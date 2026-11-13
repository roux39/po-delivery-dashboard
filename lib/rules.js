// 붙여넣기 해석과 업로드 가공 규칙.
// 브라우저(public)와 서버가 같은 파일을 함께 쓴다. 단가 관련 열은 여기서 읽지 않는다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 날짜 / 숫자 ----------
  const pad = n => String(n).padStart(2, '0');
  function localISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayISO() { return localISO(new Date()); }
  function validYMD(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  function excelSerialToISO(n) {
    const ms = Math.round((n - 25569) * 864e5); // 1970-01-01 = 25569
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // 연도가 있는 날짜만 해석 (발주 파일용)
  function parseFullDate(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (/^\d{5}(\.\d+)?$/.test(s)) return excelSerialToISO(parseFloat(s));
    let m = s.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
    if (m) return validYMD(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); // 월/일/연도
    if (m) return validYMD(+m[3], +m[1], +m[2]);
    return null;
  }
  // 입고 메모용: "10/16 착(용차)" 처럼 연도 없는 날짜도 해석. 연도는 기준일로 추정.
  function parseLooseDate(s, refISO) {
    const full = parseFullDate(s);
    if (full) return full;
    const m = String(s || '').match(/(\d{1,2})\s*[/.월]\s*(\d{1,2})/);
    if (!m) return null;
    const ref = refISO || todayISO();
    const ry = +ref.slice(0, 4), rm = +ref.slice(5, 7);
    const mon = +m[1];
    let y = ry;
    if (mon > rm + 1) y -= 1;       // 기준월보다 2달 이상 뒤면 작년 (예: 1월에 붙여넣은 "12/28")
    else if (mon < rm - 10) y += 1; // 12월에 붙여넣은 "1/3"
    return validYMD(y, mon, +m[2]);
  }
  function parseNum(s) {
    const t = String(s == null ? '' : s).replace(/[,\s]/g, '');
    if (t === '' || isNaN(+t)) return null;
    return +t;
  }

  // ---------- 붙여넣기(탭 구분) 해석 ----------
  // 엑셀에서 복사하면 탭으로 나뉘고, 줄바꿈이 든 칸은 따옴표로 감싸진다.
  function parseTSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = String(text || '').replace(/\r\n?/g, '\n');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(x => x.trim()));
  }
  const norm = h => String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');

  // ---------- 발주 파일 ----------
  // 읽는 열 (이 목록에 없는 열은 버린다. 단가 관련 열은 일부러 넣지 않았다)
  const PO_COLS = {
    po: 'po number', type: 'purchase type', rowStatus: 'row status', currency: 'price currency',
    posting: 'posting date', delivery: 'delivery date', vendor: 'vendor name', vendorCode: 'vendor code',
    item: 'item no.', desc: 'item description', line: 'po line', qty: 'quantity',
    open: 'remaining open quantity', uom: 'purchasing uom',
  };
  const PO_REQUIRED = ['po', 'type', 'rowStatus', 'currency', 'posting', 'delivery', 'vendor', 'item', 'qty', 'open'];

  function findHeader(rows, must) {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const h = rows[i].map(norm);
      if (must.every(m => h.includes(m))) return i;
    }
    return -1;
  }
  function colIndex(headerRow, map) {
    const h = headerRow.map(norm), idx = {};
    for (const [k, name] of Object.entries(map)) idx[k] = h.indexOf(name); // 같은 이름이 여러 개면 첫 번째
    return idx;
  }

  // 붙여넣은 발주 내용 → 필요한 열만 담은 원본 줄 목록 (아직 규칙 적용 전)
  function extractPoRows(text) {
    const rows = parseTSV(text);
    const hi = findHeader(rows, ['po number', 'item no.']);
    if (hi < 0) return { error: '제목줄을 찾지 못했어요. "PO number", "Item No." 같은 제목줄까지 함께 복사해 주세요.' };
    const idx = colIndex(rows[hi], PO_COLS);
    const missing = PO_REQUIRED.filter(k => idx[k] < 0).map(k => PO_COLS[k]);
    if (missing.length) return { error: `필요한 열이 없어요: ${missing.join(', ')}` };
    const out = [];
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.every(c => !c)) continue;                       // 빈 줄
      if (norm(r[idx.po]) === 'po number') continue;          // 다시 나온 제목줄
      const o = {};
      for (const k of Object.keys(PO_COLS)) o[k] = idx[k] >= 0 ? (r[idx[k]] || '') : '';
      out.push(o);
    }
    return { rows: out };
  }

  function lineKey(r) { return [r.po, r.posting, r.delivery, r.item, r.vendor].join('|'); }

  // 사용자가 정한 업로드 규칙 적용
  //  ① 삭제: Purchase Type Indirect/공란, Row Status C/공란, Price Currency KRW 아님/공란
  //  ② 중복: PO number·Posting Date·Delivery Date·Item No.·Vendor Name 모두 같으면 중복 → 가장 최근(아래쪽) 줄만 남김
  function applyPoRules(raw) {
    const removed = { type: 0, status: 0, currency: 0, invalid: 0 };
    const invalidSamples = [];
    const closedKeys = [];   // Row Status = C 인 줄 (Closed 날짜 기록용)
    const map = new Map();
    let dupTotal = 0, dupChanged = 0;
    for (const r of raw) {
      const type = norm(r.type), st = norm(r.rowStatus), cur = norm(r.currency);
      const posting = parseFullDate(r.posting), delivery = parseFullDate(r.delivery);
      const qty = parseNum(r.qty), open = parseNum(r.open);
      const base = {
        po: String(r.po || '').trim(), item: String(r.item || '').trim(), vendor: String(r.vendor || '').trim(),
        posting, delivery,
      };
      if (!type || type === 'indirect') { removed.type++; continue; }
      if (!st || st === 'c') {
        removed.status++;
        if (st === 'c' && base.po && base.item && base.vendor && posting && delivery) closedKeys.push(lineKey(base));
        continue;
      }
      if (cur !== 'krw') { removed.currency++; continue; }
      if (!base.po || !base.item || !base.vendor || !posting || !delivery || qty == null || open == null) {
        removed.invalid++;
        if (invalidSamples.length < 5) invalidSamples.push(`PO ${base.po || '?'} / ${base.item || '?'}: ${!posting ? 'Posting Date 형식 확인' : !delivery ? 'Delivery Date 형식 확인' : '빈 칸 있음'}`);
        continue;
      }
      const row = {
        ...base, key: lineKey(base),
        vendorCode: String(r.vendorCode || '').trim(), desc: String(r.desc || '').trim(),
        line: String(r.line || '').trim(), uom: String(r.uom || '').trim(), qty, open,
      };
      const prev = map.get(row.key);
      if (prev) {
        dupTotal++;
        if (prev.qty !== row.qty || prev.open !== row.open || prev.line !== row.line || prev.desc !== row.desc) dupChanged++;
        map.delete(row.key); // 아래쪽(최근) 줄이 이긴다
      }
      map.set(row.key, row);
    }
    return { rows: [...map.values()], removed, invalidSamples, closedKeys, dupTotal, dupChanged };
  }

  // ---------- 거래명세서 입고 ----------
  const RC_COLS = {
    po: 'po number', vendorCode: 'vendor code', vendor: 'vendor name', item: 'item no.',
    qty: 'quantity', qty2: 'remaining open quantity', warehouse: 'warehouse', remark: 'po remark', remark2: '입고일',
  };
  // 붙여넣은 입고 내용 → 입고 줄 목록. 제목줄이 여러 번 나와도 되고, 합계줄·빈 줄은 건너뛴다.
  function extractReceipts(text, refISO) {
    const rows = parseTSV(text);
    let idx = null, skipped = 0;
    const out = [];
    for (const r of rows) {
      const h = r.map(norm);
      if (h.includes('po number') && h.includes('item no.')) { idx = colIndex(r, RC_COLS); skipped++; continue; }
      if (!idx) { skipped++; continue; }
      const get = k => (idx[k] >= 0 ? (r[idx[k]] || '') : '').trim();
      // 어떤 거래명세서 양식은 수량 열 제목이 "Remaining Open Quantity"로 되어 있다
      const po = get('po'), item = get('item'), qty = parseNum(get('qty') || get('qty2'));
      if (!/^\d{4,}$/.test(po) || !item || !qty) { skipped++; continue; }
      const remark = get('remark') || get('remark2');
      const date = parseLooseDate(remark, refISO);
      const note = remark.replace(/^\s*\d{1,4}[-./]\d{1,2}([-./]\d{1,4})?\s*/, '').trim();
      out.push({ po, vendorCode: get('vendorCode'), vendor: get('vendor'), item, qty, warehouse: get('warehouse'), date, note, remark });
    }
    if (!out.length && !idx) return { error: '제목줄을 찾지 못했어요. "PO number", "Item No." 제목줄까지 함께 복사해 주세요.', rows: [], skipped };
    return { rows: out, skipped };
  }

  return { todayISO, localISO, parseFullDate, parseLooseDate, parseNum, parseTSV, extractPoRows, applyPoRules, lineKey, extractReceipts };
});
