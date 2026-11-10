// Jarvis command bar brain. Env vars in Vercel: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPS_PASSCODE, ANTHROPIC_API_KEY
const SB = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|storage|auth)\/v1$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PASS = process.env.OPS_PASSCODE;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.JARVIS_MODEL || 'claude-sonnet-5-5';
const ID_RE = /^[0-9a-fA-F-]{36}$/;

async function sb(path, method, body) {
  const r = await fetch(SB + '/rest/v1/' + path, {
    method: method || 'GET',
    body: body ? JSON.stringify(body) : undefined,
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' }
  });
  const t = await r.text();
  if (!r.ok) throw new Error(t || r.statusText);
  return t ? JSON.parse(t) : null;
}

const TOOLS = [
  { name: 'get_overview', description: 'Get all receipts with items, outgoing shipments and stores.', input_schema: { type: 'object', properties: {} } },
  { name: 'add_purchase', description: 'Add a receipt (store purchase) with one or more items. Dates are YYYY-MM-DD.', input_schema: { type: 'object', properties: {
    store: { type: 'string' }, purchase_date: { type: 'string' }, return_window_days: { type: 'integer' },
    order_number: { type: 'string' }, tracking_number: { type: 'string' }, carrier: { type: 'string' }, expected_delivery: { type: 'string' },
    items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' }, unit_cost: { type: 'number' } }, required: ['name'] } } },
    required: ['store', 'purchase_date', 'items'] } },
  { name: 'add_shipment', description: 'Add an outgoing customer shipment that needs to ship.', input_schema: { type: 'object', properties: {
    platform: { type: 'string' }, item: { type: 'string' }, ship_by: { type: 'string' }, tracking_number: { type: 'string' }, carrier: { type: 'string' } }, required: ['platform', 'item', 'ship_by'] } },
  { name: 'set_shipment_status', description: 'Set a shipment status.', input_schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['to_ship', 'shipped', 'delivered'] } }, required: ['id', 'status'] } },
  { name: 'update_purchase', description: 'Update a receipt: mark delivered, set status, tracking, or expected delivery.', input_schema: { type: 'object', properties: {
    id: { type: 'string' }, delivered: { type: 'boolean' }, status: { type: 'string', enum: ['open', 'returned', 'kept', 'sold'] }, tracking_number: { type: 'string' }, carrier: { type: 'string' }, expected_delivery: { type: 'string' } }, required: ['id'] } },
  { name: 'return_all', description: 'Mark every unsold unit on a receipt as returned.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }
];

async function runTool(name, a) {
  if (name === 'get_overview') {
    const p = await sb('purchases?select=*,purchase_items(*)&order=return_deadline.asc');
    const s = await sb('shipments?select=*&order=ship_by.asc');
    return { purchases: p, shipments: s };
  }
  if (name === 'add_purchase') {
    const items = (a.items || []).filter(function (i) { return i && i.name; });
    if (!items.length) throw new Error('Need at least one item');
    const row = { store: a.store, purchase_date: a.purchase_date, return_window_days: a.return_window_days || 30, item: items.length > 1 ? items[0].name + ' +' + (items.length - 1) + ' more' : items[0].name };
    ['order_number', 'tracking_number', 'carrier', 'expected_delivery'].forEach(function (k) { if (a[k]) row[k] = a[k]; });
    if (!a.return_window_days) {
      const st = await sb('stores?select=return_window_days&name=ilike.' + encodeURIComponent(a.store)).catch(function () { return []; });
      if (st && st[0]) row.return_window_days = st[0].return_window_days;
    }
    const saved = (await sb('purchases', 'POST', row))[0];
    await sb('purchase_items', 'POST', items.map(function (i) { return { purchase_id: saved.id, name: i.name, qty: i.qty > 0 ? i.qty : 1, unit_cost: i.unit_cost == null ? null : i.unit_cost }; }));
    return { ok: true, id: saved.id, return_deadline: saved.return_deadline };
  }
  if (name === 'add_shipment') {
    const row = { platform: a.platform, item: a.item, ship_by: a.ship_by };
    if (a.tracking_number) row.tracking_number = a.tracking_number;
    if (a.carrier) row.carrier = a.carrier;
    const saved = (await sb('shipments', 'POST', row))[0];
    return { ok: true, id: saved.id };
  }
  if (!ID_RE.test(a.id || '')) throw new Error('Bad id');
  if (name === 'set_shipment_status') { await sb('shipments?id=eq.' + a.id, 'PATCH', { status: a.status }); return { ok: true }; }
  if (name === 'update_purchase') {
    const patch = {};
    ['delivered', 'status', 'tracking_number', 'carrier', 'expected_delivery'].forEach(function (k) { if (a[k] !== undefined) patch[k] = a[k]; });
    await sb('purchases?id=eq.' + a.id, 'PATCH', patch);
    return { ok: true };
  }
  if (name === 'return_all') {
    const items = (await sb('purchase_items?select=id,qty,qty_sold&purchase_id=eq.' + a.id)) || [];
    for (const it of items) await sb('purchase_items?id=eq.' + it.id, 'PATCH', { qty_returned: Math.max(0, it.qty - it.qty_sold) });
    return { ok: true };
  }
  throw new Error('Unknown tool');
}

async function claude(messages, system) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system: system, tools: TOOLS, messages: messages })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Anthropic error');
  return j;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB || !KEY || !PASS) return res.status(200).json({ reply: 'Ops is not connected yet.' });
  if (req.headers['x-ops-key'] !== PASS) return res.status(401).json({ error: 'Unlock the Ops tab with your passcode first, then try again.' });
  if (!AKEY) return res.status(200).json({ reply: 'Add ANTHROPIC_API_KEY in Vercel and redeploy to turn on the AI.' });
  try {
    const b = req.body || {};
    const msg = String(b.message || '').slice(0, 1000);
    if (!msg) return res.status(400).json({ error: 'Empty message' });
    const ctx = b.context ? '\nDashboard numbers right now: ' + JSON.stringify(b.context).slice(0, 1500) : '';
    const system = 'You are Jarvis, the operations assistant for Tommy\'s reselling dashboard. Today is ' + (b.today || new Date().toISOString().slice(0, 10)) + '. Tommy is in Los Angeles. Use the tools to read and change receipts, return deadlines and shipments. Look up ids with get_overview before changing anything. Do exactly what he asks and nothing more. Answers are spoken aloud, so keep them to one or two short sentences, plain words, no lists, no markdown, no hyphens or dashes. After a change, say what you did.' + ctx;
    let messages = [{ role: 'user', content: msg }];
    let refresh = false;
    for (let i = 0; i < 6; i++) {
      const out = await claude(messages, system);
      const uses = out.content.filter(function (c) { return c.type === 'tool_use'; });
      if (!uses.length || out.stop_reason !== 'tool_use') {
        const text = out.content.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join(' ').trim();
        return res.status(200).json({ reply: text || 'Done.', refresh: refresh });
      }
      messages.push({ role: 'assistant', content: out.content });
      const results = [];
      for (const u of uses) {
        let content;
        try {
          const r = await runTool(u.name, u.input || {});
          if (u.name !== 'get_overview') refresh = true;
          content = JSON.stringify(r);
        } catch (e) { content = 'Error: ' + e.message; }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: content });
      }
      messages.push({ role: 'user', content: results });
    }
    return res.status(200).json({ reply: 'That took too many steps. Try a simpler command.', refresh: refresh });
  } catch (e) {
    return res.status(200).json({ reply: 'Jarvis hit an error: ' + e.message });
  }
}
