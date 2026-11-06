# Staff Payroll, Incentives & Deductions

**Code slice(s):** `Features/PayrollManagement` (read its README.md)

**Routes:** /account-office/staff-payroll[/policy|/incentives-and-deductions[/add|/{ItemId}/edit]]

**Endpoints / use cases:** Payroll items CRUD, activation toggle, eligibility preview/matches/dropped, PublishPayrollPolicy, version history

## Business rules & known risk areas
- Generate & Publish payroll in code review (86eyqauen, high)
- Backlog: apply at run time, leave/absence exceptions, payslips
- Policy versions are immutable once published

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
