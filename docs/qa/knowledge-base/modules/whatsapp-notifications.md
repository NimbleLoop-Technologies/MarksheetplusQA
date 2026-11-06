# WhatsApp Notifications & Quota

**Code slice(s):** `Features/Notifications + Quotas` (read its README.md)

**Routes:** Notification preferences; /backoffice/quota-packages, /quota-requests

**Endpoints / use cases:** Get/UpdateNotificationPreferences, GetQuotaSummary/Status/Packages, RequestQuotaTopUp; Worker WhatsAppQueueScheduler/Send/Result consumers

## Business rules & known risk areas
- Metered: result published, pending dues (WhatsAppUtility). Never metered: OTP, invites, welcome
- Monthly UTC allocation per active campus, lazily created
- Quota feature in QA (z94x8e7hp4); fee receipt notification (z94x8e9yhj)
- Local: messages appear in Worker log, not real WhatsApp

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
