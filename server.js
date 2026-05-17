const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const CONFIG = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'cktech-secret-2026',
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      store_name TEXT,
      bol_client_id TEXT,
      bol_client_secret TEXT,
      push_tokens JSONB DEFAULT '[]',
      inventory JSONB DEFAULT '[]',
      orders_cache JSONB DEFAULT '{}',
      known_order_ids JSONB DEFAULT '[]',
      first_run BOOLEAN DEFAULT false,
      low_stock_threshold INTEGER DEFAULT 3,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expiry BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] Database klaar!');
}

async function getUser(id) {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getUserByEmail(email) {
  const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return res.rows[0] || null;
}

async function saveUser(user) {
  await pool.query(`
    INSERT INTO users (id, email, password, name, store_name, bol_client_id, bol_client_secret, push_tokens, inventory, orders_cache, known_order_ids, first_run)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (id) DO UPDATE SET
      email = $2, password = $3, name = $4, store_name = $5,
      bol_client_id = $6, bol_client_secret = $7, push_tokens = $8,
      inventory = $9, orders_cache = $10, known_order_ids = $11, first_run = $12
  `, [
    user.id, user.email, user.password, user.name, user.store_name,
    user.bol_client_id, user.bol_client_secret,
    JSON.stringify(user.push_tokens || []),
    JSON.stringify(user.inventory || []),
    JSON.stringify(user.orders_cache || {}),
    JSON.stringify(user.known_order_ids || []),
    user.first_run || false
  ]);
}

const tokenCache = {};

async function getBolToken(user) {
  const cache = tokenCache[user.id];
  if (cache && cache.expiry > Date.now()) return cache.token;
  const credentials = Buffer.from(`${user.bol_client_id}:${user.bol_client_secret}`).toString('base64');
  const res = await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  tokenCache[user.id] = { token: res.data.access_token, expiry: Date.now() + (res.data.expires_in - 60) * 1000 };
  return tokenCache[user.id].token;
}

async function fetchOrders(user, status) {
  const token = await getBolToken(user);
  let allOrders = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const res = await axios.get('https://api.bol.com/retailer/orders', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.retailer.v10+json' },
        params: { status, page }
      });
      const orders = res.data.orders || [];
      if (orders.length === 0) break;
      allOrders = [...allOrders, ...orders];
    } catch(e) { break; }
  }
  return allOrders;
}

