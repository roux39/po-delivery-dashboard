// 규칙 검사. 실행: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const R = require('../lib/rules');
const Store = require('../lib/store');

const H = ['PO number', 'Purchase Type', 'PO Status', 'Posting Date', 'Delivery Date', 'Vendor code', 'Vendor Name', 'PO Line', 'Row Status', 'Item No.', 'Item Description', 'Quantity', 'Remaining Open Quantity', 'Price Currency', 'Price', 'Row Total (KRW)'];
const row = (o) => H.map(h => o[h] ?? '').join('\t');
const base = { 'PO number': '900000012', 'Purchase Type': 'Direct', 'Posting Date': '2026-10-01', 'Delivery Date': '2026-11-20', 'Vendor code': 'V1', 'Vendor Name': '㈜가나', 'PO Line': '1', 'Row Status': 'O', 'Item No.': 'A-1', 'Quantity': '50,000', 'Remaining Open Quantity': '50000', 'Price Currency': 'KRW', 'Price': '9.9', 'Row Total (KRW)': '1' };

test('날짜 해석', () => {
  assert.strictEqual(R.parseFullDate('2026-04-30'), '2026-04-30');
  assert.strictEqual(R.parseFullDate('2026. 4. 30.'), '2026-04-30');
  assert.strictEqual(R.parseFullDate('46142'), '2026-04-30');
  assert.strictEqual(R.parseFullDate('04/30/2026'), '2026-04-30');
  assert.strictEqual(R.parseFullDate('2026-02-30'), null);
  assert.strictEqual(R.parseLooseDate('10/16 착(용차)', '2026-11-13'), '2026-10-16');
  assert.strictEqual(R.parseLooseDate('12/28 착', '2027-01-05'), '2026-12-28');
  assert.strictEqual(R.parseLooseDate('1/3 착', '2026-12-30'), '2027-01-03');
  assert.strictEqual(R.parseLooseDate('거래명세서', '2026-11-13'), null);
});

test('발주: 단가 열은 읽지 않음', () => {
  const r = R.extractPoRows([H.join('\t'), row(base)].join('\n'));
  assert.ok(!('price' in r.rows[0]));
  assert.ok(!Object.values(r.rows[0]).includes('9.9'));
});

test('발주: 삭제 규칙과 중복 규칙', () => {
  const text = [H.join('\t'),
    row(base),
    row({ ...base, 'Purchase Type': 'Indirect' }),
    row({ ...base, 'Purchase Type': '' }),
    row({ ...base, 'Row Status': 'C', 'Item No.': 'A-9' }),
    row({ ...base, 'Row Status': '' }),
    row({ ...base, 'Price Currency': 'USD' }),
    row({ ...base, 'Price Currency': '' }),
    '', '\t\t\t',
    row({ ...base, 'PO Line': '2', 'Remaining Open Quantity': '30000' }),   // 5가지 같음 → 중복, 최근 것 적용
    row({ ...base, 'Delivery Date': '2026-12-20' }),                      // 납기 다름 → 별개 줄
  ].join('\n');
  const x = R.applyPoRules(R.extractPoRows(text).rows);
  assert.deepStrictEqual(x.removed, { type: 2, status: 2, currency: 2, invalid: 0 });
  assert.strictEqual(x.rows.length, 2);
  assert.strictEqual(x.dupTotal, 1);
  assert.strictEqual(x.dupChanged, 1);
  const first = x.rows.find(r => r.delivery === '2026-11-20');
  assert.strictEqual(first.open, 30000);
  assert.strictEqual(first.line, '2');
  assert.strictEqual(x.closedKeys.length, 1);
});

test('입고: 제목줄 반복, 합계줄, 빈 줄 건너뛰기', () => {
  const text = [
    'PO number\tVendor code\tVendor Name\tItem No.\tQuantity\tPrice\tTotal\tWarehouse\t입고일',
    'PO number\tVendor code\tVendor Name\tItem No.\tQuantity\tPrice\tTotal\tWarehouse\tPO Remark',
    '900000012\tV1\t㈜가나\tA-1\t20000\t9\t180000\tWH01\t10/16 착(화물)',
    '\t\t\t\t\t\t180000\t\t', '',
    'PO number\tVendor code\tVendor Name\tItem No.\tQuantity\tPrice\tTotal\tWarehouse\tPO Remark',
    '900000013\tV1\t㈜가나\tA-1\t5,000\t9\t45000\tWH01\t거래명세서',
  ].join('\n');
  const r = R.extractReceipts(text, '2026-11-13');
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].date, '2026-10-16');
  assert.strictEqual(r.rows[0].note, '착(화물)');
  assert.strictEqual(r.rows[1].date, null);
  assert.strictEqual(r.rows[1].qty, 5000);
  assert.ok(!JSON.stringify(r.rows).includes('180000'));
});

