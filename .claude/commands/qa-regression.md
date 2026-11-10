---
description: Run the full Playwright regression suite and summarize the verdict
---

Run the full Marksheet+ regression suite against qa-integration.

1. Invoke the `run-and-triage` skill.
2. Run `npm test`.
3. Parse `test-results/results.json` — do not scrape stdout.
4. Classify every failure: real failure / flaky / selector drift / blocked. Check `knowledge/known-issues.md` so expected failures (`test.fail`) are not reported as new.
5. Give me the verdict block: PASS / FAIL / BLOCKED, with real failures and flakes listed separately, and skipped tests counted.

Do not report a retry-pass as a pass. Do not file product defects for out-of-date selectors.
