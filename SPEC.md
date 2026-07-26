# Movie Roulette — Spec

A small app that picks a movie to watch from a Google Sheet, using a "roulette" that only
offers movies that are unwatched and whose prequel (if any) has already been watched.

## Hosting model

- **Frontend**: static site (Vite + React), deployed to **GitHub Pages**. No server runtime available.
- **Backend**: a **Google Apps Script** Web App bound to (or with access to) the Google Sheet.
  Apps Script runs inside Google's infrastructure, so it needs no separate hosting, and it can
  read/write the Sheet natively via `SpreadsheetApp` with no credential files to manage.
- The frontend calls the Apps Script Web App URL over `fetch()` (CORS-friendly JSON responses).
- Because the frontend is static files in a public repo, the Apps Script URL cannot be a true
  secret. It's protected by a shared token (see "API contract" below) as a deterrent, not real
  security. Good enough for a personal/family app; not intended to protect sensitive data.

## Google Sheet shape

One row per movie. Column order is not guaranteed and there may be extra columns — resolve
columns by matching the header row (case-insensitive, trimmed) rather than by fixed index.

| Header (case-insensitive) | Type | Notes |
|---|---|---|
| `Movie` | string | Movie title. Required. |
| `Year` | integer or date | Release year. If a date, use its year. |
| `Prequel` | string | Title of another row's `Movie`, or blank. Must match another row's title (trimmed, case-insensitive) when present. |
| `Watched` | boolean | `TRUE`/`FALSE` (or truthy string variants Sheets may store). |
| `Poster URL` | string | **Optional, app-managed.** Cache for the resolved poster image URL (see Posters below). If this column doesn't exist yet, the backend creates it on first write. Users may hand-edit a cell to override a wrong match. |

Any other columns are ignored.

## Posters (real artwork, via TMDB)

Poster art is **real movie poster images from The Movie Database (TMDB)**, not generated. This
must go through the backend, not the frontend, because:

- The frontend is a public static bundle (GitHub Pages) — any API key embedded in it is public.
- A TMDB API key must stay server-side, so **only the Apps Script backend calls TMDB**, using a
  key stored in Script Properties (`TMDB_API_KEY`), never sent to the client.

Resolution flow (in the backend, per row, when building the `list`/`spin` response):
1. If the row's `Poster URL` cell is already populated, use it as-is (no network call).
2. Otherwise, call TMDB `GET /search/movie?query=<title>&year=<year>`, take the top result's
   `poster_path`, build `https://image.tmdb.org/t/p/w500<poster_path>`, and **write that URL back
   into the row's `Poster URL` cell** (creating the column if needed) so future requests are free
   and instant. If TMDB has no match, leave the cell blank and return `posterUrl: null` — don't
   retry every single request; a blank cell means "checked, no match" only if paired with a
   sentinel (e.g. write the literal string `none` and treat that as "checked, skip"), otherwise
   every list call would re-search unmatched titles. Use that sentinel approach.
3. The frontend never talks to TMDB directly — it only ever renders whatever `posterUrl` the
   backend returns.
4. If `posterUrl` is null, the frontend shows a plain fallback card: the same ticket-card frame
   (notches, rules, title caption) with a flat neutral fill and a small "Poster unavailable"
   label — no generated art, just an honest empty state.
5. Include a small "Movie art via TMDB" text credit somewhere unobtrusive (e.g. the footer) — 
   required by TMDB's terms of use for apps using their API/images.

Setting up the free TMDB API key is a manual step for the human running this project (documented
in `apps-script/README.md`), same category of step as deploying the Apps Script itself.

## Core business logic (must be pure, unit-testable functions — no Sheets/Apps Script globals)

```
eligible(movie, allMovies) =
     movie.watched === false
  && (movie.prequel is empty
      OR the movie in allMovies whose title matches movie.prequel (case-insensitive, trimmed) has watched === true)
```

- If `movie.prequel` is set but does **not** match any row's title, treat the movie as **not eligible**
  (fail closed — a dangling reference shouldn't cause a broken spin) and surface a `waitingOn` value
  of the raw prequel text so the UI can still show *why*.
- `waitingOn`: if not eligible solely because of an unwatched/unresolved prequel, this is that
  prequel's title (as referenced). Otherwise `null`.
- Spin selection = uniform-random pick among all rows where `eligible === true`. If the eligible
  list is empty, the API returns `{ movie: null }` and the frontend shows an empty state — never
  an error.

## API contract (Apps Script Web App)

All requests include a `token` (query param on GET, JSON body field on POST) matched against a
value stored in Script Properties (`SHARED_TOKEN`). Missing/incorrect token → HTTP 200 with
`{ error: "unauthorized" }` (Apps Script can't set arbitrary HTTP status codes on doGet/doPost
easily, so errors are signaled in the JSON body — the frontend must check `error` first on every
response).

**Movie object** (shape returned by `list` and `spin`):
```json
{
  "id": 5,
  "title": "Harbor Lights III: Undertow",
  "year": 2021,
  "prequel": "Harbor Lights II: The Tide",
  "watched": false,
  "eligible": true,
  "waitingOn": null,
  "posterUrl": "https://image.tmdb.org/t/p/w500/abc123.jpg"
}
```
`posterUrl` is `null` when TMDB has no match (see Posters section) — the frontend must handle
that, not assume it's always present.
`id` is the movie's absolute row number in the sheet (1-indexed, including the header row), used
as the stable identifier for updates. Never re-derive `id` from title.

### `GET ?token=...&action=list`
→ `{ "movies": [ Movie, ... ] }`

### `GET ?token=...&action=spin`
→ `{ "movie": Movie }` or `{ "movie": null }` when nothing is eligible.
Does **not** mutate the sheet — selection only. Marking watched is a separate call.

### `POST` body `{ "token": "...", "action": "setWatched", "id": 5, "watched": true }`
→ `{ "movie": Movie }` (the updated row, re-read after write) or `{ "error": "not_found" }` if
`id` doesn't match a row. `watched` accepts `true` or `false` (the Library view allows undoing a
watched mark).

