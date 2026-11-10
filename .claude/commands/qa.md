---
description: Run the full QA cycle on a ClickUp task — context, plan, test, triage, report
argument-hint: <clickup-task-id-or-url>
---

Run the full QA cycle on ClickUp task: $ARGUMENTS

Dispatch the `qa-lead` agent. It must follow the QA cycle in CLAUDE.md:
1. Read `knowledge/` and ground the task via the `qa-task-context` skill.
2. Write the numbered test plan under `.qa/<task-id>/`.
3. Dispatch `regression-author` and `exploratory-tester` in parallel.
4. Triage via `run-and-triage`.
5. Report via `report-to-clickup` — posting bug and verdict comments, but proposing the status transition and waiting for my confirmation.
6. Update `knowledge/` and `docs/qa/ui-reference.md`.

If no task id was provided above, ask me for one before doing anything.
