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
// Optional free online store for the daily history (Upstash Redis). Without it, a local file is used.
// Settings pasted into a host's dashboard often carry stray spaces, line breaks or quote marks, so clean them.
function cleanSetting(v) {
  return v ? v.trim().replace(/^["'`]+|["'`]+$/g, "").trim() : v;
}
const REDIS_URL = cleanSetting(process.env.UPSTASH_REDIS_REST_URL);
const REDIS_TOKEN = cleanSetting(process.env.UPSTASH_REDIS_REST_TOKEN);
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const HISTORY_KEY = "chartwatch:history";
const CACHE_MS = 60 * 60 * 1000; // refresh each chart at most once an hour
const KEEP_DAYS = 3; // daily snapshots kept per chart. Only the latest earlier day is used for the arrows.
const CHART_SIZE = 50;

// Countries offered on the page. "yt" is YouTube's regionCode, "apple" is Apple's storefront code, and
// "deezer" lists the names Deezer's own country-chart playlist might have (first exact match wins).
const COUNTRIES = {
  ng: { name: "Nigeria", yt: "NG", apple: "ng", deezer: ["Top Nigeria"] },
  gh: { name: "Ghana", yt: "GH", apple: "gh", deezer: ["Top Ghana"] },
  za: { name: "South Africa", yt: "ZA", apple: "za", deezer: ["Top South Africa"] },
  ke: { name: "Kenya", yt: "KE", apple: "ke", deezer: ["Top Kenya"] },
  gb: { name: "United Kingdom", yt: "GB", apple: "gb", deezer: ["Top United Kingdom", "Top UK"] },
  us: { name: "United States", yt: "US", apple: "us", deezer: ["Top United States", "Top USA", "Top US"] }
};
const COUNTRY_IDS = Object.keys(COUNTRIES);
const REGIONS_BY_PLATFORM = {
  youtube: COUNTRY_IDS,
  apple: COUNTRY_IDS,
  deezer: COUNTRY_IDS.concat(["gl"]) // "gl" is Deezer's worldwide chart
};

const cache = new Map();

/* ---------- Daily snapshots, used for the up/down/NEW markers ---------- */

let history = {};
let historyLoaded = false; // stays false if the online store could not be read, so we never overwrite it with an empty copy

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error("Redis responded " + res.status);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function loadHistory() {
  try {
    if (USE_REDIS) {
      const stored = await redis(["GET", HISTORY_KEY]);
      history = stored ? JSON.parse(stored) : {};
    } else {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      } catch (e) {
        history = {}; // no file yet
      }
    }
    historyLoaded = true;
  } catch (e) {
    console.error("Could not load history:", e.message);
    if (USE_REDIS && /401/.test(e.message)) {
      console.error(
        "Upstash rejected the token. Using database " + new URL(REDIS_URL).hostname +
        " and a token of " + REDIS_TOKEN.length + " characters. Check that the URL and token come from the same database, " +
        "and that the token is the normal one, not read-only."
      );
    }
  }
}

function writeHistoryNow() {
  if (!historyLoaded) return;
  if (USE_REDIS) {
    redis(["SET", HISTORY_KEY, JSON.stringify(history)]).catch(function (e) {
      console.error("Could not save history:", e.message);
    });
    return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    console.error("Could not save history:", e.message);
  }
}

// Many charts refresh together, so saves are grouped into one write a couple of seconds later.
let saveTimer = null;
function saveHistory() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    writeHistoryNow();
  }, 2000);
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
// Each returns { unit, items: [{ id, rank, title, artist, value, cover, url, preview?, embed? }] }.
// "preview" is a 30-second audio file. "embed" is a YouTube video id for the official embedded player.

// "PT3M45S" -> 225 seconds.
function isoSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
// Where a 30-second YouTube preview starts: a quarter of the way in, which skips most intros.
function previewStart(totalSeconds) {
  if (!totalSeconds) return 0;
  return Math.max(0, Math.min(Math.floor(totalSeconds * 0.25), totalSeconds - 35, 90));
}

async function youtubeChart(region) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.search = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    chart: "mostPopular",
    videoCategoryId: "10", // Music
    regionCode: COUNTRIES[region].yt,
    maxResults: String(CHART_SIZE),
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
      url: "https://www.youtube.com/watch?v=" + v.id,
      embed: v.id,
      previewStart: previewStart(isoSeconds(v.contentDetails && v.contentDetails.duration))
    };
  });
  if (!items.length) throw new Error("YouTube returned no videos");
  return { unit: "total views", items: items };
}

// Apple's feed gives a ranking but no previews, so previews come from Apple's public lookup. If that fails, rows just have no play button.
async function applyApplePreviews(items, country) {
  try {
    const ids = items.map(function (i) { return i.id; }).join(",");
    const res = await fetch("https://itunes.apple.com/lookup?id=" + ids + "&country=" + country);
    if (!res.ok) throw new Error("responded " + res.status);
    const json = await res.json();
    const byId = {};
    for (const r of json.results || []) if (r.trackId && r.previewUrl) byId[String(r.trackId)] = r.previewUrl;
    for (const it of items) if (byId[it.id]) it.preview = byId[it.id];
  } catch (e) {
    console.error("Apple previews:", e.message);
  }
}

