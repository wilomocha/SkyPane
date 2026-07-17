'use strict';

const { fetchAircraftNear, normalizeAircraft } = require('./adsbClient');
const { lookupRouteVrs, lookupRoute, lookupAircraft, lookupRouteAirframes, lookupRouteAeroApi } = require('./routeLookup');
const { distanceNM, flagEmoji } = require('./geo');
const { colorForAirline, GENERIC_COLOR } = require('./airlineColors');
const { estimateEtaMinutes, evaluateRoute } = require('./estimate');
const { logoForAirline } = require('./logos');
const { aircraftTypeName } = require('./aircraftTypes');
const { lookupRouteCsv, csvOverride } = require('./routesCsv');

const POLL_MS = Number(process.env.ADSB_POLL_MS) || 10000;
const GRACE_MS = POLL_MS * 4; // tolerate a few missed ADS-B updates before calling it "left the zone"
const TEARDOWN_MS = 20000; // keep an unwatched zone's poller warm briefly in case of quick reconnects
const MAX_BACKOFF_MS = 60000; // ceiling for 429 rate-limit backoff
const STALE_MS = 30000; // keep showing the last good frame through errors up to this long

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sanitizeZoneConfig(raw) {
  const lat = clamp(Number(raw.lat), -90, 90);
  const lon = clamp(Number(raw.lon), -180, 180);
  const radiusNM = clamp(Number(raw.radiusNM), 0.1, 50);
  let altFloor = clamp(Number(raw.altFloor), -1000, 460000);
  let altCeil = clamp(Number(raw.altCeil), -1000, 460000);
  if (altFloor > altCeil) [altFloor, altCeil] = [altCeil, altFloor];
  if ([lat, lon, radiusNM, altFloor, altCeil].some((n) => !Number.isFinite(n))) {
    return null;
  }
  return { lat, lon, radiusNM, altFloor, altCeil };
}

function zoneKey(cfg) {
  return [
    cfg.lat.toFixed(4),
    cfg.lon.toFixed(4),
    cfg.radiusNM.toFixed(1),
    Math.round(cfg.altFloor),
    Math.round(cfg.altCeil),
  ].join(':');
}

class ZoneWatcher {
  constructor(key, config) {
    this.key = key;
    this.config = config;
    this.subscribers = new Set();
    this.enteredAt = new Map(); // hex -> ms timestamp first seen this stay
    this.lastSeenAt = new Map(); // hex -> ms timestamp last seen in zone
    this.snapshot = new Map(); // hex -> latest normalized aircraft data
    this.currentHex = null;
    this.currentSwitchedAt = 0;
    this.lastPayload = null;
    this.teardownTimer = null;
    this.pollTimer = null;
    this.backoffUntil = 0; // skip polling until this timestamp (429 cooldown)
    this.backoffMs = 0; // current backoff window, grows on repeated 429s
    this.lastGoodAt = 0; // timestamp of last successful adsb.lol response
    this.activeSource = null; // which ADS-B feed last served data
    this.sourceFallback = false; // true when that feed isn't the primary
    this._lastSource = null;
  }

  start() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  addSubscriber(ws) {
    this.subscribers.add(ws);
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    if (this.lastPayload) ws.send(JSON.stringify(this.lastPayload));
  }

  removeSubscriber(ws) {
    this.subscribers.delete(ws);
  }

