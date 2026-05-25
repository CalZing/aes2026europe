# AES Europe 2026 — Schedule Viewer

A small Node.js + Express + vanilla-JS web app that re-renders the
[official AES Europe 2026 schedule](https://aeseurope2026.sched.com/) with:

- **Multi-topic filtering** — pick any combination of topics; sessions in multiple topics appear on multiple rows.
- **Horizontal timeline view** — one row per topic (or per room, or a flat list), time runs left to right.
- **Bookmarks** — saved in `localStorage` so no accounts, no cookies-to-a-server. Export your bookmarks as `.ics` and import into any calendar app.
- **No data duplication** — the server fetches the live `all.ics` feed from Sched (cached 10 min), so when Sched updates, this app updates.

## Why a server at all?

Sched.com blocks cross-origin browser requests and bot scrapes. A tiny Node
process is needed to fetch the public ICS feed server-side and re-serve it as
JSON. That's all the backend does.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. On Render, **New → Web Service**, connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** *(leave empty — there is no build step)*
   - **Start command:** `npm start`
   - **Instance type:** Free is fine; the app does a 10-minute cache so traffic to Sched is negligible.
4. Optional environment variables (all have sensible defaults):
   - `PORT` — set automatically by Render.
   - `ICS_URL` — defaults to `https://aeseurope2026.sched.com/all.ics`.
   - `CONFERENCE_TZ` — defaults to `Europe/Copenhagen`.
   - `CACHE_TTL_MS` — defaults to `600000` (10 minutes).

That's it — no database, no secrets, no build pipeline.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Force a cache refresh with `GET /api/schedule?refresh=1`.

## File layout

```
.
├── package.json        # only dependency: express
├── server.js           # ICS fetcher, parser, JSON API, static host
├── test-parser.js      # node test-parser.js — runs parser assertions
└── public/
    ├── index.html      # single-page shell
    ├── style.css       # dark theme, peak-meter amber accent
    └── app.js          # state, rendering, localStorage, ICS export
```

## How it works

- **`server.js`** fetches `all.ics` on first request, caches the parsed
  events in memory for 10 minutes, and serves them at `GET /api/schedule`.
  All times are normalised to `{ dayKey, minutes, label }` in
  `Europe/Copenhagen`, so the frontend never has to do timezone maths.
  Topics come from the ICS `CATEGORIES` field, from `Type:` / `Track:` /
  `Topic:` lines in descriptions, and from trailing `(Topic)` markers in
  session titles.
- **`public/app.js`** keeps state in `localStorage` (`aes2026.bookmarks`,
  `aes2026.prefs`) and reflects the active day, topics, and search into
  the URL hash so you can share filtered views by link. The timeline
  renders as an absolutely-positioned CSS grid; sessions can appear in
  multiple topic rows simultaneously.

## Caveats

- If Sched's `CATEGORIES` field is sparse, topic rows will be too. The
  parser scrapes descriptions as a fallback. Once the real feed is live,
  let me know what topic data actually appears and we can refine the
  extraction.
- Bookmarks are per-browser (since they live in `localStorage`).
- The "now" indicator only shows if the current time falls within the
  selected day's bounds.

## License

Personal use; not affiliated with the AES or Sched.
