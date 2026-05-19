import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Banknote, CalendarDays, CreditCard, Database, Landmark, LogOut, Plus, RefreshCcw, Settings, Trash2, Wallet } from 'lucide-react';
import { hasSupabase, supabase } from './lib/supabase';
import { CURRENCIES, calculateDashboard, fmt, forecastPayouts, num, todayPlus, uid } from './lib/calc';
import './styles.css';

const LOCAL_KEY = 'cashflow_calculator_v4';

const seed = {
  banks: [{ id: 'bank-1', name: 'AW', currency: 'USD', balance: 0 }],
  payouts: [
    { id: 'payout-1', source: 'P1', currency: 'USD', gross_amount: 300, expected_date: todayPlus(1), destination_bank_id: 'bank-1', payout_conversion_fee_percent: 0, payout_transfer_fee_flat: 0, bank_conversion_fee_percent: 0, bank_receiving_fee_flat: 0, status: 'pending' }
  ],
  suppliers: [{ id: 'supplier-1', name: 'NSDL', currency: 'USD', current_balance: 0, forecast_revenue: 0, cogs_percent: 22, buffer_percent: 10 }],
  adAccounts: [{ id: 'ad-1', name: 'Ad1', platform: 'Meta', currency: 'USD', current_balance: 0, daily_spend: 0, funding_days: 3, roas_3d: 0 }],
  opexItems: [
    { id: 'opex-1', name: 'Payroll', amount: 0 },
    { id: 'opex-2', name: 'Subscriptions', amount: 0 },
    { id: 'opex-3', name: 'Misc', amount: 0 }
  ],
  settings: { display_currency: 'USD', cashflow_days: 7, scale_percent: 20, roas_threshold: 1.8, owner_draw_target: 500, owner_draw_currency: 'USD' }
};

