const axios = require('axios');

async function test() {
  const credentials = Buffer.from('7fedb0f6-223e-40c0-9b52-32b2d3f3c7bb:v1zSk(pgF7B7!9HDFTotfHjFTHW9MyDH2KAYGHe0ANfegWypYES@k@upokMXx@Bw').toString('base64');
  const tokenRes = await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, { headers: { Authorization: `Basic ${credentials}` } });
  const token = tokenRes.data.access_token;
  
  try {
    const res = await axios.get('https://api.bol.com/retailer/inventory', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.retailer.v10+json' } });
    console.log('inventory:', JSON.stringify(res.data).substring(0, 500));
  } catch(e) { console.log('inventory fout:', e.response?.status, e.response?.data); }

  try {
    const res = await axios.get('https://api.bol.com/retailer/offers', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.retailer.v10+json' } });
    console.log('offers:', JSON.stringify(res.data).substring(0, 500));
  } catch(e) { console.log('offers fout:', e.response?.status, JSON.stringify(e.response?.data)); }
}

test().catch(console.error);
