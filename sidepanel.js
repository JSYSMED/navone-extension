// sidepanel.js — background.js 연동

// === Page switching (addEventListener) ===
document.querySelectorAll('.nav-item').forEach(function(item) {
  item.addEventListener('click', function() {
    switchPage(this.getAttribute('data-page'), this);
  });
});

function switchPage(id, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  el.classList.add('active');
}

// === Log mode toggle ===
document.getElementById('logModeBtn').addEventListener('click', toggleLogMode);
function toggleLogMode() {
  var s = document.getElementById('logSimple');
  var d = document.getElementById('logDetail');
  var btn = document.getElementById('logModeBtn');
  if (d.classList.contains('show')) {
    d.classList.remove('show'); s.classList.remove('hide');
    btn.textContent = '상세 보기';
  } else {
    d.classList.add('show'); s.classList.add('hide');
    btn.textContent = '간단히 보기';
  }
}

// === Start ===
document.getElementById('btnStart').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.includes('sell.smartstore.naver.com')) {
    addSimpleLog('error', '페이지 오류', '카탈로그 가격관리 페이지를 먼저 열어주세요.');
    return;
  }
  const cfg = await chrome.storage.local.get('config');
  if (!cfg.config || !cfg.config.clientId || !cfg.config.clientSecret) {
    addSimpleLog('error', '설정 필요', 'API 키를 먼저 입력해주세요.');
    switchPage('settings', document.querySelector('[data-page="settings"]'));
    return;
  }
  // Clear logs
  document.getElementById('logSimple').innerHTML = '';
  document.getElementById('logDetail').innerHTML = '';
  document.getElementById('logFull').innerHTML = '';
  document.getElementById('cntChange').textContent = '0';
  document.getElementById('cntSkip').textContent = '0';
  document.getElementById('cntError').textContent = '0';
  document.getElementById('progressBar').style.width = '0%';

  const testMode = document.getElementById('testToggle').classList.contains('on');
  chrome.runtime.sendMessage({ action: 'START', tabId: tab.id, testMode }, (res) => {
    if (res?.status === 'started') setRunning(true);
    else if (res?.status === 'already_running') addSimpleLog('skip', '이미 실행 중', '자동화가 이미 진행 중입니다.');
  });
});

// === Stop ===
document.getElementById('btnStop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'STOP' }, (res) => {
    if (res?.status === 'stopped') {
      setRunning(false);
      addSimpleLog('skip', '중지됨', '자동화가 중지되었습니다.');
    }
  });
});

// === Running state UI ===
function setRunning(running) {
  document.getElementById('btnStart').disabled = running;
  document.getElementById('btnStop').disabled = !running;
  var badge = document.getElementById('statusBadge');
  var text = document.getElementById('statusText');
  var navRun = document.querySelector('[data-page="run"]');
  if (running) {
    badge.classList.add('running'); text.textContent = '실행 중';
    navRun.classList.add('running');
  } else {
    badge.classList.remove('running'); text.textContent = '대기';
    navRun.classList.remove('running');
    document.getElementById('progressBar').style.width = '100%';
  }
}

// === Simple log entry ===
function addSimpleLog(type, title, desc) {
  var box = document.getElementById('logSimple');
  var t = new Date().toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'});
  var icons = { collect: 'i', change: 'OK', skip: '—', error: '!', done: 'V' };
  var el = document.createElement('div');
  el.className = 'log-s ' + type;
  el.innerHTML = '<div class="ico">' + (icons[type]||'·') + '</div><div class="content"><div class="title">' + esc(title) + '</div><div class="desc">' + esc(desc) + '</div><div class="time">' + t + '</div></div>';
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// === Detail log entry ===
function addDetailLog(msg, time) {
  var cls = '';
  if (msg.includes('변경') || msg.includes('완료') || msg.includes('최저')) cls = 'g';
  else if (msg.includes('배송비') || msg.includes('노출') || msg.includes('✅')) cls = 'o';
  else if (msg.includes('오류') || msg.includes('실패')) cls = 'r';
  else if (msg.includes('http') || msg.includes('수집')) cls = 'b';

  // Run page detail log
  var d = document.getElementById('logDetail');
  var el = document.createElement('div');
  el.className = 'log-d ' + cls;
  el.innerHTML = '<span class="t">' + (time || '') + '</span> ' + esc(msg.replace(/^\[.*?\]\s*/, ''));
  d.appendChild(el);
  d.scrollTop = d.scrollHeight;

  // Full log page
  var f = document.getElementById('logFull');
  var el2 = el.cloneNode(true);
  f.appendChild(el2);
  f.scrollTop = f.scrollHeight;
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// === Listen to background messages ===
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'LOG') {
    addDetailLog(msg.message, msg.time || '');
  }
  if (msg.action === 'SLOG') {
    addSimpleLog(msg.type, msg.title, msg.desc);
  }
});

