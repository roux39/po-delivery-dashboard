// 공급사 거래명세서(엑셀 양식 / PDF·스캔 글자인식 결과)에서 입고 줄을 찾아낸다.
// 업체마다 양식이 달라서 "제목줄(수량·품번·단가…) 위치"와 "SAP 발주에 있는 품번·공급사"를 기준으로 맞춘다.
// 단가·금액은 수량을 구분하는 데에만 잠깐 쓰고 결과에는 절대 담지 않는다.
'use strict';
const Rules = require('./rules');

// 우리 회사(공급받는자) 이름: 거래명세서의 공급사 후보에서 뺀다.
// data/buyer-names.txt 에 한 줄에 하나씩 적는다 (정규식 가능, # 은 메모). 회사 정보라 코드에는 넣지 않는다.
function loadBuyer() {
  const fs = require('fs'), path = require('path');
  try {
    const pats = fs.readFileSync(path.join(__dirname, '..', 'data', 'buyer-names.txt'), 'utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    if (pats.length) return new RegExp(pats.join('|'), 'i');
  } catch { /* 파일이 없으면 빼지 않음 */ }
  return /(?!)/;
}
const BUYER = loadBuyer();
const normName = s => String(s || '')
  .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|co\.?,?\s*ltd\.?|inc\.?|corp\.?/gi, '')
  .replace(/[\s\-_.,()[\]{}'"·:]/g, '').toLowerCase();
const normItem = s => String(s || '').toUpperCase().replace(/[—–]/g, '-').replace(/\s+/g, '').replace(/^[[(]+|[\])]+$/g, '');
const hasDigit = s => /\d/.test(s), hasAlpha = s => /[A-Z]/i.test(s);
const codeLike = t => t.length >= 7 && /[-_]/.test(t) && hasDigit(t) && hasAlpha(t) && /^[A-Z0-9][A-Z0-9\-_./]*$/i.test(t);

// 글자인식에서 자주 헷갈리는 글자는 싸게 친다
const CONF = ['0ODQ', '1IL', '5S', '8B', '2Z', '6G', '-_'];
const subCost = (a, b) => a === b ? 0 : (CONF.some(g => g.includes(a) && g.includes(b)) ? 0.3 : 1);
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + subCost(a[i - 1], b[j - 1]));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return Infinity;
    prev = cur;
  }
  return prev[b.length];
}

// 숫자 칸: "1,000" "1.000"(천 단위 점) "832.00"
function numOf(t) {
  t = String(t).trim();
  if (!/^[\d][\d,.\s]*$/.test(t)) return null;
  t = t.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return Rules.parseNum(t);
}

// ---------- 참고 목록 (SAP 발주에 있는 품번·공급사·PO) ----------
function makeRefs(lines) {
  const items = new Map();   // 정규화 품번 → {item, vendors:Set}
  const vendors = new Map(); // 정규화 이름 → 원래 이름
  const pos = new Set();
  for (const l of lines || []) {
    const k = normItem(l.item);
    if (!items.has(k)) items.set(k, { item: l.item, vendors: new Set() });
    items.get(k).vendors.add(l.vendor);
    if (l.vendor) vendors.set(normName(l.vendor), l.vendor);
    if (l.po) pos.add(String(l.po));
  }
  return { items, vendors, pos };
}
function matchItem(raw, refs, vendor) {
  const k = normItem(raw);
  if (refs.items.has(k)) return { item: refs.items.get(k).item, exact: true };
  if (k.length < 6) return null;
  let best = null, bestD = Infinity, second = Infinity;
  for (const [key, v] of refs.items) {
    if (vendor && !v.vendors.has(vendor)) continue;
    const d = editDist(k, key, 1.5);
    if (d < bestD) { second = bestD; bestD = d; best = v.item; } else if (d < second) second = d;
  }
  return best && bestD <= 1.2 && second - bestD >= 0.5 ? { item: best, exact: false } : null;
}

