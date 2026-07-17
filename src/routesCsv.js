'use strict';

const fs = require('fs');
const path = require('path');

// User-supplied route data, used as the FINAL fallback after adsbdb (primary)
// and airframes.io (backup) — or, with ROUTE_CSV_OVERRIDE=true, as an override
// that wins whenever an entry exists for the flight. Handy when the APIs carry
// stale/wrong routes and you want to correct specific flights yourself.
//
// File: data/routes.csv (override with ROUTES_CSV_PATH). See data/README.md.
const CSV_PATH = process.env.ROUTES_CSV_PATH || path.join(__dirname, '..', 'data', 'routes.csv');

// Accepted column names (case-insensitive), each mapped to a canonical field.
const COLUMNS = {
  callsign: ['callsign', 'flight', 'ident', 'flight_icao'],
  flightIata: ['flight_iata', 'callsign_iata', 'iata', 'flight_number', 'flightno'],
  airline: ['airline', 'airline_name', 'airline_callsign', 'operator'],
  airlineIcao: ['airline_icao', 'operator_icao', 'opicao'],
  originCode: ['origin', 'origin_iata', 'origin_code', 'from', 'dep', 'departure'],
  originIcao: ['origin_icao', 'dep_icao'],
  originCity: ['origin_city', 'origin_municipality', 'from_city'],
  originCountry: ['origin_country', 'origin_country_iso', 'from_country'],
  originLat: ['origin_lat', 'origin_latitude', 'dep_lat'],
  originLon: ['origin_lon', 'origin_lng', 'origin_longitude', 'dep_lon'],
  destCode: ['dest', 'destination', 'dest_iata', 'dest_code', 'to', 'arr', 'arrival'],
  destIcao: ['dest_icao', 'arr_icao'],
  destCity: ['dest_city', 'dest_municipality', 'to_city'],
  destCountry: ['dest_country', 'dest_country_iso', 'to_country'],
  destLat: ['dest_lat', 'dest_latitude', 'arr_lat'],
  destLon: ['dest_lon', 'dest_lng', 'dest_longitude', 'arr_lon'],
};

let index = new Map(); // normalized callsign -> route object

// Minimal RFC-4180-ish CSV parser (handles quoted fields, escaped quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normCallsign(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, '');
}

// Build an airport object from a code (+ optional explicit ICAO/city/country/coords).
function buildAirport(code, icao, city, country, lat, lon) {
  const c = (code || '').trim().toUpperCase();
  let iataV = null;
  let icaoV = (icao || '').trim().toUpperCase() || null;
  if (c) {
    if (c.length === 4 && !icaoV) icaoV = c; // 4 letters looks like ICAO
    else if (c.length !== 4) iataV = c; // otherwise treat as IATA-ish code
  }
  if (!iataV && !icaoV && lat == null && lon == null && !city) return null;
  return {
    iata: iataV,
    icao: icaoV,
    municipality: (city || '').trim() || null,
    countryIso: (country || '').trim().toUpperCase() || null,
    lat: num(lat),
    lon: num(lon),
  };
}

// Load/reload the CSV into the in-memory index. Returns the number of routes.
function loadRoutesCsv() {
  index = new Map();
  let text;
  try {
    text = fs.readFileSync(CSV_PATH, 'utf8');
  } catch {
    return 0; // no CSV present — that's fine, the feature is optional
  }

  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return 0;

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const colIdx = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    colIdx[field] = aliases.map((a) => header.indexOf(a)).find((i) => i >= 0);
    if (colIdx[field] === undefined) colIdx[field] = -1;
  }
  if (colIdx.callsign < 0) {
    console.warn(`[routes-csv] ${CSV_PATH} has no "callsign" column; ignoring it`);
    return 0;
  }

  let count = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (field) => (colIdx[field] >= 0 ? (row[colIdx[field]] || '').trim() : '');
    const cs = normCallsign(get('callsign'));
    if (!cs) continue;

    const airline = get('airline') || null;
    const route = {
      callsignIata: get('flightIata') || null,
      airlineName: airline,
      airlineCallsign: airline, // shown as the board's big title
      airlineIcao: get('airlineIcao').toUpperCase() || null,
      origin: buildAirport(get('originCode'), get('originIcao'), get('originCity'), get('originCountry'), get('originLat'), get('originLon')),
      destination: buildAirport(get('destCode'), get('destIcao'), get('destCity'), get('destCountry'), get('destLat'), get('destLon')),
      _source: 'csv',
    };
    index.set(cs, route);
    count++;
  }
  console.log(`[routes-csv] loaded ${count} user route(s) from ${CSV_PATH}`);
  return count;
}

function lookupRouteCsv(callsign) {
  if (!callsign) return null;
  return index.get(normCallsign(callsign)) || null;
}

// Whether CSV entries should override the APIs (vs. being a last-resort fallback).
function csvOverride() {
  return String(process.env.ROUTE_CSV_OVERRIDE || '').toLowerCase() === 'true';
}

module.exports = { loadRoutesCsv, lookupRouteCsv, csvOverride };
