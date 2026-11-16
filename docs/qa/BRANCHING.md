# QA branch convention (MarksheetplusQA)

## Branches

- **`main`** — the regression suite and shared docs that are known-good against shipped product behaviour. Specs for a product change land here when that change's QA PR is merged together with the product PR (plus shared fixes those branches needed).
- **`qa/pr-<n>`** — one branch per product PR that QA tests. Always base it on current **`main`** (not on another `qa/pr-*`). Open its own QA PR into `main` when testing starts, and keep that PR's specs, fixtures and page objects on this branch until the product PR merges.
- **`qa/knowledge-base`** — docs-only branch for the Marksheet+ QA knowledge base; merged into `main` once reviewed.

Product-PR specs do not reach `main` through a later sync PR (`qa/sync-*` or `qa/main-sync`). Each product PR has its own QA PR, opened at the start of testing.

## Lifecycle

1. Start `qa/pr-<n>` from `origin/main`.
2. Open that branch's QA PR into `main` when testing starts — not later, after a pass. Link the QA PR on the product PR in `NimbleLoop-Technologies/MarksheetPlus`, and merge the two together when the product PR merges.
3. Author / update specs on `qa/pr-<n>` while cycling the product PR. Push freely; do **not** rebase or force-push other agents' `qa/*` tips without agreement.
4. When the product PR merges, merge its QA PR with it. Do **not** hold passed specs for a follow-up sync. Specs for a product PR that has not merged stay on `qa/pr-<n>`.

## Shared vs PR-specific

- Shared on `main`: knowledge base under `docs/qa/`, core Playwright config, auth/login page objects, fixtures used by more than one suite.
- On `qa/pr-<n>` until the product PR (and its QA PR) merge: feature folders under `tests/`, matching `pages/` and `fixtures/`, and any project entry in `playwright.config.ts` that only that PR needs.

## Regression

The regression suite **lives on `main`**. CI and local “run everything green” should target `main`. Each open `qa/pr-<n>` PR may add failing bug-repro specs on purpose; those are not the main regression bar until that QA PR merges with its product PR.
