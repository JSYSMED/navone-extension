// =============================================
// background.js v2 — Side Panel + 구조화 로그
// =============================================

importScripts("lib/bcrypt.js");

let CFG = {};
let state = { running: false, products: [], currentIndex: 0, results: [], token: null, tokenExpiry: 0 };

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
        MIN_MARGIN: c.margin || 20,
        MIN_PRICE: 1000,
        TG_TOKEN: c.tgToken || "",
        TG_CHAT_ID: c.tgChatId || "",
        TAB_LOAD_TIMEOUT: 10000,
        DELAY: 2000,
        PRICE_FLOOR: {},
      };
      r();
    });
  });
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
  return true;
});

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

          const competitors = priceData.sellers.filter(
            s => !CFG.MY_STORE_NAMES.some(name => s.sellerName.includes(name) || name.includes(s.sellerName))
          );
          if (competitors.length === 0) {
            log("  ✅ 경쟁사 없음");
            state.results.push({ ...product, status: "NO_COMPETITORS" });
            totalSkipped++;
            continue;
          }

          const lowest = competitors.reduce((min, s) => s.price < min.price ? s : min, competitors[0]);
          log("  🏷️ 경쟁 최저: " + lowest.sellerName + " " + lowest.price.toLocaleString() + "원");

          const myStore = priceData.sellers.find(
            s => CFG.MY_STORE_NAMES.some(name => s.sellerName.includes(name) || name.includes(s.sellerName))
          );
          const myPrice = myStore ? myStore.price : 0;

          if (myPrice > 0 && myPrice <= lowest.price) {
            log("  ✅ 이미 최저가");
            state.results.push({ ...product, status: "ALREADY_LOWEST" });
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

          const targetExposure = lowest.price - CFG.UNDERCUT;
          const targetPrice = targetExposure - ourDeliveryFee;

          if (targetPrice <= 0) {
            log("  ⚠️ 배송비 차감 후 0 이하 → 건너뜀");
            state.results.push({ ...product, status: "PRICE_TOO_LOW" });
            totalSkipped++;
            continue;
          }

          const floor = Math.max(
            ourCurrentSalePrice > 0 ? Math.floor(ourCurrentSalePrice * (1 - CFG.MIN_MARGIN / 100)) : CFG.MIN_PRICE,
            CFG.PRICE_FLOOR[product.channelProductNo] || CFG.MIN_PRICE
          );
          const finalPrice = Math.max(targetPrice, floor);
          log("  🎯 노출: " + targetExposure.toLocaleString() + " = 판매가 " + finalPrice.toLocaleString() + " + 배송비 " + ourDeliveryFee.toLocaleString());

          if (ourCurrentSalePrice > 0 && finalPrice === ourCurrentSalePrice) {
            log("  ✅ 가격 동일 → 건너뜀");
            state.results.push({ ...product, status: "SAME_PRICE" });
            totalSkipped++;
            continue;
          }

          if (testMode) {
            log("  🧪 [테스트] " + ourCurrentSalePrice + " → " + finalPrice + " (노출: " + (finalPrice + ourDeliveryFee) + ")");
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
                 "노출가: " + (finalPrice + ourDeliveryFee).toLocaleString() + "원 (경쟁: " + lowest.price.toLocaleString() + ")");
              state.results.push({ ...product, status: "UPDATED", from: ourCurrentSalePrice, to: finalPrice });
              totalUpdated++;
            } else {
              log("  ❌ API: " + result.error);
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
