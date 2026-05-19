const cache = new Map();

export async function convertCurrency(amount, from = 'USD', to = 'USD') {
  const value = Number(amount) || 0;
  if (!from || !to || from === to) return value;

  const key = `${from}:${to}`;
  if (cache.has(key)) return value * cache.get(key);

  const response = await fetch(`/api/fx?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=1`);
  if (!response.ok) {
    console.warn('FX failed, using 1:1 fallback', from, to);
    cache.set(key, 1);
    return value;
  }

  const data = await response.json();
  const rate = Number(data.rate || data.converted || 1);
  cache.set(key, rate);
  return value * rate;
}
