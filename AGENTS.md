# NavOne Multi-Agent Development System

> **목적**: Claude Code 에이전트 6개가 feature 브랜치에서 Tier1 기능을 병렬 구현하고, 준우가 사업판단 + 실테스트 + 배포만 담당하는 구조.
> **원칙**: 모든 Tier1 기능은 네이버 커머스 API 기반 → DOM 조작 없음 → 에이전트 자율 구현 가능

---

## 1. 시스템 아키텍처 (현재 상태)

```
┌─────────────────────────────────────────────────────────────┐
│                    NavOne Architecture                       │
│                                                             │
│  [Chrome Extension]  ←→  [Vercel Server]  ←→  [Supabase]   │
│   navone-extension        navone-server        DB 4 tables  │
│   - Side Panel UI         - 6 APIs             - users      │
│   - content scripts       - GPT-4o-mini        - licenses   │
│   - chrome.storage        - Commerce API       - configs    │
│   - price engine v2       - bcrypt auth        - logs       │
│                                                             │
│  [React Dashboard]   ←→  [Telegram Bot]                     │
│   navone-dashboard        @NavOne_bot                       │
│   - 6 pages               ChatID:5677149726                 │
│                                                             │
│  Test Store: 볼빨간오빠 (pkstory1974)                         │
│  GitHub: github.com/JSYSMED                                 │
└─────────────────────────────────────────────────────────────┘
```

### 레포 구조

| Repo | 역할 | 기술스택 |
|------|------|---------|
| `navone-extension` | 크롬 확장 (Side Panel + content scripts) | JS, Chrome APIs, chrome.storage |
| `navone-server` | Vercel 서버 (API 라우트 + AI 호출) | Node.js, Vercel Serverless, Supabase |
| `navone-dashboard` | React 웹 대시보드 | React, Vite |

### 네이버 커머스 API 인증

```
Auth Header = base64(bcrypt.hashpw(f"{client_id}_{timestamp}", client_secret))
Content-Type: application/json
Base URL: https://api.commerce.naver.com
```

### Supabase DB (기존 4 테이블)

```sql
-- 에이전트가 새 테이블 추가 시 반드시 이 네이밍 컨벤션 준수
-- prefix: navone_
-- 예: navone_settlements, navone_claims, navone_penalties
```

---

## 2. 에이전트 배정표

| Agent | Feature Branch | 담당 기능 | 작업 레포 | 핵심 API |
|-------|---------------|----------|----------|---------|
| **A** | `feature/settlement-margin` | 정산API + 마진대시보드 | server + dashboard | 정산 API (`/external/v1/pay-order/seller/settlements/`) |
| **B** | `feature/claim-automation` | 클레임 자동처리 | server + extension | Claim API (`.../claim/return/approve`, `.../claim/cancel/approve`) |
| **C** | `feature/order-dispatch` | 발주확인자동화 + 송장등록 | server + extension | Order API (`POST .../place-order`, `POST .../dispatch`) |
| **D** | `feature/clean-penalty-bot` | 클린페널티 알림봇 | server (+ Telegram) | Product API + 자체 로직 |
| **E** | `feature/cs-inquiry` | CS문의 AI답변 | server + extension | 고객문의 API (`GET /external/v1/pay-user/inquiries`) |
| **F** | `feature/auto-mode` | 자동모드 (chrome.alarms) | extension | chrome.alarms + 기존 API 호출 |

---

## 3. 브랜치 전략

```
main (안정/배포)
 ├── develop (통합 테스트)
 │    ├── feature/settlement-margin   ← Agent A
 │    ├── feature/claim-automation    ← Agent B
 │    ├── feature/order-dispatch      ← Agent C
 │    ├── feature/clean-penalty-bot   ← Agent D
 │    ├── feature/cs-inquiry          ← Agent E
 │    └── feature/auto-mode           ← Agent F
 │
 └── hotfix/* (긴급 수정)
```

### 브랜치 규칙