// === Poll status ===
setInterval(() => {
  chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    setRunning(res.running);
    if (res.total > 0) {
      var pct = Math.round((res.current / res.total) * 100);
      document.getElementById('progressBar').style.width = pct + '%';
    }
    if (res.results) {
      document.getElementById('cntChange').textContent = res.results.filter(r => r.status === 'UPDATED' || r.status === 'TEST_SKIP').length;
      document.getElementById('cntSkip').textContent = res.results.filter(r => ['SAME_PRICE','NO_COMPETITORS','PRICE_TOO_LOW'].includes(r.status)).length;
      document.getElementById('cntError').textContent = res.results.filter(r => ['ERROR','API_ERROR','NO_SELLERS'].includes(r.status)).length;
    }
  });
}, 1000);

// === Settings ===
chrome.storage.local.get('config', (data) => {
  var c = data.config || {};
  document.getElementById('cfgId').value = c.clientId || '';
  document.getElementById('cfgSecret').value = c.clientSecret || '';
  document.getElementById('cfgStore').value = (c.storeNames || []).join(', ');
  document.getElementById('cfgUnder').value = c.undercut || 10;
  document.getElementById('cfgLicense').value = c.licenseKey || '';
  document.getElementById('cfgTgToken').value = c.tgToken || '';
  document.getElementById('cfgTgChat').value = c.tgChatId || '';
});

document.getElementById('btnSave').addEventListener('click', () => {
  // 기존 config 위에 병합 — reviewTone/vercelUrl 등 폼에 없는 키 보존
  chrome.storage.local.get('config', (data) => {
    var cfg = Object.assign({}, data.config || {}, {
      clientId: document.getElementById('cfgId').value.trim(),
      clientSecret: document.getElementById('cfgSecret').value.trim(),
      storeNames: document.getElementById('cfgStore').value.split(',').map(s => s.trim()).filter(Boolean),
      undercut: parseInt(document.getElementById('cfgUnder').value) || 10,
      licenseKey: document.getElementById('cfgLicense').value.trim(),
      tgToken: document.getElementById('cfgTgToken').value.trim(),
      tgChatId: document.getElementById('cfgTgChat').value.trim(),
    });
    chrome.storage.local.set({ config: cfg }, () => {
      var ok = document.getElementById('saveOk');
      ok.style.display = 'block';
      setTimeout(() => ok.style.display = 'none', 2000);
    });
  });
});

// === 상품별 최소가 CSV 업로드 ===
function refreshCsvCount() {
  chrome.storage.local.get('product_configs', (data) => {
    var n = Object.keys(data.product_configs || {}).length;
    document.getElementById('csvCount').textContent = '등록된 상품: ' + n + '개';
  });
}
refreshCsvCount();

// "channelProductNo, min_sale_price" 2컬럼 파싱. 헤더 행(숫자 아님)은 자동 무시.
function parseMinPriceCsv(text) {
  var out = {};
  text.split(/\r?\n/).forEach(function (line) {
    line = line.trim();
    if (!line) return;
    var cols = line.split(',').map(function (c) { return c.trim(); });
    var no = cols[0];
    var price = parseInt((cols[1] || '').replace(/[^\d]/g, ''), 10);
    if (!/^\d{6,}$/.test(no) || !price || price <= 0) return; // 헤더/빈값/이상치 스킵
    out[no] = price;
  });
  return out;
}

