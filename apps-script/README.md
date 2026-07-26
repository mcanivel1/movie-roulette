# Movie Roulette — Apps Script backend

This is the Google Apps Script Web App that backs Movie Roulette. It reads and
writes a Google Sheet directly (via `SpreadsheetApp`) and resolves real movie
poster art from [TMDB](https://www.themoviedb.org/) server-side, so no
credentials ever ship in the public frontend bundle.

It implements the API contract in `../SPEC.md`:

- `GET ?token=...&action=list` — all movies, with `eligible`/`waitingOn`/`posterUrl` computed
- `GET ?token=...&action=spin` — one random eligible movie (or `{ movie: null }`)
- `POST { token, action: "setWatched", id, watched }` — updates a row's Watched cell

## File layout

- `Logic.js` — pure business logic (header resolution, eligibility, random
  pick, TMDB response parsing). No Apps Script globals; unit tested directly
  with Node.
- `Code.js` — the thin outer layer: `doGet`/`doPost`, Sheet/TMDB/Properties
  wiring. This is the only file that touches `SpreadsheetApp`,
  `PropertiesService`, `UrlFetchApp`, or `ContentService`.
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
   Property in step 5 below. Keep it private; don't commit it to the repo.

## 2. Create the Google Sheet (if you don't already have one)

The backend reads and writes an existing Google Sheet — it doesn't create
one for you. Before deploying, make sure you have a Sheet with a header row
containing these column names (case-insensitive, any order, other columns
are fine too and are ignored):

| `Movie` | `Year` | `Prequel` | `Watched` |
|---|---|---|---|

- `Movie`: the title (required for every row).
- `Year`: release year, as a number (or a date cell — the backend will use
  its year).
- `Prequel`: leave blank if there isn't one, otherwise it must exactly match
  another row's `Movie` value (case-insensitive, trimmed).
- `Watched`: a checkbox or `TRUE`/`FALSE` value.

Add one row per movie below the header. You do **not** need to add a
`Poster URL` column — the backend creates that automatically the first time
it needs to cache a resolved poster.

Once the Sheet exists, copy its ID out of the browser URL — the long string
between `/d/` and `/edit`, e.g. for
`https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit` it's
`1AbCdEfGhIjKlMnOp`. You'll paste this into `SPREADSHEET_ID` in step 5
below.

(If you point `SPREADSHEET_ID` at a Sheet whose header row doesn't match any
of these names, the backend won't error — `list`/`spin` will just silently
return an empty movie list, since there's nothing to resolve columns from.
If that happens, double-check the header row spelling first.)

## 3. Install `clasp` and log in

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

## 4. Create the Apps Script project

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

## 5. Set the three Script Properties

The backend never hardcodes secrets — it reads them from Script Properties
at runtime. Open the project in the Apps Script editor:

```bash
clasp open
```

Then, in the editor:

1. Click the gear icon (**Project Settings**) in the left sidebar.
2. Scroll to **Script Properties** and click **Add script property**.
3. Add all three of these (exact names, case-sensitive):

   | Property | Value |
   |---|---|
   | `SPREADSHEET_ID` | The target Google Sheet's ID — the long string in its URL between `/d/` and `/edit`, e.g. for `https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit`, it's `1AbCdEfGhIjKlMnOp`. |
   | `SHARED_TOKEN` | Any long random string you make up (e.g. run `openssl rand -hex 16` locally). This is the shared secret the frontend sends on every request — pick something, and give the same value to the frontend dev. |
   | `TMDB_API_KEY` | The TMDB API key from step 1. |

4. Click **Save script properties**.

## 6. Deploy as a Web App

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
  to add it to the Sheet yourself.
- If you ever need to rotate `SHARED_TOKEN`, update it in Script Properties
  and tell the frontend dev the new value — both sides must match exactly,
  there's no versioning/negotiation of the token.
