// Small shared pieces used on the RFQ page.
export function EmailPreviewNote({ data, quote }) {
  const snap = quote.snapshot || {};
  return (
    <div className="muted small stack-sm">
      {data.sourceEmail && <span>Sent as a reply in their original email thread "{data.sourceEmail.subject}".</span>}
      {snap.previous && <span>Marked as a revision of {snap.previous.ref}{snap.changes?.length ? `, listing ${snap.changes.length} change(s)` : ''}. The earlier version is closed once this is sent.</span>}
      <span>The PDF is attached{quote.language === 'zh' ? ' in Traditional Chinese' : ''}.</span>
    </div>
  );
}
