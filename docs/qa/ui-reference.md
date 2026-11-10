# UI reference (observed in the live app)

What the apps actually render, recorded from Playwright MCP sessions. Page objects in `pages/` are
built from this. If a screen changes, re-recon and update this file first.

Legend: `role "name"` is the accessible role and name. `[hook]` is a component `data-*` attribute,
used only when nothing accessible exists.

---

## Shared AuthApp (https://localhost:7104 locally)

Recorded 2026-11-03, PR 550 head 69080e19.

### /auth/login — `pages/LoginPage.ts`
- heading "Sign in to your account" (h1)
- textbox "WhatsApp Number or Email" → button "Continue" → textbox "Password" → button "Sign in"
- link "Start your free trial today" → /auth/register (the `returnUrl` is kept). Same copy on the
  family persona, though it reads as school-owner copy.
- Family deep links: `/join?code=X` signed out redirects here with
  `returnUrl=/connect/authorize?...persona=Family...`. After sign-in you land back on `/join?code=X`.

### /auth/register — `pages/RegisterPage.ts` (`RegisterPage`)
- heading "Create your account" (h1)
- textbox "First Name", "Last Name", "WhatsApp Number" (placeholder "e.g., +923xxxxxxxxx or 03xxxxxxxxx"),
  "Email Address (optional)", "Password", "Confirm Password" (each password has button "Show password")
- button "Create account"; link "Login Now"

### /auth/verify-whatsapp — `pages/RegisterPage.ts` (`VerifyWhatsAppPage`)
- heading "Verify your WhatsApp number" (h1); text "We have sent a 6-digit code to +92********NN"
- group "Enter the 6-digit verification code" with textbox "Digit 1 of 6" … "Digit 6 of 6"
- button "Resend" (disabled for a cooldown), button "Verify", link "Back to sign in"
- **Gotcha:** typing all six digits in one go does not distribute reliably (boxes ended up holding
  "000", "0000", …). Fill each box separately.
- On success: back to the original `returnUrl`. The family app's `/join?code=` is kept.

---

## School WebApp (https://localhost:7236 locally)

### /registrar/students: Admission Register — `pages/StudentsRegisterPage.ts`
- heading "Admission Register" (h1)
- textbox "Search by name, admission ID or mobile" (debounced; filters the table)
- table: each row's first cell holds link "<Full Name>", "Active", the text "Admission <ID>", and
  button "Actions for <Full Name>"
- footer text "Showing 1 to N of M results"; combobox "Rows per page"
- Row action menu: menu "Actions for <Full Name>" with menuitem "View profile", "Link parent account",
  "Family invite code", "Archive". **Linked students show only "View profile" and "Archive"**
  (`row.CanLinkParent` is false).
- **Gotcha:** after a search the table re-renders. The first click on "Actions for …" can be swallowed,
  or the open menu gets detached ("element was detached from the DOM"). The page object retries the
  open with `toPass`.

### Family invite code drawer — `pages/FamilyInviteCodeDrawer.ts`
- dialog "Family invite code" (`#family-invite-code-drawer`, `[data-family-invite-drawer]`). The page
  also has 5 other `<dialog>`s, so always scope by name.
