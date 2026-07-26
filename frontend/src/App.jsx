import { useCallback, useEffect, useState } from 'react';
import { listMovies, setWatched } from './api';
import RouletteView from './components/RouletteView';
import LibraryView from './components/LibraryView';

export default function App() {
  const [tab, setTab] = useState('roulette');
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
    // Optimistic update so the Library grid feels instant; refresh() below
    // reconciles with the source of truth (also recomputes eligible/waitingOn
    // for any downstream sequels).
    setMovies((prev) => prev.map((m) => (m.id === id ? { ...m, watched } : m)));
    try {
      await setWatched(id, watched);
    } catch {
      // Optimistic update above gets rolled back by refresh() below
      // regardless (network failure, bad token, stale id, ...).
    } finally {
      refresh();
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
            <LibraryView movies={movies} onToggleWatched={handleToggleWatched} active={tab === 'library'} />
          </>
        )}
      </main>

      <footer className="credit">Movie art via TMDB</footer>
    </div>
  );
}
