// =============================================
// content_review.js
// 리뷰 관리 페이지(sell.smartstore.naver.com/#/review/search) 파싱
// AG-Grid (카탈로그 가격관리와 완전 동일 패턴)
// 1단계: PARSE_REVIEWS 만 구현
// =============================================

(function () {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "PARSE_REVIEWS") {
      parseReviews().then(result => sendResponse(result));
      return true;
    }
    else if (msg.action === "OPEN_REVIEW_DETAIL") {
      openReviewDetail(msg.rowIndex).then(result => sendResponse(result));
      return true;
    }
    else if (msg.action === "WRITE_REVIEW_REPLY") {
      writeReviewReply(msg.replyText, true).then(result => sendResponse(result));
      return true;
    }
    else if (msg.action === "WRITE_REVIEW_DRAFT") {
      writeReviewReply(msg.replyText, false).then(result => sendResponse(result));
      return true;
    }
    else if (msg.action === "CLOSE_REVIEW_DETAIL") {
      sendResponse(closeReviewDetail());
    }
    return true;
  });

  // =============================================
  // 리뷰 파싱 (가상 스크롤 + 디듀플리케이션)
  // content_catalog.js의 parseGrid 패턴 재사용
  // 디듀프 키: reviewId
  // =============================================
  async function parseReviews() {
    await sleep(5000);
    const allReviews = new Map();

    const viewport = document.querySelector(".ag-body-viewport");
    if (!viewport) return { success: false, reviews: [] };

    const totalH = viewport.scrollHeight;
    const viewH = viewport.clientHeight;
    let scrollPos = 0;
    let noNewCount = 0;

    while (scrollPos <= totalH + viewH && noNewCount < 3) {
      viewport.scrollTop = scrollPos;
      await sleep(300);

      const rows = parseVisibleRows();
      let newCount = 0;
      rows.forEach(r => {
        if (r.reviewId && !allReviews.has(r.reviewId)) {
          allReviews.set(r.reviewId, r);
          newCount++;
        }
      });

      if (newCount === 0) noNewCount++;
      else noNewCount = 0;
      scrollPos += Math.floor(viewH * 0.7);
    }

    viewport.scrollTop = 0;
    const reviews = Array.from(allReviews.values());

    return {
      success: reviews.length > 0,
      reviews,
      totalCount: reviews.length,
    };
  }

  // =============================================
  // 현재 보이는 행들 파싱
  // =============================================
  function parseVisibleRows() {
    const reviews = [];

    // 중앙 컨테이너 기준으로 row-index 순회 (left pinned 셀과 병합)
    const centerContainer = document.querySelector(".ag-center-cols-container");
    if (!centerContainer) return reviews;

    const centerRows = centerContainer.querySelectorAll(".ag-row");
    centerRows.forEach(centerRow => {
      const rowIdx = centerRow.getAttribute("row-index");
      const review = parseRow(rowIdx);
      if (review) reviews.push(review);
    });

    return reviews;
  }

  // 같은 row-index의 모든 컨테이너(좌측 고정/중앙/우측 고정) 셀을 col-id로 매핑
  function getCellMap(rowIdx) {
    const map = {};
    const selector = '.ag-row[row-index="' + rowIdx + '"] .ag-cell';
    document.querySelectorAll(selector).forEach(cell => {
      const colId = cell.getAttribute("col-id");
      if (colId && !map[colId]) map[colId] = cell;
    });
    return map;
  }

  function parseRow(rowIdx) {
    const cells = getCellMap(rowIdx);

    // --- 리뷰내용 + 리뷰ID ---
    const contentCell = cells["reviewContent"];
    if (!contentCell) return null;

    const reviewId = extractReviewId(contentCell);
    if (!reviewId) return null;

    let content = "";
    const contentBody = contentCell.querySelector("div[ng-non-bindable]");
    content = (contentBody ? contentBody.textContent : contentCell.textContent).trim();

    // --- 채널상품번호 ---
    let productNo = "";
    const productNoCell = cells["productNo"];
    if (productNoCell) {
      const link = productNoCell.querySelector("a.text-info") || productNoCell.querySelector("a");
      const t = (link ? link.textContent : productNoCell.textContent).trim();
      const m = t.match(/\d{6,}/);
      if (m) productNo = m[0];
    }

    // --- 상품명 ---
    let productName = "";
    const productNameCell = cells["productName"];
    if (productNameCell) {
      const nameBody = productNameCell.querySelector("div[ng-non-bindable]");
      productName = (nameBody ? nameBody.textContent : productNameCell.textContent).trim();
    }

    // --- 리뷰구분 ---
    let reviewType = "";
    const typeCell = cells["reviewType"];
    if (typeCell) reviewType = typeCell.textContent.trim();

    // --- 별점 ---
    const rating = extractRating(cells["reviewScore"]);

    // --- 사진 ---
    let hasPhoto = false;
    let photoCount = 0;
    const attachCell = cells["reviewAttach"];
    if (attachCell) {
      const imgs = attachCell.querySelectorAll("img");
      photoCount = imgs.length;
      hasPhoto = photoCount > 0;
    }

    // --- 도움수 ---
    let helpCount = 0;
    const helpCell = cells["helpCount"];
    if (helpCell) {
      const n = parseInt(helpCell.textContent.replace(/[^\d]/g, ""), 10);
      if (!isNaN(n)) helpCount = n;
    }

    // --- 등록자 ---
    let writerId = "";
    const writerCell = cells["writerId"];
    if (writerCell) writerId = writerCell.textContent.trim();

    // --- 등록일 ---
    let date = "";
    const dateCell = cells["createDate"];
    if (dateCell) date = dateCell.textContent.trim();

    return {
      reviewId,
      productNo,
      productName: productName.substring(0, 100),
      rating,
      content,
      reviewType,
      hasPhoto,
      photoCount,
      writerId,
      date,
      helpCount,
      rowIndex: rowIdx,
    };
  }

  // =============================================
  // 리뷰ID 추출
  // a[ng-click="vm.func.openReviewDetailModal(4984587284, true)"] → 4984587284
  // =============================================
  function extractReviewId(contentCell) {
    const link = contentCell.querySelector('a[ng-click*="openReviewDetailModal"]');
    if (link) {
      const ngClick = link.getAttribute("ng-click") || "";
      const m = ngClick.match(/openReviewDetailModal\(\s*(\d+)/);
      if (m) return m[1];
    }
    // fallback: 셀 내 어떤 ng-click이든 숫자
    const anyLink = contentCell.querySelector("a[ng-click]");
    if (anyLink) {
      const m = (anyLink.getAttribute("ng-click") || "").match(/(\d{6,})/);
      if (m) return m[1];
    }
    return "";
  }

  // =============================================
  // 별점 추출
  // 1순위: .seller-rating-value style width (20%=1 … 100%=5)
  // 2순위: 셀 텍스트 마지막 숫자
  // =============================================
  function extractRating(scoreCell) {
    if (!scoreCell) return 0;

    const ratingEl = scoreCell.querySelector(".seller-rating-value");
    if (ratingEl) {
      const widthStr = ratingEl.style.width || "";
      const m = widthStr.match(/([\d.]+)\s*%/);
      if (m) {
        const pct = parseFloat(m[1]);
        const star = Math.round(pct / 20);
        if (star >= 1 && star <= 5) return star;
      }
    }

    // fallback: 셀 텍스트 마지막 숫자 (예: " 4", " 5")
    const text = scoreCell.textContent.trim();
    const nums = text.match(/[1-5]/g);
    if (nums && nums.length) return parseInt(nums[nums.length - 1], 10);

    return 0;
  }

  // =============================================
  // 1. OPEN_REVIEW_DETAIL — 개별 리뷰 상세 팝업 열기
  // 체크박스+일괄모달 방식 폐기. 리뷰내용 셀의
  // a[ng-click*="openReviewDetailModal"] 링크를 클릭해 상세 팝업을 연다.
  // (ngClick이 링크에 직접 걸려 있어 DOM click 이벤트로 트리거됨)
  // 링크 클릭으로 안 열리면 { needMainWorld:true, reviewId } 반환
  // → background가 MAIN world에서 vm.func.openReviewDetailModal(reviewId, true) 직접 호출.
  // =============================================
  async function openReviewDetail(rowIndex) {
    const link = await scrollToReviewLink(rowIndex);
    let reviewId = "";
    if (link) {
      const m = (link.getAttribute("ng-click") || "").match(/openReviewDetailModal\(\s*(\d+)/);
      if (m) reviewId = m[1];

      fireClick(link);

      // "리뷰 상세보기" 팝업이 보일 때까지 대기
      const modal = await waitFor(findReviewDetailModal, 5000);
      if (modal) return { success: true, reviewId };
    }

    // 링크 클릭 실패 → MAIN world 폴백 필요
    return {
      success: false,
      needMainWorld: true,
      reviewId,
      error: link ? "상세 팝업이 열리지 않음" : "row " + rowIndex + " 리뷰 링크 못 찾음",
    };
  }

  // 해당 rowIndex의 리뷰내용 셀 링크가 DOM에 나타날 때까지 .ag-body-viewport 스크롤
  async function scrollToReviewLink(rowIndex) {
    const sel = '.ag-center-cols-container .ag-row[row-index="' + rowIndex
      + '"] [col-id="reviewContent"] a[ng-click*="openReviewDetailModal"]';
    let link = document.querySelector(sel);
    if (link) { link.scrollIntoView({ block: "center" }); await sleep(150); return link; }

    const vp = document.querySelector(".ag-body-viewport");
    if (!vp) return null;
    const totalH = vp.scrollHeight;
    const viewH = vp.clientHeight;
    for (let pos = 0; pos <= totalH + viewH; pos += Math.floor(viewH * 0.6)) {
      vp.scrollTop = pos;
      await sleep(200);
      link = document.querySelector(sel);
      if (link) { link.scrollIntoView({ block: "center" }); await sleep(150); return link; }
    }
    return null;
  }

  // mousedown→mouseup→click 풀 시퀀스 디스패치
  function fireClick(el) {
    ["mousedown", "mouseup", "click"].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    try { el.click(); } catch (e) {}
  }

  // =============================================
  // 2. WRITE_REVIEW_REPLY / WRITE_REVIEW_DRAFT
  // "리뷰 상세보기" 팝업 안의 답글 textarea에 입력. submit=true면 "답글 등록" 클릭.
  // =============================================
  async function writeReviewReply(replyText, submit) {
    const text = (replyText || "").trim();
    if (text.length < 5) return { success: false, error: "답글은 최소 5자 이상" };

    const ta = await waitFor(findReplyTextarea, 5000);
    if (!ta) return { success: false, error: "답글 textarea 못 찾음" };

    ta.focus();
    setAngularValue(ta, text);
    await sleep(300);

    if (!submit) return { success: true };  // DRAFT — 입력만

    const submitBtn = findSubmitButton(ta);
    if (!submitBtn) return { success: false, error: "답글 등록 버튼 없음" };
    if (submitBtn.disabled) return { success: false, error: "답글 등록 버튼 비활성 (입력 미반영 의심)" };

    fireClick(submitBtn);
    await sleep(500);
    return { success: true };
  }

  // "리뷰 상세보기" 팝업 요소
  function findReviewDetailModal() {
    const m = document.querySelector('div[data-target="review-detail"], .modal.seller-layer-modal');
    if (m && isVisible(m)) return m;
    // fallback: 보이는 일반 모달
    const any = document.querySelector(".modal.in, .modal.show, .modal[style*='block']");
    return any && isVisible(any) ? any : null;
  }

  // 답글 입력 textarea 탐색 (상세 팝업 기준)
  // placeholder에 "답글"/"정성" 포함 우선, 없으면 팝업 내 첫 보이는 textarea
  function findReplyTextarea() {
    const modal = findReviewDetailModal();
    const root = modal || document;

    const cands = root.querySelectorAll("textarea");
    for (const t of cands) {
      if (!isVisible(t)) continue;
      const ph = t.getAttribute("placeholder") || "";
      const ng = (t.getAttribute("ng-model") || "").toLowerCase();
      if (ph.includes("답글") || ph.includes("정성") || ng.includes("comment") || ng.includes("reply")) return t;
    }
    // fallback: 팝업 내 첫 보이는 textarea
    for (const t of cands) {
      if (isVisible(t)) return t;
    }
    return null;
  }

  // "답글 등록" 버튼 탐색 (textarea가 속한 팝업 안에서)
  function findSubmitButton(ta) {
    const scope = findReviewDetailModal() || ta.closest(".modal") || document;

    // 텍스트에 "답글등록" 또는 "등록" 포함하는 버튼 우선
    const buttons = scope.querySelectorAll("button, a.btn");
    for (const b of buttons) {
      const t = b.textContent.replace(/\s+/g, "");
      if (t.includes("답글등록")) return b;
    }
    for (const b of buttons) {
      const t = b.textContent.replace(/\s+/g, "");
      if (t.includes("등록")) return b;
    }
    // fallback: ng-click / progress-button
    return scope.querySelector('[ng-click*="addComment"], [progress-button*="addComment"], .btn-primary');
  }

  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  // =============================================
  // 3. CLOSE_REVIEW_DETAIL — "리뷰 상세보기" 팝업 닫기
  // X 버튼(button.close / data-dismiss / ng-click*=close) 우선, 없으면 배경 클릭
  // =============================================
  function closeReviewDetail() {
    const modal = findReviewDetailModal();
    const scope = modal || document;

    let btn = scope.querySelector('button.close')
      || scope.querySelector('[data-dismiss="modal"]')
      || scope.querySelector('[ng-click*="close"], [ng-click*="Close"]');
    if (btn) {
      fireClick(btn);
      return { success: true };
    }

    // fallback: 모달 배경(backdrop) 클릭
    const backdrop = document.querySelector(".modal-backdrop");
    if (backdrop) { fireClick(backdrop); return { success: true }; }

    return { success: false, error: "닫기 버튼 없음" };
  }

  // =============================================
  // AngularJS 바인딩 갱신
  // 콘텐트 스크립트는 isolated world라 전역 angular에 접근 못 할 수 있음.
  // → typeof 가드 후, 접근 가능하면 $setViewValue+$render,
  //   아니면 input/change 이벤트 디스패치(Angular 1.x ngModel이 input 리스닝).
  // =============================================
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

    // fallback: input/change 이벤트 디스패치 (Angular 1.x ngModel이 input 이벤트 청취)
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // 조건이 truthy를 반환할 때까지 폴링. 결과(요소)를 반환, 타임아웃 시 null.
  async function waitFor(fn, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = fn();
      if (r) return r;
      await sleep(150);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  console.log("[NavOne] content_review.js 로드됨");
})();
