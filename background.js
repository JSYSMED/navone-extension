// =============================================
// background.js v2 — Side Panel + 구조화 로그
// =============================================

importScripts("lib/bcrypt.js");

let CFG = {};
let state = {
  running: false, products: [], currentIndex: 0, results: [], token: null, tokenExpiry: 0,
  // v2: 메모리 캐시 — startProcess 시작 시 storage에서 로드
  productConfigs: {},   // product_configs[channelProductNo] = { min_sale_price, strategy, updated_at }
  snapshots: {},        // price_snapshots[channelProductNo] = { sellers, timestamp }
};

// 확장 아이콘 클릭 → Side Panel 열기
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// 설정 로드
async function loadConfig() {
  return new Promise(r => {
    chrome.storage.local.get("config", data => {
      const c = data.config || {};
      CFG = {
        CLIENT_ID: c.clientId || "",
        CLIENT_SECRET: c.clientSecret || "",
        MY_STORE_NAMES: c.storeNames || [],
        UNDERCUT: c.undercut || 10,
        MIN_MARGIN: c.margin || 20,   // [deprecated v2] floor는 min_sale_price/fallback로 산출. 미사용.
        MIN_PRICE: 1000,
        TG_TOKEN: c.tgToken || "",
        TG_CHAT_ID: c.tgChatId || "",
        TAB_LOAD_TIMEOUT: 10000,
        DELAY: 2000,
        PRICE_FLOOR: {},              // [deprecated v2] 미사용.
      };
      r();
    });
  });
}

// =============================================
// v2: storage 헬퍼 + 가격 결정 알고리즘
// =============================================
function storageGet(key) {
  return new Promise(r => chrome.storage.local.get(key, d => r(d[key])));
}
function storageSet(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r));
}

// startProcess 시작 시 1회 로드
async function loadProductConfigs() {
  state.productConfigs = (await storageGet("product_configs")) || {};
}
async function loadSnapshots() {
  state.snapshots = (await storageGet("price_snapshots")) || {};
}

// 매 사이클: 현재 판매자 목록을 스냅샷으로 저장 (다음 사이클 급락 필터용)
async function savePriceSnapshot(channelProductNo, sellers) {
  state.snapshots[channelProductNo] = { sellers, timestamp: Date.now() };
  await storageSet({ price_snapshots: state.snapshots });
}