document.getElementById('btnCsvUpload').addEventListener('click', () => {
  var input = document.getElementById('csvFile');
  var file = input.files && input.files[0];
  if (!file) { alert('CSV 파일을 선택하세요.'); return; }
  var reader = new FileReader();
  reader.onload = function (e) {
    var parsed = parseMinPriceCsv(String(e.target.result || ''));
    var count = Object.keys(parsed).length;
    if (count === 0) { alert('유효한 행이 없습니다. (channelProductNo, min_sale_price)'); return; }
    chrome.storage.local.get('product_configs', (data) => {
      var cfgs = data.product_configs || {};
      var now = new Date().toISOString();
      Object.keys(parsed).forEach(function (no) {
        cfgs[no] = { min_sale_price: parsed[no], strategy: 'auto', updated_at: now };
      });
      chrome.storage.local.set({ product_configs: cfgs }, () => {
        var ok = document.getElementById('csvOk');
        ok.textContent = count + '개 상품 업로드되었습니다.';
        ok.style.display = 'block';
        setTimeout(() => ok.style.display = 'none', 2500);
        input.value = '';
        refreshCsvCount();
      });
    });
  };
  reader.readAsText(file, 'utf-8');
});

// Telegram test
document.getElementById('btnTgTest').addEventListener('click', async () => {
  var token = document.getElementById('cfgTgToken').value.trim();
  var chatId = document.getElementById('cfgTgChat').value.trim();
  if (!token || !chatId) { alert('봇 토큰과 Chat ID를 입력하세요.'); return; }
  try {
    var res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: 'PRA 텔레그램 연결 성공', parse_mode: 'HTML' }),
    });
    var data = await res.json();
    alert(data.ok ? '발송 성공! 텔레그램을 확인하세요.' : '실패: ' + (data.description || ''));
  } catch (e) { alert('오류: ' + e.message); }
});

// Toggle
document.getElementById('testToggle').addEventListener('click', function() {
  this.classList.toggle('on');
});

// =====================================================
// === 자동화 설정 탭 ===
// =====================================================
// 토글 → chrome.storage.local의 top-level 키. background.js가 storage 변화를 감지해
// chrome.alarms를 재설정한다(클레임 30분 / 발주 15분).
var AUTO_TOGGLES = [
  { id: 'autoModeToggle',    key: 'autoMode' },          // 가격 자동화
  { id: 'autoClaimToggle',   key: 'autoClaimProcess' },  // 클레임 자동처리
  { id: 'autoConfirmToggle', key: 'autoConfirmOrders' }, // 발주 자동확인
];

// 저장된 상태 불러오기
chrome.storage.local.get(AUTO_TOGGLES.map(t => t.key), (data) => {
  AUTO_TOGGLES.forEach(t => {
    document.getElementById(t.id).classList.toggle('on', !!data[t.key]);
  });
});

// 클릭 → 상태 반전 + 저장
AUTO_TOGGLES.forEach(t => {
  document.getElementById(t.id).addEventListener('click', function () {
    this.classList.toggle('on');
    var on = this.classList.contains('on');
    chrome.storage.local.set({ [t.key]: on });
  });
});

// Load existing logs on open
chrome.storage.local.get(['logs', 'slogs'], (data) => {
  if (data.slogs) data.slogs.slice(-20).forEach(s => addSimpleLog(s.type, s.title, s.desc));
  if (data.logs) data.logs.slice(-50).forEach(m => addDetailLog(m));
});

// =====================================================
// === 리뷰 답변 탭 ===
// =====================================================
var reviewTone = '정중';
var reviewTabId = null;  // 스캔한 리뷰관리 탭 — 등록 시 재사용

