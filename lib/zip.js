// 아주 작은 ZIP 읽기 (엑셀 .xlsx 용). 외부 라이브러리 없이 Node 내장 zlib만 사용.
'use strict';
const zlib = require('zlib');

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('엑셀 파일을 읽지 못했어요. (zip 구조 아님)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    files.set(name.replace(/\\/g, '/'), { method, csize, local });
    p += 46 + nameLen + extraLen + commLen;
  }
  return {
    names: () => [...files.keys()],
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      const lh = f.local;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.slice(start, start + f.csize);
      if (f.method === 0) return data;
      if (f.method === 8) return zlib.inflateRawSync(data);
      throw new Error('지원하지 않는 압축 방식이에요.');
    },
  };
}

module.exports = { readZip };
