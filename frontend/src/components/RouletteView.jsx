import { useEffect, useRef, useState } from 'react';
import { spin as spinApi, setWatched as setWatchedApi, ApiError } from '../api';
import PosterImage from './PosterImage';

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
export default function RouletteView({ movies, onRefreshMovies }) {
  const [deckMovie, setDeckMovie] = useState(null); // null => idle stub text
  const [spinning, setSpinning] = useState(false);
  const [showReveal, setShowReveal] = useState(false);
  const [revealMovie, setRevealMovie] = useState(null);
  const [markStatus, setMarkStatus] = useState('idle'); // idle | marking | marked
  const [spinError, setSpinError] = useState(null);

  const deckElRef = useRef(null);
  const deckFrontRef = useRef(null);
  const burstLayerRef = useRef(null);
  const timeouts = useRef([]);

  useEffect(() => () => { timeouts.current.forEach(clearTimeout); }, []);

  function scheduleTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    timeouts.current.push(id);
    return id;
  }

  const eligibleMovies = movies.filter((m) => m.eligible);
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

    let selected = null;
    try {
      const res = await spinApi();
      selected = res.movie;
    } catch (err) {
      setSpinError(err instanceof ApiError ? err.code : 'spin_failed');
    }

    if (!selected) {
      setSpinning(false);
      return;
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const decoys = eligibleMovies.filter((m) => m.id !== selected.id);
    const seqLen = reduceMotion ? 1 : 9 + Math.floor(Math.random() * 4);
    const sequence = [];
    for (let i = 0; i < seqLen - 1; i++) {
      sequence.push(decoys.length ? decoys[Math.floor(Math.random() * decoys.length)] : selected);
    }
    sequence.push(selected);

    const delays = [];
    for (let d = 0; d < seqLen; d++) {
      delays.push(reduceMotion ? 0 : Math.round(70 + (d / seqLen) * (d / seqLen) * 230));
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
    <section className="view active">
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

          {spinError && (
            <p className="pool-status empty">Couldn&rsquo;t spin — please try again.</p>
          )}

          <button
            className="spin-btn"
            disabled={spinning || poolCount === 0}
            onClick={doSpin}
          >
            Spin the Roulette
          </button>
        </div>

        {showReveal && revealMovie && (
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
              <h2 className="reveal-title">{revealMovie.title}</h2>
              <p className="reveal-year">{revealMovie.year}</p>
              <div className="reveal-actions">
                <button
                  className="btn-primary"
                  disabled={markStatus !== 'idle'}
                  onClick={handleMarkWatched}
                >
                  {markStatus === 'marked'
                    ? 'Marked as Watched'
                    : markStatus === 'marking'
                    ? 'Marking…'
                    : 'Mark as Watched'}
                </button>
                <button className="btn-ghost" onClick={doSpin}>Spin Again</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
