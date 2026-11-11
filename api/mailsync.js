// Scans every connected Gmail for orders and shipping emails and saves them as receipts.
// Vercel env vars: MAIL_SOURCES = [{"name":"Main","url":"<web app url>","token":"<secret>"}, ...] plus SUPABASE_URL, SUPABASE_SERVICE_KEY, OPS_PASSCODE, ANTHROPIC_API_KEY
const SB = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|storage|auth)\/v1$/, '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY, PASS = process.env.OPS_PASSCODE, AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.JARVIS_MODEL || 'claude-sonnet-5-5';

async function sb(path, method, body) {
  const r = await fetch(SB + '/rest/v1/' + path, { method: method || 'GET', body: body ? JSON.stringify(body) : undefined, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' } });
  const t = await r.text();
  if (!r.ok) throw new Error(t || r.statusText);
  return t ? JSON.parse(t) : null;
}

const TOOL = { name: 'report_orders', description: 'Report every purchase or shipment found in the emails.', input_schema: { type: 'object', properties: { orders: { type: 'array', items: { type: 'object', properties: {
  email_id: { type: 'string' }, kind: { type: 'string', enum: ['purchase','sale','shipping_label','offer','other'], description: 'purchase = something the owner bought; sale = owner sold an item on Mercari, eBay, TikTok etc; shipping_label = shipping postage receipt; offer = a buyer offer' }, amount: { type: 'number' }, platform: { type: 'string' }, store: { type: 'string' }, order_number: { type: 'string' }, purchase_date: { type: 'string', description: 'YYYY-MM-DD' },
  tracking_number: { type: 'string' }, carrier: { type: 'string' }, expected_delivery: { type: 'string', description: 'YYYY-MM-DD' }, delivered: { type: 'boolean' },
  items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' }, unit_cost: { type: 'number' } }, required: ['name'] } } },
  required: ['email_id', 'kind'] } } }, required: ['orders'] } };

async function extract(emails) {
  const text = emails.map(e => '[' + e.id + '] ' + e.date + ' | ' + e.from + ' | ' + e.subject + '\n' + e.body).join('\n\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, tools: [TOOL], tool_choice: { type: 'tool', name: 'report_orders' },
      system: 'You read order, shipping and delivery emails for a reseller. Classify every real transaction email: purchase (owner bought something), sale (owner sold an item, include platform, item name, amount), shipping_label (postage receipt, include amount), offer (a buyer offer on their listing, include item and amount). Ignore pure marketing. One entry per order number or item. Use the email_id of the best email for that order. Dates are YYYY-MM-DD. Only include fields you can see in the email; never guess. Carrier is USPS, UPS, FedEx, Amazon or other.',
      messages: [{ role: 'user', content: text }] }) });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Anthropic error');
  const u = (j.content || []).find(c => c.type === 'tool_use');
  return u && u.input && u.input.orders ? u.input.orders : [];
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SB || !KEY || !PASS) return res.status(200).json({ error: 'Ops is not connected yet.' });
  if (req.headers['x-ops-key'] !== PASS) return res.status(401).json({ error: 'Unlock the Ops tab with your passcode first.' });
  if (!AKEY) return res.status(200).json({ error: 'Add ANTHROPIC_API_KEY in Vercel and redeploy.' });
  let sources = [];
  try { sources = JSON.parse(process.env.MAIL_SOURCES || '[]'); } catch (e) {}
  if (!sources.length) return res.status(200).json({ error: 'No email accounts connected yet. Add MAIL_SOURCES in Vercel.' });
  try {
    const existing = (await sb('purchases?select=id,order_number,tracking_number,delivered')) || [];
    const byOrder = {}; existing.forEach(p => { if (p.order_number) byOrder[String(p.order_number).trim()] = p; });
    const report = { added: 0, updated: 0, sales: 0, labels: 0, offers: [], accounts: [], errors: [] };
    const salesSeen = new Set(((await sb('shipments?select=platform,item').catch(() => [])) || []).map(x => (x.platform || '') + '|' + (x.item || '')));
    for (const s of sources) {
      try {
        const r = await fetch(s.url + (s.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(s.token), { redirect: 'follow' });
        const j = JSON.parse(await r.text());
        if (j.error) throw new Error(j.error);
        const emails = (j.emails || []).slice(0, 60).map(e => ({ ...e, body: String(e.body || '').slice(0, 700) }));
        report.accounts.push({ name: s.name, emails: emails.length });
        if (!emails.length) continue;
        const parts = []; for (let i = 0; i < emails.length; i += 20) parts.push(emails.slice(i, i + 20));
        const orders = (await Promise.all(parts.map(extract))).flat();
        for (const o of orders) {
          if (o.kind === 'offer') { report.offers.push((o.platform || '') + ' ' + (o.items && o.items[0] ? o.items[0].name : '') + (o.amount ? ' $' + o.amount : '')); continue; }
          if (o.kind === 'shipping_label') { report.labels += Number(o.amount) || 0; continue; }
          if (o.kind === 'sale') {
            const nm = (o.items && o.items[0] ? o.items[0].name : (o.order_number || 'Sale')).slice(0, 120);
            const dupe = salesSeen.has((o.platform || '') + '|' + nm);
            if (!dupe) { try { await sb('shipments', 'POST', { platform: o.platform || 'Mercari', item: nm, ship_by: o.purchase_date || new Date().toISOString().slice(0, 10) }); report.sales++; salesSeen.add((o.platform || '') + '|' + nm); } catch (e) {} }
            continue;
          }
          if (!o.store) continue;
          const on = String(o.order_number || '').trim(); if (!on) continue;
          const have = byOrder[on];
          if (have) {
            const patch = {};
            if (o.tracking_number && !have.tracking_number) patch.tracking_number = o.tracking_number;
            if (o.carrier && !have.tracking_number) patch.carrier = o.carrier;
            if (o.expected_delivery) patch.expected_delivery = o.expected_delivery;
            if (o.delivered && !have.delivered) patch.delivered = true;
            if (Object.keys(patch).length) { await sb('purchases?id=eq.' + have.id, 'PATCH', patch); report.updated++; }
            continue;
          }
          const items = (o.items || []).filter(i => i && i.name);
          const label = /^amazon/i.test(o.store) && sources.length > 1 ? 'Amazon (' + s.name + ')' : o.store;
          const row = { store: label, purchase_date: o.purchase_date || new Date().toISOString().slice(0, 10), order_number: on, item: items.length > 1 ? items[0].name + ' +' + (items.length - 1) + ' more' : (items[0] ? items[0].name : 'Order ' + on), return_window_days: 30 };
          const st = await sb('stores?select=return_window_days&name=ilike.' + encodeURIComponent(o.store)).catch(() => []);
          if (st && st[0]) row.return_window_days = st[0].return_window_days;
          ['tracking_number', 'carrier', 'expected_delivery'].forEach(k => { if (o[k]) row[k] = o[k]; });
          if (o.delivered) row.delivered = true;
          const saved = (await sb('purchases', 'POST', row))[0];
          if (items.length) await sb('purchase_items', 'POST', items.map(i => ({ purchase_id: saved.id, name: i.name, qty: i.qty > 0 ? i.qty : 1, unit_cost: i.unit_cost == null ? null : i.unit_cost })));
          byOrder[on] = { id: saved.id, tracking_number: row.tracking_number, delivered: row.delivered };
          report.added++;
        }
      } catch (e) { report.errors.push((s.name || 'account') + ': ' + e.message); }
    }
    return res.status(200).json(report);
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
