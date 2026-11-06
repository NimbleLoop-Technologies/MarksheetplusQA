# Class Attendance

**Code slice(s):** `Features/ClassAttendance` (read its README.md)

**Routes:** /attendance-register, /registrar/attendance

**Endpoints / use cases:** GetAttendanceSections, GetTodayAttendanceRegister, SubmitAttendanceRegister, CorrectAttendanceMark, GetMonthAttendanceRegister, ExportMonthAttendanceRegister (CSV/PDF), GetStudentAttendanceSummary

## Business rules & known risk areas
- Submit only for operational current working day (PK date); Sundays non-working; Morning sitting only
- ExpectedVersion required; stale → 409
- Corrections are separate audited flow; back-date marking in code review (z94x8ean2v)
- Dropdown should show classes with pending attendance (z94x8e91p9)
- Archived students handling in register (z94x8e5pa3); remove Brought forward column (z94x8ea2ny)
- Absent notifications to parents via WhatsApp

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
