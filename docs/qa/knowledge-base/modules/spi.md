# SPI & Analytics

**Code slice(s):** `Features/Analytics` (read its README.md)

**Routes:** /analytics, /analytics/class-dashboard, /analytics/exam-dashboard, /sessions/{SessionId}/performance, /dashboard

**Endpoints / use cases:** Main/class dashboard metrics, absences, exams, session performance summary/charts/tables/heatmap/position holders

## Business rules & known risk areas
- SPI 0-100 per student per term: cohort normalisation, subject weight, anti-noise/confidence pull, growth velocity; summative only
- Bug z94x8ea28k (high, QA): confidence pull caps scores below 80 → Top performers empty
- Calc runs in Worker after mastersheet publish — verify recalculation on republish

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
