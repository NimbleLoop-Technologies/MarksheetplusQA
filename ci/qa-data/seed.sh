#!/usr/bin/env bash
# MarksheetplusQA copy of /workspace/devenv/seed.sh (Dan's devenv), identities moved to accounts.env.
# Bash port of utility-scripts/test-env/seed.ps1 (owner + school data only).
#
# Seeds, idempotently, against a Development AuthApp/RestApi pair (Otp__Enabled=false,
# Otp__DevFixedCode=000000):
#   1. owner account: /account/login, else /account/register + /account/verify-email (fixed OTP)
#   2. RestApi HS256 login (persona 1 = Campus) -> tenant claim
#   3. no Campus tenant yet: /subscription/start {addCampus:true} + /campus/create
#   4. academic session with its terms           (sessions/list, sessions/{id}, sessions/create)
#   5. one class with one section                 (/grades, /classes, /classes/create)
#   6. one active student whose father mobile is the parent phone  (/students, /students/quick-add)
#
# Endpoint paths, verbs, bodies and cookie handling were checked against the C# sources:
#   AuthApp/AccountEndpoints.cs, AuthApp/SubscriptionEndpoints.cs, AuthApp/Program.cs,
#   Features/CampusSetup/UseCase/CreateCampus.cs, Features/Auth/Usecases/Login.cs,
#   Features/ExamManagement/Usecases/{AddSession,GetSessionsList,GetSessionById}.cs,
#   Features/ClassManagement/Usecases/{CreateClass,GetClassesList,GetGrade}.cs,
#   Features/StudentsManagement/Usecases/{QuickAddStudent,GetStudentsList}.cs
#
# Requires: bash 4+, curl, jq, base64.  Every value below can be overridden from the environment.
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
OTP_FIXED_CODE="${OTP_FIXED_CODE:-000000}"

OWNER_FIRST_NAME="${OWNER_FIRST_NAME:?set it in ci/qa-data/accounts.env}"
OWNER_LAST_NAME="${OWNER_LAST_NAME:?set it in ci/qa-data/accounts.env}"
OWNER_PHONE="${OWNER_PHONE:?set it in ci/qa-data/accounts.env}"
OWNER_EMAIL="${OWNER_EMAIL:?set it in ci/qa-data/accounts.env}"
OWNER_PASSWORD="${OWNER_PASSWORD:?set it in ci/qa-data/accounts.env}"

PARENT_PHONE="${PARENT_PHONE:?set it in ci/qa-data/accounts.env}"

CAMPUS_SCHOOL_NAME="${CAMPUS_SCHOOL_NAME:?set it in ci/qa-data/accounts.env}"
CAMPUS_NAME="${CAMPUS_NAME:?set it in ci/qa-data/accounts.env}"
CAMPUS_OWNER_NAME="${CAMPUS_OWNER_NAME:?set it in ci/qa-data/accounts.env}"
CAMPUS_ADDRESS="${CAMPUS_ADDRESS:-1 Test Road}"
CAMPUS_CITY="${CAMPUS_CITY:-Lahore}"
CAMPUS_PROVINCE="${CAMPUS_PROVINCE:-Punjab}"

SESSION_NAME="${SESSION_NAME:-2026-2027}"
SESSION_START="${SESSION_START:-2026-09-01}"
SESSION_END="${SESSION_END:-2027-06-30}"
TERM1_NAME="${TERM1_NAME:-Term 1}";  TERM1_START="${TERM1_START:-2026-09-01}";  TERM1_END="${TERM1_END:-2026-12-31}"
TERM2_NAME="${TERM2_NAME:-Term 2}";  TERM2_START="${TERM2_START:-2027-01-01}";  TERM2_END="${TERM2_END:-2027-06-30}"
TERM_PASSING_CRITERIA="${TERM_PASSING_CRITERIA:-40}"

CLASS_NAME="${CLASS_NAME:-Class 5}"
CLASS_GRADE="${CLASS_GRADE:-5}"
SECTION_NAME="${SECTION_NAME:-A}"
SECTION_SIZE="${SECTION_SIZE:-40}"