// price_history append (최대 1000건, 초과 시 오래된 것 삭제)
async function appendPriceHistory(entry) {
  const hist = (await storageGet("price_history")) || [];
  hist.push(entry);
  if (hist.length > 1000) hist.splice(0, hist.length - 1000);
  await storageSet({ price_history: hist });
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 자사 제외 + 이상치(오매칭) 제외 + 급락(쿠폰 의심) 제외
// 반환: [{ sellerName, price, deliveryFee, exposure }] (노출 총액 기준)
function filterCompetitors(sellers, prevSnapshot) {
  // 1) 자사 제외 (기존 로직 유지)
  let competitors = sellers.filter(
    s => !CFG.MY_STORE_NAMES.some(name => s.sellerName.includes(name) || name.includes(s.sellerName))
  ).map(s => ({
    sellerName: s.sellerName,
    price: s.price,
    deliveryFee: s.deliveryFee || 0,
    exposure: s.price + (s.deliveryFee || 0),
  }));

  if (competitors.length === 0) return competitors;

  // 2) median 50% 미만 제외 (오매칭 의심)
  const med = median(competitors.map(c => c.exposure));
  if (med > 0) {
    competitors = competitors.filter(c => {
      if (c.exposure < med * 0.5) {
        log("  ⛔ 오매칭 제외: " + c.sellerName + " " + c.exposure.toLocaleString() + " (median " + med.toLocaleString() + ")");
        return false;
      }
      return true;
    });
  }

  // 3) 직전 스냅샷 대비 -30% 이상 급락 제외 (쿠폰 의심)
  if (prevSnapshot && prevSnapshot.sellers) {
    const prevByName = {};
    prevSnapshot.sellers.forEach(s => { prevByName[s.sellerName] = s.price + (s.deliveryFee || 0); });
    competitors = competitors.filter(c => {
      const prev = prevByName[c.sellerName];
      if (prev && c.exposure <= prev * 0.7) {
        log("  ⛔ 급락 제외: " + c.sellerName + " " + prev.toLocaleString() + "→" + c.exposure.toLocaleString());
        return false;
      }
      return true;
    });
  }

  return competitors;
}

// 1·2위 gap 기반 분기 + 최소 판매가 보호.
// 모든 가격은 노출 총액(price+배송비) 기준으로 비교, 최종 판매가는 노출가에서 배송비 차감.
// 반환: { rank1, rank2, rank3, gap, floor, floorSource, targetExposure, finalPrice, actionType, triggeredBy }
function computeV2Decision(competitors, ourDeliveryFee, productConfig) {
  const sorted = [...competitors].sort((a, b) => a.exposure - b.exposure);
  const rank1 = sorted[0];
  const rank2 = sorted[1] || null;
  const rank3 = sorted[2] || null;

  // floor (판매가 단위)
  let floor, floorSource;
  if (productConfig && productConfig.min_sale_price > 0) {
    floor = productConfig.min_sale_price;
    floorSource = "USER";
  } else {
    // fallback: 노출 총액 기준 → 배송비 차감해 판매가 단위로 환산
    const base = rank3 ? rank3.exposure * 0.90 : (rank2 ? rank2.exposure * 0.85 : rank1.exposure * 0.85);
    floor = Math.max(Math.floor(base - ourDeliveryFee), CFG.MIN_PRICE);
    floorSource = "FALLBACK";
  }

  // gap + 분기
  const gap = rank2 ? (rank2.exposure - rank1.exposure) / rank2.exposure * 100 : 0;
  let chosen, baseAction, triggeredBy;
  if (!rank2 || gap < 3) {
    chosen = rank1; baseAction = "AUTO_RANK1"; triggeredBy = "AUTO";
  } else {
    triggeredBy = "DEFAULT";
    if (gap >= 4) { chosen = rank2; baseAction = "DEFAULT_RANK2"; }
    else { chosen = rank1; baseAction = "DEFAULT_RANK1"; }
  }

  const targetExposure = chosen.exposure - CFG.UNDERCUT;
  const targetSalePrice = targetExposure - ourDeliveryFee;

  let finalPrice, actionType;
  if (targetSalePrice <= 0) {
    finalPrice = 0; actionType = "PRICE_TOO_LOW";
  } else if (targetSalePrice < floor) {
    finalPrice = floor; actionType = "FLOOR_HOLD";
  } else {
    finalPrice = targetSalePrice; actionType = baseAction;
  }

  return { rank1, rank2, rank3, gap, floor, floorSource, targetExposure, finalPrice, actionType, triggeredBy };
}

// =============================================
// 메시지 핸들러
// =============================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "START") {
    if (state.running) { sendResponse({ status: "already_running" }); return; }
    startProcess(msg.tabId, msg.testMode);
    sendResponse({ status: "started" });
  }
  else if (msg.action === "STOP") { state.running = false; sendResponse({ status: "stopped" }); }
  else if (msg.action === "GET_STATUS") {
    sendResponse({ running: state.running, total: state.products.length, current: state.currentIndex, results: state.results.slice(-20) });
  }
  else if (msg.action === "SCAN_REVIEWS") {
    scanReviews(msg.tabId).then(sendResponse);
    return true;  // 비동기 응답
  }
  else if (msg.action === "GENERATE_REVIEW_REPLY") {
    generateReviewReply(msg.review, msg.tone).then(sendResponse);
    return true;  // 비동기 응답
  }
  else if (msg.action === "SUBMIT_REPLY") {
    submitReply(msg.tabId, msg.rowIndex, msg.replyText, msg.review).then(sendResponse);
    return true;  // 비동기 응답
  }
  return true;
});

// =============================================
// 리뷰 핸들러
// =============================================
// SCAN_REVIEWS: content_review.js 주입 → PARSE_REVIEWS → 리뷰 목록 반환
async function scanReviews(tabId) {
  try {
    log("\n💬 리뷰 스캔 시작");
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content_review.js"] }); } catch (e) {}
    await sleep(500);

    const res = await sendMessageToTab(tabId, { action: "PARSE_REVIEWS" });
    if (!res || !res.success || !Array.isArray(res.reviews) || res.reviews.length === 0) {
      log("⚠️ 리뷰 파싱 실패 또는 0건");
      slog("skip", "리뷰 없음", "미답변 리뷰를 찾지 못했습니다. 페이지를 확인해주세요.");
      return { success: false, reviews: [] };
    }

    log("💬 리뷰 " + res.reviews.length + "개 수집");
    slog("collect", "리뷰 스캔 완료", res.reviews.length + "개 리뷰를 불러왔습니다.");
    return { success: true, reviews: res.reviews };
  } catch (e) {
    log("❌ 리뷰 스캔 오류: " + e.message);
    return { success: false, reviews: [], error: e.message };
  }
}

