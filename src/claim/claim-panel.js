// =============================================
// NavOne 확장 — 클레임 탭 Side Panel UI (Agent B)
// 자립형 모듈: 주어진 컨테이너에 렌더링. sidepanel.js 를 직접 수정하지 않음.
//   사용법(README 참고):
//     <script src="src/claim/claim-api.js"></script>
//     <script src="src/claim/claim-panel.js"></script>
//     NavOneClaimPanel.mount(document.getElementById("claim-tab"), config);
// =============================================

(function (root) {
  const CATEGORY_KO = {
    simple_return: "단순변심", defect: "상품하자", delivery: "배송문제", other: "기타", null: "미분류",
  };
  const TYPE_KO = { RETURN: "반품", CANCEL: "취소", EXCHANGE: "교환" };

  let CSS_INJECTED = false;
  function injectCss() {
    if (CSS_INJECTED) return;
    CSS_INJECTED = true;
    const style = document.createElement("style");
    style.textContent = `
      .no-claim-bar { display:flex; gap:8px; align-items:center; margin-bottom:10px; }
      .no-claim-bar button { padding:6px 12px; border:0; border-radius:6px; cursor:pointer; font-size:13px; }
      .no-claim-refresh { background:#eef; }
      .no-claim-auto { background:#2b6; color:#fff; font-weight:600; }
      .no-claim-auto:disabled { background:#9c9; cursor:default; }
      .no-claim-status { font-size:12px; color:#666; margin-left:auto; }
      .no-claim-card { border:1px solid #e2e2e2; border-radius:8px; padding:10px; margin-bottom:8px; font-size:13px; }
      .no-claim-card .head { display:flex; justify-content:space-between; gap:8px; }
      .no-claim-card .name { font-weight:600; }
      .no-claim-card .reason { color:#555; margin:6px 0; white-space:pre-wrap; }
      .no-claim-meta { font-size:12px; color:#777; }
      .no-claim-actions { display:flex; gap:6px; margin-top:8px; }
      .no-claim-actions button { flex:1; padding:6px; border:0; border-radius:6px; cursor:pointer; font-size:12px; }
      .no-claim-approve { background:#2b6; color:#fff; }
      .no-claim-reject { background:#e55; color:#fff; }
      .no-tag { display:inline-block; padding:1px 6px; border-radius:4px; background:#f0f0f0; font-size:11px; margin-right:4px; }
      .no-tag.done { background:#d6f5d6; }
      .no-claim-empty { color:#888; text-align:center; padding:24px 0; }
    `;
    document.head.appendChild(style);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function mount(container, config) {
    injectCss();
    if (!config || !config.licenseKey) {
      container.innerHTML = `<div class="no-claim-empty">라이선스 키 설정 후 이용 가능합니다.</div>`;
      return;
    }
    const api = root.NavOneClaimAPI;

    container.innerHTML = `
      <div class="no-claim-bar">
        <button class="no-claim-refresh">새로고침</button>
        <button class="no-claim-auto">전체 자동처리</button>
        <span class="no-claim-status"></span>
      </div>
      <div class="no-claim-list"></div>`;

    const statusEl = container.querySelector(".no-claim-status");
    const listEl = container.querySelector(".no-claim-list");
    const autoBtn = container.querySelector(".no-claim-auto");

    function setStatus(msg) { statusEl.textContent = msg || ""; }

    async function refresh() {
      setStatus("불러오는 중…");
      try {
        const data = await api.getPending(config, { days: 7 });
        renderList(data.claims || []);
        setStatus(`${data.storeName || ""} · 미처리 ${(data.pending || []).length}건`);
      } catch (e) {
        listEl.innerHTML = `<div class="no-claim-empty">조회 실패: ${esc(e.message)}</div>`;
        setStatus("");
      }
    }

    function renderList(claims) {
      if (!claims.length) {
        listEl.innerHTML = `<div class="no-claim-empty">미처리 클레임이 없습니다.</div>`;
        return;
      }
      listEl.innerHTML = claims.map(renderCard).join("");
      listEl.querySelectorAll("[data-decide]").forEach((btn) => {
        btn.addEventListener("click", () => decide(btn));
      });
    }

    function renderCard(c) {
      const cat = CATEGORY_KO[c.category] || CATEGORY_KO.null;
      const type = TYPE_KO[c.claimType] || c.claimType || "-";
      const doneTag = c.processed
        ? `<span class="no-tag done">${esc(c.decision || "처리됨")} (${esc(c.decidedBy || "")})</span>` : "";
      const actions = (!c.processed && (c.claimType === "RETURN" || c.claimType === "CANCEL"))
        ? `<div class="no-claim-actions">
             <button class="no-claim-approve" data-decide="approve" data-id="${esc(c.productOrderId)}" data-type="${esc(c.claimType)}">승인</button>
             <button class="no-claim-reject" data-decide="reject" data-id="${esc(c.productOrderId)}" data-type="${esc(c.claimType)}">거부</button>
           </div>` : "";
      return `
        <div class="no-claim-card">
          <div class="head">
            <span class="name">${esc(c.productName)}</span>
            <span class="no-claim-meta">${Number(c.amount || 0).toLocaleString()}원</span>
          </div>
          <div class="no-claim-meta"><span class="no-tag">${esc(type)}</span><span class="no-tag">${esc(cat)}</span>${doneTag}</div>
          <div class="reason">${esc(c.claimReason || "(사유 없음)")}</div>
          ${actions}
        </div>`;
    }

    async function decide(btn) {
      const productOrderId = btn.dataset.id;
      const claimType = btn.dataset.type;
      const decision = btn.dataset.decide;
      btn.disabled = true;
      setStatus(decision === "approve" ? "승인 처리 중…" : "거부 처리 중…");
      try {
        await api.manualDecide(config, { productOrderId, claimType, decision });
        await refresh();
      } catch (e) {
        setStatus("실패: " + e.message);
        btn.disabled = false;
      }
    }

    autoBtn.addEventListener("click", async () => {
      autoBtn.disabled = true;
      setStatus("AI 자동처리 실행 중…");
      try {
        const out = await api.autoProcess(config, { days: 7 });
        setStatus(`자동처리 ${out.processed}건 (승인 ${out.approved}, 보류 ${out.held})`);
        await refresh();
      } catch (e) {
        setStatus("자동처리 실패: " + e.message);
      } finally {
        autoBtn.disabled = false;
      }
    });

    container.querySelector(".no-claim-refresh").addEventListener("click", refresh);
    refresh();
  }

  root.NavOneClaimPanel = { mount };
})(typeof self !== "undefined" ? self : globalThis);
