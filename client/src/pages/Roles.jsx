// Settings > Roles: roles bundle permissions; approval levels (Settings → Pricing) are assigned to roles.
import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Button, Modal, Field, Input, Loading, ErrorBox, useLoad, useAction } from '../components/ui.jsx';

/** Ticking adds what a permission needs; unticking removes what depended on it. */
function toggle(perms, code, on, catalog) {
  const set = new Set(perms);
  const needs = (c) => catalog.find((p) => p.code === c)?.requires || [];
  if (on) {
    const add = (c) => { if (set.has(c)) return; set.add(c); needs(c).forEach(add); };
    add(code);
  } else {
    const drop = (c) => { set.delete(c); catalog.filter((p) => (p.requires || []).includes(c) && set.has(p.code)).forEach((p) => drop(p.code)); };
    drop(code);
  }
  return catalog.map((p) => p.code).filter((c) => set.has(c));
}

export default function Roles() {
  const meta = useLoad(() => api.get('/meta'));
  const roles = useLoad(() => api.get('/roles'));
  const settings = useLoad(() => api.get('/settings'));
  const [editing, setEditing] = useState(null);
  const [busy, run] = useAction();
  const catalog = useMemo(() => (meta.data?.permissions || []).flatMap((g) => g.items), [meta.data]);
  if (roles.error) return <ErrorBox error={roles.error} />;
  if (!roles.data || !meta.data) return <Loading />;
  const label = (c) => catalog.find((p) => p.code === c)?.label || c;
  const levels = settings.data?.pricing?.approval_levels || [];
  const approves = (key) => levels.filter((l) => l.role === key).map((l) => `margin below ${l.below_pct}%`);
  const remove = (r) => confirm(`Delete the ${r.name} role?`) && run(`del${r.key}`, async () => roles.setData(await api.del(`/roles/${r.key}`)), `${r.name} deleted`);

  return (
    <>
      <PageHeader title="Roles" sub="Roles bundle permissions. Approval levels are assigned to roles, so everyone holding a role can act on that level." actions={
        <Button onClick={() => setEditing({ name: '', description: '', permissions: ['rfqs.view'] })}>+ New role</Button>
      } />
      <div className="role-grid">
        {roles.data.map((r) => (
          <div key={r.key} className="card role-card">
            <div className="row-between"><h3>{r.name}</h3><span className="muted small">{r.users} user{r.users === 1 ? '' : 's'}</span></div>
            {r.description && <p className="muted small">{r.description}</p>}
            <div className="perm-chips">
              {r.permissions.length
                ? r.permissions.map((p) => <span key={p} className="perm-chip" title={label(p)}>{p}</span>)
                : <span className="muted small">No permissions — approval role only</span>}
            </div>
            {(r.key === 'admin' || approves(r.key).length > 0) && (
              <p className="small"><b>Approves:</b> {r.key === 'admin' ? 'every approval level' : approves(r.key).join(', ')}</p>
            )}
            <div className="row gap-sm">
              <Button small variant="ghost" onClick={() => setEditing(r)}>{r.locked ? 'View' : 'Edit'}</Button>
              {!r.system && <Button small variant="ghost" busy={busy === `del${r.key}`} onClick={() => remove(r)}>Delete</Button>}
            </div>
          </div>
        ))}
      </div>
      <p className="small muted">Someone with several roles gets everything any of their roles allows. Without <span className="mono">costs.view</span>, agent rates, buy costs, margins and profit are removed on the server, not just hidden. Without <span className="mono">data.all</span>, a user sees only the RFQs and jobs they created or that are assigned to them.</p>

      {editing && <RoleModal role={editing} groups={meta.data.permissions} catalog={catalog}
        onClose={() => setEditing(null)}
        onSaved={(list) => { roles.setData(list); setEditing(null); }} />}
    </>
  );
}

function RoleModal({ role, groups, catalog, onClose, onSaved }) {
  const [name, setName] = useState(role.name || '');
  const [description, setDescription] = useState(role.description || '');
  const [perms, setPerms] = useState(role.permissions || []);
  const [busy, run] = useAction();
  const locked = !!role.locked;
  const save = () => run('save', async () => {
    const body = { name, description, permissions: perms };
    onSaved(await (role.key ? api.put(`/roles/${role.key}`, body) : api.post('/roles', body)));
  }, `${name} saved. Changes apply on each user’s next click.`);
  return (
    <Modal title={role.key ? `${locked ? '' : 'Edit '}${role.name}` : 'New role'} onClose={onClose} footer={
      <div className="row gap-sm">
        <Button variant="ghost" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</Button>
        {!locked && <Button busy={busy === 'save'} disabled={!name.trim()} onClick={save}>Save</Button>}
      </div>
    }>
      <Field label="Name"><Input value={name} disabled={locked} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales, Operations, Accounts" /></Field>
      <Field label="Description"><Input value={description} disabled={locked} onChange={(e) => setDescription(e.target.value)} placeholder="Shown when choosing a user's roles" /></Field>
      <fieldset className="perm-group">
        <legend>Permissions</legend>
        {locked && <p className="small muted">The Administrator role always has every permission and can approve every level.</p>}
        {groups.map((g) => (
          <div key={g.name} className="stack-sm">
            <div className="field-l">{g.name}</div>
            <div className="check-list">
              {g.items.map((p) => (
                <label key={p.code} className="check-item">
                  <input type="checkbox" disabled={locked} checked={locked || perms.includes(p.code)} onChange={(e) => setPerms(toggle(perms, p.code, e.target.checked, catalog))} />
                  <span><strong className="mono">{p.code}</strong><span className="muted small block">{p.label}{p.requires?.length ? ` · needs ${p.requires.join(', ')}` : ''}</span></span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>
    </Modal>
  );
}
