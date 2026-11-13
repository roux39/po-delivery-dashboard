// 화면 확인용 예시 데이터 만들기 (모두 가상의 공급사·품번·PO 번호)
// 실행: node demo/make-demo.js  →  node server.js --data demo-data
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../lib/rules');
const Store = require('../lib/store');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'demo-data'));
fs.rmSync(dir, { recursive: true, force: true });
const S = Store.open(dir);

const today = R.todayISO();
const day = n => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + n); return R.localISO(d); };
const H = ['PO number', 'Purchase Type', 'PO Status', 'Posting Date', 'Delivery Date', 'Vendor code', 'Vendor Name', 'PO Line', 'Row Status', 'Item No.', 'Item Description', 'Quantity', 'Remaining Open Quantity', 'Price Currency'];
const V = { A: ['V001', '한빛정밀㈜'], B: ['V002', '대성볼트'], C: ['V003', '미래패스너(주)'], D: ['V004', '세진금속'] };
// [PO, 공급사, 라인, 품번, 품명, 수량, 작성일(오늘 기준), 납기(오늘 기준)]
const lines = [
  ['DEMO-1001', 'A', 1, 'HB-M6X20-ZN', '육각볼트 M6x20', 50000, -60, -25],
  ['DEMO-1001', 'A', 2, 'HB-M8X30-ZN', '육각볼트 M8x30', 30000, -60, -20],
  ['DEMO-1002', 'B', 1, 'NT-M6-SUS', '육각너트 M6 SUS', 80000, -45, -5],
  ['DEMO-1003', 'C', 1, 'WS-08-FLAT', '평와셔 8', 120000, -40, 3],
  ['DEMO-1004', 'A', 1, 'HB-M6X20-ZN', '육각볼트 M6x20', 40000, -30, 6],
  ['DEMO-1005', 'D', 1, 'SC-4X12-BK', '태핑나사 4x12', 200000, -28, 9],
  ['DEMO-1005', 'D', 2, 'SC-4X16-BK', '태핑나사 4x16', 150000, -28, 9],
  ['DEMO-1006', 'B', 1, 'NT-M8-SUS', '육각너트 M8 SUS', 60000, -20, 12],
  ['DEMO-1007', 'C', 1, 'RV-3.2X8-AL', '블라인드리벳 3.2x8', 90000, -15, 15],
  ['DEMO-1008', 'A', 1, 'HB-M10X40-ZN', '육각볼트 M10x40', 20000, -10, 20],
  ['DEMO-1009', 'D', 1, 'SC-4X12-BK', '태핑나사 4x12', 100000, -6, 27],
  ['DEMO-1010', 'C', 1, 'WS-10-SPRING', '스프링와셔 10', 70000, -3, 34],
];
const tsv = openOf => [H.join('\t'), ...lines.map((l, i) => [l[0], 'Direct', 'O', day(l[6]), day(l[7]), ...V[l[1]], l[2], 'O', l[3], l[4], l[5], openOf(l, i), 'KRW'].join('\t'))].join('\n');
const upload = openOf => S.uploadPo(R.extractPoRows(tsv(openOf)).rows, { by: '데모', fullList: true });

upload(l => l[5]);
// 납기예정일 변경 이력
const id = po => S.listLines({}).find(l => l.po === po).id;
S.addEta(id('DEMO-1001'), day(-10), '도금 공정 지연', '데모');
S.addEta(id('DEMO-1001'), day(4), '원자재 입고 지연', '데모');
S.addEta(id('DEMO-1003'), day(8), '공급사 설비 점검', '데모');
S.addEta(id('DEMO-1006'), day(10), '조기 납품 가능 통보', '데모');
// 예전 입고 (SAP에 이미 반영된 것으로 확인됨)
const rc = (v, item, qty, d, note) => ({ vendorCode: V[v][0], vendor: V[v][1], item, qty, date: day(d), note });
S.addReceipts([
  rc('A', 'HB-M6X20-ZN', 30000, -27, '착(화물)'),
  rc('A', 'HB-M6X20-ZN', 15000, -12, '착'),
  rc('A', 'HB-M8X30-ZN', 30000, -18, '착(용차)'),
  rc('B', 'NT-M6-SUS', 50000, -8, '착'),
  rc('C', 'WS-08-FLAT', 40000, -4, '착'),
], { by: '데모' });
// 새 SAP 목록 업로드: 위 입고가 반영된 잔량. 한 품번은 SAP 잔량이 2,000 더 적게 → '확인 필요'
const now = new Map(S.listLines({ includeClosed: true }).map(l => [l.po + '|' + l.line, l.open_qty]));
upload(l => (now.get(l[0] + '|' + l[2]) ?? l[5]) - (l[0] === 'DEMO-1005' && l[2] === 2 ? 2000 : 0));
// 방금 들어온 입고 (SAP 반영 대기)
S.addReceipts([
  rc('D', 'SC-4X12-BK', 120000, -1, '착(화물)'),
  rc('B', 'NT-M8-SUS', 20000, 0, '착'),
], { by: '데모' });
// '신규' 표시는 최근 두 발주에만
S.db.prepare("UPDATE po_lines SET first_seen=? WHERE po NOT IN ('DEMO-1009','DEMO-1010')").run(day(-30));
S.db.close();
console.log('예시 데이터를 만들었어요:', dir);
