'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n == null || n === '' ? '' : Number(n).toLocaleString('ko-KR'));
const dayNum = s => Math.round(new Date(s + 'T00:00:00Z').getTime() / 864e5);

const st = { me: { editor: false }, lines: [], today: Rules.todayISO(), sort: { k: 'posting', dir: 1 }, quick: '', selId: null, receipts: [] };

async function call(method, url, body) {
  // GET이 아닌 요청은 서버가 JSON 형식만 받는다 (삭제·되돌리기 포함)
  const send = method !== 'GET';
  const r = await fetch(url, { method, headers: send ? { 'Content-Type': 'application/json' } : {}, body: send ? JSON.stringify(body || {}) : undefined });
  let data = {};
  try { data = await r.json(); } catch { /* 빈 응답 */ }
  if (!r.ok) {
    if (r.status === 401 && st.me.editor) { st.me.editor = false; renderWho(); }
    throw new Error(data.error || '처리 중 문제가 생겼어요.');
  }
  return data;
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 2600);
}

// ---------- 로그인 ----------
async function loadMe() {
  st.me = await call('GET', '/api/me');
  if (st.me.today) st.today = st.me.today;
  renderWho();
  if (st.me.needsSetup) openLogin(true);
}
function renderWho() {
  const m = st.me;
  $('#who').innerHTML = m.editor
    ? `<span>${esc(m.name)}</span><span class="badge">구매팀</span><button class="btn sm" id="logout">로그아웃</button>`
    : `<span class="small">조회 모드</span><button class="btn sm" id="loginbtn">구매팀 로그인</button>`;
  $$('.editor-only').forEach(el => el.hidden = !m.editor);
  const cur = $$('nav.tabs button').find(b => b.getAttribute('aria-selected') === 'true');
  if (cur && cur.hidden) showTab('dash');
  $('#last-up').textContent = m.lastPoUpload ? `SAP 발주 파일 마지막 업로드: ${m.lastPoUpload}` : 'SAP 발주 파일을 아직 올리지 않았어요.';
  if ($('#logout')) $('#logout').onclick = async () => { await call('POST', '/api/logout', {}); await loadMe(); renderTable(); };
  if ($('#loginbtn')) $('#loginbtn').onclick = () => openLogin(false);
}
let setupMode = false;
function openLogin(setup) {
  setupMode = setup;
  $('#login-title').textContent = setup ? '처음 설정: 구매팀 비밀번호 정하기' : '구매팀 로그인';
  $('#login-help').textContent = setup
    ? '처음 한 번만 정하면 돼요. 구매팀원은 이 비밀번호로 로그인해서 입력할 수 있고, 다른 부서는 로그인 없이 보기만 해요.'
    : '로그인하면 납기예정일 입력과 데이터 올리기를 할 수 있어요.';
  $('#lg-submit').textContent = setup ? '정하고 시작하기' : '로그인';
  $('#lg-pw').autocomplete = setup ? 'new-password' : 'current-password';
  $('#lg-msg').textContent = '';
  $('#login').hidden = false;
  $('#lg-name').focus();
}
$('#lg-cancel').onclick = () => { $('#login').hidden = true; };
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  try {
    await call('POST', setupMode ? '/api/setup' : '/api/login', { name: $('#lg-name').value, password: $('#lg-pw').value });
    $('#lg-pw').value = '';
    $('#login').hidden = true;
    await loadMe(); renderTable();
    toast(setupMode ? '비밀번호를 정했어요.' : '로그인했어요.');
  } catch (err) { $('#lg-msg').textContent = err.message; }
};

