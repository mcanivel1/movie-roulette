// Throwaway in-memory mock dataset used by src/api.js while USE_MOCK is on.
// Adapted from docs/design/approved-mockup.html's sample data (the Harbor
// Lights / Glass Orchard trilogies), reshaped to the Movie object fields
// SPEC.md defines (`id` as an integer row number, `prequel` as the
// referenced title string, `posterUrl` present on every row).
//
// posterUrl is null for all rows — this is mock data, not real TMDB
// resolution (that only ever happens server-side, per SPEC.md's Posters
// section) — so every poster renders the honest "Poster unavailable"
// fallback state until the app is wired to the real backend.
//
// Row 11 is a deliberate dangling-prequel example: its `prequel` doesn't
// match any other row's title, exercising the "fail closed" rule.
//
// `rating` and `seenBy` are the v2 fields from SPEC.md's "Ratings" and
// "Attendance" sections. `seenBy` deliberately varies per movie/member so
// toggling different attendees in the mock UI exercises both the normal
// attendance-filtering path (some eligible movies get filtered out) and the
// empty-pool fallback path (marking almost everyone absent).
import { ROSTER } from '../lib/attendance';

function seenBy(present) {
  const map = {};
  ROSTER.forEach((name) => {
    map[name] = present.includes(name);
  });
  return map;
}

export const MOCK_MOVIES = [
  {
    id: 2,
    title: 'Harbor Lights',
    year: 2014,
    prequel: '',
    watched: true,
    rating: 4.5,
    posterUrl: null,
    seenBy: seenBy(['Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle']),
  },
  {
    id: 3,
    title: 'Harbor Lights II: The Tide',
    year: 2017,
    prequel: 'Harbor Lights',
    watched: true,
    rating: null,
    posterUrl: null,
    seenBy: seenBy(['Austin', 'Josh', 'Lynda', 'Mel']),
  },
  {
    id: 4,
    title: 'Harbor Lights III: Undertow',
    year: 2021,
    prequel: 'Harbor Lights II: The Tide',
    watched: false,
    rating: null,
    posterUrl: null,
    seenBy: seenBy(['Austin', 'Mel']),
  },
  {
    id: 5,
    title: 'Neon Meridian',
    year: 2019,
    prequel: '',
    watched: false,
    rating: null,
    posterUrl: null,
    seenBy: seenBy(['Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel', 'Michelle']),
  },
  {
    id: 6,
    title: 'The Glass Orchard',
    year: 2016,
    prequel: '',
    watched: true,
    rating: 3,
    posterUrl: null,
    seenBy: seenBy(ROSTER),
  },
  {
    id: 7,
    title: 'Glass Orchard: Winter',
    year: 2022,
    prequel: 'The Glass Orchard',
    watched: false,
    rating: null,
    posterUrl: null,
    seenBy: seenBy(['Eugie', 'Jouissance']),
  },
  {
    id: 8,
    title: 'Glass Orchard: Requiem',
    year: 2024,
    prequel: 'Glass Orchard: Winter',
    watched: false,
    rating: null,
    posterUrl: null,
    seenBy: seenBy([]),
  },
  {
    id: 9,
    title: 'Static & Bloom',
    year: 2023,
    prequel: '',
    watched: false,
    rating: null,
    posterUrl: null,
    // Deliberately NOT seen-by-everyone (unlike the other eligible rows'
    // partial overlaps) -- with every roster member marked absent, no
    // eligible movie satisfies "every absentee has seen it", so the
    // attendance filter empties the pool and exercises the fallback rule.
    seenBy: seenBy(['Austin', 'Eugie', 'Josh', 'Jouissance', 'Lynda', 'Marvin', 'Mel']),
  },
  {
    id: 10,
    title: 'Paper Moths',
    year: 2020,
    prequel: '',
    watched: true,
    rating: null,
    posterUrl: null,
    seenBy: seenBy(['Austin', 'Eugie', 'Lynda']),
  },
  {
    id: 11,
    title: 'Cinder & Salt II: Aftermath',
    year: 2025,
    prequel: 'Cinder & Salt',
    watched: false,
    rating: null,
    posterUrl: null,
    seenBy: seenBy([]),
  },
];

// Fake "details" (streaming platforms + memorable quotes) for the mock
// action=details endpoint, keyed by movie id — see SPEC.md's "Streaming
// platforms & memorable quotes" section. Movies with no entry here still
// return a valid response with empty arrays (a legitimate state, not an
// error), same as the real backend would for an unmatched/quote-less title.
export const MOCK_DETAILS = {
  2: {
    streamingPlatforms: ['Netflix', 'Max'],
    quotes: [
      'The tide doesn’t forgive. It just forgets. — Mara Voss',
      'You don’t leave the harbor. The harbor leaves you. — Cal Renner',
    ],
  },
  4: {
    streamingPlatforms: ['Netflix', 'Hulu', 'Apple TV+'],
    quotes: [
      'We don’t chase the light. We become it. — Reyna Voss',
      'Every city has a frequency. Ours just happens to be broken. — Dorian Cade',
      'I didn’t come back for the money. I came back for the noise. — Reyna Voss',
    ],
  },
  5: {
    streamingPlatforms: [],
    quotes: ['Some nights the neon remembers you before you remember it. — Wren Aoki'],
  },
  9: {
    streamingPlatforms: ['Hulu'],
    quotes: [],
  },
};