1. **에이전트는 자기 feature 브랜치에서만 작업** — 다른 브랜치 절대 터치 금지
2. **main에서 분기**: `git checkout main && git pull && git checkout -b feature/xxx`
3. **커밋 컨벤션**: `[AgentX] type: description`
   - 예: `[AgentA] feat: add settlement API route`
   - 예: `[AgentB] fix: claim approval error handling`
   - type: `feat`, `fix`, `refactor`, `test`, `docs`
4. **머지 순서** (충돌 최소화):
   - 1차: F (auto-mode) → 기존 코드 래핑만, 신규 파일 없음
   - 2차: D (penalty-bot) → 독립 모듈, 충돌 없음
   - 3차: A (settlement) → server + dashboard 신규 추가
   - 4차: C (order-dispatch) → server 라우트 추가
   - 5차: E (cs-inquiry) → server + extension 추가
   - 6차: B (claim) → 가장 복잡, 마지막 머지

### 충돌 방지 파일 할당

```
navone-server/
├── api/
│   ├── settlement/        ← Agent A 전용
│   ├── claim/             ← Agent B 전용
│   ├── order/             ← Agent C 전용
│   ├── penalty/           ← Agent D 전용
│   └── inquiry/           ← Agent E 전용
├── lib/
│   ├── commerce-auth.js   ← 공유 (READ ONLY — 수정 금지)
│   ├── supabase.js        ← 공유 (READ ONLY)
│   └── telegram.js        ← D가 생성, 다른 에이전트 참조 가능
│
navone-extension/
├── src/
│   ├── claim/             ← Agent B 전용
│   ├── order/             ← Agent C 전용
│   ├── inquiry/           ← Agent E 전용
│   ├── auto-mode/         ← Agent F 전용
│   └── content_cs.js      ← Agent E 전용 (기존 파일 수정)
│
navone-dashboard/
├── src/pages/
│   ├── Settlement/        ← Agent A 전용
│   └── Margin/            ← Agent A 전용
```

---

## 4. 공유 인프라 (에이전트 공통 사용)

### 4.1 Commerce API 헬퍼 (수정 금지, 임포트만)

```javascript
// navone-server/lib/commerce-auth.js (기존)
// 사용법:
const { getCommerceHeaders } = require('../lib/commerce-auth');
const headers = await getCommerceHeaders(clientId, clientSecret);
```

### 4.2 Supabase 클라이언트 (수정 금지, 임포트만)

```javascript
// navone-server/lib/supabase.js (기존)
const { supabase } = require('../lib/supabase');
```

### 4.3 에러 응답 표준

```javascript
// 모든 API 라우트에서 이 형식 준수
// 성공
res.status(200).json({ success: true, data: { ... } });

// 실패
res.status(4xx).json({ success: false, error: { code: 'ERROR_CODE', message: '...' } });
```

### 4.4 환경변수 (Vercel)

```
SUPABASE_URL=...
SUPABASE_KEY=...
OPENAI_API_KEY=...          # GPT-4o-mini
TELEGRAM_BOT_TOKEN=...      # @NavOne_bot
TELEGRAM_CHAT_ID=5677149726
```

에이전트가 새 환경변수 필요 시 → `.env.example`에 추가하고 README에 명시. 실제 값은 준우가 Vercel에 설정.

---

## 5. 에이전트별 상세 명세

### Agent A: 정산API + 마진대시보드

**목표**: 일별 정산 자동수집 → 상품별 마진 랭킹 대시보드

**작업 범위**:
- `navone-server/api/settlement/` — 정산 데이터 조회/저장 API
- `navone-dashboard/src/pages/Settlement/` — 정산 현황 페이지
- `navone-dashboard/src/pages/Margin/` — 마진 랭킹 페이지
- Supabase: `navone_settlements` 테이블 생성

**핵심 API 엔드포인트**:
```
GET /external/v1/pay-order/seller/settlements/daily
  - Query: startDate, endDate
  - Response: 일별 정산 내역 (수수료, 광고비, 배송비, 반품 차감 포함)
```

**산출물**:
1. `GET /api/settlement/daily?start=YYYY-MM-DD&end=YYYY-MM-DD` — 정산 조회
2. `GET /api/settlement/margin-rank` — 상품별 마진율 랭킹
3. Dashboard 2페이지 (Settlement, Margin)
4. Supabase migration SQL

