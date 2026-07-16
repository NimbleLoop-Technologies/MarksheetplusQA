---
name: report-to-clickup
description: Report QA results back to a ClickUp task — pass/fail summary, bug write-up with repro steps and evidence, and a proposed status transition. Use after a QA run completes on a ClickUp-tracked task.
---

# Report QA Results to ClickUp

## What is automatic vs. confirmed

- **Automatic:** posting the result comment and any bug write-up.
- **Requires human confirmation:** changing the task's status. Always propose, never transition unasked. Moving a ticket is visible to the whole team — ask first.

## Procedure

1. Post the result with `clickup_create_task_comment` on the task id.
2. State the proposed transition and ask the user to confirm:
   - All criteria pass → propose `qa` → `complete`.
   - Any real failure → propose `qa` → `development`.
   - Blocked (env/auth down) → propose leaving it in `qa`; it was never tested.
3. Only after explicit confirmation, apply the transition.

## Pass comment format

> ✅ **QA PASSED** — <scope tested>
>
> **Verified:**
> - <criterion> — automated: `tests/<path>:<test name>`
> - <criterion> — exploratory via Playwright MCP
>
> **Run:** <passed>/<total> passed · env: qa-integration
>
> _Automated QA via Claude Code._

## Fail comment format

> ❌ **QA FAILED** — <scope tested>
>
> **Defect:** one sentence — the observed wrong behaviour.
>
> **Expected:** <from the acceptance criterion>
> **Actual:** <what happened>
>
> **Steps to reproduce:**
> 1. <exact step>
> 2. <exact step>
>
> **Environment:** qa-integration.marksheetplus.com · Chromium
> **Evidence:** <screenshot>
> **Failing test:** `tests/<path>:<test name>` (if automated)
>
> _Automated QA via Claude Code._

## NEVER attach a Playwright trace to ClickUp

`trace: 'on-first-retry'` records full network activity **including request bodies**. A retried login writes the seeded account's `QA_PASSWORD` into `trace.zip` in plaintext. Traces are gitignored and safe on disk — uploading one to a ticket publishes the QA password to everyone with board access.

- **Screenshots: safe to attach.** Password inputs render as dots.
- **Videos: safe by default**, but check the frames if the flow involves a show-password toggle.
- **`trace.zip`: never attach.** Reference it by local path (`test-results/<dir>/trace.zip`) so a developer can open it themselves with `npx playwright show-trace`.

## Rules

- One defect per report. Two bugs in one comment means one gets forgotten.
- Repro steps must be exact enough for a developer to follow without asking a question. "Log in and it breaks" is not a repro.
- Never report a flake as a failure, or a retry-pass as a pass. Say "flaky" and mean it.
- If ClickUp is unavailable, still surface the full result to the user locally. A reporting outage must never discard a run.
- Attach evidence for every failure. A failure without a screenshot gets bounced back.
- Never paste credentials, tokens, or `.env` contents into a comment.
