import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Banknote, Calculator, CalendarDays, CreditCard, Database, Landmark, LogOut, Plus, RefreshCcw, Settings, Trash2, TrendingUp, Wallet } from 'lucide-react';
import { hasSupabase, supabase } from './lib/supabase';
import { CURRENCIES, calculateDashboard, fmt, forecastPayouts, num, scaleVerdict, uid } from './lib/calc';
import './styles.css';

const LOCAL_KEY = 'cashflow_calculator_v1';

const seed = {
  banks: [
    { id: 'bank-1', name: 'HKD Operating Bank', currency: 'HKD', balance: 50000, notes: 'Main bank' },
    { id: 'bank-2', name: 'USD Reserve Bank', currency: 'USD', balance: 3500, notes: 'Reserve' }
  ],
  payouts: [
    { id: 'payout-1', source: 'Shopify UK', currency: 'GBP', gross_amount: 4200, expected_date: todayPlus(2), destination_bank_id: 'bank-1', payout_conversion_fee_percent: 1.5, payout_transfer_fee_flat: 0, bank_conversion_fee_percent: 0.5, bank_receiving_fee_flat: 35, status: 'pending', notes: '' },
    { id: 'payout-2', source: 'Stripe US', currency: 'USD', gross_amount: 1800, expected_date: todayPlus(4), destination_bank_id: 'bank-2', payout_conversion_fee_percent: 0, payout_transfer_fee_flat: 0, bank_conversion_fee_percent: 0, bank_receiving_fee_flat: 0, status: 'pending', notes: '' }
  ],
  suppliers: [
    { id: 'supplier-1', name: 'NSDL', currency: 'USD', amount_due: 4500, due_date: todayPlus(3), status: 'open', notes: 'Supplier payment reserve' }
  ],
  adAccounts: [
    { id: 'ad-1', name: 'NOVA UK', platform: 'Meta', currency: 'USD', current_balance: 900, target_balance: 2500, daily_spend: 650, roas_3d: 2.1, notes: '' },
    { id: 'ad-2', name: 'NOVA US', platform: 'Meta', currency: 'USD', current_balance: 1200, target_balance: 3000, daily_spend: 750, roas_3d: 1.55, notes: '' }
  ],
  settings: {
    display_currency: 'USD',
    opex: { reserve_amount: 2000, currency: 'USD', label: 'Payroll, tools, fixed expenses' },
    planning: { scale_percent: 20, roas_threshold: 1.8, scale_buffer_days: 3 },
    owner_draw: { target_amount: 500, currency: 'USD' }
  }
};

