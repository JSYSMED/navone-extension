// =============================================
// NavOne 확장 — 클레임 자동처리 태스크 (Agent F 자동모드 연동)
// AGENTS.md §8 표준 run() 인터페이스.
//   service worker: importScripts("src/claim/claim-api.js", "src/claim/claimProcess.js")
//   → claimProcess.run(config) 호출
//
// 반환: { success: boolean, processed: number, errors: string[] }
// =============================================

(function (root) {
  const claimProcess = {
    /**
     * @param {Object} config - chrome.storage.local.config (licenseKey 필수)
     * @returns {Promise<{ success: boolean, processed: number, errors: string[] }>}
     */
    async run(config) {
      if (!config || !config.licenseKey) {
        return { success: false, processed: 0, errors: ["licenseKey 미설정"] };
      }
      const api = root.NavOneClaimAPI;
      if (!api) {
        return { success: false, processed: 0, errors: ["NavOneClaimAPI 미로드 (claim-api.js 먼저 로드)"] };
      }
      try {
        const out = await api.autoProcess(config, {});
        return {
          success: out.errors.length === 0,
          processed: out.processed || 0,
          errors: out.errors || [],
        };
      } catch (e) {
        return { success: false, processed: 0, errors: [e.message] };
      }
    },
  };

  root.claimProcess = claimProcess;
  if (typeof module !== "undefined" && module.exports) module.exports = claimProcess;
})(typeof self !== "undefined" ? self : globalThis);
