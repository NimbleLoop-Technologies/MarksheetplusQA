# Staff Room

**Code slice(s):** `Features/StaffManagement` (read its README.md)

**Routes:** /staff/add, /staff/{StaffId}/profile, staff register; AuthApp /staff/app-access/invites/{Token}

**Endpoints / use cases:** AddStaff, profile sections (basic/contact/employment/statutory), qualifications & certifications (+docs), salary set/revise, MarkStaffAsLeft, RehireStaff, app-access invite send/resend/revoke/accept

## Business rules & known risk areas
- Invite requires phone; invite lives in Mongo; accept = atomic user+membership
- Role assignment to invited staff (z94x8ean2x, code review)
- Archive staff (z94x8e5pan)
- Open umbrella ticket z94x8ebrbk 'Staff module issues'

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
