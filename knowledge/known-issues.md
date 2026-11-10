# Known issues

Bugs the QA agent has reported, and what happened to them. Status is **open**, **accepted**
(a human said won't-fix / later: don't re-report, list as known) or **fixed** (re-verified).
Slug = the short id used in the ClickUp comment and in `test.fail()` specs.

| Slug | Severity | Where | Summary | Task | Found | Status | Decision / fixed in |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1-pr555 | normal | WhatsApp fee receipt send | Empty default FeePaymentReceiptTemplateName: receipt Sent/charged (fake) or permanently Failed (real); doc says Pending | z94x8e9yhj | 2026-11-10 | open | |
| R2-pr555 | normal | campus/notification-preferences PUT | Complement storage: old client's disabledKinds silently enables Fee receipt | z94x8e9yhj | 2026-11-10 | open | |
| R3-pr555 | normal | Fee receipt PDF | Relative _content brand logo renders broken | z94x8e9yhj | 2026-11-10 | open | |
| R4-pr555 | normal | Fee receipt message/PDF | Fractional amounts rounded (N0) | z94x8e9yhj | 2026-11-10 | open | |
| R5-pr555 | high (pre-existing) | GET fee-payments/payments/{id}/receipt | Non-GUID id -> 500 FormatException | z94x8e9yhj | 2026-11-10 | open | |
