// Ops Hub API: receipts (with items), stores and outgoing shipments in Supabase.
// Env vars needed in Vercel: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPS_PASSCODE

// Accept any pasted form of the project URL: strips /rest/v1, /storage/v1 and trailing slashes
const SB = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|storage|auth)\/v1$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PASS = process.env.OPS_PASSCODE;

const PURCHASE_FIELDS = ['store', 'item', 'order_number', 'purchase_date', 'return_window_days', 'tracking_number', 'carrier', 'expected_delivery', 'delivered', 'status', 'notes'];
const REQUIRED_FIELDS = ['store', 'purchase_date', 'return_window_days'];
const SHIPMENT_FIELDS = ['platform', 'item', 'ship_by', 'tracking_number', 'carrier', 'status', 'net_payout', 'notes'];
const ID_RE = /^[0-9a-fA-F-]{36}$/;

function pick(obj, fields) {
  const out = {};
  fields.forEach(function (f) {
    if (obj && obj[f] !== undefined && obj[f] !== '') out[f] = obj[f];
  });
  return out;
}

// Like pick, but lets optional fields be cleared (empty text becomes null)
function pickEdit(obj, fields) {
  const out = {};
  fields.forEach(function (f) {
    if (!obj || obj[f] === undefined) return;
    if (obj[f] === '') {
      if (REQUIRED_FIELDS.indexOf(f) < 0) out[f] = null;
    } else {
      out[f] = obj[f];
    }
  });
  return out;
}

function toInt(v, d) {
  const n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? d : n;
}

function cleanItems(list) {
  return (list || []).map(function (it) {
    const name = String(it.name || '').trim();
    if (!name) return null;
    const qty = toInt(it.qty, 1);
    const ret = toInt(it.qty_returned, 0);
    const sold = toInt(it.qty_sold, 0);
    if (ret + sold > qty) {
      throw new Error('Returned plus sold is more than the quantity for ' + name);
    }
    const cost = parseFloat(it.unit_cost);
    const row = { name: name, qty: qty, qty_returned: ret, qty_sold: sold, unit_cost: isNaN(cost) ? null : cost };
    if (it.id) {
      if (!ID_RE.test(it.id)) throw new Error('Bad item id');
      row.id = it.id;
    }
    return row;
  }).filter(Boolean);
}

