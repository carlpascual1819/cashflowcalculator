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

export function addBusinessDays(startDate, businessDays) {
  const date = new Date(startDate);
  date.setHours(0, 0, 0, 0);
  let remaining = Math.max(1, Math.round(num(businessDays, 5)));
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date;
}

export function dateOnly(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function daysBetween(startDate, endDate) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);
  return Math.max(1, Math.ceil((end - start) / 86400000));
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

export function getPlanningWindow(enrichedPayouts, settings) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const futureDates = enrichedPayouts
    .filter(p => p.status !== 'received')
    .map(p => dateOnly(p.expected_date))
    .filter(date => date && date >= today)
    .sort((a, b) => a - b);

  const nextPayoutDate = futureDates[0] || addBusinessDays(today, settings.payout_delay_business_days || 5);
  const autoCashflowDays = daysBetween(today, nextPayoutDate);

  return {
    today,
    nextPayoutDate,
    nextPayoutDateString: nextPayoutDate.toISOString().slice(0, 10),
    autoCashflowDays
  };
}

function payoutsWithinWindow(enrichedPayouts, today, days) {
  const end = new Date(today);
  end.setDate(end.getDate() + num(days, 7));
  return enrichedPayouts.filter(payout => {
    if (payout.status === 'received' || !payout.expected_date) return false;
    const expected = dateOnly(payout.expected_date);
    return expected && expected >= today && expected <= end;
  });
}

function buildWindowTotals({ days, today, enrichedPayouts, bankCash, adRows, supplierInputs, opexRows, ownerDrawTargetDisplay }) {
  const payoutRows = payoutsWithinWindow(enrichedPayouts, today, days);
  const pendingIncoming = payoutRows.reduce((sum, p) => sum + p.netDisplay, 0);
  const cashAvailable = bankCash + pendingIncoming;

  const projectedAdSpendDaily = adRows.reduce((sum, row) => sum + row.dailySpendDisplay, 0);
  const projectedAdSpendTotal = projectedAdSpendDaily * days;
  const forecastRevenueDailyDisplay = adRows.reduce((sum, row) => sum + row.dailyRevenueDisplay, 0);
  const forecastRevenueTotalDisplay = forecastRevenueDailyDisplay * days;

  const adTopups = adRows.reduce((sum, row) => sum + Math.max(0, row.dailySpendDisplay * days - row.currentDisplay), 0);
  const scaleExtraNeeded = adRows.reduce((sum, row) => row.roasOk ? sum + (row.dailySpendDisplay * row.scalePercentDecimal * days) : sum, 0);

  let expectedCogsTotal = 0;
  let supplierSend = 0;
  const supplierRows = supplierInputs.map(supplier => {
    const supplierRevenueBaseDisplay = forecastRevenueTotalDisplay * (supplier.revenueSharePercent / 100);
    const expectedCogsDisplay = supplierRevenueBaseDisplay * (supplier.cogsPercent / 100);
    const expectedCogsDailyDisplay = days > 0 ? expectedCogsDisplay / days : expectedCogsDisplay;
    const bufferDisplay = expectedCogsDisplay * (supplier.bufferPercent / 100);
    const requiredReserveDisplay = expectedCogsDisplay + bufferDisplay;
    const topupDisplay = Math.max(0, requiredReserveDisplay - supplier.balanceDisplay);
    expectedCogsTotal += expectedCogsDisplay;
    supplierSend += topupDisplay;
    return {
      ...supplier.raw,
      revenue_share_percent: supplier.revenueSharePercent,
      balanceDisplay: supplier.balanceDisplay,
      forecastRevenueDisplay: supplierRevenueBaseDisplay,
      expectedCogsDisplay,
      expectedCogsDailyDisplay,
      bufferDisplay,
      requiredReserveDisplay,
      topupDisplay
    };
  });

  const opexReserve = opexRows.reduce((sum, row) => sum + (forecastRevenueTotalDisplay * (num(row.amount) / 100)), 0);
  const opexDaily = days > 0 ? opexReserve / days : opexReserve;
  const requiredSends = supplierSend + adTopups + opexReserve;
  const cashAfterRequiredSends = cashAvailable - requiredSends;
  const theoreticalOwnerDraw = Math.max(0, cashAfterRequiredSends);
  const safeOwnerDraw = Math.max(0, Math.min(ownerDrawTargetDisplay, cashAfterRequiredSends));
  const remainingAfterOwnerDraw = cashAfterRequiredSends - safeOwnerDraw;

  const opexRowsForWindow = opexRows.map(row => {
    const amountForPeriodDisplay = forecastRevenueTotalDisplay * (num(row.amount) / 100);
    return {
      ...row,
      amountForPeriodDisplay,
      amountDailyDisplay: days > 0 ? amountForPeriodDisplay / days : amountForPeriodDisplay,
      subLabel: `${num(row.amount).toFixed(2)}% of projected revenue`
    };
  });

  const adRowsForWindow = adRows.map(row => ({
    ...row,
    funding_days: days,
    plannedSpendDisplay: row.dailySpendDisplay * days,
    projectedRevenueDisplay: row.dailyRevenueDisplay * days,
    topupDisplay: Math.max(0, row.dailySpendDisplay * days - row.currentDisplay),
    scaleExtraDisplay: row.roasOk ? row.dailySpendDisplay * row.scalePercentDecimal * days : 0
  }));

  return {
    days,
    payoutRows,
    pendingIncoming,
    cashAvailable,
    supplierRows,
    adRows: adRowsForWindow,
    opexRows: opexRowsForWindow,
    projectedAdSpendDaily,
    projectedAdSpendTotal,
    forecastRevenueDailyDisplay,
    forecastRevenueTotalDisplay,
    expectedCogsDaily: days > 0 ? expectedCogsTotal / days : expectedCogsTotal,
    expectedCogsTotal,
    supplierSend,
    adTopups,
    opexReserve,
    opexDaily,
    requiredSends,
    scaleExtraNeeded,
    cashAfterRequiredSends,
    theoreticalOwnerDraw,
    safeOwnerDraw,
    remainingAfterOwnerDraw
  };
}

