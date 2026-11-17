// Chartwatch server. No dependencies, needs Node 18 or newer (for built-in fetch).
// Run: node server.js   (put YOUTUBE_API_KEY in a .env file or the environment)

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// Minimal .env loader so you don't need the dotenv package.
try {
  const lines = fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) {
  /* no .env file, that's fine */
}

const PORT = Number(process.env.PORT) || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const CACHE_MS = 60 * 60 * 1000; // refresh each chart at most once an hour
const KEEP_DAYS = 14; // how many daily snapshots to remember per chart

// The page's two region buttons: "ng" is Nigeria, "gl" is shown as United States.
const YOUTUBE_REGIONS = { ng: "NG", gl: "US" };
const APPLE_COUNTRIES = { ng: "ng", gl: "us" };

const cache = new Map();

/* ---------- Daily snapshots, used for the up/down/NEW markers ---------- */

let history = {};
try {
  history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
} catch (e) {
  history = {};
}

function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    console.error("Could not save history:", e.message);
  }
}

// Adds item.prev (last snapshot's rank, or null for a new entry) and returns the date compared against.
function applyMovement(key, items) {
  const today = new Date().toISOString().slice(0, 10); // UTC day
  const snaps = history[key] || [];
  let before = null;
  for (const s of snaps) if (s.date < today) before = s;

  if (before) {
    for (const it of items) {
      it.prev = Object.prototype.hasOwnProperty.call(before.ranks, it.id) ? before.ranks[it.id] : null;
    }
  }

  const ranks = {};
  for (const it of items) ranks[it.id] = it.rank;
  const rest = snaps.filter(function (s) { return s.date !== today; });
  rest.push({ date: today, ranks: ranks });
  history[key] = rest.slice(-KEEP_DAYS);
  saveHistory();

  return before ? before.date : null;
}

/* ---------- Platform fetchers ---------- */

async function youtubeChart(region) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.search = new URLSearchParams({
    part: "snippet,statistics",
    chart: "mostPopular",
    videoCategoryId: "10", // Music
    regionCode: YOUTUBE_REGIONS[region],
    maxResults: "10",
    key: YOUTUBE_API_KEY
  }).toString();

  const res = await fetch(url);
  if (!res.ok) throw new Error("YouTube API responded " + res.status);
  const json = await res.json();

  const items = (json.items || []).map(function (v, i) {
    const thumbs = v.snippet.thumbnails || {};
    const thumb = thumbs.medium || thumbs.default || {};
    return {
      id: v.id,
      rank: i + 1,
      title: v.snippet.title,
      artist: v.snippet.channelTitle.replace(/ - Topic$/i, "").replace(/VEVO$/i, ""),
      value: Number(v.statistics && v.statistics.viewCount) || 0,
      cover: thumb.url || null,
      url: "https://www.youtube.com/watch?v=" + v.id
    };
  });
  if (!items.length) throw new Error("YouTube returned no videos");
  return { unit: "views", items: items };
}

// Apple's public "most played" feed. No key needed, and it gives a ranking but no play counts.
async function appleChart(region) {
  const url = "https://rss.marketingtools.apple.com/api/v2/" + APPLE_COUNTRIES[region] + "/music/most-played/10/songs.json";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Apple feed responded " + res.status);
  const json = await res.json();
  const results = (json.feed && json.feed.results) || [];

  const items = results.map(function (s, i) {
    return {
      id: String(s.id),
      rank: i + 1,
      title: s.name,
      artist: s.artistName,
      value: null,
      cover: s.artworkUrl100 ? s.artworkUrl100.replace("100x100", "200x200") : null,
      url: s.url || null
    };
  });
  if (!items.length) throw new Error("Apple feed returned no songs");
  return { unit: "", items: items };
}

// One entry per connected platform. Spotify and SoundCloud can be added here later.
const FETCHERS = { youtube: youtubeChart, apple: appleChart };

async function getChart(platform, region) {
  const key = platform + ":" + region;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const data = await FETCHERS[platform](region);
    const since = applyMovement(key, data.items);
    const out = Object.assign(
      { platform: platform, region: region, source: "live", updated: new Date().toISOString(), since: since },
      data
    );
    cache.set(key, { at: Date.now(), data: out });
    return out;
  } catch (err) {
    if (hit) return hit.data; // serve the older copy rather than fail
    throw err;
  }
}

/* ---------- HTTP ---------- */

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const PUBLIC_DIR = path.join(__dirname, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch (e) {
    res.writeHead(400);
    return res.end("Bad request");
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, function (err, buf) {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://localhost");
  const m = url.pathname.match(/^\/api\/charts\/([a-z]+)$/);

  if (!m) return serveStatic(url.pathname, res);
  if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });

  const platform = m[1];
  const region = url.searchParams.get("region") || "ng";

  if (!FETCHERS[platform]) return sendJson(res, 501, { error: "not_connected", platform: platform });
  if (!YOUTUBE_REGIONS[region]) return sendJson(res, 400, { error: "unknown_region", region: region });
  if (platform === "youtube" && !YOUTUBE_API_KEY) return sendJson(res, 503, { error: "missing_api_key" });

  try {
    sendJson(res, 200, await getChart(platform, region));
  } catch (err) {
    console.error(platform, region, err.message);
    sendJson(res, 502, { error: "upstream_failed" });
  }
});

server.listen(PORT, function () {
  console.log("Chartwatch running at http://localhost:" + PORT);
  if (!YOUTUBE_API_KEY) console.log("No YOUTUBE_API_KEY set, so YouTube shows sample data.");
});
