# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

### The per-product loop — v2 algorithm (the part that matters)

The pricing logic lives in `computeV2Decision()` (plus `filterCompetitors()`); the loop in `startProcess()` orchestrates. For each catalog page, `background.js`:

1. `PARSE_CATALOG_TABLE` → filter to products where `priceDiffText` includes `높음` (my price is higher) or `priceDiff > 0`.
2. For each target, `clickDetailAndParse()`: the "상세보기" button opens the competitor page via `window.open`. The extension **monkey-patches `window.open` in the page's MAIN world** (`world: "MAIN"` injection) to capture that URL instead of letting a tab open, then opens it as a background tab itself, injects `content_price.js`, runs `PARSE_PRICES`, and closes the tab.
3. **Snapshot**: reads the previous `price_snapshots[no]` (for the drop filter below), then overwrites it with this cycle's raw sellers.
4. `filterCompetitors()`: excludes own stores (`config.storeNames` substring match), computes **exposure = price + deliveryFee** per seller, then drops outliers — anything **below 50% of the median exposure** (mismatched product) and anything that **fell ≥30% vs. the same seller in the previous snapshot** (coupon-suspect). Zero survivors → `NO_COMPETITORS`.
5. Fetches authoritative current sale price + our delivery fee via Commerce API `getProductInfo()`.
6. `computeV2Decision()` — all comparisons in **exposure** terms, final result converted back to a sale price by subtracting `ourDeliveryFee`:
   - Sorts competitors by exposure → `rank1/rank2/rank3`.
   - **Floor (a sale price, never derived from our current price — that was the v1 bug):** `product_configs[no].min_sale_price` if set (`floorSource="USER"`), else fallback `(rank3 ? rank3.exposure*0.90 : rank2.exposure*0.85) - ourDeliveryFee` clamped to `MIN_PRICE` (`"FALLBACK"`).
   - `gap = (rank2.exposure - rank1.exposure) / rank2.exposure * 100`.
   - **Branch:** `gap < 3` (or only one competitor) → chase rank1, `triggeredBy="AUTO"`, `AUTO_RANK1`. `gap ≥ 3` → `triggeredBy="DEFAULT"`; `gap ≥ 4` targets rank2 (`DEFAULT_RANK2`), else rank1 (`DEFAULT_RANK1`). (Telegram two-way override is a later PR; for now the default applies automatically.)
   - `targetSalePrice = (chosen.exposure - UNDERCUT) - ourDeliveryFee`. If `≤ 0` → `PRICE_TOO_LOW`; if `< floor` → clamped to floor and tagged `FLOOR_HOLD`; else the branch's action type.
7. Writes `price_history` for **every** product that reaches a decision (incl. `SAME_PRICE`, `FLOOR_HOLD`, `TEST_SKIP`, `API_ERROR`). In real mode, `updateProductPrice()` does a GET-modify-PUT of the **full** channel-product object (mutating only `originProduct.salePrice`). In test mode it logs the would-be change, records history, and skips the PUT.

There is no separate "already lowest" early-exit — if the computed `finalPrice` equals our current sale price it's recorded as `SAME_PRICE`. `state.results` statuses (`UPDATED`, `TEST_SKIP`, `SAME_PRICE`, `NO_COMPETITORS`, `NO_SELLERS`, `PRICE_TOO_LOW`, `API_ERROR`, `ERROR`) drive the side panel's change/skip/error counts; the finer `action_type` lives only in `price_history` and the detail log.

### `chrome.storage.local` keys

- `config` — user settings (API keys, store names, undercut, telegram). `margin`/`PRICE_FLOOR` are **deprecated** in v2 (no longer used for the floor) but still saved for compatibility.
- `product_configs` — `{ [channelProductNo]: { min_sale_price, strategy, updated_at } }`. Populated by the side panel's CSV upload (2 columns: `channelProductNo, min_sale_price`).
- `price_history` — append-only array of decision records, **capped at 1000** (oldest dropped). Fields: `channelProductNo, timestamp(ISO), old_price, new_price, rank1_price, rank2_price, gap_percent, action_type, floor, triggered_by`.
- `price_snapshots` — `{ [channelProductNo]: { sellers, timestamp } }`, rewritten each cycle; feeds the next cycle's drop filter.
- `logs` / `slogs` — last 200 detail lines / 50 UI cards.