// ---------- 탭 ----------
function showTab(t) {
  $$('nav.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  for (const id of ['dash', 'upload', 'receipts', 'settings']) {
    const el = $('#tab-' + id);
    el.hidden = id !== t;
    if (id === t && (id === 'dash' || id === 'receipts')) el.style.display = 'flex';
  }
  if (t !== 'dash') closeDetail();
  if (t === 'receipts') loadReceipts();
  if (t === 'settings') loadUploads();
}
$$('nav.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- 대시보드 ----------
const due = l => l.eta || l.delivery;
function status(l) {
  if (l.closed_at) return 'Closed';
  if (l.open_qty <= 0) return '입고완료';
  if (dayNum(due(l)) < dayNum(st.today)) return '지연';
  if (l.open_qty < l.qty) return '부분입고';
  return '입고대기';
}
const PILL = { '지연': 'late', '부분입고': 'part', '입고대기': 'wait', '입고완료': 'done', 'Closed': 'done' };
const STATUS_ORDER = { '지연': 0, '부분입고': 1, '입고대기': 2, '입고완료': 3, 'Closed': 4 };
const inWeek = l => { const d = dayNum(due(l)) - dayNum(st.today); return !l.closed_at && l.open_qty > 0 && d >= 0 && d <= 7; };

async function loadLines() {
  const d = await call('GET', '/api/lines' + ($('#f-closed').checked ? '?closed=1' : ''));
  st.lines = d.lines;
  const sel = $('#f-vendor'), cur = sel.value;
  const vendors = [...new Set(st.lines.map(l => l.vendor))].sort((a, b) => a.localeCompare(b, 'ko'));
  sel.innerHTML = '<option value="">공급사 전체</option>' + vendors.map(v => `<option>${esc(v)}</option>`).join('');
  sel.value = vendors.includes(cur) ? cur : '';
  renderTable();
}
function filtered() {
  const q = $('#q').value.trim().toLowerCase(), v = $('#f-vendor').value, s = $('#f-status').value;
  return st.lines.filter(l => {
    if (q && !`${l.po} ${l.item} ${l.descr || ''} ${l.vendor} ${l.vendor_code || ''}`.toLowerCase().includes(q)) return false;
    if (v && l.vendor !== v) return false;
    if (s && status(l) !== s) return false;
    if (st.quick === 'late' && status(l) !== '지연') return false;
    if (st.quick === 'week' && !inWeek(l)) return false;
    if (st.quick === 'open' && (l.closed_at || l.open_qty <= 0)) return false;
    return true;
  });
}
function sortVal(l, k) {
  if (k === 'due') return due(l);
  if (k === 'status') return STATUS_ORDER[status(l)];
  if (k === 'posting') return `${l.posting}|${l.po}|${String(l.line).padStart(5, '0')}`;
  return l[k];
}
function renderTable() {
  const open = st.lines.filter(l => !l.closed_at);
  $('#s-late').textContent = open.filter(l => status(l) === '지연').length;
  $('#s-week').textContent = open.filter(inWeek).length;
  $('#s-open').textContent = open.filter(l => l.open_qty > 0).length;
  $$('.stat').forEach(b => b.classList.toggle('on', b.dataset.quick === st.quick));

  const { k, dir } = st.sort;
  const rows = filtered().sort((a, b) => {
    const x = sortVal(a, k), y = sortVal(b, k);
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
  $$('th.sortable').forEach(th => {
    th.textContent = th.textContent.replace(/ [▲▼]$/, '');
    if (th.dataset.sort === k) th.textContent += dir > 0 ? ' ▲' : ' ▼';
  });
  $('#count').textContent = `${rows.length}줄 / 전체 ${st.lines.length}줄`;
  const ed = st.me.editor;
  $('#rows').innerHTML = rows.map(l => {
    const s = status(l);
    const etaCell = ed && !l.closed_at
      ? `<input class="eta-input${l.eta ? ' changed' : ''}" type="date" value="${esc(l.eta || '')}" data-id="${l.id}" aria-label="납기예정일 입력">`
      : (l.eta ? `<span class="num eta-changed">${esc(l.eta)}</span>` : '<span class="eta-none">-</span>');
    return `<tr data-id="${l.id}" class="${st.selId === l.id ? 'sel' : ''}">
      <td class="num">${esc(l.po)}${l.is_new ? '<span class="flag new">신규</span>' : ''}</td>
      <td>${esc(l.vendor)}</td>
      <td class="num" title="${esc(l.descr || '')}">${esc(l.item)}</td>
      <td class="r num">${fmt(l.qty)}</td>
      <td class="r num"${l.pending ? ` title="SAP 잔량 ${fmt(l.sap_open)}에서 최근 입고를 뺀 값"` : ''}>${fmt(l.open_qty)}${l.pending ? '<span class="flag">SAP 반영 대기</span>' : ''}${l.check_msg ? `<span class="flag err" title="${esc(l.check_msg)}">확인 필요</span>` : ''}</td>
      <td class="num">${esc(l.delivery)}</td>
      <td>${etaCell}</td>
      <td><span class="pill ${PILL[s]}">${s}</span></td></tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">${st.lines.length ? '조건에 맞는 줄이 없어요. 필터를 초기화해 보세요.' : (st.me.editor ? '아직 발주 데이터가 없어요. "데이터 올리기" 탭에서 SAP 발주 목록을 붙여넣어 주세요.' : '아직 발주 데이터가 없어요. 구매팀이 SAP 발주 목록을 올리면 여기에 보여요.')}</td></tr>`;
}
$('#rows').addEventListener('click', e => {
  if (e.target.closest('input')) return;
  const tr = e.target.closest('tr[data-id]'); if (tr) openDetail(Number(tr.dataset.id));
});
$('#rows').addEventListener('change', async e => {
  const inp = e.target.closest('.eta-input'); if (!inp) return;
  const l = st.lines.find(x => x.id === Number(inp.dataset.id));
  if (!inp.value || inp.value === l.eta) { inp.value = l.eta || ''; return; }
  try {
    await call('POST', `/api/lines/${l.id}/eta`, { eta: inp.value, reason: '' });
    toast(`${l.po} / ${l.item} 납기예정일을 ${inp.value}로 바꿨어요.`);
    await loadLines();
  } catch (err) { toast(err.message); inp.value = l.eta || ''; }
});
$$('th.sortable').forEach(th => th.onclick = () => {
  const k = th.dataset.sort;
  st.sort = { k, dir: st.sort.k === k ? -st.sort.dir : 1 };
  renderTable();
});
['#q', '#f-vendor', '#f-status'].forEach(s => $(s).addEventListener('input', () => { st.quick = ''; renderTable(); }));
$('#f-closed').addEventListener('change', loadLines);
$('#reset').onclick = () => { $('#q').value = ''; $('#f-vendor').value = ''; $('#f-status').value = ''; st.quick = ''; renderTable(); };
$$('.stat').forEach(b => b.onclick = () => {
  $('#q').value = ''; $('#f-vendor').value = ''; $('#f-status').value = '';
  st.quick = st.quick === b.dataset.quick ? '' : b.dataset.quick;
  renderTable();
});

// ---------- 상세 ----------
function diffLabel(d1, target) {
  const d = dayNum(d1) - dayNum(target);
  if (d === 0) return '<span class="diff ontime">당일</span>';
  return d < 0 ? `<span class="diff early">${-d}일 빠름</span>` : `<span class="diff lateby">${d}일 늦음</span>`;
}
async function openDetail(id) {
  st.selId = id;
  $$('#rows tr').forEach(tr => tr.classList.toggle('sel', Number(tr.dataset.id) === id));
  let d;
  try { d = await call('GET', `/api/lines/${id}`); } catch (err) { toast(err.message); return; }
  const l = d.line;
  const li = { ...l, eta: d.eta.length ? d.eta[d.eta.length - 1].eta : null };
  const s = status(li), got = d.receipts.reduce((a, r) => a + r.qty, 0), latest = li.eta;
  $('#d-title').textContent = `${l.item}${l.descr ? ' · ' + l.descr : ''}`;
  $('#d-meta').innerHTML = `PO ${esc(l.po)}${l.line ? ' / Line ' + esc(l.line) : ''} · ${esc(l.vendor)} · 작성일 ${esc(l.posting)} · <span class="pill ${PILL[s]}">${s}</span>${l.closed_at ? ` <span class="small">(${esc(l.closed_at)} Closed)</span>` : ''}`;
  const ed = st.me.editor && !l.closed_at;
  const hist = [`<li><span class="tag">기존 납기일</span><div><span class="d">${esc(l.delivery)}</span><div class="why">SAP Delivery Date · 수정 불가</div></div><span></span></li>`]
    .concat(d.eta.map((e, i) => {
      const last = i === d.eta.length - 1;
      return `<li class="${last ? 'cur' : ''}"><span class="tag">${i + 1}차 변경</span><div><span class="d">${esc(e.eta)}</span>
        <div class="why">${esc(e.at.slice(0, 16))} · ${esc(e.by || '')}${e.reason ? ' · ' + esc(e.reason) : ''}</div></div>
        ${ed && last ? `<button class="btn sm danger" data-del-eta="${e.id}">되돌리기</button>` : '<span></span>'}</li>`;
    }));
  const pct = l.qty ? Math.max(0, Math.min(100, Math.round((l.qty - l.open_qty) / l.qty * 100))) : 0;
  const pending = d.receipts.some(r => !r.sap_ok);
  const rcRows = d.receipts.map(r => `<tr><td class="num">${esc(r.rdate)}${r.sap_ok ? '' : '<div><span class="flag" style="margin:0">SAP 반영 대기</span></div>'}</td><td class="r num">${fmt(r.qty)}${r.qty !== r.total_qty ? `<div class="small">전체 ${fmt(r.total_qty)} 중</div>` : ''}</td>
    <td>${diffLabel(r.rdate, l.delivery)}</td><td>${latest ? diffLabel(r.rdate, latest) : '<span class="small">-</span>'}</td>
    <td class="small">${esc(r.note)}${r.rc_po !== l.po ? `<div>명세서 PO ${esc(r.rc_po)}</div>` : ''}</td></tr>`).join('');
  $('#d-body').innerHTML = `
    <div class="kv">
      <div><div class="k">현재 발주 수량</div><div class="v">${fmt(l.qty)}</div></div>
      <div><div class="k">입고 기록 합계</div><div class="v">${fmt(got)}</div></div>
      <div><div class="k">현재 잔량</div><div class="v">${fmt(l.open_qty)}</div>${pending ? `<div class="small">SAP ${fmt(l.sap_open)}</div>` : ''}</div>
    </div>
    ${l.check_msg ? `<div class="checkbox"><b>확인 필요</b><span>${esc(l.check_msg)}</span><span class="small">공급사+품번(${esc(l.item)}) 전체 기준이에요. SAP와 입고 기록을 확인한 뒤 표시를 지워 주세요.</span>${st.me.editor ? '<button class="btn sm" id="chk-clear">확인했어요 · 표시 지우기</button>' : ''}</div>` : ''}
    <div class="section"><h3>입고 진행률 ${pct}%</h3><div class="bar"><i style="width:${pct}%"></i></div>
      ${pending ? `<p class="small" style="margin:6px 0 0">최근 입고를 SAP 잔량(${fmt(l.sap_open)})에서 바로 뺐어요. 다음에 SAP 발주 파일을 올릴 때 SAP에 반영됐는지 확인해요.</p>` : ''}</div>
    <div class="section"><h3>납기 변경 이력</h3><ul class="hist">${hist.join('')}</ul>
      ${ed ? `<form class="etaform" id="eta-form"><input type="date" id="eta-date" required aria-label="새 납기예정일"><input type="text" id="eta-why" placeholder="변경 사유 (선택)" maxlength="200"><button class="btn primary sm" type="submit">납기예정일 저장</button></form>` : ''}
    </div>
    <div class="section"><h3>날짜별 입고 (이 줄에 FIFO로 연결된 입고)</h3>
      ${d.receipts.length ? `<div class="tablebox free"><table><thead><tr><th>입고일</th><th class="r">수량</th><th>기존 납기 대비</th><th>최신 납기 대비</th><th>메모</th></tr></thead><tbody>${rcRows}</tbody></table></div>`
        : '<p class="small" style="margin:0">아직 연결된 입고 기록이 없어요.</p>'}
    </div>`;
  $('#drawer').hidden = false;
  const cc = $('#chk-clear');
  if (cc) cc.onclick = async () => {
    try { await call('DELETE', `/api/lines/${id}/check`); toast('확인 필요 표시를 지웠어요.'); await loadLines(); openDetail(id); }
    catch (err) { toast(err.message); }
  };
  const f = $('#eta-form');
  if (f) f.onsubmit = async e => {
    e.preventDefault();
    try { await call('POST', `/api/lines/${id}/eta`, { eta: $('#eta-date').value, reason: $('#eta-why').value }); toast('납기예정일을 저장했어요.'); await loadLines(); openDetail(id); }
    catch (err) { toast(err.message); }
  };
  $$('[data-del-eta]').forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = '한 번 더 누르면 되돌려요'; return; }
    try { await call('DELETE', `/api/eta/${b.dataset.delEta}`); toast('마지막 변경을 되돌렸어요.'); await loadLines(); openDetail(id); }
    catch (err) { toast(err.message); }
  });
}
function closeDetail() { $('#drawer').hidden = true; st.selId = null; $$('#rows tr').forEach(tr => tr.classList.remove('sel')); }
$('#d-close').onclick = closeDetail;
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDetail(); $('#login').hidden = true; } });

