// 데이터 저장 (Node 내장 SQLite). 파일 하나(data/fifo.db)에 모든 데이터가 들어간다.
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const Rules = require('./rules');

const KEEP_MONTHS = 6;   // PO가 Closed 된 뒤 입고 기록 보관 기간
const NEW_DAYS = 7;      // '신규' 표시 기간
const BACKUP_KEEP = 30;  // 자동 백업 보관 개수
const RECENT_DAYS = 2;   // 이 기간 안의 입고는 아직 SAP에 반영 안 됐을 수 있음 (잔량에서 바로 뺌)

const nf = n => Number(n).toLocaleString('ko-KR');
function checkMsg(c) {
  return c.diff < 0
    ? `SAP 잔량(${nf(c.sapOpen)})이 현황판 잔량(${nf(c.viewOpen)})보다 ${nf(-c.diff)} 적어요. 현황판에 등록하지 않은 입고가 SAP에 있거나, 입고가 두 번 잡혔을 수 있어요.`
    : `SAP 잔량(${nf(c.sapOpen)})이 현황판 잔량(${nf(c.viewOpen)})보다 ${nf(c.diff)} 많아요. 최근 ${RECENT_DAYS}일 입고 기록 중 맞는 것이 없어요.`;
}

// 대기 중인 입고 중에서 합계가 차이와 같은 묶음 찾기
function subsetSum(list, target) {
  const xs = list.slice(0, 16);
  for (let mask = 1; mask < (1 << xs.length); mask++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) if (mask & (1 << i)) s += xs[i].qty;
    if (Math.abs(s - target) < 1e-6) return new Set(xs.filter((_, i) => mask & (1 << i)).map(x => x.id));
  }
  return null;
}

