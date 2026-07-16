# Marksheet+ Automated QA Workspace — Design

**Date:** 2026-07-16
**Status:** Approved
**Target environment:** `https://qa-integration.marksheetplus.com`

## Purpose

Turn this repo into a single workspace that is two things at once:

1. A **Playwright Test project (TypeScript)** holding the automated regression suite for Marksheet+.
2. A **Claude Code QA workspace** — agents and skills that pull QA work from ClickUp, execute both scripted and exploratory testing against the QA integration environment, and report results back.

The goal is a closed loop: a task lands in the ClickUp `qa` status, Claude tests it (scripted + exploratory), and the outcome is reported back with evidence.

## Decisions

These were settled during brainstorming and are not open for re-litigation during implementation:

| Decision | Choice |
|---|---|
| ClickUp model | Pull tasks from the `qa` status of the existing Dev Backlog (`901812410599`). Report results back to the same task. |
| Test auth | Seeded test accounts via `.env`, logged in once and reused via Playwright `storageState`. Plus a registration helper for tests that need a fresh account. |
| Initial regression scope | Auth / login and Students management. Structure must stay open for Classes, Sessions, and other modules later. |
| Packaging | In-repo `.claude/` (agents, skills, commands, settings) — not a standalone plugin. |
| Language | **TypeScript** throughout (config, page objects, fixtures, specs). |
| ClickUp status transitions | Comments and bug write-ups are posted automatically. **Status transitions require human confirmation.** |
| CI pipeline | Out of scope for this pass. Config must be CI-ready, but no pipeline is built. |

## Architecture

### Directory layout

```
MarksheetplusQA/
├── .claude/
│   ├── agents/
│   │   ├── qa-lead.md            # orchestrator: scans qa-status, dispatches, reports to ClickUp
│   │   ├── regression-author.md  # writes/updates Playwright TS tests (TDD)
│   │   └── exploratory-tester.md # drives live site via Playwright MCP, captures evidence, files bugs
│   ├── skills/
│   │   ├── qa-task-context/      # pull QA task + linked story + acceptance criteria from ClickUp
│   │   ├── write-regression-test/# repo conventions: POM, selectors, fixtures, data isolation
│   │   ├── run-and-triage/       # run suite, read report, classify real-fail vs flaky
│   │   └── report-to-clickup/    # post pass/fail + bug report, propose status transition
│   ├── commands/
│   │   ├── qa.md                 # /qa <clickup-id>  → full flow on one task
│   │   └── qa-regression.md      # /qa-regression     → run whole suite + summarize
│   └── settings.json             # enable clickup + superpowers plugins, permission allowlist
├── .mcp.json                     # pin @playwright/mcp@latest
├── tests/
│   ├── auth/                     # login, logout, register, invalid-login
│   └── students/                 # student management flows
├── pages/                        # Page Object Models (TS)
├── fixtures/                     # auth.setup.ts, test-data helpers, unique-email generator
├── playwright.config.ts          # baseURL from QA_BASE_URL, retries, trace/screenshot/video
├── tsconfig.json
├── package.json
├── .env.example                  # QA_BASE_URL, QA_EMAIL, QA_PASSWORD (real .env gitignored)
└── README.md
```

### Component responsibilities

Each unit has one purpose and a defined interface:

**`pages/` — Page Object Models.** One class per screen. Exposes intent-level methods (`login(email, password)`, `openStudentProfile(name)`); hides selectors. Tests never touch raw selectors. Changing a selector must not change any spec.

**`fixtures/` — test infrastructure.** `auth.setup.ts` (login-once, save state), unique test-data generators, `registerNewAccount()` helper. Consumed by specs via Playwright fixtures; no test constructs its own auth.

**`tests/` — specs.** Declarative, one behaviour per test, named for the acceptance criterion they prove. Depend on `pages/` and `fixtures/` only.

**`.claude/agents/` — orchestration.** Each agent has a narrow remit and communicates through the skills, not by reaching into each other's internals.

**`.claude/skills/` — procedures.** Each encodes one repeatable QA procedure so agents behave consistently.

## Test suite design

### Authentication
`auth.setup.ts` runs once as a Playwright *project dependency*: it logs in through the UI using `QA_EMAIL` / `QA_PASSWORD` from `.env`, then saves `storageState` to `.auth/user.json` (gitignored). All subsequent test projects declare a dependency on setup and load that state — no repeated logins, fast suite.

Tests that specifically exercise auth (invalid login, registration) run *without* stored state, in their own project with no setup dependency.

### Fresh accounts
`registerNewAccount()` drives the register form with a generated unique email (timestamp + random suffix) for flows that require a brand-new user. Returns the created credentials for the test to use.

### Reliability
- `retries: 1` — surfaces flakes without hiding them.
- `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `video: 'retain-on-failure'` — enough evidence to triage a failure without re-running it.
- Test data is uniquely generated per run so tests never collide and can run in parallel.
- `baseURL` from `QA_BASE_URL` so the suite can be pointed at another environment without edits.

### Initial coverage
- **Auth:** successful login, invalid credentials rejected, logout, registration of a new account.
- **Students management:** the core happy flows for student listing, profile view, and create/edit.

Later modules (Classes, Sessions) follow the same POM + fixtures pattern and require no structural change.

## The QA loop (data flow)

1. `qa-lead` receives a task ID via `/qa <id>`, or scans the `qa` status in the Dev Backlog.
2. `qa-task-context` skill pulls the task, its linked Product user story, acceptance criteria, and persona from ClickUp.
3. `qa-lead` dispatches in parallel:
   - `regression-author` → writes or updates the automated TS test covering the acceptance criteria (TDD).
   - `exploratory-tester` → drives the live QA site via Playwright MCP for edge cases outside the scripted path, capturing screenshots.
4. `run-and-triage` runs the relevant suite subset, reads the JSON/HTML report, and separates real failures from flakes (a failure that passes on retry is reported as flaky, not green).
5. `report-to-clickup` posts a structured comment: result, repro steps, and evidence. On failure it includes a bug write-up. It then **proposes** a status transition (pass → complete, fail → back to development) and waits for human confirmation.

## Error handling

- **Environment unreachable:** the suite fails fast with a clear message rather than producing hundreds of confusing timeouts.
- **Auth setup failure:** treated as a blocking error — no point running dependent tests against a broken login. Reported distinctly from test failures.
- **Flaky tests:** classified separately from real failures by `run-and-triage`. Never silently swallowed; reported as flaky so they can be fixed.
- **ClickUp unavailable:** results are still written locally and surfaced to the user; the run is not lost because reporting failed.

## Testing strategy

The suite *is* the test artifact, so validation is about proving the harness works:

- Auth specs are the canary — if login and stored state work, the infrastructure is sound.
- Each new page object gets at least one happy-flow spec proving it drives the real screen.
- The suite must pass green against live `qa-integration` before the setup is considered complete. A suite that has never run against the real environment is unverified.

## Out of scope

- CI/CD pipeline (GitHub Actions).
- Performance, load, and security testing.
- Cross-browser matrix beyond Playwright's default Chromium for the first pass.
- Test case management outside ClickUp.
