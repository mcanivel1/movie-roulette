import { useCallback, useEffect, useState } from 'react';
import { listMovies, setWatched } from './api';
import RouletteView from './components/RouletteView';
import LibraryView from './components/LibraryView';

export default function App() {
  const [tab, setTab] = useState('roulette');
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listMovies();
      setMovies(list);
      setError(null);
    } catch {
      setError('Could not load movies.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleToggleWatched(id, watched) {
    // No optimistic flip here on purpose: this movie's own watched state
    // isn't the only thing that can change -- a sequel's eligible/waitingOn
    // depends on it too, and that only becomes correct once refresh() has
    // actually re-read the sheet. Flipping this button instantly (while
    // dependent cards elsewhere hadn't caught up yet) read as a bug, so
    // instead the clicked card shows a pending/spinner state and every
    // card updates together, once, when the real result comes back.
    setPendingId(id);
    try {
      await setWatched(id, watched);
    } catch {
      // refresh() below reflects whatever the real state actually is
      // regardless of whether this call succeeded.
    } finally {
      await refresh();
      setPendingId(null);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <nav className="tabs">
          <button
            className={`tab${tab === 'roulette' ? ' active' : ''}`}
            onClick={() => setTab('roulette')}
          >
            Roulette
          </button>
          <button
            className={`tab${tab === 'library' ? ' active' : ''}`}
            onClick={() => setTab('library')}
          >
            Library
          </button>
        </nav>
      </header>

      <main>
        {loading ? (
          <p className="loading-note">Loading movies…</p>
        ) : error ? (
          <p className="loading-note">{error}</p>
        ) : (
          <>
            {/* Both views stay mounted so RouletteView's in-progress spin/
                reveal state survives switching to Library and back --
                conditionally rendering one or the other would unmount and
                reset it every time. Visibility is CSS-driven via `active`. */}
            <RouletteView movies={movies} onRefreshMovies={refresh} active={tab === 'roulette'} />
            <LibraryView movies={movies} onToggleWatched={handleToggleWatched} active={tab === 'library'} pendingId={pendingId} />
          </>
        )}
      </main>

      <footer className="credit">Movie art via TMDB</footer>
    </div>
  );
}
