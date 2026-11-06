# MarksheetPlus QA Knowledge Base — Overview

Education cloud platform (Pakistan-focused): schools run operations (admissions, classes, attendance, exams, fees, bookshop/POS, staff, payroll); parents follow their children via the Family (Parents) App.

- Source repo: `NimbleLoop-Technologies/MarksheetPlus` (monorepo). Solution at `src/MarksheetPlusCode/`.
- Stack: .NET 10 minimal API, Blazor WASM (PWA), .NET Worker, PostgreSQL (school tenant data), MongoDB (accounts/auth, staff invites, subscriptions, notifications outbox), RabbitMQ, MinIO, Seq, Caddy, Docker Compose. Tailwind UI (Metronic removed in MIG-F7).
- Product docs inside the code repo: `product/knowledge-base/*.md`, `product/ux-flow-*.md`, `docs/adr/0001..0010`, `docs/Marksheet+ - *.md`. Each feature slice has a `README.md` with business rules — read it before testing that slice.
- Latest release: v1.12.0 (1 Nov 2026, Sprint 26) — Registrar & Account Office UI redesign; quality score 3/10, 5 items still in QA.

## Test instances
| Surface | Integration | Local (Dan's shared stack) |
|---|---|---|
| School/Admin WebApp | qa-integration.marksheetplus.com | https://localhost:7236 |
| Family App | family-integration.marksheetplus.com | https://localhost:7100 |
| Landing | landing-integration.marksheetplus.com | (not running) |
| AuthApp | — | https://localhost:7104 |
| RestApi | — | https://localhost:7244 |
| smtp4dev / Seq / RabbitMQ | — | :5013 / :5341 / :15672 |

Local seeded accounts: admin `owner@testenv.local`, parent `parent@testenv.local` (passwords per Dan's handoff). Dev OTP = `000000`; WhatsApp sends are faked into the Worker log.

## Index
- [architecture.md](architecture.md) — projects, planes, auth, error patterns
- [modules/](modules/) — one file per domain module
- [workflow.md](workflow.md) — ClickUp statuses, ticket/bug conventions, people
- [critical-flows.md](critical-flows.md) — regression priorities
- [glossary.md](glossary.md)
