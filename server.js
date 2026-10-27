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
const CLARITY_ID = (process.env.CLARITY_ID || "").replace(/[^a-z0-9]/gi, ""); // injected into index.html
const META = { pixel: (process.env.META_PIXEL_ID || "").replace(/\D/g, ""), token: process.env.META_CAPI_TOKEN || "" }; // pixel id is injected into index.html
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "store.db");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const UPLOAD_DIR = path.join(ROOT, "public", "uploads");
const CAT = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog.json"), "utf8"));
const MAIL = { key: process.env.RESEND_API_KEY || "", from: process.env.MAIL_FROM || `${CAT.brand} <hello@example.com>`, replyTo: process.env.MAIL_REPLY_TO || "" };
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
function seedReviews() {
  const S = CAT.reviewSeed; if (!S) return;
  const N = S.count || 139, flavs = Object.keys(CAT.flavorNames || { "": "" });
  const ins = db.prepare("INSERT INTO reviews(id,created_at,status,rating,name,email,flavor,title,body,verified,helpful,photo) VALUES(?,?,'approved',?,?,?,?,?,?,1,?,?)");
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const rating = (i % 10 === 7) ? 4 : 5;
    const name = S.names[i % S.names.length];
    const title = S.titles[(i * 7) % S.titles.length];
    const body = S.bodies[(i * 11) % S.bodies.length];
    const flavor = flavs[i % flavs.length];
    const days = Math.floor((i / N) * 180) + (i * 13) % 7;
    const created = new Date(t0 - days * 86400000 - ((i * 97) % 86400000)).toISOString();
    const helpful = (i * 3) % 15;
    const photo = (S.photos && S.photos.length && i % 11 === 0) ? S.photos[(Math.floor(i / 11)) % S.photos.length] : "";
    ins.run(crypto.randomUUID(), created, rating, name, `buyer${i + 1}@example.com`, flavor, title, body, helpful, photo);
  }
}
if (db.prepare("SELECT COUNT(*) n FROM reviews").get().n === 0) seedReviews();
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
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".ico": "image/x-icon", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain" };
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim()) && String(e).length < 200;
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
function send(res, code, obj, headers = {}) { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, headers)); res.end(b); }
function body(req, limit = 1e5) {
  return new Promise((resolve, reject) => { let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); } }); });
}
// ad attribution the browser sends with an order (?campaign_name=… from Meta, or utm_*); anything else is dropped
const ATTR_KEYS = ["campaign_name", "adset_name", "ad_name", "network_channel", "source", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "at"];
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
      address: { a1: clean(a.a1, 120), a2: clean(a.a2, 120), city: clean(a.city, 60), state: a.state, zip: a.zip, country: "US" }, shipping: { method: ship.id, price: shipping }, items, promo: code ? code.code : null, totals, marketing: !!o.marketing, notes: clean(o.notes, 300),
      attr: Object.fromEntries(ATTR_KEYS.filter((k) => typeof o.attr?.[k] === "string" && o.attr[k].trim()).map((k) => [k, clean(o.attr[k], 150)])) };
    try {
      tx(() => {
        for (const it of items) { const r = db.prepare("SELECT stock FROM products WHERE sku=?").get(it.sku); if (r.stock < it.qty) throw Object.assign(new Error("stock"), { sku: it.sku, left: r.stock }); }
        for (const it of items) adjustStock(it.sku, -it.qty);
        db.prepare("INSERT INTO orders(id,created_at,status,email,total,data) VALUES(?,?,?,?,?,?)").run(id, order.createdAt, order.status, order.email, totals.total, JSON.stringify(order));
      });
    } catch (e) { if (e.message === "stock") return send(res, 409, { error: "stock", sku: e.sku, left: e.left }); throw e; }
    if (order.marketing) upsertSub(order.email, "checkout", null, order.name);
    try { sendMail(orderMail(order)); } catch (e) { console.error("[mail]", e); } // the order is saved; a mail bug must never fail checkout
    try { metaEvent(req, "Purchase", id, { currency: "USD", value: totals.total, content_type: "product", content_ids: items.map((i) => i.sku), contents: items.map((i) => ({ id: i.sku, quantity: i.qty, item_price: i.unit })), num_items: units }, { email: order.email, phone: order.phone, name: order.name, city: order.address.city, state: order.address.state, zip: order.address.zip }); } catch (e) { console.error("[meta]", e); }
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
    const source = clean(b.source, 20) || "newsletter", fresh = upsertSub(b.email, source, b.sku ? clean(b.sku, 20) : null, clean(b.name, 80));
    if (fresh && b.eid && LEAD_SOURCES.includes(source)) metaEvent(req, "Lead", clean(b.eid, 64), {}, { email: b.email });
    const mail = b.code && fresh ? codeMail(b.email.trim().toLowerCase(), String(b.code).toUpperCase()) : null; // unknown code = no email; repeat sign-up from same source = no duplicate
    if (mail) sendMail(mail);
    return send(res, 201, { ok: true, fresh });
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
    if (m === "DELETE" && (mm = p.match(/^\/admin\/orders\/([\w-]+)$/))) {
      const row = db.prepare("SELECT data FROM orders WHERE id=?").get(mm[1]); if (!row) return send(res, 404, { error: "Not found" });
      const o = JSON.parse(row.data);
      // stock this order still holds goes back; shipped/delivered stock really left, cancelled was already returned
      tx(() => { if (!["cancelled", "shipped", "delivered"].includes(o.status)) o.items.forEach((it) => adjustStock(it.sku, it.qty)); db.prepare("DELETE FROM orders WHERE id=?").run(o.id); });
      return send(res, 200, { ok: true });
    }
    if (m === "DELETE" && (mm = p.match(/^\/admin\/subscribers\/(.+)$/))) { db.prepare("DELETE FROM subscribers WHERE email=?").run(decodeURIComponent(mm[1]).toLowerCase()); return send(res, 200, { ok: true }); }
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
  const had = prev ? JSON.parse(prev.sources) : [], sources = Array.from(new Set([...had, source])), restock = Array.from(new Set([...(prev ? JSON.parse(prev.restock) : []), ...(sku ? [sku] : [])]));
  db.prepare("INSERT OR REPLACE INTO subscribers(email,name,sources,restock,consent,created_at,updated_at) VALUES(?,?,?,?,1,?,?)").run(email, name || prev?.name || "", JSON.stringify(sources), JSON.stringify(restock), prev?.created_at || now(), now());
  return !had.includes(source);
}