// GENERATE_REVIEW_REPLY: Vercel /api/review-reply 호출 → AI 답글 생성
// config는 startProcess와 무관하게 호출될 수 있으므로 storage에서 직접 읽음
async function generateReviewReply(review, tone) {
  try {
    if (!review || !review.content) return { success: false, error: "리뷰 내용 없음" };

    const cfg = (await storageGet("config")) || {};
    const vercelUrl = (cfg.vercelUrl || "https://navone-server.vercel.app").replace(/\/+$/, "");
    const storeName = (cfg.storeNames && cfg.storeNames[0]) || "스토어";

    const body = {
      review: {
        content: review.content,
        rating: review.rating || 0,
        productName: review.productName || "",
        photoCount: review.photoCount || 0,
      },
      storeContext: {
        storeName,
        tone: tone || cfg.reviewTone || "정중",
        customPrompt: cfg.reviewCustomPrompt || "",
      },
      licenseKey: cfg.licenseKey || "",
    };

    const res = await fetch(vercelUrl + "/api/review-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error || ""; } catch (_) {}
      log("❌ 답변 생성 실패 (" + res.status + ") " + detail);
      return { success: false, error: "서버 오류 " + res.status + (detail ? " · " + detail : "") };
    }

    const data = await res.json();
    if (!data.reply) return { success: false, error: data.error || "빈 응답" };

    const out = data.tokens ? data.tokens.output : 0;
    log("✍️ 답변 생성 완료 (" + (review.rating || 0) + "점, " + out + " 토큰)");
    return { success: true, reply: data.reply, tokens: data.tokens };
  } catch (e) {
    log("❌ 답변 생성 오류: " + e.message);
    return { success: false, error: e.message };
  }
}

// SUBMIT_REPLY: 체크박스 선택 → 답글작성 모달 → 답글 입력+등록 (content_review.js 순차 호출)
async function submitReply(tabId, rowIndex, replyText, review) {
  try {
    const text = (replyText || "").trim();
    if (text.length < 5) return { success: false, error: "답글은 최소 5자 이상" };

    log("\n📝 답글 등록 시작 (row " + rowIndex + ")");

    // 1) 개별 리뷰 상세 팝업 열기 (리뷰내용 셀 링크 클릭)
    const open = await sendMessageToTab(tabId, { action: "OPEN_REVIEW_DETAIL", rowIndex });
    if (!open || !open.success) {
      // 링크 클릭으로 안 열리면 → MAIN world에서 vm.func.openReviewDetailModal(reviewId, true) 직접 호출
      const reviewId = (open && open.reviewId) || (review && review.reviewId);
      if (open && open.needMainWorld && reviewId) {
        log("  ↪ 링크 클릭 실패 → openReviewDetailModal(MAIN) 폴백 (reviewId " + reviewId + ")");
        const r = await openDetailViaAngular(tabId, reviewId);
        if (!r || !r.ok) return failReply({ error: (r && r.reason) || "상세 팝업 열기 실패" }, "리뷰 상세 팝업 열기 실패");
        log("  ✅ openReviewDetailModal 호출 성공");
        await sleep(1200);  // 팝업 렌더 대기
      } else {
        return failReply(open, "리뷰 상세 팝업 열기 실패");
      }
    }
    await sleep(1000);

    // 2) 팝업의 답글 textarea에 입력 + 등록
    const write = await sendMessageToTab(tabId, { action: "WRITE_REVIEW_REPLY", replyText: text });
    if (!write || !write.success) {
      // 실패해도 팝업은 닫아 다음 리뷰 진행에 지장 없게
      await sleep(300);
      await sendMessageToTab(tabId, { action: "CLOSE_REVIEW_DETAIL" });
      return failReply(write, "답글 입력/등록 실패");
    }

    // 3) 팝업 닫기
    await sleep(500);
    await sendMessageToTab(tabId, { action: "CLOSE_REVIEW_DETAIL" });

    // 성공 → review_history 기록
    await appendReviewHistory({
      reviewId: review ? review.reviewId : null,
      productName: review ? review.productName : "",
      rating: review ? review.rating : 0,
      originalReview: review ? review.content : "",
      generatedReply: (review && review.generatedReply) || text,
      finalReply: text,
      timestamp: new Date().toISOString(),
      mode: "manual",
    });

    // 서버에도 적재 (fire-and-forget)
    pushHistory("review", {
      review_id: review && review.reviewId,
      product_name: review && review.productName,
      rating: review && review.rating,
      original_review: review && review.content,
      generated_reply: (review && review.generatedReply) || text,
      final_reply: text,
      mode: "manual",
    });

    log("✅ 답글 등록 완료");
    slog("change", "답글 등록", (review && review.productName) || ("row " + rowIndex));

    // sidepanel에 결과 통지
    chrome.runtime.sendMessage({
      action: "REPLY_SUBMITTED",
      rowIndex,
      reviewId: review ? review.reviewId : null,
      success: true,
    }).catch(() => {});

    return { success: true };
  } catch (e) {
    log("❌ 답글 등록 오류: " + e.message);
    return { success: false, error: e.message };
  }
}

