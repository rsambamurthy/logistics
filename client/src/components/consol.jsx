// Consolidation building blocks shared by the agent plan, the consol page and the job page.
import { useState } from 'react';
import { Button, Input, Select, Stat, Badge, money } from './ui.jsx';

const n2 = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/** Master totals: what shippers pay vs what the carrier charges, the gain and the free capacity. */
export function ConsolStats({ e, currency, capacity }) {
  if (!e) return null;
  const air = e.mode !== 'LCL';
  return (
    <div className="stats">
      <Stat label="Shipments" value={e.houses} />
      <Stat label="Gross kg" value={n2(e.gross)} />
      {air ? <Stat label="Volume kg" value={n2(e.volKg)} /> : <Stat label={`cbm${capacity?.cbm ? ` of ${capacity.cbm}` : ''}`} value={n2(e.cbm)} />}
      {air && <Stat label="Shippers pay (kg)" value={n2(e.sold)} />}
      {air && <Stat label="Carrier charges (kg)" value={n2(e.chargeable)} />}
      {air && <Stat label="Weight gain (kg)" value={n2(e.gain)} tone={e.gain > 0 ? 'good' : ''} />}
      {e.revenue !== null && e.revenue !== undefined && <Stat label="Freight sold" value={money(e.revenue, currency)} />}
      {e.cost !== null && e.cost !== undefined && <Stat label="Master cost" value={money(e.cost, currency)} />}
      {e.profit !== null && e.profit !== undefined && <Stat label="Consol profit" value={money(e.profit, currency)} tone={e.profit < 0 ? 'bad' : 'good'} />}
    </div>
  );
}

/** One line telling the desk what still fits for free. */
export function FreeSpace({ e }) {
  if (!e || e.mode === 'LCL') return null;
  if (e.freeWeight > 0) return <div className="alert alert-green small">Volume is paid for: up to <b>{n2(e.freeWeight)} kg</b> of dense cargo can still be added at no extra carrier cost.</div>;
  if (e.freeVolumeKg > 0) return <div className="alert alert-green small">Weight is paid for: bulky cargo up to <b>{n2(e.freeVolumeKg)} volume kg</b> can still be added at no extra carrier cost.</div>;
  return null;
}

/** Weights cell for a house: gross / volume → chargeable, with bulky or dense. */
export function HouseWeights({ w }) {
  if (!w) return '—';
  if (w.unit === 'W/M') return <span>{n2(w.gross)} kg · {n2(w.cbm)} cbm → <b>{n2(w.chargeable)} W/M</b></span>;
  return <span>{n2(w.gross)} kg / {n2(w.volKg)} vol → <b>{n2(w.chargeable)} kg</b> <Badge color={w.dense ? 'grey' : 'blue'}>{w.dense ? 'dense' : 'bulky'}</Badge></span>;
}

const blankPiece = { count: 1, l: '', w: '', h: '', unit: 'cm', kg: '' };

/** Pieces with dimensions (L × W × H, cm or inches). Volume kg = cm³ / 6000 or in³ / 366. */
export function PiecesEditor({ value, onSave, busy, disabled }) {
  const [rows, setRows] = useState(value?.length ? value : [blankPiece]);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const vol = rows.reduce((s, p) => s + (Number(p.count || 1) * Number(p.l || 0) * Number(p.w || 0) * Number(p.h || 0)) / (p.unit === 'in' ? 366 : 6000), 0);
  return (
    <div className="stack-sm">
      <table className="table compact">
        <thead><tr><th>Pieces</th><th>Length</th><th>Width</th><th>Height</th><th>Unit</th><th>Kg each</th><th /></tr></thead>
        <tbody>{rows.map((p, i) => (
          <tr key={i}>
            <td><Input type="number" min="1" style={{ width: 70 }} disabled={disabled} value={p.count} onChange={(e) => set(i, 'count', e.target.value)} /></td>
            {['l', 'w', 'h'].map((k) => <td key={k}><Input type="number" style={{ width: 80 }} disabled={disabled} value={p[k]} onChange={(e) => set(i, k, e.target.value)} /></td>)}
            <td><Select style={{ width: 70 }} disabled={disabled} options={[{ value: 'cm', label: 'cm' }, { value: 'in', label: 'in' }]} value={p.unit} onChange={(e) => set(i, 'unit', e.target.value)} /></td>
            <td><Input type="number" style={{ width: 80 }} disabled={disabled} value={p.kg ?? ''} onChange={(e) => set(i, 'kg', e.target.value)} /></td>
            <td>{!disabled && <button type="button" className="link" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="row gap-sm wrap">
        {!disabled && <Button small variant="ghost" onClick={() => setRows([...rows, { ...blankPiece, unit: rows[rows.length - 1]?.unit || 'cm' }])}>+ Add pieces</Button>}
        <span className="small muted">Volume weight: <b>{n2(vol)} kg</b> (cm ÷ 6000, inches ÷ 366)</span>
        <span className="spacer" />
        {!disabled && onSave && <Button small busy={busy} onClick={() => onSave(rows)}>Save dimensions</Button>}
      </div>
    </div>
  );
}

export const CONSOL_STATUS = {
  planning: ['blue', 'planning'], closed: ['amber', 'closed'], departed: ['blue', 'departed'], arrived: ['green', 'arrived'], cancelled: ['grey', 'cancelled'],
};
export const ConsolStatus = ({ status }) => <Badge color={CONSOL_STATUS[status]?.[0]}>{CONSOL_STATUS[status]?.[1] || status}</Badge>;
export const VERDICT = { ok: ['green', 'Agent: OK to consolidate'], check: ['amber', 'Agent: check before closing'], split: ['red', 'Agent: should not travel together'] };
