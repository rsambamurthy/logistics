// The agent's delay prediction for a job: risk, expected arrival, the reasons, and "warn the customer".
import { api } from '../api.js';
import { Button, Badge, useAction } from './ui.jsx';

export const RISK = { on_time: ['green', 'on time'], at_risk: ['amber', 'delay likely'], late: ['red', 'late'], arrived: ['grey', 'arrived'], unknown: ['grey', 'no ETA yet'] };
export const RiskBadge = ({ r }) => (r?.risk ? <Badge color={RISK[r.risk]?.[0]}>{RISK[r.risk]?.[1]}{r.risk === 'at_risk' && r.probability ? ` ${Math.round(r.probability * 100)}%` : ''}</Badge> : null);
const days = (h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`);

export default function DelayRisk({ job, onChanged, canManage }) {
  const [busy, run] = useAction();
  const r = job.delay_risk;
  const recheck = () => run('re', async () => { await api.post(`/jobs/${job.id}/delay`); await onChanged(); });
  if (!r || ['arrived', 'unknown'].includes(r.risk)) return null;
  const tone = r.risk === 'late' ? 'alert-red' : r.risk === 'at_risk' ? 'alert-amber' : 'alert-green';
  return (
    <div className={`alert ${tone} small`}>
      <div className="row gap-sm wrap">
        <b>Delay prediction:</b> <RiskBadge r={r} />
        {r.risk === 'on_time' ? <span>Expected on time{r.eta ? ` (${r.eta})` : ''}.</span>
          : <span>Expected around <b>{r.expected_eta}</b>{r.delay_hours ? `, about ${days(r.delay_hours)} late` : ''}{r.eta ? ` (carrier / booked ETA ${r.eta})` : ''}.</span>}
        <span className="spacer" />
        <button type="button" className="link" disabled={busy === 're'} onClick={recheck}>check again</button>
        {canManage && ['at_risk', 'late'].includes(r.risk) && (r.warned_eta === r.expected_eta
          ? <span className="muted">customer told {r.warned_at ? new Date(r.warned_at).toLocaleDateString('en-GB') : ''}</span>
          : <Button small busy={busy === 'warn'} onClick={() => run('warn', async () => { await api.post(`/jobs/${job.id}/delay/warn`); await onChanged(); }, 'Customer emailed')}>Warn the customer</Button>)}
      </div>
      {r.signals?.length > 0 && <ul className="reasons">{r.signals.map((s) => <li key={s.type}>{s.text}</li>)}</ul>}
    </div>
  );
}
