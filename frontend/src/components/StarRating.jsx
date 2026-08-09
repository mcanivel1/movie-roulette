import { useEffect, useRef, useState } from 'react';
import { snapToHalfStar } from '../lib/rating';

const FULL_STAR_ROW = '★★★★★';
const EMPTY_STAR_ROW = '☆☆☆☆☆';

/**
 * Half-star rating widget, ported from docs/design/mockup-v2-features.html's
 * setupRatingDemo (see the mockup's inline comments for the full rationale).
 * Two distinct states share one paint: a live PREVIEW (hover, or a touch
 * drag) that follows the pointer but is never persisted, and the COMMITTED
 * value (click / touchend / arrow keys), which is what the widget falls
 * back to the instant the pointer leaves or a touch ends without moving.
 *
 * `rating` is the movie's current committed rating (null when unrated).
 * `onRate(newRating)` is called on every commit — the caller (LibraryView /
 * RouletteView, via App.jsx's handleSetRating) owns persisting it and
 * patches its own state optimistically, so this widget also keeps a small
 * `committed` mirror of `rating` that updates instantly on commit rather
 * than waiting a render cycle for the new `rating` prop to arrive.
 *
 * The star-fill width transition and the commit "pulse" are both plain CSS
 * (see styles.css), so the app-wide prefers-reduced-motion rule that zeroes
 * every animation/transition duration already covers this widget with no
 * extra JS-side handling needed.
 */
export default function StarRating({ rating, onRate, size = 'sm', label }) {
  const [committed, setCommitted] = useState(rating ?? 0);
  const [preview, setPreview] = useState(null);
  const [pulsing, setPulsing] = useState(false);
  const widgetRef = useRef(null);

  // Stay in sync with the caller's source of truth (e.g. once a background
  // refresh() confirms/corrects the optimistic value).
  useEffect(() => {
    setCommitted(rating ?? 0);
  }, [rating]);

  useEffect(() => {
    if (!pulsing) return undefined;
    const t = setTimeout(() => setPulsing(false), 380);
    return () => clearTimeout(t);
  }, [pulsing]);

  // touchmove needs preventDefault (so a drag across the stars doesn't also
  // scroll the page), and React attaches touch listeners passively by
  // default — so this has to be a manual, non-passive DOM listener rather
  // than a JSX onTouchMove prop, same reasoning as the mockup's vanilla JS.
  useEffect(() => {
    const el = widgetRef.current;
    if (!el) return undefined;
    function handleTouchMove(e) {
      if (!e.touches || !e.touches[0]) return;
      setPreview(valueFromClientX(e.touches[0].clientX));
      e.preventDefault();
    }
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', handleTouchMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- valueFromClientX only reads the ref, stable across renders
  }, []);

  function valueFromClientX(clientX) {
    const el = widgetRef.current;
    if (!el) return 0.5;
    const rect = el.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return snapToHalfStar(ratio * 5);
  }

  function commit(value) {
    setPreview(null);
    setCommitted(value);
    setPulsing(false);
    setPulsing(true);
    onRate(value);
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      commit(Math.min(5, committed + 0.5 || 0.5));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      commit(Math.max(0.5, committed - 0.5));
    }
  }

  const display = preview ?? committed;
  const isRated = display > 0;
  const pct = Math.max(0, Math.min(5, display)) / 5 * 100;

  return (
    <div className={`rating-demo${isRated ? ' is-rated' : ''}`}>
      <div className="rating-row">
        <div
          ref={widgetRef}
          className={`star-rating ${size}${pulsing ? ' pulse' : ''}`}
          data-interactive="true"
          tabIndex={0}
          role="slider"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={5}
          aria-valuenow={display}
          onMouseMove={(e) => setPreview(valueFromClientX(e.clientX))}
          onMouseLeave={() => setPreview(null)}
          onClick={(e) => commit(valueFromClientX(e.clientX))}
          onTouchStart={(e) => {
            if (e.touches[0]) setPreview(valueFromClientX(e.touches[0].clientX));
          }}
          onTouchEnd={(e) => {
            if (e.changedTouches[0]) commit(valueFromClientX(e.changedTouches[0].clientX));
          }}
          onKeyDown={handleKeyDown}
        >
          <div className="star-row star-back">{EMPTY_STAR_ROW}</div>
          <div className="star-fill" style={{ width: `${pct}%` }}>
            <div className="star-row">{FULL_STAR_ROW}</div>
          </div>
        </div>
        <span className="rating-readout">
          {display > 0 ? (
            <>
              <b>{display.toFixed(1)}</b> / 5
            </>
          ) : (
            'Not rated yet'
          )}
        </span>
      </div>
    </div>
  );
}
