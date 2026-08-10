# Movie Roulette — Apps Script backend

This is the Google Apps Script Web App that backs Movie Roulette. It reads and
writes a Google Sheet directly (via `SpreadsheetApp`), resolves real movie
poster art from [TMDB](https://www.themoviedb.org/) server-side, and (for the
per-movie "details" strip) looks up streaming platforms via TMDB and
generates memorable quotes via the [Google Gemini API](https://ai.google.dev/) —
all server-side, so no credentials ever ship in the public frontend bundle.
Gemini (rather than a paid LLM API) was chosen specifically so this app can
run at zero ongoing cost — its free tier needs no billing account.

It implements the API contract in `../SPEC.md`:

- `GET ?token=...&action=list[&absent=Name,Name]` — all movies, with
  `eligible`/`waitingOn`/`posterUrl`/`rating`/`seenBy` computed
- `GET ?token=...&action=spin[&absent=Name,Name]` — one random eligible movie
  (or `{ movie: null }`)
- `GET ?token=...&action=details&id=5` — lazy per-movie streaming platforms +
  memorable quotes, cached server-side
- `POST { token, action: "setWatched", id, watched }` — updates a row's Watched cell
- `POST { token, action: "setRating", id, rating }` — updates a row's Rating cell

## File layout

- `Logic.js` — pure business logic (header resolution, eligibility,
  attendance/rating validation, random pick, TMDB/Gemini response
  parsing). No Apps Script globals; unit tested directly with Node.
- `Code.js` — the thin outer layer: `doGet`/`doPost`, Sheet/TMDB/Gemini/
  Properties/Cache wiring. This is the only file that touches
  `SpreadsheetApp`, `PropertiesService`, `UrlFetchApp`, `ContentService`, or
  `CacheService`.
- `appsscript.json` — the project manifest (clasp/Apps Script format).
- `test/` — unit tests (`node --test`). See "Running the tests" below.

You don't need to understand Apps Script internals to deploy this — follow
the steps below in order.

## 1. Get a free TMDB API key

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Once logged in, go to **Settings → API** (or visit
   [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)).
3. Click **Create** / **Request an API key**, choose the **Developer**
   (free) option, and fill in the short form (you can put "personal project"
   / "Movie Roulette" for the app name and description — it doesn't need to
   be a public product).
4. Once approved (usually instant), copy the **API Key (v3 auth)** value —
   it's a long string of letters/numbers. You'll paste this into a Script
   Property in step 6 below. Keep it private; don't commit it to the repo.

## 2. Get a free Google Gemini API key

Used only for the "details" call's memorable-quotes generation (streaming
platforms still come from TMDB) — see `../SPEC.md`'s "Streaming platforms &
memorable quotes" section. Deliberately **not** a paid LLM API: Gemini's free
tier needs no billing account or credit card, so this feature costs nothing
to run at the volume a small group app generates.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in
   with any Google account (the same one you use for the Sheet is fine, but
   doesn't have to be).
2. Click **Create API key**, then **Create API key in new project** (or pick
   an existing Google Cloud project if you already have one — it doesn't
   matter which).
3. Copy the key that's shown. You'll paste this into `GEMINI_API_KEY` when
   you set the Script Properties below. Keep it private; don't commit it to
   the repo.

No credit card, billing account, or payment info is required for the free
tier — if Google Cloud ever prompts you to "enable billing," you've clicked
into a different, unrelated product; the API key from Google AI Studio's
free tier works without it. The free tier has generous per-minute/per-day
request limits that a small group app running one request per movie (cached
for hours afterward — see "Notes for whoever deploys this" at the bottom of
this file) won't come close to hitting.

The backend calls the `gemini-3.1-flash-lite` model (Code.js's `GEMINI_MODEL`
constant), currently free-tier-eligible with generous per-minute/per-day
limits (30 requests/minute, 1,500 requests/day as of this writing) — far
more than a small group app running one request per movie (cached for hours
afterward) will ever approach.

**Google retires Gemini model versions on a real cadence.** This has already
happened once in this project: the original pick (`gemini-2.0-flash-lite`)
was retired 2026-06-01, and every quote-generation call silently failed
model-not-found from that point on. The backend's fail-safe design (SPEC.md)
correctly degrades any single failed request to an empty quotes array with
nothing cached — exactly right for a *transient* TMDB/Gemini hiccup, but a
retired model is a *permanent* failure wearing that same "empty array,
nothing cached" costume, so it went unnoticed until a product owner report
that quotes had simply never worked.

**If quotes stop populating in production, check this first** — a retired
model is a more likely culprit than an actual bug. Check
[ai.google.dev's current model list](https://ai.google.dev/gemini-api/docs/models)
for a free-tier-eligible Flash/Flash-Lite model (don't trust this README or
your own memory — that list is the only source of truth for what's current)
and update `GEMINI_MODEL` in Code.js (and this paragraph, so the next person
isn't debugging the same thing blind).

## 3. Create the Google Sheet (if you don't already have one)

The backend reads and writes an existing Google Sheet — it doesn't create
one for you. Before deploying, make sure you have a Sheet with a header row
containing these column names (case-insensitive, any order, other columns
are fine too and are ignored):

| `Movie` | `Year` | `Prequel` | `Watched` | `Rating` | `Austin` | `Eugie` | `Josh` | `Jouissance` | `Lynda` | `Marvin` | `Mel` | `Michelle` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

- `Movie`: the title (required for every row).
- `Year`: release year, as a number (or a date cell — the backend will use
  its year).
- `Prequel`: leave blank if there isn't one, otherwise it must exactly match
  another row's `Movie` value (case-insensitive, trimmed).
- `Watched`: a checkbox or `TRUE`/`FALSE` value.
- `Rating`: a plain number cell, 0.5–5.0 in half-star steps, blank until the
  user rates a watched movie. The backend never auto-creates this column —
  add it yourself (any watched movie can be rated; blank means "not rated
  yet").
- `Austin` / `Eugie` / `Josh` / `Jouissance` / `Lynda` / `Marvin` / `Mel` /
  `Michelle`: one checkbox (or `TRUE`/`FALSE`) column per group member —
  fixed roster, exact names — marking whether that person has personally
  seen the movie. Powers the Attendance feature (the `absent` param on
  `list`/`spin`). Like `Rating`, the backend never auto-creates these columns.

Add one row per movie below the header. You do **not** need to add a
`Poster URL` column — the backend creates that automatically the first time
it needs to cache a resolved poster. `Rating` and the 8 member columns,
unlike `Poster URL`, are **not** auto-created — set them up yourself before
deploying, or `setRating` calls will fail with `sheet_error` and every
row's attendance will read as "nobody's seen it" until the member columns
exist.

Once the Sheet exists, copy its ID out of the browser URL — the long string
between `/d/` and `/edit`, e.g. for
`https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit` it's
`1AbCdEfGhIjKlMnOp`. You'll paste this into `SPREADSHEET_ID` in step 6
below.

(If you point `SPREADSHEET_ID` at a Sheet whose header row doesn't match any
of these names, the backend won't error — `list`/`spin` will just silently
return an empty movie list, since there's nothing to resolve columns from.
If that happens, double-check the header row spelling first.)

## 4. Install `clasp` and log in

`clasp` is Google's CLI for pushing local files into an Apps Script project.

```bash
npm install -g @google/clasp
clasp login
```

This opens a browser window to authorize `clasp` against your Google
account — use the **same Google account that owns (or has edit access to)
the target spreadsheet**. That matters: whichever account the Apps Script
project runs as needs to be able to open and edit the Sheet, and normally
that's automatic when it's the same account.

## 5. Create the Apps Script project

From inside this `apps-script/` directory:

```bash
cd apps-script
clasp create --type webapp --title "Movie Roulette"
```

This creates a new, empty Apps Script project bound to your account and
writes a `.clasp.json` file here recording its script ID.
`.clasp.json` is already listed in the repo's `.gitignore` — it's
per-developer, don't commit it.

(Alternative: if you already created an Apps Script project by hand in
the [Apps Script editor](https://script.google.com), use
`clasp clone <scriptId>` instead of `clasp create`, using the script ID from
the project's URL.)

Then push the local files up:

```bash
clasp push
```

`clasp push` will likely warn that it's about to overwrite the project's
default `Code.js`/`appsscript.json` with the local versions — that's
expected, confirm it.

## 6. Set the four Script Properties

The backend never hardcodes secrets — it reads them from Script Properties
at runtime. Open the project in the Apps Script editor:

```bash
clasp open-script
```

(Older clasp versions (v2) call this `clasp open` instead — if that's what you have installed, use that form. Run `clasp --help` to check which your version supports.)

Then, in the editor:

1. Click the gear icon (**Project Settings**) in the left sidebar.
2. Scroll to **Script Properties** and click **Add script property**.
3. Add all four of these (exact names, case-sensitive):

   | Property | Value |
   |---|---|
   | `SPREADSHEET_ID` | The target Google Sheet's ID — the long string in its URL between `/d/` and `/edit`, e.g. for `https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit`, it's `1AbCdEfGhIjKlMnOp`. |
   | `SHARED_TOKEN` | Any long random string you make up (e.g. run `openssl rand -hex 16` locally). This is the shared secret the frontend sends on every request — pick something, and give the same value to the frontend dev. |
   | `TMDB_API_KEY` | The TMDB API key from step 1. |
   | `GEMINI_API_KEY` | The Google Gemini API key from step 2. Only used for the `details` action's memorable-quotes generation. |

4. Click **Save script properties**.

## 7. Deploy as a Web App

Still in the Apps Script editor:

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in the deployment settings:
   - **Execute as: Me** (your account) — this is required so the app runs
     with your Sheet access, not the anonymous caller's.
   - **Who has access: Anyone** — required so the static frontend (running
     in visitors' browsers, not logged into your Google account) can call
     it. This is safe here because every request is still gated by the
     `SHARED_TOKEN` above (see the "Hosting model" section of `../SPEC.md`
     for why that's a deterrent, not real security, and why that's an
     acceptable tradeoff for this app).
4. Click **Deploy**. The first time, Google will show an authorization
   prompt (since the script accesses your Sheet and calls an external API)
   — review and accept it.
5. Copy the **Web app URL** shown after deploying. It looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`

Give this URL to the frontend dev (or drop it into the frontend's config) —
it's the value the frontend calls with `fetch()`.

### Redeploying after code changes

Every time you change `Code.js` or `Logic.js` and want the live Web App to
pick it up:

```bash
clasp push
```

then in the editor: **Deploy → Manage deployments → (pick the existing
deployment) → Edit (pencil icon) → Version: New version → Deploy**.

Pushing alone updates the project's source, but a Web App URL keeps serving
whatever version it was last deployed at — you must explicitly create a new
version for a live deployment to see the change. (Using **Test deployments**
from the same dialog is a faster way to try changes against the `/dev` URL
before cutting a new versioned deployment.)

## Running the tests

The pure logic (and the `doGet`/`doPost` wiring, exercised against mocked
Apps Script globals) is unit tested with Node's built-in test runner — no
extra dependencies to install.

```bash
cd apps-script
npm test
```

This runs `node --test`, which picks up everything under `test/`.

## Notes for whoever deploys this

- The Apps Script project's Google account needs access to the spreadsheet
  named by `SPREADSHEET_ID`. If you created the Sheet yourself and logged
  `clasp` into that same account, this is automatic — nothing extra to do.
  If the Sheet is owned by a different account, share it (Editor access)
  with the account you deployed the script as.
- The `Poster URL` column is created automatically by the backend the first
  time it needs to cache a resolved (or "no match") poster — you don't need
  to add it to the Sheet yourself. `Rating` and the 8 attendance columns are
  **not** auto-created — add them to the header row yourself before
  deploying (see "Create the Google Sheet" above).
- If you ever need to rotate `SHARED_TOKEN`, update it in Script Properties
  and tell the frontend dev the new value — both sides must match exactly,
  there's no versioning/negotiation of the token.
- Streaming platforms and quotes (the `details` action) are cached
  server-side via `CacheService`, not written into the Sheet — a stale
  provider list or quote set clears itself after a few hours automatically.
  There's no manual "refresh" action; if you need to force a re-fetch sooner,
  the only lever right now is waiting out the cache TTL.
