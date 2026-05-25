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
      document.getElementById('cntSkip').textContent = res.results.filter(r => ['ALREADY_LOWEST','SAME_PRICE','NO_COMPETITORS'].includes(r.status)).length;
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
  document.getElementById('cfgMargin').value = c.margin || 20;
  document.getElementById('cfgTgToken').value = c.tgToken || '';
  document.getElementById('cfgTgChat').value = c.tgChatId || '';
});

document.getElementById('btnSave').addEventListener('click', () => {
  var cfg = {
    clientId: document.getElementById('cfgId').value.trim(),
    clientSecret: document.getElementById('cfgSecret').value.trim(),
    storeNames: document.getElementById('cfgStore').value.split(',').map(s => s.trim()).filter(Boolean),
    undercut: parseInt(document.getElementById('cfgUnder').value) || 10,
    margin: parseInt(document.getElementById('cfgMargin').value) || 20,
    tgToken: document.getElementById('cfgTgToken').value.trim(),
    tgChatId: document.getElementById('cfgTgChat').value.trim(),
  };
  chrome.storage.local.set({ config: cfg }, () => {
    var ok = document.getElementById('saveOk');
    ok.style.display = 'block';
    setTimeout(() => ok.style.display = 'none', 2000);
  });
});

// Telegram test
document.querySelector('.btn-test-tg').addEventListener('click', async () => {
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

// Load existing logs on open
chrome.storage.local.get(['logs', 'slogs'], (data) => {
  if (data.slogs) data.slogs.slice(-20).forEach(s => addSimpleLog(s.type, s.title, s.desc));
  if (data.logs) data.logs.slice(-50).forEach(m => addDetailLog(m));
});
