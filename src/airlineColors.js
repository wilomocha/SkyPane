'use strict';

// Deterministic palette so the same airline always gets the same LED globe color.
const PALETTE = [
  '#4a90ff', // blue
  '#00c2b8', // teal
  '#b581ff', // purple
  '#ff8a3d', // orange
  '#35d97a', // green
  '#ff5d8f', // pink
  '#ffd24d', // amber
  '#5ad1ff', // sky
];

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function colorForAirline(key) {
  if (!key) return PALETTE[0];
  return PALETTE[hashString(key) % PALETTE.length];
}

const GENERIC_COLOR = '#9aa4ad';

module.exports = { colorForAirline, GENERIC_COLOR };