### Conventions worth knowing

- **Config** lives entirely in `chrome.storage.local.config`; `background.js` re-reads it into `CFG` at the start of every run (`loadConfig`), and also loads `product_configs`/`price_snapshots` into `state`. `MIN_PRICE` (1000), `DELAY`, `TAB_LOAD_TIMEOUT` are hardcoded in `loadConfig`, not user-editable.
- **Commerce API auth**: `ensureToken()` signs `clientId + "_" + timestamp` with `bcrypt.hashSync(..., clientSecret)`, base64-encodes it, and exchanges it for a 4h bearer token cached on `state`.
- **Telegram**: optional notifications via `tg()`; no-ops if `tgToken`/`tgChatId` are unset.
- **DOM selectors are brittle by nature** — they target Naver's obfuscated/hashed class names (`[class*='product_seller_item']`, AG-Grid `.ag-center-cols-container .ag-row[row-index="..."]`). Expect these to break when Naver ships UI changes; that is the most likely cause of "파싱 실패" / "판매자 정보 없음".
- Code, logs, and UI strings are in **Korean**; match that style.
## AI 리뷰/CS 답변 기능 — 구현 가이드

> 이 섹션은 가격 자동화 다음 기능인 AI 리뷰 답변 + CS문의 답변의 구현 가이드.
> Commerce API에 리뷰/문의 관련 엔드포인트가 없으므로 100% DOM 파싱 + DOM 조작.

### 새로 추가할 파일

| 파일 | 역할 |
|------|------|
| `content_review.js` | 리뷰관리 페이지 DOM 파싱 + 답글 입력 |
| `content_cs.js` | 문의관리 페이지 DOM 파싱 + 답변 입력 |

`background.js`에 리뷰/CS 핸들러 추가, `sidepanel.html/js`에 리뷰/CS 탭 추가, `manifest.json`에 Vercel 서버 host_permission 추가.

content_review.js와 content_cs.js는 background.js에서 `chrome.scripting.executeScript`로 필요할 때만 주입 (가격자동화와 동일 패턴). manifest.json의 content_scripts에는 추가하지 않음.

---

### 리뷰 관리 페이지 DOM 구조

**URL**: `sell.smartstore.naver.com/#/review/search`

**테이블**: AG-Grid (카탈로그 가격관리와 **완전 동일 패턴**). 가상 스크롤됨.

#### 컬럼별 셀렉터 (col-id 기반)

각 행: `.ag-center-cols-container .ag-row[row-index="N"]`

```
col-id="productNo"      → 채널상품번호: span > a.text-info 텍스트
col-id="productName"    → 상품명: div[ng-non-bindable] 텍스트
col-id="reviewType"     → 리뷰구분: 셀 텍스트 ("일반" | "한달사용")
col-id="reviewScore"    → 별점: span.seller-rating-value의 style width
                           width: 20%=1점, 40%=2점, 60%=3점, 80%=4점, 100%=5점
                           또는 span 마지막 텍스트 노드 숫자 (예: " 4", " 5")
col-id="reviewAttach"   → 사진: img 있으면 사진리뷰, "-"이면 텍스트만
                           img 개수 = 사진 수
col-id="reviewContent"  → 리뷰내용: div[ng-non-bindable] 텍스트
                           a의 ng-click에서 리뷰ID 추출:
                           ng-click="vm.func.openReviewDetailModal(4984587284, true)"
                           → reviewId = 4984587284
col-id="helpCount"      → 리뷰도움수: 셀 텍스트 (숫자)
col-id="writerId"       → 등록자: span 텍스트 (마스킹됨, 예: "faro*****")
col-id="createDate"     → 리뷰등록일: 셀 텍스트 (예: "2026.05.26. 15:46")
```

#### 답글 등록 방식 — "답글작성" 일괄 모달

리뷰 테이블 위에 2개 버튼이 있음:
```
button "베스트리뷰선정 · 혜택지급"  → vm.func.openBestReviewBenefitModal()
button "답글작성"                   → vm.func.openBulkUpdateCommentModal()
```