async function fetchOrderDetail(user, orderId) {
  const token = await getBolToken(user);
  const res = await axios.get(`https://api.bol.com/retailer/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.retailer.v10+json' }
  });
  return res.data;
}

async function sendPush(pushTokens, title, body, data) {
  if (!pushTokens || pushTokens.length === 0) return;
  await axios.post('https://exp.host/--/api/v2/push/send',
    pushTokens.map(t => ({ to: t, sound: 'default', title, body, data, badge: 1 }))
  );
}

async function syncOrdersForUser(user) {
  console.log("[Sync] Start voor:", user.email);
  if (!user.bol_client_id || !user.bol_client_secret) { console.log("[Sync] Geen credentials"); return; }
  console.log("[Sync] Credentials gevonden, ophalen token...");
  try { await getBolToken(user); console.log("[Sync] Token OK!"); } catch(e) { console.error("[Sync] Token fout:", e.response?.data || e.message); return; }
  try {
    console.log("[Sync] Bestellingen ophalen...");
    const orders = await fetchOrders(user, "OPEN");
    console.log("[Sync] Bestellingen opgehaald:", orders.length);
    const knownIds = user.known_order_ids || [];
    const ordersCache = user.orders_cache || {};

    if (!user.first_run) {
      orders.forEach(o => { if (!knownIds.includes(o.orderId)) knownIds.push(o.orderId); });
      user.known_order_ids = knownIds;
      user.first_run = true;
      await saveUser(user);
      return;
    }

    let changed = false;
    for (const order of orders) {
      if (!knownIds.includes(order.orderId)) {
        knownIds.push(order.orderId);
        let detail = null;
        try { detail = await fetchOrderDetail(user, order.orderId); } catch(e) {}
        if (detail) {
          ordersCache[order.orderId] = detail;
          changed = true;
          const product = detail.orderItems?.[0]?.product?.title || 'product';
          const total = detail.orderItems?.reduce((s, i) => s + (i.unitPrice * i.quantity || 0), 0) || 0;
          await sendPush(user.push_tokens || [], 'Nieuwe bestelling! #' + order.orderId, product + ' — €' + total.toFixed(2), { orderId: order.orderId });

          if (detail.orderItems) {
            const inventory = user.inventory || [];
            detail.orderItems.forEach(item => {
              const ean = item.product?.ean;
              if (!ean) return;
              const idx = inventory.findIndex(i => i.ean === ean);
              if (idx !== -1) {
                inventory[idx].stock = Math.max(0, inventory[idx].stock - (item.quantity || 1));
                if (inventory[idx].stock <= 3) {
                  sendPush(user.push_tokens || [], 'Lage voorraad!', inventory[idx].name + ' nog maar ' + inventory[idx].stock + ' stuks!', {});
                }
              }
            });
            user.inventory = inventory;
          }
        }
      }
    }

    if (changed) {
      user.known_order_ids = knownIds;
      user.orders_cache = ordersCache;
      await saveUser(user);
    }
  } catch(e) { console.error('[Sync] Fout voor', user.email, ':', e.message); }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]).then(result => {
      if (!result.rows[0]) return res.status(401).json({ error: 'Gebruiker niet gevonden' });
      req.user = result.rows[0];
      req.user.push_tokens = req.user.push_tokens || [];
      req.user.inventory = req.user.inventory || [];
      req.user.orders_cache = req.user.orders_cache || {};
      req.user.known_order_ids = req.user.known_order_ids || [];
      next();
    });
  } catch(e) { res.status(401).json({ error: 'Sessie verlopen' }); }
}

app.post('/auth/register', async (req, res) => {
  const { email, password, name, storeName } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, wachtwoord en naam zijn verplicht' });
  if (await getUserByEmail(email)) return res.status(400).json({ error: 'Email al in gebruik' });
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = { id: Date.now().toString(), email, password: hashedPassword, name, store_name: storeName || name, bol_client_id: null, bol_client_secret: null, push_tokens: [], inventory: [], orders_cache: {}, known_order_ids: [], first_run: false };
  await saveUser(user);
  const token = jwt.sign({ userId: user.id }, CONFIG.JWT_SECRET, { expiresIn: '30d' });
  console.log('[Auth] Nieuwe gebruiker:', email);
  res.json({ token, user: { id: user.id, email, name, storeName: user.store_name, hasBolCredentials: false } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getUserByEmail(email);
  if (!user) return res.status(400).json({ error: 'Email of wachtwoord onjuist' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Email of wachtwoord onjuist' });
  const token = jwt.sign({ userId: user.id }, CONFIG.JWT_SECRET, { expiresIn: '30d' });
  console.log('[Auth] Ingelogd:', email);
  res.json({ token, user: { id: user.id, email, name: user.name, storeName: user.store_name, hasBolCredentials: !!(user.bol_client_id && user.bol_client_secret) } });
});

app.get('/auth/me', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, email: u.email, name: u.name, storeName: u.store_name, hasBolCredentials: !!(u.bol_client_id && u.bol_client_secret), bolClientId: u.bol_client_id || "", bolClientSecret: u.bol_client_secret || "" });
});

app.post('/auth/bol-credentials', authMiddleware, async (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Client ID en Secret zijn verplicht' });
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, { headers: { Authorization: `Basic ${credentials}` } });
  } catch(e) { console.log("[Creds] Verificatie overgeslagen:", e.message); }
  req.user.bol_client_id = clientId;
  req.user.bol_client_secret = clientSecret;
  req.user.first_run = false;
  await saveUser(req.user);
  res.json({ success: true });
});

app.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await getUserByEmail(email);
  if (!user) return res.json({ success: true });
  const resetToken = require('crypto').randomBytes(32).toString('hex');
  const code = resetToken.substring(0, 6).toUpperCase();
  await pool.query('INSERT INTO reset_tokens (token, user_id, expiry) VALUES ($1, $2, $3)', [resetToken, user.id, Date.now() + 3600000]);
  try {
    await resend.emails.send({
      from: 'CKTech <onboarding@resend.dev>',
      to: email,
      subject: 'Wachtwoord resetten - CKTech',
      html: `<div style="font-family:Arial;max-width:500px;margin:0 auto"><h1 style="color:#FF6B35">CKTech®</h1><h2>Wachtwoord resetten</h2><p>Hoi ${user.name},</p><p>Gebruik deze code in de app:</p><div style="background:#f5f5f5;padding:20px;border-radius:8px;text-align:center;margin:20px 0"><h1 style="color:#FF6B35;letter-spacing:8px;font-size:32px">${code}</h1></div><p>Deze code is 1 uur geldig.</p></div>`
    });
    console.log('[Auth] Reset email verstuurd naar:', email);
    res.json({ success: true });
  } catch(e) {
    console.error('[Auth] Email fout:', e.message);
    res.status(500).json({ error: 'Email versturen mislukt: ' + e.message });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  const { code, newPassword } = req.body;
  if (!code || !newPassword) return res.status(400).json({ error: 'Code en nieuw wachtwoord zijn verplicht' });
  const result = await pool.query('SELECT * FROM reset_tokens WHERE UPPER(SUBSTRING(token, 1, 6)) = $1', [code.toUpperCase()]);
  if (!result.rows[0]) return res.status(400).json({ error: 'Ongeldige code' });
  const resetData = result.rows[0];
  if (resetData.expiry < Date.now()) {
    await pool.query('DELETE FROM reset_tokens WHERE token = $1', [resetData.token]);
    return res.status(400).json({ error: 'Code verlopen, vraag een nieuwe aan' });
  }
  const user = await getUser(resetData.user_id);
  if (!user) return res.status(400).json({ error: 'Gebruiker niet gevonden' });
  user.password = await bcrypt.hash(newPassword, 10);
  await saveUser(user);
  await pool.query('DELETE FROM reset_tokens WHERE token = $1', [resetData.token]);
  console.log('[Auth] Wachtwoord gereset voor:', user.email);
  res.json({ success: true });
});

app.post('/register-token', authMiddleware, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token vereist' });
  const tokens = req.user.push_tokens || [];
  if (!tokens.includes(token)) tokens.push(token);
  req.user.push_tokens = tokens;
  await saveUser(req.user);
  res.json({ success: true });
});

app.get('/orders', authMiddleware, (req, res) => {
  if (!req.user.bol_client_id) return res.status(400).json({ error: 'Geen bol.com credentials gekoppeld' });
  const orders = Object.values(req.user.orders_cache || {}).sort((a, b) => new Date(b.orderPlacedDateTime) - new Date(a.orderPlacedDateTime));
  res.json({ orders });
});

app.get('/inventory-items', authMiddleware, (req, res) => {
  res.json({ items: req.user.inventory || [] });
});

app.post('/inventory-items', authMiddleware, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items moet een array zijn' });
  req.user.inventory = items;
  await saveUser(req.user);
  res.json({ success: true });
});

app.post('/settings/threshold', authMiddleware, async (req, res) => {
  const { threshold } = req.body;
  if (!threshold || threshold < 1) return res.status(400).json({ error: 'Ongeldige drempel' });
  await pool.query('UPDATE users SET low_stock_threshold = $1 WHERE id = $2', [threshold, req.user.id]);
  res.json({ success: true });
});

app.get('/settings/threshold', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT low_stock_threshold FROM users WHERE id = $1', [req.user.id]);
  res.json({ threshold: result.rows[0]?.low_stock_threshold || 3 });
});

app.post('/orders/:orderId/ship', authMiddleware, async (req, res) => {
  const { orderId } = req.params;
  const { orderItemId, trackingCode, transporterCode } = req.body;
  if (!req.user.bol_client_id) return res.status(400).json({ error: 'Geen bol.com credentials' });
  try {
    const token = await getBolToken(req.user);
    await axios.put(`https://api.bol.com/retailer/orders/${orderId}/shipment`, {
      orderItems: [{ orderItemId, quantity: 1 }],
      shipmentReference: trackingCode,
      transport: { trackingCode, transporterCode: transporterCode || 'TNT' }
    }, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.retailer.v10+json', 'Content-Type': 'application/vnd.retailer.v10+json' }
    });
    if (req.user.orders_cache && req.user.orders_cache[orderId]) {
      req.user.orders_cache[orderId].status = 'SHIPPED';
      await saveUser(req.user);
    }
    console.log('[Ship] Bestelling', orderId, 'als verzonden gemarkeerd');
    res.json({ success: true });
  } catch(e) {
    console.error('[Ship] Fout:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.detail || e.message });
  }
});

