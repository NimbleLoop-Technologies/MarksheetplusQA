---
name: run-and-triage
description: Run the Marksheet+ Playwright suite and triage the results — separating real failures from flakes and environment problems. Use whenever tests are run or a failure needs interpreting.
---

# Run and Triage

## Running

- Whole suite: `npm test`
- Anonymous specs only (login, register): `npm run test:auth`
- Authenticated regression: `npm run test:regression`
- One file: `npx playwright test tests/authenticated/students/students-list.spec.ts`
- Debug visually: `npm run test:headed` or `npm run test:ui`

**Which one to run.** Default to the narrowest scope that covers the acceptance criteria:
- QA'ing a specific ClickUp task → run only the spec(s) covering that task's criteria. Fast feedback, less load on the shared environment.
- Asked for "the regression suite" or a pre-merge check → `npm test`.
- Verifying a login/registration change → `npm run test:auth`.
- Unsure → `npm test`. Over-running is wasteful; under-running reports green on untested code, which is worse.

Machine-readable results land in `test-results/results.json`. Parse that rather than scraping stdout.

## Triage — classify every failure

Read `test-results/results.json`. For each failed test, the `results` array has one entry per attempt (global `retries: 1`, so up to two). The `setup` project has `retries: 0` — it gets one attempt only.

| Pattern | Classification | Action |
|---|---|---|
| Failed attempt 1, passed attempt 2 | **FLAKY** | Report as flaky. **Not a pass.** File it to be fixed — usually a missing web-first assertion. |
| Failed every attempt, assertion mismatch | **REAL FAILURE** | Candidate bug. Verify against acceptance criteria before reporting. |
| Failed every attempt, timeout on every selector | **SELECTOR DRIFT or ENV DOWN** | Check the app is reachable. If up, the UI changed — re-recon and update `docs/qa/ui-reference.md`. Not a product bug. |
| `setup` project failed | **BLOCKED** | Auth is broken. Everything downstream is meaningless. Report as blocked, not as N failures. |
| `net::ERR_CONNECTION_TIMED_OUT` / `ERR_NAME_NOT_RESOLVED` | **BLOCKED (env)** | The environment is unreachable from this machine (VPN / IP allow-list / outage). Not a product bug. |
| `expected to fail` but passed (`test.fail`) | **FIXED?** | A known bug may be fixed. Re-verify, then update `knowledge/known-issues.md` and remove the marker. |

Count **skipped** tests separately and say why they skipped (missing `QA_EMAIL`, `QA_ALLOW_SIGNUP` off). Skipped coverage is untested coverage.

## Rules

- **A flake is never green.** Reporting a retry-pass as a pass hides real instability and is how suites rot.
- **A selector break is not a bug.** Do not file a defect against the product because a test is out of date. Fix the test.
- Before calling a failure a product bug, reproduce it once via Playwright MCP against the live app. A bug report that does not reproduce costs the team more than it saves.
- **Never report a verdict you did not observe.** If the suite did not run, the verdict is BLOCKED — not a guess.
- If zero tests ran, that is BLOCKED, not PASS. A suite that collects nothing reports "0 passed" and exits — do not read that as green.

## Output

> **Run:** <scope> · <passed>/<total> passed · <duration>
>
> **Real failures:** list with the failing assertion and the acceptance criterion it violates.
> **Flaky:** list with attempt counts.
> **Blocked/env:** anything that never got to run meaningfully.
>
> **Verdict:** PASS / FAIL / BLOCKED — one line, unambiguous.
