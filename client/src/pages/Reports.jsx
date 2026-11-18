import { useState } from 'react';
import { api } from '../api.js';
import { PageHeader, Card, Table, Select, Stat, Badge, Loading, ErrorBox, useLoad, money } from '../components/ui.jsx';

const pctText = (v) => (v === null || v === undefined ? '—' : `${v}%`);

export default function Reports() {
  const [days, setDays] = useState('90');
  const r = useLoad(() => api.get(`/reports?days=${days}`), [days]);
  const d = r.data;
  const perfCols = (first) => [
    first,
    { key: 'quotes', label: 'Quotes', align: 'center' },
    { key: 'won', label: 'Won', align: 'center' },
    { key: 'lost', label: 'Lost', align: 'center' },
    { key: 'open', label: 'Open', align: 'center' },
    { label: 'Win rate', render: (x) => pctText(x.win_rate), align: 'center' },
    { label: 'Avg margin', render: (x) => pctText(x.avg_margin_pct), align: 'center' },
    { label: `Profit won (${d?.currency})`, render: (x) => money(x.profit_won), align: 'right' },
  ];
  const maxLost = Math.max(1, ...(d?.lost_reasons || []).map((x) => x.n));
  return (
    <>
      <PageHeader title="Reports" sub="How your quoting is performing" actions={<Select value={days} onChange={(e) => setDays(e.target.value)} options={[{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '180', label: 'Last 6 months' }, { value: '365', label: 'Last 12 months' }]} />} />
      {r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : (
        <>
          <div className="stats">
            <Stat label="Quotes sent" value={d.summary.quotes} />
            <Stat label="Win rate" value={pctText(d.summary.win_rate)} />
            <Stat label="Average margin" value={pctText(d.summary.avg_margin_pct)} />
            <Stat label={`Profit on won quotes (${d.currency})`} value={money(d.summary.profit_won)} />
            <Stat label="Avg time to quote" value={d.summary.avg_response_hours !== null ? `${d.summary.avg_response_hours} h` : '—'} />
          </div>
          <div className="grid g2">
            <Card title="Why quotes were lost">
              {!d.lost_reasons.length ? <div className="empty">No lost quotes recorded.</div> : (
                <div className="stack-sm">
                  {d.lost_reasons.map((x) => (
                    <div key={x.reason} className="bar-row">
                      <span>{x.reason}</span>
                      <div className="bar"><div style={{ width: `${(x.n / maxLost) * 100}%` }} /></div>
                      <b>{x.n}</b>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Partner agents">
              <Table rows={d.agents} empty="No agents asked in this period." columns={[
                { key: 'company', label: 'Agent', render: (a) => <b>{a.company}</b> },
                { label: 'Asked', key: 'invited', align: 'center' },
                { label: 'Reply rate', render: (a) => pctText(a.reply_rate), align: 'center' },
                { label: 'Avg reply', render: (a) => (a.avg_reply_hours !== null ? `${a.avg_reply_hours} h` : '—'), align: 'center' },
                { label: 'Cheapest', render: (a) => a.cheapest_legs || '', align: 'center' },
                { label: 'Won', key: 'won', align: 'center' },
              ]} />
              <p className="muted small">"Cheapest" counts the legs where this agent had the lowest price.</p>
            </Card>
          </div>
          <Card title="By customer / requesting agent">
            <Table rows={d.by_requester} rowKey="name" empty="No quotes in this period." columns={perfCols({ label: 'Requested by', render: (x) => <>{x.name} {x.role === 'agent' && <Badge color="blue">agent</Badge>}</> })} />
          </Card>
          <Card title="By lane">
            <Table rows={d.by_lane} rowKey="pol" empty="No quotes in this period." columns={perfCols({ label: 'Lane', render: (x) => <>{x.mode} · {x.pol} → {x.pod}</> })} />
          </Card>
        </>
      )}
    </>
  );
}