STUDENT_ADMISSION_ID="${STUDENT_ADMISSION_ID:-ADM-0001}"
STUDENT_FULL_NAME="${STUDENT_FULL_NAME:-Ali Khan}"
STUDENT_FATHER_NAME="${STUDENT_FATHER_NAME:-Imran Khan}"
STUDENT_DATE_OF_BIRTH="${STUDENT_DATE_OF_BIRTH:-2015-01-01T00:00:00Z}"
STUDENT_GENDER="${STUDENT_GENDER:-0}"   # Core/ValueObjects/Gender.cs: 0 = Male

WAIT_TIMEOUT_SEC="${WAIT_TIMEOUT_SEC:-30}"
CURL_TIMEOUT_SEC="${CURL_TIMEOUT_SEC:-90}"

# ── Helpers ────────────────────────────────────────────────────────────────────────────────────
step() { printf '\033[36m[seed] %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[seed] WARNING: %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m[seed] FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

for tool in curl jq base64; do
	command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required"
done

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# Request state set by api(): HTTP status and response body.
API_STATUS=""
API_BODY=""

# api METHOD URL [JSON_BODY] [ALLOWED_STATUSES]
#   Uses the owner cookie jar when API_USE_COOKIES=1 and a bearer token when API_BEARER is set.
#   Any non-2xx status not in ALLOWED_STATUSES (space separated) fails loudly with the body,
#   mirroring Invoke-Api -Allow in _common.ps1.
api() {
	local method="$1" url="$2" body="${3:-}" allowed="${4:-}"
	local -a args=(-sk -S --max-time "$CURL_TIMEOUT_SEC" -X "$method" "$url" -H 'Accept: application/json' -w $'\n%{http_code}')
	if [[ -n "$body" ]]; then
		args+=(-H 'Content-Type: application/json; charset=utf-8' --data "$body")
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

# ── 1. Owner AuthApp session (cookie .AspNetCore.AuthAppCookie) ────────────────────────────────
# AccountEndpoints.cs: /account/login -> 200 (cookie set) | 401 bad credentials | 403 VERIFICATION_REQUIRED | 429 lockout.
# All four /account/* routes carry DisableAntiforgery, and /subscription/start + /campus/create bind JSON bodies,
# so no antiforgery token is needed anywhere in this script.
API_USE_COOKIES=1 api POST "$AUTH_APP/account/login" \
	"$(jq -cn --arg u "$OWNER_PHONE" --arg p "$OWNER_PASSWORD" '{username:$u, password:$p, returnUrl:null}')" "401 403 429"
case "$API_STATUS" in
	200)
		step "owner: already registered; signed in" ;;
	429)
		fail "owner: /account/login -> 429: the account is locked out after repeated wrong passwords: $API_BODY" ;;
	403)
		[[ "$(json_get '.code // empty')" == "VERIFICATION_REQUIRED" ]] || fail "owner: /account/login -> 403: $API_BODY"
		confirm_fixed_otp "owner"
		step "owner: registered by an earlier run but never verified; verified with the fixed OTP" ;;
	401)
		API_USE_COOKIES=1 api POST "$AUTH_APP/account/register" \
			"$(jq -cn --arg f "$OWNER_FIRST_NAME" --arg l "$OWNER_LAST_NAME" --arg ph "$OWNER_PHONE" --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASSWORD" \
				'{firstName:$f, lastName:$l, phoneNumber:$ph, email:$e, password:$p, recaptchaToken:null, returnUrl:null}')" "409 429"
		otp_permit "owner" "/account/register"
		if [[ "$API_STATUS" == "409" ]]; then
			detail="$(json_get '.detail // empty')"
			if [[ "$detail" == *email* ]]; then
				fail "owner: /account/register -> 409 ($detail): no account has phone $OWNER_PHONE but another account uses $OWNER_EMAIL"
			fi
			fail "owner: /account/login rejected the password (401) but /account/register says the account exists ($API_BODY); the identity exists with a different password"
		fi
		confirm_fixed_otp "owner"
		step "owner: registered and verified with the fixed OTP" ;;
