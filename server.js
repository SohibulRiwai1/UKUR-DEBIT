'use strict';
/**
 * Server Sistem Pencatatan Debit — tanpa dependensi (hanya Node.js >= 18).
 * Penyimpanan: file JSON (data/db.json). Login: username + password (scrypt), sesi via cookie.
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

// Muat .env sederhana
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');
const SESSION_MS = 12 * 3600 * 1000;
const TYPES = ['persegi', 'vnotch', 'cipolletti', 'ufm'];

/* ---------- Database JSON ---------- */
let db = { users: [], stations: [], readings: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch {}
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = DATA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA);
}

/* ---------- Password & sesi ---------- */
function hash(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verify(pw, u) {
  const a = Buffer.from(hash(pw, u.salt).hash, 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sessions = new Map(), attempts = new Map();

if (!db.users.length) {
  const user = process.env.ADMIN_USER || 'admin', pass = process.env.ADMIN_PASS || 'admin123';
  db.users.push({ username: user, name: 'Administrator', role: 'admin', ...hash(pass) });
  save();
  console.log(`[setup] Admin awal dibuat: ${user} / ${pass}  -> SEGERA ganti password di menu Akun.`);
}

/* ---------- Util ---------- */
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const fail = (res, code, msg) => send(res, code, { error: msg });
const str = (v, n = 200) => String(v ?? '').slice(0, n);
const num = v => (Number.isFinite(+v) && v !== '' && v !== null ? +v : null);
function body(req) {
  return new Promise((ok, no) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e5) { no(new Error('Terlalu besar')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { no(new Error('JSON tidak valid')); } });
  });
}
function auth(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  if (!s || s.exp < Date.now()) return null;
  const u = db.users.find(x => x.username === s.u);
  return u ? { u, token: m[1] } : null;
}
const pub = u => ({ username: u.username, name: u.name, role: u.role });

/* ---------- API ---------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const isJson = (req.headers['content-type'] || '').includes('application/json');
  if (req.method !== 'GET' && !isJson && req.method !== 'DELETE') return fail(res, 415, 'Content-Type harus application/json');

  if (route === 'POST /api/login') {
    const ip = req.socket.remoteAddress, a = attempts.get(ip) || { n: 0, reset: Date.now() + 6e5 };
    if (a.reset < Date.now()) { a.n = 0; a.reset = Date.now() + 6e5; }
    if (a.n >= 10) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi beberapa menit.');
    const b = await body(req);
    const u = db.users.find(x => x.username === str(b.username, 50).toLowerCase());
    if (!u || !verify(str(b.password, 200), u)) { a.n++; attempts.set(ip, a); return fail(res, 401, 'Username atau password salah.'); }
    attempts.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { u: u.username, exp: Date.now() + SESSION_MS });
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, pub(u), { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
  }

  const A = auth(req);
  if (!A) return fail(res, 401, 'Belum login.');
  const me = A.u, admin = me.role === 'admin';

  if (route === 'GET /api/me') return send(res, 200, pub(me));
  if (route === 'POST /api/logout') { sessions.delete(A.token); return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' }); }

  if (route === 'POST /api/password') {
    const b = await body(req);
    if (!verify(str(b.old, 200), me)) return fail(res, 400, 'Password lama salah.');
    if (str(b.new, 200).length < 8) return fail(res, 400, 'Password baru minimal 8 karakter.');
    Object.assign(me, hash(str(b.new, 200))); save();
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/stations') return send(res, 200, db.stations);
  if (route === 'GET /api/readings') return send(res, 200, db.readings);

  if (route === 'POST /api/stations') {
    if (!admin) return fail(res, 403, 'Hanya admin yang boleh mengelola titik ukur.');
    const b = await body(req);
    if (!TYPES.includes(b.type) || !str(b.name).trim()) return fail(res, 400, 'Data titik ukur tidak valid.');
    const s = { id: str(b.id, 40).replace(/[^\w-]/g, '') || crypto.randomUUID(), name: str(b.name, 100).trim(), cat: str(b.cat, 40), type: b.type };
    if (b.type === 'persegi') { s.b = num(b.b); s.p = num(b.p); s.cd = num(b.cd); s.cdAuto = !(s.cd > 0); if (!(s.b > 0 && s.p > 0)) return fail(res, 400, 'b dan p wajib > 0.'); }
    if (b.type === 'vnotch') { s.ang = num(b.ang); s.cd = num(b.cd); if (!(s.ang > 0 && s.ang < 180 && s.cd > 0)) return fail(res, 400, 'Sudut/Cd tidak valid.'); }
    if (b.type === 'cipolletti') { s.b = num(b.b); if (!(s.b > 0)) return fail(res, 400, 'b wajib > 0.'); }
    const i = db.stations.findIndex(x => x.id === s.id);
    i >= 0 ? (db.stations[i] = s) : db.stations.push(s);
    save(); return send(res, 200, s);
  }
  let m = /^\/api\/stations\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === 'DELETE') {
    if (!admin) return fail(res, 403, 'Hanya admin.');
    db.stations = db.stations.filter(x => x.id !== m[1]); save(); return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/readings') {
    const b = await body(req);
    const st = db.stations.find(x => x.id === b.sid);
    const q = num(b.q);
    if (!st || q === null || q < 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str(b.t))) return fail(res, 400, 'Data pengukuran tidak valid.');
    const id = str(b.id, 40).replace(/[^\w-]/g, '') || crypto.randomUUID();
    if (db.readings.some(x => x.id === id)) return send(res, 200, { ok: true });
    const r = { id, sid: st.id, sname: st.name, type: st.type, t: str(b.t, 16), op: str(b.op, 80) || me.name, h: num(b.h), q, note: str(b.note, 300), uid: me.username, ts: Date.now() };
    db.readings.push(r); save(); return send(res, 200, r);
  }
  m = /^\/api\/readings\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === 'DELETE') {
    const r = db.readings.find(x => x.id === m[1]);
    if (r && (admin || r.uid === me.username)) { db.readings = db.readings.filter(x => x.id !== m[1]); save(); return send(res, 200, { ok: true }); }
    return fail(res, 403, 'Hanya admin atau pembuat data yang boleh menghapus.');
  }

  if (url.pathname.startsWith('/api/users')) {
    if (!admin) return fail(res, 403, 'Hanya admin.');
    if (route === 'GET /api/users') return send(res, 200, db.users.map(pub));
    if (route === 'POST /api/users') {
      const b = await body(req), un = str(b.username, 50).toLowerCase().trim();
      if (!/^[a-z0-9._-]{3,50}$/.test(un)) return fail(res, 400, 'Username 3–50 karakter (huruf kecil, angka, . _ -).');
      if (str(b.password, 200).length < 8) return fail(res, 400, 'Password minimal 8 karakter.');
      if (db.users.some(x => x.username === un)) return fail(res, 409, 'Username sudah dipakai.');
      db.users.push({ username: un, name: str(b.name, 80) || un, role: b.role === 'admin' ? 'admin' : 'operator', ...hash(str(b.password, 200)) });
      save(); return send(res, 200, { ok: true });
    }
    m = /^\/api\/users\/([\w.-]+)$/.exec(url.pathname);
    if (m && req.method === 'DELETE') {
      if (m[1] === me.username) return fail(res, 400, 'Tidak bisa menghapus akun sendiri.');
      db.users = db.users.filter(x => x.username !== m[1]);
      for (const [t, s] of sessions) if (s.u === m[1]) sessions.delete(t);
      save(); return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, 'Endpoint tidak ditemukan.');
}

/* ---------- Static ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serve(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serve(req, res, url);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (!res.headersSent) fail(res, 400, e.message || 'Permintaan tidak valid');
  }
}).listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));
