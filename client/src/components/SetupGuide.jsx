// First-run checklist shown on the dashboard until the essentials are done (or dismissed).
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Card, Button, useLoad, useAction } from './ui.jsx';

export default function SetupGuide() {
  const nav = useNavigate();
  const s = useLoad(() => api.get('/onboarding'));
  const [busy, run] = useAction();
  if (!s.data || s.data.dismissed) return null;
  const { steps, done, total, complete } = s.data;
  const next = steps.find((x) => !x.done && !x.optional);
  const dismiss = () => run('d', async () => s.setData(await api.post('/onboarding/dismiss', {})));
  return (
    <Card
      title={complete ? 'You are all set 🎉' : `Get Quayly ready: ${done} of ${total} done`}
      actions={<Button small variant="ghost" busy={busy === 'd'} onClick={dismiss}>{complete ? 'Close' : 'Hide guide'}</Button>}
      className="setup"
    >
      <div className="progress"><div style={{ width: `${(done / total) * 100}%` }} /></div>
      <div className="steps">
        {steps.map((st) => (
          <div key={st.key} className={`step${st.done ? ' done' : ''}${next?.key === st.key ? ' next' : ''}`}>
            <span className="tick">{st.done ? '✓' : st.partial ? '…' : ''}</span>
            <div className="step-body">
              <b>{st.title}{st.progress && !st.done ? ` (${st.progress})` : ''}</b>
              <span className="small muted">{st.hint}</span>
            </div>
            {!st.done && <Button small variant={next?.key === st.key ? 'primary' : 'ghost'} onClick={() => nav(st.link)}>{st.action}</Button>}
          </div>
        ))}
      </div>
    </Card>
  );
}
