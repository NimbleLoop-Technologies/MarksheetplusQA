# Campus Setup, Subscription, Multi-campus

**Code slice(s):** `Features/CampusSetup + SubscriptionManagement + AccessRoles` (read its README.md)

**Routes:** /campus/create, /subscription, /subscription/plan, /subscription/blocked, /backoffice/*

**Endpoints / use cases:** CreateCampus (→ welcome email after 24h), Get/UpdateCampusSettings, CheckCampusUniqueness, GetMyCampuses, SwitchCampus; access role CRUD

## Business rules & known risk areas
- Campus name unique
- Trial/active/blocked gating; 'Enter a Blocked Campus' in development
- After registration back-arrow should not drop into campus setup (86evmu39q)

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
