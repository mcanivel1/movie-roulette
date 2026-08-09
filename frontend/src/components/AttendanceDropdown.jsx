import { useEffect, useRef, useState } from 'react';
import { ROSTER, previewAttendanceEligibility } from '../lib/attendance';

/**
 * Attendance selector — header dropdown, "Variant A" from
 * docs/design/mockup-v2-features.html (the pre-shuffle gating-screen
 * alternative was mocked up and explicitly rejected — see SPEC.md's
 * "Attendance" section). Lives in App.jsx's topbar, visible regardless of
 * the active tab, per the mockup — its effect only matters to RouletteView,
 * which is handed `absentees` as a prop and appends `&absent=...` to its
 * list/spin calls (see lib/attendance.js and api.js).
 *
 * `movies` here is App's plain (attendance-*un*adjusted) movie list — used
 * only to compute the live "N eligible tonight" preview note as chips are
 * toggled, via previewAttendanceEligibility (the exact same rule *and*
 * empty-pool fallback the real spin will apply) so this note can never
 * show a number the Roulette tab then contradicts a moment later.
 */
export default function AttendanceDropdown({ movies, absentees, onToggleMember, onSelectAll }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const selectAllRef = useRef(null);

  const presentCount = ROSTER.length - absentees.length;
  const allPresent = absentees.length === 0;
  const nonePresent = absentees.length === ROSTER.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allPresent && !nonePresent;
    }
  }, [allPresent, nonePresent]);

  useEffect(() => {
    if (!open) return undefined;
    function handleDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('click', handleDocClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleDocClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const { count: eligibleCount, attendanceApplied } = previewAttendanceEligibility(movies, absentees);

  return (
    <div className="attn-popover-wrap" ref={wrapRef}>
      <button className="attn-trigger" type="button" onClick={() => setOpen((o) => !o)}>
        Tonight <span className="attn-count">{presentCount}/{ROSTER.length}</span>
      </button>
      {open && (
        <div className="attn-popover">
          <div className="attn-popover-head">
            <h3>Who&rsquo;s here tonight?</h3>
            <button className="attn-close" type="button" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <label className="select-all-row">
            <input
              type="checkbox"
              ref={selectAllRef}
              checked={allPresent}
              onChange={(e) => onSelectAll(e.target.checked)}
            />
            Select All
          </label>
          <div className="member-grid">
            {ROSTER.map((name) => {
              const present = !absentees.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  className={`member-chip ${present ? 'present' : 'absent'}`}
                  aria-pressed={present}
                  onClick={() => onToggleMember(name)}
                >
                  <span className="chip-dot" />
                  <span className="chip-name">{name}</span>
                </button>
              );
            })}
          </div>
          <p className="attn-eligible-note">
            {attendanceApplied === false ? (
              <>
                <b>{eligibleCount}</b> of <b>{movies.length}</b> films eligible tonight — that&rsquo;d leave nobody
                anything to watch, so attendance isn&rsquo;t narrowing the pool right now
              </>
            ) : (
              <>
                <b>{eligibleCount}</b> of <b>{movies.length}</b> films eligible tonight, adjusted for who&rsquo;s here
              </>
            )}
          </p>
          <button className="btn-primary attn-done-btn" type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}