  broadcast(payload) {
    this.lastPayload = payload;
    const msg = JSON.stringify(payload);
    for (const ws of this.subscribers) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  handleFetchError(err) {
    const now = Date.now();
    if (err.status === 429) {
      // Respect Retry-After if given, otherwise exponential backoff up to the ceiling.
      const next =
        err.retryAfterMs && err.retryAfterMs > 0
          ? err.retryAfterMs
          : Math.min(MAX_BACKOFF_MS, Math.max(POLL_MS * 2, (this.backoffMs || POLL_MS) * 2));
      this.backoffMs = next;
      this.backoffUntil = now + next;
      console.warn(
        `[zone ${this.key}] adsb.lol rate-limited (429); backing off ${Math.round(next / 1000)}s`
      );
    } else {
      console.error(`[zone ${this.key}] adsb.lol lookup failed: ${err.message}`);
    }

    // Ride through transient errors: keep showing the last good frame until it
    // goes stale, so a brief 429 doesn't flash an error over live traffic.
    if (this.lastPayload && this.lastPayload.hasPlane && now - this.lastGoodAt < STALE_MS) {
      return;
    }
    this.broadcast({
      ...(this.lastPayload || {}),
      type: 'update',
      ok: false,
      hasPlane: false,
      statusLabel: err.status === 429 ? 'RATE LIMITED' : 'SIGNAL ERROR',
    });
  }

  async poll() {
    if (Date.now() < this.backoffUntil) return; // in rate-limit cooldown; skip this tick

    const { lat, lon, radiusNM, altFloor, altCeil } = this.config;
    let raw;
    try {
      const result = await fetchAircraftNear(lat, lon, radiusNM);
      raw = result.aircraft;
      this.activeSource = result.source;
      this.sourceFallback = result.fallback;
      if (result.source !== this._lastSource) {
        if (result.fallback) console.warn(`[zone ${this.key}] ADS-B source switched to fallback: ${result.source}`);
        else if (this._lastSource) console.log(`[zone ${this.key}] ADS-B source back to primary: ${result.source}`);
        this._lastSource = result.source;
      }
      this.backoffMs = 0;
      this.backoffUntil = 0;
    } catch (err) {
      this.handleFetchError(err);
      return;
    }

    const now = Date.now();
    this.lastGoodAt = now;
    const inZoneNow = [];
    for (const rawAc of raw) {
      const ac = normalizeAircraft(rawAc);
      if (!ac.hex || ac.lat == null || ac.lon == null || ac.altitudeFt == null) continue;
      const dist = distanceNM(lat, lon, ac.lat, ac.lon);
      if (dist > radiusNM) continue;
      if (ac.altitudeFt < altFloor || ac.altitudeFt > altCeil) continue;
      ac.distNM = dist;
      inZoneNow.push(ac);
    }

    for (const ac of inZoneNow) {
      if (!this.enteredAt.has(ac.hex)) this.enteredAt.set(ac.hex, now);
      this.lastSeenAt.set(ac.hex, now);
      this.snapshot.set(ac.hex, ac);
    }
    for (const [hex, lastSeen] of [...this.lastSeenAt]) {
      if (now - lastSeen > GRACE_MS) {
        this.lastSeenAt.delete(hex);
        this.enteredAt.delete(hex);
        this.snapshot.delete(hex);
      }
    }

    const present = [...this.enteredAt.keys()];
    if (present.length === 0) {
      this.currentHex = null;
      this.broadcast(this.buildEmptyPayload());
      return;
    }

    present.sort((a, b) => this.enteredAt.get(b) - this.enteredAt.get(a));
    const latestHex = present[0];
    let entering = false;
    if (latestHex !== this.currentHex) {
      this.currentHex = latestHex;
      this.currentSwitchedAt = now;
      entering = true;
    }

    const extra = present.length - 1;
    const stale = now - (this.lastSeenAt.get(this.currentHex) || now) > POLL_MS * 1.5;
    let statusLabel = 'IN ZONE';
    if (entering) statusLabel = 'ENTERING';
    else if (stale) statusLabel = 'EXITING';
    else if (extra > 0) statusLabel = `+${extra} · LATEST`;

    const ac = this.snapshot.get(this.currentHex);
    const payload = await this.buildAircraftPayload(ac, { entering, extra, statusLabel });
    this.broadcast(payload);
  }

  buildEmptyPayload() {
    return {
      type: 'update',
      ok: true,
      hasPlane: false,
      isAirline: false,
      isGeneric: false,
      extra: 0,
      entering: false,
      statusLabel: 'STANDING BY',
      airlineName: '',
      route: '',
      acType: '',
      flightNo: '',
      tail: '',
      destFlag: null,
      destCode: null,
      destName: '',
      emblemColor: GENERIC_COLOR,
      logoUrl: null,
      source: this.activeSource,
      sourceFallback: this.sourceFallback,
      altitudeFt: null,
      groundSpeedKt: null,
      trackDeg: null,
      vertRateFtMin: null,
      distanceToGoNM: null,
      etaMinutes: null,
      zone: this.config,
    };
  }

  // Resolve a trustworthy route for this aircraft. Route sources are tried in
  // order — vrs-standing-data → adsbdb → airframes.io → user CSV — and each
  // candidate must be consistent with the live position (except the CSV, which
  // is trusted as your own data). Returns { route, airline }:
  //   route   -> a position-consistent route, or null (suppressed/unknown)
  //   airline -> operator identity, kept even when the route itself is suppressed
  //              (airline is reliably derived from the callsign, so it stays
  //              trustworthy even if the origin/destination pairing is not).
  async resolveRoute(ac) {
    const callsign = ac.flight;
    const airlineOf = (r) =>
      r && (r.airlineCallsign || r.airlineName || r.airlineIcao)
        ? { callsign: r.airlineCallsign || null, name: r.airlineName || null, icao: r.airlineIcao || null }
        : null;

    // 0) Optional CSV override: a user-supplied entry wins outright.
    if (csvOverride()) {
      const csv = lookupRouteCsv(callsign);
      if (csv) {
        console.log(`[zone ${this.key}] using user CSV route for ${callsign} (override)`);
        return { route: csv, airline: airlineOf(csv) };
      }
    }

    // Primary route = vrs-standing-data; adsbdb is the second route candidate and
    // also our best source for the friendly airline name/callsign (vrs only has
    // the ICAO airline code). Fetch both in parallel.
    const [vrs, adsbdbRoute] = await Promise.all([
      lookupRouteVrs(callsign),
      lookupRoute(callsign),
    ]);

    // Airline identity: prefer adsbdb (name + radio callsign), else vrs (ICAO),
    // else the 3-letter callsign prefix. Kept even if the route is suppressed.
    const callsignPrefix = /^[A-Za-z]{3}/.test(callsign || '') ? callsign.slice(0, 3).toUpperCase() : null;
    const airline =
      airlineOf(adsbdbRoute) ||
      airlineOf(vrs) ||
      (callsignPrefix ? { callsign: null, name: null, icao: callsignPrefix } : null);

    // Try route candidates in priority order; use the first position-consistent one.
    for (const cand of [{ name: 'vrs-standing-data', route: vrs }, { name: 'adsbdb', route: adsbdbRoute }]) {
      if (!cand.route) continue;
      const e = evaluateRoute(cand.route, ac);
      if (!e.validated || e.plausible) {
        if (cand.name !== 'vrs-standing-data') console.log(`[zone ${this.key}] route for ${callsign} via ${cand.name}`);
        return { route: cand.route, airline: airline || airlineOf(cand.route) };
      }
      const o = cand.route.origin, d = cand.route.destination;
      console.warn(
        `[zone ${this.key}] ${cand.name} route ${(o && (o.iata || o.icao)) || '?'}->` +
        `${(d && (d.iata || d.icao)) || '?'} for ${callsign} is inconsistent with live position`
      );
    }

    // Consult the airframes.io backup.
    let backup = null;
    try {
      const bk = await lookupRouteAirframes(callsign);
      if (bk.available && bk.route) {
        const be = evaluateRoute(bk.route, ac);
        if (!be.validated || be.plausible) backup = bk.route;
        else console.warn(`[zone ${this.key}] airframes backup route for ${callsign} also inconsistent; suppressing`);
      }
    } catch (err) {
      if (err.quota) console.warn(`[zone ${this.key}] airframes backup unavailable (quota/auth) for ${callsign}; suppressing route`);
      else console.warn(`[zone ${this.key}] airframes backup failed for ${callsign}: ${err.message}`);
    }

    if (backup) {
      console.warn(`[zone ${this.key}] using airframes.io backup route for ${callsign}`);
      return { route: backup, airline: airline || airlineOf(backup) };
    }

    // Last-resort paid API: FlightAware AeroAPI (only if a key is configured).
    let aero = null;
    try {
      const ar = await lookupRouteAeroApi(callsign);
      if (ar.available && ar.route) {
        const ae = evaluateRoute(ar.route, ac);
        if (!ae.validated || ae.plausible) aero = ar.route;
        else console.warn(`[zone ${this.key}] AeroAPI route for ${callsign} also inconsistent; suppressing`);
      }
    } catch (err) {
      if (err.quota) console.warn(`[zone ${this.key}] AeroAPI unavailable (quota/auth) for ${callsign}`);
      else console.warn(`[zone ${this.key}] AeroAPI lookup failed for ${callsign}: ${err.message}`);
    }
    if (aero) {
      console.log(`[zone ${this.key}] using FlightAware AeroAPI route for ${callsign}`);
      return { route: aero, airline: airline || airlineOf(aero) };
    }

    // Final fallback: user-supplied CSV (trusted as-is — it's your data).
    const csv = lookupRouteCsv(callsign);
    if (csv) {
      console.log(`[zone ${this.key}] using user CSV route for ${callsign}`);
      return { route: csv, airline: airlineOf(csv) || airline };
    }

    // No trustworthy route. Suppress route fields; keep airline if we had it.
    return { route: null, airline };
  }

  async buildAircraftPayload(ac, { entering, extra, statusLabel }) {
    const [routeResult, aircraftInfo] = await Promise.all([
      this.resolveRoute(ac),
      lookupAircraft(ac.registration || ac.hex),
    ]);
    const { route, airline } = routeResult;

    const isAirline = !!airline;
    const isGeneric = !isAirline;
    const dest = route && route.destination;

    // ICAO airline code for logo matching: from route data if present, else the
    // 3-letter prefix of the flight callsign (e.g. SWA3644 -> SWA), which is the
    // code users name their logo files after and is reliable even when the route
    // is suppressed.
    const callsignPrefix = /^[A-Za-z]{3}/.test(ac.flight || '') ? ac.flight.slice(0, 3).toUpperCase() : null;
    const airlineIcao = (airline && airline.icao) || callsignPrefix;

    // DTG + ETA only for a trusted route. ETA is remaining flight time estimated
    // against a representative cruise speed (see estimate.js) — instantaneous
    // ground speed in a small low zone is a climb/descent speed and would make
    // ETA far too long.
    let distanceToGoNM = null;
    let etaMinutes = null;
    if (dest && dest.lat != null && dest.lon != null) {
      distanceToGoNM = distanceNM(ac.lat, ac.lon, dest.lat, dest.lon);
      etaMinutes = estimateEtaMinutes(distanceToGoNM, ac.groundSpeedKt, ac.typeCode, ac.category);
    }

    const originCode = route && route.origin && (route.origin.iata || route.origin.icao);
    const destCode = route && route.destination && (route.destination.iata || route.destination.icao);
    const routeStr = originCode && destCode ? `${originCode}–${destCode}` : '';

    const airlineKey = isAirline ? (airline.callsign || airline.name) : null;

    return {
      type: 'update',
      ok: true,
      hasPlane: true,
      isAirline,
      isGeneric,
      extra,
      entering,
      statusLabel,
      airlineName: isAirline ? (airline.callsign || airline.name) : 'UNSCHEDULED',
      route: routeStr,
      // Full model name (e.g. B38M -> "Boeing 737 MAX 8"); falls back to the code.
      acType: aircraftTypeName(ac.typeCode || (aircraftInfo && aircraftInfo.icaoType), aircraftInfo && aircraftInfo.typeName) || '—',
      acTypeCode: (ac.typeCode || (aircraftInfo && aircraftInfo.icaoType) || '').toUpperCase() || null,
      flightNo: (route && route.callsignIata) || ac.flight || ac.hex,
      tail: ac.registration || ac.hex.toUpperCase(),
      destFlag: dest ? flagEmoji(dest.countryIso) : null,
      destCode: dest ? (dest.countryIso ? dest.countryIso.toUpperCase() : null) : null,
      destName: dest ? dest.municipality || destCode || '' : '',
      emblemColor: isAirline ? colorForAirline(airlineKey) : GENERIC_COLOR,
      logoUrl: isAirline ? logoForAirline(airlineIcao, airline.callsign, airline.name) : null,
      source: this.activeSource,
      sourceFallback: this.sourceFallback,
      altitudeFt: ac.altitudeFt,
      groundSpeedKt: ac.groundSpeedKt,
      trackDeg: ac.trackDeg,
      vertRateFtMin: ac.vertRateFtMin,
      distanceToGoNM,
      etaMinutes,
      zone: this.config,
    };
  }
}

class ZoneManager {
  constructor() {
    this.watchers = new Map(); // key -> ZoneWatcher
    this.clientZone = new Map(); // ws -> key
  }

  setZone(ws, rawConfig) {
    const config = sanitizeZoneConfig(rawConfig);
    if (!config) return { error: 'Invalid zone configuration' };

    const key = zoneKey(config);
    const prevKey = this.clientZone.get(ws);
    if (prevKey === key) return { ok: true, config };
    if (prevKey) this.unsubscribe(ws);

    let watcher = this.watchers.get(key);
    if (!watcher) {
      watcher = new ZoneWatcher(key, config);
      this.watchers.set(key, watcher);
      watcher.start();
    }
    watcher.addSubscriber(ws);
    this.clientZone.set(ws, key);
    return { ok: true, config };
  }

  unsubscribe(ws) {
    const key = this.clientZone.get(ws);
    if (!key) return;
    this.clientZone.delete(ws);
    const watcher = this.watchers.get(key);
    if (!watcher) return;
    watcher.removeSubscriber(ws);
    if (watcher.subscribers.size === 0) {
      watcher.teardownTimer = setTimeout(() => {
        if (watcher.subscribers.size === 0) {
          watcher.stop();
          this.watchers.delete(key);
        }
      }, TEARDOWN_MS);
    }
  }
}

module.exports = { ZoneManager, sanitizeZoneConfig };
