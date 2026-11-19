// Reusable UI building blocks. Every page composes these — no page-specific copies.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';

export function Button({ variant = 'primary', small, busy, children, ...p }) {
  return (
    <button className={`btn btn-${variant}${small ? ' btn-sm' : ''}`} disabled={busy || p.disabled} {...p}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export const Spinner = () => <span className="spinner" />;

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-h">
          <h3>{title}</h3>
          <div className="row gap">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, sub, actions }) {
  return (
    <div className="page-h">
      <div>
        <h1>{title}</h1>
        {sub && <div className="muted">{sub}</div>}
      </div>
      <div className="row gap">{actions}</div>
    </div>
  );
}

export function Field({ label, hint, children, span = 1 }) {
  return (
    <label className="field" style={{ gridColumn: `span ${span}` }}>
      <span className="field-l">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const Input = (p) => <input className="input" {...p} value={p.value ?? ''} />;
export const Textarea = (p) => <textarea className="input" rows={p.rows || 4} {...p} value={p.value ?? ''} />;

export function Select({ options, value, onChange, placeholder, ...p }) {
  return (
    <select className="input" value={value ?? ''} onChange={onChange} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => {
        const v = typeof o === 'object' ? o.value : o;
        const l = typeof o === 'object' ? o.label : o;
        return <option key={v} value={v}>{l}</option>;
      })}
    </select>
  );
}

export function Check({ label, checked, onChange }) {
  return (
    <label className="check">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Generic form bound to an object: fields = [{ key, label, type, options, span, hint, disabled }] */
export function FormGrid({ fields, value, onChange, cols = 3 }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {fields.map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint} span={f.span}>
          {f.type === 'select' ? (
            <Select options={f.options} value={value[f.key]} placeholder={f.placeholder ?? ''} disabled={f.disabled} onChange={(e) => set(f.key, e.target.value)} />
          ) : f.type === 'textarea' ? (
            <Textarea rows={f.rows} value={value[f.key]} disabled={f.disabled} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />
          ) : f.type === 'checkbox' ? (
            <Check label={f.checkLabel || ''} checked={value[f.key]} onChange={(v) => set(f.key, v)} />
          ) : (
            <Input type={f.type || 'text'} value={value[f.key]} placeholder={f.placeholder} disabled={f.disabled} onChange={(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
          )}
        </Field>
      ))}
    </div>
  );
}

export function Table({ columns, rows, empty = 'Nothing here yet', onRowClick, rowKey = 'id', rowClass }) {
  if (!rows?.length) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key || c.label} style={{ textAlign: c.align }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[rowKey] ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={[onRowClick ? 'clickable' : '', rowClass ? rowClass(r) : ''].filter(Boolean).join(' ')}>
              {columns.map((c) => <td key={c.key || c.label} style={{ textAlign: c.align }}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_COLORS = {
  draft: 'grey', pending: 'grey', sent: 'blue', reminded: 'amber', replied: 'green', quoting: 'blue', quoted: 'purple', awarded: 'green', closed: 'grey', failed: 'red', declined: 'red',
  lost: 'red', expired: 'grey', superseded: 'grey', new: 'amber', enquiry: 'amber', requester: 'purple',
  parsed: 'green', parsing: 'blue', error: 'red', no_quote: 'amber', unmatched: 'amber', ignored: 'grey', accepted: 'green', cancelled: 'grey',
};
export function Badge({ children, color }) {
  return <span className={`badge badge-${color || STATUS_COLORS[children] || 'grey'}`}>{String(children).replace(/_/g, ' ')}</span>;
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="card-h"><h3>{title}</h3><button className="x" onClick={onClose}>×</button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-f">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className={`tab${active === t.key ? ' active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, tone }) {
  return (
    <div className={`stat ${tone || ''}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export const money = (n, cur) => (n === null || n === undefined ? '—' : `${cur ? cur + ' ' : ''}${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

// ---- toast ----
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, type = 'ok') => {
    const id = Math.random();
    setItems((x) => [...x, { id, text, type }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), type === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">{items.map((t) => <div key={t.id} className={`toast toast-${t.type}`}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Load data with loading/error state and a reload function. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      setState({ data: await fn(), loading: false, error: null });
    } catch (e) {
      setState({ data: null, loading: false, error: e.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

/** Wrap an async action with busy flag + toast on error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const run = useCallback(async (key, fn, okMsg) => {
    setBusy(key);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message, 'error');
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return [busy, run];
}

export const Loading = () => <div className="loading"><Spinner /> Loading…</div>;
export const ErrorBox = ({ error }) => <div className="alert alert-red">{error}</div>;

/** Vertical sub-menu for sections inside a page (e.g. Settings). items: [{ to, label, hint }] or [{ group }] headings */
export function SideMenu({ title, items }) {
  return (
    <nav className="subnav">
      {title && <div className="subnav-title">{title}</div>}
      {items.map((i) => i.group ? <div key={`g-${i.group}`} className="subnav-group">{i.group}</div> : (
        <NavLink key={i.to} to={i.to} className="subnav-item">
          <span>{i.label}</span>
          {i.hint && <small>{i.hint}</small>}
        </NavLink>
      ))}
    </nav>
  );
}
