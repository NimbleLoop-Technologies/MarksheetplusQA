#!/usr/bin/env bash
# Registers (idempotently) the back-office operator account from accounts.env on the CI stack's AuthApp.
# The AuthApp is started with BackOffice__Operators__0=$OPERATOR_EMAIL, so BackOfficeMemberSeeder gives this
# account an active BackOfficeMember row; registering it makes it able to sign in. Fixed OTP, Development only.
# Requires: bash 4+, curl, jq.
set -euo pipefail
QA_DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while IFS= read -r line; do
	[[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
	[[ -n "${!BASH_REMATCH[1]+x}" ]] || eval "export ${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$QA_DATA_DIR/accounts.env"

AUTH_APP="${AUTH_APP:-https://localhost:7104}"
OTP_FIXED_CODE="${OTP_FIXED_CODE:-000000}"
step() { printf '[operator] %s\n' "$*" >&2; }
fail() { printf '[operator] FAILED: %s\n' "$*" >&2; exit 1; }

JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
post() { # post PATH JSON -> sets STATUS / BODY
	local out
	out="$(curl -sk -S --max-time 60 -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -H 'Accept: application/json' \
		-X POST "$AUTH_APP$1" --data "$2" -w $'\n%{http_code}')" || fail "POST $1: no response"
	STATUS="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
verify() {
	local pending; pending="$(jq -r '.pendingUserId // empty' <<<"$BODY" 2>/dev/null || true)"
	[[ -n "$pending" ]] || fail "no pendingUserId in: $BODY"
	post /account/verify-email "$(jq -cn --arg p "$pending" --arg c "$OTP_FIXED_CODE" '{pendingUserId:$p, code:$c}')"
	[[ "$STATUS" =~ ^2 ]] || fail "verify-email -> $STATUS: $BODY"
}

post /account/login "$(jq -cn --arg u "$OPERATOR_EMAIL" --arg p "$OPERATOR_PASSWORD" '{username:$u, password:$p, returnUrl:null}')"
case "$STATUS" in
	200) step "operator $OPERATOR_EMAIL already registered" ;;
	403) verify; step "operator $OPERATOR_EMAIL verified (registered by an earlier run)" ;;
	401)
		post /account/register "$(jq -cn --arg f "$OPERATOR_FIRST_NAME" --arg l "$OPERATOR_LAST_NAME" --arg ph "$OPERATOR_PHONE" \
			--arg e "$OPERATOR_EMAIL" --arg p "$OPERATOR_PASSWORD" \
			'{firstName:$f, lastName:$l, phoneNumber:$ph, email:$e, password:$p, recaptchaToken:null, returnUrl:null}')"
		[[ "$STATUS" =~ ^2 ]] || fail "register -> $STATUS: $BODY"
		verify
		step "operator $OPERATOR_EMAIL registered and verified" ;;
	*) fail "login -> $STATUS: $BODY" ;;
esac

# Prove the account is an operator: the back-office API answers 200 only for an active BackOfficeMember.
code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 30 -b "$JAR" -H 'Accept: application/json' "$AUTH_APP/backoffice/api/plans")"
[[ "$code" == 200 ]] || fail "GET /backoffice/api/plans as $OPERATOR_EMAIL -> $code (is BackOffice__Operators__0 set to it?)"
step "operator can use /backoffice/api"
