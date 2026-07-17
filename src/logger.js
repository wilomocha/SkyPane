'use strict';

// Prefix every console line with an ISO-8601 UTC timestamp for troubleshooting.
// Requiring this module once (first thing in server.js) patches the global
// console, so all logs from every module are timestamped.
const methods = ['log', 'info', 'warn', 'error', 'debug'];
for (const name of methods) {
  const original = console[name].bind(console);
  console[name] = (...args) => original(`[${new Date().toISOString()}]`, ...args);
}

module.exports = {};