**답글작성 모달 (판매자 일괄 답글 작성)**:
```
모달 제목: "판매자 일괄 답글 작성"
리뷰 글번호 입력: textarea (리뷰ID 표시됨, 예: "4984587284")
답글 내용: textarea#reviewComment
  - id="reviewComment"
  - maxlength="1000", minlength="5"
  - ng-model="vm.viewData.inputCommentContent"
  - placeholder="답글을 입력하세요."
등록 버튼: button.btn-primary.progress-button
  - ng-click 또는 progress-button="vm.func.addComment()"
  - Name: "등록"
닫기 버튼: button.btn-default[data-dismiss="modal"]
  - ng-click="vm.func.closeModal()"
글자수 표시: "0 / 1000 (최소 5자)"
```

**중요**: 답글을 달려면 체크박스로 리뷰를 선택한 후 "답글작성" 버튼을 누르는 흐름.
체크박스는 `.ag-pinned-left-cols-container .ag-row .ag-selection-checkbox` 안의 input.

#### 대안 방식 — 개별 리뷰 상세 팝업

리뷰 내용 셀의 `a[ng-click*="openReviewDetailModal"]`을 클릭하면 리뷰 상세 팝업이 뜸.
팝업 안에 답글 입력 영역이 있을 수 있음 (확인 필요). 일괄 모달보다 개별 팝업이 더 안정적일 수 있음.

---

### 문의 관리 페이지 DOM 구조

**URL**: `sell.smartstore.naver.com/#/comment/`

**리스트**: AG-Grid가 아닌 **AngularJS ng-repeat 리스트**.

#### 문의 항목 셀렉터

각 문의: `li[ng-repeat="comment in ::vm.commentList"]`

```
답변 상태:  .title-area .label.label-outline
            class에 label-default → "답변완료"
            class에 label-danger → "미답변"
            텍스트로도 판별 가능: "답변완료" vs "미답변"

상품명:     .title-area a strong 텍스트
            예: "GD11지디일레븐 어드밴스드 랩 에너지 앰플 미스트 100ml + 수분팩2매"

상품번호:   .partition-area 텍스트에서 정규식 추출
            /상품번호:\s*(\d+)/ → "10741586523"

스토어명:   .partition-area .label.storefarm 다음 텍스트
            예: "볼빨간오빠", "예삐상점"

작성자:     a.text-info[ng-click*="confirmOrder"] 텍스트
            예: "jenn****" (마스킹)

날짜:       .partition-area 마지막 span 텍스트
            예: "2026.05.26 11:31"

문의 내용:  p.text-area 텍스트 (white-space: pre-line)

비밀글:     i.fn-secret1 존재 여부

문의 유형:  comment.commentType 속성 (DOM에서 직접 읽기 어려움)
            'PRODUCT_INQUIRY' = 상품문의
            'SETPRODUCTREPLY' = 세트상품답변
            → 내용 분석으로 유형 추정 (배송/교환/상품 등)

기존 답글:  .seller-reply-list li 존재 여부 + .write-area span 텍스트
```

#### 답변 입력 셀렉터

각 문의의 "답글" 버튼 클릭 → 답변 영역 토글:
```
답글 버튼:  .btn-area button.btn-default.btn-sm (텍스트: "답글 N")
            ng-click="vm.replyShowOnClick(comment.id)"

답글 영역:  ncp-comment-reply > .seller-reply-section (답글 버튼 클릭 후 나타남)

textarea:   .seller-write-group textarea.form-control
            - maxlength="1000"
            - placeholder="답글을 입력해 주세요."
            - ng-model="vm.newContents[vm.comment.id]"

등록 버튼:  .input-group-btn button.btn.progress-button
            - progress-button="vm.save(0, vm.comment)"
            - 텍스트: "등록"

템플릿:     a[ng-click*="openTemplateListModal"] (답글 템플릿 불러오기)
```

**흐름**: 답글 버튼 클릭 → textarea에 텍스트 입력 → 등록 버튼 클릭

---

### content_review.js 메시지 프로토콜

#### `PARSE_REVIEWS` — 미답변 리뷰 목록 추출

카탈로그 파싱과 동일한 AG-Grid 스크롤 + 디듀플리케이션 패턴 사용.

