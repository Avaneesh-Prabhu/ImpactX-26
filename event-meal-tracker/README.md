<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Event Meal Tracker

A shared, real-time dashboard for tracking meal service at an event: scan
guest QR codes, log who's eaten, and see it reflected instantly on every
open scanner station and dashboard.

## How it works

- **`server/`** — an Express + Socket.IO backend. It owns the single shared
  source of truth (a Supabase Postgres database): participants, meals, meal logs,
  volunteer accounts, and the simulated event clock.
- **`src/`** — the React/Vite frontend. Every device that opens the site
  fetches the current shared state (`GET /api/state`) and then stays live
  via a Socket.IO connection: any import, scan, undo, or schedule change
  made on *any* device is broadcast to *every* connected device immediately.
- There is no more `localStorage`-only mode — importing a guest list or
  scanning a QR code on one device now shows up on everyone else's screen
  within a fraction of a second.

## Run locally (development)

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Start the backend API (owns the shared data, port 4000 by default):
   `npm run server`
3. In a second terminal, start the frontend dev server:
   `npm run dev`
4. Open the URL Vite prints (`http://localhost:3000`). Vite's dev server
   proxies `/api` and `/socket.io` to the backend automatically (see
   `vite.config.ts`), so there's nothing else to configure. Open the same
   URL in a second tab/device to see the shared dashboard update live.

## Deploying it as one shared site

The simplest deploy is **one process** that serves both the API and the
built frontend, so there's only one URL and no cross-origin setup:

```bash
npm run build   # builds the frontend into dist/
npm run server  # (or: npm start, which builds then starts)
```

`server/index.js` automatically serves `dist/` (and falls back to
`index.html` for client-side routing) whenever that folder exists, on the
same port as the API and Socket.IO — so deploying it to a single Node
host (Render, Railway, Fly.io, a VPS, etc.) with:

- **Build command:** `npm install && npm run build`
- **Start command:** `npm run server` (or `npm start`)
- **Port:** whatever the platform provides via the `PORT` env var (already
  read in `server/index.js`)

...is enough. Everyone who opens that one URL shares the same live data.

### Database (Supabase Postgres)

All shared data lives in Supabase Postgres, so it survives restarts and
redeploys, and every server instance sees the same data. `server/data/db.json`
is no longer used.

**One-time setup**

1. Create a project at supabase.com.
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it.
3. Go to **Project Settings > Database > Connection string**, copy the
   **Session pooler** (or Transaction pooler) URI and put it in `.env`:
   `DATABASE_URL="postgresql://postgres.xxxx:<password>@...pooler.supabase.com:6543/postgres"`
   (see `.env.example`). On your host (Render/Railway/etc.) set the same
   `DATABASE_URL` as an environment variable. Never commit `.env`.
4. `npm install`, then `npm run server`. On first start the server seeds the
   default meal schedule and volunteer accounts into empty tables.

**Bringing over an existing `db.json`** (optional, replaces DB contents):
`npm run migrate:json` (or `node scripts/migrate-json-to-supabase.js path/to/db.json`).

Scans are atomic: a unique constraint on (participant, meal) means two
volunteers scanning the same guest at the same moment can never both succeed.

### Running frontend and backend as two separate services

If you'd rather deploy the frontend (e.g. to Vercel/Netlify) and the
backend (e.g. to Render/Railway) separately, you'll need to:

1. Deploy `server/` on its own (it still works standalone; just skip
   `npm run build` for it, or ignore the `dist/` static-serving branch).
2. Point the frontend at that backend's URL instead of relying on
   same-origin requests — add an env var (e.g. `VITE_API_URL`) and update
   `src/services/socket.ts` / the `fetch` calls in
   `src/services/storage.ts` to use it, and enable CORS for that origin
   (already permissive via `cors()` in `server/index.js`).

The single-service deploy above avoids all of this, so it's the
recommended path unless you have a specific reason to split them.
