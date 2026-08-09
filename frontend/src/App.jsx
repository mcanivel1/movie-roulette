import { useCallback, useEffect, useState } from 'react';
import { listMovies, setWatched, setRating } from './api';
import RouletteView from './components/RouletteView';
import LibraryView from './components/LibraryView';
import AttendanceDropdown from './components/AttendanceDropdown';
import { ROSTER } from './lib/attendance';

export default function App() {
  const [tab, setTab] = useState('roulette');
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  // Who's absent tonight, per SPEC.md's "Attendance" section — a plain
  // array of roster names. Lives here (not in RouletteView) because the
  // selector itself is visible regardless of the active tab, per the
  // approved mockup, even though its effect only matters to Roulette.
  const [absentees, setAbsentees] = useState([]);

  const refresh = useCallback(async () => {
    try {
      const { movies: list } = await listMovies();
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

  async function handleSetRating(id, rating) {
    // Unlike watched-toggling, a rating change never affects any OTHER
    // row's eligible/waitingOn -- so, unlike handleToggleWatched above,
    // there's no correctness reason to hold off on an optimistic update.
    // Patch local state immediately so the star widget paints instantly,
    // then persist in the background and resync via refresh() either way
    // (self-healing if the write fails or the value gets clamped/rejected).
    setMovies((prev) => prev.map((m) => (m.id === id ? { ...m, rating } : m)));
    try {
      await setRating(id, rating);
    } catch {
      // ignore -- refresh() below reflects whatever's actually true
    } finally {
      await refresh();
    }
  }

  function handleToggleMember(name) {
    setAbsentees((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  function handleSelectAll(makeAllPresent) {
    // Mirrors the mockup's "Select All" checkbox exactly: checking it marks
    // everyone present (clears absentees), unchecking it marks everyone
    // absent -- it's a real select-all/select-none toggle, not just a
    // shortcut for the all-present case.
    setAbsentees(makeAllPresent ? [] : [...ROSTER]);
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-spacer" aria-hidden="true" />
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
        <AttendanceDropdown
          movies={movies}
          absentees={absentees}
          onToggleMember={handleToggleMember}
          onSelectAll={handleSelectAll}
        />
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
            <RouletteView
              movies={movies}
              onRefreshMovies={refresh}
              active={tab === 'roulette'}
              absentees={absentees}
              onSetRating={handleSetRating}
            />
            <LibraryView
              movies={movies}
              onToggleWatched={handleToggleWatched}
              onSetRating={handleSetRating}
              active={tab === 'library'}
              pendingId={pendingId}
            />
          </>
        )}
      </main>

      <footer className="credit">Movie art via TMDB</footer>
    </div>
  );
}
