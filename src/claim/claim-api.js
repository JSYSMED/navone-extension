// =============================================
// NavOne 확장 — 클레임 서버 API 래퍼 (Agent B)
// navone-server 의 /api/claim/* 엔드포인트를 호출.
// 빌드/번들 없음: 전역 NavOneClaimAPI 로 노출 (sidepanel + service worker 공용).
// =============================================

(function (root) {
  const DEFAULT_SERVER = "https://navone-server.vercel.app";

  // config.serverBase 로 override 가능(개발용). 미설정 시 운영 서버.
  function base(config) {
    return (config && config.serverBase) || DEFAULT_SERVER;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `서버 오류 ${res.status}`);
    return data;
  }

  // 미처리 클레임 목록 조회. { storeName, count, pending, claims } 반환.
  async function getPending(config, { days = 1, since } = {}) {
    const qs = new URLSearchParams({ licenseKey: config.licenseKey });
    if (since) qs.set("since", since);
    else qs.set("days", String(days));
    const res = await fetch(`${base(config)}/api/claim/pending?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `서버 오류 ${res.status}`);
    return data.data;
  }

  // AI 분류 + 자동처리 실행. { processed, approved, held, errors, results } 반환.
  async function autoProcess(config, opts = {}) {
    const data = await postJson(`${base(config)}/api/claim/auto-process`, {
      licenseKey: config.licenseKey,
      ...opts,
    });
    return data.data;
  }

  // 셀러 수동 승인/거부. decision: "approve" | "reject".
  async function manualDecide(config, { productOrderId, claimType, decision }) {
    const data = await postJson(`${base(config)}/api/claim/manual-decide`, {
      licenseKey: config.licenseKey,
      productOrderId,
      claimType,
      decision,
    });
    return data.data;
  }

  root.NavOneClaimAPI = { getPending, autoProcess, manualDecide, DEFAULT_SERVER };
})(typeof self !== "undefined" ? self : globalThis);
