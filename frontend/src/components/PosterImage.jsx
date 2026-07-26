import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Renders the poster art for a movie inside whatever ticket-card chrome the
 * caller has already set up (deck ticket / reveal poster / library card).
 * This is the one deliberate deviation from the approved mockup: real
 * <img> pointed at the backend-resolved TMDB posterUrl, not canvas-drawn
 * generative art. Three states, per SPEC.md's Posters section:
 *   - posterUrl === null            -> flat neutral "Poster unavailable" card
 *   - posterUrl set, image loading  -> shimmering skeleton
 *   - posterUrl set, image loaded   -> fades in over the skeleton
 */
export default function PosterImage({ movie }) {
  const hasUrl = Boolean(movie.posterUrl);
  const [status, setStatus] = useState(hasUrl ? 'loading' : 'unavailable');
  const imgRef = useRef(null);

  // Reset AND check-if-already-cached both happen here, synchronously, in
  // one layout effect -- not split across a passive useEffect (reset) and
  // a separate useLayoutEffect (cache check). Splitting them left a window
  // during rapid deck shuffling where a render could commit the *new*
  // movie's <img src> while `status` (and its 'is-loaded' class) was still
  // whatever the *previous* movie had left behind, since the passive
  // effect resetting it only runs after paint. That showed up as a blank
  // flash: a fully-opaque, not-yet-loaded image. Resetting first and then
  // upgrading to 'loaded' if already cached -- all before paint -- means
  // there's no state for a stale status to ever be visible in.
  useLayoutEffect(() => {
    if (!movie.posterUrl) {
      setStatus('unavailable');
      return;
    }
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      setStatus('loaded');
    } else {
      setStatus('loading');
    }
  }, [movie.posterUrl, movie.id]);

  if (!hasUrl || status === 'unavailable') {
    return (
      <div className="poster-fallback">
        <span>Poster unavailable</span>
      </div>
    );
  }

  return (
    <div className="poster-img-wrap">
      {status === 'loading' && <div className="poster-skeleton" aria-hidden="true" />}
      <img
        ref={imgRef}
        className={`poster-img${status === 'loaded' ? ' is-loaded' : ''}`}
        src={movie.posterUrl}
        alt={`${movie.title} poster`}
        loading="lazy"
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('unavailable')}
      />
    </div>
  );
}
