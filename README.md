# Chartwatch

Top-10 music charts on one page. YouTube, Apple Music and Deezer (worldwide) are live. The Spotify and SoundCloud tabs link to their own official charts, because neither platform gives new developers open access to chart data (checked November 2026: Spotify's Development Mode can't read public playlists like Top 50, and SoundCloud's self-serve API needs an Artist Pro plan).

## Run it on your computer

1. Get a YouTube API key: in Google Cloud Console, create a project, enable "YouTube Data API v3", then create an API key. A standard key starts with `AIza`.
2. Copy `.env.example` to `.env` and paste the key in.
3. Run `node server.js` (Node 18 or newer) and open http://localhost:3000.

Without a key the page still works. YouTube shows sample data, and Apple Music needs no key at all.

## How it works

- `server.js` fetches each chart, keeps the result for an hour, and serves it at `/api/charts/<platform>?region=ng`.
- Once an hour the server also refreshes every chart by itself, so history is saved and charts stay fresh even when nobody visits.
- `public/index.html` asks the server for each chart. If the server has nothing for a platform (or is down), the page falls back to made-up sample data and shows a "Sample data" tag.
- The keys stay on the server and are never sent to the browser.
- YouTube lists show view counts. Apple's feed gives a ranking only, so Apple rows have no number.
- `/health` answers `{"ok":true}`. It exists so a pinger can keep a free host awake.

### Movement arrows

Each chart's ranks are saved once a day. The server compares the latest chart with the last saved day and marks each row up, down, unchanged or NEW. The header says which day it compared against. Nothing shows until two different days have been saved. Days are counted in UTC.

Where the history is saved:
- On your computer: `data/history.json`.
- When hosted: an Upstash Redis database, used automatically whenever `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set. If the database can't be reached at startup, the server serves charts without arrows and does not overwrite the saved history.

## Hosting it online for free, always on

Three free services work together: Render runs the server, Upstash keeps the history, and an uptime pinger stops Render from sleeping.

1. **Upstash.** Sign up at upstash.com and create a Redis database on the free plan. On its page, copy the REST URL and the REST token.
2. **GitHub.** Create a repository and push this folder to it. `.gitignore` already keeps `.env` and `data/` out.
3. **Render.** On render.com choose New, then Blueprint, and select the repository. `render.yaml` sets everything up. When asked, enter three values: `YOUTUBE_API_KEY`, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Deploy and note the `onrender.com` address.
4. **Pinger.** Sign up for a free uptime service such as UptimeRobot or cron-job.org and add a check for `https://YOUR-SERVICE.onrender.com/health` every 5 minutes. Render puts free services to sleep after 15 minutes without traffic, so any interval under 15 minutes keeps it awake.

Things to know:
- Render's free plan gives each workspace 750 free hours a month, which covers one always-on service. Don't run other free web services in the same workspace.
- Render may restart the service at any time. That's fine, because history lives in Upstash and the server reloads it at startup.
- The Upstash free plan allows 500,000 commands a month. Chartwatch uses a few thousand.
- Free plans change. Check Render's and Upstash's current free-plan pages if something stops working.
- Treat the YouTube key and the Upstash token like passwords. Never commit them to GitHub.

## Adding the next platform

To turn a link-only tab into a live one, remove `linkOnly: true` from its entry in `PLATFORMS` in `public/index.html`, then add a function to `FETCHERS` in `server.js` that returns `{ unit, items: [{ id, rank, title, artist, value, cover, url }] }`. Use `value: null` when a platform has no count. The page, the hourly refresh and the movement arrows pick it up with no other changes.
