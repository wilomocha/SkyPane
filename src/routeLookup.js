'use strict';

// adsbdb.com is a free, keyless companion API (same project family as adsb.lol)
// that resolves a callsign to airline/origin/destination, and a registration/hex
// to a friendly aircraft type. Raw ADS-B alone doesn't carry any of that.
const ADSBDB_BASE = process.env.ADSBDB_BASE_URL || 'https://api.adsbdb.com/v0';

// Primary route source: adsb.lol's vrs-standing-data (VirtualRadarServer standing
// data). Per-callsign JSON at /routes/{XX}/{CALLSIGN}.json where XX is the first
// two letters of the callsign. Each _airports entry carries coordinates, so we
// get origin/destination + lat/lon directly. Disable with VRS_ENABLED=false.
const VRS_BASE = (process.env.VRS_BASE_URL || 'https://vrs-standing-data.adsb.lol').replace(/\/+$/, '');
const VRS_ENABLED = String(process.env.VRS_ENABLED ?? 'true').toLowerCase() !== 'false';

const ROUTE_TTL_MS = 6 * 60 * 60 * 1000; // callsign->route rarely changes in a day
const AIRCRAFT_TTL_MS = 24 * 60 * 60 * 1000; // reg->aircraft type essentially static
const NEGATIVE_TTL_MS = 15 * 60 * 1000; // don't hammer lookups that 404

// ── Backup route source: airframes.io ────────────────────────────────────────
// Airframes' API is gated (requires an API key + a feeder or paid account). It
// is used only as a FALLBACK when adsbdb's route is missing or fails the
// position-plausibility check. Configure via environment variables:
//     AIRFRAMES_API_KEY   your key (leave empty to disable the backup entirely)
//     AIRFRAMES_BASE_URL  defaults to https://api.airframes.io/v1
const AIRFRAMES_BASE = (process.env.AIRFRAMES_BASE_URL || 'https://api.airframes.io/v1').replace(/\/+$/, '');
const AIRFRAMES_KEY = process.env.AIRFRAMES_API_KEY || '';

// ── Last-resort route source: FlightAware AeroAPI ─────────────────────────────
// Paid, keyed API. Used only as the final API layer (after vrs/adsbdb/airframes,
// before the user CSV) so paid queries stay rare; results are cached. AeroAPI's
// /flights airport objects don't include coordinates, so AeroAPI-sourced routes
// show origin→destination + city but no DTG/ETA. Configure via:
//     AEROAPI_KEY       your FlightAware AeroAPI key (empty = disabled)
//     AEROAPI_BASE_URL  defaults to https://aeroapi.flightaware.com/aeroapi
const AEROAPI_BASE = (process.env.AEROAPI_BASE_URL || 'https://aeroapi.flightaware.com/aeroapi').replace(/\/+$/, '');
const AEROAPI_KEY = process.env.AEROAPI_KEY || '';

const routeCache = new Map(); // callsign -> { at, expires, value }
const aircraftCache = new Map(); // key -> { at, expires, value }
const airframesCache = new Map(); // callsign -> { at, expires, value }
const vrsCache = new Map(); // callsign -> { at, expires, value }
const aeroapiCache = new Map(); // callsign -> { at, expires, value }

