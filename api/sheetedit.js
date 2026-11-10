// Writes edits from the Resale tab back to the Google Sheet through your Apps Script.
// Env vars in Vercel: SHEET_SCRIPT_URL (the Apps Script web app URL), SHEET_TOKEN (same secret as in the script), OPS_PASSCODE
export default async function handler(req, res) {
  const URL_ = process.env.SHEET_SCRIPT_URL, TOKEN = process.env.SHEET_TOKEN, PASS = process.env.OPS_PASSCODE;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!URL_ || !TOKEN || !PASS) return res.status(200).json({ error: 'Sheet editing is not set up yet. Add SHEET_SCRIPT_URL and SHEET_TOKEN in Vercel.' });
  if (req.headers['x-ops-key'] !== PASS) return res.status(401).json({ error: 'Wrong passcode. Set it on the Ops tab first.' });
  try {
    const b = req.body || {};
    const payload = { token: TOKEN, action: b.action };
    if (b.action === 'edit') {
      payload.row = b.row; payload.field = b.field; payload.value = b.value; payload.expectItem = b.expectItem;
    } else if (b.action === 'add') {
      payload.fields = b.fields || {};
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
    const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) { return res.status(200).json({ error: 'The Sheet script did not answer correctly. Redeploy it as a new version.' }); }
    return res.status(200).json(j);
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