// ---------- 날짜 ----------
const DATE_RE = /(20\d{2})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})/;
function validDate(y, m, d, today) {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = Date.parse(iso), now = Date.parse(today);
  if (isNaN(t) || +m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  return t >= now - 400 * 864e5 && t <= now + 31 * 864e5 ? iso : null;
}
const LABEL = /일\s*자|날\s*짜|date|출고|거래|작성|발행|납품|년/i;
function findDate(lineTexts, headerIdx, today) {
  const cands = [];
  lineTexts.forEach((t, i) => {
    t = t.replace(/\s*\|\s*/g, ' '); // 칸 사이가 벌어져 "2026년 | 11월 | 12일" 처럼 나뉜 경우
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(t.trim()) ? t.trim() : null;
    const label = LABEL.test(t) || (i > 0 && LABEL.test(lineTexts[i - 1]));
    for (const m of t.matchAll(new RegExp(DATE_RE, 'g'))) {
      const v = validDate(m[1], m[2], m[3], today);
      if (v) cands.push({ v, i, label });
    }
    // 20261113 처럼 붙여 쓴 날짜
    for (const m of t.matchAll(/(?<![\d-])(20\d{2})(\d{2})(\d{2})(?![\d-])/g)) {
      const v = validDate(m[1], m[2], m[3], today);
      if (v) cands.push({ v, i, label });
    }
    if (iso) cands.push({ v: iso, i, label: false });
  });
  const top = cands.filter(c => headerIdx < 0 || c.i < headerIdx);
  const pick = top.find(c => c.label) || top[0] || cands.find(c => c.label) || cands[0];
  return pick ? pick.v : null;
}
function dateFromName(name, today) {
  const s = String(name || '');
  let m = s.match(DATE_RE);
  if (m) { const v = validDate(m[1], m[2], m[3], today); if (v) return v; }
  m = s.match(/(?<!\d)(2\d)(0[1-9]|1[0-2])([0-2]\d|3[01])(?!\d)/);
  if (m) { const v = validDate('20' + m[1], m[2], m[3], today); if (v) return v; }
  m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) return Rules.parseLooseDate(`${m[1]}/${m[2]}`, today);
  return null;
}

// ---------- 공급사 ----------
function findVendor(lineTexts, refs) {
  const raws = [];
  for (const t of lineTexts) {
    for (const m of t.matchAll(/상\s*호\s*(?:\(법인명\))?\s*[|:]?\s*([^|]+)/g)) {
      const v = m[1].replace(/\s*(성\s*명|대\s*표).*$/, '').trim();
      if (v && !BUYER.test(v)) raws.push(v);
    }
  }
  const all = normName(lineTexts.filter(t => !BUYER.test(t) || raws.some(r => t.includes(r))).join(' '));
  let byName = null;
  for (const [nv, name] of refs.vendors) {
    if (nv.length >= 2 && all.includes(nv) && (!byName || nv.length > normName(byName).length)) byName = name;
  }
  if (!byName) for (const r of raws) {
    const nr = normName(r);
    for (const [nv, name] of refs.vendors) if (nr.length >= 2 && nv.includes(nr)) { byName = name; break; }
    if (byName) break;
  }
  return { byName, raw: raws[0] || '' };
}

// ---------- 제목줄 ----------
const HDR = {
  qty: /수량|qty|quantity/i,
  price: /단가|unitprice|^price/i,
  amount: /금액|공급가|amount/i,
  item: /품번|자재코드|품목코드|부품번호|partno|itemno|품목|품명|item/i,
  po: /발주번호|발주no|po번호|^po$|ponumber|ponumber|주문번호/i,
};
function headerOf(cells) {
  const found = {};
  for (const c of cells) {
    const n = c.t.replace(/\s/g, '');
    if (!n || n.length > 14) continue;
    for (const k of Object.keys(HDR)) {
      if (found[k]) continue;
      if (k === 'qty' && /잔|단가/.test(n)) continue;
      if (k === 'item' && /사내|규격/.test(n) && !/품번/.test(n)) continue;
      if (HDR[k].test(n)) { found[k] = c; break; }
    }
  }
  const kinds = ['qty', 'price', 'amount', 'item'].filter(k => found[k]).length;
  return kinds >= 2 ? found : null;
}
const center = c => c.x + c.w / 2;

