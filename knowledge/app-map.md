# Application map

Marksheet+ — multi-tenant school management. Blazor WebAssembly web app → .NET API, with a
separate auth app (OIDC authority) for sign-in and sign-up. Source: `E:\MarksheetPlus2`.

Seeded 2026-11-03 **from source code**; the live environment was not reachable from the authoring
machine, so every entry is **unverified live** until a cycle confirms it.

## Hosts (integration)

| Host | Role |
| --- | --- |
| `qa-integration.marksheetplus.com` | Web app (school staff) |
| `qa-integration-auth.marksheetplus.com` | Auth app: `/auth/login`, `/auth/register`, `/connect/authorize`, `/connect/token` |
| `qa-integration-api.marksheetplus.com` | REST API |

Integration runs with `ASPNETCORE_ENVIRONMENT=integration`: WhatsApp OTP off, reCAPTCHA off.

## Auth app routes (`MarksheetPlus.Auth`)

| Route | Page | Notes |
| --- | --- | --- |
| `/auth/login` | Sign-in step 1 | Card "Sign in to your account"; field "WhatsApp Number or Email"; button "Continue". Calls `POST /auth/check-uniqueness`: unknown → `/auth/register?username=…`, known → `/auth/login-form?username=…` |
| `/auth/login-form?username=…` | Sign-in step 2 | Username disabled; "Password" (label visually hidden, input `#login-password`); "Show password" toggle; "Forgot password?" link; button "Sign in" |
| `/auth/register` | Sign-up | Card "Create your account": First Name, Last Name, WhatsApp Number, Email Address (optional), Password, Confirm Password; button "Create account"; footer link "Login Now" |
| `/auth/verify-whatsapp` | OTP step | Only when OTP is on (not on integration) |
| `/auth/forgot-password` | Reset | |
| `/auth/logout` | Sign out | |

The web app returns via `/authentication/login-callback`.

## Web app routes (selection)

| Route | Page | Notes |
| --- | --- | --- |
| `/students` | Admission Register | Breadcrumb title "Admission Register" (or "Archived Students"); stat cards Total / Active / Struck-off Students; paged table: Student Name, Class/Grade, Primary Contact, Admission Date, Actions (eye link → `students/{id}`, Archive, "Complete Profile") |
| `/students/{id}` | Student profile | |
| `/account-office/dashboard`, `/account-office/fee-payment`, `/account-office/fee-policies`, `/account-office/staff-payroll`, `/account-office/additional-funds` | Fees / account office | |

Policies: `/students` requires a tenant and the Registrar Office "see" permission.

## Validation messages (exact text)

Sign-in:
- "Please enter your email or phone to continue."
- "Password is required."
- "Invalid password. Please try again."
- "Too many failed attempts. Please try again later or reset your password."

Shared validators (`MarksheetPlus.Core/UniversalValidators`):
- Email: "Please enter a valid email address (e.g., name@example.com)." · "Email must be 254 characters or fewer."
- Phone (`^(\+[1-9]\d{9,14}|03\d{9})$`): "Enter a valid phone number. Use international format with country code (e.g., +923001234567) or Pakistani format (e.g., 03001234567)."
- Name (letters/marks, `'` `-` `.` space; max 50): "<Field> must be 50 characters or fewer." · "<Field> contains invalid characters." · "<Field> contains invalid sequences or leading/trailing separators."
- Password (8–20, upper + lower + digit): "Password must be at least 8 characters long." · "Password must be 20 characters or fewer." · "Password must contain at least one uppercase letter, one lowercase letter, and one number."

Sign-up:
- "First name is required." · "Last name is required." · "WhatsApp number cannot be blank." · "Password is required." · "Passwords do not match."
- "WhatsApp number is already registered. Try logging in to your account." · "Email is already registered. Try logging in to your account."
