// Audit entries as a table. Used by Settings → Activity log and the RFQ History tab.
import { Link } from 'react-router-dom';
import { Table, fmtDateTime } from './ui.jsx';

export default function ActivityList({ rows, showRfq = true, empty = 'No activity yet.' }) {
  return (
    <Table
      rows={rows}
      empty={empty}
      columns={[
        { label: 'When', render: (a) => <span className="small">{fmtDateTime(a.at)}</span> },
        { label: 'Who', render: (a) => (a.user_id ? a.user_name : <span className="muted">{a.user_name}</span>) },
        { label: 'What', render: (a) => <><b>{a.action}</b>{a.summary && <div className="small muted">{a.summary}</div>}</> },
        ...(showRfq ? [{ label: 'RFQ', render: (a) => (a.rfq_id ? <Link to={`/rfqs/${a.rfq_id}`}>{a.rfq_ref || `#${a.rfq_id}`}</Link> : '') }] : []),
      ]}
    />
  );
}
