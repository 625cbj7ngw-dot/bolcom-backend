const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const app = express();
app.use(express.json());
const CONFIG = { BOL_CLIENT_ID: process.env.BOL_CLIENT_ID, BOL_CLIENT_SECRET: process.env.BOL_CLIENT_SECRET, PORT: process.env.PORT || 3000 };
let accessToken = null, tokenExpiry = null, knownOrderIds = new Set(), pushTokens = new Set(), isFirstRun = true;
async function getBolToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
  const credentials = Buffer.from(`${CONFIG.BOL_CLIENT_ID}:${CONFIG.BOL_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, { headers: { Authorization: `Basic ${credentials}` } });
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return accessToken;
}
async function fetchOrders(status) {
  const token = await getBolToken();
  const res = await axios.get('https://api.bol.com/retailer/orders', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.retailer.v10+json' }, params: { status, page: 1 } });
  return res.data.orders || [];
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
async function checkNewOrders() {
  try {
    const orders = await fetchOrders('OPEN');
    if (isFirstRun) { orders.forEach(o => knownOrderIds.add(o.orderId)); isFirstRun = false; return; }
    for (const order of orders.filter(o => !knownOrderIds.has(o.orderId))) {
      knownOrderIds.add(order.orderId);
      let detail = null;
      try { detail = await fetchOrderDetail(order.orderId); } catch(e) {}
      const product = detail?.orderItems?.[0]?.product?.title || 'product';
      const total = detail?.orderItems?.reduce((s, i) => s + (i.unitPrice * i.quantity || 0), 0) || 0;
      await sendPush('Nieuwe bestelling! #' + order.orderId, product + ' - EUR' + total.toFixed(2), { orderId: order.orderId });
    }
  } catch(e) { if (e.response?.status === 401) accessToken = null; }
}
app.post('/register-token', (req, res) => { pushTokens.add(req.body.token); res.json({ success: true }); });
app.get('/orders', async (req, res) => {
  try {
    const [open, shipped, delivered] = await Promise.all([fetchOrders('OPEN'), fetchOrders('SHIPPED'), fetchOrders('DELIVERED')]);
    const allOrders = [...open, ...shipped, ...delivered];
    console.log('[Orders] Opgehaald:', allOrders.length);
    const detailed = await Promise.allSettled(allOrders.slice(0, 30).map(o => fetchOrderDetail(o.orderId)));
    res.json({ orders: detailed.filter(r => r.status === 'fulfilled').map(r => r.value) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/health', (req, res) => res.json({ status: 'ok', tokens: pushTokens.size }));
app.listen(CONFIG.PORT, () => console.log('Server draait op poort', CONFIG.PORT));
cron.schedule('*/5 * * * *', checkNewOrders);
setTimeout(checkNewOrders, 3000);
