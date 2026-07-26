# Movie Roulette

Picks tonight's movie from a Google Sheet — only offering films that haven't been watched yet
and whose prequel (if any) has already been watched — then lets you mark the result as watched,
which updates the sheet.

See [`SPEC.md`](./SPEC.md) for the full spec (sheet shape, API contract, design system, poster
sourcing). See [`docs/design/approved-mockup.html`](./docs/design/approved-mockup.html) for the
approved interactive design prototype.

## Structure

- [`apps-script/`](./apps-script) — Google Apps Script Web App. Reads/writes the Sheet, resolves
  real poster art from TMDB server-side, and serves a small JSON API. See its README for
  deployment steps.
- [`frontend/`](./frontend) — Vite + React static app, deployed to GitHub Pages. See its README
  for local dev and deployment.

## Setup order

1. Deploy the Apps Script (`apps-script/README.md`) — needs a Google Sheet matching the shape in
   `SPEC.md`, and a free TMDB API key.
2. Point the frontend at the deployed Apps Script URL (`frontend/README.md`) and build/deploy to
   GitHub Pages.
