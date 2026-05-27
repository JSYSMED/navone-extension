# Agent B — 클레임 탭 (navone-extension)

navone-server `/api/claim/*` 를 호출하는 Side Panel 클레임 UI + 자동모드 태스크.
빌드/번들 없음 — 파일은 `<script>` 또는 `importScripts`로 직접 로드.

## 파일
| 파일 | 역할 | 노출 전역 |
|------|------|-----------|
| `claim-api.js` | 서버 엔드포인트 fetch 래퍼 | `NavOneClaimAPI` |
| `claim-panel.js` | Side Panel 클레임 탭 UI(자립형) | `NavOneClaimPanel` |
| `claimProcess.js` | Agent F 자동모드 `run(config)` 태스크 | `claimProcess` |

## Side Panel 통합 (sidepanel.html / sidepanel.js)
> `sidepanel.*` 는 공용 코어라 직접 수정하지 않음. 코어 담당자가 아래만 추가:

1. `sidepanel.html` `<head>`(또는 body 끝)에 스크립트 추가:
   ```html
   <script src="src/claim/claim-api.js"></script>
   <script src="src/claim/claim-panel.js"></script>
   ```
2. 탭 컨테이너 추가: `<div id="claim-tab"></div>`
3. 탭 활성화 시 마운트(config는 `chrome.storage.local.config`):
   ```js
   chrome.storage.local.get("config", ({ config }) => {
     NavOneClaimPanel.mount(document.getElementById("claim-tab"), config || {});
   });
   ```
   - config 필수 필드: `licenseKey` (서버가 이 키로 스토어/커머스 자격증명 조회). 개발 시 `serverBase` 로 서버 URL override.

## Agent F 자동모드 연동 (background.js service worker)
AGENTS.md §8 표준 `run()` 인터페이스. scheduler 의 `claim_process.handler = "claimProcess.run"` 에 대응.
```js
// background.js (service worker, classic)
importScripts("src/claim/claim-api.js", "src/claim/claimProcess.js");
const result = await claimProcess.run(config); // { success, processed, errors }
```

## manifest.json
서버/텔레그램 host_permission 은 이미 존재(`navone-server.vercel.app`, `api.telegram.org`). 추가 권한 불필요.
