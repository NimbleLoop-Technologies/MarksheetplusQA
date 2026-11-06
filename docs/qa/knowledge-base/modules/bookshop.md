# Bookshop / Inventory / POS

**Code slice(s):** `Features/Bookshop + FamilyPurchases` (read its README.md)

**Routes:** (bookshop module pages in WebApp); Family: /purchases, /purchases/bill/{SchoolId}/{BillId}

**Endpoints / use cases:** Inventory items, stock update, kits (create/update/components), POS Open/Close day, Search, CompleteBookshopPointOfSale, sales history (view/search/filter), sale detail

## Business rules & known risk areas
- Kit out of stock when items archived; updating kit must not crash (z94x8e80qv)
- Upcoming in UI approved: return sale, replace item/kit, recent bills, stock movements log + CSV
- Unbilled purchases flow onto fee account (86ey8zt31)
- Parents see only student-linked bills, never cost/margin/cashier

## Test focus
- Happy path per acceptance criteria; permission matrix (role without module See/Edit → 403/hidden).
- Validation messages (Problem/ValidationProblem copy), duplicates, archived-state conflicts.
- Cross-plane effects (parent app / Worker projections) where applicable.
