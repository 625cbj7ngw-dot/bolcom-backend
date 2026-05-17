const axios = require('axios');
async function test() {
  const clientId = '23dacd81-02dc-41b2-b29e-99ddcb542462';
  const clientSecret = 'nkxMOcrjwgdriVPMultRsLJjudnYuPNqwdSNznp19jWO0CYB9c6CEiwjFsug3xr!';
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  console.log('Base64:', credentials.substring(0, 30));
  try {
    const res = await axios.post('https://login.bol.com/token?grant_type=client_credentials', null, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    console.log('OK!', res.data.access_token.substring(0, 20));
  } catch(e) {
    console.log('Fout:', e.response?.status, JSON.stringify(e.response?.data));
  }
}
test();
