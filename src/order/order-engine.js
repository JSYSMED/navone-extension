// =============================================
// NavOne Extension — 발주/송장 엔진 (Agent C)
// 컨텍스트 무관 classic script: Side Panel(sidepanel.html)과
// Service Worker(background.js, Agent F 스케줄러) 양쪽에서 동작.
//
// 전제: lib/bcrypt.js 가 먼저 로드되어 전역 `bcrypt` 사용 가능.
//   - Side Panel: <script src="lib/bcrypt.js"> 선행
//   - Service Worker: importScripts("lib/bcrypt.js") 선행 (background.js가 이미 로드)
//
// 커머스 API는 host_permissions(api.commerce.naver.com) 로 직접 호출.
//
// 노출 인터페이스 (AGENTS.md §8 표준):
//   self.orderConfirm.run(config) → { success, processed, errors }
// =============================================

(function (global) {
  "use strict";

  var COMMERCE = "https://api.commerce.naver.com";
  var PATHS = {
    token: "/external/v1/oauth2/token",
    lastChanged: "/external/v1/pay-order/seller/product-orders/last-changed-statuses",
    query: "/external/v1/pay-order/seller/product-orders/query",
    confirm: "/external/v1/pay-order/seller/product-orders/confirm",
    dispatch: "/external/v1/pay-order/seller/product-orders/dispatch",
  };

  // 배송사 코드 (네이버 커머스 표준). 전체 목록: GET .../seller/delivery-companies
  var DELIVERY_COMPANIES = {
    CJGLS: "CJ대한통운",
    HANJIN: "한진택배",
    LOTTE: "롯데택배",
    EPOST: "우체국택배",
    LOGEN: "로젠택배",
    KDEXP: "경동택배",
    CVSNET: "GS Postbox 편의점택배",
    HYUNDAI: "롯데글로벌(현대)",
    DAESIN: "대신택배",
    ILYANG: "일양로지스",
    CHUNIL: "천일택배",
    KGB: "KGB택배",
    DHL: "DHL",
    FEDEX: "FedEx",
    EMS: "우체국 EMS",
  };

  var RPS_DELAY_MS = 500;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 토큰 캐시 (clientId 단위)
  var _tokenCache = {}; // clientId -> { token, exp }

  function _config(config) {
    var c = config || {};
    // chrome.storage.local 의 config 형태(clientId/clientSecret) 호환
    return {
      clientId: c.clientId || c.CLIENT_ID || "",
      clientSecret: c.clientSecret || c.CLIENT_SECRET || "",
      tgToken: c.tgToken || c.TG_TOKEN || "",
      tgChatId: c.tgChatId || c.TG_CHAT_ID || "",
      autoConfirmOrders: c.autoConfirmOrders === true,
    };
  }

  async function getToken(cfg) {
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error("API 키(clientId/clientSecret)가 설정되지 않았습니다.");
    }
    var cached = _tokenCache[cfg.clientId];
    if (cached && Date.now() < cached.exp - 300000) return cached.token;

    var ts = Date.now();
    var hashed = bcrypt.hashSync(cfg.clientId + "_" + ts, cfg.clientSecret);
    var res = await fetch(COMMERCE + PATHS.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        timestamp: ts.toString(),
        client_secret_sign: btoa(hashed),
        grant_type: "client_credentials",
        type: "SELF",
      }),
    });
    if (!res.ok) {
      var t = await res.text();
      throw new Error("토큰 발급 실패 (" + res.status + ") " + t.substring(0, 120));
    }
    var d = await res.json();
    _tokenCache[cfg.clientId] = {
      token: d.access_token,
      exp: Date.now() + (d.expires_in || 10800) * 1000,
    };
    return d.access_token;
  }

  // 커머스 API 호출. 실패 시 status 달린 Error throw.
  async function api(cfg, path, opts) {
    opts = opts || {};
    var token = await getToken(cfg);
    var url = COMMERCE + path;
    if (opts.query) {
      var qs = new URLSearchParams();
      Object.keys(opts.query).forEach(function (k) {
        if (opts.query[k] != null) qs.append(k, opts.query[k]);
      });
      url += "?" + qs.toString();
    }
    var res = await fetch(url, {
      method: opts.method || "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var text = await res.text();
    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
    if (!res.ok) {
      var err = new Error((data && data.message) || ("커머스 API 오류 " + res.status));
      err.status = res.status;
      err.detail = data;
      throw err;
    }
    return data;
  }

  // 재시도 (4xx 비-429 는 즉시 throw)
  async function withRetry(fn, max) {
    max = max || 3;
    var lastErr;
    for (var attempt = 1; attempt <= max; attempt++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        var s = err && err.status;
        if (s && s >= 400 && s < 500 && s !== 429) throw err;
        if (attempt < max) await sleep(RPS_DELAY_MS * attempt);
      }
    }
    throw lastErr;
  }

  function normalize(d) {
    var po = d.productOrder || d;
    var order = d.order || {};
    return {
      productOrderId: po.productOrderId || d.productOrderId,
      orderId: order.orderId || po.orderId || null,
      productName: po.productName || "(상품명 없음)",
      productOrderStatus: po.productOrderStatus || null,
      buyerName: order.ordererName || po.ordererName || null,
      quantity: po.quantity != null ? po.quantity : null,
      totalAmount: po.totalPaymentAmount != null ? po.totalPaymentAmount : (order.totalPaymentAmount || null),
      orderedAt: order.orderDate || po.orderDate || null,
    };
  }

  // 미발주(PAY_WAITING) 주문 목록
  async function fetchPending(config, opts) {
    opts = opts || {};
    var cfg = _config(config);
    var from = opts.from || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    var changed = await api(cfg, PATHS.lastChanged, {
      query: { lastChangedFrom: from, lastChangedType: opts.type || "PAY_WAITING" },
    });
    var list = (changed && (
      (changed.data && changed.data.lastChangeStatuses) ||
      changed.lastChangeStatuses || changed.data)) || [];
    var seen = {};
    var ids = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      var id = c.productOrderId || c.productOrderID;
      if (id && !seen[id]) { seen[id] = 1; ids.push(id); }
    });
    if (!ids.length) return [];

    var details = [];
    for (var i = 0; i < ids.length; i += 300) {
      var chunk = ids.slice(i, i + 300);
      var res = await api(cfg, PATHS.query, { method: "POST", body: { productOrderIds: chunk } });
      var arr = (res && (res.data || res.productOrders)) || (Array.isArray(res) ? res : []);
      if (Array.isArray(arr)) details = details.concat(arr);
      if (i + 300 < ids.length) await sleep(RPS_DELAY_MS);
    }
    return details.map(normalize);
  }

  // 발주확인 (productOrderIds 일괄). 최대 3회 재시도.
  async function confirm(config, productOrderIds) {
    var cfg = _config(config);
    var ids = (productOrderIds || []).map(String).filter(Boolean);
    if (!ids.length) return { confirmed: 0, productOrderIds: [] };
    var result = await withRetry(function () {
      return api(cfg, PATHS.confirm, { method: "POST", body: { productOrderIds: ids } });
    });
    var ok = (result && ((result.data && result.data.successProductOrderIds) || result.successProductOrderIds)) || ids;
    return { confirmed: ok.length, productOrderIds: ok, raw: result };
  }

  // 송장 등록 (단건). 최대 3회 재시도.
  async function dispatch(config, item) {
    var cfg = _config(config);
    if (!item || !item.productOrderId || !item.deliveryCompanyCode || !item.trackingNumber) {
      throw new Error("productOrderId, deliveryCompanyCode, trackingNumber는 필수입니다.");
    }
    if (!DELIVERY_COMPANIES[item.deliveryCompanyCode]) {
      throw new Error("알 수 없는 배송사 코드: " + item.deliveryCompanyCode);
    }
    var body = {
      productOrderId: String(item.productOrderId),
      deliveryMethod: item.deliveryMethod || "DELIVERY",
      deliveryCompanyCode: item.deliveryCompanyCode,
      trackingNumber: String(item.trackingNumber),
      dispatchDate: item.dispatchDate || new Date().toISOString(),
    };
    return withRetry(function () {
      return api(cfg, PATHS.dispatch, { method: "POST", body: body });
    });
  }

  // 송장 일괄 등록. 순차 처리 + 각 건 사이 500ms (RPS 제한 준수).
  async function dispatchBulk(config, items) {
    items = Array.isArray(items) ? items : [];
    var succeeded = [];
    var failed = [];
    for (var i = 0; i < items.length; i++) {
      try {
        await dispatch(config, items[i]);
        succeeded.push({ productOrderId: items[i].productOrderId, trackingNumber: items[i].trackingNumber });
      } catch (err) {
        failed.push({ productOrderId: items[i] && items[i].productOrderId, error: err.message });
      }
      if (i < items.length - 1) await sleep(RPS_DELAY_MS);
    }
    return { total: items.length, succeededCount: succeeded.length, failedCount: failed.length, succeeded: succeeded, failed: failed };
  }

  async function tg(cfg, text) {
    if (!cfg.tgToken || !cfg.tgChatId) return false;
    try {
      await fetch("https://api.telegram.org/bot" + cfg.tgToken + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.tgChatId, text: text, parse_mode: "HTML" }),
      });
      return true;
    } catch (e) { return false; }
  }

  // ── Agent F 스케줄러 표준 인터페이스 ──
  // 매 주기: 미발주 감지 → Telegram 알림 → (설정 ON 시) 자동 발주확인
  async function run(config) {
    var cfg = _config(config);
    var errors = [];
    var processed = 0;
    try {
      var pending = await fetchPending(config, { type: "PAY_WAITING" });
      if (!pending.length) return { success: true, processed: 0, errors: [] };

      await tg(cfg,
        "🆕 <b>NavOne 신규 주문</b>\n미발주(발주대기): " + pending.length + "건\n" +
        (cfg.autoConfirmOrders ? "→ 자동 발주확인 실행" : "→ 자동확인 OFF (수동 확인 필요)"));

      if (cfg.autoConfirmOrders) {
        var ids = pending.map(function (o) { return o.productOrderId; }).filter(Boolean);
        var r = await confirm(config, ids);
        processed = r.confirmed;
        if (processed) {
          await tg(cfg, "✅ <b>발주확인 완료</b>\n확인: " + processed + "건");
        }
      }
      return { success: true, processed: processed, errors: errors };
    } catch (err) {
      errors.push(err.message);
      return { success: false, processed: processed, errors: errors };
    }
  }

  var OrderEngine = {
    DELIVERY_COMPANIES: DELIVERY_COMPANIES,
    RPS_DELAY_MS: RPS_DELAY_MS,
    fetchPending: fetchPending,
    confirm: confirm,
    dispatch: dispatch,
    dispatchBulk: dispatchBulk,
    run: run,
  };

  // 전역 노출 (Side Panel + Service Worker 양쪽)
  global.orderConfirm = OrderEngine;  // AGENTS.md handler 문자열: 'orderConfirm.run'
  global.OrderEngine = OrderEngine;
  if (typeof module !== "undefined" && module.exports) module.exports = OrderEngine;
})(typeof self !== "undefined" ? self : this);