**성공 기준**: 테스트스토어(볼빨간오빠)에서 최근 30일 정산 데이터 조회 + 마진율 계산 정확

---

### Agent B: 클레임 자동처리

**목표**: 반품/교환/취소 클레임을 AI로 분류 → 룰 매칭 시 자동 승인

**작업 범위**:
- `navone-server/api/claim/` — 클레임 조회/자동처리 API
- `navone-extension/src/claim/` — 클레임 알림 UI (Side Panel 탭)
- Supabase: `navone_claims` 테이블 + `navone_claim_rules` 테이블

**핵심 API 엔드포인트**:
```
GET  /external/v1/pay-order/seller/product-orders/last-changed-statuses
  - 클레임 상태 변경 감지 (폴링)

POST /external/v1/pay-order/seller/product-orders/{productOrderId}/claim/return/approve
POST /external/v1/pay-order/seller/product-orders/{productOrderId}/claim/cancel/approve
POST /external/v1/pay-order/seller/product-orders/{productOrderId}/claim/exchange/redeliver
```

**AI 분류 로직**:
```
클레임 접수 → GPT-4o-mini 사유 분류
  → 단순변심 + 금액 ≤ 기준 → 자동 승인
  → 상품하자 → 자동 승인 + 셀러 알림
  → 애매한 사유 → 보류 + 셀러 판단 요청 (Telegram 알림)
```

**산출물**:
1. `GET /api/claim/pending` — 미처리 클레임 목록
2. `POST /api/claim/auto-process` — AI 분류 + 자동처리
3. `POST /api/claim/manual-decide` — 셀러 수동 판단
4. Extension Side Panel 클레임 탭
5. Supabase migration SQL

**성공 기준**: 단순변심 반품 자동승인 정상 동작, Telegram 알림 수신

---

### Agent C: 발주확인자동화 + 송장등록

**목표**: 신규 주문 자동 발주확인 + 송장번호 일괄 등록

**작업 범위**:
- `navone-server/api/order/` — 주문 조회/발주확인/송장등록 API
- `navone-extension/src/order/` — 발주 현황 UI
- Supabase: `navone_orders` 테이블

**핵심 API 엔드포인트**:
```
GET  /external/v1/pay-order/seller/product-orders/last-changed-statuses
  - lastChangedFrom, lastChangedType=PAY_WAITING

POST /external/v1/pay-order/seller/product-orders/confirm
  - Body: { productOrderIds: [...] }

POST /external/v1/pay-order/seller/product-orders/dispatch
  - Body: { productOrderId, deliveryCompanyCode, trackingNumber }
```

**자동화 플로우**:
```
매시간 폴링 → 신규 주문 감지
  → 자동 발주확인 (설정 ON 시)
  → 셀러에게 Telegram 알림
  → 송장번호 입력 대기 (대시보드 or Extension)
  → 일괄 송장 등록
```

**산출물**:
1. `POST /api/order/auto-confirm` — 자동 발주확인
2. `POST /api/order/dispatch` — 송장 등록 (단건 + 일괄)
3. `GET /api/order/pending` — 미발주 주문 목록
4. Extension Side Panel 발주 탭

**성공 기준**: 테스트스토어 주문 자동 발주확인 + 송장 등록 정상 처리

---

### Agent D: 클린페널티 알림봇

**목표**: 14개월 무거래 상품, 등록 한도 임박, 클린 페널티 누적 자동 감지 → Telegram 알림

**작업 범위**:
- `navone-server/api/penalty/` — 페널티 리스크 분석 API
- `navone-server/lib/telegram.js` — Telegram 봇 헬퍼 (신규 생성)
- Supabase: `navone_penalty_alerts` 테이블

**자체 로직 (API 조합)**:
```
1. GET /v2/products/search → 전체 상품 목록
2. 각 상품의 lastSoldDate 체크 → 13개월 이상 무거래 = 위험
3. 등록 한도: 직전 3개월 판매액 < 500만원 → 1,000개 한도 경고
4. 클린 프로그램: 가품/심의위반 키워드 패턴 매칭

결과 → Telegram @NavOne_bot 알림 발송
  → Supabase 로그 저장
  → 대시보드 알림 뱃지 (optional)
```