function getCached(cache, key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached(cache, key, value, ttl) {
  cache.set(key, { expires: Date.now() + ttl, value });
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`adsbdb request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// -> { airlineName, airlineIcao, callsignIata, origin, destination } | null
async function lookupRoute(icaoCallsign) {
  if (!icaoCallsign) return null;
  const key = icaoCallsign.toUpperCase();
  const cached = getCached(routeCache, key);
  if (cached !== undefined) return cached;

  let value = null;
  try {
    const body = await getJson(`${ADSBDB_BASE}/callsign/${encodeURIComponent(key)}`);
    const fr = body && body.response && body.response.flightroute;
    if (fr) {
      value = {
        callsignIata: fr.callsign_iata || null,
        airlineName: fr.airline ? fr.airline.name : null,
        airlineCallsign: fr.airline ? fr.airline.callsign : null,
        airlineIcao: fr.airline ? fr.airline.icao : null,
        origin: fr.origin
          ? {
              iata: fr.origin.iata_code || null,
              icao: fr.origin.icao_code || null,
              municipality: fr.origin.municipality || null,
              countryIso: fr.origin.country_iso_name || null,
              lat: typeof fr.origin.latitude === 'number' ? fr.origin.latitude : null,
              lon: typeof fr.origin.longitude === 'number' ? fr.origin.longitude : null,
            }
          : null,
        destination: fr.destination
          ? {
              iata: fr.destination.iata_code || null,
              icao: fr.destination.icao_code || null,
              municipality: fr.destination.municipality || null,
              countryIso: fr.destination.country_iso_name || null,
              lat: typeof fr.destination.latitude === 'number' ? fr.destination.latitude : null,
              lon: typeof fr.destination.longitude === 'number' ? fr.destination.longitude : null,
            }
          : null,
      };
    }
  } catch (err) {
    setCached(routeCache, key, null, NEGATIVE_TTL_MS);
    return null;
  }
  setCached(routeCache, key, value, value ? ROUTE_TTL_MS : NEGATIVE_TTL_MS);
  return value;
}

function numOr2(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Map a vrs-standing-data per-callsign JSON into our common route shape.
// Origin = first airport, destination = last (intermediate stops are ignored).
function mapVrsRoute(body) {
  const airports = Array.isArray(body && body._airports) ? body._airports : [];
  if (airports.length < 1) return null;
  const toAirport = (a) =>
    a
      ? {
          iata: a.iata || null,
          icao: a.icao || null,
          municipality: a.location || a.name || null, // "location" is the city
          countryIso: a.countryiso2 || null,
          lat: numOr2(a.lat),
          lon: numOr2(a.lon),
        }
      : null;
  const origin = toAirport(airports[0]);
  const destination = toAirport(airports[airports.length - 1]);
  if (!origin && !destination) return null;
  return {
    callsignIata: null,
    airlineName: null, // vrs JSON has only the ICAO airline code, not a name
    airlineCallsign: null,
    airlineIcao: (body.airline_code || '').toUpperCase() || null,
    origin,
    destination,
    _source: 'vrs',
  };
}

// Primary route lookup via vrs-standing-data. -> route | null
async function lookupRouteVrs(icaoCallsign) {
  if (!icaoCallsign || !VRS_ENABLED) return null;
  const key = icaoCallsign.toUpperCase().replace(/\s+/g, '');
  const cached = getCached(vrsCache, key);
  if (cached !== undefined) return cached;

  let value = null;
  try {
    const prefix = key.slice(0, 2); // subdirectory is the first two characters
    const body = await getJson(`${VRS_BASE}/routes/${encodeURIComponent(prefix)}/${encodeURIComponent(key)}.json`);
    if (body) value = mapVrsRoute(body);
  } catch (err) {
    setCached(vrsCache, key, null, NEGATIVE_TTL_MS);
    return null;
  }
  setCached(vrsCache, key, value, value ? ROUTE_TTL_MS : NEGATIVE_TTL_MS);
  return value;
}

// -> { typeName, icaoType, registeredOwner } | null
async function lookupAircraft(registrationOrHex) {
  if (!registrationOrHex) return null;
  const key = registrationOrHex.toUpperCase();
  const cached = getCached(aircraftCache, key);
  if (cached !== undefined) return cached;

  let value = null;
  try {
    const body = await getJson(`${ADSBDB_BASE}/aircraft/${encodeURIComponent(key)}`);
    const ac = body && body.response && body.response.aircraft;
    if (ac) {
      value = {
        typeName: ac.type || null,
        icaoType: ac.icao_type || null,
        registeredOwner: ac.registered_owner || null,
      };
    }
  } catch (err) {
    setCached(aircraftCache, key, null, NEGATIVE_TTL_MS);
    return null;
  }
  setCached(aircraftCache, key, value, value ? AIRCRAFT_TTL_MS : NEGATIVE_TTL_MS);
  return value;
}

function numOr(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v != null && v !== '' && Number.isFinite(+v)) return +v;
  return null;
}

// Map an Airframes /flights response into our common route shape.
//
// NOTE: Airframes' API is gated and its exact response schema could not be
// verified while building this. This maps the most likely field names; if your
// account's responses differ, adjust the field paths below to match — the rest
// of the integration (auth, caching, plausibility, quota handling) stays the
// same. Returns null if it can't find origin/destination.
function mapAirframesRoute(body) {
  const f = Array.isArray(body && body.flights)
    ? body.flights[0]
    : Array.isArray(body && body.data)
      ? body.data[0]
      : (body && body.flight) || body;
  if (!f) return null;

  const o = f.origin || f.departure || f.from;
  const d = f.destination || f.arrival || f.to;
  if (!o && !d) return null;

  const airport = (x) =>
    x
      ? {
          iata: x.iata || x.iata_code || null,
          icao: x.icao || x.icao_code || null,
          municipality: x.municipality || x.city || x.name || null,
          countryIso: x.country_iso || x.country_iso_name || x.country || null,
          lat: numOr(x.latitude != null ? x.latitude : x.lat),
          lon: numOr(x.longitude != null ? x.longitude : x.lon),
        }
      : null;

  return {
    callsignIata: f.callsign_iata || f.iata || null,
    airlineName: (f.airline && f.airline.name) || f.airline_name || null,
    airlineCallsign: (f.airline && f.airline.callsign) || null,
    airlineIcao: (f.airline && f.airline.icao) || null,
    origin: airport(o),
    destination: airport(d),
  };
}

// Backup route lookup. Returns { available, route }.
//   available=false  -> backup disabled (no API key) — not an error.
// Throws err with err.quota=true when the API key is out of quota / unauthorized,
// so the caller can suppress the (untrusted) route.
async function lookupRouteAirframes(icaoCallsign) {
  if (!icaoCallsign || !AIRFRAMES_KEY) return { available: false, route: null };
  const key = icaoCallsign.toUpperCase();

  const cached = getCached(airframesCache, key);
  if (cached !== undefined) return { available: true, route: cached };

  const url = `${AIRFRAMES_BASE}/flights?callsign=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${AIRFRAMES_KEY}` },
    signal: AbortSignal.timeout(8000),
  });

  if (res.status === 429 || res.status === 402 || res.status === 401 || res.status === 403) {
    const err = new Error(`airframes quota/auth error: ${res.status}`);
    err.quota = true;
    throw err;
  }
  if (res.status === 404) {
    setCached(airframesCache, key, null, NEGATIVE_TTL_MS);
    return { available: true, route: null };
  }
  if (!res.ok) throw new Error(`airframes request failed: ${res.status} ${res.statusText}`);

  const body = await res.json();
  const route = mapAirframesRoute(body);
  setCached(airframesCache, key, route, route ? ROUTE_TTL_MS : NEGATIVE_TTL_MS);
  return { available: true, route };
}

function airframesEnabled() {
  return !!AIRFRAMES_KEY;
}

// Map an AeroAPI /flights/{ident} response into our common route shape.
// AeroAPI airport objects carry codes + city + name but no coordinates.
function mapAeroApiRoute(body) {
  const flights = Array.isArray(body && body.flights) ? body.flights : [];
  if (!flights.length) return null;
  // Prefer a flight that actually has both endpoints; else the first (most recent).
  const f = flights.find((x) => x && x.origin && x.destination) || flights[0];
  if (!f) return null;

  const airport = (a) =>
    a
      ? {
          iata: a.code_iata || null,
          icao: a.code_icao || a.code || null,
          municipality: a.city || a.name || null,
          countryIso: null, // not present on the /flights airport object
          lat: null,
          lon: null,
        }
      : null;

  const origin = airport(f.origin);
  const destination = airport(f.destination);
  if (!origin && !destination) return null;
  return {
    callsignIata: f.ident_iata || null,
    airlineName: null,
    airlineCallsign: null,
    airlineIcao: (f.operator_icao || f.operator || '').toUpperCase() || null,
    origin,
    destination,
    _source: 'aeroapi',
  };
}

// Last-resort route lookup via FlightAware AeroAPI. Returns { available, route }.
// available=false -> disabled (no key). Throws err.quota=true on auth/quota/rate
// errors so the caller can fall through to the CSV.
async function lookupRouteAeroApi(icaoCallsign) {
  if (!icaoCallsign || !AEROAPI_KEY) return { available: false, route: null };
  const key = icaoCallsign.toUpperCase().replace(/\s+/g, '');

  const cached = getCached(aeroapiCache, key);
  if (cached !== undefined) return { available: true, route: cached };

  const url = `${AEROAPI_BASE}/flights/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'x-apikey': AEROAPI_KEY },
    signal: AbortSignal.timeout(8000),
  });

  if (res.status === 401 || res.status === 403 || res.status === 402 || res.status === 429) {
    const err = new Error(`aeroapi quota/auth error: ${res.status}`);
    err.quota = true;
    throw err;
  }
  if (res.status === 404) {
    setCached(aeroapiCache, key, null, NEGATIVE_TTL_MS);
    return { available: true, route: null };
  }
  if (!res.ok) throw new Error(`aeroapi request failed: ${res.status} ${res.statusText}`);

  const body = await res.json();
  const route = mapAeroApiRoute(body);
  setCached(aeroapiCache, key, route, route ? ROUTE_TTL_MS : NEGATIVE_TTL_MS);
  return { available: true, route };
}

function aeroapiEnabled() {
  return !!AEROAPI_KEY;
}

module.exports = {
  lookupRouteVrs,
  lookupRoute,
  lookupAircraft,
  lookupRouteAirframes,
  airframesEnabled,
  lookupRouteAeroApi,
  aeroapiEnabled,
};