function failReply(res, fallbackMsg) {
  const err = (res && res.error) || fallbackMsg;
  log("❌ " + err);
  return { success: false, error: err };
}

// 상세 팝업 열기 폴백 (MAIN world) — 콘텐트 스크립트는 isolated world라 vm scope에 직접 못 닿음.
// AngularJS scope 트리를 훑어 func.openReviewDetailModal를 가진 컨트롤러(vm)를 찾아
// 파싱해둔 reviewId로 직접 호출. func의 반환값이 executeScript 결과로 돌아옴.
async function openDetailViaAngular(tabId, reviewId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: function (rid) {
        if (typeof angular === "undefined") return { ok: false, reason: "angular 없음" };

        function hasFn(o) {
          return o && o.func && typeof o.func.openReviewDetailModal === "function";
        }
        var found = null, seen = 0;
        function scan(scope) {
          if (!scope || found || seen > 8000) return;
          seen++;
          for (var k in scope) {
            if (k.charAt(0) === "$") continue;
            var v;
            try { v = scope[k]; } catch (e) { continue; }
            if (hasFn(v)) { found = { scope: scope, vm: v }; return; }
          }
          scan(scope.$$childHead);
          if (!found) scan(scope.$$nextSibling);
        }
        try { scan(angular.element(document.body).scope()); } catch (e) {}

        if (!found) return { ok: false, reason: "vm.func.openReviewDetailModal 못 찾음" };
        try {
          found.scope.$apply(function () {
            found.vm.func.openReviewDetailModal(Number(rid), true);
          });
          return { ok: true };
        } catch (e) {
          try {
            found.vm.func.openReviewDetailModal(Number(rid), true);
            return { ok: true };
          } catch (e2) {
            return { ok: false, reason: e2.message };
          }
        }
      },
      args: [reviewId],
    });
    return res && res[0] && res[0].result;
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// 실행 결과를 Vercel 서버에 적재 (fire-and-forget).
// 서버 에러가 확장 동작을 멈추면 안 되므로 전부 try/catch로 삼킴. 로컬 저장과 무관.
async function pushHistory(type, data) {
  try {
    const cfg = (await storageGet("config")) || {};
    const licenseKey = cfg.licenseKey || "";
    if (!licenseKey) return;  // 라이선스 없으면 서버 적재 스킵 (로컬 저장은 그대로)
    const vercelUrl = (cfg.vercelUrl || "https://navone-server.vercel.app").replace(/\/+$/, "");
    await fetch(vercelUrl + "/api/history-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey, type, data }),
    });
  } catch (e) {
    console.log("[NavOne] history push 실패(무시): " + e.message);
  }
}

// review_history append (최대 500건, 초과 시 오래된 것 삭제)
async function appendReviewHistory(entry) {
  const hist = (await storageGet("review_history")) || [];
  hist.push(entry);
  if (hist.length > 500) hist.splice(0, hist.length - 500);
  await storageSet({ review_history: hist });
}

// =============================================
// 텔레그램
// =============================================
async function tg(text) {
  if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) return;
  try {
    await fetch("https://api.telegram.org/bot" + CFG.TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CFG.TG_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) {}
}