**Telegram 메시지 포맷**:
```
🚨 NavOne 클린페널티 알림

⚠️ 무거래 위험 상품 (13개월+): 3건
  - [상품명1] (마지막 판매: 2025-04-15)
  - [상품명2] (마지막 판매: 2025-03-22)

📊 등록 한도: 847 / 1,000 (84.7%)
💡 권장: 무거래 상품 정리로 한도 확보
```

**산출물**:
1. `GET /api/penalty/risk-scan` — 리스크 스캔 실행
2. `lib/telegram.js` — 범용 Telegram 발송 모듈
3. Supabase migration SQL
4. cron 설정 가이드 (Vercel Cron)

**성공 기준**: 테스트스토어 상품 스캔 + Telegram 알림 수신

---

### Agent E: CS문의 AI답변

**목표**: 상품 Q&A(고객문의) AI 자동답변 등록

**작업 범위**:
- `navone-server/api/inquiry/` — 문의 조회/답변 등록 API
- `navone-extension/src/inquiry/` — 문의 목록 + AI 답변 UI
- `navone-extension/src/content_cs.js` — 기존 파일 확장

**핵심 API 엔드포인트**:
```
GET  /external/v1/pay-user/inquiries
  - 고객문의 목록 조회 (v1.4.0 신설)

POST /external/v1/pay-user/inquiries/{inquiryId}/answer
  - AI 생성 답변 등록
```

**AI 답변 파이프라인**:
```
문의 접수 → 상품정보 + 문의내용 → GPT-4o-mini
  → 시스템 프롬프트:
    "네이버 스마트스토어 셀러 CS 담당자. 정중하고 정확하게.
     상품 스펙 기반 답변. 모르는 건 '확인 후 답변 드리겠습니다.'
     공정위 표시광고법 위반 표현 금지."
  → 답변 초안 생성 → 셀러 확인/수정 → 등록
     (자동모드 ON 시: 확인 없이 바로 등록)
```

**산출물**:
1. `GET /api/inquiry/list` — 미답변 문의 목록
2. `POST /api/inquiry/ai-answer` — AI 답변 생성
3. `POST /api/inquiry/submit` — 답변 등록
4. Extension Side Panel CS 탭

**성공 기준**: 테스트스토어 문의에 AI 답변 생성 + 등록 정상 동작

---

### Agent F: 자동모드 (chrome.alarms)

**목표**: 기존 기능들(가격자동화, 리뷰답글, 향후 추가 기능)을 주기적으로 자동 실행

**작업 범위**:
- `navone-extension/src/auto-mode/` — 자동모드 엔진
- `navone-extension/manifest.json` — alarms 권한 추가
- 기존 코드 수정 최소화 (래핑만)

**설계**:
```javascript
// auto-mode/scheduler.js
const TASKS = {
  price_update:    { interval: 60,   handler: 'priceEngine.run' },
  review_reply:    { interval: 30,   handler: 'reviewReply.run' },
  order_confirm:   { interval: 60,   handler: 'orderConfirm.run' },  // Agent C 완성 후
  inquiry_reply:   { interval: 30,   handler: 'inquiryReply.run' },  // Agent E 완성 후
  claim_process:   { interval: 15,   handler: 'claimProcess.run' },  // Agent B 완성 후
  penalty_scan:    { interval: 1440, handler: 'penaltyScan.run' },   // Agent D 완성 후 (1일 1회)
};

// chrome.alarms.create('navone-auto', { periodInMinutes: 1 });
// onAlarm → 각 태스크의 마지막 실행 시간 체크 → interval 경과 시 실행
```

**manifest.json 추가**:
```json
{
  "permissions": ["alarms"],
  "background": {
    "service_worker": "src/auto-mode/background.js"
  }
}
```