// 톤 선택 (segmented control) — 변경 즉시 config에 저장
document.getElementById('toneSeg').addEventListener('click', (e) => {
  var opt = e.target.closest('.tone-opt');
  if (!opt) return;
  document.querySelectorAll('#toneSeg .tone-opt').forEach(o => o.classList.remove('on'));
  opt.classList.add('on');
  reviewTone = opt.getAttribute('data-tone');
  chrome.storage.local.get('config', (data) => {
    var c = data.config || {};
    c.reviewTone = reviewTone;
    chrome.storage.local.set({ config: c });
  });
});

// 저장된 톤 불러오기
chrome.storage.local.get('config', (data) => {
  var t = (data.config || {}).reviewTone;
  if (t) {
    reviewTone = t;
    document.querySelectorAll('#toneSeg .tone-opt').forEach(o => {
      o.classList.toggle('on', o.getAttribute('data-tone') === t);
    });
  }
});

// 카운터
function bumpReviewStat(id) {
  var el = document.getElementById(id);
  el.textContent = (parseInt(el.textContent, 10) || 0) + 1;
}

// 별점 렌더
function starsHtml(rating) {
  var on = '', off = '';
  for (var i = 0; i < 5; i++) {
    if (i < rating) on += '★'; else off += '★';
  }
  return '<span class="rv-stars">' + on + '<span class="off">' + off + '</span></span>';
}

// 리뷰 스캔
document.getElementById('btnReviewScan').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('sell.smartstore.naver.com')) {
    document.getElementById('reviewEmpty').innerHTML = '스마트스토어 리뷰관리 페이지를<br>먼저 열어주세요.';
    document.getElementById('reviewEmpty').style.display = 'block';
    return;
  }

  reviewTabId = tab.id;
  var btn = document.getElementById('btnReviewScan');
  btn.disabled = true;
  btn.textContent = '스캔 중…';
  document.getElementById('reviewList').innerHTML = '<div class="rv-loading">리뷰를 불러오는 중…</div>';
  document.getElementById('rvDone').textContent = '0';
  document.getElementById('rvSkip').textContent = '0';
  document.getElementById('rvError').textContent = '0';

  chrome.runtime.sendMessage({ action: 'SCAN_REVIEWS', tabId: tab.id }, (res) => {
    btn.disabled = false;
    btn.textContent = '리뷰 스캔';
    if (chrome.runtime.lastError || !res || !res.success) {
      document.getElementById('reviewList').innerHTML =
        '<div class="review-empty">리뷰를 가져오지 못했습니다.<br>페이지를 확인해주세요.</div>';
      return;
    }
    renderReviews(res.reviews || []);
  });
});

// 리뷰 카드 리스트 렌더
function renderReviews(reviews) {
  var list = document.getElementById('reviewList');
  list.innerHTML = '';
  if (!reviews.length) {
    list.innerHTML = '<div class="review-empty">표시할 리뷰가 없습니다.</div>';
    return;
  }
  reviews.forEach(r => list.appendChild(buildReviewCard(r)));
}