function App() {
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState('snapshot');
  const [forecastDays, setForecastDays] = useState(7);
  const [expandedPayout, setExpandedPayout] = useState(seed.payouts[0].id);

  const [banks, setBanks] = useState(seed.banks);
  const [payouts, setPayouts] = useState(seed.payouts);
  const [suppliers, setSuppliers] = useState(seed.suppliers);
  const [adAccounts, setAdAccounts] = useState(seed.adAccounts);
  const [opexItems, setOpexItems] = useState(seed.opexItems);
  const [settings, setSettings] = useState(seed.settings);
  const [dashboard, setDashboard] = useState(null);

  useEffect(() => {
    if (!hasSupabase) {
      loadLocal();
      return;
    }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (hasSupabase && session) loadRemote();
  }, [session]);

  useEffect(() => {
    let live = true;
    calculateDashboard({ banks, payouts, suppliers, adAccounts, opexItems, settings })
      .then(result => { if (live) setDashboard(result); })
      .catch(err => setMessage(err.message));
    return () => { live = false; };
  }, [banks, payouts, suppliers, adAccounts, opexItems, settings]);

  useEffect(() => {
    if (!hasSupabase) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ banks, payouts, suppliers, adAccounts, opexItems, settings }));
    }
  }, [banks, payouts, suppliers, adAccounts, opexItems, settings]);

  function loadLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
      const data = saved || seed;
      setBanks(data.banks || seed.banks);
      setPayouts(data.payouts || seed.payouts);
      setSuppliers(data.suppliers || seed.suppliers);
      setAdAccounts(data.adAccounts || seed.adAccounts);
      setOpexItems(data.opexItems || seed.opexItems);
      setSettings(data.settings || seed.settings);
    } catch {
      setBanks(seed.banks);
      setPayouts(seed.payouts);
      setSuppliers(seed.suppliers);
      setAdAccounts(seed.adAccounts);
      setOpexItems(seed.opexItems);
      setSettings(seed.settings);
    }
  }

  async function loadRemote() {
    setBusy(true);
    setMessage('');
    try {
      const [b, p, s, a, o, st] = await Promise.all([
        supabase.from('banks').select('*').order('created_at'),
        supabase.from('pending_payouts').select('*').order('expected_date'),
        supabase.from('supplier_plans').select('*').order('created_at'),
        supabase.from('ad_accounts').select('*').order('created_at'),
        supabase.from('opex_items').select('*').order('created_at'),
        supabase.from('cashflow_settings').select('*').maybeSingle()
      ]);
      for (const result of [b, p, s, a, o, st]) if (result.error) throw result.error;
      setBanks(b.data || []);
      setPayouts(p.data || []);
      setSuppliers(s.data || []);
      setAdAccounts(a.data || []);
      setOpexItems(o.data || []);
      if (st.data) setSettings(normalizeSettings(st.data));
      else await saveSettings(seed.settings);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function normalizeSettings(row) {
    return {
      display_currency: row.display_currency || 'USD',
      cashflow_days: row.cashflow_days ?? 7,
      scale_percent: row.scale_percent ?? 20,
      roas_threshold: row.roas_threshold ?? 1.8,
      owner_draw_target: row.owner_draw_target ?? 0,
      owner_draw_currency: row.owner_draw_currency || row.display_currency || 'USD'
    };
  }

  async function handleAuth(e) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const fn = authMode === 'signUp' ? supabase.auth.signUp : supabase.auth.signInWithPassword;
      const { error } = await fn.call(supabase.auth, { email, password });
      if (error) throw error;
      setMessage(authMode === 'signUp' ? 'Account created. Check email if confirmation is on.' : 'Signed in.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(nextSettings) {
    setSettings(nextSettings);
    if (!hasSupabase || !session) return;
    const { error } = await supabase.from('cashflow_settings').upsert({ ...nextSettings, user_id: session.user.id }, { onConflict: 'user_id' });
    if (error) setMessage(error.message);
  }

  async function insertRow(table, row, setter) {
    if (hasSupabase && session) {
      const { id, ...remoteRow } = row;
      const { data, error } = await supabase.from(table).insert({ ...remoteRow, user_id: session.user.id }).select().single();
      if (error) return setMessage(error.message);
      setter(prev => [...prev, data]);
    } else setter(prev => [...prev, row]);
  }

  async function updateRow(table, id, patch, setter) {
    setter(prev => prev.map(item => item.id === id ? { ...item, ...patch } : item));
    if (hasSupabase && session) {
      const { error } = await supabase.from(table).update(patch).eq('id', id);
      if (error) setMessage(error.message);
    }
  }

  async function deleteRow(table, id, setter) {
    setter(prev => prev.filter(item => item.id !== id));
    if (hasSupabase && session) {
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) setMessage(error.message);
    }
  }

  const forecastRows = useMemo(() => forecastPayouts(dashboard?.enrichedPayouts || [], forecastDays), [dashboard, forecastDays]);
  const forecastIncoming = forecastRows.reduce((sum, p) => sum + p.netDisplay, 0);

  if (hasSupabase && !session) {
    return <AuthPage authMode={authMode} setAuthMode={setAuthMode} email={email} setEmail={setEmail} password={password} setPassword={setPassword} busy={busy} message={message} onSubmit={handleAuth} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Cashflow Calculator v4</div>
          <h1>Calculates supplier sends, ad top-ups, OPEX by percentage, and safe owner draw.</h1>
        </div>
        <div className="top-actions">
          <button className="ghost" onClick={hasSupabase ? loadRemote : loadLocal}><RefreshCcw size={16} /> Reload</button>
          {hasSupabase && <button className="ghost" onClick={() => supabase.auth.signOut()}><LogOut size={16} /> Sign out</button>}
        </div>
      </header>

      {message && <div className="notice">{message}</div>}

      <nav className="tabs">
        <button className={activeTab === 'snapshot' ? 'active' : ''} onClick={() => setActiveTab('snapshot')}>Snapshot</button>
        <button className={activeTab === 'inputs' ? 'active' : ''} onClick={() => setActiveTab('inputs')}>Inputs</button>
        <button className={activeTab === 'forecast' ? 'active' : ''} onClick={() => setActiveTab('forecast')}>Forecast</button>
        <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}><Settings size={16} /> Settings</button>
      </nav>

      {activeTab === 'snapshot' && dashboard && (
        <main>
          <section className="summary-grid">
            <Summary title="Bank Cash" value={fmt(dashboard.totals.bankCash, dashboard.displayCurrency)} icon={<Landmark />} />
            <Summary title="Pending Incoming" value={fmt(dashboard.totals.pendingIncoming, dashboard.displayCurrency)} icon={<Wallet />} />
            <Summary title="Cash Available" value={fmt(dashboard.totals.cashAvailable, dashboard.displayCurrency)} icon={<Banknote />} tone="good" />
            <Summary title="Required Sends" value={fmt(dashboard.totals.requiredSends, dashboard.displayCurrency)} icon={<CreditCard />} tone="warn" />
          </section>

          <section className="decision-grid">
            <Panel title="Cash Decision">
              <Metric label="Projected cash available" value={fmt(dashboard.totals.cashAvailable, dashboard.displayCurrency)} />
              <Metric label="Send to supplier" value={fmt(dashboard.totals.supplierSend, dashboard.displayCurrency)} />
              <Metric label="Top up ad accounts" value={fmt(dashboard.totals.adTopups, dashboard.displayCurrency)} />
              <Metric label="Reserve for OPEX" value={fmt(dashboard.totals.opexReserve, dashboard.displayCurrency)} />
              <Metric label="Total OPEX %" value={`${num(dashboard.totals.opexPercentTotal).toFixed(2)}%`} />
              <Metric label="Forecast revenue base" value={fmt(dashboard.totals.forecastRevenueTotalDisplay, dashboard.displayCurrency)} />
              <Metric label="Cash after required sends" value={fmt(dashboard.totals.cashAfterRequiredSends, dashboard.displayCurrency)} />
              <div className={`verdict ${dashboard.totals.cashAfterRequiredSends >= 0 ? 'good' : 'bad'}`}>
                {dashboard.totals.cashAfterRequiredSends >= 0 ? 'Cash covers supplier, ads, and OPEX.' : 'Cash is short before owner draw.'}
              </div>
            </Panel>

            <Panel title="Owner Draw">
              <Metric label="Target owner draw" value={fmt(dashboard.totals.ownerDrawTargetDisplay, dashboard.displayCurrency)} />
              <Metric label="Safe owner draw now" value={fmt(dashboard.totals.safeOwnerDraw, dashboard.displayCurrency)} />
              <Metric label="Remaining business cash" value={fmt(dashboard.totals.remainingAfterOwnerDraw, dashboard.displayCurrency)} />
              <div className={`verdict ${dashboard.totals.safeOwnerDraw >= dashboard.totals.ownerDrawTargetDisplay ? 'good' : 'warn'}`}>
                {dashboard.totals.safeOwnerDraw >= dashboard.totals.ownerDrawTargetDisplay ? 'Target draw is safe.' : 'Take less or wait for more cash.'}
              </div>
            </Panel>
          </section>

          <section className="three-col">
            <Panel title="Supplier Send Needed">
              {dashboard.supplierRows.map(s => <MiniRow key={s.id} title={s.name} value={fmt(s.topupDisplay, dashboard.displayCurrency)} sub={`COGS ${num(s.cogs_percent).toFixed(1)}% | Balance ${fmt(s.balanceDisplay, dashboard.displayCurrency)}`} tone={s.topupDisplay > 0 ? 'bad' : 'good'} />)}
            </Panel>
            <Panel title="Ad Top-up Needed">
              {dashboard.adRows.map(a => <MiniRow key={a.id} title={a.name} value={fmt(a.topupDisplay, dashboard.displayCurrency)} sub={`${a.funding_days} days funded | Runway ${a.runwayDays === null ? 'n/a' : a.runwayDays.toFixed(1)} days | ROAS ${num(a.roas_3d).toFixed(2)}x`} tone={a.topupDisplay > 0 ? 'bad' : 'good'} />)}
            </Panel>
            <Panel title="OPEX Reserve Needed">
              {dashboard.opexRows.map(o => <MiniRow key={o.id} title={o.name} value={fmt(o.amountForPeriodDisplay, dashboard.displayCurrency)} sub={o.subLabel} />)}
            </Panel>
          </section>
        </main>
      )}

      {activeTab === 'inputs' && dashboard && (
        <main className="settings-grid">
          <SettingsPanel title="Banks" action={<AddButton onClick={() => insertRow('banks', { id: uid('bank'), name: 'New Bank', currency: settings.display_currency, balance: 0 }, setBanks)} />}>
            {banks.map(bank => <EditableBank key={bank.id} bank={bank} update={patch => updateRow('banks', bank.id, patch, setBanks)} remove={() => deleteRow('banks', bank.id, setBanks)} />)}
          </SettingsPanel>

          <SettingsPanel title="Payouts" action={<AddButton onClick={() => insertRow('pending_payouts', { id: uid('payout'), source: 'New Payout', currency: settings.display_currency, gross_amount: 0, expected_date: todayPlus(2), destination_bank_id: banks[0]?.id || null, payout_conversion_fee_percent: 0, payout_transfer_fee_flat: 0, bank_conversion_fee_percent: 0, bank_receiving_fee_flat: 0, status: 'pending' }, setPayouts)} />}>
            {dashboard.enrichedPayouts.map(payout => (
              <div className="payout-card" key={payout.id}>
                <button className="row-button" onClick={() => setExpandedPayout(expandedPayout === payout.id ? '' : payout.id)}>
                  <span><strong>{payout.source}</strong><small>{payout.expected_date || 'No date'} to {banks.find(b => b.id === payout.destination_bank_id)?.name || 'No bank'}</small></span>
                  <b>{fmt(payout.netDisplay, dashboard.displayCurrency)}</b>
                </button>
                {expandedPayout === payout.id && <PayoutEditor payout={payout} banks={banks} update={(patch) => updateRow('pending_payouts', payout.id, patch, setPayouts)} remove={() => deleteRow('pending_payouts', payout.id, setPayouts)} displayCurrency={dashboard.displayCurrency} />}
              </div>
            ))}
          </SettingsPanel>

          <SettingsPanel title="Supplier Planning" action={<AddButton onClick={() => insertRow('supplier_plans', { id: uid('supplier'), name: 'New Supplier', currency: settings.display_currency, current_balance: 0, forecast_revenue: 0, cogs_percent: 22, buffer_percent: 10 }, setSuppliers)} />}>
            {suppliers.map(supplier => <EditableSupplier key={supplier.id} supplier={supplier} update={patch => updateRow('supplier_plans', supplier.id, patch, setSuppliers)} remove={() => deleteRow('supplier_plans', supplier.id, setSuppliers)} />)}
          </SettingsPanel>

          <SettingsPanel title="Ad Planning" action={<AddButton onClick={() => insertRow('ad_accounts', { id: uid('ad'), name: 'New Ad Account', platform: 'Meta', currency: settings.display_currency, current_balance: 0, daily_spend: 0, funding_days: settings.cashflow_days, roas_3d: 0 }, setAdAccounts)} />}>
            {adAccounts.map(account => <EditableAdAccount key={account.id} account={account} update={patch => updateRow('ad_accounts', account.id, patch, setAdAccounts)} remove={() => deleteRow('ad_accounts', account.id, setAdAccounts)} />)}
          </SettingsPanel>

          <SettingsPanel title="OPEX Percentages" action={<AddButton onClick={() => insertRow('opex_items', { id: uid('opex'), name: 'New OPEX Bucket', amount: 0, currency: settings.display_currency, period: 'one_time', calculation_mode: 'percent_of_revenue' }, setOpexItems)} />}>
            {opexItems.map(item => <EditableOpex key={item.id} item={item} update={patch => updateRow('opex_items', item.id, patch, setOpexItems)} remove={() => deleteRow('opex_items', item.id, setOpexItems)} />)}
          </SettingsPanel>
        </main>
      )}

      {activeTab === 'forecast' && dashboard && (
        <main>
          <section className="panel wide">
            <div className="panel-head">
              <h2>Forecasted Payouts</h2>
              <div className="segmented">{[7, 14, 30].map(days => <button key={days} className={forecastDays === days ? 'active' : ''} onClick={() => setForecastDays(days)}>{days}d</button>)}</div>
            </div>
            <div className="forecast-total">Expected landed cash: {fmt(forecastIncoming, dashboard.displayCurrency)}</div>
            <div className="table">
              <div className="table-head"><span>Source</span><span>Date</span><span>Bank</span><span>Net</span></div>
              {forecastRows.map(p => <div className="table-row" key={p.id}><span>{p.source}</span><span>{p.expected_date}</span><span>{banks.find(b => b.id === p.destination_bank_id)?.name || '-'}</span><span>{fmt(p.netDisplay, dashboard.displayCurrency)}</span></div>)}
              {!forecastRows.length && <div className="empty">No pending payouts in this period.</div>}
            </div>
          </section>
        </main>
      )}

      {activeTab === 'settings' && dashboard && (
        <main className="settings-grid compact">
          <SettingsPanel title="Global Settings">
            <Field label="Display currency" type="select" value={settings.display_currency} onChange={v => saveSettings({ ...settings, display_currency: v })} options={CURRENCIES} />
            <Field label="Cashflow days" value={settings.cashflow_days} onChange={v => saveSettings({ ...settings, cashflow_days: v })} />
            <Field label="Scale percent" value={settings.scale_percent} onChange={v => saveSettings({ ...settings, scale_percent: v })} />
            <Field label="ROAS threshold" value={settings.roas_threshold} onChange={v => saveSettings({ ...settings, roas_threshold: v })} />
            <Field label="Owner draw target" value={settings.owner_draw_target} onChange={v => saveSettings({ ...settings, owner_draw_target: v })} />
            <Field label="Owner draw currency" type="select" value={settings.owner_draw_currency} onChange={v => saveSettings({ ...settings, owner_draw_currency: v })} options={CURRENCIES} />
          </SettingsPanel>
        </main>
      )}

      {busy && <div className="loading">Loading...</div>}
    </div>
  );
}

