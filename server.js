// WinnersBet payments API — single-file deployment build.
// Contains the Express server + all payment providers (mock, LightIO, SonicPesa)
// inline so the whole API lives in ONE file (no folder structure required).
//
// Environment variables:
//   PAYMENT_MODE=mock|live
//   PAYMENT_PROVIDER=lightio|sonicpesa
//   SONIC_API_KEY / SONIC_SECRET_KEY / SONIC_BASE_URL   (SonicPesa)
//   LIGHTIO_API_USERNAME / LIGHTIO_API_PASSWORD / LIGHTIO_SERVICE_CODE / LIGHTIO_BASE_URL  (LightIO)
//   MOCK_PAY_DELAY_MS   (mock auto-confirm delay)
//   PORT                (web port)
//
// Endpoints:
//   GET  /api/health
//   POST /api/pay/initiate   { bundleId, title, price, phone, network }
//   POST /api/pay/status     { ref }
//   POST /api/pay/webhook    (reserved)

import 'dotenv/config';
import express from 'express';
import https from 'node:https';

// ---------------------------------------------------------------- helpers ---

function postJson(url, headers, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = {};
          try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

const NETWORKS = {
  'M-PESA': 'VODACOM',
  'TIGO PESA': 'TIGO',
  'AIRTEL MONEY': 'AIRTEL',
  'HALOPESA': 'HALOPESA',
};

function lightioNetwork(network) {
  return NETWORKS[network] || network;
}

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d]/g, '');
  if (p.startsWith('0')) p = '255' + p.slice(1);
  if (p.startsWith('255') && p.length === 12) return p;
  if (p.length === 9 && p.startsWith('7')) p = '255' + p;
  if (p.length === 10 && p.startsWith('0')) p = '255' + p.slice(1);
  if (!/^255\d{9}$/.test(p)) return null;
  return p;
}

// ------------------------------------------------------------ adapter ---