function buildReviewCard(r) {
  var card = document.createElement('div');
  card.className = 'rv-card';

  var badges = '<span class="rv-badge">' + esc(r.reviewType || '일반') + '</span>';
  if (r.hasPhoto) badges += '<span class="rv-badge photo">사진 ' + (r.photoCount || 0) + '</span>';

  card.innerHTML =
    '<div class="rv-top">' + starsHtml(r.rating || 0) + '<div class="rv-badges">' + badges + '</div></div>' +
    '<div class="rv-name">' + esc(r.productName || '') + '</div>' +
    '<div class="rv-content">' + esc(r.content || '') + '</div>' +
    '<div class="rv-meta">' + esc(r.writerId || '') + ' · ' + esc(r.date || '') + '</div>' +
    '<div class="rv-actions">' +
      '<button class="rv-btn primary act-gen">답변 생성</button>' +
      '<button class="rv-btn act-skip">건너뛰기</button>' +
    '</div>' +
    '<div class="rv-reply">' +
      '<textarea maxlength="1000" placeholder="답글을 입력하세요."></textarea>' +
      '<div class="cnt">0 / 1000</div>' +
      '<div class="rv-actions">' +
        '<button class="rv-btn primary act-submit">등록</button>' +
        '<button class="rv-btn act-regen">재생성</button>' +
        '<button class="rv-btn act-cancel">취소</button>' +
      '</div>' +
    '</div>';

  var genBtn = card.querySelector('.act-gen');
  var skipBtn = card.querySelector('.act-skip');
  var reply = card.querySelector('.rv-reply');
  var ta = card.querySelector('textarea');
  var cnt = card.querySelector('.cnt');
  var actionsRow = card.querySelector('.rv-actions');

  ta.addEventListener('input', () => { cnt.textContent = ta.value.length + ' / 1000'; });

  // 답변 생성
  function generate() {
    genBtn.disabled = true;
    genBtn.textContent = '생성 중…';
    chrome.runtime.sendMessage(
      { action: 'GENERATE_REVIEW_REPLY', review: r, tone: reviewTone },
      (res) => {
        genBtn.disabled = false;
        genBtn.textContent = '답변 생성';
        if (chrome.runtime.lastError || !res || !res.success) {
          bumpReviewStat('rvError');
          addSimpleLog('error', '답변 생성 실패', r.productName || '');
          return;
        }
        ta.value = res.reply || '';
        cnt.textContent = ta.value.length + ' / 1000';
        actionsRow.style.display = 'none';
        reply.classList.add('show');
      }
    );
  }

  genBtn.addEventListener('click', generate);
  card.querySelector('.act-regen').addEventListener('click', () => {
    reply.classList.remove('show');
    actionsRow.style.display = 'flex';
    generate();
  });

  // 건너뛰기
  skipBtn.addEventListener('click', () => {
    card.classList.add('done');
    genBtn.disabled = true; skipBtn.disabled = true;
    bumpReviewStat('rvSkip');
  });

  // 취소
  card.querySelector('.act-cancel').addEventListener('click', () => {
    reply.classList.remove('show');
    actionsRow.style.display = 'flex';
  });

  // 등록
  card.querySelector('.act-submit').addEventListener('click', (e) => {
    var submitBtn = e.target;
    var text = ta.value.trim();
    if (text.length < 5) { alert('답글은 최소 5자 이상이어야 합니다.'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = '등록 중…';
    chrome.runtime.sendMessage(
      { action: 'SUBMIT_REPLY', tabId: reviewTabId, rowIndex: r.rowIndex, replyText: text, review: r },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.success) {
          submitBtn.disabled = false;
          submitBtn.textContent = '등록';
          bumpReviewStat('rvError');
          addSimpleLog('error', '답글 등록 실패', r.productName || '');
          return;
        }
        card.classList.add('done');
        reply.classList.remove('show');
        bumpReviewStat('rvDone');
        addSimpleLog('change', '답글 등록', r.productName || '');
      }
    );
  });

  return card;
}

// =====================================================
// === 클레임 자동처리 탭 ===
// =====================================================
var CLAIM_TYPE_KO = { RETURN: '반품', CANCEL: '취소', EXCHANGE: '교환' };
var CLAIM_CAT_KO = { simple_return: '단순변심', defect: '상품하자', delivery: '배송문제', other: '기타' };

function bumpClaimStat(id) {
  var el = document.getElementById(id);
  el.textContent = (parseInt(el.textContent, 10) || 0) + 1;
}

// 클레임 조회(새로고침)
document.getElementById('btnClaimRefresh').addEventListener('click', loadClaims);

function loadClaims() {
  var btn = document.getElementById('btnClaimRefresh');
  btn.disabled = true;
  document.getElementById('claimList').innerHTML = '<div class="rv-loading">클레임을 불러오는 중…</div>';
  chrome.runtime.sendMessage({ action: 'CLAIM_PENDING' }, (res) => {
    btn.disabled = false;
    if (chrome.runtime.lastError || !res || !res.success) {
      document.getElementById('claimList').innerHTML =
        '<div class="review-empty">' + esc((res && res.error) || '클레임을 가져오지 못했습니다.') + '</div>';
      return;
    }
    renderClaims(res.claims || []);
  });
}

