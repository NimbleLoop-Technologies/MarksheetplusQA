# Family App: Setup, Linking, Invites

**Code slice(s):** `Features/FamilySetup + FamilyLinking + Learners` (read its README.md)

**Routes:** /family/setup, /family/management, /link, /children/{LearnerId}/timeline

**Endpoints / use cases:** CompleteFamilySetup (mints family tenant), child add/update/remove, Get pending invites, AcceptStudentLink, RejectStudentLink, RedeemInviteCode (6-char code)

## Business rules & known risk areas
- One student ↔ one family (unique index → 409 StudentAlreadyClaimed)
- Invite reachable by WhatsApp token or caller's OTP-verified phone only
- Redeem errors: 404 invalid/withdrawn, 409 used, 410 expired, 429 lockout
- Caller must be recipient (CallerMayAnswer); campus token must be rejected
- PR #550 / z94x8ebqpt simpler invite (codes) — first QA cycle
- Bugs: wrong message adding child to linked account (z94x8e4qrb), can't link second child (z94x8eanca, high), incomplete child list on modal (z94x8e3138)

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
