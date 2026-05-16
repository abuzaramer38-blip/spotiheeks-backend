/**
 * SpotiHeeks — Backend API Server
 * Node.js / Express — Deploy on Render or Railway (free tier)
 *
 * Routes:
 *   POST /api/info      → Fetch Spotify metadata (track / album / playlist)
 *   POST /api/download  → Download & convert audio to MP3, stream to client
 *   GET  /health        → Health check
 *
 * Requires:
 *   npm install express cors axios dotenv fluent-ffmpeg node-fetch ytdl-core
 *   System dependency: ffmpeg, yt-dlp (installed via Dockerfile / render.yaml)
 */

require('dotenv').config();

const express      = require('express');
const cors         = require('cors');
const axios        = require('axios');
const { execFile } = require('child_process');
const path         = require('path');
const os           = require('os');
const fs           = require('fs');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app           = express();
const PORT          = process.env.PORT || 3000;

/* ── Environment ─────────────────────────────────────────────────────────────
   Set these in Render / Railway environment variables:
     SPOTIFY_CLIENT_ID     = 1697c046b92146e29b69af2870861687
     SPOTIFY_CLIENT_SECRET = 66ef0cd879a444269934c67b632c61b3
     ALLOWED_ORIGIN        = https://spotiheeks.com
     PORT                  = (auto-set by platform)
 ──────────────────────────────────────────────────────────────────────────── */
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || '1697c046b92146e29b69af2870861687';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '66ef0cd879a444269934c67b632c61b3';
const ALLOWED_ORIGIN        = process.env.ALLOWED_ORIGIN        || '*';

/* ── CORS ─────────────────────────────────────────────────────────────────── */
app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? '*' : (origin, cb) => {
    const allowed = ALLOWED_ORIGIN.split(',').map(o => o.trim());
    if (!origin || allowed.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

/* ── Rate-limit (simple in-memory, no Redis needed on free tier) ─────────── */
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60_000;   // 1 minute
  const maxReqs  = 20;

  if (!rateMap.has(ip)) rateMap.set(ip, []);
  const times = rateMap.get(ip).filter(t => now - t < windowMs);
  if (times.length >= maxReqs) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  times.push(now);
  rateMap.set(ip, times);
  next();
}
// Prune map every 5 min to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of rateMap) {
    const fresh = times.filter(t => now - t < 60_000);
    if (fresh.length === 0) rateMap.delete(ip); else rateMap.set(ip, fresh);
  }
}, 300_000);

/* ── Spotify Token Cache ──────────────────────────────────────────────────── */
let spotifyToken      = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;

  const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const { data } = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10_000,
    }
  );

  spotifyToken       = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

