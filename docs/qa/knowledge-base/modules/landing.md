# Landing Site

**Code slice(s):** `Features/Landing` (read its README.md)

**Routes:** /, /features, /pricing, /contact, /request-demo, /join, /support, /privacy, /terms

**Endpoints / use cases:** Forms publish events → Worker Landing*Consumer (contact, demo, newsletter, preorder, signup, support, feedback) → ClickUp lead + Meta conversion

## Business rules & known risk areas
- reCAPTCHA on forms
- Pricing reflects default subscription plan
- Verify no real ClickUp leads are created from test env

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
