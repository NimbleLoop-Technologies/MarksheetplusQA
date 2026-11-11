#!/usr/bin/env bash
# ci/run-regression.sh — single entry point: build a MarksheetPlus checkout, start it as a throwaway Docker
# stack, seed it, run the MarksheetplusQA Playwright regression suite against it, collect artifacts, tear down.
#
#   ci/run-regression.sh --mp-dir <path to MarksheetPlus checkout> [options]
#
# Options (each also settable through the environment variable in brackets):
#   --mp-dir PATH        MarksheetPlus checkout to test (repo root, contains src/MarksheetPlusCode) [QA_CI_MP_DIR]  required
#   --project NAME       docker compose project name; must be unique on the Docker host           [QA_CI_COMPOSE_PROJECT=qaci]
#   --work-dir PATH      scratch dir for publish output, generated env and logs                    [QA_CI_WORK_DIR=<repo>/.ci-work]
#   --artifacts PATH     where reports and logs are copied                                         [QA_CI_ARTIFACTS_DIR=<repo>/ci-artifacts]
#   --suites LIST        comma list of Playwright projects, or "auto"                              [QA_CI_SUITES=auto]
#   --workers N          Playwright workers                                                        [QA_CI_WORKERS=1]
#   --skip-build         reuse the publish output already in the work dir                          [QA_CI_SKIP_BUILD=false]
#   --skip-npm           skip `npm ci` + `playwright install` (already done)                       [QA_CI_SKIP_NPM=false]
#   --keep               leave the stack running afterwards (default: `down -v`)                   [QA_CI_KEEP_STACK=false]
#   --down               only tear down the stack of --project and exit
#   Extra arguments after `--` go to `playwright test` (e.g. -- --grep @critical).
#
# Ports: QA_CI_API_PORT/AUTH_PORT/WEB_PORT/FAMILY_PORT (defaults 7244/7104/7236/7100, ci/stack/stack.env).
# Private NuGet feed: export GH_PACKAGES_USER / GH_PACKAGES_TOKEN when the runner's NuGet cache lacks TailwindUi.*.
# Exit code: Playwright's (0 = all passed); 2 = usage; 3 = stack failed to build/start/seed.
set -euo pipefail

QA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_DIR="$QA_ROOT/ci"
log()  { printf '\n\033[36m[qa-ci %(%H:%M:%S)T] %s\033[0m\n' -1 "$*"; }
warn() { printf '\033[33m[qa-ci] WARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[qa-ci] FAILED: %s\033[0m\n' "$*" >&2; exit "${2:-3}"; }

# ── Arguments ──────────────────────────────────────────────────────────────────────────────────
DOWN_ONLY=false; PW_EXTRA=()
while (($#)); do
	case "$1" in
		--mp-dir) QA_CI_MP_DIR="$2"; shift 2 ;;
		--project) QA_CI_COMPOSE_PROJECT="$2"; shift 2 ;;
		--work-dir) QA_CI_WORK_DIR="$2"; shift 2 ;;
		--artifacts) QA_CI_ARTIFACTS_DIR="$2"; shift 2 ;;
		--suites) QA_CI_SUITES="$2"; shift 2 ;;
		--workers) QA_CI_WORKERS="$2"; shift 2 ;;
		--skip-build) QA_CI_SKIP_BUILD=true; shift ;;
		--skip-npm) QA_CI_SKIP_NPM=true; shift ;;
		--keep) QA_CI_KEEP_STACK=true; shift ;;
		--down) DOWN_ONLY=true; shift ;;
		--) shift; PW_EXTRA=("$@"); break ;;
		-h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) die "unknown argument $1 (see --help)" 2 ;;
	esac
done

export QA_CI_COMPOSE_PROJECT="${QA_CI_COMPOSE_PROJECT:-qaci}"
export COMPOSE_PROJECT_NAME="$QA_CI_COMPOSE_PROJECT"
export QA_CI_WORK_DIR="$(mkdir -p "${QA_CI_WORK_DIR:-$QA_ROOT/.ci-work}" && cd "${QA_CI_WORK_DIR:-$QA_ROOT/.ci-work}" && pwd)"
QA_CI_ARTIFACTS_DIR="${QA_CI_ARTIFACTS_DIR:-$QA_ROOT/ci-artifacts}"
QA_CI_SUITES="${QA_CI_SUITES:-auto}"
QA_CI_WORKERS="${QA_CI_WORKERS:-1}"
QA_CI_SKIP_BUILD="${QA_CI_SKIP_BUILD:-false}"
QA_CI_SKIP_NPM="${QA_CI_SKIP_NPM:-false}"
QA_CI_KEEP_STACK="${QA_CI_KEEP_STACK:-false}"
QA_CI_HEALTH_TIMEOUT="${QA_CI_HEALTH_TIMEOUT:-300}"

