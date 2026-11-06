# Architecture

## Projects (src/MarksheetPlusCode)
| Project | Role |
|---|---|
| MarksheetPlus.RestApi | Minimal-API host. Pipeline: ForwardedHeaders → HTTPS → AuthN → Routing → CORS → RateLimiter (OTP) → AuthZ → `AuthStateMiddleware` → `ArchiveStateConflictMiddleware` → `UseFeatures()`. OpenAPI + dev exception page in Development/integration. |
| MarksheetPlus.Features | ~600 files; all vertical slices (endpoints = static classes `Map<UseCase>` under `<Slice>/Usecases`). The real business logic. |
| MarksheetPlus.Infrastructure | EF Core (Postgres), Mongo, RabbitMQ, MinIO, repositories, unit of work, outbox. |
| MarksheetPlus.Worker | Schedulers (`GenerateFeeChallansScheduler`, `WhatsAppQueueScheduler`, `SendWelcomeEmailsScheduler`, `MetaConversionSweepScheduler`) + RabbitMQ consumers (SPI calc/recalc, challans generated, datesheet projection, family finance/linking/purchases/learners projections, ledger posting, staff access provisioning, auth email/WhatsApp, landing leads, subscriptions, register entries, outbox relays). |
| MarksheetPlus.AuthApp (+Client, Tests) | Login/register/OTP/password reset/staff invite accept UI (`/auth/{Action}`, `/auth/verify-email`, `/auth/verify-whatsapp`, `/staff/app-access/invites/{Token}`). |
| MarksheetPlus.WebApp | School/admin Blazor WASM shell (`ModuleRoot`, `Subscription`, `LegacyRedirect`). Pages live in module Razor libs: StudentsManagement, ClassManagement, FeeManagement, StaffManagement, Bookshop, Sessions (exams), Analytics, Permissions, BackOffice. |
| MarksheetPlus.FamilyApp + FamilyOnboarding | Parents PWA: `/`, `/family/setup`, `/family/management`, `/link`, `/exams`, `/exams/child/{ChildId}/{EnrollmentId}`, `/fees`, `/fees/child/{LearnerId}/{EnrollmentId}`, `/payments`, `/purchases`, `/purchases/bill/{SchoolId}/{BillId}`, `/children/{LearnerId}/timeline`. |
| MarksheetPlus.Landing (+Client) | Marketing site: `/`, `/features`, `/pricing`, `/contact`, `/request-demo`, `/join`, `/support`, `/privacy`, `/terms`. Forms go via RabbitMQ to Landing* consumers (ClickUp lead creation via `IClickUpService`, Meta conversions). |
| BackOffice | Platform-owner console: `/backoffice`, customers, pending, plans, quota-packages, quota-requests, settings. |
| Core / Shared / Abstractions / BrowserInfra / Identity.Client / Auth / Permissions | Value objects, `UniversalValidators` (Name, Email, Phone, CNIC, Password, BankAccount, ExamPaperPart), paging, shared UI components, client auth. |
| Server.Tests, Marksheet.Client.Tests, AuthApp.Tests | Existing unit/integration tests (xUnit/bUnit) — dev-owned. |

## Data planes
- **School plane** (Postgres, tenant = campus). Fail-closed tenant query filters.
- **Accounts** (Mongo): users, `UserTenant` memberships, staff invites, subscriptions, quotas, scheduled emails.
- **Family / Learner plane** (`FamilyDbContext`): FamilyProfile, Learner, LearnerEnrollment, Guardianship, projections (PublishedDatesheet, LearnerFeeStatements, LearnerPurchasesSnapshot, timeline). Populated **asynchronously** via school outbox → RabbitMQ → Worker. Rule: *mirror, never compute* (ADR 0009). QA implication: parent-side data lags and depends on the Worker running; stale-projection bugs are common.

## Auth & roles
- JWT HS256 access (60 min) + refresh (14 d, token-family rotation). Claims: `persona` (Family | Campus | Accounts), optional `tenant`, permissions claim, `email_verified`.
- Registration requires email OTP; pending account login → **403 VERIFICATION_REQUIRED**. Password reset = 6-digit OTP → 15-min reset token. PK phone normalization 03xx → +92xx. OTP endpoints rate-limited per IP (429).
- Policies: `RequiresTenant`, `MarksheetRequiresFamilyPersona`, refresh, otp-request. Family-lobby endpoints must use family-persona policy (a campus token also carries a tenant!) — good negative test.
- RBAC: seeded system roles Head Admin, Campus Manager, Academic Coordinator, Teacher, Accountant, Bookshop Admin (fixed GUIDs c000…01–06) + custom roles (create/clone/edit). Modules: home, registrar-office, classrooms, attendance, fee-management, payroll-management, staff-room, bookshop, examination-center, analytics, setup. Permissions are See/Edit/Export style per module (submodule-level permissions doc exists). Multi-campus: `SwitchCampus` endpoint.
- Subscription gate: trial → active → blocked (`/subscription/blocked`); blocked/deactivated campuses excluded from challan generation & WhatsApp.

## Error handling / validation patterns (what to assert)
- Endpoints return RFC7807 `Results.Problem(message, status)` with user-facing copy, and `ValidationProblem` (field dictionary) for input errors. Expect: 400 validation, 403 permission, 404 not found/withdrawn, 409 conflict (concurrency `ExpectedVersion`, uniqueness, archive state, already-claimed), 410 expired, 429 throttling, 500 with generic "try again" copy (logged to Seq).
- Uniqueness checks have dedicated `Check*Uniqueness` endpoints (class, admission number, campus, fee policy, fund, staff) used for inline validation.
- `ArchiveStateConflictException` → 409 via middleware (writes against archived records).
- Concurrency: attendance and others require `ExpectedVersion`; stale → 409.
- QA heuristics: unhandled exceptions surfacing as raw 500 or blank UI = **high** priority bug per Umair's rule.