// 전체 자동처리
document.getElementById('btnClaimAuto').addEventListener('click', () => {
  var btn = document.getElementById('btnClaimAuto');
  btn.disabled = true;
  btn.textContent = '자동처리 중…';
  chrome.runtime.sendMessage({ action: 'CLAIM_AUTO_PROCESS' }, (res) => {
    btn.disabled = false;
    btn.textContent = '전체 자동처리';
    if (chrome.runtime.lastError || !res || !res.success) {
      bumpClaimStat('clmError');
      addSimpleLog('error', '자동처리 실패', (res && res.error) || '');
      return;
    }
    var r = res.result || {};
    addSimpleLog('change', '클레임 자동처리', '처리 ' + (r.processed || 0) + '건 (승인 ' + (r.approved || 0) + ', 보류 ' + (r.held || 0) + ')');
    loadClaims();  // 처리 후 목록 갱신
  });
});

function renderClaims(claims) {
  var list = document.getElementById('claimList');
  var pending = claims.filter(c => !c.processed);
  document.getElementById('clmPending').textContent = pending.length;
  list.innerHTML = '';
  if (!claims.length) {
    list.innerHTML = '<div class="review-empty">미처리 클레임이 없습니다.</div>';
    return;
  }
  claims.forEach(c => list.appendChild(buildClaimCard(c)));
}

