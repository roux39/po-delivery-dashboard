// 발주 납기 현황판 서버. 실행: node server.js  (또는 시작하기.bat 더블클릭)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Store = require('./lib/store');
const Files = require('./lib/files');
const Rules = require('./lib/rules');

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg('port') || process.env.PORT || 3000);
const DATA_DIR = path.resolve(arg('data') || process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC = path.join(__dirname, 'public');
const S = Store.open(DATA_DIR);
// 프로그램 파일이 바뀌었는지 알아보는 버전 (파일 수정 시각 기준)
const VERSION = (() => {
  let m = 0;
  for (const d of [__dirname, path.join(__dirname, 'lib'), PUBLIC]) {
    for (const f of fs.readdirSync(d)) {
      const st = fs.statSync(path.join(d, f));
      if (st.isFile() && /\.(js|html|css|ps1)$/.test(f)) m = Math.max(m, st.mtimeMs);
    }
  }
  return String(Math.round(m));
})();

// ---------- 비밀번호 / 로그인 ----------
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPw(pw, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function session(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const s = S.db.prepare('SELECT * FROM sessions WHERE sid=?').get(sid);
  if (!s) return null;
  const now = new Date().toISOString();
  if (s.expires < now) { S.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); return null; }
  return s;
}
function newSession(res, name) {
  const sid = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 30 * 864e5).toISOString();
  S.db.prepare('INSERT INTO sessions(sid,name,expires) VALUES(?,?,?)').run(sid, name, expires);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
}

// ---------- 응답 도우미 ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 20 * 1024 * 1024) { reject(new Error('보낸 내용이 너무 커요.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('잘못된 요청이에요.')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let file;
  if (pathname === '/rules.js') file = path.join(__dirname, 'lib', 'rules.js');
  else {
    file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('없는 페이지예요.'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const sess = session(req);
  const editor = !!sess;
  const needEditor = () => { if (!editor) { send(res, 401, { error: '구매팀 로그인이 필요해요.' }); return true; } return false; };
  if (m !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return send(res, 400, { error: '잘못된 요청이에요.' });

  if (p === '/api/me' && m === 'GET') {
    return send(res, 200, { editor, name: sess ? sess.name : null, needsSetup: !S.getSetting('password'), today: require('./lib/rules').todayISO(), lastPoUpload: S.getSetting('last_po_upload'), version: VERSION });
  }
  if (p === '/api/setup' && m === 'POST') {
    if (S.getSetting('password')) return send(res, 400, { error: '이미 비밀번호가 설정되어 있어요.' });
    const b = await readJson(req);
    if (!b.password || String(b.password).length < 4) return send(res, 400, { error: '비밀번호는 4자 이상으로 정해 주세요.' });
    if (!b.name || !String(b.name).trim()) return send(res, 400, { error: '이름을 입력해 주세요.' });
    S.setSetting('password', hashPw(String(b.password)));
    newSession(res, String(b.name).trim().slice(0, 30));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req);
    if (!b.name || !String(b.name).trim()) return send(res, 400, { error: '이름을 입력해 주세요.' });
    if (!checkPw(String(b.password || ''), S.getSetting('password'))) {
      await new Promise(r => setTimeout(r, 800));
      return send(res, 401, { error: '비밀번호가 맞지 않아요.' });
    }
    newSession(res, String(b.name).trim().slice(0, 30));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/logout' && m === 'POST') {
    const sid = cookies(req).sid;
    if (sid) S.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/password' && m === 'POST') {
    if (needEditor()) return;
    const b = await readJson(req);
    if (!checkPw(String(b.current || ''), S.getSetting('password'))) return send(res, 400, { error: '지금 비밀번호가 맞지 않아요.' });
    if (!b.next || String(b.next).length < 4) return send(res, 400, { error: '새 비밀번호는 4자 이상으로 정해 주세요.' });
    S.setSetting('password', hashPw(String(b.next)));
    S.db.prepare('DELETE FROM sessions WHERE sid<>?').run(sess.sid); // 다른 곳의 로그인은 모두 해제
    return send(res, 200, { ok: true });
  }

  if (p === '/api/lines' && m === 'GET') return send(res, 200, { lines: S.listLines({ includeClosed: url.searchParams.get('closed') === '1' }) });
  let mm;
  if ((mm = p.match(/^\/api\/lines\/(\d+)$/)) && m === 'GET') {
    const d = S.lineDetail(Number(mm[1]));
    return d ? send(res, 200, d) : send(res, 404, { error: '발주 줄을 찾지 못했어요.' });
  }
  if ((mm = p.match(/^\/api\/lines\/(\d+)\/eta$/)) && m === 'POST') {
    if (needEditor()) return;
    const b = await readJson(req);
    S.addEta(Number(mm[1]), b.eta, String(b.reason || '').slice(0, 200), sess.name);
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/eta\/(\d+)$/)) && m === 'DELETE') {
    if (needEditor()) return;
    return send(res, 200, { deleted: S.deleteEta(Number(mm[1])) });
  }
  if (p === '/api/po' && m === 'POST') {
    if (needEditor()) return;
    const b = await readJson(req);
    if (!Array.isArray(b.rows)) return send(res, 400, { error: '발주 내용이 비어 있어요.' });
    const summary = S.uploadPo(b.rows, { fullList: !!b.fullList, by: sess.name, dryRun: !!b.dryRun });
    return send(res, 200, { summary });
  }
  // 엑셀·PDF 파일 읽기 (저장은 하지 않고, 읽은 결과만 돌려줌)
  if (p === '/api/file' && m === 'POST') {
    if (needEditor()) return;
    const b = await readJson(req);
    const buf = Buffer.from(String(b.data || ''), 'base64');
    if (!buf.length) return send(res, 400, { error: '파일이 비어 있어요.' });
    try {
      if (b.purpose === 'po') return send(res, 200, Files.poFromFile(buf));
      const r = await Files.receiptsFromFile(buf, String(b.name || ''), S.refLines(), Rules.todayISO());
      if (r.kind === 'form') r.vendors = [...new Set(S.refLines().map(l => l.vendor).filter(Boolean))].sort();
      return send(res, 200, r);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/receipts' && m === 'GET') return send(res, 200, { receipts: S.listReceipts() });
  if (p === '/api/receipts' && m === 'POST') {
    if (needEditor()) return;
    const b = await readJson(req);
    if (!Array.isArray(b.rows) || !b.rows.length) return send(res, 400, { error: '입고 내용이 비어 있어요.' });
    return send(res, 200, { result: S.addReceipts(b.rows, { by: sess.name }) });
  }
  if ((mm = p.match(/^\/api\/lines\/(\d+)\/check$/)) && m === 'DELETE') {
    if (needEditor()) return;
    return send(res, 200, { cleared: S.clearCheck(Number(mm[1])) });
  }
  if ((mm = p.match(/^\/api\/receipts\/(\d+)\/sap$/)) && m === 'POST') {
    if (needEditor()) return;
    const b = await readJson(req);
    return send(res, 200, { changed: S.setReceiptSap(Number(mm[1]), !!b.ok) });
  }
  if ((mm = p.match(/^\/api\/receipts\/(\d+)$/)) && m === 'DELETE') {
    if (needEditor()) return;
    return send(res, 200, { deleted: S.deleteReceipt(Number(mm[1])) });
  }
  if (p === '/api/uploads' && m === 'GET') return send(res, 200, { uploads: S.listUploads() });
  return send(res, 404, { error: '없는 기능이에요.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serveStatic(req, res, decodeURIComponent(url.pathname));
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message || '처리 중 문제가 생겼어요.' });
  }
});

