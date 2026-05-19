const cache = new Map();
const memoryRates = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  HKD: 7.82,
  CAD: 1.36,
  AUD: 1.52,
  CHF: 0.9,
  SEK: 10.5,
  NOK: 10.7,
  DKK: 6.87,
  MXN: 17.1,
  ILS: 3.72,
  JPY: 155,
  PHP: 58
};

export async function convertCurrency(amount, from, to) {
  const value = Number(amount || 0);
  const source = String(from || 'USD').toUpperCase();
  const target = String(to || 'USD').toUpperCase();

  if (!Number.isFinite(value)) return 0;
  if (source === target) return value;

  const rate = await getRate(source, target);
  return value * rate;
}

export async function getRate(from, to) {
  const source = String(from || 'USD').toUpperCase();
  const target = String(to || 'USD').toUpperCase();
  const key = `${source}_${target}`;

  if (source === target) return 1;
  if (cache.has(key)) return cache.get(key);

  try {
    const response = await fetch(`/api/fx?from=${source}&to=${target}`);
    if (!response.ok) throw new Error('FX API failed');
    const data = await response.json();
    const rate = Number(data?.rates?.[target]);
    if (!Number.isFinite(rate)) throw new Error('Missing FX rate');
    cache.set(key, rate);
    return rate;
  } catch {
    const fallback = (memoryRates[target] || 1) / (memoryRates[source] || 1);
    cache.set(key, fallback);
    return fallback;
  }
}
