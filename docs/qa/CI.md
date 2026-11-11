# CI: run the regression suite against a PR's own MarksheetPlus code

> MarksheetplusQA is a public repository. The accounts committed here (`ci/qa-data/accounts.env`,
> `ci/stack/stack.env`) are throwaway: they exist only inside the Docker stack this entry point seeds and
> removes, their passwords were generated for these files, the e-mails use the non-routable `.qa-ci.local`
> domain and the phones are NANP fictional numbers (`+1 202-555-01xx`). Keep it that way: credentials for
> shared environments or providers stay out of the repo. Per-run secrets (JWT signing keys,
> deployment-hook password, family-link keys) are generated at run time and never committed.

`ci/run-regression.sh` builds a MarksheetPlus checkout, starts it as a throwaway Docker stack, seeds it,
runs the Playwright suite against it and tears it down. `.github/actions/regression` wraps it for GitHub
Actions so the MarksheetPlus PR workflow can test **the PR's code** instead of the shared integration site.

## Entry point

```bash
ci/run-regression.sh --mp-dir <MarksheetPlus checkout> [--project qaci] [--suites auto|a,b,c] [--workers 1] \
                     [--work-dir DIR] [--artifacts DIR] [--skip-build] [--skip-npm] [--keep] [-- <playwright args>]
ci/run-regression.sh --project qaci --down          # tear a kept stack down
```

| Input | Flag / env | Default | Notes |
|---|---|---|---|
| MarksheetPlus checkout | `--mp-dir` / `QA_CI_MP_DIR` | required | Repo root (has `src/MarksheetPlusCode/MarksheetPlusCode.sln`). Any branch or PR head. |
| Compose project | `--project` / `QA_CI_COMPOSE_PROJECT` | `qaci` | Must be unique on the Docker host; also names the images (`<project>-api:local` …). |
| Projects | `--suites` / `QA_CI_SUITES` | `auto` | `auto` = every Playwright project whose feature the checkout contains (see below). |
| Workers | `--workers` / `QA_CI_WORKERS` | `1` | The self-seeding suites were written for 1 worker. `challan-name` forces 1 (about 12 min per file). |
| Ports | `QA_CI_API_PORT` `QA_CI_AUTH_PORT` `QA_CI_WEB_PORT` `QA_CI_FAMILY_PORT` | 7244 7104 7236 7100 | Published on `127.0.0.1` (`QA_CI_BIND_ADDRESS`). Served as `https://localhost:<port>`. |
| Private NuGet feed | `GH_PACKAGES_USER` / `GH_PACKAGES_TOKEN` | – | Read by `src/MarksheetPlusCode/nuget.config` for `TailwindUi.Blazor*`. Not needed when the NuGet cache already has them. |
| Scratch / artifacts | `QA_CI_WORK_DIR` / `QA_CI_ARTIFACTS_DIR` | `.ci-work/` / `ci-artifacts/` | Both gitignored. |
| Keep stack | `--keep` / `QA_CI_KEEP_STACK` | false | Default is `docker compose down -v`. |
| Client-IP spreading | `QA_CI_SPREAD_CLIENT_IPS` | true | See "Deviations from production". |

Exit code: Playwright's (0 = green), 2 = usage error, 3 = the stack failed to build, start or seed.

Artifacts (`QA_CI_ARTIFACTS_DIR`): `playwright-report/`, `test-results/` (incl. `results.json`), `stack-logs/`
(build logs, container logs, seed log, live worker log) and `summary.md` (also appended to `$GITHUB_STEP_SUMMARY`).

### Runner requirements

- Linux with Docker Engine + `docker compose` v2 (GitHub `ubuntu-latest` has both). Any Docker host works,
  including a remote one (`DOCKER_HOST`): nothing is bind-mounted; images are built from contexts.
- .NET SDK per `src/MarksheetPlusCode/global.json`, Node 20+, `curl`, `jq`, `openssl`, `git`.
- No `mongosh` or `psql` needed: `ci/bin/{mongosh,psql}` exec into the stack's containers.
- About 6 GB RAM and 10 GB disk free.
- Approximate runtime: 4–5 min `dotnet publish` (cold NuGet cache longer), ~1 min image build + start +
  migrations + seed, plus the suite (~50 min with 1 worker; see the latest local run below).

## What it does

