import { useEffect, useRef, useState } from 'react';
import { spin as spinApi, setWatched as setWatchedApi, listMovies, ApiError } from '../api';
import PosterImage from './PosterImage';
import StarRating from './StarRating';
import ExtrasStrip from './ExtrasStrip';

const CHIP_COLORS = ['#ff5a47', '#2f5de3', '#ffc839', '#2fae6e'];
const CHIP_SHAPES = ['circle', 'square', 'tri'];

/**
 * The shuffle-deck spin mechanic, ported from the approved mockup's
 * doSpin/swapDeck/spawnBurst functions. Animation classes are toggled
 * imperatively on refs (like the mockup's vanilla JS) because the timing
 * (flick-out -> swap content -> flick-in/land, with forced reflows to
 * restart CSS animations) is easiest to keep faithful that way; React only
 * owns *what movie* is currently painted on the deck front and whether the
 * reveal panel is showing.
 *
 * Per the approved revision: the result REPLACES the spin area in place
 * (stage-spin gets [hidden], reveal renders in the same .stage) rather than
 * stacking below it. "Spin Again" re-runs the same doSpin() flow.
 */
export default function RouletteView({ movies, onRefreshMovies, active, absentees, onSetRating }) {
  const [deckMovie, setDeckMovie] = useState(null); // null => idle stub text
  const [spinning, setSpinning] = useState(false);
  const [showReveal, setShowReveal] = useState(false);
  const [revealMovie, setRevealMovie] = useState(null);
  const [markStatus, setMarkStatus] = useState('idle'); // idle | marking | marked
  const [spinError, setSpinError] = useState(null);

  // Attendance-adjusted pool (SPEC.md's "Attendance" section): when nobody's
  // marked absent this is left null and `movies` (the plain, unadjusted
  // list already fetched by App.jsx) is used directly -- no extra request
  // in the common/default case. Only when `absentees` is non-empty does
  // Roulette fetch its own list(absentees) so the pool count and
  // decoy-shuffle candidates built below stay consistent with what spin can
  // actually pick (same rule, same fallback), without changing what Library
  // shows for the same movies elsewhere.
  const [attnMovies, setAttnMovies] = useState(null);
  const [attendanceApplied, setAttendanceApplied] = useState(null);
  const [attnLoading, setAttnLoading] = useState(false);

  const deckElRef = useRef(null);
  const deckFrontRef = useRef(null);
  const burstLayerRef = useRef(null);
  const timeouts = useRef([]);

  useEffect(() => () => { timeouts.current.forEach(clearTimeout); }, []);

  useEffect(() => {
    if (!absentees || absentees.length === 0) {
      setAttnMovies(null);
      setAttendanceApplied(null);
      return undefined;
    }
    let cancelled = false;
    setAttnLoading(true);
    listMovies(absentees)
      .then(({ movies: list, attendanceApplied: applied }) => {
        if (cancelled) return;
        setAttnMovies(list);
        setAttendanceApplied(applied ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setAttnMovies(null);
          setAttendanceApplied(null);
        }
      })
      .finally(() => {
        if (!cancelled) setAttnLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [absentees, movies]);

  const poolMovies = attnMovies ?? movies;

  // Warm the browser's image cache for every possible decoy well before any
  // spin happens. Without this, a decoy tick can land on a poster that
  // hasn't finished loading yet -- it shows a skeleton, then the real image
  // pops in late in that tick's ~90ms hold (sometimes barely before the
  // next tick's flick-out already starts), so that one card visibly gets
  // less hold time than the others and the shuffle reads as briefly
  // speeding up. Preloading means PosterImage's cache check almost always
  // resolves synchronously, so every tick gets its full, even hold time.
  useEffect(() => {
    poolMovies.filter((m) => m.eligible && m.posterUrl).forEach((m) => {
      const img = new Image();
      img.src = m.posterUrl;
    });
  }, [poolMovies]);

  function scheduleTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    timeouts.current.push(id);
    return id;
  }

  const eligibleMovies = poolMovies.filter((m) => m.eligible);
  const poolCount = eligibleMovies.length;

  function spawnBurst() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const layer = burstLayerRef.current;
    if (reduceMotion || !layer) return;
    const count = 9;
    for (let i = 0; i < count; i++) {
      const chip = document.createElement('span');
      const shape = CHIP_SHAPES[Math.floor(Math.random() * CHIP_SHAPES.length)];
      const color = CHIP_COLORS[Math.floor(Math.random() * CHIP_COLORS.length)];
      chip.className = `chip ${shape}`;
      if (shape === 'tri') chip.style.borderBottomColor = color;
      else chip.style.background = color;
      const angle = (Math.PI * 2) * (i / count) + (Math.random() * 0.6 - 0.3);
      const dist = 70 + Math.random() * 50;
      chip.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
      chip.style.setProperty('--ty', `${Math.sin(angle) * dist - 20}px`);
      chip.style.setProperty('--rot', `${Math.random() * 360 - 180}deg`);
      layer.appendChild(chip);
      scheduleTimeout(() => chip.remove(), 760);
    }
  }

  function swapDeck(movie, isFinal, reduceMotion, cb) {
    const front = deckFrontRef.current;
    if (!front) return;
    front.classList.remove('land');
    front.classList.add('flick-out');
    scheduleTimeout(() => {
      setDeckMovie(movie);
      front.classList.remove('flick-out');
      if (isFinal) {
        // Force reflow so the 'land' animation restarts cleanly.
        void front.offsetWidth;
        front.classList.add('land');
        deckElRef.current?.classList.add('settle');
        spawnBurst();
        scheduleTimeout(() => deckElRef.current?.classList.remove('settle'), 660);
      } else {
        void front.offsetWidth;
        front.classList.add('flick-in');
        scheduleTimeout(() => front.classList.remove('flick-in'), 230);
      }
      if (cb) cb();
    }, reduceMotion ? 0 : 140);
  }

  async function doSpin() {
    if (spinning || poolCount === 0) return;
    setSpinning(true);
    setShowReveal(false);
    setSpinError(null);
    setMarkStatus('idle');

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Fire the network request without awaiting it yet, so the shuffle can
    // start immediately in parallel instead of sitting idle until it
    // resolves -- the request's latency (Apps Script's redirect hop, a
    // full sheet re-read, sometimes a live TMDB lookup) gets absorbed into
    // motion you're already watching rather than being a dead pause before
    // anything moves.
    const spinPromise = spinApi(absentees);

    // Indefinite decoy shuffle: no fixed length, since we don't yet know
    // how long the request will take. Runs at a constant brisk tempo (the
    // deceleration curve below is for the *landing*, once we know the
    // real answer and can time a satisfying finish). `cancelled` stops it
    // cleanly once the request settles, one way or the other.
    let cancelled = false;
    const runDecoyTick = () => {
      if (cancelled) return;
      const decoy = eligibleMovies[Math.floor(Math.random() * eligibleMovies.length)];
      swapDeck(decoy, false, reduceMotion, () => {
        if (!cancelled) scheduleTimeout(runDecoyTick, 90);
      });
    };
    if (!reduceMotion) runDecoyTick();

    let selected = null;
    try {
      const res = await spinPromise;
      selected = res.movie;
      if (res.attendanceApplied !== undefined) setAttendanceApplied(res.attendanceApplied);
    } catch (err) {
      setSpinError(err instanceof ApiError ? err.code : 'spin_failed');
    }
    cancelled = true;

    if (!selected) {
      // Graceful failure: flick the deck back to its idle placeholder
      // instead of leaving it frozen on whatever decoy happened to be
      // showing when the request failed -- makes it clear the attempt
      // ended, not stuck. The error line below explains why.
      swapDeck(null, false, reduceMotion, () => setSpinning(false));
      return;
    }

    // Short decelerating landing run ending on the real pick. Shorter than
    // a full spin sequence used to be, since we've already been shuffling
    // this whole time -- this is just the "slowing down to land" tail.
    const decoys = eligibleMovies.filter((m) => m.id !== selected.id);
    const landLen = reduceMotion ? 1 : 5 + Math.floor(Math.random() * 3);
    const sequence = [];
    for (let i = 0; i < landLen - 1; i++) {
      sequence.push(decoys.length ? decoys[Math.floor(Math.random() * decoys.length)] : selected);
    }
    sequence.push(selected);

    const delays = [];
    for (let d = 0; d < landLen; d++) {
      delays.push(reduceMotion ? 0 : Math.round(90 + (d / landLen) * (d / landLen) * 220));
    }

    let idx = 0;
    const step = () => {
      const movie = sequence[idx];
      const isFinal = idx === sequence.length - 1;
      swapDeck(movie, isFinal, reduceMotion, () => {
        idx++;
        if (idx < sequence.length) {
          scheduleTimeout(step, delays[idx]);
        } else {
          setSpinning(false);
          scheduleTimeout(() => {
            setRevealMovie(selected);
            setShowReveal(true);
          }, reduceMotion ? 0 : 720);
        }
      });
    };
    step();
  }

  async function handleMarkWatched() {
    if (!revealMovie || markStatus !== 'idle') return;
    setMarkStatus('marking');
    try {
      await setWatchedApi(revealMovie.id, true);
      setMarkStatus('marked');
    } catch {
      setMarkStatus('idle');
    } finally {
      onRefreshMovies();
    }
  }

  return (
    <section className={`view${active ? ' active' : ''}`}>
      <div className="stage">
        <div className="stage-spin" hidden={showReveal}>
          <div className="deck" ref={deckElRef}>
            <div className="deck-back a" />
            <div className="deck-back b" />
            <div className="deck-front ticket" ref={deckFrontRef}>
              {deckMovie ? (
                <PosterImage movie={deckMovie} />
              ) : (
                <div className="stub-idle">Tap Spin to pick tonight&rsquo;s movie</div>
              )}
            </div>
            <div className="burst-layer" ref={burstLayerRef} />
          </div>

          <p className={`pool-status${poolCount === 0 ? ' empty' : ''}`}>
            {poolCount === 0
              ? 'No films eligible — mark a prequel watched first'
              : <>
                  <b>{poolCount}</b> film{poolCount === 1 ? '' : 's'} eligible tonight
                </>}
          </p>

          {attendanceApplied === false && (
            <p className="pool-status">
              Couldn&rsquo;t narrow by attendance without emptying the pool — showing everyone&rsquo;s films instead.
            </p>
          )}

          {spinError && (
            <p className="pool-status empty">Couldn&rsquo;t spin — please try again.</p>
          )}

          <button
            className="spin-btn"
            disabled={spinning || poolCount === 0 || attnLoading}
            onClick={doSpin}
          >
            Spin the Roulette
          </button>
        </div>

        {showReveal && revealMovie && (() => {
          // Title/year/poster/prequel stay pinned to the movie the spin
          // actually picked (revealMovie), but watched/rating are mutable
          // fields App.jsx's `movies` keeps live (optimistic rating patches,
          // refresh() after marking watched) -- so once that same id shows
          // up there again, prefer its copy for those two fields instead of
          // the frozen spin-time snapshot.
          const live = movies.find((m) => m.id === revealMovie.id) ?? revealMovie;
          const isWatched = markStatus === 'marked' || live.watched;
          return (
            <div className="reveal enter">
              <div className="poster ticket">
                <div className="stub-head">
                  <span>{revealMovie.year}</span>
                  <span className="stub-dot" />
                </div>
                <PosterImage movie={revealMovie} />
                <div className="stub-foot">
                  <span className="poster-title">{revealMovie.title}</span>
                </div>
              </div>
              <div className="reveal-info">
                <p className="reveal-eyebrow">
                  {revealMovie.prequel ? `Sequel to ${revealMovie.prequel}` : 'Standalone feature'}
                </p>
                <div className="reveal-title-row">
                  <h2 className="reveal-title">{revealMovie.title}</h2>
                  <span className="reveal-year">{revealMovie.year}</span>
                </div>
                {isWatched && (
                  <StarRating
                    rating={live.rating}
                    onRate={(value) => onSetRating(revealMovie.id, value)}
                    size="lg"
                    label={`Rate ${revealMovie.title}`}
                  />
                )}
                <div className="reveal-actions">
                  <button
                    className="btn-primary"
                    disabled={markStatus !== 'idle' || live.watched}
                    onClick={handleMarkWatched}
                  >
                    {markStatus === 'marked' || live.watched
                      ? 'Marked as Watched'
                      : markStatus === 'marking'
                      ? 'Marking…'
                      : 'Mark as Watched'}
                  </button>
                  <button className="btn-ghost" onClick={doSpin}>Spin Again</button>
                </div>
                <ExtrasStrip movieId={revealMovie.id} />
              </div>
            </div>
          );
        })()}
      </div>
    </section>
  );
}
