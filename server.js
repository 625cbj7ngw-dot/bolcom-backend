const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const CONFIG = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'cktech-secret-2026',
};

// ── In-memory database (later PostgreSQL) ─────────────────────────────────────
const DB_FILE = '/tmp/cktech_db.json';
let db = { users: [], sessions: {} };

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      console.log('[DB] Geladen:', db.users.length, 'gebruikers');
    }
  } catch(e) { console.log('[DB] Nieuw database aangemaakt'); }
}

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch(e) {}
}

// ── Auth middleware ────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const user = db.users.find(u => u.id === decoded.userId);
    if (!user) return res.status(401).json({ error: 'Gebruiker niet gevonden' });
    req.user = user;
    next();
  } catch(e) { res.status(401).json({ error: 'Sessie verlopen, log opnieuw in' }); }
}

// ── Bol.com token per gebruiker ───────────────────────────────────────────────
const tokenCache = {};

async function getBolToken(user) {
  const cache = tokenCache[user.id];
  if (cache && cache.expiry > Date.now()) return cache.token;
  
  const credentials = Buffer.from(`${user.bolClientId}:${user.bolClientSecret}`).toString('base64');
  const res = await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  tokenCache[user.id] = {
    token: res.data.access_token,
    expiry: Date.now() + (res.data.expires_in - 60) * 1000
  };
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

// ── Poll orders per gebruiker ─────────────────────────────────────────────────
async function syncOrdersForUser(user) {
  try {
    const orders = await fetchOrders(user, 'OPEN');
    if (!user.knownOrderIds) user.knownOrderIds = [];
    if (!user.ordersCache) user.ordersCache = {};
    if (!user.firstRun) {
      orders.forEach(o => {
        if (!user.knownOrderIds.includes(o.orderId)) user.knownOrderIds.push(o.orderId);
        user.ordersCache[o.orderId] = o;
      });
      user.firstRun = true;
      saveDB();
      return;
    }
    for (const order of orders) {
      if (!user.knownOrderIds.includes(order.orderId)) {
        user.knownOrderIds.push(order.orderId);
        let detail = null;
        try { detail = await fetchOrderDetail(user, order.orderId); } catch(e) {}
        if (detail) {
          user.ordersCache[order.orderId] = detail;
          saveDB();
          const product = detail.orderItems?.[0]?.product?.title || 'product';
          const total = detail.orderItems?.reduce((s, i) => s + (i.unitPrice * i.quantity || 0), 0) || 0;
          await sendPush(user.pushTokens || [], '🛍️ Nieuwe bestelling!', product + ' — €' + total.toFixed(2), { orderId: order.orderId });

          // Auto decrease inventory
          if (detail.orderItems) {
            detail.orderItems.forEach(item => {
              const ean = item.product?.ean;
              if (!ean || !user.inventory) return;
              const idx = user.inventory.findIndex(i => i.ean === ean);
              if (idx !== -1) {
                user.inventory[idx].stock = Math.max(0, user.inventory[idx].stock - (item.quantity || 1));
                if (user.inventory[idx].stock <= 3) {
                  sendPush(user.pushTokens || [], '⚠️ Lage voorraad!', user.inventory[idx].name + ' nog maar ' + user.inventory[idx].stock + ' stuks!', {});
                }
              }
            });
            saveDB();
          }
        }
      }
    }
  } catch(e) { console.error('[Sync] Fout voor', user.email, ':', e.message); }
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// Registreren
app.post('/auth/register', async (req, res) => {
  const { email, password, name, storeName } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, wachtwoord en naam zijn verplicht' });
  if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email al in gebruik' });
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(),
    email,
    password: hashedPassword,
    name,
    storeName: storeName || name,
    bolClientId: null,
    bolClientSecret: null,
    pushTokens: [],
    inventory: [],
    ordersCache: {},
    knownOrderIds: [],
    firstRun: false,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  saveDB();
  
  const token = jwt.sign({ userId: user.id }, CONFIG.JWT_SECRET, { expiresIn: '30d' });
  console.log('[Auth] Nieuwe gebruiker:', email);
  res.json({ token, user: { id: user.id, email, name, storeName: user.storeName, hasBolCredentials: false } });
});

// Inloggen
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'Email of wachtwoord onjuist' });
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Email of wachtwoord onjuist' });
  
  const token = jwt.sign({ userId: user.id }, CONFIG.JWT_SECRET, { expiresIn: '30d' });
  console.log('[Auth] Ingelogd:', email);
  res.json({ token, user: { id: user.id, email, name: user.name, storeName: user.storeName, hasBolCredentials: !!(user.bolClientId && user.bolClientSecret) } });
});

// Profiel
app.get('/auth/me', authMiddleware, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, email: u.email, name: u.name, storeName: u.storeName, hasBolCredentials: !!(u.bolClientId && u.bolClientSecret) });
});

// Bol.com credentials koppelen
app.post('/auth/bol-credentials', authMiddleware, async (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Client ID en Secret zijn verplicht' });
  
  // Test credentials
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, {
      headers: { Authorization: `Basic ${credentials}` }
    });
  } catch(e) { return res.status(400).json({ error: 'Ongeldige bol.com credentials' }); }
  
  req.user.bolClientId = clientId;
  req.user.bolClientSecret = clientSecret;
  req.user.firstRun = false;
  saveDB();
  console.log('[Auth] Bol credentials gekoppeld voor:', req.user.email);
  res.json({ success: true });
});

// ── USER ROUTES ───────────────────────────────────────────────────────────────

// Push token registreren
app.post('/register-token', authMiddleware, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token vereist' });
  if (!req.user.pushTokens) req.user.pushTokens = [];
  if (!req.user.pushTokens.includes(token)) req.user.pushTokens.push(token);
  saveDB();
  res.json({ success: true });
});

// Bestellingen
app.get('/orders', authMiddleware, (req, res) => {
  if (!req.user.bolClientId) return res.status(400).json({ error: 'Geen bol.com credentials gekoppeld' });
  const orders = Object.values(req.user.ordersCache || {}).sort((a, b) => new Date(b.orderPlacedDateTime) - new Date(a.orderPlacedDateTime));
  res.json({ orders });
});

// Voorraad
app.get('/inventory-items', authMiddleware, (req, res) => {
  res.json({ items: req.user.inventory || [] });
});

app.post('/inventory-items', authMiddleware, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items moet een array zijn' });
  req.user.inventory = items;
  saveDB();
  res.json({ success: true });
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: db.users.length, version: '2.0.0' });
});

// ── POLLING ───────────────────────────────────────────────────────────────────
async function syncAllUsers() {
  const usersWithBol = db.users.filter(u => u.bolClientId && u.bolClientSecret);
  console.log('[Poll] Checken voor', usersWithBol.length, 'gebruikers...');
  for (const user of usersWithBol) {
    await syncOrdersForUser(user);
  }
}

loadDB();
app.listen(CONFIG.PORT, () => console.log('🚀 CKTech Server v2.0 draait op poort', CONFIG.PORT));
cron.schedule('*/5 * * * *', syncAllUsers);
setTimeout(syncAllUsers, 3000);