function todayPlus(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function App() {
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState('snapshot');
  const [forecastDays, setForecastDays] = useState(7);
  const [expandedPayout, setExpandedPayout] = useState('payout-1');

  const [banks, setBanks] = useState(seed.banks);
  const [payouts, setPayouts] = useState(seed.payouts);
  const [suppliers, setSuppliers] = useState(seed.suppliers);
  const [adAccounts, setAdAccounts] = useState(seed.adAccounts);
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
    calculateDashboard({ banks, payouts, suppliers, adAccounts, settings })
      .then(result => { if (live) setDashboard(result); })
      .catch(err => setMessage(err.message));
    return () => { live = false; };
  }, [banks, payouts, suppliers, adAccounts, settings]);

  useEffect(() => {
    if (!hasSupabase) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ banks, payouts, suppliers, adAccounts, settings }));
    }
  }, [banks, payouts, suppliers, adAccounts, settings]);

  function loadLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
      const data = saved || seed;
      setBanks(data.banks || seed.banks);
      setPayouts(data.payouts || seed.payouts);
      setSuppliers(data.suppliers || seed.suppliers);
      setAdAccounts(data.adAccounts || seed.adAccounts);
      setSettings(data.settings || seed.settings);
    } catch {
      setBanks(seed.banks);
      setPayouts(seed.payouts);
      setSuppliers(seed.suppliers);
      setAdAccounts(seed.adAccounts);
      setSettings(seed.settings);
    }
  }

  async function loadRemote() {
    setBusy(true);
    setMessage('');
    try {
      const [b, p, s, a, st] = await Promise.all([
        supabase.from('banks').select('*').order('created_at'),
        supabase.from('pending_payouts').select('*').order('expected_date'),
        supabase.from('supplier_obligations').select('*').order('due_date'),
        supabase.from('ad_accounts').select('*').order('created_at'),
        supabase.from('cashflow_settings').select('*').maybeSingle()
      ]);
      for (const result of [b, p, s, a, st]) if (result.error) throw result.error;
      setBanks(b.data || []);
      setPayouts(p.data || []);
      setSuppliers(s.data || []);
      setAdAccounts(a.data || []);
      if (st.data) {
        setSettings({
          display_currency: st.data.display_currency || 'USD',
          opex: st.data.opex || seed.settings.opex,
          planning: st.data.planning || seed.settings.planning,
          owner_draw: st.data.owner_draw || seed.settings.owner_draw
        });
      } else {
        await saveSettings(seed.settings);
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAuth(e) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const fn = authMode === 'signUp' ? supabase.auth.signUp : supabase.auth.signInWithPassword;
      const { error } = await fn.call(supabase.auth, { email, password });
      if (error) throw error;
      setMessage(authMode === 'signUp' ? 'Account created. Check email if Supabase email confirmation is on.' : 'Signed in.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(nextSettings) {
    setSettings(nextSettings);
    if (!hasSupabase || !session) return;
    const payload = {
      user_id: session.user.id,
      display_currency: nextSettings.display_currency,
      opex: nextSettings.opex,
      planning: nextSettings.planning,
      owner_draw: nextSettings.owner_draw
    };
    const { error } = await supabase.from('cashflow_settings').upsert(payload, { onConflict: 'user_id' });
    if (error) setMessage(error.message);
  }

  async function insertRow(table, row, setter) {
    if (hasSupabase && session) {
      const { id, ...remoteRow } = row;
      const { data, error } = await supabase.from(table).insert({ ...remoteRow, user_id: session.user.id }).select().single();
      if (error) return setMessage(error.message);
      setter(prev => [...prev, data]);
    } else {
      setter(prev => [...prev, row]);
    }
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
  const avgRoas = adAccounts.length ? adAccounts.reduce((sum, a) => sum + num(a.roas_3d), 0) / adAccounts.length : 0;
  const verdict = scaleVerdict({ roas3d: avgRoas, threshold: settings.planning.roas_threshold, netAfterScale: dashboard?.totals.netAfterScale || 0 });

  if (hasSupabase && !session) {
    return <AuthPage authMode={authMode} setAuthMode={setAuthMode} email={email} setEmail={setEmail} password={password} setPassword={setPassword} busy={busy} message={message} onSubmit={handleAuth} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Cashflow Calculator</div>
          <h1>Bank cash, payouts, suppliers, ad top-ups, OPEX, and owner draw.</h1>
        </div>
        <div className="top-actions">
          <button className="ghost" onClick={hasSupabase ? loadRemote : loadLocal}><RefreshCcw size={16} /> Reload</button>
          {hasSupabase && <button className="ghost" onClick={() => supabase.auth.signOut()}><LogOut size={16} /> Sign out</button>}
        </div>
      </header>

      {message && <div className="notice">{message}</div>}

      <nav className="tabs">
        <button className={activeTab === 'snapshot' ? 'active' : ''} onClick={() => setActiveTab('snapshot')}><Calculator size={16} /> Snapshot</button>
        <button className={activeTab === 'forecast' ? 'active' : ''} onClick={() => setActiveTab('forecast')}><CalendarDays size={16} /> Forecast</button>
        <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setActiveTab('settings')}><Settings size={16} /> Settings</button>
      </nav>

      {activeTab === 'snapshot' && dashboard && (
        <main>
          <section className="summary-grid">
            <Summary title="Bank Cash" value={fmt(dashboard.totals.bankCash, dashboard.displayCurrency)} icon={<Landmark />} />
            <Summary title="Pending Incoming" value={fmt(dashboard.totals.pendingIncoming, dashboard.displayCurrency)} icon={<Wallet />} />
            <Summary title="Total Obligations" value={fmt(dashboard.totals.obligations, dashboard.displayCurrency)} icon={<CreditCard />} tone="warn" />
            <Summary title="Net Position" value={fmt(dashboard.totals.netPosition, dashboard.displayCurrency)} icon={<Banknote />} tone={dashboard.totals.netPosition >= 0 ? 'good' : 'bad'} />
          </section>

          <section className="two-col">
            <Panel title="Banks" action={<AddButton onClick={() => insertRow('banks', { id: uid('bank'), name: 'New Bank', currency: 'USD', balance: 0, notes: '' }, setBanks)} />}>
              {dashboard.bankCards.map(bank => (
                <div className="bank-card" key={bank.id}>
                  <div><strong>{bank.name}</strong><span>{bank.currency}</span></div>
                  <div className="bank-money">{fmt(bank.balanceDisplay, dashboard.displayCurrency)}</div>
                  <small>Projected after routed payouts: {fmt(bank.projectedDisplay, dashboard.displayCurrency)}</small>
                </div>
              ))}
            </Panel>

            <Panel title="Pending Payouts" action={<AddButton onClick={() => insertRow('pending_payouts', { id: uid('payout'), source: 'New Payout', currency: settings.display_currency, gross_amount: 0, expected_date: todayPlus(2), destination_bank_id: banks[0]?.id || null, payout_conversion_fee_percent: 0, payout_transfer_fee_flat: 0, bank_conversion_fee_percent: 0, bank_receiving_fee_flat: 0, status: 'pending', notes: '' }, setPayouts)} />}>
              {dashboard.enrichedPayouts.map(payout => (
                <div className="payout-card" key={payout.id}>
                  <button className="row-button" onClick={() => setExpandedPayout(expandedPayout === payout.id ? '' : payout.id)}>
                    <span><strong>{payout.source}</strong><small>{payout.expected_date || 'No date'} to {banks.find(b => b.id === payout.destination_bank_id)?.name || 'No bank'}</small></span>
                    <b>{fmt(payout.netDisplay, dashboard.displayCurrency)}</b>
                  </button>
                  {expandedPayout === payout.id && <PayoutEditor payout={payout} banks={banks} update={(patch) => updateRow('pending_payouts', payout.id, patch, setPayouts)} remove={() => deleteRow('pending_payouts', payout.id, setPayouts)} displayCurrency={dashboard.displayCurrency} />}
                </div>
              ))}
            </Panel>
          </section>

          <section className="three-col">
            <Panel title="Supplier Payments" action={<AddButton onClick={() => insertRow('supplier_obligations', { id: uid('supplier'), name: 'New Supplier', currency: 'USD', amount_due: 0, due_date: todayPlus(3), status: 'open', notes: '' }, setSuppliers)} />}>
              {dashboard.supplierRows.map(s => <MiniRow key={s.id} title={s.name} value={fmt(s.amountDisplay, dashboard.displayCurrency)} sub={`${s.daysLeft ?? '?'} days left`} tone={s.daysLeft !== null && s.daysLeft <= 3 ? 'bad' : 'neutral'} />)}
            </Panel>
            <Panel title="Ad Top-ups" action={<AddButton onClick={() => insertRow('ad_accounts', { id: uid('ad'), name: 'New Ad Account', platform: 'Meta', currency: 'USD', current_balance: 0, target_balance: 0, daily_spend: 0, roas_3d: 0, notes: '' }, setAdAccounts)} />}>
              {dashboard.adRows.map(a => <MiniRow key={a.id} title={a.name} value={fmt(a.topupDisplay, dashboard.displayCurrency)} sub={`Runway: ${a.runwayDays === null ? 'n/a' : `${a.runwayDays.toFixed(1)} days`} | 3D ROAS: ${num(a.roas_3d).toFixed(2)}x`} tone={a.runwayDays !== null && a.runwayDays <= 3 ? 'bad' : 'neutral'} />)}
            </Panel>
            <Panel title="OPEX Reserve">
              <MiniRow title={settings.opex.label || 'OPEX'} value={fmt(dashboard.totals.opexReserve, dashboard.displayCurrency)} sub="Set aside before owner draw" />
            </Panel>
          </section>

          <section className="two-col">
            <Panel title="Scaling Logic">
              <div className={`verdict ${verdict.level}`}>{verdict.text}</div>
              <Metric label="Average 3D ROAS" value={`${avgRoas.toFixed(2)}x`} />
              <Metric label="ROAS Threshold" value={`${num(settings.planning.roas_threshold).toFixed(2)}x`} />
              <Metric label="Extra cash needed to scale" value={fmt(dashboard.totals.scaleExtraNeeded, dashboard.displayCurrency)} />
              <Metric label="Net after scaling" value={fmt(dashboard.totals.netAfterScale, dashboard.displayCurrency)} />
            </Panel>
            <Panel title="Owner Draw">
              <Metric label="Target transfer" value={fmt(dashboard.totals.ownerTargetDisplay, dashboard.displayCurrency)} />
              <Metric label="Remaining after owner draw" value={fmt(dashboard.totals.netAfterOwnerDraw, dashboard.displayCurrency)} />
              <div className={`verdict ${dashboard.totals.netAfterOwnerDraw >= 0 ? 'good' : 'bad'}`}>{dashboard.totals.netAfterOwnerDraw >= 0 ? 'Safe based on current obligations.' : 'Too tight. Keep this inside the business for now.'}</div>
            </Panel>
          </section>
        </main>
      )}

      {activeTab === 'forecast' && dashboard && (
        <main>
          <section className="panel wide">
            <div className="panel-head">
              <h2>Forecast</h2>
              <div className="segmented">
                {[7, 14, 30].map(days => <button key={days} className={forecastDays === days ? 'active' : ''} onClick={() => setForecastDays(days)}>{days}d</button>)}
              </div>
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
        <main className="settings-grid">
          <SettingsPanel title="Global Settings">
            <Field label="Display currency" type="select" value={settings.display_currency} onChange={v => saveSettings({ ...settings, display_currency: v })} options={CURRENCIES} />
            <Field label="OPEX reserve amount" value={settings.opex.reserve_amount} onChange={v => saveSettings({ ...settings, opex: { ...settings.opex, reserve_amount: v } })} />
            <Field label="OPEX currency" type="select" value={settings.opex.currency} onChange={v => saveSettings({ ...settings, opex: { ...settings.opex, currency: v } })} options={CURRENCIES} />
            <Field label="Scale percent" value={settings.planning.scale_percent} onChange={v => saveSettings({ ...settings, planning: { ...settings.planning, scale_percent: v } })} />
            <Field label="ROAS threshold" value={settings.planning.roas_threshold} onChange={v => saveSettings({ ...settings, planning: { ...settings.planning, roas_threshold: v } })} />
            <Field label="Scale buffer days" value={settings.planning.scale_buffer_days} onChange={v => saveSettings({ ...settings, planning: { ...settings.planning, scale_buffer_days: v } })} />
            <Field label="Owner draw target" value={settings.owner_draw.target_amount} onChange={v => saveSettings({ ...settings, owner_draw: { ...settings.owner_draw, target_amount: v } })} />
            <Field label="Owner draw currency" type="select" value={settings.owner_draw.currency} onChange={v => saveSettings({ ...settings, owner_draw: { ...settings.owner_draw, currency: v } })} options={CURRENCIES} />
          </SettingsPanel>

          <SettingsPanel title="Banks">
            {banks.map(bank => <EditableBank key={bank.id} bank={bank} update={patch => updateRow('banks', bank.id, patch, setBanks)} remove={() => deleteRow('banks', bank.id, setBanks)} />)}
          </SettingsPanel>

          <SettingsPanel title="Suppliers">
            {suppliers.map(supplier => <EditableSupplier key={supplier.id} supplier={supplier} update={patch => updateRow('supplier_obligations', supplier.id, patch, setSuppliers)} remove={() => deleteRow('supplier_obligations', supplier.id, setSuppliers)} />)}
          </SettingsPanel>

          <SettingsPanel title="Ad Accounts">
            {adAccounts.map(account => <EditableAdAccount key={account.id} account={account} update={patch => updateRow('ad_accounts', account.id, patch, setAdAccounts)} remove={() => deleteRow('ad_accounts', account.id, setAdAccounts)} />)}
          </SettingsPanel>
        </main>
      )}

      {busy && <div className="loading">Loading...</div>}
    </div>
  );
}

function AuthPage({ authMode, setAuthMode, email, setEmail, password, setPassword, busy, message, onSubmit }) {
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit}>
        <Database size={28} />
        <h1>Cashflow Calculator</h1>
        <p>Sign in to sync data with Supabase. Without Supabase env vars, the app uses local browser storage.</p>
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        <button disabled={busy}>{authMode === 'signUp' ? 'Create account' : 'Sign in'}</button>
        <button type="button" className="link-button" onClick={() => setAuthMode(authMode === 'signUp' ? 'signIn' : 'signUp')}>{authMode === 'signUp' ? 'Use existing account' : 'Create a new account'}</button>
        {message && <div className="notice">{message}</div>}
      </form>
    </div>
  );
}