function buildClaimCard(c) {
  var card = document.createElement('div');
  card.className = 'clm-card' + (c.processed ? ' done' : '');

  var type = CLAIM_TYPE_KO[c.claimType] || c.claimType || '-';
  var cat = CLAIM_CAT_KO[c.category] || '미분류';
  var amount = Number(c.amount || 0).toLocaleString() + '원';

  var badges = '<span class="clm-badge type">' + esc(type) + '</span>' +
               '<span class="clm-badge">' + esc(cat) + '</span>';
  if (c.processed) badges += '<span class="clm-badge done">' + esc(c.decision || '처리됨') + '</span>';

  var canDecide = !c.processed && (c.claimType === 'RETURN' || c.claimType === 'CANCEL');
  var actions = canDecide
    ? '<div class="clm-actions">' +
        '<button class="clm-btn approve">승인</button>' +
        '<button class="clm-btn reject">거부</button>' +
      '</div>'
    : '';

  card.innerHTML =
    '<div class="clm-top"><div class="clm-name">' + esc(c.productName || '') + '</div>' +
    '<div class="clm-amount">' + amount + '</div></div>' +
    '<div class="clm-badges">' + badges + '</div>' +
    '<div class="clm-reason">' + esc(c.claimReason || '(사유 없음)') + '</div>' +
    actions;

  if (canDecide) {
    var approveBtn = card.querySelector('.approve');
    var rejectBtn = card.querySelector('.reject');
    function decide(decision, btn) {
      approveBtn.disabled = true; rejectBtn.disabled = true;
      btn.textContent = '처리 중…';
      chrome.runtime.sendMessage(
        { action: 'CLAIM_MANUAL_DECIDE', productOrderId: c.productOrderId, decision },
        (res) => {
          if (chrome.runtime.lastError || !res || !res.success) {
            approveBtn.disabled = false; rejectBtn.disabled = false;
            btn.textContent = decision === 'approve' ? '승인' : '거부';
            bumpClaimStat('clmError');
            addSimpleLog('error', '클레임 처리 실패', (res && res.error) || c.productName || '');
            return;
          }
          card.classList.add('done');
          bumpClaimStat('clmDone');
          var pn = document.getElementById('clmPending');
          pn.textContent = Math.max(0, (parseInt(pn.textContent, 10) || 1) - 1);
          addSimpleLog('change', decision === 'approve' ? '클레임 승인' : '클레임 거부', c.productName || '');
        }
      );
    }
    approveBtn.addEventListener('click', () => decide('approve', approveBtn));
    rejectBtn.addEventListener('click', () => decide('reject', rejectBtn));
  }
// === 주문/발주 탭 ===
// =====================================================
// 배송사 코드 (커머스 표준) — 서버 _lib.js DELIVERY_COMPANIES 부분집합
var DELIVERY_COMPANIES = [
  ['CJGLS', 'CJ대한통운'],
  ['HANJIN', '한진'],
  ['LOTTE', '롯데'],
  ['EPOST', '우체국'],
  ['LOGEN', '로젠'],
];

// config에서 서버 URL + licenseKey 로드 (background.js와 동일 규약)
function withOrderApi(cb) {
  chrome.storage.local.get('config', (data) => {
    var c = data.config || {};
    var base = (c.vercelUrl || 'https://navone-server.vercel.app').replace(/\/+$/, '');
    cb(base, c.licenseKey || '');
  });
}

function bumpOrderStat(id, n) {
  var el = document.getElementById(id);
  el.textContent = (parseInt(el.textContent, 10) || 0) + (n || 1);
}

// 서버 표준 에러({success:false, error:{message}}) → 사람이 읽을 메시지
function orderErrMsg(data, status) {
  return (data && data.error && data.error.message) || ('서버 오류 ' + status);
}

// 미발주 주문 불러오기
document.getElementById('btnOrderLoad').addEventListener('click', loadPendingOrders);

function loadPendingOrders() {
  var btn = document.getElementById('btnOrderLoad');
  var list = document.getElementById('orderList');
  btn.disabled = true;
  btn.textContent = '불러오는 중…';
  list.innerHTML = '<div class="od-loading">미발주 주문을 불러오는 중…</div>';

  withOrderApi(async (base, licenseKey) => {
    if (!licenseKey) {
      btn.disabled = false; btn.textContent = '미발주 주문 불러오기';
      list.innerHTML = '<div class="order-empty">라이선스 키가 없습니다.<br>설정에서 먼저 등록해주세요.</div>';
      return;
    }
    try {
      var res = await fetch(base + '/api/order/pending?licenseKey=' + encodeURIComponent(licenseKey));
      var data = await res.json();
      btn.disabled = false; btn.textContent = '미발주 주문 불러오기';
      if (!res.ok || !data.success) {
        list.innerHTML = '<div class="order-empty">' + esc(orderErrMsg(data, res.status)) + '</div>';
        return;
      }
      var orders = (data.data && data.data.orders) || [];
      document.getElementById('odPending').textContent = (data.data && data.data.count) || orders.length;
      renderOrders(orders);
    } catch (e) {
      btn.disabled = false; btn.textContent = '미발주 주문 불러오기';
      list.innerHTML = '<div class="order-empty">불러오기 실패: ' + esc(e.message) + '</div>';
    }
  });
}

// 신규 주문 자동 발주확인 (ids 미지정 → 서버 자동 모드)
document.getElementById('btnOrderAutoConfirm').addEventListener('click', () => {
  var btn = document.getElementById('btnOrderAutoConfirm');
  btn.disabled = true;
  btn.textContent = '발주확인 중…';
  withOrderApi(async (base, licenseKey) => {
    if (!licenseKey) {
      btn.disabled = false; btn.textContent = '신규 주문 자동 발주확인';
      addSimpleLog('error', '라이선스 필요', '설정에서 라이선스 키를 먼저 등록해주세요.');
      return;
    }
    try {
      var res = await fetch(base + '/api/order/auto-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: licenseKey }),
      });
      var data = await res.json();
      btn.disabled = false; btn.textContent = '신규 주문 자동 발주확인';
      if (!res.ok || !data.success) {
        addSimpleLog('error', '발주확인 실패', orderErrMsg(data, res.status));
        return;
      }
      var d = data.data || {};
      if (d.skipped) {
        addSimpleLog('skip', '자동확인 OFF', (d.reason || '') + ' · 미발주 ' + (d.pendingCount || 0) + '건');
        return;
      }
      var n = d.confirmed || 0;
      if (n > 0) bumpOrderStat('odConfirm', n);
      addSimpleLog('change', '발주확인 완료', '확인 ' + n + '건' + (d.failed ? ' · 실패 ' + d.failed + '건' : ''));
      loadPendingOrders();  // 목록 갱신
    } catch (e) {
      btn.disabled = false; btn.textContent = '신규 주문 자동 발주확인';
      addSimpleLog('error', '발주확인 오류', e.message);
    }
  });
});

