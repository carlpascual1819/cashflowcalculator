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

export function todayPlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function enrichPayout(payout, displayCurrency) {
  const grossNative = num(payout.gross_amount);
  const payoutConversionFeeNative = grossNative * (num(payout.payout_conversion_fee_percent) / 100);
  const payoutTransferFeeNative = num(payout.payout_transfer_fee_flat);
  const bankConversionFeeNative = grossNative * (num(payout.bank_conversion_fee_percent) / 100);
  const bankReceivingFeeNative = num(payout.bank_receiving_fee_flat);
  const totalFeesNative = payoutConversionFeeNative + payoutTransferFeeNative + bankConversionFeeNative + bankReceivingFeeNative;
  const netNative = Math.max(0, grossNative - totalFeesNative);

  return {
    ...payout,
    grossNative,
    totalFeesNative,
    netNative,
    grossDisplay: await convertCurrency(grossNative, payout.currency, displayCurrency),
    totalFeesDisplay: await convertCurrency(totalFeesNative, payout.currency, displayCurrency),
    netDisplay: await convertCurrency(netNative, payout.currency, displayCurrency)
  };
}

export async function calculateDashboard({ banks, payouts, suppliers, adAccounts, opexItems, settings }) {
  const displayCurrency = settings.display_currency || 'USD';
  const cashflowDays = num(settings.cashflow_days, 7);
  const scalePercent = num(settings.scale_percent, 20);
  const roasThreshold = num(settings.roas_threshold, 1.8);
  const ownerDrawTargetDisplay = await convertCurrency(num(settings.owner_draw_target), settings.owner_draw_currency || displayCurrency, displayCurrency);

  const enrichedPayouts = [];
  for (const payout of payouts) enrichedPayouts.push(await enrichPayout(payout, displayCurrency));

  const bankRows = [];
  for (const bank of banks) {
    const balanceDisplay = await convertCurrency(num(bank.balance), bank.currency, displayCurrency);
    const incomingDisplay = enrichedPayouts
      .filter(p => p.destination_bank_id === bank.id && p.status !== 'received')
      .reduce((sum, p) => sum + p.netDisplay, 0);
    bankRows.push({ ...bank, balanceDisplay, incomingDisplay, projectedDisplay: balanceDisplay + incomingDisplay });
  }

  const supplierRows = [];
  for (const supplier of suppliers) {
    const balanceNative = num(supplier.current_balance);
    const revenueNative = num(supplier.forecast_revenue);
    const cogsPercent = num(supplier.cogs_percent);
    const bufferPercent = num(supplier.buffer_percent);
    const expectedCogsNative = revenueNative * (cogsPercent / 100);
    const bufferNative = expectedCogsNative * (bufferPercent / 100);
    const requiredReserveNative = expectedCogsNative + bufferNative;
    const topupNative = Math.max(0, requiredReserveNative - balanceNative);
    supplierRows.push({
      ...supplier,
      balanceDisplay: await convertCurrency(balanceNative, supplier.currency, displayCurrency),
      forecastRevenueDisplay: await convertCurrency(revenueNative, supplier.currency, displayCurrency),
      expectedCogsDisplay: await convertCurrency(expectedCogsNative, supplier.currency, displayCurrency),
      bufferDisplay: await convertCurrency(bufferNative, supplier.currency, displayCurrency),
      requiredReserveDisplay: await convertCurrency(requiredReserveNative, supplier.currency, displayCurrency),
      topupDisplay: await convertCurrency(topupNative, supplier.currency, displayCurrency)
    });
  }

  const adRows = [];
  for (const ad of adAccounts) {
    const currentNative = num(ad.current_balance);
    const dailyNative = num(ad.daily_spend);
    const fundingDays = num(ad.funding_days, cashflowDays);
    const roasOk = num(ad.roas_3d) >= roasThreshold;
    const plannedDailyNative = roasOk ? dailyNative * (1 + scalePercent / 100) : dailyNative;
    const requiredReserveNative = plannedDailyNative * fundingDays;
    const topupNative = Math.max(0, requiredReserveNative - currentNative);
    const runwayDays = dailyNative > 0 ? currentNative / dailyNative : null;
    adRows.push({
      ...ad,
      roasOk,
      runwayDays,
      plannedDailyDisplay: await convertCurrency(plannedDailyNative, ad.currency, displayCurrency),
      currentDisplay: await convertCurrency(currentNative, ad.currency, displayCurrency),
      dailySpendDisplay: await convertCurrency(dailyNative, ad.currency, displayCurrency),
      requiredReserveDisplay: await convertCurrency(requiredReserveNative, ad.currency, displayCurrency),
      topupDisplay: await convertCurrency(topupNative, ad.currency, displayCurrency)
    });
  }

  const forecastRevenueTotalDisplay = supplierRows.reduce((sum, row) => sum + row.forecastRevenueDisplay, 0);

  const opexRows = [];
  for (const item of opexItems) {
    const percent = num(item.amount);
    const amountForPeriodDisplay = forecastRevenueTotalDisplay * (percent / 100);
    opexRows.push({
      ...item,
      calculation_mode: 'percent_of_revenue',
      amountForPeriodDisplay,
      subLabel: `${percent.toFixed(2)}% of forecast revenue`
    });
  }

  const bankCash = bankRows.reduce((sum, bank) => sum + bank.balanceDisplay, 0);
  const pendingIncoming = enrichedPayouts.filter(p => p.status !== 'received').reduce((sum, p) => sum + p.netDisplay, 0);
  const cashAvailable = bankCash + pendingIncoming;
  const supplierSend = supplierRows.reduce((sum, row) => sum + row.topupDisplay, 0);
  const adTopups = adRows.reduce((sum, row) => sum + row.topupDisplay, 0);
  const opexReserve = opexRows.reduce((sum, row) => sum + row.amountForPeriodDisplay, 0);
  const opexPercentTotal = opexRows.reduce((sum, row) => sum + num(row.amount), 0);
  const requiredSends = supplierSend + adTopups + opexReserve;
  const cashAfterRequiredSends = cashAvailable - requiredSends;
  const safeOwnerDraw = Math.max(0, Math.min(ownerDrawTargetDisplay, cashAfterRequiredSends));
  const remainingAfterOwnerDraw = cashAfterRequiredSends - safeOwnerDraw;

  return {
    displayCurrency,
    cashflowDays,
    bankRows,
    enrichedPayouts,
    supplierRows,
    adRows,
    opexRows,
    totals: {
      bankCash,
      pendingIncoming,
      cashAvailable,
      supplierSend,
      adTopups,
      opexReserve,
      opexPercentTotal,
      requiredSends,
      cashAfterRequiredSends,
      forecastRevenueTotalDisplay,
      ownerDrawTargetDisplay,
      safeOwnerDraw,
      remainingAfterOwnerDraw
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
