#!/usr/bin/env bash
# MarksheetplusQA copy of /workspace/devenv/parent.sh (Dan's devenv), identities moved to accounts.env.
# Bash port of the parent-only part of utility-scripts/test-env/seed-family.ps1 (steps 2 and 3).
#
# Idempotently, against a Development AuthApp/RestApi pair (Otp__Enabled=false, Otp__DevFixedCode=000000):
#   1. parent account: /account/login, else /account/register + /account/verify-email (fixed OTP)
#   2. RestApi HS256 login (persona 0 = Family); if its token carries no tenant claim:
#   3. PKCE /connect/authorize?persona=Family -> 302 login-callback?code= -> /connect/token (client marksheet-familyapp)
#      which is the only place the Family tenant is minted (AuthApp/ConnectEndpoints.cs:97-98); re-login for the HS256 token
#   4. family setup: GET /family/setup/status, POST /family/setup/complete when not completed
#
# It never sends, redeems, accepts or rejects a link invite (seed-family.ps1 steps 1, 4, 5 are out of scope).
#
# Endpoint paths, verbs, bodies and cookie handling were checked against the C# sources:
#   AuthApp/AccountEndpoints.cs, AuthApp/ConnectEndpoints.cs, AuthApp/OpenIddictSeeder.cs (redirect URIs),
#   AuthApp/Program.cs (RequireProofKeyForCodeExchange, FamilyAppOrigins), AuthApp/appsettings.Development.json,
#   Features/Auth/Usecases/Login.cs, Features/FamilySetup/Usecases/{GetFamilySetupStatus,CompleteFamilySetup,FamilySetupShared}.cs
#
# Requires: bash 4+, curl, jq, base64, openssl.  Every value below can be overridden from the environment.
set -euo pipefail

