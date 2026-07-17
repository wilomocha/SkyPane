'use strict';

require('./src/logger'); // patch console to timestamp every log (must be first)

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { ZoneManager } = require('./src/zoneManager');
const { scanLogos, startLogoWatch } = require('./src/logos');
const { loadRoutesCsv, startRoutesCsvWatch } = require('./src/routesCsv');

const PORT = Number(process.env.PORT) || 3000;

// Index user-provided airline logos + route corrections, then keep watching them
// so files added/edited at runtime (e.g. Docker bind-mounts) apply without a restart.
scanLogos();
startLogoWatch();
loadRoutesCsv();
startRoutesCsvWatch();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const zoneManager = new ZoneManager();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'setZone') {
      const result = zoneManager.setZone(ws, msg.zone || {});
      if (result.error) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
      }
    }
  });

  ws.on('close', () => {
    zoneManager.unsubscribe(ws);
  });
});

// Drop dead connections (e.g. kiosk display that lost network without a clean close).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`SkyPane listening on http://localhost:${PORT}`);
});
