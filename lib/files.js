// 데이터 올리기: 엑셀(.xlsx) / PDF 파일 읽기
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Rules = require('./rules');
const { readXlsx, toTSV } = require('./xlsx');
const Forms = require('./receipt-forms');

function kindOf(buf) {
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return 'xlsx';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0) return 'xls';
  return 'other';
}
const XLS_MSG = '예전 엑셀 형식(.xls)이에요. 엑셀에서 열고 "다른 이름으로 저장" → "Excel 통합 문서(.xlsx)"로 저장한 뒤 올려 주세요.';

// Windows 내장 기능으로 PDF 쪽마다 글자 인식
function ocrPdf(buf) {
  if (process.platform !== 'win32') return Promise.reject(new Error('PDF 읽기는 Windows PC에서만 돼요.'));
  const tmp = path.join(os.tmpdir(), 'fifo-' + crypto.randomBytes(8).toString('hex') + '.pdf');
  fs.writeFileSync(tmp, buf);
  const script = path.join(__dirname, 'pdf-ocr.ps1');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, tmp],
      { timeout: 180000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        fs.rm(tmp, { force: true }, () => {});
        if (err) {
          console.error('PDF 읽기 오류:', stderr || err.message);
          return reject(new Error('PDF를 읽지 못했어요. 암호가 걸린 PDF인지 확인해 주세요.'));
        }
        try {
          const j = JSON.parse(stdout.replace(/^﻿/, '').trim());
          resolve(j.pages == null ? [] : Array.isArray(j.pages) ? j.pages : [j.pages]);
        } catch { reject(new Error('PDF를 읽지 못했어요.')); }
      });
  });
}

// SAP 발주 목록 엑셀 → 붙여넣기와 같은 발주 줄
function poFromFile(buf) {
  const kind = kindOf(buf);
  if (kind === 'xls') throw new Error(XLS_MSG);
  if (kind === 'pdf') throw new Error('SAP 발주 목록은 엑셀 파일로 올려 주세요. (PDF는 거래명세서 입고 칸에서만 받아요)');
  if (kind !== 'xlsx') throw new Error('엑셀(.xlsx) 파일만 올릴 수 있어요.');
  let firstErr = null;
  for (const sh of readXlsx(buf).filter(s => !s.hidden)) {
    const ex = Rules.extractPoRows(toTSV(sh.rows));
    if (!ex.error && ex.rows.length) return { rows: ex.rows, sheet: sh.name };
    if (ex.error && !firstErr && /필요한 열/.test(ex.error)) firstErr = ex.error;
  }
  throw new Error(firstErr || '이 파일에서 SAP 발주 목록(PO number… 제목줄)을 찾지 못했어요.');
}

// 거래명세서 (SAP 입고 양식 엑셀 / 공급사 엑셀 / PDF·스캔) → 입고 줄
async function receiptsFromFile(buf, name, refLines, today) {
  const kind = kindOf(buf);
  if (kind === 'xls') throw new Error(XLS_MSG);
  if (kind === 'other') throw new Error('엑셀(.xlsx) 또는 PDF 파일만 올릴 수 있어요.');
  const refs = Forms.makeRefs(refLines);
  const docs = []; // [{rows, vendor, date}]
  let sapRows = [];
  if (kind === 'xlsx') {
    for (const sh of readXlsx(buf).filter(s => !s.hidden)) {
      const ex = Rules.extractReceipts(toTSV(sh.rows), today);
      if (ex.rows && ex.rows.length) { sapRows = sapRows.concat(ex.rows); continue; }
      docs.push(Forms.extract(Forms.fromGrid(sh.rows), refs, { today, fileName: name }));
    }
  } else {
    const pages = await ocrPdf(buf);
    for (const p of pages) docs.push(Forms.extract(Forms.fromOcrPage(p), refs, { today, fileName: name }));
  }
  if (sapRows.length) return { kind: 'sap', rows: sapRows };

  // 쪽마다 날짜·공급사가 없으면 앞쪽 것을 이어 쓴다. 같은 내용 쪽(복사본)은 한 번만.
  const out = [], seen = new Set();
  let lastDate = null, lastVendor = null, vendorRaw = '';
  for (const d of docs) {
    const date = d.date || lastDate, vendor = d.vendor || lastVendor;
    lastDate = date; lastVendor = vendor; vendorRaw = vendorRaw || d.vendorRaw;
    const sig = d.rows.map(r => `${r.item}|${r.qty}|${r.po}`).join(';');
    if (!d.rows.length || seen.has(sig)) continue;
    seen.add(sig);
    for (const r of d.rows) out.push({ date, vendor: vendor || '', item: r.item, qty: r.qty, po: r.po, known: r.known, checks: r.checks });
  }
  return { kind: 'form', rows: out, vendorRaw, source: kind };
}

module.exports = { poFromFile, receiptsFromFile, ocrPdf, kindOf };