# ── Identities: ci/qa-data/accounts.env (only variables not already set in the environment) ─────
QA_DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while IFS= read -r line; do
	[[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
	[[ -n "${!BASH_REMATCH[1]+x}" ]] || eval "export ${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$QA_DATA_DIR/accounts.env"

# ── Targets and identities (utility-scripts/test-env/test-env.json) ────────────────────────────
AUTH_APP="${AUTH_APP:-https://localhost:7104}"
REST_API="${REST_API:-https://localhost:7244}"
FAMILY_APP="${FAMILY_APP:-https://localhost:7100}"
OTP_FIXED_CODE="${OTP_FIXED_CODE:-000000}"

PARENT_FIRST_NAME="${PARENT_FIRST_NAME:?set it in ci/qa-data/accounts.env}"
PARENT_LAST_NAME="${PARENT_LAST_NAME:?set it in ci/qa-data/accounts.env}"
PARENT_PHONE="${PARENT_PHONE:?set it in ci/qa-data/accounts.env}"
PARENT_EMAIL="${PARENT_EMAIL:?set it in ci/qa-data/accounts.env}"
PARENT_PASSWORD="${PARENT_PASSWORD:?set it in ci/qa-data/accounts.env}"

# identities.parent.familySetup
FAMILY_FATHER_NAME="${FAMILY_FATHER_NAME:?set it in ci/qa-data/accounts.env}"
FAMILY_CNIC="${FAMILY_CNIC:?set it in ci/qa-data/accounts.env}"
FAMILY_HOME_ADDRESS="${FAMILY_HOME_ADDRESS:-2 Test Road}"
FAMILY_CITY="${FAMILY_CITY:-Lahore}"
FAMILY_PROVINCE="${FAMILY_PROVINCE:-Punjab}"
FAMILY_NAME="${FAMILY_NAME:-Khan}"

# OpenIddictSeeder.cs EnsureFamilyAppClientAsync: public client, PKCE, redirect {origin}/authentication/login-callback
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-marksheet-familyapp}"
OIDC_SCOPE="${OIDC_SCOPE:-openid profile offline_access marksheet_api}"
REDIRECT_URI="${FAMILY_APP}/authentication/login-callback"

WAIT_TIMEOUT_SEC="${WAIT_TIMEOUT_SEC:-30}"
CURL_TIMEOUT_SEC="${CURL_TIMEOUT_SEC:-90}"

# ── Helpers ────────────────────────────────────────────────────────────────────────────────────
step() { printf '\033[36m[parent] %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33m[parent] WARNING: %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m[parent] FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

for tool in curl jq base64 openssl; do
	command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required"
done

COOKIE_JAR="$(mktemp)"
HEADERS_FILE="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$HEADERS_FILE"' EXIT

# Request state set by api(): HTTP status and response body.
API_STATUS=""
API_BODY=""

# api METHOD URL [JSON_BODY] [ALLOWED_STATUSES]
#   Uses the parent cookie jar when API_USE_COOKIES=1 and a bearer token when API_BEARER is set.
#   Any non-2xx status not in ALLOWED_STATUSES (space separated) fails loudly with the body,
#   mirroring Invoke-Api -Allow in _common.ps1.  API_CONTENT_TYPE overrides the JSON content type.
api() {
	local method="$1" url="$2" body="${3:-}" allowed="${4:-}"
	local -a args=(-sk -S --max-time "$CURL_TIMEOUT_SEC" -X "$method" "$url" -H 'Accept: application/json' -w $'\n%{http_code}')
	if [[ -n "$body" ]]; then
		args+=(-H "Content-Type: ${API_CONTENT_TYPE:-application/json; charset=utf-8}" --data "$body")
	fi
	if [[ "${API_USE_COOKIES:-0}" == "1" ]]; then
		args+=(-b "$COOKIE_JAR" -c "$COOKIE_JAR")
	fi
	if [[ -n "${API_BEARER:-}" ]]; then
		args+=(-H "Authorization: Bearer $API_BEARER")
	fi
	local out
	if ! out="$(curl "${args[@]}" 2>&1)"; then
		fail "$method $url: no response ($out)"
	fi
	API_STATUS="${out##*$'\n'}"
	API_BODY="${out%$'\n'*}"
	[[ "$API_BODY" == "$API_STATUS" ]] && API_BODY=""
	if [[ "$API_STATUS" =~ ^2 ]]; then return 0; fi
	local s
	for s in $allowed; do
		[[ "$s" == "$API_STATUS" ]] && return 0
	done
	fail "$method $url -> HTTP $API_STATUS: $API_BODY"
}

# json_get FILTER  -> jq -r FILTER over the last response body ("" when the body is not JSON)
json_get() { jq -r "$1" <<<"$API_BODY" 2>/dev/null || true; }

# wait_http URL EXPECTED_STATUS WHAT
wait_http() {
	local url="$1" expected="$2" what="$3" deadline=$((SECONDS + WAIT_TIMEOUT_SEC)) status=""
	while (( SECONDS < deadline )); do
		status="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || true)"
		[[ "$status" == "$expected" ]] && return 0
		sleep 2
	done
	fail "$what did not answer HTTP $expected at $url within ${WAIT_TIMEOUT_SEC}s (last: ${status:-none}); -k already bypasses the dev certificate, so the host is not running"
}

# jwt_payload TOKEN -> decoded JSON payload
jwt_payload() {
	local p
	p="$(cut -d. -f2 <<<"$1" | tr '_-' '/+')"
	case $(( ${#p} % 4 )) in 2) p+='==';; 3) p+='=';; esac
	printf '%s' "$p" | base64 -d 2>/dev/null || true
}

# jwt_claim TOKEN NAME -> claim value or ""
jwt_claim() { jwt_payload "$1" | jq -r --arg n "$2" '.[$n] // "" | tostring' 2>/dev/null || true; }

# base64url STDIN -> unpadded base64url (ConvertTo-Base64Url in _common.ps1)
base64url() { base64 | tr -d '\n=' | tr '+/' '-_'; }

# random_url_token BYTES -> New-RandomUrlToken
random_url_token() { openssl rand "$1" | base64url; }

# urldecode STRING -> decoded (query-string flavour: + is a space)
urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }

# otp_permit LABEL ROUTE  -> fails when the last call hit the OTP limiter (it sets only the status code)
otp_permit() {
	if [[ "$API_STATUS" == "429" ]]; then
		fail "$1: $2 -> 429: the OTP limiter (30 per 15 min per IP) is exhausted; wait or restart the AuthApp"
	fi
}

# confirm_fixed_otp LABEL  -> verifies the pendingUserId named in the last response with the fixed code; signs the cookie in
confirm_fixed_otp() {
	local label="$1" pending
	pending="$(json_get '.pendingUserId // empty')"
	[[ -n "$pending" ]] || fail "$label: no pendingUserId to verify in: $API_BODY"
	API_USE_COOKIES=1 api POST "$AUTH_APP/account/verify-email" \
		"$(jq -cn --arg p "$pending" --arg c "$OTP_FIXED_CODE" '{pendingUserId:$p, code:$c}')" "429"
	otp_permit "$label" "/account/verify-email"
}

# rest_api_login PHONE PASSWORD PERSONA -> prints the /auth/login JSON (Persona 0 = Family, 1 = Campus; Features/Auth/Entities.cs)
rest_api_login() {
	API_USE_COOKIES=0 API_BEARER="" api POST "$REST_API/auth/login" \
		"$(jq -cn --arg u "$1" --arg p "$2" --argjson persona "$3" '{username:$u, password:$p, persona:$persona}')"
	local token
	token="$(json_get '.accessToken // empty')"
	[[ -n "$token" ]] || fail "/auth/login for $1 (persona $3) returned no accessToken: $API_BODY"
	printf '%s' "$API_BODY"
}

# ── 0. Hosts ───────────────────────────────────────────────────────────────────────────────────
wait_http "$AUTH_APP/.well-known/openid-configuration" 200 "AuthApp"
wait_http "$REST_API/api/post-deployment" 401 "RestApi"
step "hosts answering: AuthApp=$AUTH_APP RestApi=$REST_API"

# ── 1. Parent AuthApp session (cookie .AspNetCore.AuthAppCookie) — New-AuthAppSession ──────────
# AccountEndpoints.cs: /account/login -> 200 (cookie set) | 401 bad credentials | 403 VERIFICATION_REQUIRED | 429 lockout.
# All /account/* routes carry DisableAntiforgery, so no antiforgery token is needed anywhere in this script.
API_USE_COOKIES=1 api POST "$AUTH_APP/account/login" \
	"$(jq -cn --arg u "$PARENT_PHONE" --arg p "$PARENT_PASSWORD" '{username:$u, password:$p, returnUrl:null}')" "401 403 429"
case "$API_STATUS" in
	200)
		step "parent: already registered; signed in" ;;
	429)
		fail "parent: /account/login -> 429: the account is locked out after repeated wrong passwords: $API_BODY" ;;
	403)
		[[ "$(json_get '.code // empty')" == "VERIFICATION_REQUIRED" ]] || fail "parent: /account/login -> 403: $API_BODY"
		confirm_fixed_otp "parent"
		step "parent: registered by an earlier run but never verified; verified with the fixed OTP" ;;
	401)
		API_USE_COOKIES=1 api POST "$AUTH_APP/account/register" \
			"$(jq -cn --arg f "$PARENT_FIRST_NAME" --arg l "$PARENT_LAST_NAME" --arg ph "$PARENT_PHONE" --arg e "$PARENT_EMAIL" --arg p "$PARENT_PASSWORD" \
				'{firstName:$f, lastName:$l, phoneNumber:$ph, email:$e, password:$p, recaptchaToken:null, returnUrl:null}')" "409 429"
		otp_permit "parent" "/account/register"
		if [[ "$API_STATUS" == "409" ]]; then
			detail="$(json_get '.detail // empty')"
			if [[ "$detail" == *email* ]]; then
				fail "parent: /account/register -> 409 ($detail): no account has phone $PARENT_PHONE but another account uses $PARENT_EMAIL"
			fi
			fail "parent: /account/login rejected the password (401) but /account/register says the account exists ($API_BODY); the identity exists with a different password"
		fi
		confirm_fixed_otp "parent"
		step "parent: registered and verified with the fixed OTP" ;;