### Errors
Always `{ "error": "<short_code>" }` on failure, HTTP 200. Known codes: `unauthorized`,
`not_found`, `bad_request`, `sheet_error`.

### CORS gotcha — read this before wiring the POST call

Apps Script Web Apps don't handle CORS **preflight** (`OPTIONS`) requests properly. If the
frontend sends the POST with an explicit `Content-Type: application/json` header, the browser
will preflight it and the call will fail. Avoid the preflight entirely by calling
`fetch(url, { method: 'POST', body: JSON.stringify(payload) })` with **no headers object at
all** — an unset Content-Type on a string body defaults to `text/plain;charset=UTF-8`, which is a
CORS "simple request" and skips preflight. On the backend, `doPost(e)` must parse
`e.postData.contents` as JSON regardless of the declared content type (don't branch on
`e.postData.type`). Both devs must follow this exact convention or the two sides won't talk to
each other.

## Design system (already approved — see `docs/design/approved-mockup.html`)

Treat that file as the source of truth for visuals and interaction. It's a single-file working
prototype (fake in-memory data) — port its structure/behavior into real components, don't
re-derive the design from scratch. Key points:

- **Palette**: warm paper white ground (`#faf7f0`), ink navy text (`#211d2b`), one confident
  coral accent (`#ff5a47`) for the primary action, cobalt (`#2f5de3`) and yellow (`#ffc839`) used
  sparingly for status/art. Light theme only — deliberate choice, not an oversight.
- **Type**: Bricolage Grotesque (display/titles), Hanken Grotesk (UI/body), Space Mono
  (year/metadata). Font files are in `docs/design/fonts/` — self-host them (`@font-face` from
  `/fonts/...woff2` in the built app), don't refetch from Google Fonts.
- **Posters are real TMDB artwork** (see the "Posters" section above), not generated. The
  approved mockup's canvas-drawn riso-print art was a placeholder for real photos and should
  **not** be ported as-is — replace the `<canvas>` poster with a real `<img>` (`object-fit:
  cover`, 2:3 aspect box matching TMDB's poster ratio) inside the same ticket-card frame. Keep
  the ticket-card chrome (notches, dashed year rule, title caption strip) — only the art itself
  changes from generated to a real photo. Show a lightweight loading state while the image
  fetches, and the flat "Poster unavailable" fallback (not generated art) when `posterUrl` is
  `null`.
- **Ticket-card motif**: every poster/card has small circular notches on the left/right edges
  (ticket-stub illusion) and a dashed rule separating a small header strip (year) from the art,
  and a solid rule separating the art from the title caption below it.
- **Roulette mechanic**: a small "deck" of ticket cards that shuffles (front card flicks out,
  next candidate flicks in, decelerating), lands with an elastic bounce + a small confetti-chip
  burst in the palette colors, **then the result replaces the spin area in place** (not stacked
  below it). "Spin Again" swaps back to the deck and re-shuffles.
- **Library tab**: segmented filter (All / Unwatched / Watched) with counts, card grid with a
  status pill — `Watched` (amber), `Unwatched` (cobalt, eligible-to-spin), or `Waiting` (grey,
  shows "Waiting on <prequel title>" when locked by an unwatched prequel).
- **No app title/wordmark in the header** — just the Roulette/Library tab switcher, centered.
- **Responsive**: must include `<meta name="viewport" content="width=device-width, initial-scale=1">`
  (easy to forget and breaks mobile entirely — the mockup shipped without it initially and had to
  be fixed). Reveal panel collapses from two columns to one below ~640px; library grid reflows
  via `auto-fill`; deck sizes with `clamp()`.

## Team workflow

1. **Backend dev** builds the Apps Script project (`apps-script/`) implementing the contract
   above, with the pure logic functions unit-tested (mock `SpreadsheetApp`/`PropertiesService`,
   don't require real Google credentials to run tests). Notifies QA when ready.
2. **Frontend dev** builds the UI (`frontend/`) from the approved mockup in parallel, against a
   local mock implementing the same API contract, so it doesn't have to wait on the backend to
   make UI progress. Does not wire up the real API yet.
3. **QA** tests the backend logic once notified. Loops with backend dev on any issues.
4. Once backend passes QA, frontend dev wires the app to the real Apps Script contract (swapping
   the mock for real `fetch()` calls) and notifies QA.
5. **QA** tests the full wired app (including edge cases: empty eligible pool, dangling prequel
   reference, marking watched, mobile viewport). Loops with whichever dev owns the issue.
