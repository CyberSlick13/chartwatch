# Chartwatch

Top-10 music charts on one page. YouTube and Apple Music are live. Spotify and SoundCloud show sample data until their fetchers are added.

## Run it on your computer

1. Get a YouTube API key: in Google Cloud Console, create a project, enable "YouTube Data API v3", then create an API key. A standard key starts with `AIza`.
2. Copy `.env.example` to `.env` and paste the key in.
3. Run `node server.js` (Node 18 or newer) and open http://localhost:3000.

Without a key the page still works. YouTube shows sample data, and Apple Music needs no key at all.

## How it works

- `server.js` fetches each chart, keeps the result for an hour, and serves it at `/api/charts/<platform>?region=ng`.
- `public/index.html` asks the server for each chart. If the server has nothing for a platform (or is down), the page falls back to made-up sample data and shows a "Sample data" tag.
- The key stays on the server and is never sent to the browser.
- YouTube lists show view counts. Apple's feed gives a ranking only, so Apple rows have no number.

### Movement arrows

Each chart's ranks are saved once a day to `data/history.json`. When the server fetches a chart, it compares it with the last saved day and marks each row up, down, unchanged or NEW. The header says which day it compared against. Nothing shows until the server has saved at least two different days. Days are counted in UTC.

## Adding the next platform

Add a function to `FETCHERS` in `server.js` that returns `{ unit, items: [{ id, rank, title, artist, value, cover, url }] }`. Use `value: null` when a platform has no count. The page and the movement arrows pick it up with no other changes.

## Putting it online (Render)

1. Create a GitHub repository and push this folder to it. `.gitignore` already keeps `.env` and `data/` out.
2. On render.com choose New, then Blueprint (or Web Service), and select the repository. `render.yaml` sets everything up.
3. When asked, enter `YOUTUBE_API_KEY` as an environment variable. Don't commit the key.
4. Deploy, then open the `onrender.com` address Render gives you.

On Render's free plan:
- The service goes to sleep when nobody visits, so the first load after a quiet spell takes up to a minute.
- Its disk is wiped when the service restarts or sleeps, so `data/history.json` is lost and movement arrows start over. To keep the history, add a Render persistent disk (a paid feature) mounted at `/var/data` and set `DATA_DIR=/var/data`.
