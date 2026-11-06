# Exams, Sessions, Datesheet, Marksheet, Paper Generator (examination-center)

**Code slice(s):** `Features/ExamManagement + Sessions + FamilyExams` (read its README.md)

**Routes:** /sessions, /exam-center, /exam-center/papers[/new|/{PaperId}], /marksheet, /mastersheet; Family: /exams, /exams/child/{ChildId}/{EnrollmentId}

**Endpoints / use cases:** Add/Update/CompleteSession, CheckSessionValidity, InitDatesheet, SaveDatesheetAssignments, PublishDatesheet, ResetDatesheet, BulkAssignSubject, SaveMarksheetDraft, ResetMarksheet(Class), PublishMastersheet, UpdatePublishedMarksheetStudent, exam paper CRUD/parts/questions/FinalizeExamPaper; family GetFamilyMergedUpcomingExams, GetFamilyChildDatesheet

## Business rules & known risk areas
- Session → terms with PassingCriteria
- Published datesheet projects to parent app via Worker; edits after publish must re-project (bug z94x8e4udp, high)
- Paper generator: finalize enabled only when question marks = total; rich text, equations, Urdu RTL virtual keyboard (many bugs z94x8e8q*/z94x8e91p*)
- Publishing mastersheet triggers SPI calc + WhatsApp result notification (metered)

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
