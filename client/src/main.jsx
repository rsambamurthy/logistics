import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import './styles.css';
import { api } from './api.js';
import { ToastProvider, Loading } from './components/ui.jsx';
import { MetaProvider } from './components/meta.jsx';
import { SessionCtx } from './components/session.js';
import { LogoMark, PRODUCT } from './components/Brand.jsx';
import AppFrame from './components/AppFrame.jsx';
import NavIcon from './components/NavIcon.jsx';
import Login from './pages/Login.jsx';
import AccountLink from './pages/AccountLink.jsx';
import Dashboard from './pages/Dashboard.jsx';
import RfqNew from './pages/RfqNew.jsx';
import RfqDetail from './pages/RfqDetail.jsx';
import Inbox from './pages/Inbox.jsx';
import Reports from './pages/Reports.jsx';
import Settings, { settingsSections } from './pages/Settings.jsx';
import Jobs from './pages/Jobs.jsx';
import JobDetail from './pages/JobDetail.jsx';
import Consols from './pages/Consols.jsx';
import ConsolDetail from './pages/ConsolDetail.jsx';
import Track from './pages/Track.jsx';

// Settings sections as sidebar groups (VendorGate style: administration pages live in the sidebar).
const SETTINGS_ICONS = { Contacts: 'contacts', Pricing: 'pricing', System: 'config', 'Integrata admin': 'platform' };
function settingsGroups(user) {
  const groups = [];
  for (const x of settingsSections(user)) {
    if (x.group) groups.push({ key: `s-${x.group}`, label: x.group === 'System' ? 'Administration' : x.group, icon: SETTINGS_ICONS[x.group] || 'config', items: [] });
    else if (groups.length) groups[groups.length - 1].items.push({ to: `/settings/${x.key}`, label: x.label });
  }
  return groups.filter((g) => g.items.length);
}

/** Unmatched mail waiting, refreshed every minute and on each page change. */
function useUnmatched(enabled, pathname) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const get = () => document.visibilityState === 'visible' && api.get('/inbox/count').then((r) => setN(r.n)).catch(() => {});
    get();
    const t = setInterval(get, 60000);
    return () => clearInterval(t);
  }, [enabled, pathname]);
  return n;
}

function Shell({ user, tenant, access, onLogout }) {
  const perms = user.perms || [];
  const can = (p) => perms.includes(p);
  const { pathname } = useLocation();
  const unmatched = useUnmatched(can('inbox.view'), pathname);
  const single = [
    { to: '/', label: 'RFQs', icon: 'rfqs', end: true, show: can('rfqs.view') },
    { to: '/rfqs/new', label: 'New RFQ', icon: 'plus', end: true, show: can('rfqs.edit') },
    { to: '/jobs', label: 'Jobs', icon: 'jobs', show: can('jobs.view') },
    { to: '/consols', label: 'Consolidation', icon: 'consol', show: can('jobs.view') && can('data.all') },
    { to: '/inbox', label: 'Unmatched mail', icon: 'mail', show: can('inbox.view'), count: unmatched, countLabel: 'emails waiting' },
    { to: '/reports', label: 'Reports', icon: 'reports', show: can('reports.view') },
  ].filter((l) => l.show);
  const entries = [...single, ...settingsGroups(user)];
  const initials = (user.name || user.email).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <AppFrame
      prefsKey="aq.nav"
      logo={<LogoMark size={28} />}
      product={PRODUCT.name}
      workspace={tenant?.name}
      entries={entries}
      actions={<button className="af-hbtn" onClick={onLogout} title="Sign out" aria-label="Sign out"><NavIcon name="logout" size={18} /></button>}
      user={{ initials, name: user.name, role: (user.role_names || []).join(', ') }}
    >
        <AccessBanner access={access} user={user} />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/rfqs/new" element={<RfqNew />} />
          <Route path="/rfqs/:id" element={<RfqDetail />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/consols" element={<Consols />} />
          <Route path="/consols/:id" element={<ConsolDetail />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/agents" element={<Navigate to="/settings/partner-agents" replace />} />
          <Route path="/customers" element={<Navigate to="/settings/customers" replace />} />
          <Route path="/rate-cards" element={<Navigate to="/settings/rate-cards" replace />} />
          <Route path="/settings" element={<Settings user={user} />} />
          <Route path="/settings/:section" element={<Settings user={user} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    </AppFrame>
  );
}

function AccessBanner({ access, user }) {
  if (!access) return null;
  const canBill = (user?.perms || []).includes('billing.manage');
  const Plan = () => (canBill ? <Link to="/settings/subscription">Choose a plan →</Link> : <span>Ask your administrator to choose a plan.</span>);
  if (!access.ok) return <div className="banner banner-red">{access.message} <Plan /></div>;
  if (access.state === 'trialing' && access.trial_days_left <= 7) return <div className="banner banner-amber">Your free trial ends in {access.trial_days_left} day(s). <Plan /></div>;
  return null;
}

function App() {
  const [session, setSession] = useState(null);
  const load = () => api.get('/session').then(setSession).catch(() => setSession({}));
  useEffect(() => {
    load();
    const h = () => setSession({});
    window.addEventListener('aq:logout', h);
    window.addEventListener('aq:session', load);
    return () => { window.removeEventListener('aq:logout', h); window.removeEventListener('aq:session', load); };
  }, []);
  if (/^\/(verify|reset)$/.test(location.pathname)) return <AccountLink onDone={load} />;
  if (/^\/track\/[^/]+$/.test(location.pathname)) return <Track />;
  if (!session) return <Loading />;
  if (!session.user) return <Login onDone={load} />;
  const logout = async () => { await api.post('/logout'); setSession({}); };
  return (
    <SessionCtx.Provider value={session}>
      <MetaProvider>
        <Shell user={session.user} tenant={session.tenant} access={session.access} onLogout={logout} />
      </MetaProvider>
    </SessionCtx.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BrowserRouter>
);