function createAdapter(env) {
  const mode = String(env.PAYMENT_MODE || 'mock').toLowerCase() === 'live' ? 'live' : 'mock';
  const provider = String(env.PAYMENT_PROVIDER || 'lightio').toLowerCase();
  const delayMs = Number(env.MOCK_PAY_DELAY_MS || 6000);

  // in-memory payment records keyed by ref
  const records = new Map();

  async function mockInitiate({ amount, phone, network, reference }) {
    const ref = `wbo_mock_${Date.now()}`;
    records.set(ref, { ref, amount, phone, network, reference, status: 'PENDING', createdAt: Date.now(), mode: 'mock' });
    return { ref, reference, status: 'PENDING', mode: 'mock', message: 'Mock payment request received.' };
  }

  async function mockStatus(ref) {
    const rec = records.get(ref);
    if (!rec) return { ref, status: 'FAILED', message: 'Unknown reference.' };
    if (rec.status !== 'PENDING') return { ref, status: rec.status, message: rec.message };
    if (Date.now() - rec.createdAt >= delayMs) {
      rec.status = 'SUCCESS';
      rec.message = 'Payment confirmed (mock).';
    }
    return { ref, status: rec.status, message: rec.status === 'SUCCESS' ? 'Payment confirmed (mock).' : 'Awaiting customer confirmation.' };
  }

  const baseUrl = String(env.LIGHTIO_BASE_URL || 'https://lightio.com/lightpayplus').replace(/\/$/, '');
  const username = env.LIGHTIO_API_USERNAME || '';
  const password = env.LIGHTIO_API_PASSWORD || '';
  const defaultServiceCode = env.LIGHTIO_SERVICE_CODE || '';

  async function lightioInitiate({ amount, phone, network, serviceCode }) {
    const headers = {
      'api_username': username,
      'api_password': password,
      'Content-Type': 'application/json',
    };
    const body = {
      amount: String(amount),
      customer_msisdn: phone,
      service_code: serviceCode || defaultServiceCode,
      network: lightioNetwork(network),
      country: 'TZ',
      currency: 'TZS',
      reference_number: `WBO-${Date.now()}`,
    };
    const res = await fetch(`${baseUrl}/api/customer/v1/requests/payment`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`LightIO initiate failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
    }
    const ref = data.payment_request_id;
    records.set(ref, { ref, status: 'PENDING', amount, phone, network, createdAt: Date.now(), mode: 'live', provider: 'lightio' });
    return { ref, reference: data.reference_number || ref, status: 'PENDING', mode: 'live', provider: 'lightio', message: 'STK push sent to phone.' };
  }

  async function lightioStatus(ref) {
    const res = await fetch(`${baseUrl}/api/customer/v1/requests/verify/phone`, {
      method: 'POST',
      headers: { 'api_username': username, 'api_password': password, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_request_id: ref }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ref, status: 'PENDING', message: `Verify failed (HTTP ${res.status})` };
    const statusMap = {
      success: 'SUCCESS',
      succeeded: 'SUCCESS',
      failed: 'FAILED',
      failed_funds: 'FAILED',
      timeout: 'FAILED',
    };
    const status = statusMap[String(data.status || '').toLowerCase()] || 'PENDING';
    const rec = records.get(ref);
    if (rec && status === 'SUCCESS') rec.status = 'SUCCESS';
    return { ref, status, message: data.message || status };
  }

  const sonicBase = String(env.SONIC_BASE_URL || 'https://api.sonicpesa.com').replace(/\/$/, '');
  const sonicApiKey = env.SONIC_API_KEY || '';
  const sonicSecret = env.SONIC_SECRET_KEY || '';

  function sonicHeaders() {
    return {
      'X-API-KEY': sonicApiKey,
      'X-SECRET-KEY': sonicSecret,
      'Content-Type': 'application/json',
    };
  }

  async function sonicInitiate({ amount, phone }) {
    if (!sonicApiKey) throw new Error('SonicPesa not configured — set SONIC_API_KEY and SONIC_SECRET_KEY in the environment.');
    const body = {
      buyer_email: 'payments@winnersbet.co.tz',
      buyer_name: 'WinnersBet Customer',
      buyer_phone: phone,
      amount: Math.round(Number(amount) || 0),
      currency: 'TZS',
    };
    const res = await postJson(`${sonicBase}/api/v1/payment/create_order`, sonicHeaders(), body);
    if (!res.ok) throw new Error(`SonicPesa create_order failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    const data = res.data;
    const orderId = data.order_id || data.transaction_id || data.reference || data.data?.order_id || data.data?.transaction_id;
    if (!orderId) throw new Error(`SonicPesa did not return an order reference: ${JSON.stringify(data).slice(0, 200)}`);
    records.set(orderId, { ref: orderId, status: 'PENDING', amount, phone, createdAt: Date.now(), mode: 'live', provider: 'sonicpesa' });
    return { ref: orderId, reference: orderId, status: 'PENDING', mode: 'live', provider: 'sonicpesa', message: 'Payment prompt sent to phone.' };
  }

  async function sonicStatus(ref) {
    const res = await postJson(`${sonicBase}/api/v1/payment/order_status`, sonicHeaders(), { order_id: ref });
    if (!res.ok) return { ref, status: 'PENDING', message: `SonicPesa order_status failed (HTTP ${res.status})` };
    const data = res.data;
    const lc = `${String(data.status || '')} ${String(data.data?.status || '')} ${String(data.message || '')}`.toLowerCase();
    let status = 'PENDING';
    if (/(success|paid|completed|complete|succeeded|finished|confirmed)/.test(lc)) status = 'SUCCESS';
    else if (/(fail|cancel|expired|timeout|error|rejected|denied|declined)/.test(lc)) status = 'FAILED';
    return { ref, status, message: data.message || data.data?.message || status };
  }

  return {
    mode,
    provider,
    initiate: mode === 'mock'
      ? mockInitiate
      : provider === 'sonicpesa'
        ? sonicInitiate
        : lightioInitiate,
    status: mode === 'mock'
      ? mockStatus
      : provider === 'sonicpesa'
        ? sonicStatus
        : lightioStatus,
    networks: Object.keys(NETWORKS),
  };
}

// ---------------------------------------------------------------- server ---

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const pay = createAdapter(process.env);
const PORT = Number(process.env.PORT || 4000);

const VALID_NETWORKS = new Set(['M-PESA', 'TIGO PESA', 'AIRTEL MONEY', 'HALOPESA']);

app.post('/api/pay/initiate', async (req, res) => {
  try {
    const { bundleId, title, price, phone, network } = req.body || {};
    const amount = Number(price);
    if (!bundleId || !title) return res.status(400).json({ error: 'Missing bundle details.' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount.' });
    const msisdn = normalizePhone(phone);
    if (!msisdn) return res.status(400).json({ error: 'Invalid Tanzanian phone number (e.g. 07XXXXXXXX or +255XXXXXXXXX).' });
    if (!VALID_NETWORKS.has(String(network))) {
      return res.status(400).json({ error: `Unsupported network. Must be one of: ${[...VALID_NETWORKS].join(', ')}.` });
    }

    const ref = `wbo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await pay.initiate({ amount, phone: msisdn, network, reference: ref });
    res.json({
      ref: result.ref || ref,
      referenceNumber: result.reference || ref,
      bundleId,
      title,
      amount,
      network,
      phone: msisdn,
      status: result.status,
      mode: result.mode,
      message: result.message,
    });
  } catch (err) {
    console.error('[pay] initiate error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/pay/status', async (req, res) => {
  try {
    const { ref } = req.body || {};
    if (!ref) return res.status(400).json({ error: 'Missing payment reference.' });
    const result = await pay.status(String(ref));
    res.json(result);
  } catch (err) {
    console.error('[pay] status error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: pay.mode, provider: pay.provider, networks: pay.networks, ts: new Date().toISOString() });
});

app.post('/api/pay/webhook', (req, res) => {
  console.log('[pay] webhook:', JSON.stringify(req.body).slice(0, 500));
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`[winnersbet-pay] listening on http://localhost:${PORT} (mode: ${pay.mode}, provider: ${pay.provider})`);
  console.log(`[winnersbet-pay] supported networks: ${pay.networks.join(', ')}`);
});