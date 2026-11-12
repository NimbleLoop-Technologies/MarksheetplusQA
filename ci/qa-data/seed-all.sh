#!/usr/bin/env bash
# Seeds a fresh CI stack with every identity the regression suite signs in as (see accounts.env):
#   1. seed-operator.sh : back-office operator              -> QA_BACKOFFICE_EMAIL / QA_BACKOFFICE_PASSWORD
#   2. seed.sh          : school owner, trial campus, session, Class 5-A, one student (ADM-0001)
#                                                          -> QA_EMAIL / QA_PASSWORD
#   3. parent.sh        : family parent with family setup done -> QA_PARENT_EMAIL / QA_PARENT_PASSWORD
# Every script is idempotent. AUTH_APP / REST_API / FAMILY_APP select the stack (default: dev ports).
set -euo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$D/seed-operator.sh"
# seed.sh prints ids and an owner token on stdout; keep the ids, drop the token.
out="$(bash "$D/seed.sh")"
grep -E '^(TENANT_ID|STUDENT_ID|ADMISSION_ID|SESSION_ID|CLASS_ID)=' <<<"$out"
# parent.sh prints the parent token on stdout; drop it.
out="$(bash "$D/parent.sh")"
grep -E '^(FAMILY_ID|FAMILY_NUMBER|PARENT_USER_ID)=' <<<"$out"
echo "[seed-all] done"
