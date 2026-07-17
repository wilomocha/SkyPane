(() => {
  'use strict';

  const DEFAULT_ZONE = { lat: 37.818858, lon: -122.478997, radiusNM: 2.0, altFloor: 1, altCeil: 450000 };
  const DEFAULT_SETTINGS = { accent: '#46d9ff', units: 'imperial', effects: false };
  const ACCENTS = ['#46d9ff', '#35ff9e', '#ffb32e', '#eef3ee'];
  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  const $ = (id) => document.getElementById(id);

  const el = {
    liveDot: $('live-dot'),
    zoneLine: $('zone-line'),
    sourceBadge: $('source-badge'),
    clockLine: $('clock-line'),
    tzLine: $('tz-line'),
    planePanel: $('plane-panel'),
    standbyPanel: $('standby-panel'),
    standbyTitle: $('standby-title'),
    topBlock: $('top-block'),
    emblemLogo: $('emblem-logo'),
    emblemGeneric: $('emblem-generic'),
    emblemAirline: $('emblem-airline'),
    airlineName: $('airline-name'),
    route: $('route'),
    acType: $('ac-type'),
    flightNo: $('flight-no'),
    tail: $('tail'),
    statusLabel: $('status-label'),
    destFlag: $('dest-flag'),
    destName: $('dest-name'),
    mAlt: $('m-alt'), mSpd: $('m-spd'), mTrk: $('m-trk'),
    mVr: $('m-vr'), mDtg: $('m-dtg'), mEta: $('m-eta'),
    changeZoneBtn: $('change-zone-btn'),
    fullscreenBtn: $('fullscreen-btn'),
    stage: $('stage'),
    bezel: $('bezel'),
    pickerOverlay: $('picker-overlay'),
    mapEl: $('map'),
    mapFallback: $('map-fallback'),
    radiusSlider: $('radius-slider'),
    radiusLabel: $('radius-label'),
    areaLabel: $('area-label'),
    altFloorInput: $('alt-floor-input'),
    altCeilInput: $('alt-ceil-input'),
    latInput: $('lat-input'),
    lonInput: $('lon-input'),
    unitsInput: $('units-input'),
    effectsInput: $('effects-input'),
    accentSwatches: $('accent-swatches'),
    applyBtn: $('apply-btn'),
  };

  // ---------- persistence ----------

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { ...fallback };
      const parsed = JSON.parse(raw);
      return { ...fallback, ...parsed };
    } catch {
      return { ...fallback };
    }
  }

  const state = {
    zone: loadJson('skypane.zone', DEFAULT_ZONE),
    settings: loadJson('skypane.settings', DEFAULT_SETTINGS),
    draftZone: null,
    draftSettings: null,
    dragging: false,
  };

  function saveZone() { localStorage.setItem('skypane.zone', JSON.stringify(state.zone)); }
  function saveSettings() { localStorage.setItem('skypane.settings', JSON.stringify(state.settings)); }

  // ---------- helpers ----------

  function hexToRgba(hex, a) {
    const h = (hex || '#46d9ff').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const v = parseInt(full, 16) || 0;
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  function applySettingsToDom() {
    const root = document.documentElement;
    root.style.setProperty('--accent', state.settings.accent);
    root.style.setProperty('--accent-glow', hexToRgba(state.settings.accent, .5));
    root.style.setProperty('--accent-dim', hexToRgba(state.settings.accent, .38));
    document.body.classList.toggle('fx-off', !state.settings.effects);
  }

  function fmtAlt(altFt) {
    if (altFt == null) return '—';
    if (state.settings.units === 'metric') return (altFt * 0.0003048).toFixed(1) + 'km';
    return (altFt / 1000).toFixed(1) + 'kft';
  }
  function fmtSpd(gsKt) {
    if (gsKt == null) return '—';
    if (state.settings.units === 'metric') return Math.round(gsKt * 1.852) + 'kmh';
    return Math.round(gsKt * 1.15078) + 'mph';
  }
  function fmtVr(vrFtMin) {
    if (vrFtMin == null) return '—';
    const fts = vrFtMin / 60;
    const metric = state.settings.units === 'metric';
    const val = metric ? fts * 0.3048 : fts;
    const unit = metric ? 'm/s' : 'ft/s';
    const r = Math.round(val);
    const sign = r > 0 ? '+' : (r < 0 ? '−' : '');
    return sign + Math.abs(r) + unit;
  }
  function fmtTrk(trkDeg) {
    if (trkDeg == null) return '—';
    return String(Math.round(trkDeg)).padStart(3, '0') + 'deg';
  }
  function fmtDtg(nm) {
    if (nm == null) return '—';
    if (state.settings.units === 'metric') return Math.round(nm * 1.852) + 'km';
    return Math.round(nm) + 'nm';
  }
  function fmtEta(min) {
    if (min == null) return '—';
    const m = Math.max(0, Math.round(min));
    if (m >= 60) return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
    return m + 'm';
  }

  function zoneLineText(zone) {
    return 'WATCH ZONE  ·  ' + zone.radiusNM.toFixed(1) + 'NM  ·  ' +
      Math.round(zone.altFloor) + '–' + Math.round(zone.altCeil).toLocaleString() + 'ft  ·  ' +
      zone.lat.toFixed(4) + ', ' + zone.lon.toFixed(4);
  }

  // ---------- clock ----------

  function updateClock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    el.clockLine.textContent = `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}  ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const offMin = -d.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '−';
    const oh = p(Math.floor(Math.abs(offMin) / 60));
    const om = p(Math.abs(offMin) % 60);
    let abbr = '';
    try {
      abbr = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d)
        .find((x) => x.type === 'timeZoneName').value;
    } catch { /* Intl not fully supported; fall back to GMT offset only */ }
    el.tzLine.textContent = (abbr ? abbr + ' · ' : '') + 'GMT' + sign + oh + ':' + om;
  }
  updateClock();
  setInterval(updateClock, 1000);

  // ---------- render aircraft data ----------

  function statusColorFor(label) {
    if (label === 'ENTERING') return '#ffd24d';
    if (label === 'EXITING') return '#ff7a6b';
    if (label.startsWith('+')) return '#ffd24d';
    return state.settings.accent;
  }

  // Fit a value into `outer` by shrinking the font from maxPx toward minPx; if it
  // still overflows at minPx, enable a horizontal scroll (marquee) instead of
  // truncating. `outer` contains a `.fit-inner` span holding the text.
  function setFitText(outer, text, maxPx, minPx) {
    const inner = outer.firstElementChild;
    if (!inner) { outer.textContent = text; return; }
    // Skip re-measuring if the value hasn't changed (avoids restarting scroll).
    if (outer.__fitText === text && outer.clientWidth === outer.__fitWidth) return;
    outer.__fitText = text;
    inner.textContent = text;

    outer.classList.remove('scrolling');
    inner.style.removeProperty('transform');
    let size = maxPx;
    outer.style.fontSize = size + 'px';
    // Shrink until it fits or we hit the minimum.
    while (size > minPx && inner.scrollWidth > outer.clientWidth) {
      size -= 2;
      outer.style.fontSize = size + 'px';
    }
    outer.__fitWidth = outer.clientWidth;
    // Still too long at the minimum size → scroll it.
    const overflow = inner.scrollWidth - outer.clientWidth;
    if (overflow > 2) {
      outer.style.setProperty('--scroll-dist', overflow + 'px');
      outer.style.setProperty('--scroll-dur', Math.max(8, overflow / 45).toFixed(1) + 's');
      outer.classList.add('scrolling');
    }
  }

  function render(data) {
    el.zoneLine.textContent = zoneLineText(data.zone || state.zone);

    // Show which ADS-B feed is active only when it's a fallback (adsb.lol down).
    if (data.sourceFallback && data.source) {
      el.sourceBadge.textContent = 'SRC ' + data.source.toUpperCase();
      el.sourceBadge.hidden = false;
    } else {
      el.sourceBadge.hidden = true;
    }

    if (!data.hasPlane) {
      el.liveDot.style.background = '#ff7a6b';
      el.liveDot.style.boxShadow = '0 0 12px #ff7a6b';
      el.standbyTitle.textContent = data.ok === false ? (data.statusLabel || 'SIGNAL ERROR') : 'NO AIRCRAFT IN ZONE';
      el.planePanel.hidden = true;
      el.standbyPanel.hidden = false;
      return;
    }

    const dotColor = data.ok === false ? '#ffb32e' : state.settings.accent;
    el.liveDot.style.background = dotColor;
    el.liveDot.style.boxShadow = `0 0 12px ${dotColor}`;
    el.planePanel.hidden = false;
    el.standbyPanel.hidden = true;

    if (data.entering) {
      el.topBlock.classList.remove('om-enter');
      void el.topBlock.offsetWidth; // restart animation
      el.topBlock.classList.add('om-enter');
    }

    // Emblem: prefer a real logo image when one is available, else the drawn
    // globe (airline) or the generic plane silhouette. If the logo fails to
    // load, fall back to the globe (see the img onerror handler in boot).
    const useLogo = data.isAirline && !!data.logoUrl;
    if (useLogo && el.emblemLogo.getAttribute('src') !== data.logoUrl) {
      el.emblemLogo.src = data.logoUrl;
    }
    el.emblemLogo.hidden = !useLogo;
    el.emblemGeneric.hidden = data.isAirline;
    el.emblemAirline.hidden = !data.isAirline || useLogo;
    if (data.isAirline && !useLogo) {
      el.emblemAirline.style.setProperty('--emblem-color', data.emblemColor);
      el.emblemAirline.style.setProperty('--emblem-glow', hexToRgba(data.emblemColor, .6));
    }

    setFitText(el.airlineName, data.airlineName || 'UNSCHEDULED', 96, 46);
    el.route.textContent = data.route || '—';
    setFitText(el.acType, data.acType || '—', 54, 26);
    el.flightNo.textContent = data.flightNo || '—';
    el.tail.textContent = data.tail || '—';
    el.statusLabel.textContent = data.statusLabel;
    el.statusLabel.style.color = statusColorFor(data.statusLabel);

    if (data.destFlag) {
      el.destFlag.textContent = data.destFlag;
      el.destFlag.classList.remove('text-fallback');
    } else if (data.destCode) {
      el.destFlag.textContent = data.destCode;
      el.destFlag.classList.add('text-fallback');
    } else {
      el.destFlag.textContent = '';
      el.destFlag.classList.remove('text-fallback');
    }
    setFitText(el.destName, data.destName || '—', 54, 28);

    el.mAlt.textContent = fmtAlt(data.altitudeFt);
    el.mSpd.textContent = fmtSpd(data.groundSpeedKt);
    el.mTrk.textContent = fmtTrk(data.trackDeg);
    el.mVr.textContent = fmtVr(data.vertRateFtMin);
    el.mDtg.textContent = fmtDtg(data.distanceToGoNM);
    el.mEta.textContent = fmtEta(data.etaMinutes);
  }

  // ---------- websocket ----------

  let ws = null;
  let reconnectDelay = 1000;

  function sendZone() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'setZone', zone: state.zone }));
    }
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      sendZone();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'update') render(msg);
    });
    ws.addEventListener('close', () => {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  // ---------- scale-to-fit ----------

  // The board is a fixed 1516x846 (~16:9). Scale it uniformly to the largest
  // size that still fits the viewport, so it fills horizontal screens edge-to-
  // edge (near-full on 16:9, letterboxed only on unusual ratios) without ever
  // cropping content.
  function fitStage() {
    const natW = 1516;
    const natH = 846;
    const scale = Math.max(0.1, Math.min(
      window.innerWidth / natW,
      window.innerHeight / natH,
      6
    ));
    el.bezel.style.transform = `scale(${scale})`;
  }
  window.addEventListener('resize', fitStage);
  window.addEventListener('orientationchange', fitStage);
  fitStage();

  // ---------- wake lock ----------

  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.warn('wake lock request failed:', err.message);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });
  requestWakeLock();

  // ---------- fullscreen ----------

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  }
  el.fullscreenBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });

  // ---------- auto-hide controls ----------

  let controlsTimer = null;
  function showControls() {
    document.body.classList.remove('controls-hidden');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => {
      // Never hide while the zone picker is open.
      if (el.pickerOverlay.hidden) document.body.classList.add('controls-hidden');
    }, 5000);
  }
  window.addEventListener('pointermove', showControls);
  window.addEventListener('pointerdown', showControls);
  showControls();

  // ---------- picker modal (map-based) ----------

  const NM_TO_M = 1852;
  let map = null; // Leaflet map (lazily created)
  let centerMarker = null;
  let radiusCircle = null;

  function updateRadiusLabel() {
    const nm = state.draftZone.radiusNM;
    el.radiusLabel.textContent = nm.toFixed(1) + ' NM';
    const areaMi2 = Math.PI * Math.pow(nm * 1.15078, 2);
    el.areaLabel.textContent = '≈ ' + areaMi2.toFixed(1) + ' sq mi';
  }

  // Pick a zoom level that frames the radius circle reasonably.
  function zoomForRadius(nm) {
    if (nm <= 1) return 12;
    if (nm <= 3) return 11;
    if (nm <= 6) return 10;
    if (nm <= 12) return 9;
    return 8;
  }

  function setDraftCenter(lat, lon, recenterMap) {
    state.draftZone.lat = Math.max(-90, Math.min(90, lat));
    state.draftZone.lon = Math.max(-180, Math.min(180, lon));
    el.latInput.value = state.draftZone.lat.toFixed(6);
    el.lonInput.value = state.draftZone.lon.toFixed(6);
    const ll = [state.draftZone.lat, state.draftZone.lon];
    if (centerMarker) centerMarker.setLatLng(ll);
    if (radiusCircle) radiusCircle.setLatLng(ll);
    if (recenterMap && map) map.panTo(ll);
  }

  function refreshCircle() {
    if (radiusCircle) radiusCircle.setRadius(state.draftZone.radiusNM * NM_TO_M);
  }

  function applyAccentToMap() {
    if (radiusCircle) {
      radiusCircle.setStyle({ color: state.draftSettings.accent, fillColor: state.draftSettings.accent });
    }
    const dot = document.querySelector('.center-dot');
    if (dot) dot.style.background = state.draftSettings.accent;
  }

  function initMap() {
    if (typeof L === 'undefined') { el.mapFallback.hidden = false; return; }
    if (map) return;
    map = L.map(el.mapEl, { zoomControl: true, attributionControl: true });
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    });
    // If tiles fail (offline/blocked), reveal the fallback hint; fields still work.
    let tileErrors = 0;
    tiles.on('tileerror', () => { if (++tileErrors === 1) el.mapFallback.hidden = false; });
    tiles.addTo(map);

    const dotIcon = L.divIcon({ className: '', html: '<div class="center-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
    centerMarker = L.marker([state.draftZone.lat, state.draftZone.lon], { icon: dotIcon, draggable: true }).addTo(map);
    radiusCircle = L.circle([state.draftZone.lat, state.draftZone.lon], {
      radius: state.draftZone.radiusNM * NM_TO_M,
      color: state.draftSettings.accent, weight: 2,
      fillColor: state.draftSettings.accent, fillOpacity: 0.12,
    }).addTo(map);

    centerMarker.on('drag', (e) => { const p = e.target.getLatLng(); setDraftCenter(p.lat, p.lng, false); });
    map.on('click', (e) => setDraftCenter(e.latlng.lat, e.latlng.lng, false));
  }

  function renderAccentSwatches() {
    el.accentSwatches.innerHTML = '';
    for (const c of ACCENTS) {
      const sw = document.createElement('div');
      sw.className = 'accent-swatch' + (c === state.draftSettings.accent ? ' selected' : '');
      sw.style.background = c;
      sw.addEventListener('click', () => {
        state.draftSettings.accent = c;
        renderAccentSwatches();
        applyAccentToMap();
      });
      el.accentSwatches.appendChild(sw);
    }
  }

  function openPicker() {
    state.draftZone = { ...state.zone };
    state.draftSettings = { ...state.settings };
    el.altFloorInput.value = state.draftZone.altFloor;
    el.altCeilInput.value = state.draftZone.altCeil;
    el.latInput.value = state.draftZone.lat;
    el.lonInput.value = state.draftZone.lon;
    el.radiusSlider.value = state.draftZone.radiusNM;
    el.unitsInput.value = state.draftSettings.units;
    el.effectsInput.checked = state.draftSettings.effects;
    renderAccentSwatches();
    updateRadiusLabel();
    el.pickerOverlay.hidden = false;

    initMap();
    if (map) {
      // Leaflet needs a size recalc after the modal becomes visible.
      setTimeout(() => {
        map.invalidateSize();
        map.setView([state.draftZone.lat, state.draftZone.lon], zoomForRadius(state.draftZone.radiusNM));
        setDraftCenter(state.draftZone.lat, state.draftZone.lon, false);
        refreshCircle();
        applyAccentToMap();
      }, 0);
    }
  }

  function closePicker() {
    el.pickerOverlay.hidden = true;
  }

  function applyPicker() {
    const altFloor = parseInt(el.altFloorInput.value, 10);
    const altCeil = parseInt(el.altCeilInput.value, 10);
    const lat = parseFloat(el.latInput.value);
    const lon = parseFloat(el.lonInput.value);
    state.zone = {
      radiusNM: state.draftZone.radiusNM,
      altFloor: Number.isFinite(altFloor) ? altFloor : state.draftZone.altFloor,
      altCeil: Number.isFinite(altCeil) ? altCeil : state.draftZone.altCeil,
      lat: Number.isFinite(lat) ? Math.max(-90, Math.min(90, lat)) : state.draftZone.lat,
      lon: Number.isFinite(lon) ? Math.max(-180, Math.min(180, lon)) : state.draftZone.lon,
    };
    state.settings = {
      accent: state.draftSettings.accent,
      units: el.unitsInput.value === 'metric' ? 'metric' : 'imperial',
      effects: el.effectsInput.checked,
    };
    saveZone();
    saveSettings();
    applySettingsToDom();
    el.zoneLine.textContent = zoneLineText(state.zone);
    sendZone();
    closePicker();
  }

  el.changeZoneBtn.addEventListener('click', openPicker);
  el.pickerOverlay.addEventListener('click', (e) => {
    if (e.target === el.pickerOverlay) closePicker();
  });
  el.applyBtn.addEventListener('click', applyPicker);

  el.radiusSlider.addEventListener('input', () => {
    state.draftZone.radiusNM = Math.round(parseFloat(el.radiusSlider.value) * 10) / 10;
    updateRadiusLabel();
    refreshCircle();
  });

  // Typing coordinates recenters the map/marker.
  function onCoordInput() {
    const lat = parseFloat(el.latInput.value);
    const lon = parseFloat(el.lonInput.value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) setDraftCenter(lat, lon, true);
  }
  el.latInput.addEventListener('change', onCoordInput);
  el.lonInput.addEventListener('change', onCoordInput);

  // If a logo image fails to load, hide it and reveal the drawn globe instead.
  el.emblemLogo.addEventListener('error', () => {
    el.emblemLogo.removeAttribute('src');
    el.emblemLogo.hidden = true;
    el.emblemAirline.hidden = false;
  });

  // ---------- boot ----------

  applySettingsToDom();
  el.zoneLine.textContent = zoneLineText(state.zone);
  connect();
})();
