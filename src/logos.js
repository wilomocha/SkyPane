'use strict';

const fs = require('fs');
const path = require('path');

// Airline logos are trademarked, so none are bundled. Instead, users drop their
// own image files into public/logos/ named by the airline's ICAO callsign code
// (preferred) or name, e.g.:
//     public/logos/UAL.png     (United, ICAO "UAL")
//     public/logos/DAL.svg     (Delta,  ICAO "DAL")
//     public/logos/united.png  (by name, lowercased)
// Supported extensions, in priority order:
const EXTS = ['svg', 'png', 'webp', 'jpg', 'jpeg', 'gif'];

// Optional remote fallback: set AIRLINE_LOGO_URL_TEMPLATE to a URL containing
// "{icao}" and/or "{name}" placeholders (e.g. a logo CDN you have rights to use).
// Left empty by default so nothing external is loaded without opt-in.
const REMOTE_TEMPLATE = process.env.AIRLINE_LOGO_URL_TEMPLATE || '';

const LOGO_DIR = path.join(__dirname, '..', 'public', 'logos');
let index = new Map(); // lowercased basename (no ext) -> "/logos/<file>"
let lastSignature = null; // to log only when the set of logos actually changes
let watchTimer = null;

// Build an index of available local logo files. Called at startup and can be
// re-run to pick up newly added files without a restart.
function scanLogos() {
  index = new Map();
  let files = [];
  try {
    files = fs.readdirSync(LOGO_DIR);
  } catch {
    return 0; // directory may not exist yet — that's fine
  }
  // Insert in reverse extension priority so higher-priority exts overwrite.
  const byPriority = files
    .filter((f) => EXTS.includes(path.extname(f).slice(1).toLowerCase()))
    .sort((a, b) => {
      const pa = EXTS.indexOf(path.extname(a).slice(1).toLowerCase());
      const pb = EXTS.indexOf(path.extname(b).slice(1).toLowerCase());
      return pb - pa;
    });
  for (const file of byPriority) {
    const base = slug(path.basename(file, path.extname(file)));
    index.set(base, `/logos/${file}`);
  }
  // Only log when the set of indexed logos actually changed (so the periodic
  // re-scan doesn't spam the log).
  const signature = [...index.keys()].sort().join(',');
  if (signature !== lastSignature) {
    lastSignature = signature;
    console.log(`[logos] indexed ${index.size} airline logo file(s) from public/logos/`);
  }
  return index.size;
}

// Periodically re-scan the logos directory so files dropped in at runtime (e.g.
// into a Docker bind-mount) are picked up without restarting. Set
// LOGO_RESCAN_MS=0 to disable. Cheap: it just reads a small directory listing.
function startLogoWatch() {
  const intervalMs = Number(process.env.LOGO_RESCAN_MS ?? 30000);
  if (watchTimer || !intervalMs || intervalMs < 0) return;
  watchTimer = setInterval(scanLogos, intervalMs);
  if (watchTimer.unref) watchTimer.unref(); // don't keep the process alive for this
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Resolve a logo URL for an airline, or null. Tries a local file matched by the
// ICAO airline code (e.g. "SWA"), then the radio callsign (e.g. "SOUTHWEST"),
// then the airline name; otherwise a remote template URL if configured.
function logoForAirline(icao, callsign, name) {
  const keys = [];
  if (icao) keys.push(slug(icao));
  if (callsign) keys.push(slug(callsign));
  if (name) keys.push(slug(name));

  for (const k of keys) {
    if (k && index.has(k)) return index.get(k);
  }

  if (REMOTE_TEMPLATE && (icao || name)) {
    return REMOTE_TEMPLATE
      .replace(/\{icao\}/gi, encodeURIComponent(icao || ''))
      .replace(/\{name\}/gi, encodeURIComponent(name || ''));
  }
  return null;
}

module.exports = { scanLogos, startLogoWatch, logoForAirline };
