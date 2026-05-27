// =============================================
// content_price.js (최종 - 정확한 셀렉터)
// 네이버 가격비교 페이지 판매자 가격 추출
//
// DOM 구조:
//   div[class*='productList_product_list']
//     div[class*='product_seller_item']         ← 각 판매자
//       div[class*='product_seller_info_wrap']
//         div[class*='product_mall_info']
//           span[class*='product_name']          ← 판매자명
//         div[class*='product_info_area']
//           div[class*='product_price_area']
//             [class*='product_price__']          ← 가격 ("최저70,830원" or "74,900원")
// =============================================

(function () {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "PARSE_PRICES") {
      waitAndParse().then(result => sendResponse(result));
      return true;
    }
  });

  async function waitAndParse() {
    // 판매자 목록 렌더링 대기 (최대 10초)
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const items = document.querySelectorAll("[class*='product_seller_item']");
      if (items.length > 0) break;
    }

    const sellers = extractSellers();
    return {
      success: sellers.length > 0,
      sellers,
    };
  }

  function extractSellers() {
    const sellers = [];
    const items = document.querySelectorAll("[class*='product_seller_item']");

    items.forEach(function(item) {
      // 판매자명
      const nameEl = item.querySelector("[class*='product_name']");
      if (!nameEl) return;
      let sellerName = nameEl.textContent.trim();
      if (!sellerName) return;

      // 가격 (product_price__ 클래스, product_price_area 제외)
      let price = 0;
      const priceEls = item.querySelectorAll("[class*='product_price']");
      priceEls.forEach(function(el) {
        var cn = String(el.className || "");
        // product_price__로 시작하는 것만 (area 제외)
        if (cn.includes("product_price__") || (cn.includes("product_price") && !cn.includes("area"))) {
          var text = el.textContent.trim();
          // "최저70,830원" → 70830, "74,900원" → 74900
          var match = text.match(/([\d,]+)\s*원/);
          if (match) {
            var num = parseInt(match[1].replace(/,/g, ""));
            if (num >= 100 && num <= 10000000) {
              price = num;
            }
          }
        }
      });

      if (price === 0) return;

      // 배송비
      var deliveryFee = 0;
      var priceArea = item.querySelector("[class*='product_price_area']");
      if (priceArea) {
        var areaText = priceArea.textContent;
        if (areaText.includes("무료")) {
          deliveryFee = 0;
        } else {
          var deliveryMatch = areaText.match(/배송비\s*([\d,]+)/);
          if (deliveryMatch) {
            deliveryFee = parseInt(deliveryMatch[1].replace(/,/g, "")) || 0;
          }
        }
      }

      sellers.push({
        sellerName: sellerName,
        price: price,
        deliveryFee: deliveryFee,
      });
    });

    return sellers;
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  console.log("[NavOne] content_price.js 로드됨");
})();