/* ── Spotify API Helpers ──────────────────────────────────────────────────── */
function parseSpotifyUrl(url) {
  const m = url.match(/open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  return { type: m[1], id: m[2] };
}

async function spotifyFetch(endpoint) {
  const token = await getSpotifyToken();
  const { data } = await axios.get(`https://api.spotify.com/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15_000,
  });
  return data;
}

async function fetchTrack(id) {
  const t = await spotifyFetch(`tracks/${id}`);
  return {
    type      : 'track',
    id        : t.id,
    name      : t.name,
    artists   : t.artists,
    album     : t.album,
    cover_art : t.album?.images?.[0]?.url || null,
    duration_ms: t.duration_ms,
    preview_url: t.preview_url,
  };
}

async function fetchAlbum(id) {
  const a = await spotifyFetch(`albums/${id}?limit=50`);
  return {
    type    : 'album',
    id      : a.id,
    name    : a.name,
    images  : a.images,
    owner   : { display_name: a.artists?.map(x => x.name).join(', ') },
    tracks  : {
      total: a.tracks?.total,
      items: (a.tracks?.items || []).map(t => ({
        track: {
          id     : t.id,
          name   : t.name,
          artists: t.artists,
          album  : { name: a.name, images: a.images },
          duration_ms: t.duration_ms,
        },
      })),
    },
  };
}

async function fetchPlaylist(id) {
  // Spotify limits to 100 items per page — fetch first 100
  const p = await spotifyFetch(`playlists/${id}?fields=id,name,images,owner,tracks.total,tracks.items(track(id,name,artists,album(name,images),duration_ms))`);
  return {
    type   : 'playlist',
    id     : p.id,
    name   : p.name,
    images : p.images,
    owner  : p.owner,
    tracks : p.tracks,
  };
}

/* ── Audio Fetching via yt-dlp ────────────────────────────────────────────── */
async function buildSearchQuery(trackName, artists) {
  const artistStr = artists.map(a => a.name).join(', ');
  return `ytsearch1:${artistStr} - ${trackName} audio`;
}

async function downloadAudioToFile(query, outPath) {
  /*
   * yt-dlp is a fast, maintained fork of youtube-dl.
   * It pulls from YouTube (and other sites) using the search query.
   * On Render, install via: pip install yt-dlp
   * On Railway, add to Dockerfile: RUN pip install yt-dlp
   */
  await execFileAsync('yt-dlp', [
    '--no-playlist',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',          // best quality
    '--output', outPath,
    '--no-warnings',
    '--quiet',
    '--socket-timeout', '30',
    '--no-cache-dir',
    query,
  ], { timeout: 120_000 });           // 2-min timeout
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

/* Health check */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* /api/info — Fetch metadata */
app.post('/api/info', rateLimit, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "url" field.' });
  }

  const parsed = parseSpotifyUrl(url);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid Spotify URL. Only track, album, and playlist links are supported.' });
  }

  try {
    let data;
    if (parsed.type === 'track')    data = await fetchTrack(parsed.id);
    else if (parsed.type === 'album')    data = await fetchAlbum(parsed.id);
    else if (parsed.type === 'playlist') data = await fetchPlaylist(parsed.id);
    else return res.status(400).json({ error: 'Unsupported Spotify content type.' });

    res.json(data);
  } catch (err) {
    console.error('[/api/info]', err.message);
    if (err.response?.status === 404) return res.status(404).json({ error: 'Spotify item not found.' });
    if (err.response?.status === 401) return res.status(502).json({ error: 'Spotify authentication failed.' });
    res.status(502).json({ error: 'Failed to fetch track info from Spotify.' });
  }
});

/* /api/download — Download & stream MP3 */
app.post('/api/download', rateLimit, async (req, res) => {
  const { track_id } = req.body || {};
  if (!track_id || typeof track_id !== 'string') {
    return res.status(400).json({ error: 'Missing "track_id".' });
  }

  let tmpFile = null;

  try {
    // 1. Fetch track metadata
    const track     = await fetchTrack(track_id);
    const trackName = track.name;
    const artists   = track.artists;

    // 2. Build YouTube search query
    const query = await buildSearchQuery(trackName, artists);

    // 3. Create a temp file path
    const safeTitle  = trackName.replace(/[^a-z0-9 ]/gi, '').trim().slice(0, 60);
    const safeArtist = artists[0]?.name.replace(/[^a-z0-9 ]/gi, '').trim() || 'artist';
    const filename   = `${safeArtist} - ${safeTitle}.mp3`;
    tmpFile          = path.join(os.tmpdir(), `spotiheeks_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

    // 4. Download audio
    await downloadAudioToFile(query, tmpFile);

    if (!fs.existsSync(tmpFile)) {
      throw new Error('Audio file was not created.');
    }

    const stat = fs.statSync(tmpFile);
    if (stat.size < 1024) {
      throw new Error('Downloaded file is too small — may be an error page.');
    }

    // 5. Stream the file to the client
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Track-Name', encodeURIComponent(trackName));
    res.setHeader('X-Artist-Name', encodeURIComponent(safeArtist));

    const fileStream = fs.createReadStream(tmpFile);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      // Cleanup temp file after streaming
      fs.unlink(tmpFile, () => {});
      tmpFile = null;
    });

    fileStream.on('error', (err) => {
      console.error('[stream error]', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Streaming failed.' });
      }
    });

    req.on('close', () => {
      // Client disconnected — cleanup
      if (tmpFile) { fs.unlink(tmpFile, () => {}); tmpFile = null; }
    });

  } catch (err) {
    // Cleanup on error
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) {} }

    console.error('[/api/download]', err.message);

    if (!res.headersSent) {
      if (err.message.includes('not found')) return res.status(404).json({ error: 'Track not found on Spotify.' });
      res.status(500).json({ error: 'Failed to process download. Please try again.' });
    }
  }
});

/* ── 404 handler ─────────────────────────────────────────────────────────── */
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

/* ── Error handler ───────────────────────────────────────────────────────── */
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

/* ── Start ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`✅ SpotiHeeks API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});

module.exports = app;
