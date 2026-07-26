import { useEffect, useState } from 'react';

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

  // Reset load state when the underlying movie/poster changes (e.g. deck
  // cycling through candidates, or a Sheet edit resolving a poster later).
  useEffect(() => {
    setStatus(movie.posterUrl ? 'loading' : 'unavailable');
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
