import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import './styles.css';
import { api } from './api.js';
import { ToastProvider, Loading } from './components/ui.jsx';
import { MetaProvider } from './components/meta.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import RfqNew from './pages/RfqNew.jsx';
import RfqDetail from './pages/RfqDetail.jsx';
import Agents from './pages/Agents.jsx';
import Customers from './pages/Customers.jsx';
import Inbox from './pages/Inbox.jsx';
import Settings from './pages/Settings.jsx';

function Shell({ user, onLogout }) {
  const nav = [
    ['/', 'RFQs'],
    ['/rfqs/new', '+ New RFQ'],
    ['/inbox', 'Unmatched mail'],
    ['/agents', 'Partner agents'],
    ['/customers', 'Customers'],
    ['/settings', 'Settings'],
  ];
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="logo">AQ</span> AgentQuote</div>
        <nav>{nav.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} className="nav">{label}</NavLink>)}</nav>
        <div className="side-foot">
          <div>{user.name}</div>
          <button className="link" onClick={onLogout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/rfqs/new" element={<RfqNew />} />
          <Route path="/rfqs/:id" element={<RfqDetail />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/settings" element={<Settings user={user} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  const [session, setSession] = useState(null);
  const load = () => api.get('/session').then(setSession).catch(() => setSession({}));
  useEffect(() => {
    load();
    const h = () => setSession({});
    window.addEventListener('aq:logout', h);
    return () => window.removeEventListener('aq:logout', h);
  }, []);
  if (!session) return <Loading />;
  if (!session.user) return <Login setup={session.setup} onDone={(user) => setSession({ user })} />;
  const logout = async () => { await api.post('/logout'); setSession({}); };
  return (
    <MetaProvider>
      <Shell user={session.user} onLogout={logout} />
    </MetaProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BrowserRouter>
);
