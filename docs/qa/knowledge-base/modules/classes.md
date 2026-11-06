# Classes / Classrooms

**Code slice(s):** `Features/ClassManagement` (read its README.md)

**Routes:** /classes, /registrar/classes, /registrar/classes/{ClassId}, /class-listing/{ClassId}

**Endpoints / use cases:** CreateClass, UpdateClass, AddSections, UpdateClassSubjects, GetDefaultSubject, GetGrade, CheckClassUniqueness, GetPromotionTargetClasses, GetClassStudentsPage

## Business rules & known risk areas
- Class name unique; capitalisation rule for class/fund names (z94x8eavje)
- Default subjects removable (MIG-R4); subject IndexWeightage feeds SPI
- Archived classes via /classes/archived

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
