(function () {
  /** 後端 API 固定連到本機（網頁若架在別處如 GitHub Pages 仍可呼叫 localhost） */
  const API = 'http://localhost:8964/api';
  const curEl = document.getElementById('cur');
  const statusEl = document.getElementById('status');
  const presetCoords = document.getElementById('presetCoords');
  const inputCoords = document.getElementById('inputCoords');
  const selectTunnel = document.getElementById('selectTunnel');
  const btnRefreshTunnel = document.getElementById('btnRefreshTunnel');
  const inputSpeed = document.getElementById('inputSpeed');
  const inputDir = document.getElementById('inputDir');
  const inputDuration = document.getElementById('inputDuration');
  const speedHint = document.getElementById('speedHint');
  const btnMove = document.getElementById('btnMove');
  const btnRecenter = document.getElementById('btnRecenter');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const LAST_TUNNEL_HOST_KEY = 'pik.lastTunnelHost';

  // 預設紐約（單欄格式與 placeholder 一致）
  let currentLat = 40.720638;
  let currentLng = -74.000816;
  let marker = null;

  const map = L.map('map', { zoomControl: true }).setView([currentLat, currentLng], 13);
  // CARTO Voyager (Raster Retina)：高解析度、柔和配色
  const voyagerUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}' + (L.Browser.retina ? '@2x.png' : '.png');
  L.tileLayer(voyagerUrl, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);
  const pathLayer = L.layerGroup().addTo(map); // 手動設點：紅色圓點
  const playbackLayer = L.layerGroup().addTo(map); // 定時移動：依 GPX 每秒標一個軌跡點（無折線）

  let playbackTimer = null;
  let selectedTunnel = null;
  const tunnelById = Object.create(null);
  const presetsById = Object.create(null);

  const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };

  /** 依瀏覽器 GPS 更新標記、欄位，並將地圖對準（不低於目前縮放、也不低於 13） */
  function applyGeolocationPosition(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    updateMarker(lat, lng);
    map.setView([lat, lng], Math.max(map.getZoom(), 13));
  }

  function showStatus(ok, msg) {
    statusEl.style.display = 'inline';
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (ok ? 'ok' : 'err');
  }

  /** 表頭「目前座標」與側欄「GPS 座標（緯度, 經度）」共用同一字串 */
  function syncCoordsUI() {
    const s = currentLat.toFixed(6) + ', ' + currentLng.toFixed(6);
    curEl.textContent = s;
    inputCoords.value = s;
  }

  function setCurrentCoords(lat, lng) {
    currentLat = lat;
    currentLng = lng;
    syncCoordsUI();
  }

  /** 解析「緯度, 經度」字串，回傳 { lat, lng } 或 null */
  function parseCoordPair(text) {
    const parts = String(text || '')
      .trim()
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (parts.length < 2) return null;
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: lat, lng: lng };
  }

  function updateMarker(lat, lng) {
    if (marker) map.removeLayer(marker);
    marker = L.marker([lat, lng]).addTo(map);
    setCurrentCoords(lat, lng);
  }

  function renderPresetOptions(items) {
    for (const k in presetsById) delete presetsById[k];
    presetCoords.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = '請選擇座標';
    presetCoords.appendChild(first);

    (items || []).forEach(function (item, idx) {
      const id = 'preset-' + String(idx);
      presetsById[id] = item;
      const op = document.createElement('option');
      op.value = id;
      op.textContent = item.name;
      presetCoords.appendChild(op);
    });
  }

  async function fetchPresetLocations() {
    try {
      const r = await fetch('./locations.json');
      const data = await r.json().catch(function () { return []; });
      if (!r.ok || !Array.isArray(data)) throw new Error('invalid locations');
      const list = data
        .map(function (x) {
          return {
            name: String(x.name || ''),
            lat: Number(x.lat),
            lng: Number(x.lng),
          };
        })
        .filter(function (x) {
          return x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng);
        });
      renderPresetOptions(list);
    } catch (e) {
      renderPresetOptions([]);
      showStatus(false, '無法載入座標清單');
    }
  }

  function isIpAddress(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
    const isIpv6 = /^[0-9a-fA-F:]+$/.test(s) && s.indexOf(':') !== -1;
    return isIpv4 || isIpv6;
  }

  function getSelectedTunnelOrNotify() {
    if (selectedTunnel && selectedTunnel.host && Number.isFinite(selectedTunnel.port)) {
      return selectedTunnel;
    }
    showStatus(false, '請先選擇 tunneld 設備');
    return null;
  }

  function getLastTunnelHost() {
    try {
      return localStorage.getItem(LAST_TUNNEL_HOST_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function saveLastTunnelHost(host) {
    if (!host) return;
    try {
      localStorage.setItem(LAST_TUNNEL_HOST_KEY, String(host));
    } catch (e) {
      // ignore storage error
    }
  }

  function renderTunnelOptions(items) {
    for (const k in tunnelById) delete tunnelById[k];
    selectTunnel.innerHTML = '';
    if (!items || items.length === 0) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '找不到設備';
      selectTunnel.appendChild(empty);
      selectedTunnel = null;
      return;
    }
    let rememberedId = '';
    const rememberedHost = getLastTunnelHost();
    items.forEach(function (item, idx) {
      const id = item.udid + '::' + String(idx);
      tunnelById[id] = item;
      const kind = isIpAddress(item.iface) ? '無線' : '有線';
      const op = document.createElement('option');
      op.value = id;
      op.textContent = kind + ' / ' + item.iface;
      selectTunnel.appendChild(op);
      if (!rememberedId && rememberedHost && item.host === rememberedHost) {
        rememberedId = id;
      }
    });
    selectTunnel.value = rememberedId || Object.keys(tunnelById)[0];
    selectedTunnel = tunnelById[selectTunnel.value] || null;
    if (selectedTunnel) saveLastTunnelHost(selectedTunnel.host);
  }

  async function fetchTunneldDevices() {
    try {
      const r = await fetch(API + '/tunneld');
      const data = await r.json().catch(function () { return null; });
      if (!r.ok || !data || typeof data !== 'object') {
        throw new Error('invalid tunneld response');
      }
      const list = [];
      Object.keys(data).forEach(function (udid) {
        const tunnels = Array.isArray(data[udid]) ? data[udid] : [];
        tunnels.forEach(function (t) {
          const host = t['tunnel-address'];
          const port = Number(t['tunnel-port']);
          const iface = String(t.interface || '');
          if (!host || !Number.isFinite(port)) return;
          list.push({ udid: udid, host: host, port: port, iface: iface });
        });
      });
      renderTunnelOptions(list);
      if (list.length > 0) {
        showStatus(true, '已載入 ' + list.length + ' 個設備');
        setTimeout(function () { statusEl.style.display = 'none'; }, 2000);
      }
    } catch (e) {
      renderTunnelOptions([]);
      showStatus(false, '無法取得 tunneld 設備');
    }
  }

  async function fetchLocation() {
    try {
      const r = await fetch(API + '/location');
      const data = await r.json();
      updateMarker(data.lat, data.lng);
      if (!data.set) map.setView([data.lat, data.lng], 13);
    } catch (e) {
      console.warn('取得座標失敗', e);
      updateMarker(currentLat, currentLng);
    }
  }

  /** 手動設點與定時移動軌跡共用 */
  const RED_DOT_STYLE = {
    radius: 6,
    fillColor: '#ef4444',
    color: '#b91c1c',
    weight: 1,
    fillOpacity: 0.9,
  };

  function addPathPoint(lat, lng) {
    L.circleMarker([lat, lng], RED_DOT_STYLE).addTo(pathLayer);
  }

  async function setLocation(lat, lng) {
    const tunnel = getSelectedTunnelOrNotify();
    if (!tunnel) return;
    try {
      const r = await fetch(API + '/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: lat,
          lng: lng,
          rsd_host: tunnel.host,
          rsd_port: tunnel.port,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        showStatus(false, data.detail || '設定失敗');
        syncCoordsUI();
        return;
      }
      addPathPoint(data.lat, data.lng);
      stopPlaybackAnimation();
      updateMarker(data.lat, data.lng);
      map.setView([data.lat, data.lng], map.getZoom());
      showStatus(true, '已設定座標');
      setTimeout(function () { statusEl.style.display = 'none'; }, 3000);
    } catch (e) {
      showStatus(false, '網路錯誤');
      syncCoordsUI();
    }
  }

  map.on('click', function (ev) {
    const lat = ev.latlng.lat;
    const lng = ev.latlng.lng;
    updateMarker(lat, lng);
    setLocation(lat, lng);
  });

  // 移動：依輸入的「緯度, 經度」送出
  btnMove.addEventListener('click', function () {
    const pair = parseCoordPair(inputCoords.value);
    if (pair) {
      setLocation(pair.lat, pair.lng);
    } else {
      showStatus(false, '請輸入有效 GPS 座標，例如 40.720638, -74.000816');
    }
  });

  // 以瀏覽器真實定位更新標記與地圖（不會自動寫入 iPhone，需再按「移動」或點地圖）
  btnRecenter.addEventListener('click', function () {
    if (!navigator.geolocation) {
      showStatus(false, '此瀏覽器不支援定位');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        applyGeolocationPosition(pos);
        showStatus(true, '已對準現實位置');
        setTimeout(function () { statusEl.style.display = 'none'; }, 2500);
      },
      function () {
        showStatus(false, '無法取得現實位置，請允許定位權限');
      },
      GEO_OPTIONS
    );
  });

  /** GPX <time>，與後端原先 strftime UTC 格式一致 */
  function formatGpxTimeUtc(ts) {
    const d = new Date(Math.floor(ts * 1000));
    const p = function (n) { return String(n).padStart(2, '0'); };
    return (
      d.getUTCFullYear() +
      '-' +
      p(d.getUTCMonth() + 1) +
      '-' +
      p(d.getUTCDate()) +
      'T' +
      p(d.getUTCHours()) +
      ':' +
      p(d.getUTCMinutes()) +
      ':' +
      p(d.getUTCSeconds()) +
      'Z'
    );
  }

  /** 每 intervalSec 秒沿方位移動一步（演算法與原 backend main.py 相同） */
  function computeNextPosition(lat, lng, speedKmh, direction, intervalSec) {
    const metersPerSec = (speedKmh * 1000) / 3600;
    const moveMeters = metersPerSec * intervalSec;
    const latRad = (lat * Math.PI) / 180;
    const metersPerDegLat = 111320.0;
    const metersPerDegLon = 111320.0 * Math.cos(latRad);
    let dLat = 0;
    let dLng = 0;
    if (direction === 'N') dLat = moveMeters / metersPerDegLat;
    else if (direction === 'S') dLat = -moveMeters / metersPerDegLat;
    else if (direction === 'E') dLng = moveMeters / metersPerDegLon;
    else if (direction === 'W') dLng = -moveMeters / metersPerDegLon;
    return [lat + dLat, lng + dLng];
  }

  /** 直線路徑：每秒一個點；回傳 GPX 字串與與 GPX 一致的 [lat,lng] 陣列 */
  function generateRouteGpx(lat, lng, speedKmh, direction, totalSeconds) {
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="ios-location-web" xmlns="http://www.topografix.com/GPX/1/1">',
      '  <trk>',
      '    <name>route</name>',
      '    <trkseg>',
    ];
    const latlngs = [];
    let curLat = lat;
    let curLng = lng;
    const interval = 1.0;
    const startTs = Date.now() / 1000;
    for (let i = 0; i < totalSeconds; i++) {
      latlngs.push([curLat, curLng]);
      const ts = startTs + i * interval;
      lines.push(
        '      <trkpt lat="' +
          curLat.toFixed(6) +
          '" lon="' +
          curLng.toFixed(6) +
          '"><time>' +
          formatGpxTimeUtc(ts) +
          '</time></trkpt>'
      );
      const next = computeNextPosition(curLat, curLng, speedKmh, direction, interval);
      curLat = next[0];
      curLng = next[1];
    }
    lines.push('    </trkseg>', '  </trk>', '</gpx>');
    return { gpx: lines.join('\n'), latlngs: latlngs };
  }

  function stopPlaybackAnimation() {
    if (playbackTimer !== null) {
      clearInterval(playbackTimer);
      playbackTimer = null;
    }
  }

  /** 與 GPX 相同節奏：立即標第一點，之後每秒標下一點（不畫連線） */
  function startPlaybackAnimation(latlngs) {
    stopPlaybackAnimation();
    playbackLayer.clearLayers();
    if (!latlngs || latlngs.length === 0) return;
    let i = 0;
    function step() {
      if (i >= latlngs.length) {
        stopPlaybackAnimation();
        btnStart.disabled = false;
        btnStop.disabled = true;
        return;
      }
      const ll = latlngs[i];
      L.circleMarker(ll, RED_DOT_STYLE).addTo(playbackLayer);
      updateMarker(ll[0], ll[1]);
      map.panTo(ll);
      i++;
    }
    step();
    playbackTimer = setInterval(step, 1000);
  }

  // 定時移動：前端產生 GPX，後端只負責寫檔並交 pymobiledevice3 播放
  async function startRoute() {
    const tunnel = getSelectedTunnelOrNotify();
    if (!tunnel) return;
    const speed = parseFloat(inputSpeed.value);
    if (!Number.isFinite(speed) || speed <= 0) {
      showStatus(false, '請輸入有效時速 (km/h)');
      return;
    }
    const durationMin = parseFloat(inputDuration.value);
    const durationSafe = Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 60;
    const dir = (inputDir.value || 'N').toUpperCase();
    if (!{ N: 1, E: 1, S: 1, W: 1 }[dir]) {
      showStatus(false, '方位无效');
      return;
    }
    const totalSeconds = Math.max(1, Math.floor(durationSafe * 60));
    let route;
    try {
      route = generateRouteGpx(currentLat, currentLng, speed, dir, totalSeconds);
    } catch (e) {
      showStatus(false, '產生 GPX 失敗');
      return;
    }
    try {
      const r = await fetch(API + '/route/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gpx: route.gpx,
          rsd_host: tunnel.host,
          rsd_port: tunnel.port,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showStatus(false, data.detail || '啟動路線失敗');
        return;
      }
      btnStart.disabled = true;
      btnStop.disabled = false;
      startPlaybackAnimation(route.latlngs);
      showStatus(true, '已開始定時移動');
      setTimeout(function () { statusEl.style.display = 'none'; }, 3000);
    } catch (e) {
      showStatus(false, '啟動路線失敗');
    }
  }

  async function stopRoute() {
    try {
      await fetch(API + '/route/stop', { method: 'POST' });
    } catch (e) {
      // ignore
    }
    stopPlaybackAnimation();
    btnStart.disabled = false;
    btnStop.disabled = true;
  }

  btnStart.addEventListener('click', function () {
    startRoute();
  });

  btnStop.addEventListener('click', function () {
    stopRoute();
  });

  selectTunnel.addEventListener('change', function () {
    selectedTunnel = tunnelById[selectTunnel.value] || null;
    if (selectedTunnel) saveLastTunnelHost(selectedTunnel.host);
  });
  btnRefreshTunnel.addEventListener('click', function () {
    fetchTunneldDevices();
  });
  presetCoords.addEventListener('change', function () {
    const selected = presetsById[presetCoords.value];
    if (!selected) return;
    updateMarker(selected.lat, selected.lng);
    map.setView([selected.lat, selected.lng], Math.max(map.getZoom(), 15));
    setLocation(selected.lat, selected.lng);
  });

  function updateSpeedHint() {
    const s = parseFloat(inputSpeed.value);
    if (Number.isFinite(s) && s >= 0) {
      const mps = (s * 1000) / 3600;
      speedHint.textContent = '約 ' + mps.toFixed(1) + ' m/s（每秒移動距離）';
    }
  }
  inputSpeed.addEventListener('input', updateSpeedHint);
  inputSpeed.addEventListener('change', updateSpeedHint);

  // 先以目前記憶的座標畫標記並填滿欄位，再向後端同步；最後可選用瀏覽器定位覆寫
  updateMarker(currentLat, currentLng);
  updateSpeedHint();
  fetchPresetLocations();
  fetchLocation().then(function () {
    fetchTunneldDevices();
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        applyGeolocationPosition(pos);
      },
      function () { /* 拒絕或錯誤：維持 fetch 或預設座標 */ },
      GEO_OPTIONS
    );
  });
})();
