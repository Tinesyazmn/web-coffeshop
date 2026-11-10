require('dotenv').config();
const express = require('express'), http = require('http'), crypto = require('crypto'), path = require('path');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');
const webpush = require('web-push'), QRCode = require('qrcode');

const env = process.env;
const app = express(), srv = http.createServer(app), io = new Server(srv);
const db = new DatabaseSync('kopi.db'); db.exec('pragma journal_mode = WAL');
const MID = env.MIDTRANS_SERVER_KEY;
const MID_URL = env.MIDTRANS_PRODUCTION === 'true' ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
const VAPID = env.VAPID_PUBLIC && env.VAPID_PRIVATE;
if (VAPID) webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC, env.VAPID_PRIVATE);

db.exec(`
create table if not exists tables(id integer primary key, nomor integer unique, token text unique);
create table if not exists menus(id integer primary key, nama text, harga integer, kategori text, aktif integer default 1);
create table if not exists orders(id integer primary key, pid text unique, table_id integer, status text, total integer,
  catatan text, pay_method text, pay_status text, qr_url text, created_at text default (datetime('now','localtime')));
create table if not exists order_items(id integer primary key, order_id integer, nama text, qty integer, harga integer);
create table if not exists subs(id integer primary key, order_id integer, endpoint text unique, p256dh text, auth text);
`);
for (const q of ['alter table orders add column nama text', 'alter table order_items add column opsi text']) { try { db.exec(q); } catch (e) {} }
const OPSI = [
  { key: 'suhu', label: 'Suhu', selalu: true, pilihan: [['Cold', 0], ['Hot', 0]] },
  { key: 'ukuran', label: 'Ukuran', selalu: true, pilihan: [['Regular', 0], ['Large', 5000]] },
  { key: 'gula', label: 'Gula', pilihan: [['Normal', 0], ['Less sugar', 0], ['No sugar', 0]] },
  { key: 'es', label: 'Es', skip: { suhu: 'Hot' }, pilihan: [['Normal', 0], ['Less ice', 0], ['No ice', 0]] },
  { key: 'topping', label: 'Ekstra topping', multi: true, pilihan: [['Extra Espresso', 6000], ['Gula Aren', 6000], ['Grass Jelly', 6000], ['Marie Regal', 6000]] },
];
const opsiFor = k => ['Kopi', 'Non-kopi'].includes(k) ? OPSI : null;
if (!db.prepare('select 1 from tables').get()) {
  const t = db.prepare('insert into tables(nomor,token) values(?,?)');
  for (let i = 1; i <= 10; i++) t.run(i, crypto.randomBytes(4).toString('hex'));
  const m = db.prepare('insert into menus(nama,harga,kategori) values(?,?,?)');
  [['Kopi Susu', 22000, 'Kopi'], ['Americano', 18000, 'Kopi'], ['Latte', 25000, 'Kopi'], ['Matcha Latte', 27000, 'Non-kopi'],
   ['Teh Tarik', 20000, 'Non-kopi'], ['Croissant', 20000, 'Makanan'], ['Roti Bakar Cokelat', 18000, 'Makanan']].forEach(r => m.run(...r));
}

app.use(express.json());

