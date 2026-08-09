import { useEffect, useState } from 'react';
import { getDetails } from '../api';

// Same palette RouletteView's confetti burst cycles through — reused here
// just to give each platform pill's dot a bit of visual variety, since the
// backend doesn't send per-platform colors (see SPEC.md's `details` shape).
const DOT_COLORS = ['#ff5a47', '#2f5de3', '#ffc839', '#2fae6e'];

/**
 * Streaming platforms + memorable quotes strip for the Roulette reveal
 * panel, per SPEC.md's "Streaming platforms & memorable quotes" section and
 * the approved mockup's .extras-strip/.extras-drawer markup. Fetched lazily
 * right after reveal (never bundled into list/spin) so a slow TMDB/LLM
 * round-trip never delays the poster/title.
 *
 * The drawer chrome (toggle pill + collapsible panel) is always rendered;
 * styles.css only shows the toggle and applies the collapsed/expand
 * behavior below the ~640px breakpoint (see .extras-drawer-toggle /
 * .extras-drawer-panel) — above it, the panel is always fully visible and
 * the toggle is hidden, matching the mockup's desktop ("always expanded")
 * vs. mobile ("starts collapsed behind a 'More info' pill") treatments with
 * one shared component instead of two.
 */
export default function ExtrasStrip({ movieId }) {
  const [status, setStatus] = useState('loading'); // loading | loaded | error
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setData(null);
    setOpen(false);

    getDetails(movieId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setStatus('loaded');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [movieId]);

  const panelId = `extras-panel-${movieId}`;

  return (
    <div className="extras-drawer">
      <button
        className="extras-drawer-toggle"
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="extras-drawer-pill">
          More info
          <span className="extras-drawer-chevron" aria-hidden="true">▾</span>
        </span>
      </button>
      <div className={`extras-drawer-panel${open ? ' open' : ''}`} id={panelId}>
        <div className="extras-strip">
          {status === 'loading' && (
            <div className="extras-loading">
              <p className="extras-label">Streaming</p>
              <div className="skeleton-line w55" />
              <p className="extras-label" style={{ marginTop: 14 }}>Memorable quotes</p>
              <div className="skeleton-line w85" />
              <div className="skeleton-line w70" />
              <div className="skeleton-line w40" />
            </div>
          )}

          {status === 'error' && (
            <div className="extras-section">
              <p className="extras-empty">Couldn&rsquo;t load streaming &amp; quotes right now.</p>
            </div>
          )}

          {status === 'loaded' && data && (
            <>
              <div className="extras-section">
                <p className="extras-label">Streaming</p>
                {data.streamingPlatforms.length > 0 ? (
                  <div className="platform-pills">
                    {data.streamingPlatforms.map((name, i) => (
                      <span className="pill" key={name}>
                        <span className="dot" style={{ background: DOT_COLORS[i % DOT_COLORS.length] }} />
                        {name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="extras-empty">Not currently streaming anywhere we checked.</p>
                )}
              </div>
              <div className="extras-section">
                <p className="extras-label">Memorable quotes</p>
                {data.quotes.length > 0 ? (
                  <ul className="quote-list">
                    {data.quotes.map((quote, i) => (
                      // eslint-disable-next-line react/no-array-index-key -- quotes are unordered/unkeyed strings from the backend
                      <li key={i}>
                        <q>{quote}</q>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="extras-empty">No memorable quotes surfaced for this one.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