// =============================================
// 메인
// =============================================
async function startProcess(catalogTabId, testMode) {
  state.running = true;
  state.results = [];
  state.currentIndex = 0;
  state.products = [];

  await loadConfig();
  await loadProductConfigs();
  await loadSnapshots();

  if (!CFG.CLIENT_ID || !CFG.CLIENT_SECRET) {
    log("❌ 설정에서 Commerce API 키를 입력하세요");
    state.running = false;
    return;
  }

  log("가격 자동화 시작");
  slog("collect", "자동화 시작", (testMode ? "테스트" : "실전") + " 모드로 시작합니다.");
  tg("🚀 <b>가격 자동화 시작</b>\n모드: " + (testMode ? "테스트" : "실전"));

  try {
    try { await chrome.scripting.executeScript({ target: { tabId: catalogTabId }, files: ["content_catalog.js"] }); } catch(e) {}
    await sleep(500);

    log("🔑 토큰 발급 중...");
    if (!await ensureToken()) { log("❌ 토큰 실패"); tg("❌ 토큰 발급 실패"); state.running = false; return; }
    log("✅ 토큰 발급 완료");

    let page = 1;
    let totalProcessed = 0;
    let allProductNos = new Set();
    let totalUpdated = 0, totalSkipped = 0, totalErrors = 0;

    while (state.running) {
      log("\n📄 " + page + "페이지 파싱 중...");
      const response = await sendMessageToTab(catalogTabId, { action: "PARSE_CATALOG_TABLE" });
      if (!response || !response.success || response.products.length === 0) {
        if (page === 1) { log("❌ 카탈로그 파싱 실패"); tg("❌ 카탈로그 파싱 실패"); state.running = false; return; }
        break;
      }

      const newProducts = response.products.filter(p => !allProductNos.has(p.channelProductNo));
      if (newProducts.length === 0) { log("⚠️ 중복 감지 → 중단"); break; }
      newProducts.forEach(p => allProductNos.add(p.channelProductNo));
      log("📄 " + page + "페이지: " + newProducts.length + "개 수집");
      slog("collect", page + "페이지 수집 완료", newProducts.length + "개 상품을 수집했습니다.");

      const targets = newProducts.filter(p => p.priceDiffText.includes("높음") || p.priceDiff > 0);
      state.products = state.products.concat(targets);  // 프로그레스 바 total 반영
      log("🎯 가격 조정 필요: " + targets.length + "개");
      if (targets.length > 0) slog("collect", "가격 조정 대상 " + targets.length + "개", "내 가격이 높은 상품을 찾았습니다.");

      for (const product of targets) {
        if (!state.running) break;
        totalProcessed++;
        state.currentIndex = totalProcessed;

        log("\n[" + totalProcessed + "] " + (product.productName || product.channelProductNo));
        log("  📊 " + product.priceDiffText + " | 카탈로그최저: " + (product.catalogPrice || 0).toLocaleString());

        try {
          const priceData = await clickDetailAndParse(catalogTabId, product.channelProductNo);

          if (!priceData || !priceData.success || !priceData.sellers || priceData.sellers.length === 0) {
            log("  ⚠️ 판매자 정보 없음: " + (priceData?.error || "파싱 실패"));
            state.results.push({ ...product, status: "NO_SELLERS" });
            totalErrors++;
            await sleep(CFG.DELAY);
            continue;
          }

          log("  👥 판매자 " + priceData.sellers.length + "명");
          priceData.sellers.slice(0, 5).forEach(s => log("     " + s.sellerName + ": " + s.price.toLocaleString() + "원"));

          // v2: 직전 스냅샷 읽고(급락 필터용) 이번 사이클 스냅샷 저장
          const prevSnapshot = state.snapshots[product.channelProductNo];
          await savePriceSnapshot(product.channelProductNo, priceData.sellers);

          const competitors = filterCompetitors(priceData.sellers, prevSnapshot);
          if (competitors.length === 0) {
            log("  ✅ 경쟁사 없음");
            state.results.push({ ...product, status: "NO_COMPETITORS" });
            totalSkipped++;
            continue;
          }

          await ensureToken();
          const productInfo = await getProductInfo(product.channelProductNo);
          if (!productInfo.success) {
            log("  ❌ 상품 조회 실패: " + productInfo.error);
            state.results.push({ ...product, status: "API_ERROR" });
            totalErrors++;
            continue;
          }

          const ourDeliveryFee = productInfo.deliveryFee || 0;
          const ourCurrentSalePrice = productInfo.salePrice || 0;
          log("  📦 배송비: " + ourDeliveryFee.toLocaleString() + " | 현재가: " + ourCurrentSalePrice.toLocaleString());

          // v2 가격 결정
          const productConfig = state.productConfigs[product.channelProductNo];
          const d = computeV2Decision(competitors, ourDeliveryFee, productConfig);

          log("  📊 1위 " + d.rank1.exposure.toLocaleString() + " / 2위 " + (d.rank2 ? d.rank2.exposure.toLocaleString() : "-") + " / gap " + d.gap.toFixed(2) + "%");
          log("  🛡️ floor " + d.floor.toLocaleString() + " (" + d.floorSource + ")");

          if (d.actionType === "PRICE_TOO_LOW") {
            log("  ⚠️ 배송비 차감 후 0 이하 → 건너뜀");
            state.results.push({ ...product, status: "PRICE_TOO_LOW" });
            totalSkipped++;
            continue;
          }

          const finalPrice = d.finalPrice;
          log("  🎯 [" + d.actionType + "/" + d.triggeredBy + "] 노출 " + (finalPrice + ourDeliveryFee).toLocaleString() + " = 판매가 " + finalPrice.toLocaleString() + " + 배송비 " + ourDeliveryFee.toLocaleString());

          // price_history 기록 (결정에 도달한 모든 상품)
          const histEntry = {
            channelProductNo: product.channelProductNo,
            timestamp: new Date().toISOString(),
            old_price: ourCurrentSalePrice,
            new_price: finalPrice,
            rank1_price: d.rank1.exposure,
            rank2_price: d.rank2 ? d.rank2.exposure : null,
            gap_percent: parseFloat(d.gap.toFixed(2)),
            action_type: d.actionType,
            floor: d.floor,
            triggered_by: d.triggeredBy,
          };

          if (ourCurrentSalePrice > 0 && finalPrice === ourCurrentSalePrice) {
            log("  ✅ 가격 동일 → 건너뜀");
            await appendPriceHistory({ ...histEntry, action_type: "SAME_PRICE" });
            state.results.push({ ...product, status: "SAME_PRICE" });
            totalSkipped++;
            continue;
          }

          if (testMode) {
            log("  🧪 [테스트] " + ourCurrentSalePrice + " → " + finalPrice + " (노출: " + (finalPrice + ourDeliveryFee) + ")");
            slog("change", "🧪 " + (product.productName || product.channelProductNo), "[테스트] " + ourCurrentSalePrice.toLocaleString() + "원 → " + finalPrice.toLocaleString() + "원 (노출가 " + (finalPrice + ourDeliveryFee).toLocaleString() + "원)");
            await appendPriceHistory(histEntry);
            state.results.push({ ...product, status: "TEST_SKIP", from: ourCurrentSalePrice, to: finalPrice });
            totalUpdated++;
          } else {
            await ensureToken();
            const result = await updateProductPrice(product.channelProductNo, finalPrice, productInfo.rawData);
            if (result.success) {
              log("  변경: " + ourCurrentSalePrice + " → " + finalPrice + " (노출: " + (finalPrice + ourDeliveryFee) + ")");
              slog("change", (product.productName || product.channelProductNo), ourCurrentSalePrice.toLocaleString() + "원 → " + finalPrice.toLocaleString() + "원 (노출가 " + (finalPrice + ourDeliveryFee).toLocaleString() + "원)");
              tg("💰 <b>" + (product.productName || product.channelProductNo) + "</b>\n" +
                 ourCurrentSalePrice.toLocaleString() + "원 → " + finalPrice.toLocaleString() + "원\n" +
                 "노출가: " + (finalPrice + ourDeliveryFee).toLocaleString() + "원 (1위: " + d.rank1.exposure.toLocaleString() + ", gap " + d.gap.toFixed(1) + "%)");
              await appendPriceHistory(histEntry);
              // 서버에도 적재 (fire-and-forget)
              pushHistory("price", {
                channel_product_no: histEntry.channelProductNo,
                product_name: product.productName || "",
                old_price: histEntry.old_price,
                new_price: histEntry.new_price,
                rank1_price: histEntry.rank1_price,
                rank2_price: histEntry.rank2_price,
                gap_percent: histEntry.gap_percent,
                action_type: histEntry.action_type,
                floor_price: histEntry.floor,
                triggered_by: histEntry.triggered_by,
              });
              state.results.push({ ...product, status: "UPDATED", from: ourCurrentSalePrice, to: finalPrice });
              totalUpdated++;
            } else {
              log("  ❌ API: " + result.error);
              await appendPriceHistory({ ...histEntry, action_type: "API_ERROR" });
              state.results.push({ ...product, status: "API_ERROR", error: result.error });
              totalErrors++;
            }
          }
        } catch (e) {
          log("  ❌ 오류: " + e.message);
          state.results.push({ ...product, status: "ERROR", error: e.message });
          totalErrors++;
        }
        await sleep(CFG.DELAY);
      }

      const nextResult = await sendMessageToTab(catalogTabId, { action: "CLICK_NEXT_PAGE" });
      if (!nextResult?.hasNext) break;
      await sleep(5000);
      try { await chrome.scripting.executeScript({ target: { tabId: catalogTabId }, files: ["content_catalog.js"] }); } catch(e) {}
      await sleep(500);
      page++;
    }

    const summary = "완료! 변경: " + totalUpdated + " / 스킵: " + totalSkipped + " / 오류: " + totalErrors;
    log("\n=============================");
    log(summary);
    log("=============================");
    slog("done", "자동화 완료", "변경 " + totalUpdated + "건 / 스킵 " + totalSkipped + "건 / 오류 " + totalErrors + "건");
    tg("📊 <b>자동화 완료</b>\n✅ 변경: " + totalUpdated + "\n⏭ 스킵: " + totalSkipped + "\n❌ 오류: " + totalErrors +
       "\n모드: " + (testMode ? "테스트" : "실전"));

  } catch (e) {
    log("❌ 치명적 오류: " + e.message);
    tg("🚨 치명적 오류: " + e.message);
  }
  state.running = false;
}