test('저장: 업로드 후에도 납기예정일 유지, FIFO 배분, 전체 목록 Closed 처리', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fifo-test-'));
  const S = Store.open(dir);
  const raw = (o) => R.extractPoRows([H.join('\t'), ...o.map(row)].join('\n')).rows;
  const a = { ...base, 'Posting Date': '2026-09-01', 'PO number': '1001', 'Quantity': '100', 'Remaining Open Quantity': '100' };
  const b = { ...base, 'Posting Date': '2026-10-01', 'PO number': '1002', 'Quantity': '100', 'Remaining Open Quantity': '100' };
  let s = S.uploadPo(raw([a, b]), { by: 't' });
  assert.strictEqual(s.added, 2);
  const lineA = S.listLines({}).find(l => l.po === '1001');
  S.addEta(lineA.id, '2026-12-01', '지연', 't');
  // 같은 파일을 다시 올림 → 납기예정일 그대로
  s = S.uploadPo(raw([{ ...a, 'Remaining Open Quantity': '80' }, b]), { by: 't' });
  assert.strictEqual(s.added, 0); assert.strictEqual(s.changed, 1);
  const again = S.listLines({}).find(l => l.po === '1001');
  assert.strictEqual(again.eta, '2026-12-01');
  assert.strictEqual(again.open_qty, 80);
  // 입고 150 → 1001 잔량 80을 먼저 채우고 1002에 70 (작성일 순)
  const out = S.addReceipts([{ po: '1001', vendorCode: 'V1', vendor: '㈜가나', item: 'A-1', qty: 150, date: '2026-11-10', note: '착' }], { by: 't' });
  assert.strictEqual(out.added, 1);
  const lines = S.listLines({});
  assert.strictEqual(lines.find(l => l.po === '1001').logged, 80);
  assert.strictEqual(lines.find(l => l.po === '1001').open_qty, 0);
  assert.strictEqual(lines.find(l => l.po === '1002').logged, 70);
  assert.strictEqual(lines.find(l => l.po === '1002').open_qty, 30);
  // 같은 입고를 또 붙여넣으면 건너뜀
  assert.strictEqual(S.addReceipts([{ po: '1001', vendor: '㈜가나', item: 'A-1', qty: 150, date: '2026-11-10' }], { by: 't' }).duplicates, 1);
  // 전체 목록으로 b만 올림 → a는 Closed
  s = S.uploadPo(raw([b]), { by: 't', fullList: true, dryRun: true });
  assert.strictEqual(s.closedByMissing, 1);
  assert.strictEqual(S.listLines({}).length, 2, 'dryRun은 저장하지 않음');
  s = S.uploadPo(raw([b]), { by: 't', fullList: true });
  assert.strictEqual(S.listLines({}).length, 1);
  // Row Status C 로 들어오면 Closed
  s = S.uploadPo(raw([{ ...b, 'Row Status': 'C' }]), { by: 't' });
  assert.strictEqual(s.closedByStatus, 1);
  // 6개월 지난 Closed 줄 자동 삭제
  S.db.prepare("UPDATE po_lines SET closed_at='2025-01-01'").run();
  const p = S.purge();
  assert.strictEqual(p.lines, 2);
  assert.strictEqual(S.listReceipts().length, 0);
  S.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('입고 즉시 반영 + SAP 목록(B)과 현황판(A) 잔량 대조', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fifo-test-'));
  const S = Store.open(dir);
  const raw = (o) => R.extractPoRows([H.join('\t'), ...o.map(row)].join('\n')).rows;
  const today = R.todayISO();
  const ago = n => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - n); return R.localISO(d); };
  const a = (open, qty = 1000) => ({ ...base, 'Posting Date': '2026-09-01', 'PO number': '1001', 'Quantity': String(qty), 'Remaining Open Quantity': String(open) });
  const b2 = { ...base, 'Posting Date': '2026-10-01', 'PO number': '1002', 'Quantity': '500', 'Remaining Open Quantity': '500' };
  const rc = (qty, date) => ({ vendor: '㈜가나', item: 'A-1', qty, date });
  const line = () => S.listLines({}).find(l => l.po === '1001');

  S.uploadPo(raw([a(1000), b2]), { by: 't' });
  // 입고는 입고일과 상관없이 등록 즉시 잔량에서 빠짐 (오늘 300, 10일 전 50)
  const out = S.addReceipts([rc(300, today), rc(50, ago(10))], { by: 't' });
  assert.strictEqual(out.deducted, 2);
  assert.deepStrictEqual([line().open_qty, line().sap_open, line().pending], [650, 1000, 1]);

  // B: SAP 잔량 그대로 1000 → 차이 350 = 방금 등록한 입고 300+50 → 아직 SAP 반영 대기 (오류 아님)
  let s = S.uploadPo(raw([a(1000), b2]), { by: 't', dryRun: true });
  assert.strictEqual(s.checks.length, 1);
  assert.deepStrictEqual([s.checks[0].result, s.checks[0].diff], ['wait', 350]);
  S.uploadPo(raw([a(1000), b2]), { by: 't' });
  assert.deepStrictEqual([line().open_qty, line().pending, line().check_msg], [650, 1, null]);

  // B: SAP 잔량 650 + 새 발주 1003 → 일치 → SAP 반영됨, 새 발주는 비교에서 제외
  const b3 = { ...b2, 'PO number': '1003', 'Posting Date': '2026-10-05' };
  s = S.uploadPo(raw([a(650), b2, b3]), { by: 't' });
  assert.deepStrictEqual([s.newByPoLine, s.sapConfirmed, s.checks.length], [1, 2, 0]);
  assert.deepStrictEqual([line().open_qty, line().sap_open, line().pending], [650, 650, 0]);

  // B: SAP 잔량이 100 더 적음 (현황판에 없는 입고) → 확인 필요
  s = S.uploadPo(raw([a(550), b2, b3]), { by: 't' });
  assert.deepStrictEqual([s.checks[0].result, s.checks[0].diff], ['error', -100]);
  assert.ok(/100 적어요/.test(line().check_msg));
  S.clearCheck(line().id);
  assert.strictEqual(line().check_msg, null);

  // 며칠 전에 등록한 오래된 입고 40이 SAP에 아직 없음 → 최근 2일 입고와 안 맞음 → 확인 필요
  S.addReceipts([rc(40, ago(10))], { by: 't' });
  S.db.prepare('UPDATE receipts SET created_at=? WHERE qty=40').run(ago(5) + ' 09:00:00');
  assert.strictEqual(line().open_qty, 510);
  s = S.uploadPo(raw([a(550), b2, b3]), { by: 't' });
  assert.deepStrictEqual([s.checks[0].result, s.checks[0].diff], ['error', 40]);
  S.setReceiptSap(S.listReceipts().find(r => r.qty === 40).id, true);
  assert.strictEqual(line().open_qty, 550);

  // PO 수량이 1000 → 1200으로 바뀌고 잔량 550 → 750: 수량 변경만큼은 정상 → 일치
  s = S.uploadPo(raw([a(750, 1200), b2, b3]), { by: 't' });
  assert.strictEqual(s.checks.length, 0);
  assert.strictEqual(line().check_msg, null);
  S.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('입고 FIFO: PO 작성일이 빠른 발주 줄 잔량부터 빠짐 (입고일이 오래돼도)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fifo-test-'));
  const S = Store.open(dir);
  const raw = (o) => R.extractPoRows([H.join('\t'), ...o.map(row)].join('\n')).rows;
  const sep = { ...base, 'Posting Date': '2026-09-15', 'PO number': '2609', 'Quantity': '1000', 'Remaining Open Quantity': '1000' };
  const oct = { ...base, 'Posting Date': '2026-10-08', 'PO number': '2610', 'Quantity': '500', 'Remaining Open Quantity': '500' };
  S.uploadPo(raw([oct, sep]), { by: 't' });
  // PO 번호 없는 거래명세서, 입고일 8일 전, 1200 → 9월 1000 다 채우고 10월에 200
  S.addReceipts([{ vendor: '㈜가나', item: 'A-1', qty: 1200, date: '2026-11-05' }], { by: 't' });
  const by = po => S.listLines({}).find(l => l.po === po);
  assert.deepStrictEqual([by('2609').open_qty, by('2610').open_qty], [0, 300]);
  assert.deepStrictEqual([by('2609').pending, by('2610').pending], [1, 1]);
  // 다른 PO 번호가 적혀 있어도 FIFO 순서대로
  S.addReceipts([{ po: '2610', vendor: '㈜가나', item: 'A-1', qty: 100, date: '2026-11-06' }], { by: 't' });
  assert.strictEqual(by('2610').open_qty, 200);
  S.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
