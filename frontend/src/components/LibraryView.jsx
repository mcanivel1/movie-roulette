import { useState } from 'react';
import PosterImage from './PosterImage';
import StarRating from './StarRating';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unwatched', label: 'Unwatched' },
  { key: 'watched', label: 'Watched' },
];

function statusFor(movie) {
  if (movie.watched) return { key: 'watched', label: 'Watched' };
  if (movie.eligible) return { key: 'ready', label: 'Unwatched' };
  return { key: 'locked', label: movie.waitingOn ? `Waiting on ${movie.waitingOn}` : 'Waiting' };
}

export default function LibraryView({ movies, onToggleWatched, onSetRating, active, pendingId }) {
  const [filter, setFilter] = useState('all');

  const watchedCount = movies.filter((m) => m.watched).length;
  const unwatchedCount = movies.length - watchedCount;
  const counts = { all: movies.length, unwatched: unwatchedCount, watched: watchedCount };

  const list = movies.filter((m) => {
    if (filter === 'watched') return m.watched;
    if (filter === 'unwatched') return !m.watched;
    return true;
  });

  return (
    <section className={`view${active ? ' active' : ''}`}>
      <div className="library-controls">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`seg${filter === f.key ? ' active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label} <span className="count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <p className="empty-grid-note">Nothing here yet.</p>
      ) : (
        <div className="grid">
          {list.map((movie) => {
            const st = statusFor(movie);
            const isPending = movie.id === pendingId;
            return (
              <div className="card" key={movie.id}>
                <div className={`card-poster${st.key === 'locked' ? ' locked' : ''}`}>
                  <PosterImage movie={movie} />
                  <span className={`card-status ${st.key}`}>{st.key === 'locked' ? 'Waiting' : st.label}</span>
                </div>
                <div className="card-body">
                  <div className="card-title-row">
                    <span className="card-title">{movie.title}</span>
                    <span className="card-meta">{movie.year}</span>
                  </div>
                  {movie.watched && (
                    <StarRating
                      rating={movie.rating}
                      onRate={(value) => onSetRating(movie.id, value)}
                      size="sm"
                      label={`Rate ${movie.title}`}
                    />
                  )}
                  <div className="card-chain">
                    {st.key === 'locked' && movie.waitingOn ? (
                      <>Waiting on <b>{movie.waitingOn}</b></>
                    ) : movie.prequel ? (
                      <>Sequel to <b>{movie.prequel}</b></>
                    ) : null}
                  </div>
                  <button
                    className={`card-action${movie.watched ? ' is-watched' : ''}${isPending ? ' is-pending' : ''}`}
                    disabled={isPending}
                    onClick={() => onToggleWatched(movie.id, !movie.watched)}
                  >
                    {isPending ? (
                      <>
                        <span className="spinner" aria-hidden="true" />
                        Marking&hellip;
                      </>
                    ) : movie.watched ? 'Mark as Unwatched' : 'Mark as Watched'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
