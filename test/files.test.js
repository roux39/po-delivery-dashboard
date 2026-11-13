'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { readXlsx } = require('../lib/xlsx');
const Forms = require('../lib/receipt-forms');
const Files = require('../lib/files');

// 테스트용 아주 작은 xlsx 만들기 (deflate 압축 zip)
function makeZip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'), data = zlib.deflateRawSync(raw), nb = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
function makeXlsx(rowsXml) {
  return makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="명세서" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>품 번</t></si><si><t>수 량</t></si><si><t>단 가</t></si><si><t>발주번호</t></si><si><r><t>AB12</t></r><r><t>3-0001</t></r></si><si><t>상 호</t></si><si><t>㈜가나화스너</t></si><si><t>출고일자</t></si></sst>',
    'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`,
  });
}

const refs = Forms.makeRefs([
  { item: 'AB123-0001', vendor: '(주)가나화스너', po: '900000001' },
  { item: 'CD456-0002', vendor: '(주)가나화스너', po: '900000002' },
  { item: 'XY999-0009', vendor: '다라산업(주)', po: '900000003' },
]);

test('엑셀: 공유 문자열, 날짜 서식, 빈 칸 위치', () => {
  const buf = makeXlsx('<row r="1"><c r="A1" t="s"><v>7</v></c><c r="C1" s="1"><v>46338</v></c></row>' +
    '<row r="3"><c r="B3" t="s"><v>4</v></c><c r="D3"><v>1500</v></c></row>');
  const [sh] = readXlsx(buf);
  assert.equal(sh.name, '명세서');
  assert.deepEqual(sh.rows[0], ['출고일자', '', '2026-11-12']);
  assert.deepEqual(sh.rows[1], []);
  assert.deepEqual(sh.rows[2], ['', 'AB123-0001', '', '1500']);
});

test('거래명세서 엑셀 양식: 제목줄 기준으로 품번·수량·PO, 복사본은 한 번만, 단가는 결과에 없음', async () => {
  const s = i => `t="s"><v>${i}</v>`;
  const block = r0 => `<row r="${r0}"><c r="A${r0}" ${s(7)}</c><c r="B${r0}" s="1"><v>46338</v></c><c r="D${r0}" ${s(5)}</c><c r="E${r0}" ${s(6)}</c></row>` +
    `<row r="${r0 + 2}"><c r="A${r0 + 2}" ${s(0)}</c><c r="B${r0 + 2}" ${s(1)}</c><c r="C${r0 + 2}" ${s(2)}</c><c r="D${r0 + 2}" ${s(3)}</c></row>` +
    `<row r="${r0 + 3}"><c r="A${r0 + 3}" ${s(4)}</c><c r="B${r0 + 3}"><v>1500</v></c><c r="C${r0 + 3}"><v>12.5</v></c><c r="D${r0 + 3}" t="inlineStr"><is><t>PO900000001</t></is></c></row>` +
    `<row r="${r0 + 4}"><c r="A${r0 + 4}" t="inlineStr"><is><t>CD456-0002</t></is></c><c r="C${r0 + 4}"><v>30</v></c></row>`;
  const buf = makeXlsx(block(1) + block(10));
  const r = await Files.receiptsFromFile(buf, 'x.xlsx', [...refs.items.values()].flatMap(v => [...v.vendors].map(vendor => ({ item: v.item, vendor, po: '' }))), '2026-11-13');
  assert.equal(r.kind, 'form');
  assert.equal(r.rows.length, 1, '수량 없는 줄은 건너뛰고, 두 번째 복사본은 한 번만');
  assert.deepEqual({ ...r.rows[0], checks: undefined }, { date: '2026-11-12', vendor: '(주)가나화스너', item: 'AB123-0001', qty: 1500, po: '900000001', known: true, checks: undefined });
  assert.ok(!JSON.stringify(r).includes('12.5'), '단가가 결과에 들어가면 안 됨');
});

test('글자인식 결과: 잘린 숫자, 글자 보정, 수량×단가=금액으로 수량 찾기', () => {
  const W = (t, x, y) => ({ t, x, y, w: t.length * 20, h: 30 });
  const page = { words: [
    W('거래명세표', 800, 100), W('2026년', 1500, 200), W('11월', 1640, 200), W('12일', 1730, 200),
    W('상호', 100, 300), W('다라산업(주)', 200, 300), W('성명', 600, 300),
    W('번호', 100, 500), W('품', 300, 500), W('명', 330, 500), W('규격', 700, 500), W('단가', 1100, 500), W('공급가액', 1400, 500),
    W('1', 100, 600), W('[XY999-OOO9]', 300, 600), W('M6X20', 700, 600), W('2', 900, 600), W(',000', 945, 600), W('15.5', 1100, 600), W('31,000', 1400, 600),
  ] };
  const out = Forms.extract(Forms.fromOcrPage(page), refs, { today: '2026-11-13', fileName: 'scan.pdf' });
  assert.equal(out.date, '2026-11-12');
  assert.equal(out.vendor, '다라산업(주)');
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].item, 'XY999-0009');
  assert.equal(out.rows[0].qty, 2000);
  assert.ok(out.rows[0].checks.some(c => c.startsWith('글자 보정')));
  assert.ok(out.rows[0].checks.includes('수량 확인'));
});

test('파일 종류: 예전 xls와 PDF 발주 목록은 안내', () => {
  const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.throws(() => Files.poFromFile(xls), /\.xlsx/);
  assert.throws(() => Files.poFromFile(Buffer.from('%PDF-1.4 ...')), /엑셀 파일로/);
});