app.delete('/auth/account', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM reset_tokens WHERE user_id = $1', [req.user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    console.log('[Auth] Account verwijderd:', req.user.email);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', db: 'postgresql' });
});


async function sendDailySummary() {
  try {
    const result = await pool.query('SELECT * FROM users WHERE bol_client_id IS NOT NULL');
    const today = new Date();
    today.setHours(0,0,0,0);

    for (const user of result.rows) {
      const ordersCache = user.orders_cache || {};
      const todayOrders = Object.values(ordersCache).filter(o => {
        if (!o.orderPlacedDateTime) return false;
        return new Date(o.orderPlacedDateTime) >= today;
      });

      const revenue = todayOrders.reduce((sum, o) => sum + (o.orderItems?.reduce((s, i) => s + (i.unitPrice * i.quantity || 0), 0) || 0), 0);
      const commission = todayOrders.reduce((sum, o) => sum + (o.orderItems?.reduce((s, i) => s + (i.commission || 0), 0) || 0), 0);
      const count = todayOrders.length;

      if (count > 0) {
        const tokens = user.push_tokens || [];
        await sendPush(tokens,
          '📊 Dagelijks rapport - ' + today.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }),
          count + ' bestelling' + (count > 1 ? 'en' : '') + ' · €' + revenue.toFixed(2) + ' omzet · €' + commission.toFixed(2) + ' commissie',
          { type: 'daily_summary' }
        );
        console.log('[Daily] Rapport verstuurd naar:', user.email, '- €' + revenue.toFixed(2));
      }
    }
  } catch(e) { console.error('[Daily] Fout:', e.message); }
}


