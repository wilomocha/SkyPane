'use strict';

// ICAO aircraft type designator -> full model name, e.g. "B38M" -> "Boeing 737
// MAX 8". Sourced from the ICAO Doc 8643 list (see src/data/aircraftTypes.json).
const TYPES = require('./data/aircraftTypes.json');

// Resolve a friendly aircraft model name. Prefers the ICAO designator lookup,
// then a name supplied by adsbdb, then the raw code. Returns null if nothing.
function aircraftTypeName(typeCode, adsbdbTypeName) {
  const code = (typeCode || '').trim().toUpperCase();
  if (code && TYPES[code]) return TYPES[code];
  if (adsbdbTypeName && adsbdbTypeName.trim()) return adsbdbTypeName.trim();
  return code || null;
}

module.exports = { aircraftTypeName };
