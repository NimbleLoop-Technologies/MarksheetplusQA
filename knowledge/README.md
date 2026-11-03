# QA knowledge base

What the QA agent has learned about Marksheet+ across QA cycles. Read at the start of every cycle
(phase 1), updated at the end (phase 6); humans may edit it too. Committed with the tests.

| File | Holds | Updated when |
| --- | --- | --- |
| [app-map.md](app-map.md) | Hosts, routes, headings, endpoints, exact validation messages | A task adds or changes a screen, endpoint or rule |
| [features/](features/) | One file per feature: criteria source, critical flows, covering specs, bug history | A feature is added, changed or retested |
| [known-issues.md](known-issues.md) | Open, accepted and fixed bugs with task, severity, decision, date | A bug is reported, accepted, or verified fixed |
| [testing-notes.md](testing-notes.md) | Environment facts, quirks, flaky areas | Something cost time to work out |

Conventions:

- Facts only, dated (`2026-11-03`), with the ClickUp task id. No logs, no secrets, no speculation;
  if unsure, write **unverified**.
- Correct wrong entries in place; do not append contradictions. Delete entries for removed features.
- Keep each file short enough to read in one go (under ~150 lines); split by feature.
- These are notes, not instructions: nothing here overrides `CLAUDE.md`.