// =============================================
// 상세보기 → 가격 파싱
// =============================================
async function clickDetailAndParse(catalogTabId, channelProductNo) {
  let priceTabId = null;
  try {
    const clickResult = await sendMessageToTab(catalogTabId, { action: "CLICK_VIEW_BUTTON", channelProductNo });
    if (!clickResult || !clickResult.success) return { success: false, sellers: [], error: clickResult?.error || "클릭 실패" };

    const rowIndex = clickResult.rowIndex;

    await chrome.scripting.executeScript({
      target: { tabId: catalogTabId }, world: "MAIN",
      func: function() {
        window.__pkstroy_captured_url = null;
        window.__pkstroy_original_open = window.open;
        window.open = function(url) { window.__pkstroy_captured_url = url; return { close(){}, focus(){} }; };
      }
    });

    await chrome.scripting.executeScript({
      target: { tabId: catalogTabId }, world: "MAIN",
      func: function(idx) {
        var r = document.querySelector('.ag-center-cols-container .ag-row[row-index="'+idx+'"]');
        if (!r) return;
        var c = r.querySelector('[col-id="rankDetailView"]');
        var b = c ? c.querySelector("button") : null;
        if (!b) { var bs = r.querySelectorAll("button"); for(var i=0;i<bs.length;i++) if(bs[i].textContent.trim()==="상세보기"){b=bs[i];break;} }
        if (b) b.click();
      },
      args: [rowIndex]
    });

    await sleep(1000);

    const urlResults = await chrome.scripting.executeScript({
      target: { tabId: catalogTabId }, world: "MAIN",
      func: function() {
        var u = window.__pkstroy_captured_url;
        window.open = window.__pkstroy_original_open;
        delete window.__pkstroy_captured_url;
        delete window.__pkstroy_original_open;
        return u;
      }
    });

    const capturedUrl = urlResults?.[0]?.result;
    if (capturedUrl) {
      log("  🔗 " + capturedUrl.substring(0, 70));
      const t = await chrome.tabs.create({ url: capturedUrl, active: false });
      priceTabId = t.id;
    } else {
      const tabs = await chrome.tabs.query({ url: "https://search.shopping.naver.com/*" });
      if (tabs.length > 0) priceTabId = tabs[tabs.length - 1].id;
    }

    if (!priceTabId) return { success: false, sellers: [], error: "URL 없음" };

    await waitForTabLoad(priceTabId, CFG.TAB_LOAD_TIMEOUT);
    await sleep(2000);
    try { await chrome.scripting.executeScript({ target: { tabId: priceTabId }, files: ["content_price.js"] }); } catch(e) {}
    await sleep(500);

    const result = await sendMessageToTab(priceTabId, { action: "PARSE_PRICES" });
    await chrome.tabs.remove(priceTabId).catch(() => {});
    return result || { success: false, sellers: [] };

  } catch (e) {
    if (priceTabId) await chrome.tabs.remove(priceTabId).catch(() => {});
    // monkey-patch 복원 (에러 시에도)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: catalogTabId }, world: "MAIN",
        func: function() {
          if (window.__pkstroy_original_open) {
            window.open = window.__pkstroy_original_open;
            delete window.__pkstroy_captured_url;
            delete window.__pkstroy_original_open;
          }
        }
      });
    } catch (_) {}
    return { success: false, sellers: [], error: e.message };
  }
}

