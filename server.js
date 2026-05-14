const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const app = express();
app.use(express.json());
const CONFIG = { BOL_CLIENT_ID: process.env.BOL_CLIENT_ID, BOL_CLIENT_SECRET: process.env.BOL_CLIENT_SECRET, PORT: process.env.PORT || 3000 };
const CACHE_FILE = '/tmp/orders_cache.json';
let accessToken = null, tokenExpiry = null, pushTokens = new Set(), isFirstRun = true;
let ordersCache = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      ordersCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log('[Cache] Geladen:', Object.keys(ordersCache).length, 'bestellingen');
    }
  } catch(e) { console.log('[Cache] Fout bij laden:', e.message); }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(ordersCache));
  } catch(e) { console.log('[Cache] Fout bij opslaan:', e.message); }
}

async function getBolToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
  const credentials = Buffer.from(`${CONFIG.BOL_CLIENT_ID}:${CONFIG.BOL_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, { headers: { Authorization: `Basic ${credentials}` } });
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return accessToken;
}

async function fetchOrdersByStatus(status) {
  const token = await getBolToken();
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

async function fetchOrderDetail(orderId) {
  const token = await getBolToken();
  const res = await axios.get(`https://api.bol.com/retailer/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.retailer.v10+json' } });
  return res.data;
}

async function sendPush(title, body, data) {
  if (!pushTokens.size) return;
  await axios.post('https://exp.host/--/api/v2/push/send', [...pushTokens].map(t => ({ to: t, sound: 'default', title, body, data, badge: 1 })));
}

async function syncOrders() {
  try {
    const orders = await fetchOrdersByStatus('OPEN');
    if (isFirstRun) {
      for (const order of orders) {
        if (!ordersCache[order.orderId]) {
          try {
            const detail = await fetchOrderDetail(order.orderId);
            ordersCache[order.orderId] = detail;
          } catch(e) {}
        }
      }
      saveCache();
      isFirstRun = false;
      console.log('[Sync] Eerste run klaar, cache:', Object.keys(ordersCache).length);
      return;
    }
    for (const order of orders) {
      if (!ordersCache[order.orderId]) {
        let detail = null;
        try { detail = await fetchOrderDetail(order.orderId); } catch(e) {}
        if (detail) {
          ordersCache[order.orderId] = detail;
          saveCache();
          const product = detail.orderItems?.[0]?.product?.title || 'product';
          const total = detail.orderItems?.reduce((s, i) => s + (i.unitPrice * i.quantity || 0), 0) || 0;
          await sendPush('🛍️ Nieuwe bestelling! #' + order.orderId, product + ' — €' + total.toFixed(2), { orderId: order.orderId });
        }
      } else {
        try {
          const detail = await fetchOrderDetail(order.orderId);
          ordersCache[order.orderId] = detail;
        } catch(e) {}
      }
    }
    saveCache();
    console.log('[Sync] Cache bijgewerkt:', Object.keys(ordersCache).length, 'bestellingen');
  } catch(e) { console.error('[Sync] Fout:', e.message); if (e.response?.status === 401) accessToken = null; }
}

app.post('/register-token', (req, res) => { pushTokens.add(req.body.token); res.json({ success: true }); });

app.get('/orders', (req, res) => {
  const orders = Object.values(ordersCache).sort((a, b) => {
    return new Date(b.orderPlacedDateTime) - new Date(a.orderPlacedDateTime);
  });
  console.log('[Orders] Serveer uit cache:', orders.length);
  res.json({ orders });
});

app.get('/health', (req, res) => res.json({ status: 'ok', tokens: pushTokens.size, cached: Object.keys(ordersCache).length }));

loadCache();
app.listen(CONFIG.PORT, () => console.log('Server draait op poort', CONFIG.PORT));
cron.schedule('*/5 * * * *', syncOrders);
setTimeout(syncOrders, 3000);