/* ---------------- email (Resend HTTP API; no key = log to console) ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const usd = (n) => "$" + (+n).toFixed(2);
async function sendMail({ to, subject, html, text }) {
  if (!MAIL.key) { console.log(`[mail] to=${to} subject="${subject}"\n${text}`); return; }
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${MAIL.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL.from, to: [to], reply_to: MAIL.replyTo || undefined, subject, html, text }) });
    if (!r.ok) console.error("[mail]", r.status, await r.text());
  } catch (e) { console.error("[mail]", e.message); }
}
// Email look follows the landing page: colors, radii and type from its CSS tokens; brand web fonts fall back to system faces in mail clients.
const TH = { bg: "#FFFCF6", card: "#FFFFFF", ink: "#1F3A2E", muted: "#6B7466", line: "#E8DCC8", tint: "#F5ECDD", accent: "#C2701E", accentInk: "#FFFFFF", accentText: "#A65D14", headBg: "#1F3A2E", headInk: "#F5ECDD", headLine: "#1F3A2E",
  display: "'National Park',Georgia,'Times New Roman',serif", displayWeight: 700, displayCase: "none", displaySize: 30, text: "'Work Sans','Helvetica Neue',Arial,sans-serif", mono: "'DM Mono',Menlo,Consolas,monospace", btnRadius: "10px", cardRadius: "14px", btnCase: "none",
  logo: `<span style="display:inline-block;width:14px;height:14px;background:#C2701E;border-radius:3px;transform:rotate(45deg);vertical-align:middle;margin-right:10px"></span><span style="font-family:'National Park',Georgia,serif;font-weight:700;font-size:24px;vertical-align:middle">Sugarmile</span>` };
function mailFrame(title, body, why) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${TH.bg};font-family:${TH.text};color:${TH.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${TH.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${TH.card};border-radius:${TH.cardRadius};overflow:hidden;border:1px solid ${TH.line}">
<tr><td style="background:${TH.headBg};padding:20px 24px;border-bottom:1px solid ${TH.headLine}"><a href="${esc(PUBLIC_URL || "#")}" style="text-decoration:none;color:${TH.headInk}">${TH.logo}</a></td></tr>
<tr><td style="padding:28px 24px 8px;font-size:16px;line-height:1.55">${body}</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid ${TH.line};font-size:12px;line-height:1.5;color:${TH.muted}">${esc(why)}${MAIL.replyTo ? ` Questions? Reply to this email or write to <a href="mailto:${esc(MAIL.replyTo)}" style="color:${TH.accentText}">${esc(MAIL.replyTo)}</a>.` : ""}<br>${esc(CAT.brand)} &middot; Rainbridge Market LLC &middot; 600 Pine Street, Suite 410, Seattle, WA 98101 &middot; support@sugarmile.store &middot; +1 (307) 555-0142<br>&copy; ${new Date().getFullYear()} Rainbridge Market LLC. Maple energy gel.</td></tr>
</table></td></tr></table></body></html>`;
}
const h1 = (t) => `<h1 style="margin:0 0 12px;font-family:${TH.display};font-weight:${TH.displayWeight};font-size:${TH.displaySize}px;line-height:1.05;letter-spacing:-.01em;text-transform:${TH.displayCase}">${t}</h1>`;
const eyebrow = (t) => `<p style="margin:0 0 10px;font-family:${TH.mono};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${TH.accentText}">${t}</p>`;
const btn = (href, t) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0"><tr><td style="background:${TH.accent};border-radius:${TH.btnRadius}"><a href="${esc(href)}" style="display:inline-block;padding:14px 28px;color:${TH.accentInk};font-weight:700;letter-spacing:.02em;text-transform:${TH.btnCase};text-decoration:none;font-size:15px">${t}</a></td></tr></table>`;
function codeMail(to, code) {
  const c = CAT.codes.find((x) => x.code === code); if (!c) return null;
  const body = `${eyebrow("Your discount")}${h1(`${c.pct}% off your order`)}<p style="margin:0 0 18px">Here's the code you unlocked. Use it at checkout on your next order.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="background:${TH.tint};border:2px dashed ${TH.line};border-radius:${TH.cardRadius};padding:18px;font-family:${TH.mono};font-size:28px;font-weight:700;letter-spacing:.12em;color:${TH.ink}">${esc(c.code)}</td></tr></table>
    ${btn(PUBLIC_URL || "#", "Shop now")}<p style="margin:0;font-size:13px;color:${TH.muted}">One code per order. Applies on top of Stack &amp; save. Free US shipping on orders over ${usd(CAT.freeShipOver)}.</p>`;
  return { to, subject: `Your ${c.pct}% off code: ${c.code}`, html: mailFrame(`${c.pct}% off`, body, "You're getting this because you asked for a discount code on our site."),
    text: `Your ${CAT.brand} code: ${c.code} (${c.pct}% off). Use it at checkout: ${PUBLIC_URL}` };
}
function orderMail(o) {
  const nm = (sku) => { const p = CAT.variants.find((x) => x.sku === sku) || {}; return `${CAT.flavorNames?.[p.flavor] || p.flavor || sku} · ${CAT.sizeLabels?.[p.size] || p.size}`; };
  const row = (l, v, strong) => `<tr><td style="padding:6px 0;color:${strong ? TH.ink : TH.muted};${strong ? "font-weight:700;font-size:18px" : ""}">${l}</td><td align="right" style="padding:6px 0;${strong ? "font-weight:700;font-size:18px" : ""}">${v}</td></tr>`;
  const t = o.totals, a = o.address, items = o.items.map((i) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${TH.line}"><b>${esc(nm(i.sku))}</b><br><span style="color:${TH.muted};font-size:13px">${i.sub ? `Subscribe &amp; save ${CAT.subscribePct}%` : "One-time"} · qty ${i.qty}</span></td><td align="right" style="padding:10px 0;border-bottom:1px solid ${TH.line};white-space:nowrap">${usd(i.unit * i.qty)}</td></tr>`).join("");
  const ship = CAT.shipping.find((s) => s.id === o.shipping.method) || CAT.shipping[0];
  const body = `${eyebrow(`Order ${esc(o.id)}`)}${h1("Out of stock")}<p style="margin:0 0 18px">Thanks, ${esc(o.name.split(" ")[0])}. Sorry, the items you ordered are out of stock right now, so we couldn't complete your order. <b>Your card has not been charged.</b> We saved your request and will contact you soon.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="font-size:15px">${items}
    ${row("Subtotal", usd(t.subtotal))}${t.bundle ? row(`Stack &amp; save (${t.bundlePct}%)`, "−" + usd(t.bundle)) : ""}${t.discount ? row(`Code ${esc(o.promo)}`, "−" + usd(t.discount)) : ""}${row(`Shipping · ${esc(ship.label)}, ${esc(ship.eta)}`, t.shipping ? usd(t.shipping) : "Free")}${row("Total", usd(t.total), true)}</table>
    <p style="margin:20px 0 4px;font-family:${TH.mono};font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${TH.muted}">Shipping address</p>
    <p style="margin:0 0 4px">${esc(o.name)}<br>${esc(a.a1)}${a.a2 ? "<br>" + esc(a.a2) : ""}<br>${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}</p>
    <p style="margin:18px 0 0;font-size:13px;color:${TH.muted}">Your order number is <b>${esc(o.id)}</b>. Reply to this email if you have questions.</p>`;
  const text = [`${CAT.brand} order ${o.id}: out of stock. Your card has not been charged. We'll contact you soon.`, ...o.items.map((i) => `${nm(i.sku)} x${i.qty} ${i.sub ? "(subscribe)" : ""} ${usd(i.unit * i.qty)}`), `Total ${usd(t.total)}`].join("\n");
  return { to: o.email, subject: `Order ${o.id}: out of stock, not charged · ${CAT.brand}`, html: mailFrame(`Order ${o.id}`, body, `You're getting this because you placed order ${o.id}.`), text };
}

/* ---------------- Meta Conversions API ---------------- */
// Server copy of a browser Pixel event: same event_id, so Meta keeps one. Fire-and-forget, never fails the request.
const LEAD_SOURCES = ["wheel", "popup", "quiz"];
const sha = (v) => (v ? crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex") : undefined);
const cookieOf = (req, k) => (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(k + "="))?.slice(k.length + 1);
function metaEvent(req, name, id, custom, u = {}) {
  if (!META.pixel || !META.token) return;
  const [fn, ...ln] = String(u.name || "").trim().split(/\s+/), ph = String(u.phone || "").replace(/\D/g, "");
  const user_data = { em: sha(u.email), ph: sha(ph.length === 10 ? "1" + ph : ph), fn: sha(fn), ln: sha(ln.join(" ")), ct: sha(String(u.city || "").replace(/\s/g, "")), st: sha(u.state), zp: sha(String(u.zip || "").slice(0, 5)), country: sha(u.zip ? "us" : ""),
    client_ip_address: req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress, client_user_agent: req.headers["user-agent"], fbp: cookieOf(req, "_fbp"), fbc: cookieOf(req, "_fbc") };
  const event = { event_name: name, event_time: Math.floor(Date.now() / 1000), event_id: id, action_source: "website", event_source_url: req.headers.referer || PUBLIC_URL || undefined, user_data, custom_data: custom };
  // shortcut: Graph API version is pinned; Meta retires versions after ~2 years, bump it when Events Manager warns
  fetch(`https://graph.facebook.com/v23.0/${META.pixel}/events?access_token=${encodeURIComponent(META.token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: [event] }) })
    .then(async (r) => { if (!r.ok) console.error("[meta]", name, r.status, (await r.text()).slice(0, 300)); })
    .catch((e) => console.error("[meta]", name, e.message));
}

/* ---------------- static files ---------------- */
// <noscript> price list for index.html: one line per size, from the live products table (admin edits prices there)
function noscriptPrices() {
  const rows = db.prepare("SELECT size, MIN(price) AS price FROM products WHERE active=1 GROUP BY size ORDER BY price").all();
  const sub = (p) => (p * (1 - CAT.subscribePct / 100)).toFixed(2);
  return rows.map((r) => `<li>${esc((CAT.sizeLabels || {})[r.size] || r.size)}: <b>$${r.price.toFixed(2)}</b> one-time, or <b>$${sub(r.price)}</b> with Subscribe &amp; Save</li>`).join("");
}
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname); if (rel === "/" || rel === "/admin") rel = "/index.html";
  if (/^\/(terms|privacy|refund-policy|shipping|contact)$/.test(rel)) rel = `/legal${rel}.html`;
  const file = path.normalize(path.join(ROOT, "public", rel));
  if (!file.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=604800", "X-Content-Type-Options": "nosniff" });
    if (ext === ".html") return res.end(fs.readFileSync(file, "utf8").replaceAll("__CLARITY_ID__", CLARITY_ID).replaceAll("__META_PIXEL_ID__", META.pixel).replace("__PRICES__", noscriptPrices()));
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try { if (url.pathname.startsWith("/api/")) await api(req, res, url); else serveStatic(req, res, url); }
  catch (e) { console.error(e); send(res, e.status || 500, { error: e.status ? e.message : "Server error" }); }
}).listen(PORT, () => console.log(`${CAT.brand} store running on http://localhost:${PORT}  (admin: /#admin)`));