# Stack config (committed, throwaway values); environment wins.
while IFS= read -r line; do
	[[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
	[[ -n "${!BASH_REMATCH[1]+x}" ]] || eval "export ${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$CI_DIR/stack/stack.env"

COMPOSE=(docker compose -p "$QA_CI_COMPOSE_PROJECT" -f "$CI_DIR/stack/docker-compose.yml" --project-directory "$CI_DIR/stack")

teardown() {
	log "tearing down compose project $QA_CI_COMPOSE_PROJECT (containers + volumes)"
	mkdir -p "$QA_CI_WORK_DIR/env"; for f in common api authapp worker; do [[ -f "$QA_CI_WORK_DIR/env/$f.env" ]] || : > "$QA_CI_WORK_DIR/env/$f.env"; done
	"${COMPOSE[@]}" down -v --remove-orphans --timeout 20 || warn "compose down reported an error"
	docker image rm -f "$QA_CI_COMPOSE_PROJECT"-{edge,api,authapp,worker,web,familyapp}:local >/dev/null 2>&1 || true
}
if $DOWN_ONLY; then teardown; exit 0; fi

[[ -n "${QA_CI_MP_DIR:-}" ]] || die "--mp-dir is required" 2
QA_CI_MP_DIR="$(cd "$QA_CI_MP_DIR" && pwd)"
SRC="$QA_CI_MP_DIR/src/MarksheetPlusCode"
[[ -f "$SRC/MarksheetPlusCode.sln" ]] || die "$QA_CI_MP_DIR is not a MarksheetPlus checkout (no src/MarksheetPlusCode/MarksheetPlusCode.sln)" 2
for t in docker dotnet node npm npx curl jq openssl; do command -v "$t" >/dev/null || die "'$t' is required on the runner" 2; done
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required" 2

export API_URL="https://localhost:$QA_CI_API_PORT" AUTH_URL="https://localhost:$QA_CI_AUTH_PORT"
export WEB_URL="https://localhost:$QA_CI_WEB_PORT" FAMILY_URL="https://localhost:$QA_CI_FAMILY_PORT"
LOGS="$QA_CI_WORK_DIR/logs"; mkdir -p "$LOGS" "$QA_CI_WORK_DIR/env"
MP_SHA="$(git -C "$QA_CI_MP_DIR" rev-parse --short=8 HEAD 2>/dev/null || echo unknown)"
QA_SHA="$(git -C "$QA_ROOT" rev-parse --short=8 HEAD 2>/dev/null || echo unknown)"
log "MarksheetPlus $QA_CI_MP_DIR @ $MP_SHA | MarksheetplusQA @ $QA_SHA | project $QA_CI_COMPOSE_PROJECT | ports api=$QA_CI_API_PORT auth=$QA_CI_AUTH_PORT web=$QA_CI_WEB_PORT family=$QA_CI_FAMILY_PORT"

STACK_UP=false
on_exit() {
	local rc=$?
	if $STACK_UP; then
		for s in api authapp worker web familyapp edge; do "${COMPOSE[@]}" logs --no-color "$s" > "$LOGS/$s.log" 2>&1 || true; done
		[[ -n "${WORKER_LOG_PID:-}" ]] && kill "$WORKER_LOG_PID" 2>/dev/null || true
		mkdir -p "$QA_CI_ARTIFACTS_DIR"; cp -r "$LOGS" "$QA_CI_ARTIFACTS_DIR/stack-logs" 2>/dev/null || true
		if [[ "$QA_CI_KEEP_STACK" == true ]]; then log "stack left running (--keep); stop it with: $0 --project $QA_CI_COMPOSE_PROJECT --down"; else teardown; fi
	fi
	exit $rc
}
trap on_exit EXIT

# ── 1. Build: dotnet publish on the runner (NuGet creds stay out of Docker) ─────────────────────
PUB="$QA_CI_WORK_DIR/publish"
declare -A PROJ=(
	[api]="MarksheetPlus.RestApi/MarksheetPlus.RestApi.csproj"
	[authapp]="MarksheetPlus.AuthApp/MarksheetPlus.AuthApp/MarksheetPlus.AuthApp.csproj"
	[worker]="MarksheetPlus.Worker/MarksheetPlus.Worker.csproj"
	[web]="MarksheetPlus.WebApp/MarksheetPlus.WebApp.csproj"
	[familyapp]="MarksheetPlus.FamilyApp/MarksheetPlus.FamilyApp.csproj"
)
declare -A DLL=([api]=MarksheetPlus.RestApi.dll [authapp]=MarksheetPlus.AuthApp.dll [worker]=MarksheetPlus.Worker.dll)
if [[ "$QA_CI_SKIP_BUILD" != true ]]; then
	rm -rf "$PUB"; mkdir -p "$PUB"
	export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
	for app in api authapp worker web familyapp; do
		log "dotnet publish $app (${PROJ[$app]})"
		dotnet publish "$SRC/${PROJ[$app]}" -c Release -o "$PUB/$app" --nologo -v minimal > "$LOGS/build-$app.log" 2>&1 \
			|| { tail -n 60 "$LOGS/build-$app.log" >&2; die "dotnet publish $app failed (log: $LOGS/build-$app.log)"; }
	done
else
	for app in api authapp worker web familyapp; do [[ -d "$PUB/$app" ]] || die "--skip-build but $PUB/$app is missing"; done
	log "reusing publish output in $PUB"
fi

# SPA runtime settings (what deploy/Dockerfile.web's entrypoint does at container start).
for app in web familyapp; do
	f="$PUB/$app/wwwroot/appsettings.json"; [[ -f "$f" ]] || die "$f missing after publish"
	jq --arg api "$API_URL/" --arg auth "$AUTH_URL" '.ApiBaseUrl=$api | .AuthAppAuthority=$auth' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
	rm -f "$f.gz" "$f.br"
done

# ── 2. Images ──────────────────────────────────────────────────────────────────────────────────
log "building runtime images"
docker build -q -t "$QA_CI_COMPOSE_PROJECT-edge:local" -f "$CI_DIR/stack/Dockerfile.edge" "$CI_DIR/stack" > /dev/null
for app in api authapp worker; do
	docker build -q -t "$QA_CI_COMPOSE_PROJECT-$app:local" --build-arg "APP_DLL=${DLL[$app]}" -f "$CI_DIR/stack/Dockerfile.dotnet" "$PUB/$app" > /dev/null
done
docker build -q -t "$QA_CI_COMPOSE_PROJECT-web:local" --build-arg LISTEN_PORT=8083 -f "$CI_DIR/stack/Dockerfile.spa" "$PUB/web/wwwroot" > /dev/null
docker build -q -t "$QA_CI_COMPOSE_PROJECT-familyapp:local" --build-arg LISTEN_PORT=8084 -f "$CI_DIR/stack/Dockerfile.spa" "$PUB/familyapp/wwwroot" > /dev/null

# ── 3. Per-run secrets + app environment (generated, never committed) ───────────────────────────
rnd() { openssl rand -hex "$1"; }
b64key() { openssl rand -base64 32; }
JWT_ACCESS="$(rnd 48)"; JWT_REFRESH="$(rnd 48)"; DEPLOY_USER="qaci-deploy"; DEPLOY_PASS="$(rnd 24)"
CODE_ENC="$(b64key)"; CODE_LOOKUP="$(b64key)"
pg() { echo "Host=postgres;Port=5432;Database=$1;Username=$QA_CI_PG_USER;Password=$QA_CI_PG_PASSWORD;Include Error Detail=True"; }
# Load the operator address from the committed accounts (the only BackOffice operator on this stack).
OPERATOR_EMAIL_CFG="$(sed -n 's/^OPERATOR_EMAIL=//p' "$CI_DIR/qa-data/accounts.env")"
umask 077
cat > "$QA_CI_WORK_DIR/env/common.env" <<ENV
ASPNETCORE_ENVIRONMENT=Development
DOTNET_ENVIRONMENT=Development
DOTNET_gcServer=0
ConnectionStrings__MarksheetPlusSchoolsDb=$(pg mp-shared-schools-db)
ConnectionStrings__MarksheetPlusFamilyDb=$(pg mp-familyapp-db)
MarksheetPlusAccountsDb__ConnectionString=mongodb://mongo:27017
MarksheetPlusAccountsDb__DatabaseName=mp-accounts-db
MessageBroker__ConnectionString=amqp://$QA_CI_RABBIT_USER:$QA_CI_RABBIT_PASSWORD@rabbitmq:5672/
StorageAccount__ServiceUrl=http://minio:9000
StorageAccount__AccessKey=$QA_CI_MINIO_USER
StorageAccount__SecretKey=$QA_CI_MINIO_PASSWORD
StorageAccount__PublicBaseUrl=$WEB_URL/files
JwtSettings__AccessTokenSecret=$JWT_ACCESS
JwtSettings__RefreshTokenSecret=$JWT_REFRESH
FamilyLink__CodeEncryptionKey=$CODE_ENC
FamilyLink__CodeLookupKey=$CODE_LOOKUP
FamilyLink__ParentAppBaseUrl=$FAMILY_URL
Otp__DevFixedCode=000000
Otp__VerifyExistingPhonesOnLogin=false
Recaptcha__Enabled=false
WhatsApp__UseFakeSender=true
WhatsApp__PhoneNumberId=
WhatsApp__AccessToken=
ClickUp__ApiToken=
Meta__DatasetId=
Meta__AccessToken=
ENV
cat > "$QA_CI_WORK_DIR/env/api.env" <<ENV
ASPNETCORE_URLS=http://127.0.0.1:8081
# Fixed OTP 000000 (no real code is ever issued); Development only.
Otp__Enabled=false
OidcAuthority=$AUTH_URL
ClientUrls__0=$WEB_URL
ClientUrls__1=$FAMILY_URL
ClientUrls__2=
ClientUrls__3=
DeploymentAuth__Username=$DEPLOY_USER
DeploymentAuth__Password=$DEPLOY_PASS
ENV
cat > "$QA_CI_WORK_DIR/env/authapp.env" <<ENV
ASPNETCORE_URLS=http://127.0.0.1:8082
Otp__Enabled=false
Issuer=$AUTH_URL
WebAppOrigins__0=$WEB_URL
WebAppOrigins__1=
FamilyAppOrigins__0=$FAMILY_URL
FamilyAppOrigins__1=
BackOffice__Operators__0=$OPERATOR_EMAIL_CFG
LandingUrl=https://localhost:1
ENV
cat > "$QA_CI_WORK_DIR/env/worker.env" <<ENV
# The worker gates every WhatsApp send on Otp:Enabled; true here only lets the FAKE sender log them
# (WhatsApp__UseFakeSender=true, Development): nothing reaches Meta. Same as the worker's appsettings.Development.json.
Otp__Enabled=true
Smtp__Host=smtp4dev
Smtp__Port=25
Smtp__UseStartTls=false
Smtp__Username=
Smtp__Password=
Smtp__FromAddress=no-reply@qa-ci.local
FeeChallanScheduler__RunInterval=${QA_CI_FEE_CHALLAN_RUN_INTERVAL:-00:01:00}
WhatsAppNotifications__Enabled=true
WhatsAppNotifications__RunInterval=${QA_CI_WHATSAPP_RUN_INTERVAL:-00:01:00}
WhatsAppNotifications__WelcomeDelay=00:00:00
WelcomeEmail__RunInterval=00:01:00
LearnerProvisioning__SweepIntervalMinutes=1
ENV
umask 022

# ── 4. Start: infra -> edge -> api -> post-deployment (migrations) -> the rest ───────────────────
STACK_UP=true
wait_for() { # wait_for URL EXPECTED_REGEX WHAT [timeout]
	local url="$1" want="$2" what="$3" deadline=$((SECONDS + ${4:-$QA_CI_HEALTH_TIMEOUT})) code=""
	while ((SECONDS < deadline)); do
		code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || true)"
		[[ "$code" =~ ^($want)$ ]] && { log "$what is up ($url -> $code)"; return 0; }
		sleep 3
	done
	die "$what not healthy at $url within ${4:-$QA_CI_HEALTH_TIMEOUT}s (last HTTP ${code:-none}); see $LOGS"
}
log "starting infra"
"${COMPOSE[@]}" up -d --wait --wait-timeout "$QA_CI_HEALTH_TIMEOUT" postgres mongo rabbitmq minio smtp4dev > "$LOGS/compose-up.log" 2>&1 \
	|| { cat "$LOGS/compose-up.log" >&2; die "infra did not become healthy"; }
"${COMPOSE[@]}" up -d edge api >> "$LOGS/compose-up.log" 2>&1 || { cat "$LOGS/compose-up.log" >&2; die "edge/api failed to start"; }
wait_for "$API_URL/api/post-deployment" 401 "RestApi"
log "post-deployment hook (EF migrations, family DB, Mongo indexes, data migrations)"
pd="$(curl -sk -o "$LOGS/post-deployment.out" -w '%{http_code}' --max-time 900 -u "$DEPLOY_USER:$DEPLOY_PASS" "$API_URL/api/post-deployment")"
[[ "$pd" =~ ^2 ]] || { cat "$LOGS/post-deployment.out" >&2; die "post-deployment returned HTTP $pd"; }
"${COMPOSE[@]}" up -d authapp worker web familyapp >> "$LOGS/compose-up.log" 2>&1 || { cat "$LOGS/compose-up.log" >&2; die "apps failed to start"; }
wait_for "$AUTH_URL/.well-known/openid-configuration" 200 "AuthApp"
wait_for "$WEB_URL/" 200 "WebApp"
wait_for "$FAMILY_URL/" 200 "FamilyApp"
sleep 5; [[ -n "$("${COMPOSE[@]}" ps -q --status running worker)" ]] || { "${COMPOSE[@]}" logs worker | tail -50 >&2; die "worker is not running"; }
log "worker running"
# The specs read WhatsApp fake-sender lines from the worker log (QA_WORKER_LOG).
export QA_WORKER_LOG="$LOGS/worker-live.log"
"${COMPOSE[@]}" logs -f --no-color --no-log-prefix worker > "$QA_WORKER_LOG" 2>&1 & WORKER_LOG_PID=$!

# ── 5. Seed ────────────────────────────────────────────────────────────────────────────────────
export AUTH_APP="$AUTH_URL" REST_API="$API_URL" FAMILY_APP="$FAMILY_URL"
log "seeding (ci/qa-data/seed-all.sh)"
bash "$CI_DIR/qa-data/seed-all.sh" > "$LOGS/seed.log" 2>&1 || { cat "$LOGS/seed.log" >&2; die "seeding failed"; }
grep -E '^(TENANT_ID|FAMILY_ID)=|done' "$LOGS/seed.log" || true

# ── 6. Suite environment ───────────────────────────────────────────────────────────────────────
acct() { sed -n "s/^$1=//p" "$CI_DIR/qa-data/accounts.env" | tr -d '"'; }
export CI="${CI:-true}"
export QA_BASE_URL="$WEB_URL" QA_FAMILY_URL="$FAMILY_URL" QA_AUTH_URL="$AUTH_URL" QA_REST_API_URL="$API_URL"
export QA_IGNORE_HTTPS_ERRORS=true QA_OTP=000000
export QA_EMAIL="$(acct OWNER_EMAIL)" QA_PASSWORD="$(acct OWNER_PASSWORD)"
export QA_PARENT_EMAIL="$(acct PARENT_EMAIL)" QA_PARENT_PASSWORD="$(acct PARENT_PASSWORD)" QA_PARENT_PHONE="$(acct PARENT_PHONE)"
export QA_BACKOFFICE_EMAIL="$(acct OPERATOR_EMAIL)" QA_BACKOFFICE_PASSWORD="$(acct OPERATOR_PASSWORD)"
export QA_SEED_SCRIPT="$CI_DIR/qa-data/seed.sh" QA_PARENT_SCRIPT="$CI_DIR/qa-data/parent.sh"
export QA_MONGOSH="$CI_DIR/bin/mongosh" QA_MONGO_URL="mongodb://localhost:27017/mp-accounts-db"
# QA_PG_PORT is the port inside the postgres container. The psql shim drops -h/-p and connects over the
# container's local socket; fixtures still pass them so a host psql (qa555) keeps working.
export PATH="$CI_DIR/bin:$PATH" QA_PG_HOST=localhost QA_PG_PORT=5432 QA_PG_USER="$QA_CI_PG_USER" QA_PG_PASSWORD="$QA_CI_PG_PASSWORD" QA_PG_SCHOOL_DB=mp-shared-schools-db
export QA_WORKERS="$QA_CI_WORKERS" QA_ADMISSION_PREFIX="${QA_ADMISSION_PREFIX:-CI-}"

# ── 7. Suites ──────────────────────────────────────────────────────────────────────────────────
# Projects whose product feature is not in every MarksheetPlus branch yet run only when the checkout has it.
has_feature() { # has_feature <project>
	case "$1" in
		# PR 548 (back-dated attendance, CU-z94x8ean2v): the empty past-date roster message it introduced.
		attendance-backdating) grep -rqsF "No students were enrolled in this section on this date" "$SRC" --include=*.cs --include=*.razor ;;
		*) return 0 ;;
	esac
}
if [[ "$QA_CI_SUITES" == auto ]]; then
	SUITES=()
	# challan-name waits on the 1-minute fee scheduler (~12 min per file) and must run at --workers=1.
	for p in setup anonymous authenticated shell-notes whatsapp-quota challan-name attendance-backdating family-setup family; do
		if has_feature "$p"; then SUITES+=("$p"); else warn "skipping project $p: this MarksheetPlus checkout does not contain its feature yet"; fi
	done