// ---------- 발주 붙여넣기 ----------
let poPending = null;
$('#po-clear').onclick = () => { $('#po-paste').value = ''; $('#po-result').innerHTML = ''; poPending = null; };
$('#po-check').onclick = () => {
  const ex = Rules.extractPoRows($('#po-paste').value);
  if (ex.error) { $('#po-result').innerHTML = `<span class="err">${esc(ex.error)}</span>`; return; }
  poPreview(ex.rows, '');
};
async function poPreview(rows, source) {
  const box = $('#po-result');
  if (!rows.length) { box.innerHTML = '<span class="err">발주 줄이 없어요.</span>'; return; }
  const fullList = $('#po-full').checked;
  box.innerHTML = '<span class="small">확인하는 중…</span>';
  try {
    const { summary: s } = await call('POST', '/api/po', { rows, fullList, dryRun: true });
    poPending = { rows, fullList };
    box.innerHTML = (source ? `<span class="small">파일: ${esc(source)}</span>` : '') + poSummaryHtml(s, true) +
      `<div class="btnrow"><button class="btn primary" id="po-save">이대로 저장</button><span class="small">저장 전에는 아무것도 바뀌지 않아요.</span></div>`;
    $('#po-save').onclick = savePo;
  } catch (err) { box.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
}
// 전체 목록 체크를 바꾸면 미리보기를 다시 계산
$('#po-full').onchange = () => { if (poPending) poPreview(poPending.rows, ''); };
function poSummaryHtml(s, preview) {
  const r = s.removed;
  return `<span class="${preview ? 'warn' : 'ok'}">${preview ? '저장하면 이렇게 반영돼요.' : '저장했어요.'}</span>
    <div class="summary">
      <span>붙여넣은 줄</span><b>${fmt(s.received)}</b>
      <span>삭제 · Purchase Type</span><b>${fmt(r.type)}</b>
      <span>삭제 · Row Status</span><b>${fmt(r.status)}</b>
      <span>삭제 · Price Currency</span><b>${fmt(r.currency)}</b>
      ${r.invalid ? `<span>제외 · 날짜/칸 오류</span><b>${fmt(r.invalid)}</b>` : ''}
      <span>중복 제외 (그중 내용이 달라 최근 것 적용)</span><b>${fmt(s.dupTotal)} (${fmt(s.dupChanged)})</b>
      <span>대시보드에 반영될 줄</span><b>${fmt(s.kept)}</b>
      <span>└ 새로 들어온 발주</span><b>${fmt(s.added)}</b>
      <span>└ 수량·잔량이 바뀐 줄</span><b>${fmt(s.changed)}</b>
      <span>└ 변화 없음</span><b>${fmt(s.unchanged)}</b>
      ${s.reopened ? `<span>└ 다시 열린 줄 (Closed였던 줄)</span><b>${fmt(s.reopened)}</b>` : ''}
      <span>Closed 처리 · Row Status C</span><b>${fmt(s.closedByStatus)}</b>
      <span>Closed 처리 · 목록에 없음</span><b>${fmt(s.closedByMissing)}</b>
    </div>
    ${sapCheckHtml(s)}
    ${s.invalidSamples && s.invalidSamples.length ? `<span class="warn">날짜/칸 오류 예: ${s.invalidSamples.map(esc).join(' / ')}</span>` : ''}
    ${s.closedByMissing ? `<span class="small">목록에 없어서 Closed 처리될 줄: ${s.missingSamples.map(esc).join(', ')}${s.closedByMissing > s.missingSamples.length ? ' 외' : ''}</span>` : ''}`;
}
// 기존 현황판(A)과 이번 SAP 목록(B) 잔량 비교 결과
function sapCheckHtml(s) {
  if (!s.checks) return '';
  const err = s.checks.filter(c => c.result === 'error'), wait = s.checks.filter(c => c.result === 'wait');
  const row = c => `<tr><td>${esc(c.vendor)}</td><td class="num">${esc(c.item)}</td><td class="r num">${fmt(c.viewOpen)}</td><td class="r num">${fmt(c.sapOpen)}</td>
    <td class="r num">${c.diff > 0 ? '+' : ''}${fmt(c.diff)}</td>
    <td>${c.result === 'error' ? '<span class="flag err" style="margin:0">확인 필요</span>'
      : `<span class="flag" style="margin:0">SAP 반영 대기</span><div class="small">${c.receipts.map(r => `${esc(r.date)} 입고 ${fmt(r.qty)}`).join(', ')}</div>`}</td></tr>`;
  return `<div class="summary" style="grid-template-columns:1fr auto">
      <span>SAP 잔량 비교 · 새 발주 (PO number + Line 기준)</span><b>${fmt(s.newByPoLine)}</b>
      <span>SAP 잔량 비교 · 일치 (입고가 SAP에 반영됨)</span><b>${fmt(s.sapConfirmed)}건 입고 확인</b>
      <span>SAP 잔량 비교 · 아직 SAP 반영 대기 (최근 ${2}일 입고와 차이 일치)</span><b>${fmt(wait.length)}품번</b>
      <span>SAP 잔량 비교 · 확인 필요</span><b>${fmt(err.length)}품번</b>
    </div>
    ${s.checks.length ? `<div class="tablebox free"><table class="checktable"><thead><tr><th>공급사</th><th>품번</th><th class="r">현황판 잔량</th><th class="r">SAP 잔량</th><th class="r">차이</th><th>판단</th></tr></thead>
      <tbody>${err.concat(wait).map(row).join('')}</tbody></table></div>
      ${err.length ? '<span class="warn">"확인 필요" 품번은 저장 후 대시보드에 빨간 표시가 붙어요. SAP 잔량이 더 적으면 현황판에 등록 안 된 입고나 이중 입고, 더 많으면 최근 입고 기록과 맞지 않는 경우예요.</span>' : ''}`
      : '<span class="ok">기존 발주의 잔량이 현황판과 모두 일치해요.</span>'}`;
}
async function savePo() {
  if (!poPending) return;
  const box = $('#po-result');
  try {
    const { summary } = await call('POST', '/api/po', poPending);
    poPending = null;
    $('#po-paste').value = '';
    box.innerHTML = poSummaryHtml(summary, false);
    await loadMe(); await loadLines();
    toast('발주 목록을 반영했어요.');
  } catch (err) { box.innerHTML += `<span class="err">${esc(err.message)}</span>`; }
}

// ---------- 입고 붙여넣기 ----------
let rcPending = null;
$('#rc-clear').onclick = () => { $('#rc-paste').value = ''; $('#rc-result').innerHTML = ''; rcPending = null; rcReview = null; $('#rc-result').closest('.card').classList.remove('wide'); };
$('#rc-check').onclick = () => {
  const box = $('#rc-result');
  const ex = Rules.extractReceipts($('#rc-paste').value, st.today);
  if (ex.error) { box.innerHTML = `<span class="err">${esc(ex.error)}</span>`; return; }
  if (!ex.rows.length) { box.innerHTML = '<span class="err">입고 줄을 찾지 못했어요. PO number, Item No., Quantity가 있는 줄인지 확인해 주세요.</span>'; return; }
  rcPending = ex.rows;
  const noDate = ex.rows.filter(r => !r.date).length;
  box.innerHTML = `<span class="ok">입고 ${ex.rows.length}줄을 찾았어요.</span>
    <span class="small">제목줄·합계줄·빈 줄 ${ex.skipped}줄은 건너뛰었어요. 단가 관련 열은 읽지 않았어요.</span>
    ${noDate ? `<span class="warn">입고일을 읽지 못한 줄이 ${noDate}개 있어요. 빨간 칸에 날짜를 넣어 주세요.</span>` : ''}
    <div class="tablebox"><table><thead><tr><th>입고일</th><th>PO number</th><th>Vendor name</th><th>Item No.</th><th class="r">수량</th><th>메모</th></tr></thead><tbody>
    ${ex.rows.map((r, i) => `<tr><td>${r.date ? `<span class="num">${r.date}</span>` : `<input type="date" data-i="${i}" aria-label="입고일 입력">`}</td>
      <td class="num">${esc(r.po)}</td><td>${esc(r.vendor)}</td><td class="num">${esc(r.item)}</td><td class="r num">${fmt(r.qty)}</td><td class="small">${esc(r.remark)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="btnrow"><button class="btn primary" id="rc-save">이대로 저장</button></div>`;
  $$('#rc-result input[type=date]').forEach(inp => inp.onchange = () => { rcPending[Number(inp.dataset.i)].date = inp.value || null; });
  $('#rc-save').onclick = saveReceipts;
};
async function saveReceipts() {
  const box = $('#rc-result');
  if (rcPending.some(r => !r.date)) { toast('입고일이 빈 줄이 있어요. 빨간 칸에 날짜를 넣어 주세요.'); return; }
  try {
    const rows = rcPending.map(({ remark, ...r }) => r);
    const { result: r } = await call('POST', '/api/receipts', { rows });
    rcPending = null; $('#rc-paste').value = '';
    box.innerHTML = `<span class="ok">입고 ${r.added}줄을 저장했어요.</span>
      ${r.duplicates ? `<span class="small">이미 등록된 입고 ${r.duplicates}줄은 건너뛰었어요.</span>` : ''}
      ${r.unmatched ? `<span class="warn">${r.unmatched}줄은 맞는 발주 줄을 찾지 못했거나 수량이 남아요. "입고 기록" 탭에서 확인할 수 있어요.</span>` : ''}
      ${r.deducted ? `<span class="small">입고 ${r.deducted}줄을 대시보드 잔량에서 바로 뺐어요. ('SAP 반영 대기' 표시)</span>` : ''}`;
    await loadLines();
    toast('입고를 저장했어요.');
  } catch (err) { box.innerHTML += `<span class="err">${esc(err.message)}</span>`; }
}

// ---------- 엑셀·PDF 파일 올리기 ----------
function fileB64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('파일을 열지 못했어요.'));
    fr.readAsDataURL(file);
  });
}
const sendFile = async (file, purpose) => call('POST', '/api/file', { purpose, name: file.name, data: await fileB64(file) });

$$('.filedrop').forEach(zone => {
  const input = document.getElementById(zone.dataset.for);
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) input.onchange({ target: { files: e.dataTransfer.files } }); };
});

$('#po-file').onchange = async e => {
  const file = e.target.files[0]; $('#po-file').value = '';
  if (!file) return;
  const box = $('#po-result');
  box.innerHTML = `<span class="small">${esc(file.name)} 읽는 중…</span>`;
  try {
    const r = await sendFile(file, 'po');
    $('#po-paste').value = '';
    poPreview(r.rows, `${file.name} (${r.sheet} 시트)`);
  } catch (err) { box.innerHTML = `<span class="err">${esc(file.name)}: ${esc(err.message)}</span>`; }
};

// 거래명세서 파일 → 확인·수정 표
let rcReview = null; // {rows:[{date,vendor,item,qty,po,checks,known,file,on}], vendors:[]}
$('#rc-file').onchange = async e => {
  const files = [...e.target.files]; $('#rc-file').value = '';
  if (!files.length) return;
  const box = $('#rc-result');
  rcPending = null;
  const rows = [], errors = [];
  let vendors = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    box.innerHTML = `<span class="small">${esc(f.name)} 읽는 중… (${i + 1}/${files.length})${/\.pdf$/i.test(f.name) ? ' PDF는 글자를 인식하느라 조금 걸려요.' : ''}</span>`;
    try {
      const r = await sendFile(f, 'receipt');
      if (r.vendors) vendors = r.vendors;
      if (!r.rows.length) errors.push(`${f.name}: 입고 줄을 찾지 못했어요.`);
      for (const x of r.rows) rows.push({
        date: x.date || '', vendor: x.vendor || '', item: x.item || '', qty: x.qty || '', po: x.po || '',
        vendorCode: x.vendorCode || '', warehouse: x.warehouse || '', note: x.note || '',
        checks: x.checks || [], known: x.known !== false, file: f.name, on: true,
      });
    } catch (err) { errors.push(`${f.name}: ${err.message}`); }
  }
  rcReview = { rows, vendors, errors };
  renderReview();
};

function renderReview() {
  const box = $('#rc-result');
  const { rows, vendors, errors } = rcReview;
  const err = errors.map(m => `<span class="err">${esc(m)}</span>`).join('');
  if (!rows.length) { box.innerHTML = err || '<span class="err">입고 줄을 찾지 못했어요.</span>'; return; }
  const opts = v => {
    const list = vendors.includes(v) || !v ? vendors : [v, ...vendors];
    return `<option value="">공급사 선택</option>` + list.map(n => `<option${n === v ? ' selected' : ''}>${esc(n)}</option>`).join('');
  };
  const files = new Set(rows.map(r => r.file));
  box.closest('.card').classList.add('wide');
  box.innerHTML = `${err}
    <span class="ok">입고 ${rows.length}줄을 찾았어요.</span>
    <span class="warn">파일에서 자동으로 읽은 값이에요. 저장 전에 <b>입고일·공급사·품번·수량</b>이 맞는지 확인하고, 틀린 칸은 고쳐 주세요. 필요 없는 줄은 체크를 풀면 저장하지 않아요.</span>
    <span class="small">단가·금액은 읽어 오지도, 저장하지도 않아요.</span>
    <div class="tablebox"><table class="review"><thead><tr><th></th><th>입고일</th><th>공급사</th><th>품번</th><th class="r">수량</th><th>PO</th><th>확인할 점</th>${files.size > 1 ? '<th>파일</th>' : ''}</tr></thead><tbody>
    ${rows.map((r, i) => `<tr data-i="${i}" class="${r.on ? '' : 'off'}">
      <td><input type="checkbox" data-k="on" ${r.on ? 'checked' : ''} aria-label="저장할 줄"></td>
      <td><input type="date" data-k="date" value="${esc(r.date)}" class="num ${r.date ? '' : 'bad'}" aria-label="입고일"></td>
      <td><select data-k="vendor" class="${r.vendor && vendors.includes(r.vendor) ? '' : 'bad'}" aria-label="공급사">${opts(r.vendor)}</select></td>
      <td><input data-k="item" value="${esc(r.item)}" class="num item ${r.known ? '' : 'bad'}" list="rc-items" aria-label="품번"></td>
      <td class="r"><input type="number" data-k="qty" value="${esc(r.qty)}" min="0" class="num ${r.qty > 0 && !r.checks.includes('수량 확인') ? '' : 'bad'}" aria-label="수량"></td>
      <td><input data-k="po" value="${esc(r.po)}" class="num po" placeholder="없으면 비움" aria-label="PO 번호"></td>
      <td class="chk">${r.checks.map(esc).join('<br>')}</td>
      ${files.size > 1 ? `<td class="small">${esc(r.file)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>
    <span class="small">빨간 칸 = 확인이 필요한 칸. 품번은 SAP 발주에 있는 품번과 맞춰 보고, 공급사+품번이 같은 발주 줄에 PO 작성일 순서로 연결돼요.</span>
    <div class="btnrow"><button class="btn primary" id="rv-save">이대로 저장</button><button class="btn" id="rv-cancel">취소</button></div>`;
  $$('#rc-result .review [data-k]').forEach(el => {
    el.onchange = () => {
      const r = rows[Number(el.closest('tr').dataset.i)], k = el.dataset.k;
      if (k === 'on') { r.on = el.checked; el.closest('tr').classList.toggle('off', !r.on); return; }
      r[k] = k === 'qty' ? Number(el.value) : el.value.trim();
      if (k === 'qty') r.checks = r.checks.filter(c => c !== '수량 확인');
      el.classList.toggle('bad', k === 'date' ? !r.date : k === 'vendor' ? !r.vendor : k === 'qty' ? !(r.qty > 0) : false);
    };
  });
  $('#rv-cancel').onclick = () => { rcReview = null; box.innerHTML = ''; box.closest('.card').classList.remove('wide'); };
  $('#rv-save').onclick = saveReview;
  loadItemList();
}
async function loadItemList() {
  if ($('#rc-items')) return;
  const dl = document.createElement('datalist'); dl.id = 'rc-items';
  dl.innerHTML = [...new Set(st.lines.map(l => l.item))].sort().map(v => `<option value="${esc(v)}">`).join('');
  document.body.append(dl);
}
async function saveReview() {
  const box = $('#rc-result');
  const rows = rcReview.rows.filter(r => r.on);
  if (!rows.length) { toast('저장할 줄이 없어요.'); return; }
  const bad = rows.find(r => !r.date || !r.vendor || !r.item || !(r.qty > 0));
  if (bad) { toast('입고일·공급사·품번·수량이 빈 줄이 있어요. 빨간 칸을 채워 주세요.'); return; }
  try {
    const { result: r } = await call('POST', '/api/receipts', {
      rows: rows.map(x => ({ po: x.po, vendorCode: x.vendorCode, vendor: x.vendor, item: x.item, qty: x.qty, warehouse: x.warehouse, date: x.date, note: x.note || `파일: ${x.file}` })),
    });
    rcReview = null;
    box.innerHTML = `<span class="ok">입고 ${r.added}줄을 저장했어요.</span>
      ${r.duplicates ? `<span class="small">이미 등록된 입고 ${r.duplicates}줄은 건너뛰었어요.</span>` : ''}
      ${r.unmatched ? `<span class="warn">${r.unmatched}줄은 맞는 발주 줄을 찾지 못했거나 수량이 남아요. "입고 기록" 탭에서 확인할 수 있어요.</span>` : ''}
      ${r.deducted ? `<span class="small">입고 ${r.deducted}줄을 대시보드 잔량에서 바로 뺐어요. ('SAP 반영 대기' 표시)</span>` : ''}`;
    await loadLines();
    toast('입고를 저장했어요.');
  } catch (err) { toast(err.message); }
}

// ---------- 입고 기록 ----------
async function loadReceipts() {
  try { st.receipts = (await call('GET', '/api/receipts')).receipts; renderReceipts(); } catch (err) { toast(err.message); }
}
function renderReceipts() {
  const q = $('#rq').value.trim().toLowerCase();
  const rows = st.receipts.filter(r => !q || `${r.po} ${r.item} ${r.vendor}`.toLowerCase().includes(q));
  $('#rcount').textContent = `${rows.length}줄`;
  const ed = st.me.editor;
  $('#rrows').innerHTML = rows.map(r => `<tr>
    <td class="num">${esc(r.rdate)}</td><td class="num">${esc(r.po)}</td><td>${esc(r.vendor)}</td><td class="num">${esc(r.item)}</td>
    <td class="r num">${fmt(r.qty)}</td><td class="small">${esc(r.note)}</td>
    <td>${r.left_qty > 0 ? `<span class="pill part">${r.alloc_count ? fmt(r.left_qty) + ' 남음' : '연결 안 됨'}</span>` : '<span class="pill done">연결됨</span>'}</td>
    <td>${r.sap_ok ? '<span class="pill done">SAP 반영됨</span>' : '<span class="pill part" title="대시보드 잔량에서 이 입고를 빼고 있어요">반영 대기</span>'}</td>
    <td class="small">${esc(r.created_at.slice(0, 16))} ${esc(r.created_by)}</td>
    ${ed ? `<td style="white-space:nowrap"><button class="btn sm" data-sap="${r.id}" data-ok="${r.sap_ok ? 0 : 1}">${r.sap_ok ? '잔량에서 다시 빼기' : 'SAP 반영됨으로'}</button> <button class="btn sm danger" data-del="${r.id}">삭제</button></td>` : ''}</tr>`).join('')
    || `<tr><td colspan="10" class="empty">입고 기록이 없어요.</td></tr>`;
  $$('#rrows [data-sap]').forEach(b => b.onclick = async () => {
    try { await call('POST', `/api/receipts/${b.dataset.sap}/sap`, { ok: b.dataset.ok === '1' }); await loadReceipts(); loadLines(); }
    catch (err) { toast(err.message); }
  });
  $$('#rrows [data-del]').forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = '정말 삭제'; return; }
    try { await call('DELETE', `/api/receipts/${b.dataset.del}`); toast('입고 기록을 삭제했어요.'); await loadReceipts(); loadLines(); }
    catch (err) { toast(err.message); }
  });
}
$('#rq').addEventListener('input', renderReceipts);

// ---------- 설정 ----------
$('#pw-form').onsubmit = async e => {
  e.preventDefault();
  try { await call('POST', '/api/password', { current: $('#pw-cur').value, next: $('#pw-new').value }); $('#pw-cur').value = ''; $('#pw-new').value = ''; $('#pw-msg').textContent = ''; toast('비밀번호를 바꿨어요.'); }
  catch (err) { $('#pw-msg').textContent = err.message; }
};
async function loadUploads() {
  try {
    const { uploads } = await call('GET', '/api/uploads');
    $('#uprows').innerHTML = uploads.map(u => {
      const s = u.summary;
      const txt = u.kind === 'po' ? `반영 ${fmt(s.kept)}줄 · 신규 ${fmt(s.added)} · 변경 ${fmt(s.changed)} · Closed ${fmt((s.closedByStatus || 0) + (s.closedByMissing || 0))}`
        : `입고 ${fmt(s.added)}줄 저장${s.duplicates ? ` · 중복 ${s.duplicates}` : ''}`;
      return `<tr><td class="num">${esc(u.at.slice(0, 16))}</td><td>${u.kind === 'po' ? '발주' : '입고'}</td><td>${esc(u.by)}</td><td class="small">${txt}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="empty">아직 올린 기록이 없어요.</td></tr>';
  } catch (err) { toast(err.message); }
}

// ---------- 시작 ----------
(async () => {
  try { await loadMe(); await loadLines(); }
  catch (err) { $('#rows').innerHTML = `<tr><td colspan="8" class="empty">서버에 연결하지 못했어요. 현황판 프로그램이 켜져 있는지 확인해 주세요. (${esc(err.message)})</td></tr>`; }
  setInterval(() => { if ($('#drawer').hidden && !$('#tab-dash').hidden && document.activeElement.tagName !== 'INPUT') loadLines().catch(() => {}); }, 60000);
})();
