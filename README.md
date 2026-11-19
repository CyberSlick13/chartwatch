# Chartwatch

Top charts from YouTube, Apple Music and Deezer on one page, for Nigeria, Ghana, South Africa, Kenya, the United Kingdom and the United States (plus Deezer's worldwide chart). Each chart shows the top 10 with a button for the top 50, and most rows have a 30-second preview. Spotify and SoundCloud are not listed because neither gives new developers open access to chart data (checked November 2026: Spotify's Development Mode can't read public playlists like Top 50, and SoundCloud's self-serve API needs an Artist Pro plan). The footer links to their official charts.

## Run it on your computer

1. Get a YouTube API key: in Google Cloud Console, create a project, enable "YouTube Data API v3", then create an API key. A standard key starts with `AIza`.
2. Copy `.env.example` to `.env` and paste the key in.
3. Run `node server.js` (Node 18 or newer) and open http://localhost:3000.

Without a key the page still works. YouTube shows sample data for Nigeria only, and Apple Music and Deezer need no key at all.

## How it works

- Deezer's Nigeria chart is Deezer's own "Top Nigeria" playlist, found by name the first time it is needed. If it can't be found, the page shows Deezer's worldwide chart and says so.
- An open page reloads its chart every 5 minutes and shows how long ago the server fetched it.

- `server.js` fetches each chart, keeps the result for an hour, and serves it at `/api/charts/<platform>?region=ng`.
- Once an hour the server also refreshes every chart by itself, so history is saved and charts stay fresh even when nobody visits.
- `public/index.html` asks the server for each chart. If the server has nothing for a platform (or is down), the page falls back to made-up sample data and shows a "Sample data" tag.
- The keys stay on the server and are never sent to the browser.
- YouTube lists show view counts. Apple's feed gives a ranking only, so Apple rows have no number.
- `/health` answers `{"ok":true}`. It exists so a pinger can keep a free host awake.

### Previews and countries

- Deezer rows play the 30-second preview file Deezer provides. Apple Music rows play Apple's preview, looked up from Apple's public lookup (rows without one get no button). YouTube rows open YouTube's own embedded player under the row. Some videos block embedding, and the page says so.
- Countries are listed in `COUNTRIES` in `server.js` (and the same list in `public/index.html`). To add one, add it to both. Not every platform publishes a chart for every country.
- Deezer's country charts are Deezer's own "Top <country>" playlists, found by name. If one can't be found, the page shows Deezer's worldwide chart and says so.

### Install icon

`public/manifest.webmanifest` and `public/icons/` give the page a name and an icon, so "Add to Home screen" installs it as Chartwatch with the red bars.

### Platform logos

Opening splash: a dark screen where the logo bars rise and pulse, the wordmark blurs in, then the page slides up (about 2.5 seconds, skipped for reduced-motion users). The timings (`HOLD_MS`, `LEAVE_MS`, `SHOW_ONCE_PER_SESSION`) are in the script at the bottom of `public/index.html`, and the artwork is `public/logos/chartwatch-wordmark.png`.

Official logos live in `public/logos/` and must be used exactly as the platform supplies them (no recoloring or editing). A platform gets one by adding a `logo` entry in `PLATFORMS` in `public/index.html`, with a version for light pages and one for dark pages. Check each platform's brand rules first. YouTube, Apple Music (app icon, with the name written beside it) and Deezer all have logos. Deezer only supplies a black-wordmark version, so on dark pages it sits on a white badge; swapping in Deezer's white logo from its brand kit would be tidier.

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

## Adding another platform

Add a function to `FETCHERS` in `server.js` that returns `{ unit, items: [{ id, rank, title, artist, value, cover, url, preview, embed }] }` (`value`, `preview` and `embed` are optional), then add the platform to `PLATFORMS` in `public/index.html`. The hourly refresh and the movement arrows pick it up with no other changes.
