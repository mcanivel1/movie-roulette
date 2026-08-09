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
| `Rating` | number (0.5 steps) | User-set star rating for a watched movie, 0.5–5.0 in half-star steps. Blank if not yet rated. See "Ratings" below. |
| `Austin`, `Eugie`, `Josh`, `Jouissance`, `Lynda`, `Marvin`, `Mel`, `Michelle` | boolean | One column per group member (fixed roster). Truthy (same truthy-string rules as `Watched`) means that person has personally seen this movie; blank/falsy means they haven't. See "Attendance" below. |

Any other columns (e.g. `Comments`) are ignored.

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

## Ratings

Once a movie's `Watched` cell is true, the user can rate it 1–5 stars in half-star steps (10
possible values: 0.5, 1, 1.5, ... 5). The rating control appears wherever a watched movie is shown —
the Roulette reveal panel (right after marking watched) and the Library tab's card grid — per the
approved mockup (`docs/design/mockup-v2-features.html`).

- Stored directly in the sheet's `Rating` column as a plain number. No caching/derivation involved,
  unlike posters — this is a direct user write, same category as `Watched`.
- `POST { token, action: "setRating", id, rating }` → `{ movie: updatedMovie }` (re-read after
  write) or `{ error: "not_found" }` / `{ error: "bad_request" }` if `id` doesn't match a row or
  `rating` isn't `null` or a valid half-step number in `[0.5, 5]`. `rating: null` clears an existing
  rating (mirrors `Watched`'s undo-friendly `true`/`false` convention).
- The backend does not require `watched === true` before accepting a rating write — the frontend is
  responsible for only exposing the control on watched movies. Keeps the backend simple; a stray
  rating on an unwatched row is harmless.
- `rating` is `null` in the public Movie object when the cell is blank, otherwise the parsed number.

## Streaming platforms & memorable quotes

When a movie is revealed after a spin, the Roulette tab shows two small, secondary pieces of info
below the poster/title (never competing with them for attention, per the approved mockup) — which
streaming platforms currently carry the movie, and a short list of memorable quotes. Both are
**fetched lazily**, in a separate call made right after the reveal (not bundled into `list`/`spin`),
so a slow TMDB/LLM round-trip never delays the poster/title appearing. The frontend shows a loading
state for this strip while the call is in flight (on mobile, per the approved mockup, this content
starts collapsed behind a small "More info" pill on a dashed rule and expands on tap — that's an
approved design, not exploratory).

`GET ?token=...&action=details&id=<id>` → `{ "streamingPlatforms": ["Netflix", "Hulu"], "quotes":
["...", "..."] }`. Either array may be empty (no known providers / no quotes found) — never an
error; empty is a valid, expected state per the mockup's empty-state treatment. `{ "error":
"not_found" }` if `id` doesn't match a row.

**Streaming platforms** — TMDB's `GET /movie/{tmdb_id}/watch/providers` endpoint (same TMDB
account/key as posters, `TMDB_API_KEY`). Use a single fixed region (`US`) — there's no per-user
locale to key off of. Resolving the TMDB movie id reuses the same search-by-title(+year) lookup
posters already do. Cache the resolved provider list server-side (Apps Script `CacheService`, keyed
by movie id or title, a multi-hour TTL is fine) — nothing in the sheet schema is reserved for this,
unlike posters, so it doesn't get sheet-cell persistence.

**Quotes** — generated by an LLM call at request time (this app has no verified quotes data
source), using the **Google Gemini API** (`generateContent`, a current free-tier-eligible Flash
model), via a new `GEMINI_API_KEY` Script Property (same never-leaves-the-backend rule as
`TMDB_API_KEY` — GitHub Pages is a public static bundle, so this key can never ship in the frontend
build). Chosen specifically so this app can run at zero cost — no billing account required, unlike
the Anthropic API. Call `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
with the key on the `x-goog-api-key` header (not a query param), and use
`generationConfig: { responseMimeType: "application/json", responseSchema: {...} }` to get back a
strict JSON array of quote strings rather than free-form text to parse. Cache the result the same
way as streaming platforms (`CacheService`, keyed by title) — an LLM call is slower and costlier
than a cache hit, and quotes for a given movie don't change. Ask for 2-4 short quotes, attributed to
a character where natural. There is no verification step and no in-UI disclaimer — the product
owner explicitly chose not to disclose the "may not be exact" caveat in the approved mockup, so
don't add one. Handle Gemini's safety-block case (a candidate with no content, `finishReason:
"SAFETY"` or similar) the same way TMDB/network failures are already handled elsewhere in this
file: return an empty quotes array for that row, and don't write anything to the cache, so the next
request retries instead of permanently caching a false "no quotes" result.

## Attendance