function nowStamp() { const d = new Date(); return `${Rules.localISO(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; }
function addMonths(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setMonth(d.getMonth() + n); return Rules.localISO(d); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return Rules.localISO(d); }

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'fifo.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, name TEXT, expires TEXT);
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY, kind TEXT, at TEXT, by TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS po_lines (
      id INTEGER PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      po TEXT, posting TEXT, delivery TEXT, item TEXT, vendor TEXT,
      vendor_code TEXT, descr TEXT, line TEXT, uom TEXT,
      qty REAL, open_qty REAL,
      first_seen TEXT, last_upload INTEGER, closed_at TEXT);
    CREATE TABLE IF NOT EXISTS eta_changes (
      id INTEGER PRIMARY KEY, line_key TEXT NOT NULL, eta TEXT NOT NULL, reason TEXT, by TEXT, at TEXT);
    CREATE INDEX IF NOT EXISTS eta_key ON eta_changes(line_key);
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY, po TEXT, vendor_code TEXT, vendor TEXT, item TEXT, qty REAL,
      warehouse TEXT, rdate TEXT, note TEXT, created_at TEXT, created_by TEXT, left_qty REAL);
    CREATE TABLE IF NOT EXISTS receipt_alloc (
      receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      line_id INTEGER NOT NULL REFERENCES po_lines(id) ON DELETE CASCADE,
      qty REAL);
    CREATE INDEX IF NOT EXISTS alloc_line ON receipt_alloc(line_id);
    CREATE INDEX IF NOT EXISTS alloc_rc ON receipt_alloc(receipt_id);
    CREATE TABLE IF NOT EXISTS sap_checks (vendor TEXT, item TEXT, msg TEXT, at TEXT, PRIMARY KEY(vendor, item));
    DROP TABLE IF EXISTS sap_credit;
  `);
  let migrateRealloc = false;
  // SAP 반영 여부 칸 추가. 예전 데이터: 마지막 발주 파일 업로드 전에 등록했거나 2일 넘은 입고는 SAP에 반영된 것으로 본다.
  if (!db.prepare('PRAGMA table_info(receipts)').all().some(c => c.name === 'sap_ok')) {
    db.exec('ALTER TABLE receipts ADD COLUMN sap_ok INTEGER NOT NULL DEFAULT 0');
    const last = db.prepare("SELECT v FROM settings WHERE k='last_po_upload'").get();
    if (last) db.prepare('UPDATE receipts SET sap_ok=1 WHERE created_at <= ?').run(last.v);
    db.prepare('UPDATE receipts SET sap_ok=1 WHERE rdate < ?').run(addDays(Rules.todayISO(), -RECENT_DAYS));
  }
  // 2026-11-13 규칙 변경: 등록한 입고는 입고일과 상관없이 모두 바로 잔량에서 뺀다.
  // 마지막 SAP 발주 목록을 올린 뒤에 등록한 입고는 아직 SAP 확인 전이므로 '반영 대기'로 되돌린다 (한 번만).
  if (!db.prepare("SELECT v FROM settings WHERE k='rc_rule'").get()) {
    const last = db.prepare("SELECT v FROM settings WHERE k='last_po_upload'").get();
    const ids = db.prepare('SELECT id FROM receipts WHERE sap_ok=1 AND created_at > ?').all(last ? last.v : '').map(r => r.id);
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        db.prepare('DELETE FROM receipt_alloc WHERE receipt_id=?').run(id);
        db.prepare('UPDATE receipts SET sap_ok=0, left_qty=qty WHERE id=?').run(id);
      }
      db.prepare("INSERT INTO settings(k,v) VALUES('rc_rule','2')").run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    migrateRealloc = ids.length > 0;
  }

  const S = {
    db, dataDir,
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    getSetting(k) { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? r.v : null; },
    setSetting(k, v) { db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v); },
  };

  // ---------- 발주 업로드 ----------
  // rawRows: 브라우저에서 필요한 열만 골라 보낸 줄. dryRun이면 저장하지 않고 결과만 계산.
  S.uploadPo = function (rawRows, { fullList, by, dryRun }) {
    const today = Rules.todayISO();
    const res = Rules.applyPoRules(rawRows);
    const summary = {
      received: rawRows.length, kept: res.rows.length, removed: res.removed, invalidSamples: res.invalidSamples,
      dupTotal: res.dupTotal, dupChanged: res.dupChanged,
      added: 0, changed: 0, unchanged: 0, reopened: 0, closedByStatus: 0, closedByMissing: 0, missingSamples: [],
      newByPoLine: 0, sapConfirmed: 0, sapPending: 0, checks: [],
    };
    const run = () => {
      const up = db.prepare('INSERT INTO uploads(kind,at,by,summary) VALUES(?,?,?,?)').run('po', nowStamp(), by || '', '{}');
      const uploadId = Number(up.lastInsertRowid);
      const get = db.prepare('SELECT * FROM po_lines WHERE key=?');

      // ---- A(지금 현황판)와 B(이번 SAP 목록) 대조 ----
      // ① PO number + PO Line 으로 A에 없던 줄 = 새 발주 (비교에서 뺌)
      // ② 나머지를 공급사+품번별로 합쳐서, A의 잔량(입고를 바로 뺀 값)과 B의 SAP 잔량이 같은지 본다
      const pl = l => `${l.po}|${l.line || ''}`;
      const aOpen = db.prepare('SELECT * FROM po_lines WHERE closed_at IS NULL').all();
      const aPL = new Set(aOpen.map(pl)), bPL = new Set(res.rows.map(pl));
      const pendRows = db.prepare(`SELECT a.line_id, a.qty, r.id AS rid, r.qty AS rqty, r.rdate, r.created_at
        FROM receipt_alloc a JOIN receipts r ON r.id=a.receipt_id WHERE r.sap_ok=0`).all();
      const pendByLine = new Map();
      for (const p of pendRows) pendByLine.set(p.line_id, (pendByLine.get(p.line_id) || 0) + p.qty);
      const groups = new Map();
      const G = (vendor, item) => {
        const k = `${vendor}\u0001${item}`;
        if (!groups.has(k)) groups.set(k, { vendor, item, aOpen: 0, aPend: 0, aQty: 0, bOpen: 0, bQty: 0, lineIds: new Set(), rc: new Map() });
        return groups.get(k);
      };
      for (const l of aOpen) {
        if (!bPL.has(pl(l))) continue;
        const g = G(l.vendor, l.item);
        g.aOpen += l.open_qty; g.aPend += pendByLine.get(l.id) || 0; g.aQty += l.qty; g.lineIds.add(l.id);
      }
      for (const r of res.rows) {
        if (!aPL.has(pl(r))) { summary.newByPoLine++; continue; }
        const g = G(r.vendor, r.item);
        g.bOpen += r.open; g.bQty += r.qty;
      }
      const lineGroup = new Map();
      for (const g of groups.values()) for (const id of g.lineIds) lineGroup.set(id, g);
      const pendInfo = new Map();
      for (const p of pendRows) {
        const info = pendInfo.get(p.rid) || { id: p.rid, qty: p.rqty, rdate: p.rdate, created: p.created_at, inGroup: false };
        pendInfo.set(p.rid, info);
        const g = lineGroup.get(p.line_id);
        if (g) { g.rc.set(p.rid, info); info.inGroup = true; }
      }
      const recentFrom = addDays(today, -RECENT_DAYS);
      // 최근 2일 = 입고일 또는 등록한 날이 2일 안 (방금 등록한 입고는 아직 SAP에 없을 수 있음)
      const isRecent = r => r.rdate >= recentFrom || String(r.created || '').slice(0, 10) >= recentFrom;
      const confirm = new Set(), okGroups = [], errGroups = [];
      const n0 = x => Math.round(x * 1000) / 1000;
      for (const g of groups.values()) {
        // PO 수량이 바뀐 만큼은 잔량도 같이 바뀌는 게 정상
        const expect = n0(g.aOpen - g.aPend + (g.bQty - g.aQty));
        const diff = n0(g.bOpen - expect);
        const rcs = [...g.rc.values()];
        if (Math.abs(diff) < 1e-6) { rcs.forEach(r => confirm.add(r.id)); okGroups.push(g); continue; }
        const keep = diff > 0 ? subsetSum(rcs.filter(isRecent), diff) : null;
        const base = { vendor: g.vendor, item: g.item, sapOpen: n0(g.bOpen), viewOpen: expect, diff };
        if (keep) {
          rcs.forEach(r => { if (!keep.has(r.id)) confirm.add(r.id); });
          okGroups.push(g);
          summary.checks.push({ ...base, result: 'wait', receipts: rcs.filter(r => keep.has(r.id)).map(r => ({ date: r.rdate, qty: r.qty })) });
        } else {
          errGroups.push(g);
          summary.checks.push({ ...base, result: 'error' });
        }
      }

      const ins = db.prepare(`INSERT INTO po_lines(key,po,posting,delivery,item,vendor,vendor_code,descr,line,uom,qty,open_qty,first_seen,last_upload,closed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
      const upd = db.prepare(`UPDATE po_lines SET vendor_code=?,descr=?,line=?,uom=?,qty=?,open_qty=?,last_upload=?,closed_at=NULL WHERE id=?`);
      for (const r of res.rows) {
        const ex = get.get(r.key);
        if (!ex) {
          ins.run(r.key, r.po, r.posting, r.delivery, r.item, r.vendor, r.vendorCode, r.desc, r.line, r.uom, r.qty, r.open, today, uploadId);
          summary.added++;
        } else {
          if (ex.closed_at) summary.reopened++;
          if (ex.qty !== r.qty || ex.open_qty !== r.open || ex.line !== r.line) summary.changed++; else summary.unchanged++;
          upd.run(r.vendorCode || ex.vendor_code, r.desc || ex.descr, r.line, r.uom || ex.uom, r.qty, r.open, uploadId, ex.id);
        }
      }
      const close = db.prepare('UPDATE po_lines SET closed_at=? WHERE key=? AND closed_at IS NULL');
      const keptKeys = new Set(res.rows.map(r => r.key));
      for (const k of new Set(res.closedKeys)) {
        if (keptKeys.has(k)) continue;
        summary.closedByStatus += Number(close.run(today, k).changes);
      }
      if (fullList) {
        const openLines = db.prepare('SELECT id,key,po,item FROM po_lines WHERE closed_at IS NULL').all();
        const closeId = db.prepare('UPDATE po_lines SET closed_at=? WHERE id=?');
        for (const l of openLines) {
          if (keptKeys.has(l.key)) continue;
          closeId.run(today, l.id);
          summary.closedByMissing++;
          if (summary.missingSamples.length < 20) summary.missingSamples.push(`PO ${l.po} / ${l.item}`);
        }
      }
      // 비교에 안 들어간 대기 입고: 연결된 발주 줄이 모두 Closed 되었으면 SAP에서 처리된 것으로 본다
      const isClosed = db.prepare('SELECT closed_at FROM po_lines WHERE id=?');
      for (const info of pendInfo.values()) {
        if (info.inGroup) continue;
        const lines = pendRows.filter(p => p.rid === info.id).map(p => p.line_id);
        if (lines.every(id => { const r = isClosed.get(id); return !r || r.closed_at; })) confirm.add(info.id);
      }
      const ok = db.prepare('UPDATE receipts SET sap_ok=1 WHERE id=?');
      for (const id of confirm) ok.run(id);
      summary.sapConfirmed = confirm.size;
      const delCheck = db.prepare('DELETE FROM sap_checks WHERE vendor=? AND item=?');
      for (const g of okGroups) delCheck.run(g.vendor, g.item);
      const setCheck = db.prepare('INSERT INTO sap_checks(vendor,item,msg,at) VALUES(?,?,?,?) ON CONFLICT(vendor,item) DO UPDATE SET msg=excluded.msg, at=excluded.at');
      for (const c of summary.checks.filter(c => c.result === 'error')) setCheck.run(c.vendor, c.item, checkMsg(c), nowStamp());
      if (!dryRun) S.allocateLeftovers();
      summary.sapPending = db.prepare('SELECT COUNT(*) AS c FROM receipts WHERE sap_ok=0').get().c;
      db.prepare('UPDATE uploads SET summary=? WHERE id=?').run(JSON.stringify(summary), uploadId);
      return uploadId;
    };
    if (dryRun) {
      db.exec('BEGIN');
      try { run(); } finally { db.exec('ROLLBACK'); }
    } else {
      S.tx(run);
      S.setSetting('last_po_upload', nowStamp());
    }
    return summary;
  };

  // ---------- 입고 ----------
  // 같은 공급사+품번의 발주 줄에 PO 작성일(Posting Date)이 빠른 순서로 채운다 (FIFO).
  function linesFor(rc) {
    const cols = 'id, qty, open_qty, closed_at';
    const byCode = rc.vendor_code
      ? db.prepare(`SELECT ${cols} FROM po_lines WHERE item=? AND vendor_code=? ORDER BY posting, po, CAST(line AS INTEGER), delivery, id`).all(rc.item, rc.vendor_code)
      : [];
    if (byCode.length) return byCode;
    return db.prepare(`SELECT ${cols} FROM po_lines WHERE item=? AND vendor=? ORDER BY posting, po, CAST(line AS INTEGER), delivery, id`).all(rc.item, rc.vendor);
  }
  // SAP에 아직 반영 안 된 입고: 남은 잔량이 있는 열린 발주 줄에 채운다 (잔량에서 바로 빠짐)
  // 이미 반영된 예전 입고: 발주 수량 기준으로 채운다 (이력 보기용)
  function allocate(rc) {
    let left = rc.left_qty;
    if (left <= 0) return;
    const usedQ = db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM receipt_alloc WHERE line_id=?');
    const usedPend = db.prepare('SELECT COALESCE(SUM(a.qty),0) AS s FROM receipt_alloc a JOIN receipts r ON r.id=a.receipt_id WHERE a.line_id=? AND r.sap_ok=0');
    const add = db.prepare('INSERT INTO receipt_alloc(receipt_id,line_id,qty) VALUES(?,?,?)');
    for (const l of linesFor(rc)) {
      let cap;
      if (rc.sap_ok) cap = l.qty - usedQ.get(l.id).s;
      else { if (l.closed_at) continue; cap = l.open_qty - usedPend.get(l.id).s; }
      if (cap <= 0) continue;
      const q = Math.min(cap, left);
      add.run(rc.id, l.id, q);
      left -= q;
      if (left <= 0) break;
    }
    db.prepare('UPDATE receipts SET left_qty=? WHERE id=?').run(left, rc.id);
  }
  S.allocateLeftovers = function () {
    for (const rc of db.prepare('SELECT * FROM receipts WHERE left_qty > 0 ORDER BY rdate, id').all()) allocate(rc);
  };

  // rows: [{po, vendorCode, vendor, item, qty, warehouse, date, note}]
  S.addReceipts = function (rows, { by }) {
    const out = { added: 0, duplicates: 0, invalid: 0, unmatched: 0 };
    S.tx(() => {
      const dup = db.prepare('SELECT id FROM receipts WHERE po=? AND item=? AND qty=? AND rdate=? AND COALESCE(vendor,\'\')=?');
      const ins = db.prepare(`INSERT INTO receipts(po,vendor_code,vendor,item,qty,warehouse,rdate,note,created_at,created_by,left_qty,sap_ok) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows) {
        const qty = Rules.parseNum(r.qty);
        const date = Rules.parseFullDate(r.date);
        if (!r.item || !qty || !date) { out.invalid++; continue; }
        if (dup.get(r.po || '', r.item, qty, date, r.vendor || '')) { out.duplicates++; continue; }
        // 등록한 입고는 입고일과 상관없이 바로 대시보드 잔량에서 뺀다 ('SAP 반영 대기').
        // 다음 SAP 발주 목록을 올릴 때 대조해서 반영 완료 / 대기 / 확인 필요를 정한다.
        const info = ins.run(r.po || '', r.vendorCode || '', r.vendor || '', r.item, qty, r.warehouse || '', date, r.note || '', nowStamp(), by || '', qty, 0);
        const rc = db.prepare('SELECT * FROM receipts WHERE id=?').get(Number(info.lastInsertRowid));
        allocate(rc);
        if (db.prepare('SELECT left_qty FROM receipts WHERE id=?').get(rc.id).left_qty > 0) out.unmatched++;
        out.deducted = (out.deducted || 0) + 1;
        out.added++;
      }
      db.prepare('INSERT INTO uploads(kind,at,by,summary) VALUES(?,?,?,?)').run('receipt', nowStamp(), by || '', JSON.stringify(out));
    });
    return out;
  };
  // 파일 읽기에서 품번·공급사·PO를 맞춰 보는 참고 목록
  S.refLines = function () {
    return db.prepare('SELECT DISTINCT item, vendor, po FROM po_lines').all();
  };
  // 직접 '반영 완료'/'반영 대기'로 바꾸기 (자동 판단이 맞지 않을 때)
  // 바꾸면 발주 줄 연결도 새 기준으로 다시 한다
  S.setReceiptSap = function (id, ok) {
    return S.tx(() => {
      const rc = db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
      if (!rc) return 0;
      db.prepare('DELETE FROM receipt_alloc WHERE receipt_id=?').run(id);
      db.prepare('UPDATE receipts SET sap_ok=?, left_qty=qty WHERE id=?').run(ok ? 1 : 0, id);
      allocate(db.prepare('SELECT * FROM receipts WHERE id=?').get(id));
      return 1;
    });
  };
  // '확인 필요' 표시 지우기 (직접 확인한 뒤)
  S.clearCheck = function (lineId) {
    const l = db.prepare('SELECT vendor, item FROM po_lines WHERE id=?').get(lineId);
    return l ? Number(db.prepare('DELETE FROM sap_checks WHERE vendor=? AND item=?').run(l.vendor, l.item).changes) : 0;
  };
  S.deleteReceipt = function (id) {
    return Number(db.prepare('DELETE FROM receipts WHERE id=?').run(id).changes);
  };
  S.listReceipts = function (limit = 500) {
    return db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM receipt_alloc a WHERE a.receipt_id=r.id) AS alloc_count
      FROM receipts r ORDER BY r.rdate DESC, r.id DESC LIMIT ?`).all(limit);
  };

  // ---------- 납기예정일 ----------
  S.addEta = function (lineId, eta, reason, by) {
    const l = db.prepare('SELECT key FROM po_lines WHERE id=?').get(lineId);
    if (!l) throw new Error('발주 줄을 찾지 못했어요.');
    const d = Rules.parseFullDate(eta);
    if (!d) throw new Error('날짜 형식이 올바르지 않아요.');
    db.prepare('INSERT INTO eta_changes(line_key,eta,reason,by,at) VALUES(?,?,?,?,?)').run(l.key, d, reason || '', by || '', nowStamp());
  };
  S.deleteEta = function (etaId) {
    return Number(db.prepare('DELETE FROM eta_changes WHERE id=?').run(etaId).changes);
  };

  // ---------- 조회 ----------
  S.listLines = function ({ includeClosed }) {
    const newSince = addDays(Rules.todayISO(), -NEW_DAYS + 1);
    const rows = db.prepare(`
      SELECT l.id, l.po, l.posting, l.delivery, l.item, l.vendor, l.vendor_code, l.descr, l.line, l.uom, l.qty, l.first_seen, l.closed_at,
        l.open_qty AS sap_open,
        MAX(0, l.open_qty - (SELECT COALESCE(SUM(a.qty),0) FROM receipt_alloc a JOIN receipts r ON r.id=a.receipt_id WHERE a.line_id=l.id AND r.sap_ok=0)) AS open_qty,
        (SELECT msg FROM sap_checks c WHERE c.vendor=l.vendor AND c.item=l.item) AS check_msg,
        (SELECT eta FROM eta_changes e WHERE e.line_key=l.key ORDER BY e.id DESC LIMIT 1) AS eta,
        (SELECT COUNT(*) FROM eta_changes e WHERE e.line_key=l.key) AS eta_count,
        (SELECT COALESCE(SUM(a.qty),0) FROM receipt_alloc a WHERE a.line_id=l.id) AS logged,
        (SELECT COUNT(*) FROM receipt_alloc a JOIN receipts r ON r.id=a.receipt_id WHERE a.line_id=l.id AND r.sap_ok=0) AS pending
      FROM po_lines l ${includeClosed ? '' : 'WHERE l.closed_at IS NULL'}
      ORDER BY l.posting, l.po, CAST(l.line AS INTEGER), l.delivery`).all();
    return rows.map(r => ({ ...r, is_new: r.first_seen >= newSince && !r.closed_at ? 1 : 0, pending: r.pending > 0 ? 1 : 0 }));
  };
  S.lineDetail = function (id) {
    const l = db.prepare('SELECT * FROM po_lines WHERE id=?').get(id);
    if (!l) return null;
    const eta = db.prepare('SELECT id, eta, reason, by, at FROM eta_changes WHERE line_key=? ORDER BY id').all(l.key);
    const receipts = db.prepare(`SELECT r.id, r.rdate, r.note, r.qty AS total_qty, a.qty, r.po AS rc_po, r.created_at, r.sap_ok
      FROM receipt_alloc a JOIN receipts r ON r.id=a.receipt_id WHERE a.line_id=? ORDER BY r.rdate, r.id`).all(id);
    const { key, ...rest } = l;
    rest.sap_open = l.open_qty;
    rest.open_qty = Math.max(0, l.open_qty - receipts.filter(r => !r.sap_ok).reduce((s, r) => s + r.qty, 0));
    const chk = db.prepare('SELECT msg, at FROM sap_checks WHERE vendor=? AND item=?').get(l.vendor, l.item);
    rest.check_msg = chk ? chk.msg : null;
    return { line: rest, eta, receipts, lastPoUpload: S.getSetting('last_po_upload') };
  };
  S.listUploads = function (limit = 50) {
    return db.prepare('SELECT * FROM uploads ORDER BY id DESC LIMIT ?').all(limit).map(u => ({ ...u, summary: JSON.parse(u.summary || '{}') }));
  };

  // ---------- 자동 삭제 ----------
  // Closed 된 지 6개월이 지난 발주 줄과, 그 줄에 연결된 입고 기록을 지운다.
  S.purge = function () {
    const cutoff = addMonths(Rules.todayISO(), -KEEP_MONTHS);
    return S.tx(() => {
      const old = db.prepare('SELECT id, key FROM po_lines WHERE closed_at IS NOT NULL AND closed_at <= ?').all(cutoff);
      const rcIds = new Set();
      for (const l of old) {
        for (const a of db.prepare('SELECT receipt_id FROM receipt_alloc WHERE line_id=?').all(l.id)) rcIds.add(a.receipt_id);
        db.prepare('DELETE FROM eta_changes WHERE line_key=?').run(l.key);
        db.prepare('DELETE FROM po_lines WHERE id=?').run(l.id);
      }
      let receipts = 0;
      for (const rid of rcIds) {
        const still = db.prepare('SELECT COUNT(*) AS c FROM receipt_alloc WHERE receipt_id=?').get(rid).c;
        if (!still) receipts += Number(db.prepare('DELETE FROM receipts WHERE id=?').run(rid).changes);
      }
      // 어느 발주에도 연결되지 않은 입고는 입고일로부터 6개월 뒤 삭제
      receipts += Number(db.prepare(`DELETE FROM receipts WHERE rdate <= ? AND id NOT IN (SELECT receipt_id FROM receipt_alloc)`).run(cutoff).changes);
      db.prepare('DELETE FROM sessions WHERE expires < ?').run(new Date().toISOString());
      return { lines: old.length, receipts };
    });
  };

  // ---------- 자동 백업 ----------
  S.backup = function () {
    const dir = path.join(dataDir, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `fifo-${Rules.todayISO()}.db`);
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(dir).filter(f => /^fifo-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) fs.unlinkSync(path.join(dir, f));
    return file;
  };

  if (migrateRealloc) S.allocateLeftovers();
  return S;
}

module.exports = { open, KEEP_MONTHS, NEW_DAYS };
