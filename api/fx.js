export default async function handler(req, res) {
  try {
    const { from = 'USD', to = 'USD' } = req.query || {};
    const base = String(from).toUpperCase();
    const symbols = String(to).toUpperCase();

    if (base === symbols) {
      return res.status(200).json({ base, rates: { [symbols]: 1 } });
    }

    const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(symbols)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`FX request failed: ${response.status}`);
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'FX request failed' });
  }
}
