// Settings > Roles: one column per role, one row per permission. Admin always has everything.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Button, Badge, Modal, Field, Input, Select, Loading, ErrorBox, useLoad, useAction } from '../components/ui.jsx';

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
  const [draft, setDraft] = useState(null);
  const [edit, setEdit] = useState(null);
  const [busy, run] = useAction();
  useEffect(() => { if (roles.data) setDraft(Object.fromEntries(roles.data.map((r) => [r.key, r.permissions]))); }, [roles.data]);
  const groups = meta.data?.permissions || [];
  const catalog = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  if (roles.error) return <ErrorBox error={roles.error} />;
  if (!roles.data || !draft || !meta.data) return <Loading />;
  const changed = roles.data.filter((r) => !r.locked && JSON.stringify(draft[r.key]) !== JSON.stringify(r.permissions));
  const saveAll = () => run('save', async () => {
    let latest = null;
    for (const r of changed) latest = await api.put(`/roles/${r.key}`, { name: r.name, description: r.description, permissions: draft[r.key] });
    roles.setData(latest);
  }, 'Roles saved. Changes apply on each user’s next click.');

  return (
    <>
      <PageHeader title="Roles" sub="What each role can see and do. Give a user a role in Settings → Users." actions={
        <div className="row gap-sm">
          <Button variant="ghost" onClick={() => setEdit({ name: '', description: '', copy: 'user' })}>+ New role</Button>
          <Button disabled={!changed.length} busy={busy === 'save'} onClick={saveAll}>{changed.length ? `Save ${changed.length} change${changed.length > 1 ? 's' : ''}` : 'Saved'}</Button>
        </div>
      } />
      <Card>
        <div className="table-wrap">
          <table className="table roles-grid">
            <thead>
              <tr>
                <th>Permission</th>
                {roles.data.map((r) => (
                  <th key={r.key} className="center">
                    <div><b>{r.name}</b>{r.locked && <Badge color="gray">fixed</Badge>}</div>
                    <div className="small muted">{r.users} user{r.users === 1 ? '' : 's'}</div>
                    {!r.locked && <button className="link small" onClick={() => setEdit({ key: r.key, name: r.name, description: r.description || '', system: r.system, users: r.users })}>Edit</button>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => [
                <tr key={g.name} className="group-row"><td colSpan={roles.data.length + 1}><b>{g.name}</b></td></tr>,
                ...g.items.map((p) => (
                  <tr key={p.code}>
                    <td>{p.label}{p.requires?.length ? <div className="small muted">needs: {p.requires.map((c) => catalog.find((x) => x.code === c)?.label.split(' (')[0]).join('; ')}</div> : null}</td>
                    {roles.data.map((r) => (
                      <td key={r.key} className="center">
                        <input type="checkbox" aria-label={`${r.name}: ${p.label}`} disabled={r.locked} checked={(draft[r.key] || []).includes(p.code)} onChange={(e) => setDraft({ ...draft, [r.key]: toggle(draft[r.key] || [], p.code, e.target.checked, catalog) })} />
                      </td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
        <p className="small muted">Without “See buy rates…”, a role never receives agent rates, buy costs, margins or profit — they are removed on the server, not just hidden. Without “See everyone’s…”, a role sees only the RFQs and jobs it created or that are assigned to it (set the owner at the top of an RFQ or job).</p>
      </Card>

      {edit && (
        <Modal title={edit.key ? `Edit ${edit.name}` : 'New role'} onClose={() => setEdit(null)} footer={
          <div className="row gap-sm">
            {edit.key && !edit.system && <Button variant="ghost" busy={busy === 'del'} onClick={() => confirm(`Delete the ${edit.name} role?`) && run('del', async () => { roles.setData(await api.del(`/roles/${edit.key}`)); setEdit(null); }, 'Role deleted')}>Delete role</Button>}
            <Button busy={busy === 'role'} onClick={() => run('role', async () => {
              const body = { name: edit.name, description: edit.description, permissions: edit.key ? draft[edit.key] : draft[edit.copy] || [] };
              roles.setData(await (edit.key ? api.put(`/roles/${edit.key}`, body) : api.post('/roles', body)));
              setEdit(null);
            }, edit.key ? 'Saved' : 'Role created — tick its permissions in the grid')}>{edit.key ? 'Save' : 'Create'}</Button>
          </div>
        }>
          <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Sales, Operations, Accounts" /></Field>
          <Field label="Description"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="Shown when choosing a user's role" /></Field>
          {!edit.key && <Field label="Start from"><Select value={edit.copy} onChange={(e) => setEdit({ ...edit, copy: e.target.value })} options={roles.data.map((r) => ({ value: r.key, label: r.name }))} /></Field>}
          {edit.key && !edit.system && edit.users > 0 && <p className="small muted">{edit.users} user(s) have this role; give them another role before deleting it.</p>}
          {edit.system && <p className="small muted">Built-in role: you can change its permissions but not delete it.</p>}
        </Modal>
      )}
    </>
  );
}