// =============================================
// Commerce API
// =============================================
async function ensureToken() {
  if (state.token && Date.now() < state.tokenExpiry - 300000) return true;
  try {
    const ts = Date.now();
    const hashed = bcrypt.hashSync(CFG.CLIENT_ID + "_" + ts, CFG.CLIENT_SECRET);
    const res = await fetch("https://api.commerce.naver.com/external/v1/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CFG.CLIENT_ID, timestamp: ts.toString(), client_secret_sign: btoa(hashed), grant_type: "client_credentials", type: "SELF" }),
    });
    if (!res.ok) return false;
    const d = await res.json();
    state.token = d.access_token;
    state.tokenExpiry = Date.now() + (d.expires_in || 14400) * 1000;
    return true;
  } catch (e) { return false; }
}

async function getProductInfo(channelProductNo) {
  try {
    const res = await fetch("https://api.commerce.naver.com/external/v2/products/channel-products/" + channelProductNo,
      { headers: { "Authorization": "Bearer " + state.token } });
    if (!res.ok) return { success: false, error: "조회 실패 (" + res.status + ")" };
    const data = await res.json();
    const salePrice = data.originProduct?.salePrice || 0;
    let deliveryFee = 0;
    const di = data.originProduct?.deliveryInfo;
    if (di) {
      const ft = di.deliveryFeeType || "";
      if (ft === "FREE") deliveryFee = 0;
      else deliveryFee = di.baseFee || 0;
      if (typeof deliveryFee !== "number") deliveryFee = 0;
    }
    return { success: true, salePrice, deliveryFee, rawData: data };
  } catch (e) { return { success: false, error: e.message }; }
}

