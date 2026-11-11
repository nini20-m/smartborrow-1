const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = ms => ms ? new Date(ms).toLocaleString() : '';
const today = () => new Date().toISOString().slice(0, 10);
let token = localStorage.getItem('sb_token'), me = null, unread = 0, knownUsers = null;

async function api(p, method = 'GET', body) {
  const r = await fetch('/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
  return d;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', 3000); }
const go = h => { location.hash = h; };
function requireLogin() {
  if (me) return true;
  sessionStorage.setItem('next', location.hash || '#/items'); go('#/login'); return false;
}
const view = html => { $('#view').innerHTML = html; };
const statusTag = i => i.status !== 'available' ? `<span class="tag bad">${i.status === 'under_repair' ? 'Under repair' : 'Lost'}</span>`
  : i.available > 0 ? '<span class="tag ok">Available</span>' : '<span class="tag warn">All borrowed</span>';
const txTag = t => t.status === 'returned' ? `<span class="tag ok">Returned (${esc(t.returnCondition)})</span>`
  : t.status === 'returning' ? '<span class="tag warn">Waiting lender confirmation</span>'
  : t.dueDate < today() ? '<span class="tag bad">Overdue</span>' : '<span class="tag">Borrowed</span>';

// ---------- NAV ----------
function renderNav() {
  let l = '<a class="brand" href="#/items">SmartBorrow</a><a href="#/items">Items</a>';
  if (me) {
    l += '<a href="#/mine">My Borrowings</a>';
    if (me.role === 'lender' || me.role === 'admin') l += '<a href="#/lender">My Items &amp; Returns</a>';
    if (me.role === 'admin') l += '<a href="#/admin">Admin</a>';
    l += `<a href="#/notifs">Notifications${unread ? ` <span class="badge">${unread}</span>` : ''}</a><span>${esc(me.name)}</span><button onclick="logout()">Log out</button>`;
  } else l += '<a href="#/login">Log in</a><a href="#/register">Create account</a>';
  $('#nav').innerHTML = l;
}
async function logout() { try { await api('/logout', 'POST'); } catch (e) {} token = null; localStorage.removeItem('sb_token'); me = null; go('#/login'); }
function afterAuth(d) {
  token = d.token; localStorage.setItem('sb_token', token); me = d.user;
  const next = sessionStorage.getItem('next') || '#/items'; sessionStorage.removeItem('next'); go(next); route();
}

// ---------- VIEWS ----------
const views = {};
views.login = () => {
  view(`<div class="card" style="max-width:420px;margin:auto"><h2>Log in</h2>
  <form onsubmit="doLogin(event)"><label>Username</label><input id="u" required autocomplete="username"><label>Password</label><input id="p" type="password" required autocomplete="current-password">
  <button class="btn">Log in</button> <a href="#/register">Create account</a></form></div>`);
};
async function doLogin(e) { e.preventDefault(); try { afterAuth(await api('/login', 'POST', { username: $('#u').value, password: $('#p').value })); } catch (x) { toast(x.message); } }

views.register = () => {
  view(`<div class="card" style="max-width:460px;margin:auto"><h2>Create account</h2>
  <p class="muted">Your account is active right away. No admin approval needed.</p>
  <form onsubmit="doRegister(event)">
  <label>Full name</label><input id="n" required>
  <label>Username</label><input id="u" required autocomplete="username">
  <label>Contact number (optional)</label><input id="c">
  <label>Password (min. 6 characters)</label><input id="p" type="password" required autocomplete="new-password">
  <label>I am a</label><select id="r"><option value="borrower">Borrower</option><option value="lender">Item lender / owner</option></select>
  <button class="btn">Sign up</button> <a href="#/login">I already have an account</a></form></div>`);
};
async function doRegister(e) {
  e.preventDefault();
  try { afterAuth(await api('/register', 'POST', { name: $('#n').value, username: $('#u').value, contact: $('#c').value, password: $('#p').value, role: $('#r').value })); toast('Welcome to SmartBorrow!'); }
  catch (x) { toast(x.message); }
}

views.items = async () => {
  let items = []; if (me) items = await api('/items');
  if (!me) { view(`<div class="card"><h2>Welcome to SmartBorrow</h2><p>Scan the QR code on an item to borrow it, or log in to see all items.</p><a class="btn" href="#/login">Log in</a><a class="btn gold" href="#/register">Create account</a></div>`); return; }
  view(`<div class="card"><h2>Items</h2><div class="row"><input id="q" placeholder="Search name or category..." oninput="filterItems()"></div></div><div class="grid" id="grid"></div>`);
  window._items = items; filterItems();
};
function filterItems() {
  const q = ($('#q').value || '').toLowerCase();
  $('#grid').innerHTML = window._items.filter(i => (i.name + i.category).toLowerCase().includes(q)).map(i => `<div class="card"><b>${esc(i.name)}</b><br><span class="muted">${esc(i.category)} &middot; ${esc(i.lenderName)}</span><p>${statusTag(i)} <span class="muted">${i.available} of ${i.quantity} available</span></p><a class="btn sm" href="#/item/${i.id}">Open</a></div>`).join('') || '<p class="muted">No items found.</p>';
}

// Page opened after scanning a QR code
views.item = async id => {
  let i; try { i = await api('/public/item/' + id); } catch (e) { view(`<div class="card"><h2>Item not found</h2><p>This QR code is not registered.</p></div>`); return; }
  let html = `<div class="card"><h2>${esc(i.name)}</h2><p>${statusTag(i)} <span class="muted">${i.available} of ${i.quantity} available</span></p>
  <p class="muted">Category: ${esc(i.category)} &middot; Condition: ${esc(i.condition)} &middot; Owner: ${esc(i.lenderName)}</p><p>${esc(i.description)}</p></div>`;
  if (!me) {
    sessionStorage.setItem('next', '#/item/' + id);
    html += `<div class="card"><p>Please log in to borrow or return this item.</p><a class="btn" href="#/login">Log in</a><a class="btn gold" href="#/register">Create account</a></div>`;
  } else {
    const mine = (await api('/transactions')).filter(t => t.itemId === id && t.borrowerId === me.id && t.status === 'borrowed');
    mine.forEach(t => html += `<div class="card"><h3>You borrowed ${t.qty} piece(s)</h3><p>Due: ${esc(t.dueDate)} ${txTag(t)}</p><button class="btn green" onclick="requestReturn('${t.id}','${id}')">Return this item</button></div>`);
    if (i.status === 'available' && i.available > 0) {
      const d = new Date(); d.setDate(d.getDate() + 3);
      html += `<div class="card"><h3>Borrow this item</h3><form onsubmit="doBorrow(event,'${id}')">
      <div class="row"><div><label>Quantity (max ${i.available})</label><input id="qty" type="number" min="1" max="${i.available}" value="1" required></div>
      <div><label>Return date</label><input id="due" type="date" min="${today()}" value="${d.toISOString().slice(0, 10)}" required></div></div>
      <label>Purpose / event (optional)</label><input id="purpose"><button class="btn">Borrow</button></form></div>`;
    }
  }
  view(html);
};
async function doBorrow(e, id) {
  e.preventDefault();
  try { await api('/borrow', 'POST', { itemId: id, qty: $('#qty').value, dueDate: $('#due').value, purpose: $('#purpose').value }); toast('Borrowed! The owner was notified.'); go('#/mine'); }
  catch (x) { toast(x.message); }
}
async function requestReturn(tid, itemId) {
  try { await api('/transactions/' + tid + '/return-request', 'POST'); toast('Return sent. Wait for the lender to confirm.'); itemId ? views.item(itemId) : views.mine(); } catch (x) { toast(x.message); }
}

views.mine = async () => {
  if (!requireLogin()) return;
  const list = (await api('/transactions')).filter(t => t.borrowerId === me.id);
  view(`<div class="card"><h2>My Borrowings</h2><div class="table-wrap"><table><tr><th>Item</th><th>Qty</th><th>Borrowed</th><th>Due</th><th>Status</th><th></th></tr>
  ${list.map(t => `<tr><td>${esc(t.itemName)}</td><td>${t.qty}</td><td>${fmt(t.borrowedAt)}</td><td>${esc(t.dueDate)}</td><td>${txTag(t)}</td><td>${t.status === 'borrowed' ? `<button class="btn sm green" onclick="requestReturn('${t.id}')">Return</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing borrowed yet.</td></tr>'}</table></div></div>`);
};

views.lender = async () => {
  if (!requireLogin()) return;
  if (me.role === 'borrower') { view('<div class="card">Only lenders can open this page.</div>'); return; }
  const [items, txs] = await Promise.all([api('/items'), api('/transactions')]);
  const mineItems = items.filter(i => i.lenderId === me.id || me.role === 'admin');
  const loans = txs.filter(t => (t.lenderId === me.id || me.role === 'admin') && t.status !== 'returned');
  view(`<div class="card"><h2>Borrowed items &amp; returns</h2><div class="table-wrap"><table><tr><th>Item</th><th>Borrower</th><th>Qty</th><th>Due</th><th>Status</th><th>Inspect &amp; confirm return</th></tr>
  ${loans.map(t => `<tr><td>${esc(t.itemName)}</td><td>${esc(t.borrowerName)}<br><span class="muted">${esc(t.borrowerContact)}</span></td><td>${t.qty}</td><td>${esc(t.dueDate)}</td><td>${txTag(t)}</td>
  <td><select id="c${t.id}"><option value="good">Good condition</option><option value="damaged">Damaged</option><option value="lost">Lost</option></select><input id="n${t.id}" placeholder="Note (optional)"><button class="btn sm green" onclick="confirmReturn('${t.id}')">Confirm return</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No active loans.</td></tr>'}</table></div></div>
  <div class="card"><h2>Register new item</h2><form onsubmit="addItem(event)"><div class="row"><div><label>Item name</label><input id="in" required></div><div><label>Category</label><input id="ic" placeholder="Chairs, Tools, ..."></div><div><label>Quantity</label><input id="iq" type="number" min="1" value="1" required></div><div><label>Condition</label><input id="id" value="Good"></div></div>
  <label>Description</label><textarea id="ids" rows="2"></textarea><button class="btn">Add item &amp; generate QR</button></form></div>
  <div class="card"><h2>My items</h2><div class="table-wrap"><table><tr><th>Item</th><th>Available / Total</th><th>Status</th><th>Actions</th></tr>
  ${mineItems.map(i => `<tr><td>${esc(i.name)}<br><span class="muted">${esc(i.category)} &middot; ${esc(i.condition)}</span></td><td>${i.available} / ${i.quantity}</td>
  <td><select onchange="setStatus('${i.id}',this.value)"><option value="available" ${i.status === 'available' ? 'selected' : ''}>Available</option><option value="under_repair" ${i.status === 'under_repair' ? 'selected' : ''}>Under repair</option><option value="lost" ${i.status === 'lost' ? 'selected' : ''}>Lost</option></select></td>
  <td><a class="btn sm gold" href="#/qr/${i.id}">QR code</a><button class="btn sm red" onclick="delItem('${i.id}')">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No items yet.</td></tr>'}</table></div></div>`);
};
async function addItem(e) {
  e.preventDefault();
  try { const i = await api('/items', 'POST', { name: $('#in').value, category: $('#ic').value, quantity: $('#iq').value, condition: $('#id').value, description: $('#ids').value }); toast('Item added.'); go('#/qr/' + i.id); }
  catch (x) { toast(x.message); }
}
async function setStatus(id, s) { try { await api('/items/' + id, 'PUT', { status: s }); toast('Updated.'); } catch (x) { toast(x.message); } }
async function delItem(id) { if (!confirm('Delete this item?')) return; try { await api('/items/' + id, 'DELETE'); views.lender(); } catch (x) { toast(x.message); } }
async function confirmReturn(id) {
  try { await api('/transactions/' + id + '/confirm', 'POST', { condition: $('#c' + id).value, note: $('#n' + id).value }); toast('Return confirmed.'); views.lender(); } catch (x) { toast(x.message); }
}

views.qr = async id => {
  if (!requireLogin()) return;
  const i = await api('/public/item/' + id), url = location.origin + '/#/item/' + id;
  view(`<div class="card center" id="printArea"><h2>${esc(i.name)}</h2><div id="qrbox"></div><p class="muted">Scan to borrow or return &middot; SmartBorrow</p><p class="muted" style="word-break:break-all">${esc(url)}</p></div>
  <div class="noprint center"><button class="btn" onclick="print()">Print QR label</button><a class="btn gold" href="#/lender">Back</a>
  <p class="muted">Tip: open this website using its real address (not "localhost") before printing, so phones can reach it.</p></div>`);
  if (window.QRCode) new QRCode($('#qrbox'), { text: url, width: 240, height: 240 }); else $('#qrbox').textContent = 'QR library failed to load (check internet).';
};

views.notifs = async () => {
  if (!requireLogin()) return;
  const list = await api('/notifications'); await api('/notifications/read', 'POST'); unread = 0; renderNav();
  view(`<div class="card"><h2>Notifications</h2>${list.map(n => `<p>${n.read ? '' : '<span class="badge">new</span> '}<a href="${esc(n.link || '#/items')}">${esc(n.text)}</a><br><span class="muted">${fmt(n.createdAt)}</span></p>`).join('') || '<p class="muted">No notifications.</p>'}</div>`);
};

// ---------- ADMIN ----------
views.admin = async () => {
  if (!requireLogin()) return;
  if (me.role !== 'admin') { view('<div class="card">Admins only.</div>'); return; }
  const r = await api('/admin/report');
  view(`<div class="stats">${[['Users', r.users], ['Items', r.items], ['Active loans', r.activeLoans], ['Overdue', r.overdue], ['Damaged', r.damaged], ['Lost', r.lost]].map(s => `<div class="stat"><b>${s[1]}</b>${s[0]}</div>`).join('')}</div><br>
  <div class="card"><h2>User accounts</h2><button class="btn gold" onclick="loadUsers(true)">&#8635; Refresh</button> <span id="ucount" class="muted"></span>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Contact</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody id="utable"></tbody></table></div></div>`);
  knownUsers = null; loadUsers(false);
};
async function loadUsers(manual) {
  const users = await api('/admin/users');
  const newOnes = knownUsers ? users.filter(u => !knownUsers.has(u.id)) : [];
  knownUsers = new Set(users.map(u => u.id));
  const dayAgo = Date.now() - 86400000;
  $('#utable').innerHTML = users.map(u => `<tr><td>${esc(u.name)} ${u.createdAt > dayAgo ? '<span class="badge">NEW</span>' : ''}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${esc(u.contact)}</td><td>${fmt(u.createdAt)}</td>
  <td>${u.active ? '<span class="tag ok">Active</span>' : '<span class="tag bad">Disabled</span>'}</td>
  <td>${u.role === 'admin' ? '' : `<button class="btn sm" onclick="toggleUser('${u.id}')">${u.active ? 'Disable' : 'Enable'}</button><button class="btn sm red" onclick="delUser('${u.id}')">Delete</button>`}</td></tr>`).join('');
  $('#ucount').textContent = `${users.length} account(s) · updated ${new Date().toLocaleTimeString()}`;
  if (manual) toast(newOnes.length ? `${newOnes.length} new account(s) found!` : 'No new accounts.');
}
async function toggleUser(id) { try { await api('/admin/users/' + id + '/toggle', 'POST'); loadUsers(); } catch (x) { toast(x.message); } }
async function delUser(id) { if (!confirm('Delete this account?')) return; try { await api('/admin/users/' + id, 'DELETE'); loadUsers(); } catch (x) { toast(x.message); } }

// ---------- ROUTER ----------
async function route() {
  const [, page, arg] = (location.hash || '#/items').split('/');
  if (token) { try { me = await api('/me'); const n = await api('/notifications'); unread = n.filter(x => !x.read).length; } catch (e) { token = null; me = null; localStorage.removeItem('sb_token'); } } else me = null;
  renderNav();
  try { await (views[page] || views.items)(arg); } catch (e) { view(`<div class="card">Error: ${esc(e.message)}</div>`); }
}
window.addEventListener('hashchange', route);
route();
