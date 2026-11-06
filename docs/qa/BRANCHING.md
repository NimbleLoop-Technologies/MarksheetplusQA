# QA branch convention (MarksheetplusQA)

## Branches

- **`main`** — the regression suite and shared docs that are known-good against shipped product behaviour. Merge only specs from **passed** product PRs (plus shared fixes those branches needed).
- **`qa/pr-<n>`** — one branch per product PR under test. Always base it on current **`main`** (not on another `qa/pr-*`). Keep PR-specific specs, fixtures and page objects here until that product PR passes QA.
- **`qa/knowledge-base`** — docs-only branch for the Marksheet+ QA knowledge base; merged into `main` once reviewed.
- **`qa/main-sync`** (occasional) — staging branch used to land knowledge-base + passed-PR specs onto `main` in one PR.

## Lifecycle

1. Start `qa/pr-<n>` from `origin/main`.
2. Author / update specs on that branch while cycling the product PR. Push freely; do **not** rebase or force-push other agents' `qa/*` tips without agreement.
3. When the product PR **passes** QA and Umair closes the related bugs, cherry-pick or path-checkout its specs (and any shared fixes such as `LoginPage` password re-fill or `playwright.config` project wiring) into a sync PR against `main`.
4. Do **not** merge specs for product PRs that are still FAIL / in flight (they stay on their `qa/pr-<n>` until the next pass).

## Shared vs PR-specific

- Shared on `main`: knowledge base under `docs/qa/`, core Playwright config, auth/login page objects, fixtures used by more than one suite.
- PR-specific until pass: feature folders under `tests/`, matching `pages/` and `fixtures/`, and any project entry in `playwright.config.ts` that only that PR needs.

## Regression

The regression suite **lives on `main`**. CI and local “run everything green” should target `main` (or a sync PR into it). Per-PR branches may add failing bug-repro specs on purpose; those are not the main regression bar.
