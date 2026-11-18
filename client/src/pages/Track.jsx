// Public shipment tracking page (no login). Opened from the link in customer emails.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, Badge } from '../components/ui.jsx';
import { fmtLocal } from '../components/jobs.jsx';
import TrackMap from '../components/TrackMap.jsx';

const STEP_LABEL = { booked: 'Booked', departed: 'Departed', arrived: 'Arrived', completed: 'Delivered' };

function Timeline({ steps, step }) {
  return (
    <div className="tl">
      {steps.map((s, i) => (
        <div key={s} className={`tl-step${i <= step ? ' done' : ''}${i === step ? ' now' : ''}`}>
          <span className="tl-dot" />
          <span>{STEP_LABEL[s] || s}</span>
        </div>
      ))}
    </div>
  );
}

export default function Track() {
  const token = location.pathname.split('/').pop();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const load = () => api.get(`/public/track/${encodeURIComponent(token)}`).then(setD).catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [token]);
  if (error) return <div className="track-page"><div className="track-card"><h2>Shipment tracking</h2><p>{error}</p></div></div>;
  if (!d) return <Loading />;
  const air = d.mode === 'AIR';
  const eta = d.eta?.actual ? d.eta.at : d.predicted_eta || d.eta?.at;
  const rows = [
    [air ? 'Airline' : 'Shipping line', d.carrier],
    [air ? 'Flight' : 'Vessel / voyage', air ? d.flight : [d.vessel, d.voyage].filter(Boolean).join(' / ')],
    [air ? 'AWB' : 'BL no.', d.bl_no],
    ['Booking no.', d.booking_no],
    [d.etd?.actual || d.atd ? 'Departed' : 'Expected departure', d.etd?.at ? fmtLocal(d.etd.at.replace(' ', 'T')) : d.atd ? fmtLocal(d.atd) : null],
    [d.eta?.actual || d.ata ? 'Arrived' : 'Expected arrival', eta ? fmtLocal(String(eta).replace(' ', 'T')) : d.ata ? fmtLocal(d.ata) : null],
    ['Containers', (d.containers || []).map((c) => c.number).filter(Boolean).join(', ')],
    ['Cargo', [d.cargo?.commodity, d.cargo?.packages && `${d.cargo.packages} pkgs`, d.cargo?.weight && `${d.cargo.weight} kg`].filter(Boolean).join(' · ')],
    ...Object.entries(d.cutoffs || {}).map(([k, v]) => [`${{ si: 'SI', vgm: 'VGM', gate_in: 'Gate-in', docs: 'Docs', customs: 'Customs' }[k] || k} cut-off`, fmtLocal(v)]),
  ].filter(([, v]) => v);
  return (
    <div className="track-page">
      <header className="track-head">
        {d.company.logo ? <img src={d.company.logo} alt="" /> : null}
        <div><b>{d.company.name}</b><div className="small muted">{[d.company.phone, d.company.email].filter(Boolean).join(' · ')}</div></div>
      </header>
      <div className="track-card">
        <div className="row between wrap gap">
          <div>
            <div className="small muted">Shipment {d.customer_ref ? `· your ref ${d.customer_ref}` : ''}</div>
            <h2 style={{ margin: '2px 0' }}>{d.ref}</h2>
            <div>{[d.route.from, d.route.pol, d.route.pod, d.route.to].filter((x, i, a) => x && a.indexOf(x) === i).join('  →  ')}</div>
          </div>
          {d.status === 'cancelled' ? <Badge color="red">Cancelled</Badge> : eta && !(d.eta?.actual || d.ata) ? <div className="track-eta"><span className="small muted">Expected arrival</span><b>{fmtLocal(String(eta).replace(' ', 'T')).replace(/ \d\d:\d\d$/, '')}</b></div> : null}
        </div>
        {d.step !== null && <Timeline steps={d.steps} step={d.step} />}
        {(d.path?.length > 0 || d.position) && <TrackMap path={d.path} position={d.position} />}
        {d.position?.at && <div className="small muted" style={{ marginTop: 4 }}>Vessel position as of {fmtLocal(d.position.at.replace(' ', 'T'))}</div>}
        <dl className="kv" style={{ marginTop: 16 }}>
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </div>
      {d.events?.length > 0 && (
        <div className="track-card">
          <h3 style={{ marginTop: 0 }}>Tracking events</h3>
          <ul className="track-events">
            {[...d.events].reverse().map((e, i) => (
              <li key={i} className={e.actual ? '' : 'planned'}>
                <span className="when">{fmtLocal(String(e.at || '').replace(' ', 'T'))}{e.actual ? '' : ' (planned)'}</span>
                <span><b>{e.description || e.label}</b>{e.location ? ` — ${e.location}` : ''}{e.container ? <span className="small muted"> · {e.container}</span> : null}{e.vessel ? <span className="small muted"> · {e.vessel}{e.voyage ? ` ${e.voyage}` : ''}</span> : null}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="small muted center">{d.live ? `Live data${d.updated_at ? `, updated ${new Date(d.updated_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}. ` : ''}Times are local to each port. Questions? Reply to our email.</p>
      <p className="small muted center">Powered by Quayly</p>
    </div>
  );
}
