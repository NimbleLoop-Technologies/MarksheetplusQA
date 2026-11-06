# Fees, Challans, Payments, Ledger (fee-management / Account Office)

**Code slice(s):** `Features/FeeManagement + Ledger + FamilyFinance` (read its README.md)

**Routes:** /account-office/fee-policies[/add|/{PolicyId}], /additional-funds, /fee-payment[/families/{FamilyId}|/receive/{FamilyId}|/receipt/{PaymentId}], /family-ledger/{FamilyId}, /dashboard[/defaulters]; Family: /fees, /fees/child/..., /payments

**Endpoints / use cases:** Fee policy CRUD/archive/restore/duplicate, CheckClassPolicyConflict, additional funds, GetPendingFeeChallans, ReceiveFeePayment, GetFeePaymentReceipt, GetFamilyChallanPrint, GetFamilyLedger, GetFamilyOutstanding(+BookshopBill), GetFeeDashboard, GetFeeDefaulters(Page); Worker GenerateFeeChallansScheduler

## Business rules & known risk areas
- Challans generated monthly per family (or per student — z94x8eapp5 in review)
- New student's challan must merge into existing family challan (z94x8e91q4)
- Blocked/deactivated campuses excluded (z94x8e32e3)
- Carried-forward lines must appear in statement AND payment section (z94x8eavkw)
- Unarchiving published policy must not revert to Draft (z94x8e80fe)
- Double-entry ledger via async outbox; family plane mirrors, never computes

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
