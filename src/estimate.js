'use strict';

const { distanceNM } = require('./geo');

// Representative cruise ground speed (knots) by ADS-B emitter category. Aircraft
// inside a small, low watch zone are almost always climbing or descending, so
// their instantaneous ground speed badly under-represents true enroute speed and
// makes a naive "distance / current speed" ETA wildly too long. We estimate ETA
// against a representative cruise speed instead.
const CRUISE_BY_CATEGORY = {
  A1: 140, // light (<15,500 lb)
  A2: 290, // small (15,500–75,000 lb)
  A3: 450, // large (75,000–300,000 lb)
  A4: 460, // high-vortex large (e.g. B757)
  A5: 480, // heavy (>300,000 lb)
  A6: 480, // high performance
  A7: 120, // rotorcraft
  B1: 60,  // glider/sailplane
  B2: 40,  // lighter-than-air
  B4: 120, // ultralight/paraglider
};
const DEFAULT_JET_CRUISE_KT = 440;

// crude type-code fallbacks when the emitter category is missing
const LIGHT_GA_RE = /^(C1[0-8]|C2[0-9]|PA|P28|P32|BE(?!20)|SR2|DA[24]|M20|C72|C82)/;
const TURBOPROP_RE = /^(AT[47]|DH8|DHC|SF3|SW4|E1[12]0|BE20|C208|PC12|TBM)/;

function estimateCruiseKt(typeCode, category) {
  if (category && CRUISE_BY_CATEGORY[category] != null) return CRUISE_BY_CATEGORY[category];
  const t = (typeCode || '').toUpperCase();
  if (LIGHT_GA_RE.test(t)) return 160;
  if (TURBOPROP_RE.test(t)) return 280;
  return DEFAULT_JET_CRUISE_KT;
}

// Remaining flight time (minutes) to the destination, using cruise-speed
// estimation. All arithmetic is on absolute UTC instants (Date.now() is epoch
// = GMT) so it is timezone/DST-safe. Returns null if not computable.
function estimateEtaMinutes(distanceToGoNM, groundSpeedKt, typeCode, category) {
  if (distanceToGoNM == null || distanceToGoNM < 0) return null;
  const cruiseKt = estimateCruiseKt(typeCode, category);
  // Use whichever is faster: the current ground speed (already at/above cruise,
  // e.g. with a tailwind) or the type's representative cruise speed (climb/descent).
  const effectiveKt = Math.max(groundSpeedKt || 0, cruiseKt);
  if (effectiveKt <= 5) return null;
  const nowUtcMs = Date.now();
  const remainingMs = (distanceToGoNM / effectiveKt) * 3600 * 1000;
  const arrivalUtcMs = nowUtcMs + remainingMs; // projected arrival, in GMT
  return Math.max(0, (arrivalUtcMs - nowUtcMs) / 60000);
}

// Is the aircraft's live position consistent with the claimed origin→destination
// route? Community route DBs can carry a stale/wrong pairing for a reused
// callsign. Returns { validated, plausible }: validated=false means we lacked
// airport coordinates to judge (so we don't reject it).
const LOW_ALT_FT = 15000; // below this, an aircraft is climbing out of / descending into an airport
const NEAR_AIRPORT_NM = 200; // ...so it must be within this of its origin or destination

function evaluateRoute(route, ac) {
  const o = route && route.origin;
  const d = route && route.destination;
  if (!(o && o.lat != null && o.lon != null && d && d.lat != null && d.lon != null)) {
    return { validated: false, plausible: true };
  }
  const routeLen = distanceNM(o.lat, o.lon, d.lat, d.lon);
  const dOrigin = distanceNM(ac.lat, ac.lon, o.lat, o.lon);
  const dDest = distanceNM(ac.lat, ac.lon, d.lat, d.lon);

  // 1) Corridor check: is the plane within the ellipse spanning origin↔dest?
  //    Floor of 200 NM plus 60% of the leg for turns/holds/vectoring/wind.
  const onCorridor = dOrigin + dDest - routeLen <= Math.max(200, routeLen * 0.6);

  // 2) Endpoint-proximity check: a LOW aircraft in a small watch zone is taking
  //    off or landing, so it must be near one end of its route. This catches
  //    wrong long-haul routes that slip through the corridor test because the
  //    plane happens to be "roughly on the way" of a long leg (e.g. a plane at
  //    SFO tagged as SEA→IAD — 590 NM from SEA, still inside the wide ellipse).
  const isLow = ac.altitudeFt == null || ac.altitudeFt < LOW_ALT_FT;
  const nearAnEndpoint = Math.min(dOrigin, dDest) <= NEAR_AIRPORT_NM;

  const plausible = onCorridor && (!isLow || nearAnEndpoint);
  return { validated: true, plausible };
}

module.exports = { estimateCruiseKt, estimateEtaMinutes, evaluateRoute };
