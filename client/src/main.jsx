import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink, Navigate, Link } from 'react-router-dom';
import './styles.css';
import { api } from './api.js';
import { ToastProvider, Loading } from './components/ui.jsx';
import { MetaProvider } from './components/meta.jsx';
import { SessionCtx } from './components/session.js';
import { Brand } from './components/Brand.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import RfqNew from './pages/RfqNew.jsx';
import RfqDetail from './pages/RfqDetail.jsx';
import Inbox from './pages/Inbox.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';

function Shell({ user, tenant, access, onLogout }) {
  const nav = [
    ['/', 'RFQs'],
    ['/rfqs/new', '+ New RFQ'],
    ['/inbox', 'Unmatched mail'],
    ['/reports', 'Reports'],
    ['/settings', 'Settings'],
  ];
  return (
    <div className="shell">
      <aside className="side">
        <Brand />
        <nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end={to === '/' || to === '/rfqs/new'} className="nav">{label}</NavLink>)}</nav>
        <div className="side-foot">
          <div><b>{tenant?.name}</b></div>
          <div>{user.name}</div>
          <button className="link" onClick={onLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <AccessBanner access={access} />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/rfqs/new" element={<RfqNew />} />
          <Route path="/rfqs/:id" element={<RfqDetail />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/agents" element={<Navigate to="/settings/partner-agents" replace />} />
          <Route path="/customers" element={<Navigate to="/settings/customers" replace />} />
          <Route path="/rate-cards" element={<Navigate to="/settings/rate-cards" replace />} />
          <Route path="/settings" element={<Navigate to="/settings/partner-agents" replace />} />
          <Route path="/settings/:section" element={<Settings user={user} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

function AccessBanner({ access }) {
  if (!access) return null;
  if (!access.ok) return <div className="banner banner-red">{access.message} <Link to="/settings/subscription">Choose a plan →</Link></div>;
  if (access.state === 'trialing' && access.trial_days_left <= 7) return <div className="banner banner-amber">Your free trial ends in {access.trial_days_left} day(s). <Link to="/settings/subscription">Choose a plan →</Link></div>;
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
