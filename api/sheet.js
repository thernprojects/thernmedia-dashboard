export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const url = process.env.SHEET_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbz3uktahkTIPltiYfsEKLeXnzRexY6fVCROu-H3LjHvpxqQK-9RQGeIlaVZ5W_TMxojMQ/exec';
    const response = await fetch(url);
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
