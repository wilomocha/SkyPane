'use strict';

const NM_PER_KM = 0.539957;
const KM_PER_NM = 1.852;

// Great-circle distance in nautical miles.
function distanceNM(lat1, lon1, lat2, lon2) {
  const R_KM = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R_KM * c * NM_PER_KM;
}

// ISO 3166-1 alpha-2 country code -> flag emoji (regional indicator symbols).
function flagEmoji(iso2) {
  if (!iso2 || typeof iso2 !== 'string' || iso2.length !== 2) return null;
  const code = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  const points = [...code].map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...points);
}

module.exports = { distanceNM, flagEmoji, NM_PER_KM, KM_PER_NM };