- heading "Family invite code" (h2), then a paragraph with the student's full name, then button "Close panel"
- **No live code:** `<p [data-invite-message]>` explains the state (PR 550 cycle 2, ut "uta"); footer
  button "Generate code". Observed texts:
  - never generated: "No invite code yet. Generate one to send it to the parent on WhatsApp."
  - expired: "The last code expired on 03 Nov 2026. Generate a new one." (date of the expiry, UTC)
  - parent said Not my child: "The parent said this isn't their child. Check the father's mobile number,
    then generate a new code."
  - cancelled: **also** "No invite code yet. …" when the drawer is reopened (Cancel clears the student's
    invite reference, so the server's "The last code was cancelled. …" text is never reached; cycle 2).
  - (server-side, not observed) linked: "A parent has connected this student to their family."; accepted:
    "The parent accepted. The connection completes automatically."
- Rate limit: invite actions use the per-school "family-invite" limiter (300 / 15 min). A 429 shows the
  server ProblemDetails text in the error alert: "Your school has sent a lot of family invites in the last
  few minutes. Wait N minutes and try again." (fallback "Too many invite actions right now. Wait a few
  minutes and try again.").
- **Live code:**
  - code text `ABC-DEF` in `<span [data-invite-code]>` (no role or label), with button "Copy"
  - `dl`: term "Expires" → definition "06 Nov 2026, 1:31 PM" (browser local time); term "Sent to" →
    definition "+92********03"
  - footer: button "Resend" (disabled once 3 sends are used in 24h), "Regenerate", "Cancel invite"
- Inline feedback (not a toast):
  - success: `status` containing heading (h3), e.g. "Invite code sent. You will see the student connect
    once the parent enters it.", "Code copied.", "Invite code re-sent.", "New code sent. The old code
    no longer works.", "Invite cancelled."
  - error: `alert` containing heading (h3), e.g. "This student's code has been sent 3 times in the last
    24 hours. Try again later."
  - The previous notice stays until the next action replaces it. Assert on the exact text, not on presence.
- Confirmations (`#mp-confirm-dialog`):
  - alertdialog "Replace this code?": "The current code stops working and the parent gets a new one on
    WhatsApp."; buttons "Regenerate", "Keep it", "Close"
  - alertdialog "Cancel this invite?": "The code stops working. You can generate a new one later.";
    buttons "Cancel invite", "Keep it", "Close"

---

## Family app (https://localhost:7100 locally)

### /join, /join?code=… — `pages/family/JoinWithCodePage.ts`
- page title "Join with an invite code"; heading "Join with an invite code" (h1)
- **Entry form:** paragraph "Enter the 6-character code your child's school sent you on WhatsApp."
  - form "Invite code" with textbox "Invite code" (placeholder "ABC-234", `maxlength=20` since cycle 2,
    `autocomplete=one-time-code`). Spaces and dashes anywhere are ignored by the server
    ("  tx5 - szx " redeems).
  - button "Continue", button "See invitations sent to my number" (→ /link)
  - The error is a `<p>` linked by `aria-describedby`, and the input gets `aria-invalid=true`. Assert with
    `toHaveAccessibleDescription`. Observed messages:
    - "Enter the code from your WhatsApp message." (blank; no request sent)
    - "That code isn't valid. Check it and try again." (404)
    - "This code has already been used. Ask the school for a new one if you still need to connect." (409)
    - "The school has withdrawn this code. Ask them to send you a new one." (cancelled)
    - "This code has expired. Ask Testenv High School - Main to send you a new one." (410)
    - 'This code was declined as "not my child", so it no longer works. If that was a mistake, ask the
      school for a new code.' (409, after Not my child; cycle 2)
  - `maxlength=20` truncates longer input on fill/typing.
- **Invite card** (after a valid code):
  - heading (h2) = school name, e.g. "Testenv High School - Main"
  - term/definition pairs: "Child" → first name only ("Omar"); "Class" → "Class 5-5 (A)";
    "Admission number" → "***" (fully masked for short ids like QA-1006); "Code expires" →
    "06 Nov 2026, 1:31 PM"
  - When the family has **no** child the invite could be: status with heading "Add as a new child" and the
    text "<First> will be added to your family as a new child."
  - When it has (cycle 2, ut7): instead of that status, `div[data-attach-choice]` holding a radio
    group "Is <First> already in your family?" (RadioGroup cards layout; inputs are visually covered but
    have aria-labels):
    - radio "Yes, this is <child name>" per own child; the lookalike reads "Yes, this is <name> (suggested)"
      and is preselected. Names come back **lower-case** as stored ("Yes, this is bilal qaexplore").
    - radio "No, add <First> as a new child" (preselected when nothing is suggested)
    - Children already connected to this school are not listed.
  - Refused Connect / Not my child shows a bare danger Alert (`role=alert`) on the card.
  - buttons "Connect", "Not my child", "Use a different code"
  - "Not my child" swaps the buttons for heading "Tell the school this is not your child?", the text
    "We'll tell the school this isn't your child so they can correct the number.", and buttons
    "Yes, it's not my child" and "Cancel"
  - Connect (and a confirmed rejection) navigates to /dashboard. A double-click sends one accept request.
  - Browser Back after Connect re-runs the redeem from the query string and shows the 409 message.

### New parent (just registered, no family yet) — `pages/family/FamilySetupPage.ts`
- `/join?code=X` works after registration and shows the card. Since cycle 2 **Connect** navigates to
  `/family/setup?returnUrl=%2Fjoin%3Fcode%3DX` (no explanatory message). Completing setup returns to
  `/join?code=X` with the card; the parent presses Connect again.
- /dashboard: heading "Good afternoon, <First name>", text "No children linked yet. Add your child to
  see their purchases and school updates here.", button "Add your child"
- /family/setup: heading "Setup your family" (h1), a multi-step wizard:
  - form "Father information": textbox "Father Name", "CNIC", "WhatsApp #", "Email Address", "Home
    Address", "City", combobox "Province" (required), textbox "Family Name"; button "Next". Not
    prefilled from the account.
  - form "Mother information": button "Skip for Now", textbox "Mother Name", "CNIC", "WhatsApp #",
    checkbox "Same as Father" (×2), button "Previous", button "Next"
  - form "Guardian information": button "Skip for Now", textbox "Guardian Name", "CNIC", "WhatsApp #",
    "Email Address (optional)", "Home Address (optional)", buttons "Previous", "Next". "Skip for Now"
    here submits the setup.

### /dashboard — `pages/family/FamilyDashboardPage.ts`
- heading (h1) "Good morning|afternoon|evening, Parent". It says "Parent" even though the account is Imran Khan.
- one card per child: the full name as plain text (e.g. "Omar Farooq"), "Testenv High School - Main ·
  class 5-5 (A)", and links "Exams", "Fees", "History". Cards have no role or label, so locate by exact full name.
  The school line is the name's next sibling `<div>`; a child with no school reads "Not connected to a
  school yet" (History link only).
- A child linked as **new** a moment ago can show as "Child" until the school's profile snapshot is
  projected (a few seconds); the dashboard does not refresh itself.
- account menu button "Account menu" → links "Family Info", "Logout"

## WhatsApp quota (PR 538, recorded 2026-11-03 on the local stack)

### WebApp /setup/subscription → "WhatsApp messages" card — `pages/setup/SubscriptionQuotaCard.ts`
- Card scope `[data-quota-card]` (no landmark); heading "WhatsApp messages". Skeleton while loading: `[data-quota-loading]`.
- Trial: `[data-quota-trial]` status "WhatsApp notifications are not available on trial plans."; no button.
- Not entitled (PastDue/Deactivated): `[data-quota-not-entitled]` "WhatsApp notifications are not available for your current subscription."
- Active: description list `[data-quota-stats]` — "Included this month", "Extra (purchased add-ons)", "Used", "Remaining" (N0 numbers);
  `[data-quota-skipped]` "N messages could not be sent this month because the quota was exhausted." (only when N > 0);
  "Monthly quota resets on 01 Dec 2026." (`[data-quota-resets]`); heading "Purchased add-ons" + table Messages/Used/Expires when add-ons are live;
  `[data-quota-pending]` "A request for 150 messages (Rs 120) is pending approval." replaces the button; else button "Request extra quota" (setup Edit only).
- Modal: dialog "Request extra WhatsApp quota" (`#request-quota-modal`): radio per package "100 messages" (description "Valid 90 days", price "Rs 100")
  → button "Continue" → heading "Bank transfer details" (Bank / Account title / Account number / IBAN) → button "Submit request"
  → "Request submitted" → button "Done". Errors stay inline: alert "Request not submitted" + server message (409 → "You already have a pending quota request…").

### WebApp /setup/campus-settings → "WhatsApp notifications" (h2) — `pages/setup/CampusNotificationSettings.ts`
- checkbox "Result published", checkbox "Fee dues" (each saves on change: PUT campus/notification-preferences `{disabledKinds:[…]}`), caption "On"/"Off".

### WebApp shell notice — `pages/setup/QuotaShellNotice.ts`
- `[data-whatsapp-quota-notice]`: "WhatsApp quota exhausted — N messages not sent this month." + link "Request extra quota" (→ /setup/subscription, perm setup Edit).
  No close button. Read once when the shell loads (full page load); in-app navigation does not refresh it.

### AuthApp back office (https://localhost:7104/backoffice) — operator = admin@marksheetplus.com (linked on register)
- Nav links: "Dashboard", "Pending payments", "Customers", "Plans", "Quota packages", "Quota requests", "Settings".
- /backoffice/plans — `pages/backoffice/BackOfficePlansPage.ts`: heading "Plans" (h1), button "New plan"; column "Monthly quotas"
  ("WhatsApp messages / month: 100"). Modal dialog "New plan"/"Edit plan" (`#plan-modal`): textbox "Plan name", spinbutton "Price (PKR)",
  combobox "Billing cycle", spinbutton "Trial days", spinbutton "WhatsApp messages / month", textbox "Features (one per line)", (edit: "Archived"), buttons "Create"/"Save".
- /backoffice/quota-packages: heading "Quota packages", button "New package"; dialog "New package": spinbutton "Quantity (messages)", "Price (PKR)",
  "Validity (days)" (no name field; name defaults to "N messages"); table Quantity/Price/Validity/Status/Actions ("Edit").
- /backoffice/quota-requests: filter tabs All/Requested/Approved/Rejected; table Campus/Quantity/Price/Requested/Status/Actions; row buttons
  "Approve" (dialog "Approve quota request": "Approve 100 messages for <Campus> (PKR 100)?", textbox "Payment reference (optional)") and "Reject".