const isAdmin = h => { const p = Buffer.from((h || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':'); return !!env.ADMIN_PASSWORD && p === env.ADMIN_PASSWORD; };
const auth = (req, res, next) => isAdmin(req.headers.authorization) ? next() : res.set('WWW-Authenticate', 'Basic realm="Kopi"').sendStatus(401);

const full = id => {
  const o = db.prepare('select o.*, t.nomor from orders o join tables t on t.id=o.table_id where o.id=?').get(id);
  if (o) o.items = db.prepare('select nama, qty, opsi from order_items where order_id=?').all(id);
  return o;
};
const refresh = () => io.to('barista').emit('refresh');

// ---------- Customer ----------
app.get('/api/config', (_, res) => res.json({ vapid: VAPID ? env.VAPID_PUBLIC : null, qris: !!MID }));
app.get('/api/menu', (_, res) => res.json(db.prepare('select id,nama,harga,kategori,aktif from menus order by kategori,id').all().map(m => ({ ...m, opsi: opsiFor(m.kategori) }))));
app.get('/api/table/:token', (req, res) => {
  const t = db.prepare('select nomor from tables where token=?').get(req.params.token);
  t ? res.json(t) : res.sendStatus(404);
});

app.post('/api/orders', async (req, res) => {
  const { token, nama = '', items, catatan = '', method = 'cashier' } = req.body || {};
  const t = db.prepare('select * from tables where token=?').get(token);
  if (!t) return res.status(400).json({ error: 'Meja tidak dikenal. Scan ulang QR di meja.' });
  const who = String(nama).trim().slice(0, 30);
  if (!who) return res.status(400).json({ error: 'Isi nama pemesan dulu.' });
  let total = 0; const rows = [];
  for (const i of Array.isArray(items) ? items : []) {   // harga selalu dihitung di server
    const m = db.prepare('select * from menus where id=?').get(Number(i.id));
    const q = Math.min(parseInt(i.qty) || 0, 20);
    if (m && q > 0) {
      if (!m.aktif) return res.status(409).json({ error: m.nama + ' sudah habis. Hapus dulu dari pesanan.' });
      let unit = m.harga; const pil = [], o = i.opsi || {};
      for (const g of opsiFor(m.kategori) || []) {   // harga + opsi dihitung ulang di server
        if (g.skip && Object.entries(g.skip).some(([k, v]) => o[k] === v)) continue;
        const dipilih = g.multi ? [].concat(o[g.key] || []).filter(n => g.pilihan.some(p => p[0] === n))
                                : [(g.pilihan.find(p => p[0] === o[g.key]) || g.pilihan[0])[0]];
        for (const n of new Set(dipilih)) {
          unit += g.pilihan.find(p => p[0] === n)[1];
          if (g.multi || g.selalu || n !== g.pilihan[0][0]) pil.push(n);
        }
      }
      total += unit * q; rows.push([m, q, unit, pil.join(', ')]);
    }
  }
  if (!rows.length) return res.status(400).json({ error: 'Keranjang kosong.' });

  const qris = method === 'qris' && MID, pid = crypto.randomBytes(6).toString('hex');
  let id;
  try {
    db.exec('BEGIN');
    const r = db.prepare('insert into orders(pid,table_id,nama,status,total,catatan,pay_method,pay_status) values(?,?,?,?,?,?,?,?)')
      .run(pid, t.id, who, qris ? 'menunggu' : 'baru', total, String(catatan).slice(0, 200), qris ? 'qris' : 'cashier', qris ? 'pending' : 'unpaid');
    id = Number(r.lastInsertRowid);
    for (const [m, q, unit, pil] of rows) db.prepare('insert into order_items(order_id,nama,qty,harga,opsi) values(?,?,?,?,?)').run(id, m.nama, q, unit, pil);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: 'Gagal menyimpan pesanan.' });
  }

  if (qris) {
    try {
      const r = await fetch(MID_URL + '/v2/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(MID + ':').toString('base64') },
        body: JSON.stringify({ payment_type: 'qris', transaction_details: { order_id: 'KOPI-' + id, gross_amount: total } }),
      });
      const c = await r.json(), qr = (c.actions || []).find(a => a.name === 'generate-qr-code');
      if (!qr) throw new Error(c.status_message || 'charge gagal');
      db.prepare('update orders set qr_url=? where id=?').run(qr.url, id);
    } catch (e) {
      db.prepare("update orders set status='batal' where id=?").run(id);
      return res.status(502).json({ error: 'QRIS gagal dibuat, coba bayar di kasir.' });
    }
  } else refresh();
  res.status(201).json({ pid });
});

app.get('/api/orders/:pid', (req, res) => {
  const o = db.prepare('select id from orders where pid=?').get(req.params.pid);
  if (!o) return res.sendStatus(404);
  const f = full(o.id);
  res.json({ id: f.id, nama: f.nama, nomor: f.nomor, status: f.status, total: f.total, pay_method: f.pay_method, pay_status: f.pay_status, qr_url: f.qr_url, items: f.items });
});

app.post('/api/orders/:pid/push', (req, res) => {
  const o = db.prepare('select id from orders where pid=?').get(req.params.pid), s = req.body && req.body.subscription;
  if (!o || !s || !s.endpoint) return res.sendStatus(400);
  db.prepare('insert or replace into subs(order_id,endpoint,p256dh,auth) values(?,?,?,?)').run(o.id, s.endpoint, s.keys.p256dh, s.keys.auth);
  res.sendStatus(201);
});

io.on('connection', socket => {
  socket.on('join:order', pid => socket.join('o:' + pid));
  socket.on('join:barista', () => { if (isAdmin(socket.handshake.headers.authorization)) socket.join('barista'); });
});

async function pushReady(o) {
  const payload = JSON.stringify({ title: 'Pesanan siap diambil ☕', body: `Pesanan #${o.id} sudah bisa diambil di counter.`, url: `/status.html?o=${o.pid}` });
  for (const s of db.prepare('select * from subs where order_id=?').all(o.id)) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('delete from subs where id=?').run(s.id); }
  }
}

