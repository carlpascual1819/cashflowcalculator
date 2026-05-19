export default async function handler(req, res) {
  const { from = 'USD', to = 'USD', amount = '1' } = req.query;

  try {
    const value = Number(amount);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'Invalid amount' });
    if (from === to) return res.status(200).json({ amount: value, from, to, converted: value, rate: 1 });

    const url = `https://api.frankfurter.app/latest?amount=${encodeURIComponent(value)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Frankfurter returned ${response.status}`);
    const data = await response.json();
    const converted = data.rates?.[to];
    if (typeof converted !== 'number') throw new Error('Missing FX rate');

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ amount: value, from, to, converted, rate: converted / value });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