esac
# AddCookie sets no Cookie.Name (AuthApp/Program.cs), so ASP.NET Core names it .AspNetCore.<scheme>.
grep -q $'\t.AspNetCore.AuthAppCookie\t' "$COOKIE_JAR" || fail "parent: the .AspNetCore.AuthAppCookie sign-in cookie was not issued"

# ── 2-3. HS256 Family token; mint the Family tenant through PKCE when it is missing ────────────
# The Family tenant is minted only by /connect/authorize?persona=Family (ConnectEndpoints.cs:97-98); /auth/login persona 0 then carries it.
family_pkce_authorize() {
	local verifier challenge oidc_state status location body code state_back
	verifier="$(random_url_token 32)"
	challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | base64url)"
	oidc_state="$(random_url_token 16)"
	# No -L: the 302 to login-callback is the result; -D captures Location. Program.cs: RequireProofKeyForCodeExchange -> S256.
	: >"$HEADERS_FILE"
	body="$(curl -sk -S --max-time "$CURL_TIMEOUT_SEC" -G "$AUTH_APP/connect/authorize" \
		-b "$COOKIE_JAR" -c "$COOKIE_JAR" -D "$HEADERS_FILE" -w $'\n%{http_code}' \
		--data-urlencode "client_id=$OIDC_CLIENT_ID" \
		--data-urlencode "redirect_uri=$REDIRECT_URI" \
		--data-urlencode "response_type=code" \
		--data-urlencode "scope=$OIDC_SCOPE" \
		--data-urlencode "code_challenge=$challenge" \
		--data-urlencode "code_challenge_method=S256" \
		--data-urlencode "persona=Family" \
		--data-urlencode "state=$oidc_state" 2>&1)" || fail "authorize: no response ($body)"
	status="${body##*$'\n'}"
	body="${body%$'\n'*}"
	location="$(grep -i '^Location:' "$HEADERS_FILE" | tail -n1 | sed 's/^[Ll]ocation:[[:space:]]*//; s/[[:space:]]*$//')"
	# OpenIddict answers a request it cannot redirect back (bad client or redirect_uri) with error/error_description in the body.
	[[ "$status" == "302" && -n "$location" ]] || fail "authorize: expected 302 with Location, got HTTP $status: $body"
	[[ "$location" == */auth/login* ]] && fail "authorize: redirected to /auth/login, the .AspNetCore.AuthAppCookie was not sent"
	[[ "${location,,}" == "${REDIRECT_URI,,}?"* ]] || fail "authorize: unexpected redirect $location"
	code="$(sed -n 's/.*[?&]code=\([^&]*\).*/\1/p' <<<"$location")"
	state_back="$(sed -n 's/.*[?&]state=\([^&]*\).*/\1/p' <<<"$location")"
	[[ -n "$code" ]] || fail "authorize: no code in $location"
	[[ "$(urldecode "$state_back")" == "$oidc_state" ]] || fail "authorize: state mismatch"
	code="$(urldecode "$code")"
	local form
	form="grant_type=authorization_code&client_id=$OIDC_CLIENT_ID&code_verifier=$verifier"
	form+="&code=$(jq -rn --arg v "$code" '$v|@uri')&redirect_uri=$(jq -rn --arg v "$REDIRECT_URI" '$v|@uri')"
	API_USE_COOKIES=0 API_BEARER="" API_CONTENT_TYPE='application/x-www-form-urlencoded' api POST "$AUTH_APP/connect/token" "$form"
	local rs256 rs256_tenant
	rs256="$(json_get '.access_token // empty')"
	[[ -n "$rs256" ]] || fail "connect/token returned no access_token: $API_BODY"
	rs256_tenant="$(jwt_claim "$rs256" tenant)"
	if [[ "$(jwt_claim "$rs256" persona)" != "Family" || -z "$rs256_tenant" ]]; then
		fail "connect/token: RS256 token lacks persona=Family or tenant"
	fi
	step "PKCE authorize ok: 302 -> login-callback, RS256 token persona=Family tenant=$rs256_tenant"
	printf '%s' "$rs256_tenant"
}