esac
# AddCookie sets no Cookie.Name (AuthApp/Program.cs:125), so ASP.NET Core names it .AspNetCore.<scheme>.
grep -q $'\t.AspNetCore.AuthAppCookie\t' "$COOKIE_JAR" || fail "owner: the .AspNetCore.AuthAppCookie sign-in cookie was not issued"

# ── 2-3. RestApi token, trial subscription, campus ─────────────────────────────────────────────
OWNER_LOGIN="$(rest_api_login "$OWNER_PHONE" "$OWNER_PASSWORD" 1)"
OWNER_TOKEN="$(jq -r '.accessToken' <<<"$OWNER_LOGIN")"
# The persona-1 token's tenant claim is the default Campus tenant (Login.cs: GetDefaultTenant(request.Persona)).
TENANT_ID="$(jwt_claim "$OWNER_TOKEN" tenant)"

if [[ -z "$TENANT_ID" ]]; then
	# SubscriptionEndpoints.cs HandleStart: addCampus reuses the owner's pending (TenantId == null) subscription,
	# so a failed campus/create never leaves orphan trials; CreateCampus.cs stamps that row with the new tenant.
	API_USE_COOKIES=1 api POST "$AUTH_APP/subscription/start" '{"addCampus":true}'
	step "owner: /subscription/start ok ($(json_get '.status'), pending until the campus exists)"
	# CreateCampus.cs CreateCampusRequest: SchoolName ^[A-Za-z0-9 ]+$, OwnerName ^[A-Za-z ]+$, PhoneNumber validated, Address/City/Province required.
	CAMPUS_BODY="$(jq -cn \
		--arg schoolName "$CAMPUS_SCHOOL_NAME" --arg campusName "$CAMPUS_NAME" --arg ownerName "$CAMPUS_OWNER_NAME" \
		--arg phoneNumber "$OWNER_PHONE" --arg emailAddress "$OWNER_EMAIL" \
		--arg address "$CAMPUS_ADDRESS" --arg city "$CAMPUS_CITY" --arg province "$CAMPUS_PROVINCE" \
		'{schoolName:$schoolName, campusName:$campusName, ownerName:$ownerName, phoneNumber:$phoneNumber, emailAddress:$emailAddress,
		  address:$address, city:$city, province:$province, zipCode:null, officialPhoneNumber:null, emergencyContactNumber:null,
		  logoBase64:null, logoFileName:null, logoContentType:null, logoUrl:null}')"
	API_USE_COOKIES=1 api POST "$AUTH_APP/campus/create" "$CAMPUS_BODY"
	TENANT_ID="$(json_get '.tenantId // empty')"
	[[ -n "$TENANT_ID" ]] || fail "campus/create returned no tenantId: $API_BODY"
	step "owner: campus created, tenantId=$TENANT_ID"
	OWNER_LOGIN="$(rest_api_login "$OWNER_PHONE" "$OWNER_PASSWORD" 1)"
	OWNER_TOKEN="$(jq -r '.accessToken' <<<"$OWNER_LOGIN")"
else
	# With a campus, {} returns the tenant-linked subscription, or creates one on the tenant if it is missing.
	API_USE_COOKIES=1 api POST "$AUTH_APP/subscription/start" '{}'
	step "owner: campus exists, tenantId=$TENANT_ID; subscription $(json_get '.status')"
fi

