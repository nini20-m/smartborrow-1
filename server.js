// SmartBorrow server - no packages needed. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname; // online hosting: set DATA_DIR to the persistent disk folder
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

let db = { users: [], items: [], transactions: [], notifications: [], sessions: {} };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const save = () => { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); };
const uid = () => crypto.randomBytes(5).toString('hex');
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const verifyPw = (pw, stored) => {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const err = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
const today = () => new Date().toISOString().slice(0, 10);
const pub = u => ({ id: u.id, name: u.name, username: u.username, contact: u.contact, role: u.role, active: u.active, createdAt: u.createdAt });
const notify = (userId, text, link) => db.notifications.push({ id: uid(), userId, text, link: link || '', read: false, createdAt: Date.now() });

// default admin account (change the password after first login!)
if (!db.users.some(u => u.role === 'admin')) {
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123'; // online hosting: set ADMIN_PASSWORD so the password is not public
  db.users.push({ id: uid(), name: 'SmartBorrow Admin', username: 'admin', contact: '', role: 'admin', passHash: hashPw(adminPw), active: true, createdAt: Date.now() });
  save();
  console.log('Admin created -> username: admin  password: ' + (process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : 'admin123'));
}

const routes = [];
const route = (method, p, auth, fn) => routes.push({ method, auth, fn, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

// ---------- AUTH ----------
route('POST', '/api/register', false, ({ body }) => {
  const name = String(body.name || '').trim(), username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || ''), role = body.role === 'lender' ? 'lender' : 'borrower';
  if (!name) throw err(400, 'Name is required.');
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw err(400, 'Username: 3-20 letters, numbers, . or _');
  if (password.length < 6) throw err(400, 'Password must be at least 6 characters.');
  if (db.users.some(u => u.username === username)) throw err(400, 'Username is already taken.');
  const user = { id: uid(), name, username, contact: String(body.contact || '').trim(), role, passHash: hashPw(password), active: true, createdAt: Date.now() };
  db.users.push(user); // active immediately - NO admin approval needed
  const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = user.id;
  db.users.filter(u => u.role === 'admin').forEach(a => notify(a.id, `New account: ${name} (${role})`, '#/admin'));
  save();
  return { token, user: pub(user) };
});
route('POST', '/api/login', false, ({ body }) => {
  const u = db.users.find(x => x.username === String(body.username || '').trim().toLowerCase());
  if (!u || !verifyPw(String(body.password || ''), u.passHash)) throw err(401, 'Wrong username or password.');
  if (!u.active) throw err(403, 'This account is disabled. Contact the administrator.');
  const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = u.id; save();
  return { token, user: pub(u) };
});
route('POST', '/api/logout', true, ({ token }) => { delete db.sessions[token]; save(); return { ok: true }; });
route('GET', '/api/me', true, ({ user }) => pub(user));

// ---------- ITEMS ----------
const itemOut = i => ({ ...i, lenderName: (db.users.find(u => u.id === i.lenderId) || {}).name || '' });
route('GET', '/api/public/item/:id', false, ({ params }) => {
  const i = db.items.find(x => x.id === params.id); if (!i) throw err(404, 'Item not found.');
  return itemOut(i);
});
route('GET', '/api/items', true, () => db.items.map(itemOut));
route('POST', '/api/items', ['lender', 'admin'], ({ body, user }) => {
  const name = String(body.name || '').trim(), quantity = parseInt(body.quantity, 10);
  if (!name) throw err(400, 'Item name is required.');
  if (!(quantity >= 1)) throw err(400, 'Quantity must be at least 1.');
  const item = { id: uid(), name, category: String(body.category || 'General').trim(), description: String(body.description || '').trim(),
    condition: String(body.condition || 'Good').trim(), quantity, available: quantity, status: 'available', lenderId: user.id, createdAt: Date.now() };
  db.items.push(item); save(); return itemOut(item);
});
route('PUT', '/api/items/:id', ['lender', 'admin'], ({ params, body, user }) => {
  const i = db.items.find(x => x.id === params.id); if (!i) throw err(404, 'Item not found.');
  if (user.role !== 'admin' && i.lenderId !== user.id) throw err(403, 'Not your item.');
  if (body.name) i.name = String(body.name).trim();
  if (body.category) i.category = String(body.category).trim();
  if (body.description !== undefined) i.description = String(body.description);
  if (body.condition) i.condition = String(body.condition);
  if (['available', 'under_repair', 'lost'].includes(body.status)) i.status = body.status;
  if (body.quantity !== undefined) {
    const q = parseInt(body.quantity, 10); if (!(q >= 0)) throw err(400, 'Invalid quantity.');
    i.available = Math.max(0, i.available + (q - i.quantity)); i.quantity = q;
  }
  save(); return itemOut(i);
});
route('DELETE', '/api/items/:id', ['lender', 'admin'], ({ params, user }) => {
  const i = db.items.find(x => x.id === params.id); if (!i) throw err(404, 'Item not found.');
  if (user.role !== 'admin' && i.lenderId !== user.id) throw err(403, 'Not your item.');
  if (db.transactions.some(t => t.itemId === i.id && ['borrowed', 'returning'].includes(t.status))) throw err(400, 'Item is currently borrowed.');
  db.items = db.items.filter(x => x.id !== i.id); save(); return { ok: true };
});

// ---------- BORROW / RETURN ----------
route('POST', '/api/borrow', true, ({ body, user }) => {
  const i = db.items.find(x => x.id === body.itemId); if (!i) throw err(404, 'Item not found.');
  const qty = parseInt(body.qty, 10), due = String(body.dueDate || '');
  if (i.status !== 'available') throw err(400, 'This item is not available for borrowing.');
  if (!(qty >= 1) || qty > i.available) throw err(400, `Only ${i.available} available.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due < today()) throw err(400, 'Choose a valid return date.');
  const t = { id: uid(), itemId: i.id, itemName: i.name, borrowerId: user.id, borrowerName: user.name, borrowerContact: user.contact,
    lenderId: i.lenderId, qty, purpose: String(body.purpose || '').trim(), borrowedAt: Date.now(), dueDate: due, status: 'borrowed' };
  i.available -= qty; db.transactions.push(t);
  notify(i.lenderId, `${user.name} borrowed ${qty} x ${i.name} (due ${due})`, '#/lender');
  save(); return t;
});
route('GET', '/api/transactions', true, ({ user }) => {
  let list = db.transactions;
  if (user.role === 'borrower') list = list.filter(t => t.borrowerId === user.id);
  else if (user.role === 'lender') list = list.filter(t => t.lenderId === user.id || t.borrowerId === user.id);
  return list.slice().sort((a, b) => b.borrowedAt - a.borrowedAt);
});
route('POST', '/api/transactions/:id/return-request', true, ({ params, user }) => {
  const t = db.transactions.find(x => x.id === params.id); if (!t) throw err(404, 'Not found.');
  if (t.borrowerId !== user.id) throw err(403, 'Not your borrowing.');
  if (t.status !== 'borrowed') throw err(400, 'Already requested or returned.');
  t.status = 'returning'; t.returnRequestedAt = Date.now();
  notify(t.lenderId, `${t.borrowerName} is returning ${t.qty} x ${t.itemName}. Please inspect and confirm.`, '#/lender');
  save(); return t;
});
route('POST', '/api/transactions/:id/confirm', ['lender', 'admin'], ({ params, body, user }) => {
  const t = db.transactions.find(x => x.id === params.id); if (!t) throw err(404, 'Not found.');
  if (user.role !== 'admin' && t.lenderId !== user.id) throw err(403, 'Not your item.');
  if (!['borrowed', 'returning'].includes(t.status)) throw err(400, 'Already returned.');
  const cond = ['good', 'damaged', 'lost'].includes(body.condition) ? body.condition : 'good';
  const i = db.items.find(x => x.id === t.itemId);
  if (i) { if (cond === 'lost') i.quantity = Math.max(0, i.quantity - t.qty); else { i.available += t.qty; if (cond === 'damaged') i.condition = 'Damaged'; } }
  t.status = 'returned'; t.returnedAt = Date.now(); t.returnCondition = cond; t.note = String(body.note || '');
  notify(t.borrowerId, `Return of ${t.itemName} confirmed (${cond}).`, '#/mine');
  save(); return t;
});

// ---------- NOTIFICATIONS ----------
route('GET', '/api/notifications', true, ({ user }) => db.notifications.filter(n => n.userId === user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50));
route('POST', '/api/notifications/read', true, ({ user }) => { db.notifications.forEach(n => { if (n.userId === user.id) n.read = true; }); save(); return { ok: true }; });

// ---------- ADMIN ----------
route('GET', '/api/admin/users', ['admin'], () => db.users.map(pub).sort((a, b) => b.createdAt - a.createdAt));
route('POST', '/api/admin/users/:id/toggle', ['admin'], ({ params, user }) => {
  const u = db.users.find(x => x.id === params.id); if (!u) throw err(404, 'Not found.');
  if (u.id === user.id) throw err(400, "You can't disable yourself.");
  u.active = !u.active; if (!u.active) Object.keys(db.sessions).forEach(k => { if (db.sessions[k] === u.id) delete db.sessions[k]; });
  save(); return pub(u);
});
route('DELETE', '/api/admin/users/:id', ['admin'], ({ params, user }) => {
  if (params.id === user.id) throw err(400, "You can't delete yourself.");
  db.users = db.users.filter(u => u.id !== params.id); save(); return { ok: true };
});
route('GET', '/api/admin/report', ['admin'], () => {
  const active = db.transactions.filter(t => ['borrowed', 'returning'].includes(t.status));
  return {
    users: db.users.length, items: db.items.length, transactions: db.transactions.length, activeLoans: active.length,
    overdue: active.filter(t => t.dueDate < today()).length,
    damaged: db.transactions.filter(t => t.returnCondition === 'damaged').length,
    lost: db.transactions.filter(t => t.returnCondition === 'lost').length,
  };
});

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      try {
        const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
        if (!r) throw err(404, 'Not found.');
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        const user = db.users.find(u => u.id === db.sessions[token]);
        if (r.auth) {
          if (!user) throw err(401, 'Please log in.');
          if (!user.active) throw err(403, 'Account disabled.');
          if (Array.isArray(r.auth) && !r.auth.includes(user.role)) throw err(403, 'Not allowed.');
        }
        const params = (url.pathname.match(r.re).groups) || {};
        send(200, r.fn({ body: raw ? JSON.parse(raw) : {}, params, user, token }));
      } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Server error' }); if (!e.status) console.error(e); }
    });
    return;
  }
  let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`SmartBorrow running: http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal)
    .forEach(n => console.log(`On your Wi-Fi (for phones): http://${n.address}:${PORT}`));
});