```js
// 응답
{
  success: true,
  reviews: [
    {
      reviewId: "4984587284",           // ng-click에서 추출한 숫자
      productNo: "9089916281",          // 채널상품번호
      productName: "라라츄 헤어쿠션...",  // 상품명
      rating: 4,                        // 별점 (1~5)
      content: "정수리 비워 보여서...",    // 리뷰 본문
      reviewType: "일반",                // "일반" | "한달사용"
      hasPhoto: true,                   // 사진 존재 여부
      photoCount: 1,                    // 사진 수
      writerId: "faro*****",            // 작성자
      date: "2026.05.26. 15:46",        // 등록일
      helpCount: 0,                     // 도움수
      rowIndex: "0",                    // AG-Grid row-index
    }
  ]
}
```

#### `SELECT_REVIEW_AND_OPEN_MODAL` — 리뷰 체크 + 답글작성 모달 열기

```js
// 요청
{ action: "SELECT_REVIEW_AND_OPEN_MODAL", rowIndex: "0" }

// 처리: 해당 row의 체크박스 클릭 → "답글작성" 버튼 클릭 → 모달 열림 대기
// 응답
{ success: true }
```

#### `WRITE_REVIEW_REPLY` — 모달에 답글 입력 + 등록

```js
// 요청
{ action: "WRITE_REVIEW_REPLY", replyText: "AI가 생성한 답변" }

// 처리: #reviewComment textarea에 텍스트 입력 → 등록 버튼 클릭
// 응답
{ success: true }
```

#### `WRITE_REVIEW_DRAFT` — 모달에 답글만 입력 (등록 안 함, 반자동 모드)

```js
// 요청
{ action: "WRITE_REVIEW_DRAFT", replyText: "AI가 생성한 답변" }

// 처리: #reviewComment textarea에 텍스트만 입력, 셀러가 확인 후 직접 등록
// 응답
{ success: true }
```

#### `CLOSE_MODAL` — 모달 닫기

```js
{ action: "CLOSE_MODAL" }
// data-dismiss="modal" 버튼 클릭
```

---

### content_cs.js 메시지 프로토콜

#### `PARSE_INQUIRIES` — 미답변 문의 목록 추출

```js
// 응답
{
  success: true,
  inquiries: [
    {
      commentId: null,                  // DOM에서 직접 추출 어려움 — index 사용
      index: 0,                         // li 순서 (0-based)
      productName: "GD11지디일레븐...",
      productNo: "10741586523",
      content: "본사 유통정책에...",
      writerId: "jenn****",
      date: "2026.05.26 11:31",
      hasReply: true,                   // .label 텍스트가 "답변완료"인지
      isSecret: false,                  // i.fn-secret1 존재 여부
      storeName: "볼빨간오빠",           // 어느 스토어의 문의인지
    }
  ]
}
```

#### `OPEN_CS_REPLY` — 답글 영역 열기

```js
// 요청
{ action: "OPEN_CS_REPLY", index: 0 }

// 처리: 해당 li의 "답글 N" 버튼 클릭 → 답변 영역 토글
// 응답
{ success: true }
```

#### `WRITE_CS_REPLY` — 답변 입력 + 등록

```js
// 요청
{ action: "WRITE_CS_REPLY", index: 0, replyText: "AI가 생성한 답변" }

// 처리: 해당 li의 textarea에 텍스트 입력 → 등록 버튼 클릭
// 응답
{ success: true }
```

#### `WRITE_CS_DRAFT` — 답변만 입력 (등록 안 함)

```js
{ action: "WRITE_CS_DRAFT", index: 0, replyText: "..." }
```

---

### AngularJS 입력 주의사항

**중요**: 네이버 스마트스토어는 AngularJS를 사용. textarea에 직접 `.value =`로 값을 넣으면 Angular 바인딩이 갱신되지 않아 등록 버튼이 동작하지 않음.

**올바른 입력 방법**:
```js
function setAngularValue(element, value) {
  // Angular 1.x 바인딩 갱신
  const ngModelCtrl = angular.element(element).controller('ngModel');
  if (ngModelCtrl) {
    const scope = angular.element(element).scope();
    scope.$apply(() => {
      ngModelCtrl.$setViewValue(value);
      ngModelCtrl.$render();
    });
  } else {
    // fallback: input 이벤트 디스패치
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
```

---

### Vercel 서버 API

확장 프로그램에서 Vercel 서버를 호출하여 Claude Haiku 4.5로 답글 생성.

