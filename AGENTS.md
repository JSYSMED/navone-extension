# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

PRA (`가격 자동화`) is a Chrome **Manifest V3** extension that automatically undercuts competitors' prices on Naver Smartstore. It reads the seller's catalog price-management grid, looks up each product's competing sellers on Naver shopping, computes a new sale price, and writes it back through the Naver Commerce API.

There is **no build step, no bundler, no package manager, and no test suite**. Files are loaded directly by Chrome. The only dependency is the vendored `lib/bcrypt.js` (used for Commerce API token signing).

## Develop / run / debug

- **Load**: `chrome://extensions` → enable Developer mode → "Load unpacked" → select this directory.
- **Reload after edits**: click the reload icon on the extension card. Content-script changes also require reloading the target Naver tab; service-worker (`background.js`) changes take effect on reload.
- **Debug**: `background.js` logs to the service worker console (Inspect views: service worker on the extension card). `sidepanel.js` logs to the side panel's own devtools. Content scripts log to their host page console (prefixed `[NavOne]`).
- **Runtime logs**: the running automation streams to the side panel UI and persists the last 200 detail lines + 50 "simple" cards in `chrome.storage.local` (`logs` / `slogs`).

## Architecture & control flow

Four execution contexts communicate by `chrome.runtime` / `chrome.tabs` messages. `background.js` is the orchestrator; everything else is driven by it.

1. **`sidepanel.html` / `sidepanel.js`** — the UI. Saves config to `chrome.storage.local.config`, sends `START`/`STOP`, and polls `GET_STATUS` every second to drive the progress bar and counters. Receives `LOG` (detail) and `SLOG` (user-friendly card) pushes.

2. **`background.js`** (service worker) — owns the entire run loop in `startProcess()`. It does **not** parse the DOM itself; it injects content scripts and sends them action messages, then runs the pricing math and the API calls.

3. **`content_catalog.js`** — injected into `sell.smartstore.naver.com`. Parses the AG-Grid catalog table (`PARSE_CATALOG_TABLE`), clicks the per-row "상세보기" button (`CLICK_VIEW_BUTTON`), and paginates (`CLICK_NEXT_PAGE`). Note the grid is virtualized: parsing scrolls `.ag-body-viewport` in steps and dedupes rows by `channelProductNo` across scroll positions.

4. **`content_price.js`** — injected into `search.shopping.naver.com/catalog/*`. On `PARSE_PRICES`, scrapes every `[class*='product_seller_item']` into `{ sellerName, price, deliveryFee }`.

### The per-product loop (the part that matters)

For each catalog page, `background.js`:

1. `PARSE_CATALOG_TABLE` → filter to products where `priceDiffText` includes `높음` (my price is higher) or `priceDiff > 0`.
2. For each target, `clickDetailAndParse()`: the "상세보기" button opens the competitor page via `window.open`. The extension **monkey-patches `window.open` in the page's MAIN world** (`world: "MAIN"` injection) to capture that URL instead of letting a tab open, then opens it as a background tab itself, injects `content_price.js`, runs `PARSE_PRICES`, and closes the tab.
3. Excludes own stores by matching `seller.sellerName` against `config.storeNames`; finds the lowest competitor.
4. Fetches authoritative current price + delivery fee via Commerce API `getProductInfo()`.
5. Computes: `targetExposure = lowestCompetitor.price - UNDERCUT`, then `targetPrice = targetExposure - ourDeliveryFee` — i.e. the goal is the **displayed total** (price + shipping), so shipping is subtracted out of the sale price. Clamps to a floor of `currentSalePrice * (1 - MIN_MARGIN/100)`.
6. In real mode, `updateProductPrice()` does a GET-modify-PUT of the **full** channel-product object (mutating only `originProduct.salePrice`) against `api.commerce.naver.com/external/v2/...`. In test mode it logs the would-be change and skips the PUT.

Each processed product is recorded in `state.results` with a status (`UPDATED`, `TEST_SKIP`, `ALREADY_LOWEST`, `SAME_PRICE`, `NO_COMPETITORS`, `NO_SELLERS`, `API_ERROR`, `ERROR`). The side panel buckets these into change/skip/error counts.

### Conventions worth knowing

- **Config** lives entirely in `chrome.storage.local.config`; `background.js` re-reads it into `CFG` at the start of every run (`loadConfig`). `MIN_PRICE` (1000), `DELAY`, `TAB_LOAD_TIMEOUT`, `PRICE_FLOOR` are hardcoded in `loadConfig`, not user-editable.
- **Commerce API auth**: `ensureToken()` signs `clientId + "_" + timestamp` with `bcrypt.hashSync(..., clientSecret)`, base64-encodes it, and exchanges it for a 4h bearer token cached on `state`.
- **Telegram**: optional notifications via `tg()`; no-ops if `tgToken`/`tgChatId` are unset.
- **DOM selectors are brittle by nature** — they target Naver's obfuscated/hashed class names (`[class*='product_seller_item']`, AG-Grid `.ag-center-cols-container .ag-row[row-index="..."]`). Expect these to break when Naver ships UI changes; that is the most likely cause of "파싱 실패" / "판매자 정보 없음".
- Code, logs, and UI strings are in **Korean**; match that style.
