// =============================================
// content_catalog.js (최종 - 스크롤하면서 바로 처리)
// =============================================

(function () {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "PARSE_CATALOG_TABLE") {
      parseGrid().then(result => sendResponse(result));
      return true;
    }
    else if (msg.action === "CLICK_VIEW_BUTTON") {
      clickDetailForProduct(msg.channelProductNo).then(result => sendResponse(result));
      return true;
    }
    else if (msg.action === "CLICK_NEXT_PAGE") {
      sendResponse(clickNextPage());
    }
    else if (msg.action === "GO_TO_PAGE_1" || msg.action === "GO_TO_PAGE") {
      const targetPage = msg.targetPage || 0;
      const pageLink = document.querySelector('li._page[data-page="' + targetPage + '"] a');
      if (pageLink) {
        pageLink.click();
        pageLink.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      sendResponse({ success: true });
    }
    return true;
  });

  // =============================================
  // 그리드 파싱 (기존과 동일)
  // =============================================
  async function parseGrid() {
    await sleep(5000);
    const allProducts = new Map();

    const viewport = document.querySelector(".ag-body-viewport");
    if (!viewport) return { success: false, products: [] };

    const totalH = viewport.scrollHeight;
    const viewH = viewport.clientHeight;
    let scrollPos = 0;
    let noNewCount = 0;

    while (scrollPos <= totalH + viewH && noNewCount < 3) {
      viewport.scrollTop = scrollPos;
      await sleep(300);

      const rows = parseVisibleRows();
      let newCount = 0;
      rows.forEach(p => {
        if (p.channelProductNo && !allProducts.has(p.channelProductNo)) {
          allProducts.set(p.channelProductNo, p);
          newCount++;
        }
      });

      if (newCount === 0) noNewCount++;
      else noNewCount = 0;
      scrollPos += Math.floor(viewH * 0.7);
    }

    viewport.scrollTop = 0;
    const products = Array.from(allProducts.values());

    return {
      success: products.length > 0,
      products,
      totalCount: products.length,
    };
  }

  // =============================================
  // 행 파싱
  // =============================================
  function parseVisibleRows() {
    const products = [];
    const leftRows = document.querySelectorAll(".ag-pinned-left-cols-container .ag-row");
    const centerContainer = document.querySelector(".ag-center-cols-container");
    if (!centerContainer) return products;

    leftRows.forEach(leftRow => {
      const rowIdx = leftRow.getAttribute("row-index");
      const centerRow = centerContainer.querySelector('.ag-row[row-index="' + rowIdx + '"]');
      const product = parseRowPair(leftRow, centerRow, rowIdx);
      if (product) products.push(product);
    });

    return products;
  }

  function parseRowPair(leftRow, centerRow, rowIdx) {
    let channelProductNo = "";
    if (leftRow) {
      const link = leftRow.querySelector("a");
      if (link) {
        const t = link.textContent.trim();
        if (/^\d{8,}$/.test(t)) channelProductNo = t;
      }
    }
    if (!channelProductNo) return null;

    let productName = "";
    let priceDiff = 0;
    let priceDiffText = "";
    let catalogPrice = 0;

    if (centerRow) {
      const cells = centerRow.querySelectorAll(".ag-cell");
      const texts = Array.from(cells).map(c => c.textContent.trim());

      texts.forEach(t => {
        if (t.length > productName.length && t.length > 5 && t.length < 200
            && t !== "보기" && t !== "상세보기"
            && !t.includes("스마트스토어") && !t.includes("쇼핑윈도")
            && !/^[\d,]+$/.test(t)) {
          productName = t;
        }
      });

      texts.forEach(t => {
        if (t.includes("높음") || t.includes("낮음") || t.includes("최저가와 같음")) {
          priceDiffText = t;
          const match = t.match(/([+-]?\s*[\d,]+)\s*원/);
          if (match) priceDiff = parseInt(match[1].replace(/[,\s]/g, "")) || 0;
        }
      });

      texts.forEach(t => {
        if (/^[\d,]+$/.test(t)) {
          const num = parseInt(t.replace(/,/g, ""));
          if (num >= 100 && num <= 10000000) catalogPrice = num;
        }
      });
    }

    return {
      channelProductNo,
      channel: "스마트스토어",
      productName: productName.substring(0, 100),
      priceDiff,
      priceDiffText,
      catalogPrice,
      rowIndex: rowIdx,
    };
  }

  // =============================================
  // 페이지네이션
  // =============================================
  function goToPage1() {
    const firstPage = document.querySelector('li._page[data-page="0"] a');
    if (firstPage) {
      firstPage.click();
      firstPage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }

  function clickNextPage() {
    const btNext = document.querySelector('a[ref="btNext"]');
    if (btNext) {
      const parentLi = btNext.closest("li");
      if (parentLi && (parentLi.classList.contains("disabled") || parentLi.classList.contains("ag-hidden"))) {
        return { hasNext: false };
      }
      btNext.click();
      btNext.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return { hasNext: true };
    }
    return { hasNext: false };
  }

  // =============================================
  // 특정 상품의 "상세보기" 버튼 클릭
  // col-id="rankDetailView" 컬럼에 있는 버튼
  // =============================================
  async function clickDetailForProduct(targetProductNo) {
    const viewport = document.querySelector(".ag-body-viewport");
    if (!viewport) return { success: false, error: "viewport 없음" };

    const totalH = viewport.scrollHeight;
    const viewH = viewport.clientHeight;
    let scrollPos = 0;

    while (scrollPos <= totalH + viewH) {
      viewport.scrollTop = scrollPos;
      await sleep(300);

      // 좌측에서 상품번호 매칭
      const leftRows = document.querySelectorAll(".ag-pinned-left-cols-container .ag-row");
      for (const leftRow of leftRows) {
        const link = leftRow.querySelector("a");
        if (!link) continue;
        if (link.textContent.trim() !== targetProductNo) continue;

        // 매칭됨! 같은 row-index의 중앙 행에서 상세보기 찾기
        const rowIdx = leftRow.getAttribute("row-index");
        const centerRow = document.querySelector(
          '.ag-center-cols-container .ag-row[row-index="' + rowIdx + '"]'
        );
        if (!centerRow) return { success: false, error: "center row 없음" };

        // col-id="rankDetailView" 셀에서 버튼 찾기
        const detailCell = centerRow.querySelector('[col-id="rankDetailView"]');
        let targetBtn = detailCell ? detailCell.querySelector("button") : null;

        // fallback: 텍스트로 "상세보기" 찾기
        if (!targetBtn) {
          const buttons = centerRow.querySelectorAll("button");
          for (const b of buttons) {
            if (b.textContent.trim() === "상세보기") { targetBtn = b; break; }
          }
        }

        if (!targetBtn) {
          return { success: false, error: "상세보기 버튼 없음 (row " + rowIdx + ")" };
        }

        // 버튼을 뷰포트로 스크롤
        targetBtn.scrollIntoView({ block: "center", inline: "center" });
        await sleep(300);

        // ★ 버튼의 row-index를 background에 전달 → background가 MAIN world에서 처리
        return { 
          success: true, 
          capturedUrl: null, 
          rowIndex: rowIdx,
          needMainWorldClick: true 
        };
      }

      scrollPos += Math.floor(viewH * 0.7);
    }

    return { success: false, error: "상품 " + targetProductNo + " 못 찾음" };
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  console.log("[NavOne] content_catalog.js 로드됨");
})();
