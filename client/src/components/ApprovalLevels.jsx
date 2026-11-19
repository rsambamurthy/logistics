// Approval levels: a quote whose margin falls below a level must be approved by someone holding that level's role.
import { Input, Select, Button } from './ui.jsx';

export default function ApprovalLevels({ value, roles = [], onChange, disabled }) {
  const rows = value || [];
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const options = roles.filter((r) => r.key !== 'admin').map((r) => ({ value: r.key, label: r.name }));
  return (
    <div className="stack-sm">
      {rows.map((l, i) => (
        <div key={i} className="level-row">
          <span>Margin below</span>
          <Input type="number" step="0.1" style={{ width: 90 }} disabled={disabled} value={l.below_pct} onChange={(e) => set(i, 'below_pct', e.target.value === '' ? '' : Number(e.target.value))} />
          <span>% → approved by</span>
          <Select style={{ width: 200 }} disabled={disabled} options={options} placeholder="— role —" value={l.role} onChange={(e) => set(i, 'role', e.target.value)} />
          {!disabled && <button type="button" className="link" onClick={() => onChange(rows.filter((_, j) => j !== i))}>remove</button>}
        </div>
      ))}
      {!rows.length && <div className="small muted">No approval levels: any quote can be sent without approval.</div>}
      {!disabled && <div><Button small variant="ghost" onClick={() => onChange([...rows, { below_pct: '', role: '' }])}>+ Add level</Button></div>}
      <div className="small muted">When a quote falls below several levels, the lowest one applies. Administrators can approve every level.</div>
    </div>
  );
}