PARENT_LOGIN="$(rest_api_login "$PARENT_PHONE" "$PARENT_PASSWORD" 0)"
PARENT_TOKEN="$(jq -r '.accessToken' <<<"$PARENT_LOGIN")"
FAMILY_ID="$(jwt_claim "$PARENT_TOKEN" tenant)"
if [[ -z "$FAMILY_ID" ]]; then
	MINTED_TENANT="$(family_pkce_authorize)"
	PARENT_LOGIN="$(rest_api_login "$PARENT_PHONE" "$PARENT_PASSWORD" 0)"
	PARENT_TOKEN="$(jq -r '.accessToken' <<<"$PARENT_LOGIN")"
	FAMILY_ID="$(jwt_claim "$PARENT_TOKEN" tenant)"
	[[ -n "$FAMILY_ID" ]] || fail "family tenant still missing after PKCE authorize"
	# The family API calls below run on the HS256 token, so it must carry the tenant the authorize call minted.
	[[ "$FAMILY_ID" == "$MINTED_TENANT" ]] || fail "HS256 /auth/login tenant $FAMILY_ID is not the Family tenant $MINTED_TENANT the PKCE authorize minted"
else
	step "parent: family tenant already minted; PKCE skipped"
fi
[[ "$(jwt_claim "$PARENT_TOKEN" persona)" == "Family" ]] || fail "parent HS256 token persona is not Family"
PARENT_USER_ID="$(jq -r '.user.id' <<<"$PARENT_LOGIN")"
step "parent: RestApi token ok (user $PARENT_USER_ID, family tenant $FAMILY_ID)"
export API_BEARER="$PARENT_TOKEN"
export API_USE_COOKIES=0