// rows: [{cells:[{t,x,w}], words:[{t,x,w}], y, h}]  (엑셀은 cells=words)
function extract(rows, refs, { today, fileName }) {
  const texts = rows.map(r => r.cells.map(c => c.t).join(' | '));
  let headerIdx = -1, hdr = null, hdrCells = [];
  const blocks = [];
  let block = null;

  // 글자인식에서 줄바꿈으로 잘린 품번("..._AB12-" + "345CD")과 숫자 줄을 합친다
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (const w of r.words) {
      if (!/[-_]$/.test(w.t) || !hasAlpha(w.t)) continue;
      for (let j = i + 1; j < Math.min(rows.length, i + 3); j++) {
        const n = rows[j];
        if (r.h && n.y - r.y > r.h * 3.5) break;
        const k = n.words.findIndex(x => Math.abs(x.x - w.x) < Math.max(r.h || 0, 30) * 2 && /^[A-Z0-9][A-Z0-9\-_]*$/i.test(x.t));
        if (k >= 0) { w.t += n.words[k].t; n.words.splice(k, 1); n.cells = n.cells.filter(c => c.t.trim() !== '' && n.words.some(x => x.x >= c.x && x.x < c.x + c.w)); break; }
      }
    }
  }
  for (let i = 0; i + 1 < rows.length; i++) {
    const r = rows[i], n = rows[i + 1];
    if (!r.h) break;
    const codes = r.words.some(w => codeLike(normItem(w.t)));
    const nums = ws => ws.some(w => numOf(w.t) !== null);
    if (codes && !nums(r.words) && nums(n.words) && !n.words.some(w => codeLike(normItem(w.t))) && n.y - r.y < r.h * 2.5) {
      r.words = r.words.concat(n.words).sort((a, b) => a.x - b.x);
      n.words = []; n.cells = [];
    }
  }

  const vendorInfo = findVendor(texts, refs);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.words.length) continue;
    const h = headerOf(r.cells);
    if (h) {
      hdr = h; hdrCells = r.cells.filter(c => c.t.trim()); if (headerIdx < 0) headerIdx = i;
      block = { rows: [] }; blocks.push(block);
      continue;
    }
    // 품번 찾기
    let itemTok = null, itemHit = null;
    const toks = [];
    const addTok = (t, src) => { t = normItem(t); if (t && !toks.some(k => k.t === t)) toks.push({ t, x: src.x, w: src.w }); };
    for (const w of r.words) for (const t of w.t.split(/[\s[\](){}|,]+/).filter(Boolean)) {
      addTok(t, w);
      if (t.includes('_')) for (const part of t.split('_')) if (part.length >= 6) addTok(part, w);
    }
    // "XY-1234A B5" → XY-1234A-B5 / XY-1234AB5 도 맞춰 본다
    for (const c of r.cells) {
      const inner = c.t.replace(/^.*\[\s*|\s*\].*$/g, '').trim();
      if (/\s/.test(inner) && inner.length <= 30) { addTok(inner.replace(/\s+/g, '-'), c); addTok(inner.replace(/\s+/g, ''), c); }
    }
    for (const tk of toks) {
      const m = matchItem(tk.t, refs, vendorInfo.byName) || matchItem(tk.t, refs, null);
      if (m && (!itemHit || (m.exact && !itemHit.exact))) { itemHit = m; itemTok = tk; }
    }
    if (!itemHit) {
      if (!hdr) continue;
      // SAP 품번 모양(ABCDE-12345)을 먼저 고른다
      const shape = t => (/^[A-Z0-9]{3,6}-[A-Z0-9]{3,6}$/.test(t) ? 0 : 1);
      const cand = toks.filter(tk => codeLike(tk.t) && r.words.some(w => normItem(w.t).includes(tk.t)))
        .sort((a, b) => shape(a.t) - shape(b.t));
      if (!cand.length) continue;
      const near = hdr.item && shape(cand[0].t) === shape(cand[cand.length - 1].t) ? cand.sort((a, b) => Math.abs(center(a) - center(hdr.item)) - Math.abs(center(b) - center(hdr.item)))[0] : cand[0];
      itemTok = near;
    }
    // 수량 찾기
    const nums = r.words.map(w => ({ ...w, n: numOf(w.t) })).filter(w => w.n !== null && w.x > itemTok.x);
    let qty = null, qtySure = false;
    const owner = w => hdrCells.reduce((b, c) => (Math.abs(center(c) - center(w)) < Math.abs(center(b) - center(w)) ? c : b), hdrCells[0]);
    if (hdr && hdr.qty) {
      const inQty = nums.filter(w => owner(w) === hdr.qty);
      if (inQty.length) { qty = inQty[0].n; qtySure = true; }
    }
    if (qty === null) {
      // 수량 × 단가 ≈ 금액 관계로 찾기
      outer: for (let a = 0; a < nums.length; a++) for (let b = a + 1; b < nums.length; b++) for (let c = b + 1; c < nums.length; c++) {
        const p = nums[a].n * nums[b].n, t = nums[c].n;
        if (t > 0 && Math.abs(p - t) <= Math.max(1, t * 0.005)) { qty = nums[a].n; break outer; }
      }
    }
    if (qty === null && hdr && hdr.price) {
      const left = nums.filter(w => center(w) < center(hdr.price));
      if (left.length) qty = left[left.length - 1].n;
    }
    if (qty === null || !(qty > 0)) continue;
    // PO
    let po = '';
    for (const w of r.words) {
      const m = w.t.replace(/\s/g, '').match(/^(?:PO)?-?(\d{6,12})$/i);
      if (!m) continue;
      if (refs.pos.has(m[1]) || /^PO/i.test(w.t) || (hdr && hdr.po && owner(w) === hdr.po)) { po = m[1]; break; }
    }
    const raw = itemTok.t;
    const checks = [];
    if (!itemHit) checks.push('SAP 발주에 없는 품번');
    else if (!itemHit.exact) checks.push(`글자 보정: ${raw}`);
    if (!qtySure) checks.push('수량 확인');
    const row = { item: itemHit ? itemHit.item : raw, known: !!itemHit, qty, po, checks };
    if (!block) { block = { rows: [] }; blocks.push(block); }
    block.rows.push(row);
  }

  // 같은 내용이 두 번(공급자용·공급받는자용) 들어 있으면 한 번만
  const seen = new Set(), out = [];
  for (const b of blocks) {
    const sig = b.rows.map(r => `${r.item}|${r.qty}|${r.po}`).join(';');
    if (!b.rows.length || seen.has(sig)) continue;
    seen.add(sig); out.push(...b.rows);
  }

  // 공급사: 품번이 모두 한 공급사 것이면 그 공급사
  let vendor = null;
  const votes = new Map();
  for (const r of out) {
    const v = r.known && refs.items.get(normItem(r.item));
    if (v) for (const name of v.vendors) votes.set(name, (votes.get(name) || 0) + 1);
  }
  const known = out.filter(r => r.known).length;
  const top = [...votes].sort((a, b) => b[1] - a[1])[0];
  if (vendorInfo.byName && (!top || votes.get(vendorInfo.byName))) vendor = vendorInfo.byName;
  else if (top && top[1] === known) vendor = top[0];
  else vendor = vendorInfo.byName || (top && top[0]) || null;

  const date = findDate(texts, headerIdx, today) || dateFromName(fileName, today);
  return { rows: out, vendor, vendorRaw: vendorInfo.raw, date };
}

