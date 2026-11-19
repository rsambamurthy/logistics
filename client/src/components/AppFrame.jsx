// The app frame, same look as VendorGate (Integrata standard): a coloured top bar (menu button, logo,
// workspace chip, actions, user chip) and a white sidebar with single links and collapsible groups.
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import NavIcon from './NavIcon.jsx';

const isGroup = (e) => Array.isArray(e.items);
const DOTS = ['#a855f7', '#3b82f6', '#2563eb', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'];

/** Sidebar preferences (collapsed rail, open groups), remembered on this device. */
function usePrefs(key) {
  const load = () => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
  const [prefs, set] = useState(load);
  const update = (p) => { set(p); try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* storage unavailable */ } };
  return [prefs, update];
}

export default function AppFrame({ prefsKey = 'aq.nav', logo, product, workspace, entries, actions, user, navLabel = 'Navigation', sideFoot, children }) {
  const location = useLocation();
  const [prefs, update] = usePrefs(prefsKey);
  const [menuOpen, setMenuOpen] = useState(false); // phone-size drawer
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  const rail = !!prefs.rail;

  const under = (l) => location.pathname === l.to || location.pathname.startsWith(`${l.to}/`);
  const active = (l) => (l.end ? location.pathname === l.to : under(l));
  const groupActive = (g) => g.items.some(active);
  // groups start closed except the one holding the current page; the user's choice is remembered
  const isOpen = (g) => groupActive(g) || (prefs.open || []).includes(g.key);
  const toggle = (g) => {
    const open = new Set(prefs.open || []);
    if (open.has(g.key)) open.delete(g.key); else open.add(g.key);
    update({ ...prefs, open: [...open] });
  };
  const crumbs = [];
  for (const e of entries) {
    if (isGroup(e)) { const l = e.items.find(active) || e.items.find(under); if (l) { crumbs.push(e.label, l.label); break; } }
    else if (active(e)) { crumbs.push(e.label); break; }
  }
  const toggleMenu = () => (window.matchMedia('(max-width: 900px)').matches ? setMenuOpen(!menuOpen) : update({ ...prefs, rail: !rail }));

  return (
    <div className={`af ${rail ? 'af-rail' : ''} ${menuOpen ? 'af-menu-open' : ''}`}>
      <header className="af-header">
        <button className="af-hbtn" onClick={toggleMenu} aria-label={menuOpen ? 'Close menu' : rail ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={menuOpen || !rail}>
          <NavIcon name="menu" size={20} />
        </button>
        <span className="af-logo">{logo}</span>
        <span className="af-product hide-sm">{product}</span>
        {workspace && <span className="af-chip" title={workspace}><NavIcon name="workspace" size={14} /><span>{workspace}</span></span>}
        <span className="af-spacer" />
        <div className="af-actions">{actions}</div>
        <span className="af-user-chip" title={user.name}>
          <span className="af-avatar" aria-hidden="true">{user.initials}</span>
          <span className="af-user-text"><span className="af-user-name">{user.name}</span>{user.role && <span className="af-user-role">{user.role}</span>}</span>
        </span>
      </header>
      <div className="af-body">
        <aside className="af-side" aria-label={navLabel}>
          <div className="af-sb-head">{navLabel}</div>
          <nav className="af-nav" aria-label={navLabel}>
            {entries.map((e) => {
              if (!isGroup(e)) return <SingleLink key={e.to} l={e} rail={rail} />;
              const open = isOpen(e) && !rail;
              return (
                <div key={e.key} className={`af-mg ${open ? 'open' : ''} ${groupActive(e) ? 'has-active' : ''}`}>
                  <button type="button" className="af-mg-h" aria-expanded={open} title={rail ? e.label : undefined}
                    onClick={() => (rail ? update({ ...prefs, rail: false, open: [...new Set([...(prefs.open || []), e.key])] }) : toggle(e))}>
                    <span className="af-mg-ic"><NavIcon name={e.icon} size={12} /></span>
                    <span className="af-mg-t">{e.label}</span>
                    <span className="af-chev"><NavIcon name="chevron" size={12} /></span>
                  </button>
                  {open && (
                    <div className="af-mi-list">
                      {e.items.map((l, i) => (
                        <NavLink key={l.to} to={l.to} end={l.end} className="af-mi">
                          <span className="af-dot" style={{ background: DOTS[i % DOTS.length] }} />
                          <span className="af-mi-t">{l.label}</span>
                          {!!l.count && <span className="af-count" aria-label={l.countLabel}>{l.count}</span>}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          {sideFoot && <div className="af-side-foot">{sideFoot}</div>}
        </aside>
        {menuOpen && <button className="af-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
        <main className="af-main">
          {crumbs.length > 0 && <div className="af-crumbs">{crumbs.map((c) => <span key={c}>{c}</span>)}</div>}
          <div className="main">{children}</div>
        </main>
      </div>
    </div>
  );
}

function SingleLink({ l, rail }) {
  return (
    <NavLink to={l.to} end={l.end} className="af-single" title={rail ? l.label : undefined}>
      <span className="af-single-ic"><NavIcon name={l.icon} size={14} /></span>
      <span className="af-single-t">{l.label}</span>
      {!!l.count && <span className="af-count" aria-label={l.countLabel}>{l.count}</span>}
    </NavLink>
  );
}
