// Ops Hub API: purchases and shipments in Supabase.
// Env vars needed in Vercel: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPS_PASSCODE

const SB = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|storage|auth)\/v1$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PASS = process.env.OPS_PASSCODE;

const PURCHASE_FIELDS = ['store', 'item', 'order_number', 'purchase_date', 'return_window_days', 'tracking_number', 'carrier', 'expected_delivery', 'delivered', 'status', 'notes'];
const SHIPMENT_FIELDS = ['platform', 'item', 'ship_by', 'tracking_number', 'carrier', 'status', 'net_payout', 'notes'];

function pick(obj, fields) {
  const out = {};
  fields.forEach(function (f) {
    if (obj && obj[f] !== undefined && obj[f] !== '') out[f] = obj[f];
  });
  return out;
}

async function sb(path, opts) {
  opts = opts || {};
  const r = await fetch(SB + '/rest/v1/' + path, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: {
      apikey: KEY,
      Authorization: 'Bearer ' + KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text || r.statusText);
  return text ? JSON.parse(text) : null;
}

async function signedUrl(path) {
  try {
    const r = await fetch(SB + '/storage/v1/object/sign/receipts/' + path, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    const j = await r.json();
    return j.signedURL ? SB + '/storage/v1' + j.signedURL : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (!SB || !KEY || !PASS) {
    return res.status(200).json({ configured: false });
  }
  if (req.headers['x-ops-key'] !== PASS) {
    return res.status(401).json({ error: 'Wrong passcode' });
  }

  try {
    if (req.method === 'GET') {
      const results = await Promise.all([
        sb('purchases?select=*&order=return_deadline.asc'),
        sb('shipments?select=*&order=ship_by.asc')
      ]);
      const purchases = results[0] || [];
      await Promise.all(purchases.map(async function (p) {
        if (p.receipt_path) p.receipt_url = await signedUrl(p.receipt_path);
      }));
      return res.status(200).json({ configured: true, purchases: purchases, shipments: results[1] || [] });
    }

    if (req.method === 'POST') {
      const b = req.body || {};

      if (b.action === 'add_purchase') {
        const row = pick(b.purchase, PURCHASE_FIELDS);
        if (!row.store || !row.item || !row.purchase_date) {
          return res.status(400).json({ error: 'Store, item and purchase date are required' });
        }
        let saved = (await sb('purchases', { method: 'POST', body: JSON.stringify(row) }))[0];
        if (b.receipt) {
          const m = /^data:(image\/\w+);base64,(.+)$/.exec(b.receipt);
          if (m) {
            const path = saved.id + '.' + m[1].split('/')[1];
            const up = await fetch(SB + '/storage/v1/object/receipts/' + path, {
              method: 'POST',
              headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': m[1], 'x-upsert': 'true' },
              body: Buffer.from(m[2], 'base64')
            });
            if (up.ok) {
              saved = (await sb('purchases?id=eq.' + saved.id, { method: 'PATCH', body: JSON.stringify({ receipt_path: path }) }))[0];
            }
          }
        }
        return res.status(200).json({ ok: true, purchase: saved });
      }

      if (b.action === 'add_shipment') {
        const row = pick(b.shipment, SHIPMENT_FIELDS);
        if (!row.platform || !row.item || !row.ship_by) {
          return res.status(400).json({ error: 'Platform, item and ship by date are required' });
        }
        const saved = (await sb('shipments', { method: 'POST', body: JSON.stringify(row) }))[0];
        return res.status(200).json({ ok: true, shipment: saved });
      }

      if (b.action === 'update') {
        const table = b.table === 'shipments' ? 'shipments' : 'purchases';
        const patch = pick(b.patch, table === 'shipments' ? SHIPMENT_FIELDS : PURCHASE_FIELDS);
        if (!b.id || !Object.keys(patch).length) {
          return res.status(400).json({ error: 'Missing id or fields' });
        }
        const out = await sb(table + '?id=eq.' + encodeURIComponent(b.id), { method: 'PATCH', body: JSON.stringify(patch) });
        return res.status(200).json({ ok: true, row: out && out[0] });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
