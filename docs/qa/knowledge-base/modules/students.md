# Students / Admission Office (registrar-office)

**Code slice(s):** `Features/StudentsManagement` (read its README.md)

**Routes:** /students, /students/{StudentId}

**Endpoints / use cases:** QuickAddStudent, GetStudentsList/RegisterPage/Summary, GetStudentProfile, UpdateStudentProfile, UpdateStudentFeeDetails, UploadStudentFeeDocument, CheckAdmissionNumberUniqueness, PromoteStudents, TransferStudentsSection, StruckOffStudent, ReAdmissionStudent, GetStudentAcademicHistory, GetSiblings, family info (Add/RemoveChildFromFamily, UpdateFamilyInfo), parent invites (Send/Manage/RegenerateParentFamilyInvite, LinkParentFamilyAccount, GetParentFamilyLinkOptions)

## Business rules & known risk areas
- Admission number unique per campus
- Struck off / readmit must update academic history immediately (bug 86eyr1aa0: needed refresh)
- Promotion & section transfer write Academic Register events
- Unarchiving a student must keep class (bug z94x8e5r69: class became N/A)
- Story z94x8ean0x: retire 'Complete profile' status, DOB+gender move to quick add

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
