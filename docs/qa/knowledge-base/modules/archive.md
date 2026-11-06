# Archive / Restore

**Code slice(s):** `Features/Archiving` (read its README.md)

**Routes:** Archived views per list

**Endpoints / use cases:** POST /{resource}/{id}/archive, restore, GET /{resource}/archived for classes, students, additional-funds, staff, bookshop/inventory, bookshop/kits, sessions

## Business rules & known risk areas
- Writes against archived records → 409 via middleware
- Archive Data (z94x8e2np5, high, QA); Archived student in Parent app (z94x8e5pa8)
- Restore must preserve relationships (class, policy status, kit stock)

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