**리뷰 답글**: `POST /api/review-reply`
```js
// body
{
  review: { content, rating, productName, photoCount },
  storeContext: { storeName, tone, customPrompt },
  licenseKey: "..."
}
// response
{ reply: "생성된 답글", model: "claude-haiku-4-5", tokens: { input, output } }
```

**CS 답변**: `POST /api/cs-reply`
```js
// body
{
  inquiry: { content, productName, type },
  storeContext: { storeName, tone, customPrompt },
  licenseKey: "..."
}
// response
{ reply: "생성된 답변", model: "claude-haiku-4-5", tokens: { input, output } }
```

서버 코드는 `navone-server/api/review-reply.js`, `navone-server/api/cs-reply.js`에 이미 작성됨.

---

### background.js 리뷰/CS 핸들러 추가사항

기존 `startProcess()`와 별개로 `startReviewProcess()`, `startCsProcess()` 함수 추가.

**리뷰 처리 흐름 (반자동)**:
1. sidepanel에서 "리뷰 스캔" → background → content_review.js: `PARSE_REVIEWS`
2. 미답변 리뷰를 sidepanel에 카드로 표시
3. 셀러가 카드 클릭 → "답변 생성"
4. background → Vercel `/api/review-reply` 호출
5. 생성된 답변을 sidepanel에 표시 (수정 가능한 textarea)
6. 셀러가 "등록" → background → content_review.js: `SELECT_REVIEW_AND_OPEN_MODAL` + `WRITE_REVIEW_REPLY`
7. slog + review_history 기록

**리뷰 처리 흐름 (자동)**:
1~2는 동일
3. 미답변 리뷰 자동 순회
4~6을 자동 반복 (delay 포함)
7. **1~2점 리뷰는 자동 모드에서도 반자동 전환** (텔레그램 알림 후 대기)

**CS 처리 흐름**: 리뷰와 동일 패턴, content_cs.js 사용.

---

### Side Panel 변경

nav에 아이콘 2개 추가:

```
기존: [▶ 실행(run)] [⚙ 설정(settings)] ... [📄 로그(logfull)]
추가: [💬 리뷰(review)] [❓ CS(cs)]
```

리뷰 탭 UI:
- 톤 설정 (친근/정중/전문적) 라디오
- "리뷰 스캔" 버튼 → 미답변 리뷰 카드 리스트
- 각 카드: 별점 + 상품명 + 리뷰 일부 + [답변 생성] [건너뛰기]
- 답변 생성 후: 수정 가능한 textarea + [등록] [재생성] [취소]
- 하단 카운터: 처리 N / 스킵 N / 오류 N

CS 탭: 동일 패턴.

---

### chrome.storage.local 추가 키

```js
// config에 추가
config: {
  // ... 기존
  reviewTone: "정중",           // "친근" | "정중" | "전문적"
  reviewCustomPrompt: "",       // 셀러 커스텀 프롬프트
  reviewAutoMode: false,        // true: 자동, false: 반자동
  csAutoMode: false,
  vercelUrl: "https://navone-server.vercel.app",  // Vercel 서버 URL
}

// 리뷰 답변 이력
review_history: [
  {
    reviewId: "4984587284",
    productName: "...",
    rating: 5,
    originalReview: "...",
    generatedReply: "...",
    finalReply: "...",
    timestamp: "ISO",
    mode: "auto" | "manual",
  }
]  // 최대 500건, 초과시 oldest drop
```

---

### manifest.json 변경

```json
"host_permissions": [
  "https://sell.smartstore.naver.com/*",
  "https://search.shopping.naver.com/*",
  "https://api.commerce.naver.com/*",
  "https://api.telegram.org/*",
  "https://navone-server.vercel.app/*"
]
```

---

### 구현 순서 (권장)

1. `content_review.js` — PARSE_REVIEWS 먼저 (리뷰 목록 파싱만)
2. sidepanel 리뷰 탭 UI + 스캔 기능
3. background.js 리뷰 핸들러 (파싱 → sidepanel 전달)
4. Vercel 서버 배포 + background에서 API 호출
5. content_review.js — 답글 입력 (SELECT_REVIEW_AND_OPEN_MODAL + WRITE_REVIEW_REPLY)
6. 자동 모드
7. content_cs.js (리뷰와 동일 패턴)
