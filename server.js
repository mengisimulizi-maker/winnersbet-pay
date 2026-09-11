import 'dotenv/config';
import express from 'express';
import { createAdapter, normalizePhone } from './lib/pay/adapter.js';

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

// POST /api/pay/initiate — request an STK push for a paid odds bundle
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

// POST /api/pay/status — poll a payment
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

// GET /api/pay/health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: pay.mode, provider: pay.provider, networks: pay.networks, ts: new Date().toISOString() });
});

// Optional: POST /api/pay/webhook — reserved for provider server-side confirmations
app.post('/api/pay/webhook', (req, res) => {
  console.log('[pay] webhook:', JSON.stringify(req.body).slice(0, 500));
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`[winnersbet-pay] listening on http://localhost:${PORT} (mode: ${pay.mode}, provider: ${pay.provider})`);
  console.log(`[winnersbet-pay] supported networks: ${pay.networks.join(', ')}`);
});