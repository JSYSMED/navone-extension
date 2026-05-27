// =============================================
// content_cs.js
// 문의관리 페이지(sell.smartstore.naver.com/#/comment/) DOM 파싱 + 답변 입력
//
// ⚠️ 1순위 경로는 커머스 API(/api/inquiry/*)다 — background.js의 scanInquiries/
//    submitInquiryAnswer가 서버를 통해 커머스 API로 처리한다.
//    이 파일은 커머스 API 키가 없거나 API가 불가할 때를 위한 DOM 폴백이다.
//    background.js에서 chrome.scripting.executeScript로 필요할 때만 주입한다.
//
// 리스트 구조: AG-Grid가 아닌 AngularJS ng-repeat 리스트.
//   각 문의 = li[ng-repeat="comment in ::vm.commentList"]
// =============================================

(function () {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "PARSE_INQUIRIES") {
      sendResponse(parseInquiries());
    } else if (msg.action === "OPEN_CS_REPLY") {
      openCsReply(msg.index).then(sendResponse);
      return true;
    } else if (msg.action === "WRITE_CS_REPLY") {
      writeCsReply(msg.index, msg.replyText, true).then(sendResponse);
      return true;
    } else if (msg.action === "WRITE_CS_DRAFT") {
      writeCsReply(msg.index, msg.replyText, false).then(sendResponse);
      return true;
    }
    return true;
  });

  function inquiryItems() {
    // ng-repeat 셀렉터가 깨질 수 있어 폭넓게: comment 관련 li
    let items = document.querySelectorAll('li[ng-repeat*="commentList"], li[ng-repeat*="comment in"]');
    if (!items.length) {
      // fallback: 문의 내용 영역(p.text-area)을 가진 li
      items = document.querySelectorAll("li:has(p.text-area)");
    }
    return Array.from(items);
  }

  // =============================================
  // PARSE_INQUIRIES — 미답변 문의 목록 추출
  // =============================================
  function parseInquiries() {
    const items = inquiryItems();
    const inquiries = [];

    items.forEach((li, index) => {
      // 답변 상태
      const labelEl = li.querySelector(".title-area .label, .label-outline, .label");
      const labelText = labelEl ? labelEl.textContent.trim() : "";
      const hasReply = labelText.includes("답변완료") ||
        (labelEl && labelEl.className.includes("label-default")) ||
        li.querySelector(".seller-reply-list li") != null;

      // 상품명
      const nameEl = li.querySelector(".title-area a strong") || li.querySelector(".title-area strong");
      const productName = nameEl ? nameEl.textContent.trim() : "";

      // 상품번호 / 스토어명 / 날짜 — partition-area 텍스트에서 추출
      const partition = li.querySelector(".partition-area");
      const partText = partition ? partition.textContent : "";
      let productNo = "";
      const noMatch = partText.match(/상품번호\s*:?\s*(\d{6,})/);
      if (noMatch) productNo = noMatch[1];

      let storeName = "";
      const storeLabel = li.querySelector(".partition-area .label.storefarm, .label.storefarm");
      if (storeLabel && storeLabel.nextSibling) {
        storeName = (storeLabel.nextSibling.textContent || "").trim();
      }

      let date = "";
      if (partition) {
        const spans = partition.querySelectorAll("span");
        if (spans.length) date = spans[spans.length - 1].textContent.trim();
      }
      if (!date) {
        const dm = partText.match(/(\d{4}\.\d{2}\.\d{2}[.\s]*\d{0,2}:?\d{0,2})/);
        if (dm) date = dm[1].trim();
      }

      // 작성자
      const writerEl = li.querySelector('a.text-info[ng-click*="confirmOrder"], a.text-info');
      const writerId = writerEl ? writerEl.textContent.trim() : "";

      // 문의 내용
      const contentEl = li.querySelector("p.text-area");
      const content = contentEl ? contentEl.textContent.trim() : "";

      // 비밀글
      const isSecret = li.querySelector("i.fn-secret1") != null;

      if (!content) return; // 내용 없으면 스킵

      inquiries.push({
        commentId: null,
        index,
        productName,
        productNo,
        content,
        writerId,
        date,
        hasReply,
        isSecret,
        storeName,
      });
    });

    // 미답변만 반환
    const unanswered = inquiries.filter(q => !q.hasReply);
    return { success: unanswered.length > 0, inquiries: unanswered, totalCount: inquiries.length };
  }

  // =============================================
  // OPEN_CS_REPLY — 해당 문의의 "답글" 버튼 클릭 → 답변 영역 토글
  // =============================================
  async function openCsReply(index) {
    const li = inquiryItems()[index];
    if (!li) return { success: false, error: "문의 항목 없음 (index " + index + ")" };

    li.scrollIntoView({ block: "center" });
    await sleep(150);

    // 이미 답글 영역이 열려 있으면 통과
    if (findReplyTextarea(li)) return { success: true };

    let btn = li.querySelector('.btn-area button[ng-click*="replyShowOnClick"]')
      || li.querySelector('.btn-area button.btn-default.btn-sm');
    // fallback: 텍스트에 "답글" 포함하는 버튼
    if (!btn) {
      const buttons = li.querySelectorAll("button");
      for (const b of buttons) {
        if (b.textContent.replace(/\s+/g, "").includes("답글")) { btn = b; break; }
      }
    }
    if (!btn) return { success: false, error: "답글 버튼 없음" };

    fireClick(btn);
    const ta = await waitFor(() => findReplyTextarea(li), 4000);
    return ta ? { success: true } : { success: false, error: "답변 입력 영역이 열리지 않음" };
  }

  // =============================================
  // WRITE_CS_REPLY / WRITE_CS_DRAFT — textarea 입력 (+ submit이면 등록)
  // =============================================
  async function writeCsReply(index, replyText, submit) {
    const text = (replyText || "").trim();
    if (text.length < 5) return { success: false, error: "답변은 최소 5자 이상" };

    const li = inquiryItems()[index];
    if (!li) return { success: false, error: "문의 항목 없음 (index " + index + ")" };

    let ta = findReplyTextarea(li);
    if (!ta) {
      const open = await openCsReply(index);
      if (!open.success) return open;
      ta = findReplyTextarea(li);
    }
    if (!ta) return { success: false, error: "답변 textarea 못 찾음" };

    ta.focus();
    setAngularValue(ta, text);
    await sleep(300);

    if (!submit) return { success: true }; // DRAFT

    const submitBtn = findSubmitButton(li, ta);
    if (!submitBtn) return { success: false, error: "등록 버튼 없음" };
    if (submitBtn.disabled) return { success: false, error: "등록 버튼 비활성 (입력 미반영 의심)" };

    fireClick(submitBtn);
    await sleep(500);
    return { success: true };
  }

  function findReplyTextarea(li) {
    const cands = li.querySelectorAll(".seller-write-group textarea, ncp-comment-reply textarea, textarea.form-control");
    for (const t of cands) {
      if (!isVisible(t)) continue;
      const ph = t.getAttribute("placeholder") || "";
      const ng = (t.getAttribute("ng-model") || "").toLowerCase();
      if (ph.includes("답글") || ng.includes("newcontents") || ng.includes("content")) return t;
    }
    for (const t of cands) if (isVisible(t)) return t;
    return null;
  }

  function findSubmitButton(li, ta) {
    const scope = ta.closest("ncp-comment-reply") || ta.closest(".seller-reply-section") || li;
    let btn = scope.querySelector('.input-group-btn button[progress-button*="save"]')
      || scope.querySelector('button[progress-button*="save"]')
      || scope.querySelector('.input-group-btn button.progress-button');
    if (btn) return btn;
    const buttons = scope.querySelectorAll("button");
    for (const b of buttons) {
      if (b.textContent.replace(/\s+/g, "").includes("등록")) return b;
    }
    return null;
  }

  // =============================================
  // 공통 유틸 (content_review.js와 동일 패턴)
  // =============================================
  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  function fireClick(el) {
    ["mousedown", "mouseup", "click"].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    try { el.click(); } catch (e) {}
  }

  // AngularJS 1.x 바인딩 갱신. isolated world라 전역 angular 접근이 안 되면 input 이벤트로 폴백.
  function setAngularValue(element, value) {
    try {
      if (typeof angular !== "undefined" && angular.element) {
        const ngModelCtrl = angular.element(element).controller("ngModel");
        if (ngModelCtrl) {
          const scope = angular.element(element).scope();
          scope.$apply(() => {
            ngModelCtrl.$setViewValue(value);
            ngModelCtrl.$render();
          });
          return;
        }
      }
    } catch (e) { /* fallthrough */ }

    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitFor(fn, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = fn();
      if (r) return r;
      await sleep(150);
    }
    return null;
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  console.log("[NavOne] content_cs.js 로드됨");
})();
