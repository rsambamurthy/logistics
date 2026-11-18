// Generic list + add/edit page, shared by Agents and Customers.
import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Table, Button, Modal, FormGrid, Input, Loading, ErrorBox, useLoad, useAction } from './ui.jsx';

export default function CrudPage({ title, sub, endpoint, columns, fields, blank, extra, renderExtraFields, searchText }) {
  const list = useLoad(() => api.get(endpoint), [endpoint]);
  const [edit, setEdit] = useState(null);
  const [search, setSearch] = useState('');
  const [busy, run] = useAction();
  const save = () => run('save', async () => {
    if (edit.id) await api.put(`${endpoint}/${edit.id}`, edit);
    else await api.post(endpoint, edit);
    setEdit(null);
    await list.reload();
  }, 'Saved');
  const rows = (list.data || []).filter((r) => !search || (searchText ? searchText(r) : JSON.stringify(r)).toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHeader title={title} sub={sub} actions={<><Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} /><Button onClick={() => setEdit({ ...blank })}>+ Add</Button></>} />
      {extra}
      <Card>
        {list.loading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : <Table rows={rows} columns={columns} onRowClick={(r) => setEdit({ ...r })} />}
      </Card>
      {edit && (
        <Modal wide title={edit.id ? `Edit ${title.replace(/s$/, '').toLowerCase()}` : `Add ${title.replace(/s$/, '').toLowerCase()}`} onClose={() => setEdit(null)} footer={<Button busy={busy === 'save'} onClick={save}>Save</Button>}>
          <FormGrid fields={fields} value={edit} onChange={setEdit} />
          {renderExtraFields?.(edit, setEdit)}
        </Modal>
      )}
    </>
  );
}