# ── 4. Family setup (FamilyProfile.Id == family tenant); children come from the school link, not the wizard ──
# GetFamilySetupStatus.cs -> {isCompleted, familyNumber}; CompleteFamilySetup.cs is itself idempotent (returns the committed profile).
api GET "$REST_API/family/setup/status"
if [[ "$(json_get '.isCompleted')" == "true" ]]; then
	FAMILY_NUMBER="$(json_get '.familyNumber')"
	step "family setup already completed: $FAMILY_NUMBER"
else
	# FamilySetupShared.cs CompleteFamilySetupRequest {father{fatherName,cnic,whatsApp,emailAddress,homeAddress,city,province,familyName}, mother, guardian, children}.
	# FatherInformationValidator: cnic validated, whatsApp validated phone, city/province must be in PakistanLocationConstants.
	SETUP_BODY="$(jq -cn \
		--arg fatherName "$FAMILY_FATHER_NAME" --arg cnic "$FAMILY_CNIC" --arg whatsApp "$PARENT_PHONE" --arg email "$PARENT_EMAIL" \
		--arg homeAddress "$FAMILY_HOME_ADDRESS" --arg city "$FAMILY_CITY" --arg province "$FAMILY_PROVINCE" --arg familyName "$FAMILY_NAME" \
		'{father:{fatherName:$fatherName, cnic:$cnic, whatsApp:$whatsApp, emailAddress:$email, homeAddress:$homeAddress, city:$city, province:$province, familyName:$familyName},
		  mother:null, guardian:null, children:[]}')"
	api POST "$REST_API/family/setup/complete" "$SETUP_BODY"
	FAMILY_NUMBER="$(json_get '.familyNumber')"
	[[ "$(json_get '.familyId')" == "$FAMILY_ID" ]] || fail "family/setup/complete returned familyId $(json_get '.familyId'), token tenant is $FAMILY_ID"
	step "family setup completed: $FAMILY_NUMBER ($FAMILY_ID)"
fi

# ── 5. Output ──────────────────────────────────────────────────────────────────────────────────
step "parent done"
echo
echo "FAMILY_ID=$FAMILY_ID"
echo "FAMILY_NUMBER=$FAMILY_NUMBER"
echo "PARENT_USER_ID=$PARENT_USER_ID"
echo "export PARENT_TOKEN='$PARENT_TOKEN'"
