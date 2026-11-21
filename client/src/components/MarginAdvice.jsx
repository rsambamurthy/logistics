// The agent's margin suggestion: chance of winning and expected profit at each margin, learnt from
// this company's won and lost quotes.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, money } from './ui.jsx';

export default function MarginAdvice({ rfqId, buy, current, currency, onUse }) {
  const [a, setA] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!buy) return undefined;
    const t = setTimeout(() => api.post(`/rfqs/${rfqId}/margin-advice`, { buy, current }).then(setA).catch(() => setA(null)), 400);
    return () => clearTimeout(t);
  }, [rfqId, buy, current]);
  if (!a?.best) return null;
  const same = a.current && Math.abs(a.current.margin - a.best.margin) < 0.25;
  const pct = (p) => `${Math.round(p * 100)}%`;
  return (
    <div className="alert alert-blue small margin-advice">
      <div className="row gap-sm wrap">
        <b>Agent's margin advice:</b>
        {same ? <span>your {a.current.margin}% is about right: {pct(a.current.p)} chance to win, expected profit {money(a.current.expected, currency)}.</span>
          : <span><b>{a.best.margin}%</b> gives the best expected profit: {pct(a.best.p)} chance to win, {money(a.best.expected, currency)} expected
            {a.current && <> (at {a.current.margin}%: {pct(a.current.p)}, {money(a.current.expected, currency)})</>}.</span>}
        <span className="spacer" />
        {!same && <Button small onClick={() => onUse(a.best.margin)}>Use {a.best.margin}%</Button>}
        <button type="button" className="link" onClick={() => setOpen(!open)}>{open ? 'hide' : 'why?'}</button>
      </div>
      {open && (
        <div className="stack-sm">
          <Curve curve={a.curve} best={a.best} current={a.current} />
          <ul className="reasons">{a.reasons.map((r) => <li key={r}>{r}</li>)}<li>Confidence: {a.confidence}{a.confidence === 'low' ? ' (it learns as quotes are won and lost; mark lost quotes with a reason)' : ''}.</li></ul>
        </div>
      )}
    </div>
  );
}

/** Chance of winning (line) and expected profit (bars) across margins. */
function Curve({ curve, best, current }) {
  const pts = curve.filter((c) => c.margin <= 40);
  const W = 520; const H = 120; const max = Math.max(...pts.map((c) => c.expected), 1);
  const x = (m) => 30 + (m / 40) * (W - 40);
  return (
    <svg viewBox={`0 0 ${W} ${H + 24}`} style={{ width: '100%', maxWidth: 560 }} role="img" aria-label="Win chance and expected profit by margin">
      {pts.map((c) => <rect key={c.margin} x={x(c.margin) - 3} y={H - (c.expected / max) * (H - 10)} width={5} height={(c.expected / max) * (H - 10)} fill="#bfdbfe" />)}
      <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={pts.map((c) => `${x(c.margin)},${H - c.p * (H - 10)}`).join(' ')} />
      <line x1={x(best.margin)} x2={x(best.margin)} y1={4} y2={H} stroke="#15803d" strokeDasharray="4 3" />
      {current && <line x1={x(current.margin)} x2={x(current.margin)} y1={4} y2={H} stroke="#b45309" strokeDasharray="2 3" />}
      {[0, 10, 20, 30, 40].map((m) => <text key={m} x={x(m)} y={H + 16} fontSize="10" textAnchor="middle" fill="#64748b">{m}%</text>)}
      <text x={W - 4} y={12} fontSize="10" textAnchor="end" fill="#2563eb">— chance to win</text>
      <text x={W - 4} y={26} fontSize="10" textAnchor="end" fill="#64748b">▮ expected profit</text>
    </svg>
  );
}
