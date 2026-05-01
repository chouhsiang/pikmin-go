(function () {
  /** 後端 API 固定連到本機（網頁若架在別處如 GitHub Pages 仍可呼叫 localhost） */
  const API = 'http://localhost:8964/api';
  const presetPills = document.getElementById('presetPills');
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
  const PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="15" height="15"><rect width="256" height="256" fill="none"/><path fill="currentColor" d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"/></svg>';
  const PAUSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="15" height="15"><rect width="256" height="256" fill="none"/><path fill="currentColor" d="M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"/></svg>';
  function setPlayPauseIcon(playing) {
    btnStart.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    btnStart.setAttribute('data-tooltip', playing ? '停止' : '開始');
  }
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

  function showStatus(_ok, _msg) {}

  function syncCoordsUI() {
    inputCoords.value = currentLat.toFixed(6) + ', ' + currentLng.toFixed(6);
  }

  function setCurrentCoords(lat, lng) {
    currentLat = lat;
    currentLng = lng;
    syncCoordsUI();
  }

  /**
   * 解析各種格式的「緯度, 經度」字串，回傳 { lat, lng } 或 null
   *
   * 支援格式：
   *   DD  (十進位度數)
   *     25.006003, 121.454933          逗號（有無空格皆可）
   *     (25.006003, 121.454933)        有括號
   *     25.006003; 121.454933          分號分隔
   *     25.006003 121.454933           空白分隔
   *     N25.006003 E121.454933         方位字母在前
   *     25.006003N 121.454933E         方位字母在後
   *     N 25.006003, E 121.454933      方位+空白+數字
   *     25.006003°N 121.454933°E       帶度符號
   *   DDM (度分)
   *     N25° 0.36018' E121° 27.2960'
   *     25° 0.36018'N 121° 27.2960'E
   *   DMS (度分秒)
   *     N25°0'21.61" E121°27'17.76"
   *     25°0'21.61"N 121°27'17.76"E
   *     N25° 0' 21.61" E121° 27' 17.76"
   *     25° 0' 21.61" N, 121° 27' 17.76" E
   *   其他
   *     geo:25.006003,121.454933       geo URI
   *     @25.006003,121.454933          Google Maps URL 參數
   */
  function parseCoordPair(text) {
    let s = String(text || '').trim();
    if (!s) return null;

    // 去掉已知前綴
    s = s.replace(/^geo:/i, '').replace(/^@/, '').trim();

    // 正規化：括號→空白、各種度分秒 Unicode 符號→ASCII
    s = s
      .replace(/[()[\]{}]/g, ' ')
      .replace(/[˚º]/g, '°')               // ˚ º → °
      .replace(/[′‘’ʹ＇]/g, "'")  // ′ ' ' ʹ ＇ → '
      .replace(/[″“”＂]/g, '"')         // ″ " " ＂ → "
      .replace(/\s+/g, ' ')
      .trim();

    // 將一段不含方位字母的座標字串轉成十進位度數
    function toDecimal(seg) {
      seg = (seg || '').trim();
      // DMS: 25°0'21.61"  (秒號可省略)
      var m = seg.match(/^(\d+(?:\.\d+)?)°\s*(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)"?$/);
      if (m) return +m[1] + +m[2] / 60 + +m[3] / 3600;
      // DDM: 25°0.36018'
      m = seg.match(/^(\d+(?:\.\d+)?)°\s*(\d+(?:\.\d+)?)'$/);
      if (m) return +m[1] + +m[2] / 60;
      // DD: 25.006003 或 25.006003°
      m = seg.match(/^(-?\d+(?:\.\d+)?)°?$/);
      if (m) return +m[1];
      return null;
    }

    function applyDir(v, dir) {
      return (dir === 'S' || dir === 'W') ? -Math.abs(v) : v;
    }

    // 方位字母解析時，逗號/分號視同空白
    var sd = s.replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();

    // 方位在前：N25.006 E121.454 | N25°0'21.61" E121°27'17.76"
    var m = sd.match(/^([NS])\s*([\d°'". ]+?)\s*([EW])\s*([\d°'". ]+?)\s*$/i);
    if (m) {
      var lat = toDecimal(m[2].trim());
      var lng = toDecimal(m[4].trim());
      if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat: applyDir(lat, m[1].toUpperCase()), lng: applyDir(lng, m[3].toUpperCase()) };
      }
    }

    // 方位在後：25.006N 121.454E | 25°0'21.61"N 121°27'17.76"E
    m = sd.match(/^([\d°'". ]+?)\s*([NS])\s*([\d°'". ]+?)\s*([EW])\s*$/i);
    if (m) {
      var lat = toDecimal(m[1].trim());
      var lng = toDecimal(m[3].trim());
      if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat: applyDir(lat, m[2].toUpperCase()), lng: applyDir(lng, m[4].toUpperCase()) };
      }
    }

    // 逗號或分號分隔（以第一個為準）
    var sepIdx = s.search(/[,;]/);
    if (sepIdx !== -1) {
      var p1 = s.slice(0, sepIdx).trim();
      var p2 = s.slice(sepIdx + 1).trim();
      var lat = toDecimal(p1);
      var lng = toDecimal(p2);
      if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat: lat, lng: lng };
      }
    }

    // 空白分隔的兩個純數字
    var parts = s.split(' ').filter(Boolean);
    if (parts.length === 2) {
      var lat = toDecimal(parts[0]);
      var lng = toDecimal(parts[1]);
      if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat: lat, lng: lng };
      }
    }

    return null;
  }

  function updateMarker(lat, lng) {
    if (marker) map.removeLayer(marker);
    marker = L.marker([lat, lng]).addTo(map);
    setCurrentCoords(lat, lng);
  }

  function renderPresetOptions(items) {
    for (const k in presetsById) delete presetsById[k];
    presetPills.innerHTML = '';
    (items || []).forEach(function (item, idx) {
      const id = 'preset-' + String(idx);
      presetsById[id] = item;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill-btn';
      btn.dataset.presetId = id;
      btn.textContent = item.name;
      presetPills.appendChild(btn);
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

  function flashEl(el) {
    el.classList.remove('flash-err');
    void el.offsetWidth;
    el.classList.add('flash-err');
    el.addEventListener('animationend', function h() {
      el.classList.remove('flash-err');
      el.removeEventListener('animationend', h);
    });
  }

  function getSelectedTunnelOrNotify() {
    if (selectedTunnel && selectedTunnel.host && Number.isFinite(selectedTunnel.port)) {
      return selectedTunnel;
    }
    flashEl(selectTunnel);
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
      op.textContent = item.iface === '192.168.50.67' ? '阿暖手機' : kind + ' / ' + item.iface;
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
    const refreshIcon = btnRefreshTunnel.querySelector('svg');
    refreshIcon.classList.add('spinning');
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
      }
    } catch (e) {
      renderTunnelOptions([]);
      showStatus(false, '無法取得 tunneld 設備');
    } finally {
      refreshIcon.classList.remove('spinning');
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
  function doMove() {
    const pair = parseCoordPair(inputCoords.value);
    if (pair) {
      setLocation(pair.lat, pair.lng);
    } else {
      flashEl(inputCoords);
    }
  }
  btnMove.addEventListener('click', doMove);
  inputCoords.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      doMove();
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
        setLocation(pos.coords.latitude, pos.coords.longitude);
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
        setPlayPauseIcon(false);
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
      setPlayPauseIcon(true);
      startPlaybackAnimation(route.latlngs);
      showStatus(true, '已開始定時移動');
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
    setPlayPauseIcon(false);
  }

  btnStart.addEventListener('click', function () {
    if (playbackTimer !== null) {
      stopRoute();
    } else {
      startRoute();
    }
  });

  selectTunnel.addEventListener('change', function () {
    selectedTunnel = tunnelById[selectTunnel.value] || null;
    if (selectedTunnel) saveLastTunnelHost(selectedTunnel.host);
  });
  btnRefreshTunnel.addEventListener('click', function () {
    fetchTunneldDevices();
  });
  presetPills.addEventListener('click', function (e) {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    const selected = presetsById[btn.dataset.presetId];
    if (!selected) return;
    updateMarker(selected.lat, selected.lng);
    map.setView([selected.lat, selected.lng], Math.max(map.getZoom(), 15));
    setLocation(selected.lat, selected.lng);
  });

  document.querySelectorAll('.nav-item').forEach(function (item) {
    item.addEventListener('click', function () {
      document.querySelectorAll('.nav-item').forEach(function (i) { i.classList.remove('active'); });
      document.querySelectorAll('.nav-panel').forEach(function (p) { p.classList.remove('active'); });
      item.classList.add('active');
      const panel = document.querySelector('[data-nav-panel="' + item.dataset.nav + '"]');
      if (panel) panel.classList.add('active');
    });
  });

  document.querySelectorAll('.seg-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      const panel = document.getElementById('panel-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });

  function updateSpeedHint() {
    const s = parseFloat(inputSpeed.value);
    if (Number.isFinite(s) && s >= 0) {
      const mps = (s * 1000) / 3600;
      speedHint.setAttribute('data-tooltip', '約 ' + mps.toFixed(1) + ' m/s（每秒移動距離）');
    }
  }
  inputSpeed.addEventListener('input', updateSpeedHint);
  inputSpeed.addEventListener('change', updateSpeedHint);

  var sidebar = document.querySelector('.sidebar');
  var sidebarToggle = document.getElementById('sidebarToggle');

  var appTooltip = document.createElement('div');
  appTooltip.className = 'app-tooltip';
  document.body.appendChild(appTooltip);

  function showSidebarTooltip() {
    var text = sidebarToggle.getAttribute('data-tooltip');
    var rect = sidebarToggle.getBoundingClientRect();
    appTooltip.textContent = text;
    appTooltip.style.opacity = '0';
    appTooltip.style.display = 'block';
    var tw = appTooltip.offsetWidth;
    var th = appTooltip.offsetHeight;
    if (sidebar.classList.contains('collapsed')) {
      appTooltip.style.left = (rect.right + 8) + 'px';
      appTooltip.style.top = (rect.top + (rect.height - th) / 2) + 'px';
    } else {
      appTooltip.style.left = rect.left + 'px';
      appTooltip.style.top = (rect.top - th - 6) + 'px';
    }
    appTooltip.style.opacity = '1';
  }

  function hideSidebarTooltip() {
    appTooltip.style.opacity = '0';
    appTooltip.style.display = 'none';
  }

  document.querySelectorAll('.btn-icon[data-tooltip], .info-icon[data-tooltip]').forEach(function (el) {
    el.addEventListener('mouseenter', function () {
      var rect = el.getBoundingClientRect();
      appTooltip.textContent = el.getAttribute('data-tooltip');
      appTooltip.style.display = 'block';
      appTooltip.style.opacity = '0';
      var tw = appTooltip.offsetWidth;
      var th = appTooltip.offsetHeight;
      if (el.getAttribute('data-tooltip-position') === 'right') {
        appTooltip.style.left = (rect.right + 8) + 'px';
        appTooltip.style.top = (rect.top + (rect.height - th) / 2) + 'px';
      } else {
        appTooltip.style.left = rect.left + 'px';
        appTooltip.style.top = (rect.top - th - 6) + 'px';
      }
      appTooltip.style.opacity = '1';
    });
    el.addEventListener('mouseleave', hideSidebarTooltip);
  });

  sidebarToggle.addEventListener('mouseenter', showSidebarTooltip);
  sidebarToggle.addEventListener('mouseleave', hideSidebarTooltip);
  sidebarToggle.addEventListener('click', function () {
    hideSidebarTooltip();
    var collapsed = sidebar.classList.toggle('collapsed');
    sidebarToggle.setAttribute('data-tooltip', collapsed ? '展開側欄' : '收合側欄');
    sidebar.addEventListener('transitionend', function handler(e) {
      if (e.propertyName === 'width') {
        map.invalidateSize();
        sidebar.removeEventListener('transitionend', handler);
      }
    });
  });

  // ── 國家分頁 ──────────────────────────────────────────────────────────────
  const countryPanel = document.getElementById('panel-country');

  const COUNTRIES = [
    { name: '美國', sub: '紐約', tz: 'America/New_York', lat: 40.7128, lng: -74.0060 },
    { name: '巴拉圭', sub: null, tz: 'America/Asuncion', lat: -25.2867, lng: -57.6470 },
    { name: '紐西蘭', sub: null, tz: 'Pacific/Auckland', lat: -36.8485, lng: 174.7633 },
    { name: '義大利', sub: null, tz: 'Europe/Rome', lat: 41.9028, lng: 12.4964 },
  ];

  function getUtcOffsetMin(tz) {
    const now = new Date();
    const a = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const b = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((a - b) / 60000);
  }

  function formatDiff(min) {
    if (min === 0) return '±0h';
    const sign = min > 0 ? '+' : '-';
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return sign + h + (m ? ':' + String(m).padStart(2, '0') : '') + 'h';
  }

  function fmtTime(tz) {
    return new Date().toLocaleTimeString('zh-TW', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  const TZ_ZH = {
    'Asia/Taipei':          { name: '台灣',     sub: '台北' },
    'Asia/Tokyo':           { name: '日本',     sub: '東京' },
    'Asia/Shanghai':        { name: '中國',     sub: '上海' },
    'Asia/Hong_Kong':       { name: '香港',     sub: null },
    'Asia/Macau':           { name: '澳門',     sub: null },
    'Asia/Seoul':           { name: '韓國',     sub: '首爾' },
    'Asia/Singapore':       { name: '新加坡',   sub: null },
    'Asia/Bangkok':         { name: '泰國',     sub: '曼谷' },
    'Asia/Kuala_Lumpur':    { name: '馬來西亞', sub: '吉隆坡' },
    'Asia/Jakarta':         { name: '印尼',     sub: '雅加達' },
    'Asia/Manila':          { name: '菲律賓',   sub: '馬尼拉' },
    'Asia/Kolkata':         { name: '印度',     sub: '孟買' },
    'Asia/Dubai':           { name: '阿聯酋',   sub: '杜拜' },
    'America/New_York':     { name: '美國',     sub: '紐約' },
    'America/Los_Angeles':  { name: '美國',     sub: '洛杉磯' },
    'America/Chicago':      { name: '美國',     sub: '芝加哥' },
    'America/Denver':       { name: '美國',     sub: '丹佛' },
    'America/Asuncion':     { name: '巴拉圭',   sub: '亞松森' },
    'America/Sao_Paulo':    { name: '巴西',     sub: '聖保羅' },
    'Europe/London':        { name: '英國',     sub: '倫敦' },
    'Europe/Paris':         { name: '法國',     sub: '巴黎' },
    'Europe/Berlin':        { name: '德國',     sub: '柏林' },
    'Europe/Rome':          { name: '義大利',   sub: '羅馬' },
    'Europe/Madrid':        { name: '西班牙',   sub: '馬德里' },
    'Australia/Sydney':     { name: '澳洲',     sub: '雪梨' },
    'Pacific/Auckland':     { name: '紐西蘭',   sub: '奧克蘭' },
  };

  function buildCountryPanel() {
    countryPanel.innerHTML = '';
    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const userOffMin = getUtcOffsetMin(userTz);

    const tzZh = TZ_ZH[userTz];
    const tzParts = userTz.split('/');
    const userCity = tzZh ? tzZh.name : tzParts[tzParts.length - 1].replace(/_/g, ' ');
    const userSub  = tzZh ? tzZh.sub  : userTz;

    const allEntries = COUNTRIES.map(function (c) { return Object.assign({}, c, { isUser: false }); });
    allEntries.push({ name: userCity, sub: userSub, tz: userTz, lat: null, lng: null, isUser: true });
    allEntries.sort(function (a, b) { return getUtcOffsetMin(a.tz) - getUtcOffsetMin(b.tz); });

    const list = document.createElement('div');
    list.className = 'country-list';

    allEntries.forEach(function (c) {
      const diff = formatDiff(getUtcOffsetMin(c.tz) - userOffMin);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'country-item' + (c.isUser ? ' current' : '');
      if (!c.isUser) {
        item.dataset.lat = String(c.lat);
        item.dataset.lng = String(c.lng);
      }
      item.innerHTML =
        '<span class="country-name">' + c.name + (c.sub ? '<small>' + c.sub + '</small>' : '') + '</span>' +
        '<span class="country-info">' +
          '<span class="country-diff">' + (c.isUser ? '目前位置' : diff) + '</span>' +
          '<span class="country-time" data-tz="' + c.tz + '">' + fmtTime(c.tz) + '</span>' +
        '</span>';
      list.appendChild(item);
    });

    list.addEventListener('click', function (e) {
      const item = e.target.closest('.country-item');
      if (!item || item.classList.contains('current')) return;
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      updateMarker(lat, lng);
      map.setView([lat, lng], Math.max(map.getZoom(), 10));
      setLocation(lat, lng);
    });

    countryPanel.appendChild(list);
  }

  function tickCountryTimes() {
    countryPanel.querySelectorAll('.country-time[data-tz]').forEach(function (el) {
      el.textContent = fmtTime(el.dataset.tz);
    });
  }

  buildCountryPanel();
  setInterval(tickCountryTimes, 60000);

  // ── 使用教學 FAB ──────────────────────────────────────────────────────────
  var btnHelp = document.getElementById('btnHelp');
  var helpOverlay = document.getElementById('helpOverlay');

  btnHelp.addEventListener('mouseenter', function () {
    var rect = btnHelp.getBoundingClientRect();
    appTooltip.textContent = '使用教學';
    appTooltip.style.display = 'block';
    appTooltip.style.opacity = '0';
    var tw = appTooltip.offsetWidth;
    var th = appTooltip.offsetHeight;
    appTooltip.style.left = (rect.right - tw) + 'px';
    appTooltip.style.top = (rect.top - th - 6) + 'px';
    appTooltip.style.opacity = '1';
  });
  btnHelp.addEventListener('mouseleave', hideSidebarTooltip);
  btnHelp.addEventListener('click', function () {
    hideSidebarTooltip();
    helpOverlay.classList.add('active');
  });
  document.getElementById('helpClose').addEventListener('click', function () {
    helpOverlay.classList.remove('active');
  });
  helpOverlay.addEventListener('click', function (e) {
    if (e.target === helpOverlay) helpOverlay.classList.remove('active');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') helpOverlay.classList.remove('active');
  });

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
