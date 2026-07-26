import { useState } from 'react';
import PosterImage from './PosterImage';

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

export default function LibraryView({ movies, onToggleWatched }) {
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
    <section className="view active">
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
            return (
              <div className="card" key={movie.id}>
                <div className={`card-poster${st.key === 'locked' ? ' locked' : ''}`}>
                  <PosterImage movie={movie} />
                  <span className={`card-status ${st.key}`}>{st.key === 'locked' ? 'Waiting' : st.label}</span>
                </div>
                <div className="card-body">
                  <div className="card-title">{movie.title}</div>
                  <div className="card-meta">{movie.year}</div>
                  <div className="card-chain">
                    {st.key === 'locked' && movie.waitingOn ? (
                      <>Waiting on <b>{movie.waitingOn}</b></>
                    ) : movie.prequel ? (
                      <>Sequel to <b>{movie.prequel}</b></>
                    ) : null}
                  </div>
                  <button
                    className={`card-action${movie.watched ? ' is-watched' : ''}`}
                    onClick={() => onToggleWatched(movie.id, !movie.watched)}
                  >
                    {movie.watched ? 'Watched — undo' : 'Mark as Watched'}
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
