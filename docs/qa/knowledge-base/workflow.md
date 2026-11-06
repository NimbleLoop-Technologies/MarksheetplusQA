# Workflow (ClickUp)

## Where things live
- Development space → **Marksheet+** folder (90189122452): Backlog (901812410599, the working list), Releases (901818733288, one ticket per release e.g. z94x8ebktr v1.12.0), Dev - Marksheet+, Misc Tasks, sprint lists (Sprint 26 = 5–18 Oct 2026 is latest).
- Product Engineering → **MARKSHEET+** folder (90188014077): Roadmap (MVP 1 released, MVP 2 ideation), Features (statuses: planned, defining, designing, story writing, ready, commited), Stories (idea, prioritizing, ready, commited to sprint).

## Backlog status flow
`backlog → ready → discovery → ui approval → ui approved → development → code review → qa → integration (done) → released (closed)`
- QA picks tickets in **qa**; pass → **integration** (merged to integration env); release ticket moves them to **released**.
- Releases carry a "Quality Score" and list items still in QA.

## Task types & conventions
- Task types seen: **Story** (tags `feature`, `rel-<date>`), **Bug** (subtask, `parent` = story), plus umbrella "issues"/"suggestion" tasks.
- Story template: Requirement Statement (As a… I want… so that…) → Story Details (Navigation/Access incl. route, Screen Structure, Content Specs table, Functional Flow) → Primary Scenarios → Alternate Scenarios → Business Interaction Rules → **Acceptance Criteria** (grouped bullets + Given/When/Then) → Definition of Done → Figma link. Test cases map 1:1 to AC bullets + scenarios.
- Bug template (historically by QA Sidra Noor Asif): title = observed behaviour, "### Description" with expected behaviour. Thin — our bugs must add: Environment/branch, Steps to reproduce, Expected, Actual, Evidence (screenshot/video), AC reference.
- Bug title prefixes in use: "Suggestion-…", "UI issue".
- Priority rule (Umair): **high** = missing acceptance criteria or unhandled errors/exceptions; **normal** = other bugs; **low** = suggestions. (urgent used rarely for release blockers.)

## People
| Dev | Areas seen |
|---|---|
| Muhammad Abdullah | SPI/analytics, WhatsApp quota/notifications, fee challan generation, exam paper generator, family ledger, leave management |
| Muhammad Usman Tahir | Family app (linking, datesheet, exams), attendance, archive, dashboard tiles |
| Muhammad Tashif | Fee statements/payments (family finance), bookshop/sales, payroll & incentives, staff role assignment, blocked campus |
| Umair Tahir | Owner/PM; UI migration (Tailwind), files issue/suggestion umbrellas |
| Dan (agent) | PR #550 family invite codes (ticket z94x8ebqpt) |
| Sidra Noor Asif | Previous QA, bug creator |

## QA cycle rules (from Umair)
Branch testing on own instance; only assigned tickets; read linked tickets; run regression first; Claude writes/executes tests via Playwright MCP and only reports (no tickets/PR comments; don't use `report-to-clickup` skill); I verify false positives and file Bug subtasks with evidence; track cycle number + previous report per branch; add critical/bug-repro flows to regression suite.
