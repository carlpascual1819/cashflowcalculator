import { convertCurrency } from './fx';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'HKD', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'DKK', 'MXN', 'ILS', 'JPY', 'PHP'];

export function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function fmt(value, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format(num(value));
}

export function daysUntil(dateString) {
  if (!dateString) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.ceil((due - today) / 86400000);
}

export async function enrichPayout(payout, displayCurrency) {
  const grossNative = num(payout.gross_amount);
  const payoutConversionFeeNative = grossNative * (num(payout.payout_conversion_fee_percent) / 100);
  const payoutTransferFeeNative = num(payout.payout_transfer_fee_flat);
  const bankConversionFeeNative = grossNative * (num(payout.bank_conversion_fee_percent) / 100);
  const bankReceivingFeeNative = num(payout.bank_receiving_fee_flat);
  const totalFeesNative = payoutConversionFeeNative + payoutTransferFeeNative + bankConversionFeeNative + bankReceivingFeeNative;
  const netNative = Math.max(0, grossNative - totalFeesNative);
  const netDisplay = await convertCurrency(netNative, payout.currency, displayCurrency);
  const grossDisplay = await convertCurrency(grossNative, payout.currency, displayCurrency);
  const totalFeesDisplay = await convertCurrency(totalFeesNative, payout.currency, displayCurrency);

  return {
    ...payout,
    grossNative,
    payoutConversionFeeNative,
    payoutTransferFeeNative,
    bankConversionFeeNative,
    bankReceivingFeeNative,
    totalFeesNative,
    netNative,
    grossDisplay,
    totalFeesDisplay,
    netDisplay
  };
}

export async function calculateDashboard({ banks, payouts, suppliers, adAccounts, settings }) {
  const displayCurrency = settings.display_currency || 'USD';
  const enrichedPayouts = [];

  for (const payout of payouts) {
    enrichedPayouts.push(await enrichPayout(payout, displayCurrency));
  }

  const bankCards = [];
  for (const bank of banks) {
    const balanceDisplay = await convertCurrency(num(bank.balance), bank.currency, displayCurrency);
    const routedIncoming = enrichedPayouts.filter(p => p.destination_bank_id === bank.id && p.status !== 'received');
    const incomingDisplay = routedIncoming.reduce((sum, p) => sum + p.netDisplay, 0);
    bankCards.push({ ...bank, balanceDisplay, incomingDisplay, projectedDisplay: balanceDisplay + incomingDisplay });
  }

  const supplierRows = [];
  for (const supplier of suppliers) {
    const amountDisplay = await convertCurrency(num(supplier.amount_due), supplier.currency, displayCurrency);
    supplierRows.push({ ...supplier, amountDisplay, daysLeft: daysUntil(supplier.due_date) });
  }

  const adRows = [];
  for (const account of adAccounts) {
    const currentDisplay = await convertCurrency(num(account.current_balance), account.currency, displayCurrency);
    const targetDisplay = await convertCurrency(num(account.target_balance), account.currency, displayCurrency);
    const dailyDisplay = await convertCurrency(num(account.daily_spend), account.currency, displayCurrency);
    const topupDisplay = Math.max(0, targetDisplay - currentDisplay);
    const runwayDays = dailyDisplay > 0 ? currentDisplay / dailyDisplay : null;
    const scaledDailyDisplay = dailyDisplay * (1 + (num(settings.planning?.scale_percent, 20) / 100));
    const scaledTopupDisplay = Math.max(0, targetDisplay - currentDisplay + Math.max(0, scaledDailyDisplay - dailyDisplay) * num(settings.planning?.scale_buffer_days, 3));
    adRows.push({ ...account, currentDisplay, targetDisplay, dailyDisplay, topupDisplay, runwayDays, scaledDailyDisplay, scaledTopupDisplay });
  }

  const bankCash = bankCards.reduce((sum, bank) => sum + bank.balanceDisplay, 0);
  const pendingIncoming = enrichedPayouts.filter(p => p.status !== 'received').reduce((sum, p) => sum + p.netDisplay, 0);
  const supplierDue = supplierRows.filter(s => s.status !== 'paid').reduce((sum, s) => sum + s.amountDisplay, 0);
  const adTopups = adRows.reduce((sum, a) => sum + a.topupDisplay, 0);
  const opexReserve = await convertCurrency(num(settings.opex?.reserve_amount), settings.opex?.currency || displayCurrency, displayCurrency);
  const obligations = supplierDue + adTopups + opexReserve;
  const netPosition = bankCash + pendingIncoming - obligations;

  const scaleExtraNeeded = adRows.reduce((sum, a) => sum + Math.max(0, a.scaledTopupDisplay - a.topupDisplay), 0);
  const netAfterScale = netPosition - scaleExtraNeeded;
  const ownerTargetDisplay = await convertCurrency(num(settings.owner_draw?.target_amount), settings.owner_draw?.currency || displayCurrency, displayCurrency);
  const netAfterOwnerDraw = netPosition - ownerTargetDisplay;

  return {
    displayCurrency,
    bankCards,
    enrichedPayouts,
    supplierRows,
    adRows,
    totals: {
      bankCash,
      pendingIncoming,
      supplierDue,
      adTopups,
      opexReserve,
      obligations,
      netPosition,
      scaleExtraNeeded,
      netAfterScale,
      ownerTargetDisplay,
      netAfterOwnerDraw
    }
  };
}

export function forecastPayouts(enrichedPayouts, days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(today.getDate() + Number(days || 7));

  return enrichedPayouts.filter(payout => {
    if (payout.status === 'received' || !payout.expected_date) return false;
    const expected = new Date(`${payout.expected_date}T00:00:00`);
    return expected >= today && expected <= end;
  });
}

export function scaleVerdict({ roas3d, threshold, netAfterScale }) {
  const roasOk = num(roas3d) >= num(threshold);
  const cashOk = num(netAfterScale) >= 0;

  if (roasOk && cashOk) return { level: 'good', text: 'Good to scale based on ROAS and cash position.' };
  if (!roasOk && cashOk) return { level: 'warn', text: 'Cash can support it, but ROAS is not strong enough yet.' };
  if (roasOk && !cashOk) return { level: 'bad', text: 'ROAS is good, but cash position is too tight.' };
  return { level: 'bad', text: 'Do not scale yet. ROAS and cash position both need work.' };
}