function summarize(items) {
  if (!items.length) return null;
  return items.length > 1 ? items[0].name + ' +' + (items.length - 1) + ' more' : items[0].name;
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

async function uploadReceipt(id, dataUrl) {
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const path = id + '.' + m[1].split('/')[1];
  const up = await fetch(SB + '/storage/v1/object/receipts/' + path, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': m[1], 'x-upsert': 'true' },
    body: Buffer.from(m[2], 'base64')
  });
  if (!up.ok) return null;
  await sb('purchases?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ receipt_path: path }) });
  return path;
}

async function loadAll() {
  let needsUpgrade = false;
  let purchases;
  try {
    purchases = await sb('purchases?select=*,purchase_items(*)&order=return_deadline.asc&purchase_items.order=created_at.asc');
  } catch (e) {
    needsUpgrade = true;
    purchases = await sb('purchases?select=*&order=return_deadline.asc');
  }
  const extras = await Promise.all([
    sb('shipments?select=*&order=ship_by.asc'),
    sb('stores?select=*&order=name.asc').catch(function () { return []; })
  ]);
  await Promise.all((purchases || []).map(async function (p) {
    if (p.receipt_path) p.receipt_url = await signedUrl(p.receipt_path);
  }));
  return { configured: true, needsUpgrade: needsUpgrade, purchases: purchases || [], shipments: extras[0] || [], stores: extras[1] || [] };
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
      return res.status(200).json(await loadAll());
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const b = req.body || {};

    if (b.action === 'add_purchase') {
      const row = pick(b.purchase, PURCHASE_FIELDS);
      const items = cleanItems(b.items);
      if (!row.store || !row.purchase_date) {
        return res.status(400).json({ error: 'Store and purchase date are required' });
      }
      if (!items.length) {
        return res.status(400).json({ error: 'Add at least one item' });
      }
      row.item = summarize(items);
      let saved = (await sb('purchases', { method: 'POST', body: JSON.stringify(row) }))[0];
      await sb('purchase_items', {
        method: 'POST',
        body: JSON.stringify(items.map(function (i) { delete i.id; i.purchase_id = saved.id; return i; }))
      });
      if (b.receipt) await uploadReceipt(saved.id, b.receipt);
      saved = (await sb('purchases?id=eq.' + saved.id))[0];
      return res.status(200).json({ ok: true, purchase: saved });
    }

    if (b.action === 'save_purchase') {
      if (!ID_RE.test(b.id || '')) return res.status(400).json({ error: 'Bad receipt id' });
      const id = b.id;
      const header = pickEdit(b.purchase, PURCHASE_FIELDS);
      if (b.items) {
        const items = cleanItems(b.items);
        if (!items.length) return res.status(400).json({ error: 'Add at least one item' });
        header.item = summarize(items);
        const existing = (await sb('purchase_items?select=id&purchase_id=eq.' + id)) || [];
        const keep = items.filter(function (i) { return i.id; }).map(function (i) { return i.id; });
        const drop = existing.map(function (e) { return e.id; }).filter(function (x) { return keep.indexOf(x) < 0; });
        if (drop.length) await sb('purchase_items?id=in.(' + drop.join(',') + ')', { method: 'DELETE' });
        const fresh = items.filter(function (i) { return !i.id; }).map(function (i) { return Object.assign({ purchase_id: id }, i); });
        for (const it of items.filter(function (i) { return i.id; })) {
          const patch = Object.assign({}, it);
          delete patch.id;
          await sb('purchase_items?id=eq.' + it.id, { method: 'PATCH', body: JSON.stringify(patch) });
        }
        if (fresh.length) await sb('purchase_items', { method: 'POST', body: JSON.stringify(fresh) });
      }
      if (Object.keys(header).length) {
        await sb('purchases?id=eq.' + id, { method: 'PATCH', body: JSON.stringify(header) });
      }
      if (b.receipt) await uploadReceipt(id, b.receipt);
      const saved = (await sb('purchases?id=eq.' + id))[0];
      return res.status(200).json({ ok: true, purchase: saved });
    }

    if (b.action === 'delete_purchase') {
      if (!ID_RE.test(b.id || '')) return res.status(400).json({ error: 'Bad receipt id' });
      const rows = await sb('purchases?select=receipt_path&id=eq.' + b.id);
      const path = rows && rows[0] && rows[0].receipt_path;
      if (path) {
        await fetch(SB + '/storage/v1/object/receipts/' + path, {
          method: 'DELETE',
          headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
        }).catch(function () {});
      }
      await sb('purchases?id=eq.' + b.id, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'return_all') {
      if (!ID_RE.test(b.id || '')) return res.status(400).json({ error: 'Bad receipt id' });
      const items = (await sb('purchase_items?select=id,qty,qty_sold&purchase_id=eq.' + b.id)) || [];
      for (const it of items) {
        await sb('purchase_items?id=eq.' + it.id, { method: 'PATCH', body: JSON.stringify({ qty_returned: Math.max(0, it.qty - it.qty_sold) }) });
      }
      return res.status(200).json({ ok: true });
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
      const patch = pickEdit(b.patch, table === 'shipments' ? SHIPMENT_FIELDS : PURCHASE_FIELDS);
      if (!ID_RE.test(b.id || '') || !Object.keys(patch).length) {
        return res.status(400).json({ error: 'Missing id or fields' });
      }
      const out = await sb(table + '?id=eq.' + b.id, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(200).json({ ok: true, row: out && out[0] });
    }

    if (b.action === 'store_save') {
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Store name is required' });
      const body = JSON.stringify({ name: name, return_window_days: toInt(b.return_window_days, 30) });
      if (b.id) {
        if (!ID_RE.test(b.id)) return res.status(400).json({ error: 'Bad store id' });
        await sb('stores?id=eq.' + b.id, { method: 'PATCH', body: body });
      } else {
        await sb('stores', { method: 'POST', body: body });
      }
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'store_delete') {
      if (!ID_RE.test(b.id || '')) return res.status(400).json({ error: 'Bad store id' });
      await sb('stores?id=eq.' + b.id, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
