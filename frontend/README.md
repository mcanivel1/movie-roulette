# Movie Roulette — frontend

Vite + React (plain JS) static site. Deployed to GitHub Pages. See the repo
root [`SPEC.md`](../SPEC.md) for the full API contract and business logic,
and [`docs/design/approved-mockup.html`](../docs/design/approved-mockup.html)
for the design source of truth.

## Local dev setup

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run dev
```

### Pointing at the real backend

The app talks to the real Apps Script Web App **by default**. `.env.local`
needs two values, both from whoever deployed the backend (see
[`../apps-script/README.md`](../apps-script/README.md)):

```
VITE_API_URL=https://script.google.com/macros/s/XXXXXXXX/exec
VITE_API_TOKEN=<the SHARED_TOKEN value from Script Properties>
```

Without these set, `npm run dev` / `npm run build` will still run, but every
API call will fail (empty `VITE_API_URL`) — there's no silent fallback to
mock data in that case.

### Working without a backend (mock mode)

If you're doing UI-only work and don't have a deployed Apps Script URL
handy, opt into the in-memory mock instead:

```
VITE_USE_MOCK=true
```

This runs entirely against the sample dataset in `src/data/mockMovies.js`
(the Harbor Lights / Glass Orchard trilogies, including one deliberate
dangling-prequel example) — no network calls, nothing written anywhere.
Every field/behavior matches the real API's shape (see `src/api.js`), so
UI code doesn't need to know or care which mode it's in.

`.env.local` is gitignored (`*.local` in `.gitignore`) — never commit real
tokens.

## Scripts

```bash
npm run dev       # dev server
npm run build     # production build -> dist/
npm run preview   # serve the production build locally
npm run lint      # oxlint
npm run test      # vitest — currently covers src/api.js's real-fetch
                   # request shapes (mocked fetch, no live backend needed)
                   # and the pure eligibility logic
```

## Deploying (GitHub Pages)

`.github/workflows/deploy.yml` builds this app and deploys `dist/` on every
push to `main`. Before it will produce a **working** build (not just a
successful one), two repository secrets must be set:

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `VITE_API_URL` | The deployed Apps Script Web App URL |
| `VITE_API_TOKEN` | The `SHARED_TOKEN` configured in the Apps Script's Script Properties |

The workflow injects these as env vars for the `npm run build` step, and
Vite inlines `VITE_`-prefixed env vars into the built JS at that point —
there's no way to change them after the fact without rebuilding. If the
secrets are missing, the build still succeeds (Vite doesn't fail on an
empty env var), but the deployed site will hit `https://` + `undefined`... in
practice every list/spin/setWatched call will fail, so set these before
relying on a live deploy.

`base` in `vite.config.js` is hardcoded to `/movie-roulette/` for GitHub
Pages' project-site URL pattern (`https://<user>.github.io/movie-roulette/`).
If the repo is ever renamed, update it there.

## Notes for whoever wires this up next

- `src/api.js` is the single seam between the UI and "how data gets
  fetched" — `listMovies()` / `spin()` / `setWatched(id, watched)` return
  the same shapes regardless of `VITE_USE_MOCK`.
- The POST in `setWatched()` is called with **no explicit headers object**
  on purpose — see the comment above `realPost()` and SPEC.md's "CORS
  gotcha" section. Adding a `Content-Type: application/json` header there
  will trigger a CORS preflight that Apps Script Web Apps can't handle
  correctly, breaking the call in the browser (it may still "work" from
  tools like curl/Postman, which don't preflight).
- Any response shaped `{ error: "<code>" }` is thrown as an `ApiError`
  (`err.code` holds the short code) rather than returned — callers should
  expect a rejected promise on API-level errors, not a truthy check on the
  result.