else
	IFS=',' read -r -a SUITES <<<"$QA_CI_SUITES"
fi
PW_PROJECTS=(); for p in "${SUITES[@]}"; do PW_PROJECTS+=("--project=$p"); done

cd "$QA_ROOT"
if [[ "$QA_CI_SKIP_NPM" != true ]]; then
	log "npm ci + playwright install chromium"
	npm ci --no-audit --no-fund > "$LOGS/npm-ci.log" 2>&1 || { tail -40 "$LOGS/npm-ci.log" >&2; die "npm ci failed"; }
	# --with-deps apt-installs Chromium's system libraries (needed on a fresh ubuntu-latest runner). If apt is
	# unavailable (no root, offline mirror) fall back to the browser only and let the launch tell us.
	if { [[ "$(id -u)" == 0 ]] || sudo -n true 2>/dev/null; } && npx playwright install --with-deps chromium > "$LOGS/pw-install.log" 2>&1; then :
	else
		warn "playwright install --with-deps failed or no root; installing the browser only (see $LOGS/pw-install.log)"
		npx playwright install chromium >> "$LOGS/pw-install.log" 2>&1 || { tail -40 "$LOGS/pw-install.log" >&2; die "playwright install failed"; }
	fi
fi
rm -rf "$QA_ROOT/test-results" "$QA_ROOT/playwright-report" "$QA_ROOT/.auth"
if [[ " ${SUITES[*]} " == *" challan-name "* && "$QA_CI_WORKERS" != 1 ]]; then
	warn "challan-name shares the one-minute fee scheduler and must run with --workers=1; forcing 1"
	QA_CI_WORKERS=1