// 주문 카드 리스트 렌더
function renderOrders(orders) {
  var list = document.getElementById('orderList');
  list.innerHTML = '';
  if (!orders.length) {
    list.innerHTML = '<div class="order-empty">미발주 주문이 없습니다.</div>';
    return;
  }
  orders.forEach(o => list.appendChild(buildOrderCard(o)));
}

function buildOrderCard(o) {
  var card = document.createElement('div');
  card.className = 'od-card';

  var opts = DELIVERY_COMPANIES.map(c => '<option value="' + c[0] + '">' + esc(c[1]) + '</option>').join('');

  var meta = [];
  if (o.buyerName) meta.push(esc(o.buyerName));
  if (o.quantity != null) meta.push(o.quantity + '개');
  if (o.totalAmount != null) meta.push(Number(o.totalAmount).toLocaleString('ko-KR') + '원');
  if (o.orderedAt) meta.push(esc(String(o.orderedAt).slice(0, 10)));

  card.innerHTML =
    '<div class="od-top">' +
      '<span class="od-badge">' + esc(o.productOrderStatus || '발주대기') + '</span>' +
      '<span class="od-id">#' + esc(o.productOrderId || '') + '</span>' +
    '</div>' +
    '<div class="od-name">' + esc(o.productName || '(상품명 없음)') + '</div>' +
    '<div class="od-meta">' + meta.join(' · ') + '</div>' +
    '<div class="od-dispatch">' +
      '<select class="od-company">' + opts + '</select>' +
      '<input class="od-tracking" type="text" placeholder="송장번호" inputmode="numeric">' +
      '<button class="od-btn act-dispatch">송장 등록</button>' +
    '</div>';

  var btn = card.querySelector('.act-dispatch');
  var sel = card.querySelector('.od-company');
  var trk = card.querySelector('.od-tracking');

  // 송장 등록
  btn.addEventListener('click', () => {
    var trackingNumber = trk.value.trim().replace(/[\s-]/g, '');
    if (!trackingNumber) { alert('송장번호를 입력하세요.'); return; }
    btn.disabled = true;
    btn.textContent = '등록 중…';
    withOrderApi(async (base, licenseKey) => {
      if (!licenseKey) {
        btn.disabled = false; btn.textContent = '송장 등록';
        addSimpleLog('error', '라이선스 필요', '설정에서 라이선스 키를 먼저 등록해주세요.');
        return;
      }
      try {
        var res = await fetch(base + '/api/order/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            licenseKey: licenseKey,
            productOrderId: o.productOrderId,
            deliveryCompanyCode: sel.value,
            trackingNumber: trackingNumber,
          }),
        });
        var data = await res.json();
        if (!res.ok || !data.success) {
          btn.disabled = false; btn.textContent = '송장 등록';
          addSimpleLog('error', '송장 등록 실패', orderErrMsg(data, res.status));
          return;
        }
        card.classList.add('done');
        sel.disabled = true; trk.disabled = true;
        btn.textContent = '등록 완료';
        bumpOrderStat('odDispatch', 1);
        addSimpleLog('change', '송장 등록', o.productName || String(o.productOrderId || ''));
      } catch (e) {
        btn.disabled = false; btn.textContent = '송장 등록';
        addSimpleLog('error', '송장 등록 오류', e.message);
      }
    });
  });

  return card;
}
