export default function InstallPage({ apiKey }) {
  // Vite dev server (full Docker mode) proxies only the API; the collector runs on :4000.
  // In lite mode or a hosted deployment everything is served from this same origin.
  const ingest = window.location.port === '5173'
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : window.location.origin;
  const snippet = `<script src="${ingest}/tracker.js" data-key="${apiKey}" defer></script>`;
  return (
    <div className="stack">
      <section className="card">
        <h2>Install the tracking snippet</h2>
        <p>Paste this into the <code>&lt;head&gt;</code> of every page. Page views (including single-page-app route changes) are tracked automatically.</p>
        <pre><code>{snippet}</code></pre>
        <p>Track custom events and conversions from your own code:</p>
        <pre><code>{`graphpulse.track('newsletter_subscribe', { source: 'footer' });
graphpulse.convert('signup', { plan: 'growth' });   // becomes a CONVERTED edge in the graph`}</code></pre>
        <p className="muted small">Add <code>data-respect-dnt</code> to the script tag to honour browsers' Do Not Track setting.</p>
      </section>
      <section className="card">
        <h2>Try it</h2>
        <p>
          The ingestion service hosts an instrumented demo site at{' '}
          <a href={`${ingest}/demo/index.html`} target="_blank" rel="noreferrer">{ingest}/demo/</a>.
          Click around, then watch the Real-time widget.
        </p>
      </section>
    </div>
  );
}