[[ "$(jwt_claim "$OWNER_TOKEN" tenant)" == "$TENANT_ID" ]] || fail "owner token tenant claim '$(jwt_claim "$OWNER_TOKEN" tenant)' != '$TENANT_ID'"
[[ "$(jwt_claim "$OWNER_TOKEN" persona)" == "Campus" ]] || fail "owner token persona is not Campus"
[[ -n "$(jwt_claim "$OWNER_TOKEN" permissions)" ]] || fail "owner token carries no permissions claim (Tenant.CreatedBy != owner?)"
if [[ "$(jwt_claim "$OWNER_TOKEN" subscription_status)" == "past_due" ]]; then
	# SubscriptionGate strips a past-due school to read-only: GETs pass, every create returns 403.
	warn "the owner subscription is past_due: every create below will 403 until a fresh trial is seeded"
fi
OWNER_USER_ID="$(jq -r '.user.id' <<<"$OWNER_LOGIN")"
step "owner: RestApi token ok (user $OWNER_USER_ID, tenant $TENANT_ID)"
export API_BEARER="$OWNER_TOKEN"
export API_USE_COOKIES=0

# ── 4. Session with terms ──────────────────────────────────────────────────────────────────────
# GetSessionsList.cs: [{id,name,startDate,endDate,termsCount,status,...}]; no terms -> GetSessionById.cs for the ids.
api GET "$REST_API/sessions/list"
SESSION_ID="$(jq -r --arg n "$SESSION_NAME" '[.[] | select((.name|ascii_downcase) == ($n|ascii_downcase))][0].id // empty' <<<"$API_BODY")"
if [[ -n "$SESSION_ID" ]]; then
	api GET "$REST_API/sessions/$SESSION_ID"
	TERM_IDS="$(json_get '[.terms[].id] | join(",")')"
	step "session \"$SESSION_NAME\" exists ($SESSION_ID) with terms: $TERM_IDS"
else
	# AddSession.cs AddSessionRequest: sessionName, startDate, endDate, terms[{termName,termStartDate,termEndDate,passingCriteria}]; returns 200 {id,name,...,terms[{id,...}]}.
	SESSION_BODY="$(jq -cn \
		--arg name "$SESSION_NAME" --arg start "$SESSION_START" --arg end "$SESSION_END" \
		--arg t1 "$TERM1_NAME" --arg t1s "$TERM1_START" --arg t1e "$TERM1_END" \
		--arg t2 "$TERM2_NAME" --arg t2s "$TERM2_START" --arg t2e "$TERM2_END" \
		--argjson pc "$TERM_PASSING_CRITERIA" \
		'{sessionName:$name, startDate:$start, endDate:$end, terms:[
			{termName:$t1, termStartDate:$t1s, termEndDate:$t1e, passingCriteria:$pc},
			{termName:$t2, termStartDate:$t2s, termEndDate:$t2e, passingCriteria:$pc}]}')"
	api POST "$REST_API/sessions/create" "$SESSION_BODY"
	SESSION_ID="$(json_get '.id // empty')"
	[[ -n "$SESSION_ID" ]] || fail "sessions/create returned no id: $API_BODY"
	TERM_IDS="$(json_get '[.terms[].id] | join(",")')"
	step "session \"$SESSION_NAME\" created ($SESSION_ID) with terms: $TERM_IDS"
fi

# ── 5. Class with one section ──────────────────────────────────────────────────────────────────
# GetGrade.cs: [{name,level}]; the class must name an existing grade (CreateClass.cs: GetGradeAsync -> 400 otherwise).
api GET "$REST_API/grades"
if ! jq -e --arg g "$CLASS_GRADE" 'any(.[]; (.name|tostring|ascii_downcase) == ($g|ascii_downcase))' <<<"$API_BODY" >/dev/null; then
	fail "grade \"$CLASS_GRADE\" not in GET /grades ($(jq -r '[.[].name|tostring] | join(",")' <<<"$API_BODY"))"
fi
# GetClassesList.cs -> ClassListResponse {id, className, grade, sections, ...}; names come back lowercased, so compare case-insensitively.
api GET "$REST_API/classes"
CLASS_ID="$(jq -r --arg n "$CLASS_NAME" '[.[] | select((.className|ascii_downcase) == ($n|ascii_downcase))][0].id // empty' <<<"$API_BODY")"
if [[ -n "$CLASS_ID" ]]; then
	step "class \"$CLASS_NAME\" exists ($CLASS_ID)"