// Apple's public "most played" feed. No key needed, and it gives a ranking but no play counts.
async function appleChart(region) {
  const country = COUNTRIES[region].apple;
  const url = "https://rss.marketingtools.apple.com/api/v2/" + country + "/music/most-played/" + CHART_SIZE + "/songs.json";
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
  await applyApplePreviews(items, country);
  return { unit: "", items: items };
}

// Deezer's open charts. No key needed, and the page labels them as Deezer. "gl" is the worldwide chart.
// A country chart is Deezer's own "Top <country>" playlist, found by name the first time it is needed.
// If that playlist can't be found, the worldwide chart is returned and marked as a fallback.
const deezerPlaylistIds = {};

async function deezerGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Deezer responded " + res.status);
  return res.json();
}

async function deezerCountryTracks(region) {
  let id = deezerPlaylistIds[region];
  if (!id) {
    for (const name of COUNTRIES[region].deezer) {
      const found = await deezerGet("https://api.deezer.com/search/playlist?q=" + encodeURIComponent(name));
      const hit = (found.data || []).find(function (p) {
        return (p.title || "").toLowerCase() === name.toLowerCase() && p.user && /deezer/i.test(p.user.name || "");
      });
      if (hit) { id = deezerPlaylistIds[region] = hit.id; break; }
    }
    if (!id) throw new Error(COUNTRIES[region].name + " chart playlist not found");
  }
  const json = await deezerGet("https://api.deezer.com/playlist/" + id + "/tracks?limit=" + CHART_SIZE);
  return json.data || [];
}

async function deezerChart(region) {
  let tracks = null;
  let scope = "worldwide";
  if (region !== "gl") {
    try {
      tracks = await deezerCountryTracks(region);
      if (tracks.length) scope = "country"; else tracks = null;
    } catch (e) {
      console.error("Deezer " + region + " chart:", e.message);
      tracks = null;
    }
  }
  if (!tracks) {
    const json = await deezerGet("https://api.deezer.com/chart/0/tracks?limit=" + CHART_SIZE);
    tracks = json.data || (json.tracks && json.tracks.data) || [];
  }

  const items = tracks.map(function (t, i) {
    const album = t.album || {};
    return {
      id: String(t.id),
      rank: i + 1,
      title: t.title,
      artist: t.artist ? t.artist.name : "",
      value: null,
      cover: album.cover_medium || album.cover || null,
      url: t.link || null,
      preview: t.preview || null
    };
  });
  if (!items.length) throw new Error("Deezer returned no tracks");
  return { unit: "", scope: scope, items: items };
}

// Spotify and SoundCloud have no open chart feed for new developers (see README), so they are not listed here.
const FETCHERS = { youtube: youtubeChart, apple: appleChart, deezer: deezerChart };

async function getChart(platform, region, force) {
  const key = platform + ":" + region;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  try {
    const data = await FETCHERS[platform](region);
    // A worldwide fallback must not be compared with a real country chart, so it gets its own history entry.
    const historyKey = data.scope === "worldwide" && region !== "gl" ? key + ":ww" : key;
    const since = applyMovement(historyKey, data.items);
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
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
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

  if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
  if (!m) return serveStatic(url.pathname, res);
  if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });

  const platform = m[1];
  const region = url.searchParams.get("region") || "ng";

  if (!FETCHERS[platform]) return sendJson(res, 501, { error: "not_connected", platform: platform });
  if (!REGIONS_BY_PLATFORM[platform].includes(region)) return sendJson(res, 400, { error: "unknown_region", region: region });
  if (platform === "youtube" && !YOUTUBE_API_KEY) return sendJson(res, 503, { error: "missing_api_key" });

  try {
    sendJson(res, 200, await getChart(platform, region));
  } catch (err) {
    console.error(platform, region, err.message);
    sendJson(res, 502, { error: "upstream_failed" });
  }
});

// Refreshes every chart on a timer, so history is saved and charts stay warm even with no visitors.
async function refreshAll() {
  if (!historyLoaded) await loadHistory();
  for (const platform of Object.keys(FETCHERS)) {
    if (platform === "youtube" && !YOUTUBE_API_KEY) continue;
    for (const region of REGIONS_BY_PLATFORM[platform]) {
      try {
        await getChart(platform, region, true);
      } catch (err) {
        console.error("refresh", platform, region, err.message);
      }
    }
  }
}

loadHistory().then(function () {
  server.listen(PORT, function () {
    console.log("Chartwatch running at http://localhost:" + PORT);
    console.log("History is stored " + (USE_REDIS ? "in Upstash Redis." : "in " + HISTORY_FILE + "."));
    if (!YOUTUBE_API_KEY) console.log("No YOUTUBE_API_KEY set, so YouTube shows sample data.");
    refreshAll();
    setInterval(refreshAll, CACHE_MS);
  });
});
