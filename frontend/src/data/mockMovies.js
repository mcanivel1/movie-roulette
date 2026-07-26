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
export const MOCK_MOVIES = [
  { id: 2, title: 'Harbor Lights', year: 2014, prequel: '', watched: true, posterUrl: null },
  { id: 3, title: 'Harbor Lights II: The Tide', year: 2017, prequel: 'Harbor Lights', watched: true, posterUrl: null },
  { id: 4, title: 'Harbor Lights III: Undertow', year: 2021, prequel: 'Harbor Lights II: The Tide', watched: false, posterUrl: null },
  { id: 5, title: 'Neon Meridian', year: 2019, prequel: '', watched: false, posterUrl: null },
  { id: 6, title: 'The Glass Orchard', year: 2016, prequel: '', watched: true, posterUrl: null },
  { id: 7, title: 'Glass Orchard: Winter', year: 2022, prequel: 'The Glass Orchard', watched: false, posterUrl: null },
  { id: 8, title: 'Glass Orchard: Requiem', year: 2024, prequel: 'Glass Orchard: Winter', watched: false, posterUrl: null },
  { id: 9, title: 'Static & Bloom', year: 2023, prequel: '', watched: false, posterUrl: null },
  { id: 10, title: 'Paper Moths', year: 2020, prequel: '', watched: true, posterUrl: null },
  { id: 11, title: 'Cinder & Salt II: Aftermath', year: 2025, prequel: 'Cinder & Salt', watched: false, posterUrl: null },
];