async function updateProductPrice(channelProductNo, newPrice, existingData) {
  try {
    let data = existingData;
    if (!data) {
      const r = await fetch("https://api.commerce.naver.com/external/v2/products/channel-products/" + channelProductNo,
        { headers: { "Authorization": "Bearer " + state.token } });
      if (!r.ok) return { success: false, error: "조회 실패" };
      data = await r.json();
    }
    if (data.originProduct) data.originProduct.salePrice = newPrice;
    const r2 = await fetch("https://api.commerce.naver.com/external/v2/products/channel-products/" + channelProductNo,
      { method: "PUT", headers: { "Authorization": "Bearer " + state.token, "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!r2.ok) { const e = await r2.text(); return { success: false, error: e.substring(0, 150) }; }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

// =============================================
// 유틸
// =============================================
function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error("타임아웃")); }, timeout);
    function fn(id, info) { if (id === tabId && info.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(fn); resolve(); } }
    chrome.tabs.onUpdated.addListener(fn);
  });
}
function sendMessageToTab(tabId, msg) {
  return new Promise(r => chrome.tabs.sendMessage(tabId, msg, res => { if (chrome.runtime.lastError) r(null); else r(res); }));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) {
  const t = new Date().toLocaleTimeString("ko-KR");
  const e = "[" + t + "] " + msg;
  console.log(e);
  chrome.runtime.sendMessage({ action: "LOG", message: e, time: t }).catch(() => {});
  chrome.storage.local.get("logs", d => { const l = d.logs || []; l.push(e); if (l.length > 200) l.splice(0, l.length - 200); chrome.storage.local.set({ logs: l }); });
}
// 심플 로그 (일반인용 카드)
function slog(type, title, desc) {
  const t = new Date().toLocaleTimeString("ko-KR", {hour:'2-digit',minute:'2-digit'});
  chrome.runtime.sendMessage({ action: "SLOG", type, title, desc, time: t }).catch(() => {});
  chrome.storage.local.get("slogs", d => { const l = d.slogs || []; l.push({type,title,desc,time:t}); if(l.length>50) l.splice(0,l.length-50); chrome.storage.local.set({slogs:l}); });
}