// 하루 한 번: 자동 삭제 + 백업
function daily() {
  try {
    const r = S.purge();
    if (r.lines || r.receipts) console.log(`[자동 삭제] 발주 줄 ${r.lines}개, 입고 기록 ${r.receipts}개`);
    S.backup();
  } catch (e) { console.error('[자동 삭제/백업 실패]', e.message); }
}
// 브라우저 자동으로 열기 (끄려면 --no-open)
function openBrowser(url) {
  if (process.platform !== 'win32' || process.argv.includes('--no-open')) return;
  require('child_process').exec(`start "" "${url}"`, () => {});
}

// 이미 켜져 있을 때: 같은 버전이면 브라우저만 열고, 예전 버전이면 안내
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') { console.error('현황판을 켜지 못했어요:', e.message); process.exit(1); }
  const url = `http://localhost:${PORT}`;
  http.get(`http://127.0.0.1:${PORT}/api/me`, { timeout: 3000 }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      let me = null;
      try { me = JSON.parse(body); } catch { /* 다른 프로그램 */ }
      console.log('');
      if (me && me.today && me.version === VERSION) {
        console.log('  현황판은 이미 켜져 있어요. 브라우저로 열게요.');
        console.log(`  주소: ${url}`);
        openBrowser(url);
        process.exit(2);
      } else if (me && me.today) {
        console.log('  예전 버전의 현황판이 아직 켜져 있어요.');
        console.log('  작업 표시줄에서 "발주 납기 현황판" 까만 창을 찾아 닫은 뒤,');
        console.log('  시작하기.bat을 다시 실행해 주세요.');
        process.exit(3);
      } else {
        console.log(`  다른 프로그램이 ${PORT}번 포트를 쓰고 있어서 현황판을 켜지 못했어요.`);
        process.exit(4);
      }
    });
  }).on('error', () => { console.log(`\n  다른 프로그램이 ${PORT}번 포트를 쓰고 있어서 현황판을 켜지 못했어요.`); process.exit(4); });
});

server.listen(PORT, () => {
  daily();
  setInterval(daily, 6 * 3600 * 1000);
  openBrowser(`http://localhost:${PORT}`);
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('');
  console.log('  발주 납기 현황판이 켜졌어요.');
  console.log(`  이 PC에서 보기:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  팀원 접속 주소:   http://${ip}:${PORT}`);
  console.log(`  데이터 저장 위치: ${DATA_DIR}`);
  console.log('  이 창을 닫으면 현황판도 꺼져요.');
  console.log('');
});