**산출물**:
1. `auto-mode/scheduler.js` — 태스크 스케줄러
2. `auto-mode/background.js` — Service Worker 등록
3. `auto-mode/config.js` — 사용자 설정 (ON/OFF, 인터벌)
4. Side Panel 자동모드 설정 UI
5. manifest.json 수정사항 문서화

**성공 기준**: 가격자동화가 chrome.alarms로 주기 실행 + ON/OFF 토글 정상

---

## 6. 에이전트 실행 규칙

### 절대 금지사항 (모든 에이전트 공통)
1. ❌ `main` 또는 `develop` 브랜치에 직접 커밋
2. ❌ 다른 에이전트의 전용 디렉토리 수정
3. ❌ `lib/commerce-auth.js`, `lib/supabase.js` 수정
4. ❌ DOM 크롤링/스크래핑 (모든 기능은 API 기반)
5. ❌ 하드코딩된 API 키/시크릿 (환경변수 사용)
6. ❌ 새 npm 패키지 무단 추가 (README에 사유 명시 필수)
7. ❌ 기존 API 라우트의 응답 형식 변경

### 필수 준수사항
1. ✅ 커밋 메시지에 `[AgentX]` 프리픽스
2. ✅ 새 API 라우트마다 에러 핸들링 + 응답 표준 준수
3. ✅ Supabase 테이블 생성 시 migration SQL 파일 포함
4. ✅ README.md에 새로 추가한 환경변수/의존성 문서화
5. ✅ Commerce API RPS 제한 준수 (초당 2회 이하)
6. ✅ 각 기능의 ON/OFF 토글 구현 (사용자 제어)
7. ✅ Telegram 알림 시 `lib/telegram.js` 사용 (Agent D가 생성)

---

## 7. 머지 & 테스트 프로토콜

### Phase 1: 개별 완성 (에이전트 작업)
```bash
# 각 에이전트가 feature 브랜치에서:
1. 구현 완료
2. 자체 테스트 코드 작성
3. README 업데이트
4. PR 생성 → develop
```

### Phase 2: 준우 검수
```bash
# 준우가 각 PR을 순서대로 검수:
1. 코드 리뷰 (구조, 네이밍, 에러핸들링)
2. 테스트스토어(볼빨간오빠)에서 실동작 확인
3. 환경변수 설정 (Vercel, Supabase)
4. 통과 시 develop에 머지
```

### Phase 3: 통합 테스트
```bash
# develop 브랜치에서:
1. 전체 기능 동시 동작 확인
2. API 충돌/레이스컨디션 테스트
3. chrome.alarms 자동모드 전체 기능 연동 확인
4. 안정 확인 후 main 머지 + Vercel 배포
```

### 머지 순서 (충돌 최소화)
```
F (auto-mode)        → 기존 래핑만, 가장 안전
D (penalty-bot)      → 독립 모듈
A (settlement)       → server + dashboard 추가
C (order-dispatch)   → server + extension 추가
E (cs-inquiry)       → server + extension 추가
B (claim)            → 가장 복잡, AI 로직 포함
```

---

## 8. 에이전트 간 의존성

```
F (auto-mode) ──depends-on──→ B, C, D, E (각 기능의 .run() 인터페이스)
B (claim)     ──uses──→ D의 lib/telegram.js
C (order)     ──uses──→ D의 lib/telegram.js
E (inquiry)   ──uses──→ 기존 GPT-4o-mini 파이프라인

해결 전략:
- D를 가장 먼저 착수 → telegram.js 모듈 빠르게 생성
- F는 스텁(stub) 인터페이스로 먼저 구현, 각 기능 완성 후 연결
- 각 기능은 반드시 export { run } 인터페이스 노출
```

### 표준 run() 인터페이스 (모든 자동화 기능 필수)

```javascript
// 각 기능 모듈이 반드시 export해야 하는 인터페이스
module.exports = {
  /**
   * @param {Object} config - 사용자 설정 (chrome.storage에서 로드)
   * @returns {Promise<{ success: boolean, processed: number, errors: string[] }>}
   */
  async run(config) {
    // 기능 실행 로직
    return { success: true, processed: 5, errors: [] };
  }
};
```
