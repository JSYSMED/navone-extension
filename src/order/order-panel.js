// =============================================
// NavOne Extension — 발주 탭 UI 컨트롤러 (Agent C)
// Side Panel 에 "발주" 탭을 주입(nav + page)하고, 미발주 목록 / 자동확인 토글 /
// 송장 입력(단건·일괄)을 orderConfirm 엔진(order-engine.js)으로 처리.
//
// 충돌 최소화: sidepanel.html 마크업을 직접 수정하지 않고 DOM 을 런타임 주입.
// 의존: order-engine.js (전역 orderConfirm), lib/bcrypt.js, chrome.storage.local.config
// =============================================

(function () {
  "use strict";

  if (typeof document === "undefined") return; // Service Worker에선 무시
  if (window.__navoneOrderPanelInit) return;
  window.__navoneOrderPanelInit = true;

  var state = { config: {}, orders: [] };

  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function won(n) { return n == null ? "-" : Number(n).toLocaleString("ko-KR") + "원"; }

  function loadConfig() {
    return new Promise(function (r) {
      chrome.storage.local.get("config", function (d) { state.config = d.config || {}; r(state.config); });
    });
  }
  function saveConfigPatch(patch) {
    return new Promise(function (r) {
      chrome.storage.local.get("config", function (d) {
        var c = d.config || {};
        Object.assign(c, patch);
        state.config = c;
        chrome.storage.local.set({ config: c }, r);
      });
    });
  }

  // ── DOM 주입 ──
  function injectStyles() {
    var css = [
      "#page-order .od-controls{display:flex;flex-direction:column;gap:10px;padding:12px 0}",
      "#page-order .od-row{display:flex;align-items:center;gap:8px}",
      "#page-order .od-btn{flex:1;padding:9px;border:none;border-radius:8px;background:var(--nv,#03c75a);color:#fff;font-weight:600;cursor:pointer;font-size:13px}",
      "#page-order .od-btn.sec{background:var(--bg3,#2a2d35);color:var(--tx,#e6e6e6)}",
      "#page-order .od-btn:disabled{opacity:.5;cursor:default}",
      "#page-order .od-toggle{display:inline-block;width:38px;height:22px;border-radius:11px;background:var(--bg3,#3a3d45);position:relative;cursor:pointer;border:none;flex:none}",
      "#page-order .od-toggle.on{background:var(--nv,#03c75a)}",
      "#page-order .od-toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s}",
      "#page-order .od-toggle.on::after{transform:translateX(16px)}",
      "#page-order .od-stats{display:flex;gap:8px}",
      "#page-order .od-stat{flex:1;background:var(--bg2,#1d2027);border-radius:8px;padding:8px;text-align:center}",
      "#page-order .od-stat .v{font-size:18px;font-weight:700}",
      "#page-order .od-stat .l{font-size:11px;color:var(--tx3,#8a8f99)}",
      "#page-order .od-card{background:var(--bg2,#1d2027);border-radius:10px;padding:10px;margin-bottom:8px}",
      "#page-order .od-card.done{opacity:.5}",
      "#page-order .od-card .nm{font-weight:600;font-size:13px;margin-bottom:2px}",
      "#page-order .od-card .meta{font-size:11px;color:var(--tx3,#8a8f99);margin-bottom:6px}",
      "#page-order .od-card .ship{display:flex;gap:6px}",
      "#page-order .od-card select,#page-order .od-card input{padding:6px;border-radius:6px;border:1px solid var(--bg3,#33363d);background:var(--bg,#14161b);color:var(--tx,#e6e6e6);font-size:12px}",
      "#page-order .od-card select{flex:none;width:96px}",
      "#page-order .od-card input{flex:1;min-width:0}",
      "#page-order .od-card .send{flex:none;padding:6px 10px;border:none;border-radius:6px;background:var(--nv,#03c75a);color:#fff;font-size:12px;cursor:pointer}",
      "#page-order .od-card .cb{margin-right:6px}",
      "#page-order .od-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}",
      "#page-order .od-empty{text-align:center;color:var(--tx3,#8a8f99);padding:30px 10px;font-size:13px}",
    ].join("\n");
    var st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildSelect(selected) {
    var dc = window.orderConfirm.DELIVERY_COMPANIES;
    var opts = ['<option value="">배송사</option>'];
    Object.keys(dc).forEach(function (code) {
      opts.push('<option value="' + code + '"' + (code === selected ? " selected" : "") + ">" + esc(dc[code]) + "</option>");
    });
    return opts.join("");
  }

  function injectDom() {
    // nav 아이템 (택배 트럭 아이콘) — nav-spacer 앞에 삽입
    var nav = document.querySelector(".nav");
    if (nav && !nav.querySelector('[data-page="order"]')) {
      var item = document.createElement("div");
      item.className = "nav-item";
      item.setAttribute("data-page", "order");
      item.setAttribute("title", "발주/송장");
      item.innerHTML = '<span class="nav-dot"></span>' +
        '<svg viewBox="0 0 24 24"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>';
      var spacer = nav.querySelector(".nav-spacer");
      if (spacer) nav.insertBefore(item, spacer); else nav.appendChild(item);
      item.addEventListener("click", function () { showOrderPage(item); });
    }

    // page 컨테이너
    var main = document.querySelector(".main");
    if (main && !document.getElementById("page-order")) {
      var page = document.createElement("div");
      page.className = "page";
      page.id = "page-order";
      page.innerHTML =
        '<div class="od-controls">' +
          '<div class="od-row">' +
            '<button class="od-btn" id="odRefresh">미발주 새로고침</button>' +
          '</div>' +
          '<div class="od-row">' +
            '<button class="od-toggle" id="odAutoToggle"></button>' +
            '<span style="font-size:12px">신규 주문 자동 발주확인</span>' +
          '</div>' +
          '<div class="od-stats">' +
            '<div class="od-stat"><div class="v" id="odCntPending">0</div><div class="l">미발주</div></div>' +
            '<div class="od-stat"><div class="v" id="odCntSel">0</div><div class="l">선택</div></div>' +
          '</div>' +
          '<div class="od-row">' +
            '<button class="od-btn" id="odConfirmSel">선택 발주확인</button>' +
            '<button class="od-btn sec" id="odDispatchSel">선택 송장 일괄등록</button>' +
          '</div>' +
        '</div>' +
        '<div id="odList"><div class="od-empty">새로고침을 눌러 미발주 주문을 불러오세요.</div></div>';
      main.appendChild(page);
    }
  }

  // ── 페이지 전환 (sidepanel.js switchPage 와 동일 동작) ──
  function showOrderPage(navEl) {
    document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
    document.querySelectorAll(".nav-item").forEach(function (n) { n.classList.remove("active"); });
    document.getElementById("page-order").classList.add("active");
    navEl.classList.add("active");
  }

  function updateSelCount() {
    var n = document.querySelectorAll("#odList .cb:checked").length;
    document.getElementById("odCntSel").textContent = n;
  }

  function checkedOrderIds() {
    return Array.prototype.map.call(
      document.querySelectorAll("#odList .cb:checked"),
      function (cb) { return cb.getAttribute("data-poid"); }
    );
  }

  function renderOrders(orders) {
    state.orders = orders || [];
    document.getElementById("odCntPending").textContent = state.orders.length;
    document.getElementById("odCntSel").textContent = 0;
    var list = document.getElementById("odList");
    if (!state.orders.length) {
      list.innerHTML = '<div class="od-empty">미발주 주문이 없습니다. 🎉</div>';
      return;
    }
    list.innerHTML = "";
    state.orders.forEach(function (o) {
      var card = document.createElement("div");
      card.className = "od-card";
      card.setAttribute("data-poid", o.productOrderId);
      card.innerHTML =
        '<div class="od-head">' +
          '<input type="checkbox" class="cb" data-poid="' + esc(o.productOrderId) + '">' +
          '<span class="nm">' + esc(o.productName) + '</span>' +
        '</div>' +
        '<div class="meta">' +
          esc(o.buyerName || "") + (o.quantity ? " · " + o.quantity + "개" : "") +
          " · " + won(o.totalAmount) + " · #" + esc(o.productOrderId) +
        '</div>' +
        '<div class="ship">' +
          '<select class="od-company">' + buildSelect("") + '</select>' +
          '<input class="od-tracking" type="text" inputmode="numeric" placeholder="송장번호">' +
          '<button class="send">송장등록</button>' +
        '</div>';

      card.querySelector(".cb").addEventListener("change", updateSelCount);
      card.querySelector(".send").addEventListener("click", function () {
        dispatchSingle(o.productOrderId, card);
      });
      list.appendChild(card);
    });
  }

  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) { btn._t = btn.textContent; btn.disabled = true; btn.textContent = busyText || "처리 중…"; }
    else { btn.disabled = false; if (btn._t) btn.textContent = btn._t; }
  }

  function hasCreds() {
    if (!state.config.clientId || !state.config.clientSecret) {
      alert("설정 탭에서 Commerce API 키를 먼저 입력하세요.");
      return false;
    }
    return true;
  }

  // ── 액션 ──
  async function refresh() {
    if (!hasCreds()) return;
    var btn = document.getElementById("odRefresh");
    setBusy(btn, true, "불러오는 중…");
    try {
      var orders = await window.orderConfirm.fetchPending(state.config, { type: "PAY_WAITING" });
      renderOrders(orders);
    } catch (e) {
      document.getElementById("odList").innerHTML =
        '<div class="od-empty">조회 실패: ' + esc(e.message) + "</div>";
    } finally { setBusy(btn, false); }
  }

  async function confirmSelected() {
    if (!hasCreds()) return;
    var ids = checkedOrderIds();
    if (!ids.length) { alert("발주확인할 주문을 선택하세요."); return; }
    var btn = document.getElementById("odConfirmSel");
    setBusy(btn, true, "확인 중…");
    try {
      var r = await window.orderConfirm.confirm(state.config, ids);
      alert(r.confirmed + "건 발주확인 완료");
      await refresh();
    } catch (e) { alert("발주확인 실패: " + e.message); }
    finally { setBusy(btn, false); }
  }

  function collectShipItems(onlyChecked) {
    var items = [];
    document.querySelectorAll("#odList .od-card").forEach(function (card) {
      var cb = card.querySelector(".cb");
      if (onlyChecked && !cb.checked) return;
      var company = card.querySelector(".od-company").value;
      var tracking = card.querySelector(".od-tracking").value.trim();
      if (company && tracking) {
        items.push({
          productOrderId: card.getAttribute("data-poid"),
          deliveryCompanyCode: company,
          trackingNumber: tracking,
          _card: card,
        });
      }
    });
    return items;
  }

  async function dispatchSingle(poid, card) {
    if (!hasCreds()) return;
    var company = card.querySelector(".od-company").value;
    var tracking = card.querySelector(".od-tracking").value.trim();
    if (!company || !tracking) { alert("배송사와 송장번호를 입력하세요."); return; }
    var btn = card.querySelector(".send");
    setBusy(btn, true, "등록…");
    try {
      await window.orderConfirm.dispatch(state.config, {
        productOrderId: poid, deliveryCompanyCode: company, trackingNumber: tracking,
      });
      card.classList.add("done");
      card.querySelector(".cb").checked = false;
      updateSelCount();
    } catch (e) { alert("송장 등록 실패: " + e.message); setBusy(btn, false); }
  }

  async function dispatchSelected() {
    if (!hasCreds()) return;
    var items = collectShipItems(true);
    if (!items.length) { alert("선택한 주문에 배송사/송장번호를 입력하세요."); return; }
    var btn = document.getElementById("odDispatchSel");
    setBusy(btn, true, "일괄 등록 중…");
    try {
      var r = await window.orderConfirm.dispatchBulk(
        state.config,
        items.map(function (it) { return { productOrderId: it.productOrderId, deliveryCompanyCode: it.deliveryCompanyCode, trackingNumber: it.trackingNumber }; })
      );
      // 성공 건 카드 done 표시
      var okSet = {};
      r.succeeded.forEach(function (s) { okSet[s.productOrderId] = 1; });
      items.forEach(function (it) {
        if (okSet[it.productOrderId]) { it._card.classList.add("done"); it._card.querySelector(".cb").checked = false; }
      });
      updateSelCount();
      alert("송장 일괄등록 — 성공 " + r.succeededCount + "건 / 실패 " + r.failedCount + "건");
    } catch (e) { alert("일괄 등록 실패: " + e.message); }
    finally { setBusy(btn, false); }
  }

  function wire() {
    document.getElementById("odRefresh").addEventListener("click", refresh);
    document.getElementById("odConfirmSel").addEventListener("click", confirmSelected);
    document.getElementById("odDispatchSel").addEventListener("click", dispatchSelected);
    var toggle = document.getElementById("odAutoToggle");
    toggle.classList.toggle("on", state.config.autoConfirmOrders === true);
    toggle.addEventListener("click", function () {
      var on = !toggle.classList.contains("on");
      toggle.classList.toggle("on", on);
      saveConfigPatch({ autoConfirmOrders: on });
    });
  }

  function init() {
    if (!window.orderConfirm) { console.error("[order-panel] order-engine.js 미로드"); return; }
    injectStyles();
    injectDom();
    loadConfig().then(wire);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
