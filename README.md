# Marksheet+ QA

Automated QA workspace for **Marksheet+** on `qa-integration.marksheetplus.com`: a
Playwright/TypeScript regression suite plus a Claude Code QA workspace (instructions, agents,
skills and QA skill plugins) that pulls work from ClickUp, tests it, finds and reports bugs, and
grows the suite. No CI pipeline — every run is started by a person.

Open Claude Code **from this folder** so it loads [CLAUDE.md](CLAUDE.md), the skills, the QA
plugins and the Playwright MCP server.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then fill in QA_EMAIL / QA_PASSWORD
```

`.env` and `.auth/` hold live credentials and session cookies. Both are gitignored. Never commit
them. The QA environment must be reachable from your machine (VPN / allow-listed IP).

## Running tests

| Command | What it does |
|---|---|
| `npm test` | Whole suite. |
| `npm run test:auth` | Logged-out specs: sign-in and sign-up (project `anonymous`). |
| `npm run test:regression` | Logged-in specs (project `authenticated`, signs in once via `setup`). |
| `npm run test:critical` | `@critical` journeys only. |
| `npm run test:headed` | Watch it run in a real browser. |
| `npm run test:ui` | Playwright UI mode — best for debugging. |
| `npm run report` | Open the last HTML report. |
| `npm run typecheck` | Type-check without emitting. |

Set `QA_ALLOW_SIGNUP=true` in `.env` to include the spec that registers a real account.

## Layout

| Path | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | The agent's instructions: the six-phase QA cycle, bug template, severity, rules |
| `tests/anonymous/` | Specs that must run logged out. **No selectors here.** |
| `tests/authenticated/<module>/` | Specs that need the seeded user. **No selectors here.** |
| `pages/` | Page objects. Selectors live here, and only here. Hosts in `pages/urls.ts`. |
| `fixtures/` | Auth setup, unique test data, sign-up helper. |
| [docs/qa/ui-reference.md](docs/qa/ui-reference.md) | Selectors and where each came from (source vs observed). |
| [knowledge/](knowledge/) | QA memory across cycles: app map, per-feature notes, known issues, testing notes. |
| `.claude/skills/` | `qa-task-context`, `write-regression-test`, `run-and-triage`, `report-to-clickup`. |
| `.claude/agents/` | `qa-lead`, `regression-author`, `exploratory-tester`. |
| `.claude/commands/` | `/qa`, `/qa-regression`. |
| `*-testing/`, `qa-toolkit/`, … | 8 QA skill plugins (test design, strategy, API, accessibility, performance, metrics, automation, toolkit) served by the local marketplace in `.claude-plugin/`. |
| `.qa/<task-id>/` | Per-task output: scope, test plan, results, screenshots (gitignored). |

Projects map one-to-one onto directories (`setup` → `fixtures/`, `anonymous` → `tests/anonymous/`,
`authenticated` → `tests/authenticated/`). A spec placed directly in `tests/` belongs to no
project and never runs.

## The QA cycle in Claude Code

| Command | What it does |
|---|---|
| `/qa <clickup-id>` | Full cycle on a ClickUp task: context → plan → scripted + exploratory testing → triage → bug and verdict comments → knowledge update. |
| `/qa-regression` | Run the whole suite and give a PASS / FAIL / BLOCKED verdict. |

Bugs are written up with steps, expected/actual, severity and a screenshot, posted one per
ClickUp comment, and covered by a `test.fail()` spec until fixed. **Status transitions always
wait for a human.**

Requires the ClickUp connector to be authorised (`/mcp`). Without it the suite and exploratory
testing still work; results are written to `.qa/<task-id>/` instead.

## Conventions

- Selector priority: `getByRole` → `getByLabel` → `getByTestId` → CSS (last resort, comment why).
- Never `waitForTimeout`. Use web-first assertions.
- Unique test data always (letters-only names) — parallel runs and other testers share the environment.
- A flake is not a pass. An unreachable environment is BLOCKED, not FAIL.