function Summary({ title, value, icon, tone = 'neutral' }) {
  return <div className={`summary-card ${tone}`}><div>{icon}</div><span>{title}</span><strong>{value}</strong></div>;
}

function Panel({ title, action, children }) {
  return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>;
}

function SettingsPanel({ title, children }) {
  return <section className="panel"><div className="panel-head"><h2>{title}</h2></div><div className="settings-stack">{children}</div></section>;
}

function AddButton({ onClick }) {
  return <button className="icon-btn" onClick={onClick}><Plus size={16} /></button>;
}

function Field({ label, value, onChange, type = 'number', options }) {
  return <label className="field"><span>{label}</span>{type === 'select' ? <select value={value ?? ''} onChange={e => onChange(e.target.value)}>{options.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} />}</label>;
}

function TextField({ label, value, onChange, type = 'text' }) {
  return <label className="field"><span>{label}</span><input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} /></label>;
}

function MiniRow({ title, value, sub, tone = 'neutral' }) {
  return <div className={`mini-row ${tone}`}><div><strong>{title}</strong><small>{sub}</small></div><b>{value}</b></div>;
}

function Metric({ label, value }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function PayoutEditor({ payout, banks, update, remove, displayCurrency }) {
  return <div className="editor-grid">
    <TextField label="Source" value={payout.source} onChange={v => update({ source: v })} />
    <Field label="Currency" type="select" value={payout.currency} onChange={v => update({ currency: v })} options={CURRENCIES} />
    <Field label="Gross amount" value={payout.gross_amount} onChange={v => update({ gross_amount: v })} />
    <TextField label="Expected date" type="date" value={payout.expected_date || ''} onChange={v => update({ expected_date: v })} />
    <label className="field"><span>Destination bank</span><select value={payout.destination_bank_id || ''} onChange={e => update({ destination_bank_id: e.target.value })}>{banks.map(bank => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select></label>
    <label className="field"><span>Status</span><select value={payout.status || 'pending'} onChange={e => update({ status: e.target.value })}><option value="pending">Pending</option><option value="received">Received</option></select></label>
    <Field label="Payout conversion %" value={payout.payout_conversion_fee_percent} onChange={v => update({ payout_conversion_fee_percent: v })} />
    <Field label="Payout transfer flat" value={payout.payout_transfer_fee_flat} onChange={v => update({ payout_transfer_fee_flat: v })} />
    <Field label="Bank conversion %" value={payout.bank_conversion_fee_percent} onChange={v => update({ bank_conversion_fee_percent: v })} />
    <Field label="Bank receiving flat" value={payout.bank_receiving_fee_flat} onChange={v => update({ bank_receiving_fee_flat: v })} />
    <div className="fee-box">
      <Metric label="Gross" value={fmt(payout.grossDisplay, displayCurrency)} />
      <Metric label="Total fees" value={fmt(payout.totalFeesDisplay, displayCurrency)} />
      <Metric label="Net landed" value={fmt(payout.netDisplay, displayCurrency)} />
    </div>
    <button className="danger" onClick={remove}><Trash2 size={15} /> Delete payout</button>
  </div>;
}

function EditableBank({ bank, update, remove }) {
  return <div className="edit-card"><TextField label="Name" value={bank.name} onChange={v => update({ name: v })} /><Field label="Currency" type="select" value={bank.currency} onChange={v => update({ currency: v })} options={CURRENCIES} /><Field label="Balance" value={bank.balance} onChange={v => update({ balance: v })} /><button className="danger" onClick={remove}><Trash2 size={15} /> Delete</button></div>;
}

function EditableSupplier({ supplier, update, remove }) {
  return <div className="edit-card"><TextField label="Name" value={supplier.name} onChange={v => update({ name: v })} /><Field label="Currency" type="select" value={supplier.currency} onChange={v => update({ currency: v })} options={CURRENCIES} /><Field label="Amount due" value={supplier.amount_due} onChange={v => update({ amount_due: v })} /><TextField label="Due date" type="date" value={supplier.due_date || ''} onChange={v => update({ due_date: v })} /><button className="danger" onClick={remove}><Trash2 size={15} /> Delete</button></div>;
}

function EditableAdAccount({ account, update, remove }) {
  return <div className="edit-card"><TextField label="Name" value={account.name} onChange={v => update({ name: v })} /><Field label="Currency" type="select" value={account.currency} onChange={v => update({ currency: v })} options={CURRENCIES} /><Field label="Current balance" value={account.current_balance} onChange={v => update({ current_balance: v })} /><Field label="Target balance" value={account.target_balance} onChange={v => update({ target_balance: v })} /><Field label="Daily spend" value={account.daily_spend} onChange={v => update({ daily_spend: v })} /><Field label="3D ROAS" value={account.roas_3d} onChange={v => update({ roas_3d: v })} /><button className="danger" onClick={remove}><Trash2 size={15} /> Delete</button></div>;
}

createRoot(document.getElementById('root')).render(<App />);
