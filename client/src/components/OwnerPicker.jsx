// Who an RFQ or job belongs to. Roles that see only their own records see the ones they own here.
import { useState } from 'react';
import { api } from '../api.js';
import { Select, useLoad, useToast } from './ui.jsx';

export default function OwnerPicker({ value, createdBy, endpoint, onSaved, disabled }) {
  const users = useLoad(() => api.get('/users/assignable').catch(() => []));
  const [v, setV] = useState(value || '');
  const toast = useToast();
  const name = (id) => users.data?.find((u) => u.id === id)?.name;
  return (
    <label className="owner-picker small" title={createdBy ? `Created by ${name(createdBy) || 'someone'}` : undefined}>
      <span className="muted">Owner</span>
      <Select value={v} disabled={disabled} placeholder={createdBy ? `${name(createdBy) || 'Creator'} (created it)` : 'Not assigned'} options={(users.data || []).map((u) => ({ value: u.id, label: u.name }))}
        onChange={async (e) => {
          const next = e.target.value;
          setV(next);
          try { const r = await api.put(endpoint, { user_id: next || null }); toast('Owner changed'); onSaved?.(r); } catch (err) { setV(value || ''); toast(err.message, 'error'); }
        }} />
    </label>
  );
}
