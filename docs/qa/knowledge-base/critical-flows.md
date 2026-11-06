# Critical Flows (regression priority)

Ranked by business impact × bug history from ClickUp.

| # | Flow | Why | Ref tickets |
|---|---|---|---|
| 1 | Auth: register → email OTP → login; pending login 403; password reset; campus switch; refresh token | Gateway to everything; rate limits | Auth README |
| 2 | Family linking: send invite (WhatsApp token / code) → parent redeem → accept/reject; second child; already-linked messages; campus token rejected | Heaviest bug cluster, PR #550 | z94x8ebqpt, z94x8eanca, z94x8e4qrb, z94x8e3138 |
| 3 | Fee challan generation → payment receive → receipt → ledger → family statement mirror | Money; carry-forward & merge bugs | z94x8eavkw, z94x8e91q4, z94x8e32e3, z94x8eapp5 |
| 4 | Datesheet publish → edit after publish → parent app reflects | Projection staleness | z94x8e4udp, z94x8e4ubc, 86eyjvhmp |
| 5 | Archive/restore of students, classes, policies, kits, staff, sessions | Restore corrupts relationships | z94x8e2np5, z94x8e5r69, z94x8e80fe, z94x8e80qv, z94x8e5pa8 |
| 6 | Attendance: today's register submit, 409 on stale version, corrections, month export, archived students | Daily usage | z94x8e91p9, z94x8e5pa3, z94x8ean2v |
| 7 | Marksheet/mastersheet publish → SPI calc → analytics / top performers → WhatsApp result (quota) | SPI bug + metered cost | z94x8ea28k, z94x8e7hp4 |
| 8 | Student lifecycle: quick add, promote, section transfer, struck off, readmit, academic history | Register events | 86eyr1aa0 |
| 9 | Bookshop POS day open → sale → close; kit stock; parent purchases | Money/stock | 86extv5xm.. |
| 10 | RBAC: each system role sees only permitted modules; custom role; staff invite accept with role | Security | z94x8ean2x |
| 11 | Subscription gate: trial, blocked campus redirect | Revenue | 86eyqav1r |
| 12 | Exam paper generator finalize/editor | Many UI bugs | z94x8e91pr, z94x8e8q* |