function AuthPage({ authMode, setAuthMode, email, setEmail, password, setPassword, busy, message, onSubmit }) {
  return <div className="auth-wrap"><form className="auth-card" onSubmit={onSubmit}><Database size={28} /><h1>Cashflow Calculator</h1><p>Sign in to sync with Supabase. Without env vars, it uses browser storage.</p><input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} /><input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} /><button disabled={busy}>{authMode === 'signUp' ? 'Create account' : 'Sign in'}</button><button type="button" className="link-button" onClick={() => setAuthMode(authMode === 'signUp' ? 'signIn' : 'signUp')}>{authMode === 'signUp' ? 'Use existing account' : 'Create a new account'}</button>{message && <div className="notice">{message}</div>}</form></div>;
}

function Summary({ title, value, icon, tone = 'neutral' }) {
  return <div className={`summary-card ${tone}`}><div>{icon}</div><span>{title}</span><strong>{value}</strong></div>;
}
function Panel({ title, action, children }) { return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>; }
function SettingsPanel({ title, action, children }) { return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div><div className="settings-stack">{children}</div></section>; }
function AddButton({ onClick }) { return <button className="icon-btn" onClick={onClick}><Plus size={16} /></button>; }
function Field({ label, value, onChange, type = 'number', options }) { return <label className="field"><span>{label}</span>{type === 'select' ? <select value={value ?? ''} onChange={e => onChange(e.target.value)}>{options.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} />}</label>; }
function TextField({ label, value, onChange, type = 'text' }) { return <label className="field"><span>{label}</span><input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} /></label>; }
function MiniRow({ title, value, sub, tone = 'neutral' }) { return <div className={`mini-row ${tone}`}><div><strong>{title}</strong><small>{sub}</small></div><b>{value}</b></div>; }
function Metric({ label, value }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function PayoutEditor({ payout, banks, update, remove, displayCurrency }) {
  return <div className="editor-grid"><TextField label="Source" value={payout.source} onChange={v => update({ source: v })} /><Field label="Currency" type="select" value={payout.currency} onChange={v => update({ currency: v })} options={CURRENCIES} /><Field label="Gross amount" value={payout.gross_amount} onChange={v => update({ gross_amount: v })} /><TextField label="Expected date" type="date" value={payout.expected_date || ''} onChange={v => update({ expected_date: v })} /><label className="field"><span>Destination bank</span><select value={payout.destination_bank_id || ''} onChange={e => update({ destination_bank_id: e.target.value })}>{banks.map(bank => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select></label><label className="field"><span>Status</span><select value={payout.status || 'pending'} onChange={e => update({ status: e.target.value })}><option value="pending">Pending</option><option value="received">Received</option></select></label><Field label="Payout conversion %" value={payout.payout_conversion_fee_percent} onChange={v => update({ payout_conversion_fee_percent: v })} /><Field label="Payout transfer flat" value={payout.payout_transfer_fee_flat} onChange={v => update({ payout_transfer_fee_flat: v })} /><Field label="Bank conversion %" value={payout.bank_conversion_fee_percent} onChange={v => update({ bank_conversion_fee_percent: v })} /><Field label="Bank receiving flat" value={payout.bank_receiving_fee_flat} onChange={v => update({ bank_receiving_fee_flat: v })} /><div className="fee-box"><Metric label="Gross" value={fmt(payout.grossDisplay, displayCurrency)} /><Metric label="Total fees" value={fmt(payout.totalFeesDisplay, displayCurrency)} /><Metric label="Net landed" value={fmt(payout.netDisplay, displayCurrency)} /></div><button className="danger" onClick={remove}><Trash2 size={15} /> Delete payout</button></div>;
}
function EditableBank({ bank, update, remove }) { return <div className="edit-card"><TextField label="Name" value={bank.name} onChange={v => update({ name: v })} /><Field label="Currency" type="select" value={bank.currency} onChange={v => update({ currency: v })} options={CURRENCIES} /><Field label="Current bank balance" value={bank.balance} onChange={v => update({ balance: v })} /><button className="danger" onClick={remove}><Trash2 size={15} /> Delete</button></div>; }
function EditableSupplier({ supplier, update, remove }) { return <div className="edit-card"><TextField label="Supplier name" value={supplier.name} onChange={v => update({ name: v })} /><Field label="Currency" type="select" value={supplier.currency} onChange={v => update({ currency: v })} options={CURRENCIES} /><Field label="Current supplier balance" value={supplier.current_balance} onChange={v => update({ current_balance: v })} /><Field label="Forecast revenue" value={supplier.forecast_revenue} onChange={v => update({ forecast_revenue: v })} /><Field label="COGS %" value={supplier.cogs_percent} onChange={v => update({ cogs_percent: v })} /><Field label="Buffer %" value={supplier.buffer_percent} onChange={v => update({ buffer_percent: v })} /><button className="danger" onClick={remove}><Trash2 size={15} /> Delete</button></div>; }
function EditableAdAccount({ account, update, remove }) { return <div className="edit-card"><TextField label="Name" value={account.name} onChange={v => update({ name: v })} /><Field label="Currency" type="select" value={account.currency} onChange={v => update({ currency: v })} options={CURRENCIES} /><Field label="Current balance" value={account.current_balance} onChange={v => update({ current_balance: v })} /><Field label="Daily spend" value={account.daily_spend} onChange={v => update({ daily_spend: v })} /><Field label="Days to fund" value={account.funding_days} onChange={v => update({ funding_days: v })} /><Field label="3D ROAS" value={account.roas_3d} onChange={v => update({ roas_3d: v })} /><button className="danger" onClick={remove}><Trash2 size={15} /> Delete</button></div>; }
function EditableOpex({ item, update, remove }) {
  return <div className="edit-card">
    <TextField label="OPEX bucket" value={item.name} onChange={v => update({ name: v })} />
    <Field label="OPEX % of forecast revenue" value={item.amount} onChange={v => update({ amount: v, calculation_mode: 'percent_of_revenue' })} />
    <button className="danger" onClick={remove}><Trash2 size={15} /> Delete</button>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