fi
log "playwright test ${PW_PROJECTS[*]} --workers=$QA_CI_WORKERS ${PW_EXTRA[*]:-}"
set +e
npx playwright test "${PW_PROJECTS[@]}" --workers="$QA_CI_WORKERS" "${PW_EXTRA[@]}" 2>&1 | tee "$LOGS/playwright.log"
PW_RC=${PIPESTATUS[0]}
set -e

# ── 8. Artifacts + summary ─────────────────────────────────────────────────────────────────────
mkdir -p "$QA_CI_ARTIFACTS_DIR"
cp -r "$QA_ROOT/playwright-report" "$QA_CI_ARTIFACTS_DIR/" 2>/dev/null || true
cp -r "$QA_ROOT/test-results" "$QA_CI_ARTIFACTS_DIR/" 2>/dev/null || true
R="$QA_ROOT/test-results/results.json"
if [[ -f "$R" ]]; then
	SUMMARY="$(jq -r --arg mp "$MP_SHA" --arg qa "$QA_SHA" --arg suites "${SUITES[*]}" '
		.stats as $s |
		"### MarksheetplusQA regression\n\nMarksheetPlus `\($mp)` · MarksheetplusQA `\($qa)` · projects: \($suites)\n\n| passed | failed | flaky | skipped | duration |\n|---|---|---|---|---|\n| \($s.expected) | \($s.unexpected) | \($s.flaky) | \($s.skipped) | \(($s.duration/60000*10|floor)/10) min |"' "$R")"
	FAILED="$(jq -r '[.. | objects | select(has("specs")) | .specs[] | select(.ok==false) | "- \(.file):\(.line) \(.title)"] | unique | .[]' "$R" 2>/dev/null | head -50)"
	[[ -n "$FAILED" ]] && SUMMARY+=$'\n\n**Failed**\n'"$FAILED"
	printf '%s\n' "$SUMMARY" | tee "$QA_CI_ARTIFACTS_DIR/summary.md"
	[[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && printf '%s\n' "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"
fi
log "playwright exit code $PW_RC"
exit "$PW_RC"