// ---------- 엑셀 표 → rows ----------
function fromGrid(grid) {
  return grid.map((r, i) => {
    const cells = [];
    r.forEach((t, j) => { if (String(t).trim() !== '') cells.push({ t: String(t).trim(), x: j * 100, w: 100 }); });
    return { cells, words: cells.map(c => ({ ...c })), y: i, h: 0 };
  });
}

// ---------- 글자인식 결과 → rows ----------
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
function fromOcrPage(page) {
  const ws = arr(page.words).filter(w => w && String(w.t).trim()).map(w => ({ t: String(w.t), x: w.x, y: w.y, w: w.w, h: w.h }));
  ws.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const w of ws) {
    const cy = w.y + w.h / 2;
    let L = lines.find(l => Math.abs(l.cy - cy) < Math.max(l.h, w.h) * 0.6);
    if (!L) { L = { cy, h: w.h, words: [] }; lines.push(L); }
    L.words.push(w);
  }
  lines.sort((a, b) => a.cy - b.cy);
  return lines.map(L => {
    L.words.sort((a, b) => a.x - b.x);
    const h = L.words.reduce((s, w) => s + w.h, 0) / L.words.length;
    // "21" ",600" 처럼 둘로 잘린 숫자 붙이기
    for (let k = L.words.length - 1; k > 0; k--) {
      const a = L.words[k - 1], b = L.words[k];
      if (/^\d{1,3}([,.]\d{3})*$/.test(a.t) && /^[,.]\d{3}([,.]\d{3})*$/.test(b.t) && b.x - (a.x + a.w) < h * 1.5) {
        a.t += b.t; a.w = b.x + b.w - a.x; L.words.splice(k, 1);
      }
    }
    const cells = [];
    for (const w of L.words) {
      const last = cells[cells.length - 1];
      if (last && w.x - (last.x + last.w) < h * 1.2) { last.t += ' ' + w.t; last.w = w.x + w.w - last.x; }
      else cells.push({ t: w.t, x: w.x, w: w.w });
    }
    return { cells, words: L.words.map(w => ({ t: w.t, x: w.x, w: w.w })), y: L.cy, h };
  });
}

module.exports = { extract, fromGrid, fromOcrPage, makeRefs, normItem, normName, matchItem };
