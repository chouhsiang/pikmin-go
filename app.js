(function () {
  /** 後端 API 固定連到本機（網頁若架在別處如 GitHub Pages 仍可呼叫 localhost） */
  const API = 'http://localhost:8964/api';
  const presetPills = document.getElementById('presetPills');
  const inputCoords = document.getElementById('inputCoords');
  const inputCoordsFlower = document.getElementById('inputCoordsFlower');
  const inputCoordsBookmark = document.getElementById('inputCoordsBookmark');
  const selectTunnel = document.getElementById('selectTunnel');
  const btnRefreshTunnel = document.getElementById('btnRefreshTunnel');
  const inputSpeed = document.getElementById('inputSpeed');
  const inputDir = document.getElementById('inputDir');
  const inputDuration = document.getElementById('inputDuration');
  const speedHint = document.getElementById('speedHint');
  const btnRecenter = document.getElementById('btnRecenter');
  const btnRecenterFlower = document.getElementById('btnRecenterFlower');
  const btnAddBookmark = document.getElementById('btnAddBookmark');
  const bookmarkList = document.getElementById('bookmarkList');
  const btnStart = document.getElementById('btnStart');
  const flowerStatsBlock = document.getElementById('flowerStatsBlock');
  const flowerTimerText = document.getElementById('flowerTimerText');
  const flowerCountText = document.getElementById('flowerCountText');
  const flowerCoinDisplay = document.getElementById('flowerCoinDisplay');
  const flowerCoinText = document.getElementById('flowerCoinText');
  const PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="15" height="15"><rect width="256" height="256" fill="none"/><path fill="currentColor" d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"/></svg>';
  const PAUSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="15" height="15"><rect width="256" height="256" fill="none"/><path fill="currentColor" d="M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z"/></svg>';
  function setPlayPauseIcon(playing) {
    btnStart.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    btnStart.setAttribute('data-tooltip', playing ? '暫停' : '開始');
  }
  const LAST_TUNNEL_HOST_KEY = 'pik.lastTunnelHost';

  // 預設紐約（單欄格式與 placeholder 一致）
  document.getElementById('pikminImg').src = './assets/Pikmin3.png';

  let currentLat = 40.720638;
  let currentLng = -74.000816;
  let marker = null;

  const map = L.map('map', { zoomControl: false }).setView([currentLat, currentLng], 13);
  // CARTO Voyager (Raster Retina)：高解析度、柔和配色
  const voyagerUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}' + (L.Browser.retina ? '@2x.png' : '.png');
  L.tileLayer(voyagerUrl, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);
  const pathLayer = L.layerGroup().addTo(map); // 手動設點：紅色圓點
  const playbackLayer = L.layerGroup().addTo(map); // 定時移動：走路軌跡線

  let playbackTimer = null;
  let playbackPolyline = null;
  let flowerTimerInterval = null;
  let flowerElapsedSeconds = 0;
  let testMode = false;
  let selectedTunnel = null;
  let routeActive = false;
  let routeSpeed = 0;
  let routeDir = 90;
  let dirPreviewLine = null;
  let tunnelSelectTrigger = null;
  let lastHorizontalDir = 'W';
  let routeEndTime = 0;
  let paused = false;
  let pausedRemaining = 0;
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
    const v = currentLat.toFixed(6) + ', ' + currentLng.toFixed(6);
    inputCoords.value = v;
    inputCoordsFlower.value = v;
    inputCoordsBookmark.value = v;
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

  const PIKMIN_ICON = L.divIcon({
    className: 'pikmin-marker-wrapper',
    html: '<img class="pikmin-marker-img" src="./assets/Pikmin_walk.png" /><div class="pikmin-marker-dot"></div>',
    iconSize: [52, 83],
    iconAnchor: [11, 79],
    popupAnchor: [0, -79],
  });

  function updateMarker(lat, lng) {
    if (marker) map.removeLayer(marker);
    marker = L.marker([lat, lng], { icon: PIKMIN_ICON }).addTo(map);
    setCurrentCoords(lat, lng);
    if (routeActive) updateMarkerFacing(routeDir);
    updateMarkerDeviceState();
  }

  function updateMarkerDeviceState() {
    if (!marker) return;
    const el = marker.getElement();
    if (!el) return;
    el.classList.toggle('no-device', !selectedTunnel);
  }

  function updateMarkerFacing(bearing) {
    if (!marker) return;
    const el = marker.getElement();
    if (!el) return;
    if (Math.sin((bearing * Math.PI) / 180) >= 0) lastHorizontalDir = 'E';
    else lastHorizontalDir = 'W';
    el.classList.toggle('facing-east', lastHorizontalDir === 'E');
  }

  function renderPresetOptions(items) {
    for (const k in presetsById) delete presetsById[k];
    presetPills.innerHTML = '';
    let currentGroup = null;
    (items || []).forEach(function (item, idx) {
      if (item.section != null) {
        currentGroup = document.createElement('div');
        currentGroup.className = 'pill-group';
        const label = document.createElement('span');
        label.className = 'pill-group-label';
        label.textContent = item.section;
        currentGroup.appendChild(label);
        const pills = document.createElement('div');
        pills.className = 'pill-list';
        currentGroup.appendChild(pills);
        presetPills.appendChild(currentGroup);
        return;
      }
      const id = 'preset-' + String(idx);
      presetsById[id] = item;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill-btn';
      btn.dataset.presetId = id;
      btn.textContent = item.name;
      const target = currentGroup ? currentGroup.querySelector('.pill-list') : presetPills;
      target.appendChild(btn);
    });
  }

  async function fetchPresetLocations() {
    try {
      const r = await fetch('./locations.json');
      const data = await r.json().catch(function () { return []; });
      if (!r.ok || !Array.isArray(data)) throw new Error('invalid locations');
      const list = data
        .map(function (x) {
          if (x.section != null) return { section: String(x.section) };
          return {
            name: String(x.name || ''),
            lat: Number(x.lat),
            lng: Number(x.lng),
          };
        })
        .filter(function (x) {
          return x.section != null || (x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng));
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
    if (selectedTunnel && selectedTunnel.test) return selectedTunnel;
    if (selectedTunnel && selectedTunnel.host && Number.isFinite(selectedTunnel.port)) {
      return selectedTunnel;
    }
    flashEl(tunnelSelectTrigger || selectTunnel);
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
    } else {
      let rememberedId = '';
      const rememberedHost = getLastTunnelHost();
      items.forEach(function (item, idx) {
        const id = item.udid + '::' + String(idx);
        tunnelById[id] = item;
        const iface = String(item.iface || '');
        const kind = isIpAddress(iface) || /-Network$/i.test(iface) ? '無線' : '有線';
        const op = document.createElement('option');
        op.value = id;
        const DEVICE_NAMES = { '192.168.50.67': '阿暖手機', '192.168.50.227': '阿暖手機', '192.168.50.123': '執行長手機' };
        const UDID_NAMES = { '00008140-00096D193A0B001C': '阿暖手機', '00008103-0014452022D9A01E': '執行長平板' };
        const udidName = Object.keys(UDID_NAMES).find(function (u) { return iface.indexOf(u) !== -1 || String(item.udid || '').indexOf(u) !== -1; });
        op.textContent = DEVICE_NAMES[item.iface] || (udidName ? UDID_NAMES[udidName] : kind + ' / ' + item.iface);
        selectTunnel.appendChild(op);
        if (!rememberedId && rememberedHost && item.host === rememberedHost) {
          rememberedId = id;
        }
      });
      selectTunnel.value = rememberedId || Object.keys(tunnelById)[0];
      selectedTunnel = tunnelById[selectTunnel.value] || null;
      if (selectedTunnel) saveLastTunnelHost(selectedTunnel.host);
    }
    if (testMode) {
      selectedTunnel = { test: true };
      selectTunnel.disabled = true;
    }
    updateMarkerDeviceState();
  }

  async function fetchTunneldDevices() {
    const refreshIcon = btnRefreshTunnel.querySelector('svg');
    refreshIcon.classList.add('spinning');
    const spinStart = Date.now();
    const MIN_SPIN_MS = 700;
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
      const elapsed = Date.now() - spinStart;
      const wait = MIN_SPIN_MS - elapsed;
      if (wait > 0) {
        setTimeout(function () { refreshIcon.classList.remove('spinning'); }, wait);
      } else {
        refreshIcon.classList.remove('spinning');
      }
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
    if (paused) {
      setCurrentCoords(lat, lng);
      updateMarker(lat, lng);
      return;
    }
    if (routeActive) {
      await restartRouteFrom(lat, lng);
      return;
    }
    const tunnel = getSelectedTunnelOrNotify();
    if (!tunnel) return;
    if (tunnel.test) {
      addPathPoint(lat, lng);
      stopPlaybackAnimation();
      updateMarker(lat, lng);
      map.setView([lat, lng], map.getZoom());
      showStatus(true, '已設定座標');
      return;
    }
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
  function doMoveFrom(inputEl) {
    const pair = parseCoordPair(inputEl.value);
    if (pair) {
      updateMarker(pair.lat, pair.lng);
      map.setView([pair.lat, pair.lng], 18);
      setLocation(pair.lat, pair.lng);
    } else {
      flashEl(inputEl);
    }
  }
  inputCoords.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doMoveFrom(inputCoords); }
  });
  inputCoords.addEventListener('click', function () { inputCoords.value = ''; });
  inputCoordsFlower.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doMoveFrom(inputCoordsFlower); }
  });
  inputCoordsFlower.addEventListener('click', function () { inputCoordsFlower.value = ''; });
  inputCoordsBookmark.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doMoveFrom(inputCoordsBookmark); }
  });
  inputCoordsBookmark.addEventListener('click', function () { inputCoordsBookmark.value = ''; });

  const BOOKMARK_SUGGESTIONS = ['多菇點', '巨大菇', '水菇', '水晶菇', '毒菇', '火菇', '電菇', '大藍菇', '大白菇', '大紅菇', '大黃菇'];
  const suggestionDropdown = document.createElement('div');
  suggestionDropdown.className = 'bookmark-suggestion-dropdown';
  document.body.appendChild(suggestionDropdown);
  function showSuggestions(input) {
    const filter = input.value.trim();
    const filtered = filter ? BOOKMARK_SUGGESTIONS.filter(function (s) { return s.includes(filter); }) : BOOKMARK_SUGGESTIONS;
    if (filtered.length === 0) { suggestionDropdown.style.display = 'none'; return; }
    suggestionDropdown.innerHTML = '';
    filtered.forEach(function (s) {
      const opt = document.createElement('div');
      opt.className = 'bookmark-suggestion-item';
      opt.textContent = s;
      opt.addEventListener('mousedown', function (e) {
        e.preventDefault();
        input.value = s;
        suggestionDropdown.style.display = 'none';
      });
      suggestionDropdown.appendChild(opt);
    });
    const rect = input.getBoundingClientRect();
    suggestionDropdown.style.left = rect.left + 'px';
    suggestionDropdown.style.top = (rect.bottom + 4) + 'px';
    suggestionDropdown.style.width = rect.width + 'px';
    suggestionDropdown.style.display = 'block';
  }
  function hideSuggestions() { suggestionDropdown.style.display = 'none'; }

  const BOOKMARK_KEY = 'pik.bookmarks';
  function loadBookmarks() {
    try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY) || '[]'); } catch (_) { return []; }
  }
  function saveBookmarks(list) {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(list));
  }
  const ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="15" height="15"><rect width="256" height="256" fill="none"/><line x1="64" y1="192" x2="192" y2="64" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/><polyline points="88 64 192 64 192 168" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/></svg>';
  const TRASH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="15" height="15"><rect width="256" height="256" fill="none"/><polyline points="216 60 40 60" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/><line x1="104" y1="104" x2="104" y2="168" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/><line x1="152" y1="104" x2="152" y2="168" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/><path d="M200,60V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V60" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/><path d="M168,60V36a8,8,0,0,0-8-8H96a8,8,0,0,0-8,8V60" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/></svg>';
  const GRIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="12" height="12"><circle cx="88" cy="64" r="16" fill="currentColor"/><circle cx="168" cy="64" r="16" fill="currentColor"/><circle cx="88" cy="128" r="16" fill="currentColor"/><circle cx="168" cy="128" r="16" fill="currentColor"/><circle cx="88" cy="192" r="16" fill="currentColor"/><circle cx="168" cy="192" r="16" fill="currentColor"/></svg>';

  let dragSrcIdx = null;
  let insertIdx = null;
  const spacer = document.createElement('div');
  spacer.className = 'bookmark-spacer';

  bookmarkList.addEventListener('dragover', function (e) {
    e.preventDefault();
    const items = Array.from(bookmarkList.querySelectorAll('.bookmark-item:not(.dragging)'));
    let placed = false;
    let candidateIdx = null;
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        candidateIdx = i;
        placed = true;
        break;
      }
    }
    if (!placed && items.length > 0) {
      candidateIdx = loadBookmarks().length;
    }
    if (candidateIdx === null || candidateIdx === dragSrcIdx || candidateIdx === dragSrcIdx + 1) {
      spacer.remove();
      insertIdx = null;
    } else {
      insertIdx = candidateIdx;
      bookmarkList.insertBefore(spacer, placed ? items[candidateIdx] : items[items.length - 1].nextSibling);
    }
  });

  bookmarkList.addEventListener('drop', function (e) {
    e.preventDefault();
    spacer.remove();
    if (dragSrcIdx === null || insertIdx === null || dragSrcIdx === insertIdx) return;
    const updated = loadBookmarks();
    const [moved] = updated.splice(dragSrcIdx, 1);
    let target = insertIdx;
    if (dragSrcIdx < target) target--;
    updated.splice(target, 0, moved);
    saveBookmarks(updated);
    renderBookmarks();
  });

  function renderBookmarks() {
    const list = loadBookmarks();
    bookmarkList.innerHTML = '';
    if (list.length === 0) return;

    const header = document.createElement('div');
    header.className = 'bookmark-list-header';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'bookmark-clear-btn';
    clearBtn.textContent = '清除全部';
    clearBtn.addEventListener('click', function () { saveBookmarks([]); renderBookmarks(); });
    header.appendChild(clearBtn);
    bookmarkList.appendChild(header);

    list.forEach(function (bm, idx) {
      const item = document.createElement('div');
      item.className = 'bookmark-item';
      item.draggable = true;

      const handle = document.createElement('span');
      handle.className = 'bookmark-handle';
      handle.innerHTML = GRIP_SVG;

      const textBlock = document.createElement('div');
      textBlock.className = 'bookmark-text-block';

      const label = document.createElement('span');
      label.className = 'bookmark-coords';
      label.textContent = bm.name || (bm.lat.toFixed(6) + ', ' + bm.lng.toFixed(6));
      label.style.cursor = 'text';
      textBlock.appendChild(label);

      label.addEventListener('click', function () {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'bookmark-name-input';
        input.placeholder = bm.lat.toFixed(6) + ', ' + bm.lng.toFixed(6);
        if (bm.name) { input.value = bm.name; }
        input.addEventListener('focus', function () { showSuggestions(input); });
        input.addEventListener('input', function () { showSuggestions(input); });
        item.replaceChild(input, textBlock);
        input.focus();
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            const updated = loadBookmarks();
            updated[idx].name = input.value.trim() || null;
            saveBookmarks(updated);
            renderBookmarks();
          } else if (e.key === 'Escape') {
            renderBookmarks();
          }
        });
        input.addEventListener('blur', function () {
          hideSuggestions();
          const updated = loadBookmarks();
          updated[idx].name = input.value.trim() || null;
          saveBookmarks(updated);
          renderBookmarks();
        });
      });

      item.addEventListener('dragstart', function (e) {
        dragSrcIdx = idx;
        insertIdx = null;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(function () { item.classList.add('dragging'); }, 0);
      });
      item.addEventListener('dragend', function () {
        spacer.remove();
        item.classList.remove('dragging');
        dragSrcIdx = null;
        insertIdx = null;
      });

      const actions = document.createElement('div');
      actions.className = 'bookmark-actions';
      const gotoBtn = document.createElement('button');
      gotoBtn.type = 'button';
      gotoBtn.className = 'btn-icon';
      gotoBtn.setAttribute('data-tooltip', '前往');
      gotoBtn.innerHTML = ARROW_SVG;
      attachTooltip(gotoBtn);
      gotoBtn.addEventListener('click', function () { setLocation(bm.lat, bm.lng); });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-icon';
      removeBtn.setAttribute('data-tooltip', '移除');
      removeBtn.innerHTML = TRASH_SVG;
      attachTooltip(removeBtn);
      removeBtn.addEventListener('click', function () {
        const updated = loadBookmarks();
        updated.splice(idx, 1);
        saveBookmarks(updated);
        renderBookmarks();
      });
      actions.appendChild(gotoBtn);
      actions.appendChild(removeBtn);
      item.appendChild(handle);
      if (bm.flag) {
        const flagEl = document.createElement('span');
        flagEl.className = 'bookmark-flag';
        flagEl.textContent = bm.flag;
        item.appendChild(flagEl);
      }
      item.appendChild(textBlock);
      item.appendChild(actions);
      bookmarkList.appendChild(item);
    });
  }
  const toast = document.createElement('div');
  toast.className = 'app-toast';
  document.body.appendChild(toast);
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2000);
  }

  btnAddBookmark.addEventListener('click', function () {
    // 若輸入框有貼上的座標但尚未按 Enter，先移動過去再加入
    const pair = parseCoordPair(inputCoordsBookmark.value);
    if (pair && (pair.lat !== currentLat || pair.lng !== currentLng)) {
      doMoveFrom(inputCoordsBookmark);
    }
    const list = loadBookmarks();
    const exists = list.some(function (bm) { return bm.lat === currentLat && bm.lng === currentLng; });
    if (exists) { showToast('座標已存在'); return; }
    const bm = { lat: currentLat, lng: currentLng, flag: null };
    list.push(bm);
    saveBookmarks(list);
    renderBookmarks();
    fetch('https://nominatim.openstreetmap.org/reverse?lat=' + currentLat + '&lon=' + currentLng + '&format=json&zoom=3', {
      headers: { 'User-Agent': 'pikmin-go-simulator' }
    }).then(function (r) { return r.json(); }).then(function (data) {
      const code = data.address && data.address.country_code;
      const flag = code ? code.toUpperCase().split('').map(function (c) { return String.fromCodePoint(c.charCodeAt(0) + 0x1F1A5); }).join('') : null;
      const updated = loadBookmarks();
      const target = updated.find(function (b) { return b.lat === bm.lat && b.lng === bm.lng; });
      if (target) { target.flag = flag; saveBookmarks(updated); renderBookmarks(); }
    }).catch(function () {});
  });
  renderBookmarks();

  // 以瀏覽器真實定位更新標記與地圖（不會自動寫入 iPhone，需再按「移動」或點地圖）
  function doRecenter() {
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
  }
  btnRecenter.addEventListener('click', doRecenter);
  btnRecenterFlower.addEventListener('click', doRecenter);

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

  /** 每 intervalSec 秒沿 bearing（度，0=北順時針）移動一步 */
  function computeNextPosition(lat, lng, speedKmh, bearing, intervalSec) {
    const metersPerSec = (speedKmh * 1000) / 3600;
    const moveMeters = metersPerSec * intervalSec;
    const latRad = (lat * Math.PI) / 180;
    const metersPerDegLat = 111320.0;
    const metersPerDegLon = 111320.0 * Math.cos(latRad);
    const bearingRad = (bearing * Math.PI) / 180;
    const dLat = (moveMeters * Math.cos(bearingRad)) / metersPerDegLat;
    const dLng = (moveMeters * Math.sin(bearingRad)) / metersPerDegLon;
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

  function updateFlowerTimerDisplay() {
    const m = Math.floor(flowerElapsedSeconds / 60);
    const s = flowerElapsedSeconds % 60;
    flowerTimerText.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function updateFlowerStats() {
    const flowers = Math.floor(flowerElapsedSeconds * routeSpeed * 20000 / (18 * 3600));
    const coins = Math.min(60, Math.floor(flowers / 250));
    flowerCountText.textContent = flowers.toLocaleString('zh-TW');
    flowerCoinText.textContent = coins;
    flowerCoinDisplay.classList.toggle('flower-coin-max', coins >= 60);
  }

  function startFlowerTimer(reset) {
    if (reset) {
      if (flowerTimerInterval !== null) { clearInterval(flowerTimerInterval); flowerTimerInterval = null; }
      flowerElapsedSeconds = 0;
      updateFlowerTimerDisplay();
      updateFlowerStats();
    }
    flowerStatsBlock.style.display = '';
    if (flowerTimerInterval !== null) return;
    // 以真實時鐘計算經過秒數，避免 setInterval 漂移／背景節流造成統計偏少
    const baseMs = Date.now() - flowerElapsedSeconds * 1000;
    function tick() {
      flowerElapsedSeconds = Math.floor((Date.now() - baseMs) / 1000);
      updateFlowerTimerDisplay();
      updateFlowerStats();
    }
    flowerTimerInterval = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', function onVis() {
      if (flowerTimerInterval === null) { document.removeEventListener('visibilitychange', onVis); return; }
      if (!document.hidden) tick();
    });
  }

  function pauseFlowerTimer() {
    if (flowerTimerInterval !== null) { clearInterval(flowerTimerInterval); flowerTimerInterval = null; }
  }

  function resetFlowerTimer() {
    pauseFlowerTimer();
    flowerElapsedSeconds = 0;
    updateFlowerTimerDisplay();
    updateFlowerStats();
    flowerStatsBlock.style.display = 'none';
  }

  /** 走路軌跡線樣式（單一 polyline 延伸，避免大量圓點造成卡頓） */
  const ROUTE_LINE_STYLE = {
    color: '#b91c1c',
    weight: 3,
    opacity: 0.85,
  };

  function stopPlaybackAnimation() {
    if (playbackTimer !== null) {
      clearInterval(playbackTimer);
      playbackTimer = null;
    }
  }

  /** 與 GPX 相同節奏：以真實時鐘對齊索引，軌跡以線段延伸顯示 */
  function startPlaybackAnimation(latlngs, clearPath) {
    stopPlaybackAnimation();
    if (clearPath !== false) playbackLayer.clearLayers();
    playbackPolyline = null;
    if (!latlngs || latlngs.length === 0) return;

    playbackPolyline = L.polyline([latlngs[0]], ROUTE_LINE_STYLE).addTo(playbackLayer);

    const startMs = Date.now();
    let lastTarget = -1;
    function step() {
      const target = Math.min(Math.floor((Date.now() - startMs) / 1000), latlngs.length - 1);
      if (target !== lastTarget && playbackPolyline) {
        playbackPolyline.setLatLngs(latlngs.slice(0, target + 1));
        lastTarget = target;
      }
      const ll = latlngs[target];
      updateMarker(ll[0], ll[1]);
      map.panTo(ll);
      if (target >= latlngs.length - 1) {
        stopPlaybackAnimation();
        setPlayPauseIcon(false);
        routeActive = false;
        paused = false;
        resetFlowerTimer();
      }
    }
    step();
    playbackTimer = setInterval(step, 1000);
    document.addEventListener('visibilitychange', function onVis() {
      if (playbackTimer === null) { document.removeEventListener('visibilitychange', onVis); return; }
      if (!document.hidden) step();
    });
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
    const durationSafe = Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 600;
    const inputDirVal = parseFloat(inputDir.value);
    const bearing = Number.isFinite(inputDirVal) ? inputDirVal : 90;
    const totalSeconds = Math.max(1, Math.floor(durationSafe * 60));
    if (dirPreviewLine) { map.removeLayer(dirPreviewLine); dirPreviewLine = null; }
    let route;
    try {
      route = generateRouteGpx(currentLat, currentLng, speed, bearing, totalSeconds);
    } catch (e) {
      showStatus(false, '產生 GPX 失敗');
      return;
    }
    if (tunnel.test) {
      routeActive = true;
      routeSpeed = speed;
      routeDir = bearing;
      routeEndTime = Date.now() / 1000 + totalSeconds;
      setPlayPauseIcon(true);
      startFlowerTimer(true);
      map.setView([currentLat, currentLng], 18);
      startPlaybackAnimation(route.latlngs, true);
      updateMarkerFacing(bearing);
      showStatus(true, '已開始定時移動');
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
      routeActive = true;
      routeSpeed = speed;
      routeDir = bearing;
      routeEndTime = Date.now() / 1000 + totalSeconds;
      setPlayPauseIcon(true);
      startFlowerTimer(true);
      map.setView([currentLat, currentLng], 18);
      startPlaybackAnimation(route.latlngs, true);
      updateMarkerFacing(bearing);
      showStatus(true, '已開始定時移動');
    } catch (e) {
      showStatus(false, '啟動路線失敗');
    }
  }

  async function stopRoute() {
    routeActive = false;
    paused = false;
    if (!selectedTunnel || !selectedTunnel.test) {
      try {
        await fetch(API + '/route/stop', { method: 'POST' });
      } catch (e) {
        // ignore
      }
    }
    stopPlaybackAnimation();
    setPlayPauseIcon(false);
    resetFlowerTimer();
  }

  async function pauseRoute() {
    paused = true;
    pausedRemaining = Math.max(0, Math.floor(routeEndTime - Date.now() / 1000));
    stopPlaybackAnimation();
    if (selectedTunnel && !selectedTunnel.test) {
      try { await fetch(API + '/route/stop', { method: 'POST' }); } catch (e) {}
    }
    setPlayPauseIcon(false);
    pauseFlowerTimer();
  }

  async function resumeRoute() {
    if (pausedRemaining <= 0) {
      paused = false;
      routeActive = false;
      setPlayPauseIcon(false);
      resetFlowerTimer();
      return;
    }
    routeEndTime = Date.now() / 1000 + pausedRemaining;
    paused = false;
    const tunnel = getSelectedTunnelOrNotify();
    if (!tunnel) return;
    let route;
    try {
      route = generateRouteGpx(currentLat, currentLng, routeSpeed, routeDir, pausedRemaining);
    } catch (e) {
      showStatus(false, '產生 GPX 失敗');
      return;
    }
    if (tunnel.test) {
      setPlayPauseIcon(true);
      startFlowerTimer(false);
      startPlaybackAnimation(route.latlngs);
      return;
    }
    try {
      const r = await fetch(API + '/route/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gpx: route.gpx, rsd_host: tunnel.host, rsd_port: tunnel.port }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showStatus(false, data.detail || '繼續路線失敗');
        return;
      }
      setPlayPauseIcon(true);
      startFlowerTimer(false);
      startPlaybackAnimation(route.latlngs);
    } catch (e) {
      showStatus(false, '繼續路線失敗');
    }
  }

  async function restartRouteFrom(lat, lng) {
    const remaining = Math.floor(routeEndTime - Date.now() / 1000);
    if (remaining <= 0) {
      stopRoute();
      return;
    }
    const tunnel = getSelectedTunnelOrNotify();
    if (!tunnel) return;
    let route;
    try {
      route = generateRouteGpx(lat, lng, routeSpeed, routeDir, remaining);
    } catch (e) {
      showStatus(false, '產生 GPX 失敗');
      return;
    }
    if (tunnel.test) {
      routeEndTime = Date.now() / 1000 + remaining;
      stopPlaybackAnimation();
      updateMarker(lat, lng);
      map.setView([lat, lng], map.getZoom());
      startPlaybackAnimation(route.latlngs);
      return;
    }
    try {
      await fetch(API + '/route/stop', { method: 'POST' });
    } catch (e) { /* ignore */ }
    try {
      const r = await fetch(API + '/route/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gpx: route.gpx, rsd_host: tunnel.host, rsd_port: tunnel.port }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showStatus(false, data.detail || '更新路線失敗');
        return;
      }
      routeEndTime = Date.now() / 1000 + remaining;
      stopPlaybackAnimation();
      updateMarker(lat, lng);
      map.setView([lat, lng], map.getZoom());
      startPlaybackAnimation(route.latlngs);
    } catch (e) {
      showStatus(false, '更新路線失敗');
    }
  }

  btnStart.addEventListener('click', function () {
    if (paused) {
      resumeRoute();
    } else if (routeActive) {
      pauseRoute();
    } else {
      startRoute();
    }
  });

  selectTunnel.addEventListener('change', function () {
    if (testMode) return;
    selectedTunnel = tunnelById[selectTunnel.value] || null;
    if (selectedTunnel && !selectedTunnel.test) saveLastTunnelHost(selectedTunnel.host);
    updateMarkerDeviceState();
  });
  const labelDevice = document.querySelector('label[for="selectTunnel"]');
  labelDevice.addEventListener('dblclick', function () {
    testMode = !testMode;
    if (testMode) {
      selectedTunnel = { test: true };
      const testOp = document.createElement('option');
      testOp.value = '__TEST__';
      testOp.textContent = '測試模式';
      testOp.id = 'optTestMode';
      selectTunnel.appendChild(testOp);
      selectTunnel.value = '__TEST__';
      selectTunnel.disabled = true;
      selectTunnel.classList.add('test-mode-select');
      labelDevice.classList.add('test-mode-active');
      btnRefreshTunnel.style.display = 'none';
    } else {
      const testOp = document.getElementById('optTestMode');
      if (testOp) testOp.remove();
      selectTunnel.disabled = false;
      selectTunnel.classList.remove('test-mode-select');
      labelDevice.classList.remove('test-mode-active');
      btnRefreshTunnel.style.display = '';
      selectedTunnel = tunnelById[selectTunnel.value] || null;
    }
    updateMarkerDeviceState();
  });
  btnRefreshTunnel.addEventListener('click', function () {
    fetchTunneldDevices();
  });
  (function initCustomTunnelSelect() {
    const wrap = document.createElement('div');
    wrap.className = 'custom-select-wrap';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    selectTunnel.parentNode.insertBefore(wrap, selectTunnel);
    selectTunnel.style.display = 'none';
    tunnelSelectTrigger = trigger;

    function sync() {
      const opts = Array.prototype.slice.call(selectTunnel.options);
      const cur = opts.find(function (o) { return o.value === selectTunnel.value; }) || opts[0];
      trigger.textContent = cur ? cur.textContent : '找不到設備';
      trigger.classList.toggle('disabled', selectTunnel.disabled);
      menu.innerHTML = '';
      opts.forEach(function (o) {
        const item = document.createElement('div');
        item.className = 'custom-select-item' + (o.value === selectTunnel.value ? ' selected' : '');
        item.textContent = o.textContent;
        item.addEventListener('click', function () {
          selectTunnel.value = o.value;
          selectTunnel.dispatchEvent(new Event('change'));
          menu.classList.remove('open');
          sync();
        });
        menu.appendChild(item);
      });
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (selectTunnel.disabled) return;
      sync();
      const willOpen = !menu.classList.contains('open');
      if (willOpen) {
        const rect = trigger.getBoundingClientRect();
        menu.style.top = rect.bottom + 4 + 'px';
        menu.style.left = rect.left + 'px';
        menu.style.minWidth = rect.width + 'px';
      }
      menu.classList.toggle('open', willOpen);
    });
    document.addEventListener('click', function () { menu.classList.remove('open'); });
    window.addEventListener('resize', function () { menu.classList.remove('open'); });

    new MutationObserver(sync).observe(selectTunnel, {
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'class'],
    });
    selectTunnel.addEventListener('change', sync);
    sync();
  }());
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

  const speedWarning = document.getElementById('speedWarning');
  function updateSpeedHint() {
    const s = parseFloat(inputSpeed.value);
    if (Number.isFinite(s) && s >= 0) {
      const mps = (s * 1000) / 3600;
      speedHint.setAttribute('data-tooltip', '約 ' + mps.toFixed(1) + ' m/s (每秒移動距離)');
      speedWarning.style.display = s > 18 ? '' : 'none';
    }
  }
  inputSpeed.addEventListener('input', updateSpeedHint);
  inputSpeed.addEventListener('change', updateSpeedHint);
  inputDir.addEventListener('change', function () {
    if (!routeActive) return;
    const v = parseFloat(inputDir.value);
    routeDir = Number.isFinite(v) ? v : 90;
    restartRouteFrom(currentLat, currentLng);
  });
  (function initCompassDisc() {
    const svg = document.getElementById('compassSvg');
    const hoverLine = document.getElementById('compassHoverLine');
    const confirmedLine = document.getElementById('compassConfirmedLine');
    const confirmedArrow = document.getElementById('compassConfirmedArrow');
    let confirmedBearing = parseFloat(inputDir.value) || 90;

    function toRad(deg) { return (deg * Math.PI) / 180; }
    function svgPt(bearing, r) {
      return { x: 50 + r * Math.sin(toRad(bearing)), y: 50 - r * Math.cos(toRad(bearing)) };
    }

    // Draw tick marks and cardinal labels
    for (let a = 0; a < 360; a += 30) {
      const isCardinal = a % 90 === 0;
      const p1 = svgPt(a, isCardinal ? 40 : 43);
      const p2 = svgPt(a, 46.5);
      const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', p1.x.toFixed(2)); tick.setAttribute('y1', p1.y.toFixed(2));
      tick.setAttribute('x2', p2.x.toFixed(2)); tick.setAttribute('y2', p2.y.toFixed(2));
      tick.setAttribute('stroke', isCardinal ? '#71717a' : '#52525b');
      tick.setAttribute('stroke-width', isCardinal ? '1.5' : '1');
      svg.insertBefore(tick, hoverLine);
    }
    [{ a: 0, t: '北' }, { a: 90, t: '東' }, { a: 180, t: '南' }, { a: 270, t: '西' }].forEach(function (c) {
      const pos = svgPt(c.a, 34);
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      el.setAttribute('x', pos.x.toFixed(2)); el.setAttribute('y', pos.y.toFixed(2));
      el.setAttribute('text-anchor', 'middle'); el.setAttribute('dominant-baseline', 'middle');
      el.setAttribute('class', 'compass-cardinal-text');
      el.setAttribute('font-size', '7');
      el.textContent = c.t;
      svg.insertBefore(el, hoverLine);
    });

    function setConfirmed(bearing) {
      const lineEnd = svgPt(bearing, 43.5);
      const arrowPos = svgPt(bearing, 44);
      confirmedLine.setAttribute('x2', lineEnd.x.toFixed(2)); confirmedLine.setAttribute('y2', lineEnd.y.toFixed(2));
      confirmedArrow.setAttribute('transform', 'translate(' + arrowPos.x.toFixed(2) + ' ' + arrowPos.y.toFixed(2) + ') rotate(' + bearing.toFixed(1) + ')');
    }
    setConfirmed(confirmedBearing);

    function getBearing(e) {
      const rect = svg.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    }
    function nearCenter(e) {
      const rect = svg.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      return Math.sqrt(dx * dx + dy * dy) * (100 / rect.width) < 15;
    }
    function clearPreview() {
      hoverLine.setAttribute('opacity', '0');
      if (dirPreviewLine) { map.removeLayer(dirPreviewLine); dirPreviewLine = null; }
    }
    function showMapPreview(bearing) {
      if (dirPreviewLine) { map.removeLayer(dirPreviewLine); dirPreviewLine = null; }
      // 長度取「目前位置到可視範圍最遠角落」的距離再放大，確保虛線延伸出螢幕
      const b = map.getBounds();
      const origin = L.latLng(currentLat, currentLng);
      const lengthM = Math.max(
        origin.distanceTo(b.getNorthWest()),
        origin.distanceTo(b.getNorthEast()),
        origin.distanceTo(b.getSouthWest()),
        origin.distanceTo(b.getSouthEast())
      ) * 1.2;
      const latRad = (currentLat * Math.PI) / 180;
      const rad = toRad(bearing);
      const endLat = currentLat + (lengthM * Math.cos(rad)) / 111320;
      const endLng = currentLng + (lengthM * Math.sin(rad)) / (111320 * Math.cos(latRad));
      dirPreviewLine = L.polyline(
        [[currentLat, currentLng], [endLat, endLng]],
        { color: '#FD4C04', dashArray: '8,6', weight: 2, opacity: 0.7 }
      ).addTo(map);
    }

    const container = svg.parentElement;
    container.style.cursor = 'pointer';
    container.addEventListener('mousemove', function (e) {
      if (nearCenter(e)) { container.style.cursor = 'default'; clearPreview(); return; }
      container.style.cursor = 'pointer';
      const bearing = getBearing(e);
      const p = svgPt(bearing, 44);
      hoverLine.setAttribute('x2', p.x.toFixed(2)); hoverLine.setAttribute('y2', p.y.toFixed(2));
      hoverLine.setAttribute('opacity', '1');
      showMapPreview(bearing);
    });
    container.addEventListener('mouseleave', function () { container.style.cursor = 'pointer'; clearPreview(); });
    container.addEventListener('click', function (e) {
      if (nearCenter(e)) return;
      confirmedBearing = Math.round(getBearing(e));
      clearPreview();
      inputDir.value = confirmedBearing;
      setConfirmed(confirmedBearing);
      inputDir.dispatchEvent(new Event('change'));
    });
  }());

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

  function attachTooltip(el) {
    el.addEventListener('mouseenter', function () {
      var rect = el.getBoundingClientRect();
      appTooltip.textContent = el.getAttribute('data-tooltip');
      appTooltip.style.display = 'block';
      appTooltip.style.opacity = '0';
      var tw = appTooltip.offsetWidth;
      var th = appTooltip.offsetHeight;
      var pos = el.getAttribute('data-tooltip-position');
      if (pos === 'right') {
        appTooltip.style.left = (rect.right + 8) + 'px';
        appTooltip.style.top = (rect.top + (rect.height - th) / 2) + 'px';
      } else if (pos === 'bottom') {
        appTooltip.style.left = (rect.left + (rect.width - tw) / 2) + 'px';
        appTooltip.style.top = (rect.bottom + 6) + 'px';
      } else if (pos === 'left') {
        appTooltip.style.left = (rect.left - tw - 8) + 'px';
        appTooltip.style.top = (rect.top + (rect.height - th) / 2) + 'px';
      } else {
        appTooltip.style.left = rect.left + 'px';
        appTooltip.style.top = (rect.top - th - 6) + 'px';
      }
      appTooltip.style.opacity = '1';
    });
    el.addEventListener('mouseleave', hideSidebarTooltip);
  }
  document.querySelectorAll('.btn-icon[data-tooltip], .info-icon[data-tooltip], .map-ctrl-btn[data-tooltip]').forEach(attachTooltip);

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
    // ── 亞洲 ──
    { name: '台灣', flag: '🇹🇼', cities: [
      { sub: '台北', tz: 'Asia/Taipei', lat: 25.0478, lng: 121.5170 },
      { sub: '台中', tz: 'Asia/Taipei', lat: 24.1376, lng: 120.6857 },
      { sub: '高雄', tz: 'Asia/Taipei', lat: 22.6386, lng: 120.3026 },
    ]},
    { name: '日本', flag: '🇯🇵', cities: [
      { sub: '小樽',   tz: 'Asia/Tokyo', lat: 43.1907,               lng: 140.9947            },
      { sub: '東京',   tz: 'Asia/Tokyo', lat: 35.671928772634885,   lng: 139.70381947282382  },
      { sub: '鳥取',   tz: 'Asia/Tokyo', lat: 35.481417,            lng: 133.829827          },
      { sub: '名古屋', tz: 'Asia/Tokyo', lat: 35.180052,  lng: 136.900592  },
      { sub: '京都',   tz: 'Asia/Tokyo', lat: 35.0116,    lng: 135.7681    },
      { sub: '大阪',   tz: 'Asia/Tokyo', lat: 34.6937,    lng: 135.5023    },
      { sub: '福岡',   tz: 'Asia/Tokyo', lat: 33.5903,    lng: 130.4017    },
      { sub: '熊本',   tz: 'Asia/Tokyo', lat: 32.830917,  lng: 130.753556  },
    ]},
    { name: '香港', flag: '🇭🇰', cities: [
      { sub: '香港', tz: 'Asia/Hong_Kong', lat: 22.3193, lng: 114.1694 },
    ]},
    { name: '新加坡', flag: '🇸🇬', cities: [
      { sub: '新加坡', tz: 'Asia/Singapore', lat: 1.3306438832092644, lng: 103.83941477787349 },
    ]},
    { name: '泰國', flag: '🇹🇭', cities: [
      { sub: '清邁', tz: 'Asia/Bangkok', lat: 18.7883, lng:  98.9853 },
      { sub: '曼谷', tz: 'Asia/Bangkok', lat: 13.7563, lng: 100.5018 },
    ]},
    // ── 歐洲 ──
    { name: '義大利', flag: '🇮🇹', cities: [
      { sub: '米蘭',     tz: 'Europe/Rome', lat: 45.4642, lng:  9.1900 },
      { sub: '威尼斯',   tz: 'Europe/Rome', lat: 45.4408, lng: 12.3155 },
      { sub: '佛羅倫斯', tz: 'Europe/Rome', lat: 43.7696, lng: 11.2558 },
      { sub: '羅馬',     tz: 'Europe/Rome', lat: 41.9028, lng: 12.4964 },
      { sub: '那不勒斯', tz: 'Europe/Rome', lat: 40.8518, lng: 14.2681 },
    ]},
    // ── 美洲 ──
    { name: '美國', flag: '🇺🇸', cities: [
      { sub: '艾德蒙茲', tz: 'America/Los_Angeles', lat: 47.781472, lng: -122.384167 },
      { sub: '科克蘭', tz: 'America/Los_Angeles', lat: 47.684417, lng: -122.251250 },
      { sub: '喬治城 🍄', tz: 'America/Los_Angeles', lat: 47.545861, lng: -122.327139 },
      { sub: '南公園 🍄', tz: 'America/Los_Angeles', lat: 47.524833, lng: -122.342611 },
      { sub: '西雅圖', tz: 'America/Los_Angeles', lat: 47.520222, lng: -122.357889 },
      { sub: '紐約',   tz: 'America/New_York',    lat: 40.720638, lng: -74.000816 },
      { sub: '舊金山', tz: 'America/Los_Angeles', lat: 37.7749, lng: -122.4194 },
    ]},
    // ── 大洋洲 ──
    { name: '澳洲', flag: '🇦🇺', cities: [
      { sub: '布里斯本北', tz: 'Australia/Brisbane', lat: -27.352472, lng: 152.990750 },
      { sub: '布里斯本', tz: 'Australia/Brisbane', lat: -27.447944, lng: 152.975056 },
      { sub: '坎培拉',   tz: 'Australia/Sydney',   lat: -35.303300, lng: 149.096300 },
    ]},
    { name: '紐西蘭', flag: '🇳🇿', cities: [
      { sub: '奧克蘭', tz: 'Pacific/Auckland', lat: -36.848500, lng: 174.763300 },
      { sub: '威靈頓', tz: 'Pacific/Auckland', lat: -41.2865, lng: 174.7762 },
      { sub: '基督城', tz: 'Pacific/Auckland', lat: -43.5321, lng: 172.6362 },
    ]},
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

  const SUN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="7.05" y2="7.05"/><line x1="16.95" y1="16.95" x2="19.07" y2="19.07"/><line x1="19.07" y1="4.93" x2="16.95" y2="7.05"/><line x1="7.05" y1="16.95" x2="4.93" y2="19.07"/></svg>';
  const MOON_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function renderTime(tz) {
    const h = parseInt(new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', hour12: false }), 10);
    const icon = (h >= 5 && h < 18) ? SUN_ICON : MOON_ICON;
    return icon + fmtTime(tz);
  }

  const TZ_ZH = {
    'Asia/Taipei':          { name: '台灣',     sub: '台北',   flag: '🇹🇼' },
    'Asia/Tokyo':           { name: '日本',     sub: '東京',   flag: '🇯🇵' },
    'Asia/Shanghai':        { name: '中國',     sub: '上海',   flag: '🇨🇳' },
    'Asia/Hong_Kong':       { name: '香港',     sub: null,     flag: '🇭🇰' },
    'Asia/Macau':           { name: '澳門',     sub: null,     flag: '🇲🇴' },
    'Asia/Seoul':           { name: '韓國',     sub: '首爾',   flag: '🇰🇷' },
    'Asia/Singapore':       { name: '新加坡',   sub: null,     flag: '🇸🇬' },
    'Asia/Bangkok':         { name: '泰國',     sub: '曼谷',   flag: '🇹🇭' },
    'Asia/Kuala_Lumpur':    { name: '馬來西亞', sub: '吉隆坡', flag: '🇲🇾' },
    'Asia/Jakarta':         { name: '印尼',     sub: '雅加達', flag: '🇮🇩' },
    'Asia/Manila':          { name: '菲律賓',   sub: '馬尼拉', flag: '🇵🇭' },
    'Asia/Kolkata':         { name: '印度',     sub: '孟買',   flag: '🇮🇳' },
    'Asia/Dubai':           { name: '阿聯酋',   sub: '杜拜',   flag: '🇦🇪' },
    'America/New_York':     { name: '美國',     sub: '紐約',   flag: '🇺🇸' },
    'America/Los_Angeles':  { name: '美國',     sub: '洛杉磯', flag: '🇺🇸' },
    'America/Chicago':      { name: '美國',     sub: '芝加哥', flag: '🇺🇸' },
    'America/Denver':       { name: '美國',     sub: '丹佛',   flag: '🇺🇸' },
    'America/Asuncion':     { name: '巴拉圭',   sub: '亞松森', flag: '🇵🇾' },
    'America/Sao_Paulo':    { name: '巴西',     sub: '聖保羅', flag: '🇧🇷' },
    'Europe/London':        { name: '英國',     sub: '倫敦',   flag: '🇬🇧' },
    'Europe/Paris':         { name: '法國',     sub: '巴黎',   flag: '🇫🇷' },
    'Europe/Berlin':        { name: '德國',     sub: '柏林',   flag: '🇩🇪' },
    'Europe/Rome':          { name: '義大利',   sub: '羅馬',   flag: '🇮🇹' },
    'Europe/Madrid':        { name: '西班牙',   sub: '馬德里', flag: '🇪🇸' },
    'Australia/Sydney':     { name: '澳洲',     sub: '雪梨',   flag: '🇦🇺' },
    'Pacific/Auckland':     { name: '紐西蘭',   sub: '奧克蘭', flag: '🇳🇿' },
  };

  var CHEVRON_SVG = '<svg class="country-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  function buildCountryPanel() {
    countryPanel.innerHTML = '';
    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const userOffMin = getUtcOffsetMin(userTz);

    const tzZh = TZ_ZH[userTz];
    const tzParts = userTz.split('/');
    const userCountryName = tzZh ? tzZh.name : tzParts[tzParts.length - 1].replace(/_/g, ' ');
    const userCityName    = tzZh ? tzZh.sub  : userTz;
    const userFlag        = tzZh ? tzZh.flag : '';

    const groups = COUNTRIES.map(function (c) {
      return { name: c.name, flag: c.flag, cities: c.cities, isUser: false, isCurrent: false };
    });

    const matchIdx = COUNTRIES.findIndex(function (c) {
      return c.cities.some(function (city) { return city.tz === userTz; });
    });
    if (matchIdx >= 0) {
      groups[matchIdx].isCurrent = true;
    } else {
      groups.push({
        name: userCountryName, flag: userFlag,
        cities: [{ sub: userCityName, tz: userTz, lat: null, lng: null }],
        isUser: true, isCurrent: true,
      });
    }

    groups.sort(function (a, b) {
      return getUtcOffsetMin(a.cities[0].tz) - getUtcOffsetMin(b.cities[0].tz);
    });

    const list = document.createElement('div');
    list.className = 'country-list';

    groups.forEach(function (g) {
      const repTz   = g.cities[0].tz;
      const multiCity = !g.isUser && g.cities.length > 1;
      const repDiff = (!g.isUser && !g.isCurrent) ? formatDiff(getUtcOffsetMin(repTz) - userOffMin) : null;

      const group = document.createElement('div');
      group.className = 'country-group' + (g.isCurrent ? ' current' : '') + (!g.isUser ? ' interactive' : '') + (!multiCity && !g.isUser ? ' single-city' : '');

      const header = document.createElement('div');
      header.className = 'country-group-header';

      header.innerHTML =
        '<span class="country-group-left">' +
          (g.flag ? '<span class="country-flag">' + g.flag + '</span>' : '') +
          '<span class="country-group-name">' + g.name + '</span>' +
        '</span>' +
        '<span class="country-group-right">' +
          '<span class="country-time" data-tz="' + repTz + '">' + renderTime(repTz) + '</span>' +
          (g.isCurrent
            ? '<span class="country-group-badge">現在</span>' + (multiCity ? CHEVRON_SVG : '')
            : '<span class="country-group-diff">(' + repDiff + ')</span>' + (multiCity ? CHEVRON_SVG : '')) +
        '</span>';
      group.appendChild(header);

      if (multiCity) {
        const citiesEl = document.createElement('div');
        citiesEl.className = 'country-cities';
        g.cities.forEach(function (city) {
          const cityDiff = formatDiff(getUtcOffsetMin(city.tz) - userOffMin);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'country-city-btn';
          btn.dataset.lat = String(city.lat);
          btn.dataset.lng = String(city.lng);
          btn.innerHTML =
            '<span class="country-city-name">' + city.sub + '</span>' +
            '<span class="country-group-right">' +
              '<span class="country-time" data-tz="' + city.tz + '">' + renderTime(city.tz) + '</span>' +
              '<span class="country-group-diff">(' + cityDiff + ')</span>' +
            '</span>';
          citiesEl.appendChild(btn);
        });
        group.appendChild(citiesEl);

        header.addEventListener('click', function () {
          const isOpen = group.classList.contains('open');
          const currentOpen = list.querySelector('.country-group.open');
          if (currentOpen) currentOpen.classList.remove('open');
          if (!isOpen) {
            const delay = currentOpen ? 250 : 0;
            setTimeout(function () { group.classList.add('open'); }, delay);
          }
        });
      } else if (!g.isUser) {
        const city = g.cities[0];
        header.dataset.lat = String(city.lat);
        header.dataset.lng = String(city.lng);
        header.style.cursor = 'pointer';
      }

      list.appendChild(group);
    });

    list.addEventListener('click', function (e) {
      const target = e.target.closest('.country-city-btn, .country-group-header[data-lat]');
      if (!target) return;
      const lat = parseFloat(target.dataset.lat);
      const lng = parseFloat(target.dataset.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      updateMarker(lat, lng);
      map.setView([lat, lng], 18);
      setLocation(lat, lng);
    });

    countryPanel.appendChild(list);
  }

  function tickCountryTimes() {
    countryPanel.querySelectorAll('.country-time[data-tz]').forEach(function (el) {
      el.innerHTML = renderTime(el.dataset.tz);
    });
  }

  buildCountryPanel();
  setInterval(tickCountryTimes, 60000);

  // ── 地圖控制按鈕 ──────────────────────────────────────────────────────────
  document.getElementById('btnZoomIn').addEventListener('click', function () { map.zoomIn(); });
  document.getElementById('btnZoomOut').addEventListener('click', function () { map.zoomOut(); });
  document.getElementById('btnLocate').addEventListener('click', function () {
    if (!navigator.geolocation) {
      alert('你的瀏覽器不支援定位功能');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) { applyGeolocationPosition(pos); },
      function (err) {
        if (err.code === 1) {
          alert('定位權限被拒絕，請在瀏覽器設定中允許「皮皮探險器」存取位置。');
        }
      },
      GEO_OPTIONS
    );
  });

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

  // ── 美明信片 ──────────────────────────────────────────────────────────────
  var postcardLightbox = document.getElementById('postcardLightbox');
  var postcardLightboxImg = document.getElementById('postcardLightboxImg');
  var postcardLightboxGoto = document.getElementById('postcardLightboxGoto');
  var lightboxLat = null, lightboxLng = null;

  document.querySelectorAll('.postcard-card').forEach(function (card) {
    card.addEventListener('click', function () {
      setLocation(parseFloat(card.dataset.lat), parseFloat(card.dataset.lng));
    });
    card.querySelector('.postcard-zoom-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      postcardLightboxImg.src = card.querySelector('.postcard-img').src;
      lightboxLat = parseFloat(card.dataset.lat);
      lightboxLng = parseFloat(card.dataset.lng);
      postcardLightbox.classList.add('active');
    });
  });
  postcardLightbox.addEventListener('click', function () {
    postcardLightbox.classList.remove('active');
  });
  postcardLightboxGoto.addEventListener('click', function (e) {
    e.stopPropagation();
    postcardLightbox.classList.remove('active');
    setLocation(lightboxLat, lightboxLng);
  });

  document.querySelectorAll('.postcard-filter').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.postcard-filter').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var filter = btn.dataset.filter;
      document.querySelectorAll('.postcard-card').forEach(function (card) {
        var name = card.dataset.name || '';
        card.style.display = (filter === 'all' || name.startsWith(filter)) ? '' : 'none';
      });
    });
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