Before spinning, the user can mark who's present tonight out of a fixed 8-person roster: Austin,
Eugie, Josh, Jouissance, Lynda, Marvin, Mel, Michelle (same names as the sheet's per-member
columns). All are present by default; the UI is a header dropdown (the approved mockup's "Variant
A" — a gating pre-shuffle screen was also mocked up and explicitly rejected in favor of this one),
with a "Select All" shortcut and individual toggles.

**Rule**: on top of normal eligibility, a movie is only offered if every *absent* member has
already personally seen it (their sheet column is truthy) — the goal is protecting people who are
away from having a movie spoiled without them. Presence never removes a movie that's otherwise
eligible; only absence can, and only for movies an absent person hasn't seen.

**Fallback**: if applying that filter would leave zero eligible movies, drop the attendance
criterion entirely for that request (fall back to plain eligibility, ignoring who's absent) rather
than showing an empty pool — per the product owner's explicit instruction. When this fallback kicks
in, say so in the response (`attendanceApplied`, below) so the UI can reflect it instead of silently
pretending attendance had no effect.

**Wire format**: the frontend sends absent members as a comma-separated `absent` param (member
names, matched case-insensitively/trimmed against the fixed roster) on `GET action=list` and
`GET action=spin` — e.g. `&absent=Austin,Josh`. Omitting `absent` (or sending it empty) means
"everyone's here," identical to today's behavior. When `absent` is present and non-empty:
- The response's `eligible`/`waitingOn` per movie reflect the attendance-adjusted computation, so
  the Roulette pool count and decoy-shuffle candidates the frontend already builds from `list` stay
  consistent with what `spin` can actually pick.
- A top-level `attendanceApplied: true|false` field is added to the `list`/`spin` response — `false`
  when the fallback above kicked in (pool would've been empty) and attendance was ignored, `true`
  otherwise. Absent from the response when `absent` wasn't sent at all.
- Each movie in `list`'s response also gets a `seenBy` map (`{ "Austin": true, "Eugie": false, ... }`,
  one entry per roster member) so the frontend can show attendance-aware messaging without a second
  request.

This logic must be pure/testable like the rest of `Logic.js` — no `SpreadsheetApp` references; take
plain movie+roster data in, return the adjusted list out.

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
  "rating": null,
  "eligible": true,
  "waitingOn": null,
  "posterUrl": "https://image.tmdb.org/t/p/w500/abc123.jpg",
  "seenBy": { "Austin": true, "Eugie": false, "Josh": true, "Jouissance": false, "Lynda": true, "Marvin": false, "Mel": true, "Michelle": false }
}
```
`posterUrl` is `null` when TMDB has no match (see Posters section) — the frontend must handle
that, not assume it's always present. `rating` is `null` until the user rates a watched movie (see
Ratings). `seenBy` is always present in `list` responses (see Attendance).
`id` is the movie's absolute row number in the sheet (1-indexed, including the header row), used
as the stable identifier for updates. Never re-derive `id` from title.

### `GET ?token=...&action=list[&absent=Name,Name,...]`
→ `{ "movies": [ Movie, ... ], "attendanceApplied"?: true|false }`
`attendanceApplied` is only present when `absent` was sent non-empty (see Attendance).

### `GET ?token=...&action=spin[&absent=Name,Name,...]`
→ `{ "movie": Movie, "attendanceApplied"?: true|false }` or `{ "movie": null }` when nothing is
eligible. Does **not** mutate the sheet — selection only. Marking watched is a separate call.

### `GET ?token=...&action=details&id=5`
→ `{ "streamingPlatforms": ["Netflix", "Hulu"], "quotes": ["...", "..."] }` or
`{ "error": "not_found" }`. See "Streaming platforms & memorable quotes". Lazy/secondary call, not
bundled into `list`/`spin`.

### `POST` body `{ "token": "...", "action": "setWatched", "id": 5, "watched": true }`
→ `{ "movie": Movie }` (the updated row, re-read after write) or `{ "error": "not_found" }` if
`id` doesn't match a row. `watched` accepts `true` or `false` (the Library view allows undoing a
watched mark).

### `POST` body `{ "token": "...", "action": "setRating", "id": 5, "rating": 4.5 }`
→ `{ "movie": Movie }` (re-read after write) or `{ "error": "not_found" }` / `{ "error":
"bad_request" }` if `rating` isn't `null` or a half-step number in `[0.5, 5]`. See "Ratings".

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

## Design system (already approved — see `docs/design/approved-mockup.html` and `docs/design/mockup-v2-features.html`)

Treat both files as the source of truth for visuals and interaction — the original approved mockup
for the base app (Roulette/Library/deck-shuffle), and `mockup-v2-features.html` for the v2 features
below (ratings, streaming/quotes, attendance). Both are single-file working prototypes (fake
in-memory data, base64-inlined fonts purely so the file previews standalone — production still
self-hosts fonts via relative `/fonts/...woff2` paths, don't copy the base64 approach into real
components) — port structure/behavior into real components, don't re-derive from scratch. Points
specific to the v2 features, locked in after several rounds of review:

- **Rating widget**: half-star precision (hover/drag preview, click or touch-release commits),
  unrated state renders fully empty/hollow stars (no fill at all), committed rating fills to that
  value using the existing yellow status accent. Numeric readout (e.g. "4.5/5" or "Not rated yet")
  sits inline with the stars, never wrapping to its own line, at both card and reveal-panel widget
  sizes. Respects `prefers-reduced-motion` (instant snap instead of animated fill).
- **Title/year/rating layout**: wherever a title+year+rating can appear (Library card, Roulette
  reveal panel), the year sits inline next to the title (kept in the existing muted/secondary
  color, at its own smaller size — not matching the title size, that was tried and reverted), and
  the rating sits directly below the combined title+year line, ahead of any other content in that
  block.
- **Streaming/quotes extras strip**: spans the full width of its container (not a partial-width
  grid), with clear vertical spacing between the streaming-platforms block and the
  memorable-quotes block. Quote text uses a lighter/muted tint of the ink-navy body color so it
  recedes behind the poster/title. No "quotes may not be exact" or similar disclaimer copy — that
  was deliberately rejected. On mobile, this strip starts collapsed behind a small pill-shaped
  "More info" control (with a chevron) centered on a dashed rule, matching the app's existing
  dashed-separator motif; tapping expands it (animated height, respects reduced motion).
- **Attendance selector**: a header dropdown (anchored near the tab bar), not a full gating screen
  — a pre-shuffle gating-screen alternative was mocked up and explicitly rejected. Must include a
  "Select All" control and individual per-member toggles.
- Light theme only remains unchanged/deliberate — no dark theme was added for any v2 feature.

Key points for the base app (from the original approved mockup):

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
