/* Storefront server: zero dependencies (Node.js 22.13+, built-in SQLite).
   - Serves the shop from ./public
   - REST API under /api for products, orders, subscribers, reviews and admin
   - Prices, discounts and shipping are recalculated here; the browser is never trusted with money. */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = +process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "store.db");
const UPLOAD_DIR = path.join(ROOT, "public", "uploads");
const CAT = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) { console.error("Set ADMIN_TOKEN (16+ characters) in .env before starting."); process.exit(1); }
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------- database ---------------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS products(sku TEXT PRIMARY KEY, flavor TEXT, size TEXT, price REAL, compare_at REAL, stock INTEGER, low_stock_at INTEGER, sold INTEGER DEFAULT 0, active INTEGER DEFAULT 1, sort INTEGER, photo_url TEXT DEFAULT '', updated_at TEXT);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, created_at TEXT, status TEXT, email TEXT, total REAL, data TEXT);
CREATE TABLE IF NOT EXISTS subscribers(email TEXT PRIMARY KEY, name TEXT, sources TEXT, restock TEXT, consent INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, created_at TEXT, status TEXT, rating INTEGER, name TEXT, email TEXT, flavor TEXT, title TEXT, body TEXT, verified INTEGER DEFAULT 0);`);
for (const col of ["helpful INTEGER DEFAULT 0", "photo TEXT DEFAULT ''"]) { try { db.exec(`ALTER TABLE reviews ADD COLUMN ${col}`); } catch (e) {} }
const now = () => new Date().toISOString();
function seed(onlyMissing = true) {
  const ins = db.prepare(`INSERT ${onlyMissing ? "OR IGNORE" : "OR REPLACE"} INTO products(sku,flavor,size,price,compare_at,stock,low_stock_at,sold,active,sort,photo_url,updated_at) VALUES(?,?,?,?,NULL,?,?,0,1,?,'',?)`);
  CAT.variants.forEach((v, i) => ins.run(v.sku, v.flavor, v.size, v.price, v.stock, v.lowStockAt, i, now()));
}
if (db.prepare("SELECT COUNT(*) n FROM products").get().n === 0) seed();
const rowToProduct = (r) => ({ sku: r.sku, flavor: r.flavor, size: r.size, price: r.price, compareAt: r.compare_at, stock: r.stock, lowStockAt: r.low_stock_at, sold: r.sold, active: !!r.active, order: r.sort, photoUrl: r.photo_url || "", updatedAt: r.updated_at });
const tx = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };

/* ---------------- payments (connect your provider here) ----------------
   createPayment(order) runs after the order is saved and stock is reserved.
   Return a URL to redirect the shopper to (e.g. a Stripe Checkout Session URL), or null to show the confirmation page.
   Example with Stripe (npm i stripe):
     const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
     const s = await stripe.checkout.sessions.create({ mode: "payment", customer_email: order.email,
       line_items: [{ price_data: { currency: "usd", product_data: { name: `Order ${order.id}` }, unit_amount: Math.round(order.totals.total * 100) }, quantity: 1 }],
       success_url: `${process.env.PUBLIC_URL}/?paid=${order.id}`, cancel_url: `${process.env.PUBLIC_URL}/`, metadata: { orderId: order.id } });
     return s.url;
   Then mark the order paid from the provider's webhook with markPaid(orderId) (see /api/payments/webhook). */
async function createPayment(order) { return null; }
function markPaid(orderId) { db.prepare("UPDATE orders SET status='paid', data=json_set(data,'$.status','paid','$.statusAt',?) WHERE id=? AND status='awaiting_payment'").run(now(), orderId); }

/* ---------------- helpers ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".ico": "image/x-icon", ".json": "application/json" };
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim()) && String(e).length < 200;
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
function send(res, code, obj, headers = {}) { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, headers)); res.end(b); }
function body(req, limit = 1e5) {
  return new Promise((resolve, reject) => { let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); } }); });
}
const hits = new Map(); // tiny per-IP rate limit for public writes
function limited(req, max = 20) { const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress; const t = Date.now(), w = (hits.get(ip) || []).filter((x) => t - x < 60000); w.push(t); hits.set(ip, w); return w.length > max; }
function isAdmin(req) { const h = req.headers.authorization || ""; const tok = h.startsWith("Bearer ") ? h.slice(7) : ""; const a = Buffer.from(tok), b = Buffer.from(ADMIN_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function adjustStock(sku, delta) { db.prepare("UPDATE products SET stock=stock+?, sold=MAX(0,sold-?), updated_at=? WHERE sku=?").run(delta, delta, now(), sku); }

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, ""), m = req.method;
  if (m === "GET" && p === "/products") return send(res, 200, { products: db.prepare("SELECT * FROM products ORDER BY sort").all().map(rowToProduct) });
  if (m === "GET" && p === "/reviews") return send(res, 200, { reviews: db.prepare("SELECT id,created_at createdAt,rating,name,flavor,title,body,verified,helpful,photo FROM reviews WHERE status='approved' ORDER BY created_at DESC LIMIT 200").all().map((r) => ({ ...r, verified: !!r.verified })) });

  if (m === "POST" && p === "/orders") {
    if (limited(req, 10)) return send(res, 429, { error: "Too many requests" });
    const o = await body(req);
    if (!emailOk(o.email)) return send(res, 400, { error: "Invalid email" });
    const a = o.address || {};
    if (!clean(o.name, 80) || !clean(a.a1, 120) || !clean(a.city, 60) || !/^[A-Z]{2}$/.test(a.state || "") || !/^\d{5}(-\d{4})?$/.test(a.zip || "")) return send(res, 400, { error: "Invalid address" });
    if (!Array.isArray(o.items) || !o.items.length || o.items.length > 20) return send(res, 400, { error: "Empty cart" });
    const items = [];
    for (const it of o.items) {
      const pr = db.prepare("SELECT * FROM products WHERE sku=? AND active=1").get(String(it.sku));
      const qty = Math.floor(+it.qty);
      if (!pr || !(qty >= 1 && qty <= 50)) return send(res, 400, { error: "Unknown product" });
      const unit = Math.round(pr.price * (it.sub ? 1 - CAT.subscribePct / 100 : 1) * 100) / 100;
      items.push({ sku: pr.sku, qty, unit, sub: !!it.sub });
    }
    const subtotal = items.reduce((s, i) => s + i.unit * i.qty, 0);
    const units = items.reduce((s, i) => s + i.qty, 0), tiers = CAT.bundle || [];
    const bundlePct = tiers.reduce((p, t) => (units >= t.min ? t.pct : p), 0), bundle = Math.round(subtotal * bundlePct) / 100;
    const code = CAT.codes.find((c) => c.code === String(o.promo || "").toUpperCase());
    const discount = code ? Math.round((subtotal - bundle) * code.pct) / 100 : 0;
    const ship = CAT.shipping.find((s) => s.id === o.shipping?.method) || CAT.shipping[0];
    const after = subtotal - bundle - discount;
    const shipping = ship.id === "standard" && after >= CAT.freeShipOver ? 0 : ship.price;
    const full = items.reduce((s, i) => s + db.prepare("SELECT price FROM products WHERE sku=?").get(i.sku).price * i.qty, 0);
    const totals = { subtotal: +subtotal.toFixed(2), bundle: +bundle.toFixed(2), bundlePct, discount: +discount.toFixed(2), shipping, total: +(after + shipping).toFixed(2), method: ship.id, saved: +(full - after).toFixed(2), units };
    const id = CAT.orderPrefix + "-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(1).toString("hex").toUpperCase();
    const order = { id, createdAt: now(), status: "awaiting_payment", brand: CAT.brand, email: o.email.trim().toLowerCase(), name: clean(o.name, 80), phone: clean(o.phone, 30),
      address: { a1: clean(a.a1, 120), a2: clean(a.a2, 120), city: clean(a.city, 60), state: a.state, zip: a.zip, country: "US" }, shipping: { method: ship.id, price: shipping }, items, promo: code ? code.code : null, totals, marketing: !!o.marketing, notes: clean(o.notes, 300) };
    try {
      tx(() => {
        for (const it of items) { const r = db.prepare("SELECT stock FROM products WHERE sku=?").get(it.sku); if (r.stock < it.qty) throw Object.assign(new Error("stock"), { sku: it.sku, left: r.stock }); }
        for (const it of items) adjustStock(it.sku, -it.qty);
        db.prepare("INSERT INTO orders(id,created_at,status,email,total,data) VALUES(?,?,?,?,?,?)").run(id, order.createdAt, order.status, order.email, totals.total, JSON.stringify(order));
      });
    } catch (e) { if (e.message === "stock") return send(res, 409, { error: "stock", sku: e.sku, left: e.left }); throw e; }
    if (order.marketing) upsertSub(order.email, "checkout", null, order.name);
    let payUrl = null; try { payUrl = await createPayment(order); } catch (e) { console.error("payment", e); }
    return send(res, 201, { order, payUrl });
  }
  let om;
  if (m === "GET" && (om = p.match(/^\/orders\/([\w-]+)$/))) {
    if (limited(req, 30)) return send(res, 429, { error: "Too many requests" });
    const row = db.prepare("SELECT data FROM orders WHERE id=?").get(om[1].toUpperCase());
    const o = row && JSON.parse(row.data);
    if (!o || o.email !== String(url.searchParams.get("email") || "").trim().toLowerCase()) return send(res, 404, { error: "Not found" });
    return send(res, 200, { order: { id: o.id, createdAt: o.createdAt, status: o.status, items: o.items, totals: o.totals, email: o.email } });
  }
  if (m === "POST" && p === "/subscribers") {
    if (limited(req)) return send(res, 429, { error: "Too many requests" });
    const b = await body(req); if (!emailOk(b.email)) return send(res, 400, { error: "Invalid email" });
    upsertSub(b.email, clean(b.source, 20) || "newsletter", b.sku ? clean(b.sku, 20) : null, clean(b.name, 80));
    return send(res, 201, { ok: true });
  }
  if (m === "POST" && p === "/reviews") {
    if (limited(req, 5)) return send(res, 429, { error: "Too many requests" });
    const b = await body(req, 6e5); const rating = Math.round(+b.rating);
    if (!(rating >= 1 && rating <= 5) || !clean(b.name, 40) || !clean(b.title, 80) || !clean(b.body, 1200) || !emailOk(b.email)) return send(res, 400, { error: "Invalid review" });
    const bought = db.prepare("SELECT 1 FROM orders WHERE email=? AND status IN ('paid','shipped','delivered') LIMIT 1").get(String(b.email).toLowerCase());
    let photo = ""; const ph = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(b.photo || ""));
    if (ph && ph[2].length < 5.5e5) { fs.mkdirSync(path.join(UPLOAD_DIR, "reviews"), { recursive: true }); const name = crypto.randomUUID() + "." + ph[1].replace("jpeg", "jpg"); fs.writeFileSync(path.join(UPLOAD_DIR, "reviews", name), Buffer.from(ph[2], "base64")); photo = "uploads/reviews/" + name; }
    db.prepare("INSERT INTO reviews(id,created_at,status,rating,name,email,flavor,title,body,verified,photo) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), now(), "pending", rating, clean(b.name, 40), String(b.email).toLowerCase(), clean(b.flavor, 10), clean(b.title, 80), clean(b.body, 1200), bought ? 1 : 0, photo);
    return send(res, 201, { ok: true });
  }
  let hm;
  if (m === "POST" && (hm = p.match(/^\/reviews\/([\w-]+)\/helpful$/))) {
    if (limited(req, 30)) return send(res, 429, { error: "Too many requests" });
    db.prepare("UPDATE reviews SET helpful=helpful+1 WHERE id=? AND status='approved'").run(hm[1]); return send(res, 200, { ok: true });
  }
  if (m === "POST" && p === "/payments/webhook") {
    // Verify the provider's signature here before trusting the payload, then call markPaid(orderId).
    return send(res, 501, { error: "Connect your payment provider in server.js" });
  }

  /* ---- admin ---- */
  if (p.startsWith("/admin/")) {
    if (!isAdmin(req)) return send(res, 401, { error: "Unauthorized" });
    if (m === "GET" && p === "/admin/ping") return send(res, 200, { ok: true });
    if (m === "GET" && p === "/admin/orders") return send(res, 200, { orders: db.prepare("SELECT data FROM orders ORDER BY created_at DESC LIMIT 500").all().map((r) => JSON.parse(r.data)) });
    if (m === "GET" && p === "/admin/subscribers") return send(res, 200, { subscribers: db.prepare("SELECT * FROM subscribers ORDER BY created_at DESC").all().map((s) => ({ email: s.email, name: s.name, sources: JSON.parse(s.sources || "[]"), restock: JSON.parse(s.restock || "[]"), createdAt: s.created_at })) });
    if (m === "GET" && p === "/admin/reviews") return send(res, 200, { reviews: db.prepare("SELECT id,created_at createdAt,status,rating,name,email,flavor,title,body,verified,helpful,photo FROM reviews ORDER BY created_at DESC").all().map((r) => ({ ...r, verified: !!r.verified })) });
    if (m === "POST" && p === "/admin/init") { seed(true); return send(res, 200, { ok: true }); }
    let mm;
    if (m === "PATCH" && (mm = p.match(/^\/admin\/products\/([\w-]+)$/))) {
      const b = await body(req), cur = db.prepare("SELECT * FROM products WHERE sku=?").get(mm[1]); if (!cur) return send(res, 404, { error: "Not found" });
      const n = (v, d) => (v === undefined ? d : v);
      db.prepare("UPDATE products SET price=?, stock=?, low_stock_at=?, active=?, photo_url=?, updated_at=? WHERE sku=?").run(
        Math.max(0, +n(b.price, cur.price)), Math.max(0, Math.floor(+n(b.stock, cur.stock))), Math.max(0, Math.floor(+n(b.lowStockAt, cur.low_stock_at))), n(b.active, !!cur.active) ? 1 : 0, clean(n(b.photoUrl, cur.photo_url), 500), now(), mm[1]);
      return send(res, 200, { ok: true });
    }
    if (m === "PATCH" && (mm = p.match(/^\/admin\/orders\/([\w-]+)$/))) {
      const b = await body(req), row = db.prepare("SELECT data FROM orders WHERE id=?").get(mm[1]); if (!row) return send(res, 404, { error: "Not found" });
      const o = JSON.parse(row.data), st = String(b.status);
      if (!["awaiting_payment", "paid", "shipped", "delivered", "cancelled"].includes(st)) return send(res, 400, { error: "Bad status" });
      if (o.status === "cancelled") return send(res, 409, { error: "Order is cancelled" });
      tx(() => { if (st === "cancelled") o.items.forEach((it) => adjustStock(it.sku, it.qty)); o.status = st; o.statusAt = now(); db.prepare("UPDATE orders SET status=?, data=? WHERE id=?").run(st, JSON.stringify(o), o.id); });
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/admin\/reviews\/([\w-]+)$/))) {
      if (m === "DELETE") { db.prepare("DELETE FROM reviews WHERE id=?").run(mm[1]); return send(res, 200, { ok: true }); }
      if (m === "PATCH") { const b = await body(req);
        if (b.status) db.prepare("UPDATE reviews SET status=? WHERE id=?").run(["approved", "hidden", "pending"].includes(b.status) ? b.status : "pending", mm[1]);
        if (b.verified !== undefined) db.prepare("UPDATE reviews SET verified=? WHERE id=?").run(b.verified ? 1 : 0, mm[1]);
        return send(res, 200, { ok: true }); }
    }
    if (m === "POST" && p === "/admin/upload") {
      const b = await body(req, 12e6), mt = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(String(b.data || ""));
      if (!mt) return send(res, 400, { error: "Upload a PNG, JPG or WebP image" });
      const name = crypto.randomUUID() + "." + mt[1].replace("jpeg", "jpg"); fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(mt[2], "base64"));
      return send(res, 201, { url: "uploads/" + name });
    }
  }
  return send(res, 404, { error: "Not found" });
}
function upsertSub(email, source, sku, name) {
  email = String(email).trim().toLowerCase(); const prev = db.prepare("SELECT * FROM subscribers WHERE email=?").get(email);
  const sources = Array.from(new Set([...(prev ? JSON.parse(prev.sources) : []), source])), restock = Array.from(new Set([...(prev ? JSON.parse(prev.restock) : []), ...(sku ? [sku] : [])]));
  db.prepare("INSERT OR REPLACE INTO subscribers(email,name,sources,restock,consent,created_at,updated_at) VALUES(?,?,?,?,1,?,?)").run(email, name || prev?.name || "", JSON.stringify(sources), JSON.stringify(restock), prev?.created_at || now(), now());
}

/* ---------------- static files ---------------- */
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname); if (rel === "/" || rel === "/admin") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, "public", rel));
  if (!file.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=604800", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try { if (url.pathname.startsWith("/api/")) await api(req, res, url); else serveStatic(req, res, url); }
  catch (e) { console.error(e); send(res, e.status || 500, { error: e.status ? e.message : "Server error" }); }
}).listen(PORT, () => console.log(`${CAT.brand} store running on http://localhost:${PORT}  (admin: /#admin)`));
