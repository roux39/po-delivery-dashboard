// 엑셀(.xlsx) 파일을 표(문자열 2차원 배열)로 읽기. 외부 라이브러리 없음.
'use strict';
const { readZip } = require('./zip');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e] ?? m));
const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? unxml(m[1]) : null; };
const allText = xml => { let s = ''; for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += unxml(m[1]); return s; };

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1;
}
function serialToISO(v) {
  const ms = Math.round((v - 25569) * 86400000);
  const d = new Date(ms);
  return isNaN(d) ? String(v) : d.toISOString().slice(0, 10);
}

function dateStyles(stylesXml) {
  const set = new Set();
  if (!stylesXml) return set;
  const custom = new Map();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) custom.set(Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '');
  const isDateFmt = id => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return true;
    const code = custom.get(id); if (!code) return false;
    const clean = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[yd]/i.test(clean) || /m{1,2}[^a-z]*d|d[^a-z]*m/i.test(clean);
  };
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!xfs) return set;
  let i = 0;
  for (const m of xfs[1].matchAll(/<xf\s[^>]*?\/?>/g)) { if (isDateFmt(Number(attr(m[0], 'numFmtId')))) set.add(i); i++; }
  return set;
}

function readXlsx(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('엑셀(.xlsx) 파일이 아니에요.');
  const z = readZip(buf);
  const txt = n => { const b = z.read(n); return b ? b.toString('utf8') : null; };
  const wb = txt('xl/workbook.xml');
  if (!wb) throw new Error('엑셀(.xlsx) 파일이 아니에요.');
  const rels = new Map();
  for (const m of (txt('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\s[^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const shared = [];
  const ss = txt('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(allText(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const dates = dateStyles(txt('xl/styles.xml'));

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const state = attr(m[0], 'state');
    let target = rels.get(attr(m[0], 'r:id')) || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = txt(target);
    if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\s([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(' ' + rm[1], 'r')) - 1 || rows.length;
      const row = [];
      for (const cm of (rm[2] || '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = ' ' + cm[1], body = cm[2] || '';
        let ci = colIndex(attr(a, 'r')); if (ci < 0) ci = row.length;
        const t = attr(a, 't');
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        let val = '';
        if (t === 's') val = v ? (shared[Number(v[1])] ?? '') : '';
        else if (t === 'inlineStr') val = allText(body);
        else if (t === 'b') val = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
        else if (v) {
          val = unxml(v[1]);
          if ((t === null || t === 'n') && dates.has(Number(attr(a, 's'))) && val !== '' && !isNaN(Number(val))) val = serialToISO(Number(val));
        }
        row[ci] = val;
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
      rows[r] = row;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name, hidden: !!state && state !== 'visible', rows });
  }
  return sheets;
}

// 표 → 붙여넣기와 같은 탭 구분 텍스트
function toTSV(rows) {
  return rows.map(r => r.map(c => {
    c = String(c ?? '');
    return /[\t\n\r"]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
  }).join('\t').replace(/\t+$/, '')).join('\n');
}

module.exports = { readXlsx, toTSV };