// ---------- Payment webhook (QRIS) ----------
app.post('/api/midtrans/webhook', (req, res) => {
  const b = req.body || {};
  const sig = crypto.createHash('sha512').update(String(b.order_id) + b.status_code + b.gross_amount + MID).digest('hex');
  if (!MID || sig !== b.signature_key) return res.sendStatus(403);
  const id = +String(b.order_id).replace('KOPI-', ''), o = db.prepare('select * from orders where id=?').get(id);
  if (!o) return res.sendStatus(404);
  if (['settlement', 'capture'].includes(b.transaction_status)) {
    db.prepare("update orders set pay_status='paid', status=case when status='menunggu' then 'baru' else status end where id=?").run(id);
    io.to('o:' + o.pid).emit('status', {}); io.to('barista').emit('new'); refresh();
  } else if (['expire', 'cancel', 'deny'].includes(b.transaction_status)) {
    db.prepare("update orders set pay_status='expired', status='batal' where id=?").run(id);
    io.to('o:' + o.pid).emit('status', {});
  }
  res.sendStatus(200);
});

// ---------- Barista / admin ----------
app.get('/barista', auth, (_, res) => res.sendFile(path.join(__dirname, 'views/barista.html')));
app.get('/api/admin/orders', auth, (_, res) =>
  res.json(db.prepare("select id from orders where status in ('baru','diproses','siap') order by id").all().map(r => full(r.id))));

app.patch('/api/admin/orders/:id', auth, async (req, res) => {
  const o = db.prepare('select * from orders where id=?').get(req.params.id);
  if (!o) return res.sendStatus(404);
  const { status, paid } = req.body || {};
  if (paid) db.prepare("update orders set pay_status='paid' where id=?").run(o.id);
  if (['diproses', 'siap', 'selesai'].includes(status)) {
    db.prepare('update orders set status=? where id=?').run(status, o.id);
    io.to('o:' + o.pid).emit('status', {});
    if (status === 'siap' && VAPID) await pushReady(o);
    if (status === 'selesai') db.prepare('delete from subs where order_id=?').run(o.id);
  }
  refresh(); res.json(full(o.id));
});

app.get('/api/admin/history', auth, (_, res) => {
  const w = "date(created_at) = date('now','localtime') and status not in ('menunggu','batal')";
  const orders = db.prepare(`select id from orders where ${w} order by id desc`).all().map(r => full(r.id));
  const top = db.prepare(`select nama, sum(qty) as qty from order_items where order_id in (select id from orders where ${w}) group by nama order by qty desc limit 5`).all();
  res.json({ jumlah: orders.length, total: orders.reduce((n, o) => n + o.total, 0), top, orders });
});

app.get('/api/admin/menus', auth, (_, res) => res.json(db.prepare('select * from menus order by kategori,id').all()));
app.patch('/api/admin/menus/:id', auth, (req, res) => {
  db.prepare('update menus set aktif=? where id=?').run(req.body.aktif ? 1 : 0, Number(req.params.id)); res.sendStatus(204);
});

app.post('/api/admin/tables', auth, (req, res) => {
  const n = Math.min(Math.max(parseInt(req.body.jumlah) || 1, 1), 100);
  let last = db.prepare('select coalesce(max(nomor),0) as m from tables').get().m;
  for (let i = 0; i < n; i++) db.prepare('insert into tables(nomor,token) values(?,?)').run(++last, crypto.randomBytes(4).toString('hex'));
  res.json({ total: last });
});

app.get('/admin/qr', auth, async (_, res) => {
  const base = env.APP_URL || 'http://localhost:3000';
  const cards = await Promise.all(db.prepare('select * from tables order by nomor').all().map(async t => {
    const link = `${base}/menu.html?meja=${t.token}`;
    return `<figure><a href="${link}" target="_blank"><img src="${await QRCode.toDataURL(link, { width: 260, margin: 1 })}"></a><figcaption>Meja ${t.nomor}</figcaption></figure>`;
  }));
  res.send(`<!doctype html><meta charset="utf-8"><title>QR Meja</title>
<style>body{font:16px system-ui;display:flex;flex-wrap:wrap;gap:24px;padding:24px}
figure{margin:0;text-align:center;break-inside:avoid}figcaption{font-weight:700;font-size:20px}
.bar{flex-basis:100%;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.bar input{width:70px;padding:6px}
@media print{.bar{display:none}}</style>
<div class="bar"><b>Total ${cards.length} meja</b> · Tambah <input id="n" type="number" value="5" min="1" max="50"> meja
<button onclick="add()">Tambah</button><button onclick="print()">Cetak</button><small>Klik QR untuk membuka halaman customer</small></div>
${cards.join('')}
<script>async function add(){await fetch('/api/admin/tables',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jumlah:+document.getElementById('n').value})});location.reload()}</script>`);
});

app.get('/', (req, res) => res.redirect('/barista'));
app.use(express.static(path.join(__dirname, 'public')));
srv.listen(env.PORT || 3000, () => console.log('Jalan di http://localhost:' + (env.PORT || 3000)));