1. **Build** – `dotnet publish -c Release` of RestApi, AuthApp, Worker, WebApp and FamilyApp on the runner, so
   the private-feed token never enters Docker. The two WASM apps get `ApiBaseUrl`/`AuthAppAuthority` written into
   `wwwroot/appsettings.json` (what the product's nginx entrypoint does at container start).
2. **Images** – thin runtime images (`ci/stack/Dockerfile.dotnet`, `Dockerfile.spa`, `Dockerfile.edge`) mirroring the
   runtime stages of `deploy/Dockerfile.*`.
3. **Stack** (`ci/stack/docker-compose.yml`) – postgres 18, mongo 8, rabbitmq 4, minio, smtp4dev on the compose
   network (nothing published) + **edge** (Caddy). The apps join the edge's network namespace
   (`network_mode: service:edge`) and listen on `127.0.0.1:8081-8084`; Caddy serves them as
   `https://localhost:<port>` with a certificate from its own throwaway local CA, which the .NET containers add to
   their trust bundle. So `https://localhost:7104` is the AuthApp both for the browser on the runner and for the
   RestApi validating its tokens (JWKS), exactly as on a developer machine.
4. **Start order** – infra (health-checked) → edge + RestApi → `GET /api/post-deployment` with a per-run
   deployment password (EF migrations, family DB, Mongo indexes, data migrations) → AuthApp, Worker, WebApp,
   FamilyApp → health checks (OIDC discovery 200, SPAs 200, worker running).
5. **Seed** – `ci/qa-data/seed-all.sh`: back-office operator, school owner + trial campus + session + Class 5-A +
   one student, family parent with setup completed (all from `ci/qa-data/accounts.env`).
6. **Suite** – `npm ci`, `playwright install chromium`, then `playwright test --project=…` with the env below.
7. **Teardown** – container logs are saved, then `docker compose down -v` and the images are removed.

### App configuration (test mode)

All .NET hosts run as `Development` (as on the QA box) with every store/URL overridden by env
(`.ci-work/env/*.env`, generated). Notable switches: `Otp__Enabled=false` + `Otp__DevFixedCode=000000`
(fixed OTP), `WhatsApp__UseFakeSender=true` (every WhatsApp send is a `FAKE WhatsApp …` log line, Meta is
never called), `Recaptcha__Enabled=false`, SMTP → smtp4dev, `ClickUp__ApiToken` and `Meta__*` blank (those
integrations are skipped), `BackOffice__Operators__0` = the seeded CI operator only,
`FeeChallanScheduler__RunInterval=00:01:00` (`QA_CI_FEE_CHALLAN_RUN_INTERVAL`),
`WhatsAppNotifications__RunInterval=00:01:00` (`QA_CI_WHATSAPP_RUN_INTERVAL`).

### Suite environment exported by the entry point

`QA_BASE_URL`, `QA_FAMILY_URL`, `QA_AUTH_URL`, `QA_REST_API_URL` (the four https://localhost URLs),
`QA_IGNORE_HTTPS_ERRORS=true`, `QA_OTP=000000`, `QA_EMAIL/QA_PASSWORD` (owner), `QA_PARENT_EMAIL/…_PASSWORD/…_PHONE`,
`QA_BACKOFFICE_EMAIL/…_PASSWORD` (operator), `QA_SEED_SCRIPT`/`QA_PARENT_SCRIPT` (`ci/qa-data/*.sh`),
`QA_WORKER_LOG` (live `docker compose logs -f worker`), `QA_MONGOSH` + `QA_MONGO_URL` (container shim),
`QA_PG_HOST` `QA_PG_PORT` `QA_PG_USER` `QA_PG_PASSWORD` `QA_PG_SCHOOL_DB` (the psql shim on `PATH` forwards
`-U`, `-d` and `PGPASSWORD`, and drops `-h`/`-p`), `QA_ADMISSION_PREFIX=CI-`, `CI=true`.

## Suites

`auto` runs: `setup`, `anonymous`, `authenticated` (family-invites/invite-code-drawer), `shell-notes`,
`whatsapp-quota`, `challan-name`, `attendance-backdating`*, `family-setup`, `family` (join-with-code, new-parent,
existing-child-link, regenerate-race).

`challan-name` (PR 547) is in `auto`. `fixtures/fees.ts` (and `fixtures/attendance.ts`) take the Postgres user,
host, port, database and password from `QA_PG_USER`, `QA_PG_HOST`, `QA_PG_PORT`, `QA_PG_SCHOOL_DB` and
`QA_PG_PASSWORD`. When those are unset the qa555 defaults still apply (`postgres` on `127.0.0.1:5432`,
database `mp-shared-schools-db`; fees leaves the password unset, attendance falls back to `admin123`).
On the CI stack the role is `qaci`. Each challan-name file waits on the worker's 1-minute scheduler, about
12 minutes per file, and the project must run with `--workers=1` (the entry point's default; a higher
`--workers` is forced back to 1 when this project is selected).

\* `attendance-backdating` (MarksheetPlus PR 548) runs only when the checkout contains that feature (its empty
past-date roster message). Until PR 548 is merged into MarksheetPlus `main`, other PRs skip it with a warning
instead of failing on a feature they do not have. Add a `has_feature` rule in `ci/run-regression.sh` for any
future suite that lands here before its product PR merges.

## Deviations from production (by design)

- **OTP limiter**: the AuthApp/RestApi allow 30 register/verify calls per client IP per 15 min. A full run registers
  more throwaway owners/parents than that from one IP, so the edge gives each client connection its own private
  IPv6 address in `X-Forwarded-For` (the apps trust forwarded headers). The per-IP limit itself is therefore not
  exercised by CI. `QA_CI_SPREAD_CLIENT_IPS=false` turns this off.
- TLS is Caddy's local CA, not a public certificate; the suite ignores certificate errors (as on the QA box).
- No Seq, landing site or Meta/ClickUp/WhatsApp providers.

## Using it from MarksheetPlus

Paste `docs/qa/ci/qa-regression.workflow.yml` into MarksheetPlus `.github/workflows/qa-regression.yml`. It checks
out the PR (`mp/`) and MarksheetplusQA `main` (`qa/`), then calls `./qa/.github/actions/regression` with
`marksheetplus-path: mp`. What it needs from MarksheetPlus:

- **Secrets**: only the existing `GH_PACKAGES_TOKEN` (read:packages, private TailwindUi feed). `QA_EMAIL`,
  `QA_PASSWORD`, `QA_PARENT_EMAIL`, `QA_PARENT_PASSWORD` are no longer used and can be deleted.
- **Paths the entry point reads from the checkout**: `src/MarksheetPlusCode/{MarksheetPlusCode.sln,global.json,nuget.config}`
  and the five `.csproj` files (`MarksheetPlus.RestApi`, `MarksheetPlus.AuthApp/MarksheetPlus.AuthApp`,
  `MarksheetPlus.Worker`, `MarksheetPlus.WebApp`, `MarksheetPlus.FamilyApp`), plus `wwwroot/appsettings.json` of the
  two WASM apps (keys `ApiBaseUrl`, `AuthAppAuthority`). The product's `deploy/docker-compose*.yml` and
  `deploy/Dockerfile.*` are **not** used (they build inside Docker and need the feed secret as a BuildKit secret).
- **Config keys relied on** (all already in the product): `Otp:Enabled/DevFixedCode`, `WhatsApp:UseFakeSender`,
  `BackOffice:Operators`, `DeploymentAuth:*` + `GET /api/post-deployment`, `Issuer`, `OidcAuthority`,
  `WebAppOrigins`, `FamilyAppOrigins`, `ClientUrls`, `FamilyLink:*`, `ConnectionStrings:*`. Renaming any of these
  needs a matching change in `ci/run-regression.sh`.
- **Ports** on the runner: 7244, 7104, 7236, 7100 on 127.0.0.1 (override with `QA_CI_*_PORT`).
- PRs from forks get no secrets; with a cold NuGet cache their restore of `TailwindUi.Blazor` fails.

## Running it on the QA box

```bash
export DOCKER_HOST=tcp://127.0.0.1:2375 PATH=$HOME/.dotnet:$PATH
QA_CI_API_PORT=27244 QA_CI_AUTH_PORT=27104 QA_CI_WEB_PORT=27236 QA_CI_FAMILY_PORT=27100 \
  ci/run-regression.sh --mp-dir /workspace/mp-ci-main --project qaci
```

Use a scratch MarksheetPlus clone, a project name no other stack uses, and ports no other stack holds.

Note for branch testing on the box (not CI): `fixtures/devenv.ts` now defaults `QA_SEED_SCRIPT`/`QA_PARENT_SCRIPT`
to `ci/qa-data/{seed,parent}.sh`, whose identities come from `ci/qa-data/accounts.env`. On a stack seeded by
`/workspace/devenv/seed.sh`, set `QA_SEED_SCRIPT=/workspace/devenv/seed.sh` and
`QA_PARENT_SCRIPT=/workspace/devenv/parent.sh` in your local `.env` (or export the `OWNER_*` variables of that stack).

## Latest local run

Fresh compose project on the QA box (remote Docker host), MarksheetPlus `main` @ `34dfb96e`, 1 worker:
publish + images + stack + migrations + seed took ~1.5 min (warm NuGet/obj cache), the suite 44.4 min.

| project | passed | failed | flaky | skipped |
|---|---|---|---|---|
| setup | 1 | 0 | 0 | 0 |
| authenticated (family-invites drawer) | 13 | 0 | 0 | 0 |
| shell-notes | 26 | 1 | 0 | 1 |
| whatsapp-quota | 94 | 0 | 0 | 0 |
| family-setup | 1 | 0 | 0 | 0 |
| family | 38 | 0 | 1 | 3 |
| attendance-backdating | skipped (PR 548 not on `main`) | | | |
| **total** | **173** | **1** | **1** | **4** |

The skips are existing `fixme`/opt-in tests. The one failure (`notes-core.spec.ts:64`, the server-side delete
check timing out after 5 s) and the flaky `join-with-code.spec.ts:129` are timing-sensitive; see Known gaps.

## Known gaps

- The per-IP OTP limiter is not exercised (see Deviations).
- `attendance-backdating` is skipped until MarksheetPlus PR 548 is on the checked-out branch, so its Postgres
  back-dating through the `psql` shim has not run in CI yet.
- Specs written against the shared site's seed hard-code its display names ("Testenv High School - Main",
  father "Imran Khan"); `accounts.env` uses the same names. Change both together.
- The workflow has not been run on GitHub Actions yet (only end to end on the QA box with a remote Docker host).
- Fork PRs get no `GH_PACKAGES_TOKEN`, so the NuGet restore fails for them.
- Node prints a harmless `NO_COLOR is ignored due to FORCE_COLOR` warning per worker.