async function sendWeeklyReport() {
  try {
    const result = await pool.query('SELECT * FROM users WHERE bol_client_id IS NOT NULL');
    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    for (const user of result.rows) {
      const ordersCache = user.orders_cache || {};
      const weekOrders = Object.values(ordersCache).filter(o => {
        if (!o.orderPlacedDateTime) return false;
        return new Date(o.orderPlacedDateTime) >= weekAgo;
      });

      const revenue = weekOrders.reduce((sum, o) => sum + (o.orderItems?.reduce((s, i) => s + (i.unitPrice * i.quantity || 0), 0) || 0), 0);
      const commission = weekOrders.reduce((sum, o) => sum + (o.orderItems?.reduce((s, i) => s + (i.commission || 0), 0) || 0), 0);
      const count = weekOrders.length;
      const tokens = user.push_tokens || [];

      await sendPush(tokens,
        '📊 Weekrapport CKTech',
        count + ' bestelling' + (count > 1 ? 'en' : '') + ' · €' + revenue.toFixed(2) + ' omzet · €' + (revenue - commission).toFixed(2) + ' netto',
        { type: 'weekly_report' }
      );
      console.log('[Weekly] Rapport verstuurd naar:', user.email);
    }
  } catch(e) { console.error('[Weekly] Fout:', e.message); }
}

async function syncAllUsers() {
  try {
    const result = await pool.query('SELECT * FROM users WHERE bol_client_id IS NOT NULL');
    console.log("[Poll] Checken voor", result.rows.length, "gebruikers...");
    result.rows.forEach(u => console.log("[Poll] User:", u.email, "bolId:", u.bol_client_id ? "JA" : "NEE"));
    for (const user of result.rows) {
      user.push_tokens = user.push_tokens || [];
      user.inventory = user.inventory || [];
      user.orders_cache = user.orders_cache || {};
      user.known_order_ids = user.known_order_ids || [];
      await syncOrdersForUser(user);
    }
  } catch(e) { console.error('[Poll] Fout:', e.message); }
}

initDB().then(() => {
  app.listen(CONFIG.PORT, () => console.log('CKTech Server v3.0 draait op poort', CONFIG.PORT));
  cron.schedule('*/5 * * * *', syncAllUsers);
cron.schedule('0 20 * * *', sendDailySummary);
cron.schedule('0 9 * * 1', sendWeeklyReport); // Elke maandag om 09:00 // Elke dag om 20:00
  setTimeout(syncAllUsers, 3000);
});
// Force add column if not exists
pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER DEFAULT 3").catch(() => {});
