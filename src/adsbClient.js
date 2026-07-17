'use strict';

// ADS-B position sources, tried in order. All three expose the ADSBExchange-v2
// `{ ac: [...] }` shape, so they're interchangeable. When one returns HTTP 429
// (rate limited) we put it on a cooldown and fail over to the next, so live data
// keeps flowing. Bases are overridable via environment variables.
const SOURCES = [
  {
    name: 'adsb.lol',
    url: (lat, lon, r) => `${process.env.ADSB_BASE_URL || 'https://api.adsb.lol/v2'}/point/${lat}/${lon}/${r}`,
  },
  {
    name: 'adsb.fi',
    url: (lat, lon, r) => `${process.env.ADSBFI_BASE_URL || 'https://opendata.adsb.fi/api'}/v3/lat/${lat}/lon/${lon}/dist/${r}`,
  },
  {
    name: 'airplanes.live',
    url: (lat, lon, r) => `${process.env.AIRPLANESLIVE_BASE_URL || 'https://api.airplanes.live/v2'}/point/${lat}/${lon}/${r}`,
  },
];
const PRIMARY_SOURCE = SOURCES[0].name;

// After a 429, skip that source for this long before trying it again.
const SOURCE_COOLDOWN_MS = Number(process.env.ADSB_SOURCE_COOLDOWN_MS) || 60000;
const cooldownUntil = new Map(); // source name -> ms timestamp

// These public feeds throttle unidentified clients hard. Send a descriptive
// User-Agent (their etiquette). Override with ADSB_USER_AGENT (your contact/URL).
const USER_AGENT =
  process.env.ADSB_USER_AGENT ||
  'SkyPane/1.0 (personal airspace monitor; https://github.com/)';

async function fetchFromSource(source, lat, lon, queryRadius) {
  const res = await fetch(source.url(lat, lon, queryRadius), {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const err = new Error(`${source.name} lookup failed: ${res.status} ${res.statusText}`);
    err.status = res.status;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter && Number.isFinite(+retryAfter)) {
      err.retryAfterMs = Math.max(0, +retryAfter * 1000);
    }
    throw err;
  }
  const body = await res.json();
  return Array.isArray(body.ac) ? body.ac : [];
}

// Aircraft within `radiusNM` NM of (lat, lon). The point/dist endpoints take an
// integer radius in NM (max 250); we ceil small fractional zone radii up so the
// query covers the zone, then filter precisely by real distance ourselves.
//
// Returns { aircraft, source, fallback } where `source` is the feed that served
// the data and `fallback` is true when it wasn't the primary (adsb.lol). Throws
// only when every source is unavailable (err.status = 429 if rate limits were
// the cause, so the caller can back off).
async function fetchAircraftNear(lat, lon, radiusNM) {
  const queryRadius = Math.max(1, Math.min(250, Math.ceil(radiusNM)));
  const now = Date.now();
  let attempted = 0;
  let sawRateLimit = false;
  let lastErr = null;

  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i];
    if ((cooldownUntil.get(source.name) || 0) > now) continue; // still cooling down
    attempted++;
    try {
      const aircraft = await fetchFromSource(source, lat, lon, queryRadius);
      return { aircraft, source: source.name, fallback: source.name !== PRIMARY_SOURCE };
    } catch (err) {
      lastErr = err;
      if (err.status === 429) {
        sawRateLimit = true;
        cooldownUntil.set(source.name, Date.now() + SOURCE_COOLDOWN_MS);
        console.warn(`[adsb] ${source.name} rate-limited (429); cooling ${Math.round(SOURCE_COOLDOWN_MS / 1000)}s and trying next source`);
      } else {
        cooldownUntil.set(source.name, Date.now() + Math.min(SOURCE_COOLDOWN_MS, 15000));
        console.warn(`[adsb] ${source.name} failed (${err.message}); trying next source`);
      }
    }
  }

  const err = new Error(
    attempted ? 'all ADS-B sources failed' : 'all ADS-B sources cooling down (rate limited)'
  );
  // If nothing could even be attempted, they're all in cooldown — treat as rate
  // limited so the caller backs off rather than hammering.
  if (sawRateLimit || attempted === 0) err.status = 429;
  err.cause = lastErr;
  throw err;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Normalize a raw adsb.lol aircraft record into the fields we care about.
function normalizeAircraft(ac) {
  const altBaro = ac.alt_baro === 'ground' ? 0 : numOrNull(ac.alt_baro);
  const altGeom = numOrNull(ac.alt_geom);
  const vr = numOrNull(ac.baro_rate) ?? numOrNull(ac.geom_rate);
  return {
    hex: ac.hex,
    flight: typeof ac.flight === 'string' ? ac.flight.trim() : null,
    registration: ac.r || null,
    typeCode: ac.t || null,
    lat: numOrNull(ac.lat),
    lon: numOrNull(ac.lon),
    altitudeFt: altBaro ?? altGeom ?? null,
    onGround: ac.alt_baro === 'ground',
    groundSpeedKt: numOrNull(ac.gs),
    trackDeg: numOrNull(ac.track) ?? numOrNull(ac.true_heading),
    vertRateFtMin: vr,
    squawk: ac.squawk || null,
    category: ac.category || null,
    seenSec: numOrNull(ac.seen) ?? 0,
    seenPosSec: numOrNull(ac.seen_pos),
  };
}

module.exports = { fetchAircraftNear, normalizeAircraft };
