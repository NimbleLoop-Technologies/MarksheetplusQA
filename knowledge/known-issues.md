# Known issues

Bugs the QA agent has reported, and what happened to them. Status is **open**, **accepted**
(a human said won't-fix / later: don't re-report, list as known) or **fixed** (re-verified).
Slug = the short id used in the ClickUp comment and in `test.fail()` specs.

| Slug | Severity | Where | Summary | Task | Found | Status | Decision / fixed in |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1-pr555 | normal | WhatsApp fee receipt send | Empty default FeePaymentReceiptTemplateName: receipt Sent/charged (fake) or permanently Failed (real); doc says Pending | z94x8e9yhj | 2026-11-10 | fixed | Default is fee_payment_receipt; empty name Defers (Pending, credit released). Retested cycle 2 @ c590647e |
| R2-pr555 | normal | campus/notification-preferences PUT | Complement storage: old client's disabledKinds silently enables Fee receipt | z94x8e9yhj | 2026-11-10 | open | Retested cycle 2 @ c590647e: still stores [6,2] after PUT disabledKinds=[1] |
| R3-pr555 | normal | Fee receipt PDF | Relative _content brand logo renders broken | z94x8e9yhj | 2026-11-10 | fixed | Build() inlines brand logo as data:image/svg+xml;base64. Retested cycle 2 @ c590647e |
| R4-pr555 | normal | Fee receipt message/PDF | Fractional amounts rounded (N0) | z94x8e9yhj | 2026-11-10 | open | Retested cycle 2 @ c590647e: 250.75 still becomes Rs. 251 / PKR 251 |
| R5-pr555 | high (pre-existing) | GET fee-payments/payments/{id}/receipt | Non-GUID id -> 500 FormatException | z94x8e9yhj | 2026-11-10 | open | Retested cycle 2 @ c590647e: not-a-guid / %20 / long string still 500; random GUID 404 |
| C1-pr547-malformed-challanid-500 | High | `GET /fee-payments/families/{id}/outstanding?challanId=`, `GET .../challan-prints` | Malformed `challanId` (or familyId on the new `challan-prints`) → HTTP 500 (`System.FormatException: Unrecognized Guid format`, stack trace in body on dev). Malformed familyId was already 500 on legacy routes. | z94x8eapp5 (PR 547 @9e957279) | 2026-11-10 | open | spec `tests/authenticated/challan-name/student-mode.spec.ts` "C1 …" |
| C2-pr547-receipt-names-family | Low | Payment received dialog / receipt / `GET .../receipt` | A payment against a student challan is receipted "Received from <X> Family" (`familyName`); lines name the student. Ticket wording is about challans; open question to PO. | z94x8eapp5 | 2026-11-10 | open | `mode-switch.spec.ts` "C2 …" |
| C3-pr547-families-tile-counts-rows | Normal | Fee Payment tiles "Families with dues" / "Overdue N families" | In a per-student school the tiles show the row count (students + family rows): 4–6 shown for 2 families. `summary.pendingChallans = totalCount`. | z94x8eapp5 | 2026-11-10 | open | `mode-switch.spec.ts` "C3 …" |