else
	# CreateClass.cs CreateClassRequest: className, grade, sections[{sectionName,size}], subjects (null -> the grade's default subjects); 201 {id,message}.
	CLASS_BODY="$(jq -cn --arg name "$CLASS_NAME" --arg grade "$CLASS_GRADE" --arg sec "$SECTION_NAME" --argjson size "$SECTION_SIZE" \
		'{className:$name, grade:$grade, sections:[{sectionName:$sec, size:$size}], subjects:null}')"
	api POST "$REST_API/classes/create" "$CLASS_BODY"
	CLASS_ID="$(json_get '.id // empty')"
	[[ -n "$CLASS_ID" ]] || fail "classes/create returned no id: $API_BODY"
	step "class \"$CLASS_NAME\" created ($CLASS_ID) with section $SECTION_NAME"
fi

# ── 6. Student (father mobile = parent phone => the parent's Family row) ───────────────────────
# GetStudentsList.cs -> StudentListResponse {id, fullName, fatherName, mobileNumber, classId, admissionId, status, ...}.
api GET "$REST_API/students"
STUDENT_ID="$(jq -r --arg a "$STUDENT_ADMISSION_ID" '[.[] | select((.admissionId|ascii_downcase) == ($a|ascii_downcase))][0].id // empty' <<<"$API_BODY")"
if [[ -n "$STUDENT_ID" ]]; then
	STUDENT_ADMISSION_ID_ACTUAL="$(jq -r --arg a "$STUDENT_ADMISSION_ID" '[.[] | select((.admissionId|ascii_downcase) == ($a|ascii_downcase))][0].admissionId' <<<"$API_BODY")"
	step "student $STUDENT_ADMISSION_ID_ACTUAL exists ($STUDENT_ID)"
else
	# QuickAddStudent.cs QuickAddStudentRequest: fullName, admissionId (<=10, [A-Za-z0-9-]), fatherName, mobileNumber, classId,
	# admissionDate (<= tomorrow), dateOfBirth (required, past), gender (required enum). 201 StudentListResponse; Status = Active.
	STUDENT_BODY="$(jq -cn \
		--arg fullName "$STUDENT_FULL_NAME" --arg admissionId "$STUDENT_ADMISSION_ID" --arg fatherName "$STUDENT_FATHER_NAME" \
		--arg mobile "$PARENT_PHONE" --arg classId "$CLASS_ID" --arg admissionDate "$SESSION_START" --arg dob "$STUDENT_DATE_OF_BIRTH" \
		--argjson gender "$STUDENT_GENDER" \
		'{fullName:$fullName, admissionId:$admissionId, fatherName:$fatherName, mobileNumber:$mobile, classId:$classId,
		  admissionDate:$admissionDate, dateOfBirth:$dob, gender:$gender}')"
	api POST "$REST_API/students/quick-add" "$STUDENT_BODY"
	STUDENT_ID="$(json_get '.id // empty')"
	[[ -n "$STUDENT_ID" ]] || fail "students/quick-add returned no id: $API_BODY"
	STUDENT_ADMISSION_ID_ACTUAL="$(json_get '.admissionId')"
	step "student $STUDENT_ADMISSION_ID_ACTUAL $STUDENT_FULL_NAME created ($STUDENT_ID, father mobile $(json_get '.mobileNumber'), status $(json_get '.status'))"
fi

# ── 7. Output ──────────────────────────────────────────────────────────────────────────────────
step "seed done"
echo
echo "TENANT_ID=$TENANT_ID"
echo "STUDENT_ID=$STUDENT_ID"
echo "ADMISSION_ID=$STUDENT_ADMISSION_ID_ACTUAL"
echo "SESSION_ID=$SESSION_ID"
echo "CLASS_ID=$CLASS_ID"
echo "export OWNER_TOKEN='$OWNER_TOKEN'"