export async function calculateDashboard({ banks, payouts, suppliers, adAccounts, opexItems, settings }) {
  const displayCurrency = settings.display_currency || 'USD';
  const scalePercent = num(settings.scale_percent, 20);
  const roasThreshold = num(settings.roas_threshold, 1.8);
  const ownerDrawTargetDisplay = await convertCurrency(num(settings.owner_draw_target), settings.owner_draw_currency || displayCurrency, displayCurrency);

  const enrichedPayouts = [];
  for (const payout of payouts) enrichedPayouts.push(await enrichPayout(payout, displayCurrency));

  const planningWindow = getPlanningWindow(enrichedPayouts, settings);
  const selectedDays = settings.projection_days === 'auto'
    ? planningWindow.autoCashflowDays
    : Math.max(1, Math.round(num(settings.projection_days, 7)));

  const bankRows = [];
  for (const bank of banks) {
    const balanceDisplay = await convertCurrency(num(bank.balance), bank.currency, displayCurrency);
    const incomingDisplay = enrichedPayouts
      .filter(p => p.destination_bank_id === bank.id && p.status !== 'received')
      .reduce((sum, p) => sum + p.netDisplay, 0);
    bankRows.push({ ...bank, balanceDisplay, incomingDisplay, projectedDisplay: balanceDisplay + incomingDisplay });
  }
  const bankCash = bankRows.reduce((sum, bank) => sum + bank.balanceDisplay, 0);

  const adRowsBase = [];
  for (const ad of adAccounts) {
    const currentNative = num(ad.current_balance);
    const dailyNative = num(ad.daily_spend);
    const roas = num(ad.roas_3d);
    const currentDisplay = await convertCurrency(currentNative, ad.currency, displayCurrency);
    const dailySpendDisplay = await convertCurrency(dailyNative, ad.currency, displayCurrency);
    const dailyRevenueDisplay = dailySpendDisplay * roas;
    const runwayDays = dailyNative > 0 ? currentNative / dailyNative : null;

    adRowsBase.push({
      ...ad,
      roas,
      roasOk: roas >= roasThreshold,
      scalePercentDecimal: scalePercent / 100,
      currentDisplay,
      dailySpendDisplay,
      dailyRevenueDisplay,
      runwayDays
    });
  }

  const supplierInputs = [];
  for (const supplier of suppliers) {
    supplierInputs.push({
      raw: supplier,
      balanceDisplay: await convertCurrency(num(supplier.current_balance), supplier.currency, displayCurrency),
      revenueSharePercent: num(supplier.revenue_share_percent, 100),
      cogsPercent: num(supplier.cogs_percent),
      bufferPercent: num(supplier.buffer_percent)
    });
  }

  const opexRowsBase = (opexItems || []).map(item => ({
    ...item,
    calculation_mode: 'percent_of_revenue',
    amount: num(item.amount)
  }));

  const selected = buildWindowTotals({
    days: selectedDays,
    today: planningWindow.today,
    enrichedPayouts,
    bankCash,
    adRows: adRowsBase,
    supplierInputs,
    opexRows: opexRowsBase,
    ownerDrawTargetDisplay
  });

  const opexPercentTotal = opexRowsBase.reduce((sum, row) => sum + num(row.amount), 0);
  const scenarioDays = Array.from(new Set([7, 14, 30, planningWindow.autoCashflowDays])).sort((a, b) => a - b);
  const scenarioRows = scenarioDays.map(days => {
    const row = buildWindowTotals({
      days,
      today: planningWindow.today,
      enrichedPayouts,
      bankCash,
      adRows: adRowsBase,
      supplierInputs,
      opexRows: opexRowsBase,
      ownerDrawTargetDisplay
    });
    return {
      days,
      cashAvailable: row.cashAvailable,
      revenue: row.forecastRevenueTotalDisplay,
      supplierSend: row.supplierSend,
      adTopups: row.adTopups,
      opexReserve: row.opexReserve,
      requiredSends: row.requiredSends,
      theoreticalOwnerDraw: row.theoreticalOwnerDraw,
      remainingAfterTargetDraw: row.cashAfterRequiredSends - Math.min(ownerDrawTargetDisplay, Math.max(0, row.cashAfterRequiredSends))
    };
  });

  const allPendingIncoming = enrichedPayouts.filter(p => p.status !== 'received').reduce((sum, p) => sum + p.netDisplay, 0);

  return {
    displayCurrency,
    cashflowDays: selectedDays,
    planningWindow,
    bankRows,
    enrichedPayouts,
    supplierRows: selected.supplierRows,
    adRows: selected.adRows,
    opexRows: selected.opexRows,
    scenarioRows,
    totals: {
      bankCash,
      pendingIncoming: selected.pendingIncoming,
      pendingIncomingAll: allPendingIncoming,
      cashAvailable: selected.cashAvailable,
      supplierSend: selected.supplierSend,
      adTopups: selected.adTopups,
      opexReserve: selected.opexReserve,
      opexDaily: selected.opexDaily,
      opexPercentTotal,
      requiredSends: selected.requiredSends,
      cashAfterRequiredSends: selected.cashAfterRequiredSends,
      forecastRevenueTotalDisplay: selected.forecastRevenueTotalDisplay,
      forecastRevenueDailyDisplay: selected.forecastRevenueDailyDisplay,
      forecastRevenueBasis: 'ad projection',
      projectedAdSpendDaily: selected.projectedAdSpendDaily,
      projectedAdSpendTotal: selected.projectedAdSpendTotal,
      expectedCogsDaily: selected.expectedCogsDaily,
      expectedCogsTotal: selected.expectedCogsTotal,
      scaleExtraNeeded: selected.scaleExtraNeeded,
      ownerDrawTargetDisplay,
      theoreticalOwnerDraw: selected.theoreticalOwnerDraw,
      safeOwnerDraw: selected.safeOwnerDraw,
      remainingAfterOwnerDraw: selected.remainingAfterOwnerDraw
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
