// ================================================
// COVERAGE VISUALIZATION - 3GPP TR 38.901
// v5: Multi-site + Organic Shape + Gap Detector
// BW: 30 MHz | Noise: -99.2 dBm
// Blank Spot: RSRP < -120 dBm | Weak: -120 ~ -105 dBm
// ================================================

// Global Variables
let map;
let siteLayer, sectorLayer;
let buildingLayer = null;
let buildingsVisible = false;
let siteIndex = {};
let selectedSite = null;
let coverageLayer = null;
let gapLayer = null;
let gapVisible = true;
let currentCoverageType = 'rsrp';

const SESSION_KEY = 'siteIndexData';
const GAP_PLANNING_KEY = 'gapPlanningData';
const PLANNING_PAGE = '/newsite';

const SECTOR_COLORS = [
  '#ff2d55', '#00c7be', '#ffcc00', '#af52de', '#ff9500', '#34c759'
];

const SITE_BORDER_COLORS = [
  '#ffffff', '#ff6b6b', '#4ecdc4', '#ffe66d', '#a29bfe', '#fd79a8', '#00b894',
];

// ================================================
// CALIBRATION CONSTANTS
// ================================================
const CAL = {
  TX_POWER: 46,
  FREQUENCY: 2300,
  MOBILE_H: 1.5,
  SHADOW_STD: 5.0,
  ANTENNA_Am: 25,
  BEAMWIDTH: 65,

  NOISE_FLOOR_DBM: -99.2,

  SINR_FLOOR: -10,
  SINR_CEIL: 30,

  CLUTTER_REF_M: 100,
  CLUTTER_COEF: 3.5,

  SHADOW_STD_MAP: {
    uma_los: 4.0, uma_nlos: 6.0,
    umi_los: 4.0, umi_nlos: 7.82,
    rma_los: 4.0, rma_nlos: 8.0,
  },

  MAX_NEIGHBOURS: 6,

  // Organic shape
  AZIMUTH_WAVES: 7,
  AZIMUTH_AMP: 0.28,
  CORR_LENGTH_M: 120,
  NOISE_OCTAVES: 4,

  // Gap detector
  GAP_RSRP_THRESHOLD_WEAK: -105,   // weak coverage: -120 ~ -105 dBm
  GAP_RSRP_THRESHOLD_BLANK: -120,  // blank spot: < -120 dBm
  GAP_MIN_CLUSTER_PX: 3,
  GAP_CLUSTER_DIST_M: 80,
};

// ================================================
// PATH LOSS — 3GPP TR 38.901
// ================================================
function pathLoss(scenario, condition, dist_m, freq_mhz, hBS, hUT) {
  const d = Math.max(dist_m, 10);
  const f = freq_mhz / 1000;
  const hUT_ = hUT || CAL.MOBILE_H;
  switch (scenario) {
    case 'uma': {
      const pl_los = 28.0 + 22 * Math.log10(d) + 20 * Math.log10(f);
      const pl_nlos = 13.54 + 39.08 * Math.log10(d) + 20 * Math.log10(f) - 0.6 * (hUT_ - 1.5);
      if (condition === 'los') return pl_los;
      if (condition === 'nlos') return Math.max(pl_nlos, pl_los);
      if (condition === 'los_nlos') {
        const p = Math.exp(-d / 200);
        return p * pl_los + (1 - p) * Math.max(pl_nlos, pl_los);
      }
      return Math.max(pl_nlos, pl_los);
    }
    case 'umi': {
      const pl_los = 32.4 + 21 * Math.log10(d) + 20 * Math.log10(f);
      const pl_nlos = 22.4 + 35.3 * Math.log10(d) + 21.3 * Math.log10(f) - 0.3 * (hUT_ - 1.5);
      if (condition === 'los') return pl_los;
      if (condition === 'nlos') return Math.max(pl_nlos, pl_los);
      if (condition === 'los_nlos') {
        const p = Math.exp(-d / 100);
        return p * pl_los + (1 - p) * Math.max(pl_nlos, pl_los);
      }
      return Math.max(pl_nlos, pl_los);
    }
    case 'rma': {
      const h = 5, W = 20;
      const d_BP = 2 * Math.PI * hBS * hUT_ * (freq_mhz * 1e6) / 3e8;
      let pl_los;
      if (d <= d_BP) {
        pl_los = 20 * Math.log10(40 * Math.PI * d * f / 3)
          + Math.min(0.03 * Math.pow(h, 1.72), 10) * Math.log10(d)
          - Math.min(0.044 * Math.pow(h, 1.72), 14.77)
          + 0.002 * Math.log10(h) * d;
      } else {
        pl_los = 20 * Math.log10(40 * Math.PI * d_BP * f / 3)
          + Math.min(0.03 * Math.pow(h, 1.72), 10) * Math.log10(d_BP)
          - Math.min(0.044 * Math.pow(h, 1.72), 14.77)
          + 0.002 * Math.log10(h) * d_BP
          + 40 * Math.log10(d / d_BP);
      }
      if (condition === 'los') return pl_los;
      const pl_nlos = 161.04 - 7.1 * Math.log10(W) + 7.5 * Math.log10(h)
        - (24.37 - 3.7 * Math.pow(h / hBS, 2)) * Math.log10(hBS)
        + (43.42 - 3.1 * Math.log10(hBS)) * (Math.log10(d) - 3)
        + 20 * Math.log10(f)
        - (3.2 * Math.pow(Math.log10(11.75 * hUT_), 2) - 4.97);
      return Math.max(pl_nlos, pl_los);
    }
    default:
      return 28.0 + 22 * Math.log10(d) + 20 * Math.log10(f);
  }
}

// ================================================
// ORGANIC SHAPE ENGINE
// ================================================
function smoothHash(x, y, seed) {
  seed = seed || 0;
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.3) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise2D(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return smoothHash(ix, iy, seed) * (1 - ux) * (1 - uy)
    + smoothHash(ix + 1, iy, seed) * ux * (1 - uy)
    + smoothHash(ix, iy + 1, seed) * (1 - ux) * uy
    + smoothHash(ix + 1, iy + 1, seed) * ux * uy;
}

function fractalNoise2D(x, y, octaves, seed) {
  let value = 0, amplitude = 0.5, frequency = 1.0, maxVal = 0;
  for (let o = 0; o < octaves; o++) {
    value += amplitude * (smoothNoise2D(x * frequency, y * frequency, seed + o * 31) - 0.5);
    maxVal += amplitude;
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return value / maxVal;
}

function azimuthRadiusFactor(bearingDeg, siteId) {
  let seed = 0;
  for (let i = 0; i < siteId.length; i++)
    seed = (seed * 31 + siteId.charCodeAt(i)) & 0x7fffffff;
  seed = seed / 0x7fffffff;
  const ang = bearingDeg * Math.PI / 180;
  let factor = 0;
  for (let k = 1; k <= CAL.AZIMUTH_WAVES; k++) {
    const phase = smoothHash(k, seed, k * 7.3) * 2 * Math.PI;
    const amp = (1 / k) * smoothHash(seed, k, seed * 3.7);
    factor += amp * Math.sin(k * ang + phase);
  }
  factor = (factor / CAL.AZIMUTH_WAVES) * 2 * CAL.AZIMUTH_AMP;
  return 1.0 + Math.max(-CAL.AZIMUTH_AMP, Math.min(CAL.AZIMUTH_AMP, factor));
}

function spatialShadowOffset(lat, lon, siteId, shadowStd) {
  const scale = 111320 / CAL.CORR_LENGTH_M;
  let seed = 0;
  for (let i = 0; i < siteId.length; i++)
    seed = (seed * 17 + siteId.charCodeAt(i)) & 0xffff;
  return fractalNoise2D(lat * scale, lon * scale, CAL.NOISE_OCTAVES, seed) * shadowStd * 3.0;
}

function getEdgeSurvivalProb(distFromSite, radius, bearingDeg, siteId) {
  const effectiveRad = radius * azimuthRadiusFactor(bearingDeg, siteId);
  const edgeRatio = distFromSite / effectiveRad;
  if (edgeRatio <= 0.75) return 1.0;
  if (edgeRatio > 1.15) return 0.0;
  const t = (edgeRatio - 0.75) / 0.40;
  return 1.0 - t * t * (3 - 2 * t);
}

// ================================================
// RSRP & SINR
// ================================================
function computeRSRP(dist, bearingDeg, antennaHeight, gainDb, scenario, condition, lat, lon, siteId) {
  const pl = pathLoss(scenario, condition, Math.max(dist, 10), CAL.FREQUENCY, antennaHeight, CAL.MOBILE_H);
  const clutterLoss = dist > CAL.CLUTTER_REF_M ? CAL.CLUTTER_COEF * Math.log10(dist / CAL.CLUTTER_REF_M) : 0;
  const shadowKey = `${scenario}_${condition === 'los_nlos' ? 'nlos' : condition}`;
  const shadowStd = CAL.SHADOW_STD_MAP[shadowKey] || CAL.SHADOW_STD;
  const shadow = spatialShadowOffset(lat, lon, siteId, shadowStd);
  const azFactor = azimuthRadiusFactor(bearingDeg, siteId);
  const azGainDb = 10 * Math.log10(azFactor);
  return CAL.TX_POWER + gainDb + azGainDb - pl - clutterLoss + shadow;
}

function computeSINR_proper(rsrp_serving, interferer_rsrps) {
  const sigLin = Math.pow(10, rsrp_serving / 10);
  const noiseLin = Math.pow(10, CAL.NOISE_FLOOR_DBM / 10);
  const ICIC = 0.6;
  let intLin = 0;
  interferer_rsrps.forEach(r => { intLin += Math.pow(10, r / 10) * ICIC; });
  return Math.max(CAL.SINR_FLOOR, Math.min(CAL.SINR_CEIL, 10 * Math.log10(sigLin / (intLin + noiseLin))));
}

// ================================================
// COLOR & CATEGORY
// ================================================
function getRSRPColor(v) {
  if (v >= -85) return '#0042a5';
  if (v >= -95) return '#00a955';
  if (v >= -105) return '#70ff66';
  if (v >= -120) return '#fffb00';
  if (v >= -140) return '#ff3333';
  return '#800000';
}
function getSINRColor(v) {
  if (v >= 20) return '#0042a5';
  if (v >= 10) return '#00a955';
  if (v >= 0) return '#70ff66';
  if (v >= -5) return '#fffb00';
  if (v >= -40) return '#ff3333';
  return '#800000';
}
function getRSRPCategory(v) {
  if (v >= -85) return 'S1';
  if (v >= -95) return 'S2';
  if (v >= -105) return 'S3';
  if (v >= -120) return 'S4';
  if (v >= -140) return 'S5';
  return 'S6';
}
function getSINRCategory(v) {
  if (v >= 20) return 'S1';
  if (v >= 10) return 'S2';
  if (v >= 0) return 'S3';
  if (v >= -5) return 'S4';
  if (v >= -40) return 'S5';
  return 'S6';
}
function getCategoryName(c) {
  return { S1: 'Excellent', S2: 'Good', S3: 'Moderate', S4: 'Poor', S5: 'Bad', S6: 'Very Bad' }[c] || 'Unknown';
}

// ================================================
// INIT
// ================================================
document.addEventListener('DOMContentLoaded', () => {
  initializeMap();
  attachEventListeners();
  restoreSiteIndex();
});

function initializeMap() {
  map = L.map('coverageMap').setView([-6.2088, 106.8456], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19
  }).addTo(map);
  siteLayer = L.layerGroup().addTo(map);
  sectorLayer = L.layerGroup().addTo(map);
}

// ================================================
// RESTORE SESSION
// ================================================
function restoreSiteIndex() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) { showUploadPrompt(); return; }
  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !Object.keys(parsed).length) { showUploadPrompt(); return; }
    siteIndex = parsed;
    renderSitesOnMap();
    populateSiteSearch();
    setSourceBadge(`✅ ${Object.keys(siteIndex).length} site dari halaman Route`);
    showClearBtn(true);
  } catch { sessionStorage.removeItem(SESSION_KEY); showUploadPrompt(); }
}

function renderSitesOnMap() {
  siteLayer.clearLayers();
  sectorLayer.clearLayers();
  const cg = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60, disableClusteringAtZoom: 15, spiderfyOnMaxZoom: true });
  const bounds = [];
  Object.entries(siteIndex).forEach(([id, s]) => {
    bounds.push([s.lat, s.lng]);
    const m = L.circleMarker([s.lat, s.lng], { radius: 7, fillColor: '#ffd000', color: '#000', weight: 1.5, fillOpacity: 1 });
    m.bindTooltip(id, { permanent: false, direction: 'top', offset: [0, -8], className: 'site-label' });
    const sc = s.scenario || 'uma', co = s.condition || 'nlos';
    m.bindPopup(`<b>SITE: ${id}</b><br>Lat: ${s.lat.toFixed(6)}<br>Lng: ${s.lng.toFixed(6)}<br>Height: ${s.height}m<br>Clutter: <b>${s.clutter || 'N/A'}</b><br>Model: <b>${sc.toUpperCase()} ${co.toUpperCase().replace('_', '/')}</b>`);
    cg.addLayer(m);
  });
  siteLayer.addLayer(cg);
  if (bounds.length) map.fitBounds(bounds);
}

// ================================================
// 1ST TIER NEIGHBOURS
// ================================================
function getNeighbourSites(mainId) {
  const ms = siteIndex[mainId];
  if (!ms) return [];
  return Object.entries(siteIndex)
    .filter(([id]) => id !== mainId)
    .map(([id, s]) => ({ id, site: s, dist: calcDistance({ lat: ms.lat, lng: ms.lng }, { lat: s.lat, lng: s.lng }) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, CAL.MAX_NEIGHBOURS);
}

// ================================================
// UI HELPERS
// ================================================
function setSourceBadge(msg) { const e = document.getElementById('sourceBadge'); if (e) e.textContent = msg; }
function showUploadPrompt() { setSourceBadge('⚠️ Belum ada data — upload XLSX atau kembali ke halaman Route'); showClearBtn(false); }
function showClearBtn(show) { const b = document.getElementById('btnClearSite'); if (b) b.style.display = show ? 'inline-flex' : 'none'; }

// ================================================
// EVENT LISTENERS
// ================================================
function attachEventListeners() {
  document.getElementById('loadShapefileBtn')?.addEventListener('click', () => document.getElementById('shapefileInput').click());
  document.getElementById('shapefileInput')?.addEventListener('change', processXLSX);

  document.getElementById('btnClearSite')?.addEventListener('click', () => {
    if (!confirm('Hapus data site yang tersimpan?')) return;
    sessionStorage.removeItem(SESSION_KEY);
    siteIndex = {};
    siteLayer.clearLayers(); sectorLayer.clearLayers();
    if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer = null; }
    clearGapLayer();
    populateSiteSearch(); showUploadPrompt();
    document.getElementById('mapLegend').style.display = 'none';
    document.getElementById('analysisResult').innerHTML = `<div class="waiting-state"><i class="fas fa-info-circle"></i><p>Pilih site dan tipe coverage untuk melihat analisis</p></div>`;
  });

  document.getElementById('searchSiteBtn')?.addEventListener('click', onSiteSelect);
  document.getElementById('siteSearch')?.addEventListener('keypress', e => { if (e.key === 'Enter') onSiteSelect(); });
  document.getElementById('toggleBuildingBtn')?.addEventListener('click', toggleBuildings);
  document.getElementById('visualizeRSRP')?.addEventListener('click', () => setActiveVisualization('rsrp'));
  document.getElementById('visualizeSINR')?.addEventListener('click', () => setActiveVisualization('sinr'));
  document.getElementById('gridSize')?.addEventListener('change', autoRegenerate);
  document.getElementById('coverageRadius')?.addEventListener('change', autoRegenerate);
  document.getElementById('antennaHeight')?.addEventListener('input', () => { updateHeightBadge(); autoRegenerate(); });
  document.getElementById('toggleGapBtn')?.addEventListener('click', toggleGapLayer);
}

// ================================================
// BUILDING TOGGLE
// ================================================
function toggleBuildings() {
  if (buildingsVisible) {
    if (buildingLayer) map.removeLayer(buildingLayer);
    buildingsVisible = false;
    document.getElementById('buildingBtnText').textContent = 'Show Buildings';
  } else {
    showBuildings();
    buildingsVisible = true;
    document.getElementById('buildingBtnText').textContent = 'Hide Buildings';
  }
}

function showBuildings() {
  if (buildingLayer) map.removeLayer(buildingLayer);
  buildingLayer = L.layerGroup();
  const b = map.getBounds();
  showLoadingWithProgress('Memuat building data...', 0, null);
  fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `[out:json][timeout:25];(way["building"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()});relation["building"](${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}););out geom;`
  }).then(r => r.json()).then(data => {
    data.elements.forEach(el => {
      if (el.type === 'way' && el.geometry) {
        const lvl = parseInt(el.tags?.['building:levels'] || 3);
        L.polygon(el.geometry.map(n => [n.lat, n.lon]), { color: '#888', fillColor: '#ccc', fillOpacity: 0.6, weight: 1 })
          .bindPopup(`<b>Building</b><br>Height: ~${lvl * 3}m`).addTo(buildingLayer);
      }
    });
    buildingLayer.addTo(map);
    hideLoading();
  }).catch(() => { hideLoading(); alert('Error loading building data.'); });
}

function autoRegenerate() { if (selectedSite && siteIndex[selectedSite]) generateCoverage(); }

function updateHeightBadge() {
  const height = parseInt(document.getElementById('antennaHeight').value);
  const badge = document.getElementById('heightBadge');
  const site = selectedSite ? siteIndex[selectedSite] : null;
  if (site?.height) {
    if (Math.abs(height - site.height) < 2) { badge.textContent = 'Default'; badge.style.backgroundColor = '#1F3C88'; }
    else if (height > site.height) { badge.textContent = `+${height - site.height}m`; badge.style.backgroundColor = '#28a745'; }
    else { badge.textContent = `${height - site.height}m`; badge.style.backgroundColor = '#dc3545'; }
  } else { badge.textContent = `${height}m`; badge.style.backgroundColor = '#6c757d'; }
}

// ================================================
// XLSX UPLOAD
// ================================================
async function processXLSX(e) {
  const file = e.target.files[0];
  if (!file) return;
  const est = Math.max(2, Math.round(0.5 + file.size / (1024 * 1024) * 1.5));
  showLoadingWithProgress('Mengunggah dan memproses data site...', 0, est);
  let iv; const t0 = Date.now();
  try {
    let fp = 0;
    iv = setInterval(() => {
      const el = (Date.now() - t0) / 1000;
      fp = Math.min(85, Math.round((el / est) * 85));
      updateLoadingProgress(fp, `Memproses... (~${Math.max(0, est - Math.round(el))}s tersisa)`);
    }, 300);
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch('/api/upload-site', { method: 'POST', body: fd });
    clearInterval(iv); updateLoadingProgress(92, 'Menerima data...');
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || 'Upload gagal');
    updateLoadingProgress(97, 'Menyusun peta...');
    await new Promise(r => setTimeout(r, 150));
    siteIndex = json.siteIndex;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));
    renderSitesOnMap(); populateSiteSearch(); hideLoading();
    setSourceBadge(`✅ ${json.siteCount} site dimuat (${json.filename})`);
    showClearBtn(true);
    alert(`✅ Berhasil load ${json.siteCount} site dalam ${((Date.now() - t0) / 1000).toFixed(1)} detik.`);
  } catch (err) { clearInterval(iv); hideLoading(); alert('❌ Gagal: ' + err.message); }
  e.target.value = '';
}

// ================================================
// SITE SEARCH
// ================================================
function populateSiteSearch() {
  const list = document.getElementById('siteList');
  if (!list) return;
  list.innerHTML = '';
  Object.keys(siteIndex).sort().forEach(id => {
    const o = document.createElement('option');
    o.value = id;
    list.appendChild(o);
  });
}

function onSiteSelect() {
  const id = document.getElementById('siteSearch').value.trim();
  if (!siteIndex[id]) { alert('Site tidak ditemukan.'); return; }
  selectedSite = id;
  const site = siteIndex[id];
  document.getElementById('antennaHeight').value = site.height;
  updateHeightBadge();

  const sc = site.scenario || 'uma', co = site.condition || 'nlos';
  const el = document.getElementById('paramModel'); if (el) el.textContent = `${sc.toUpperCase()} ${co.toUpperCase().replace('_', '/')}`;
  const ec = document.getElementById('paramClutter'); if (ec) ec.textContent = site.clutter || 'N/A';

  sectorLayer.clearLayers();
  if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer = null; }
  clearGapLayer();

  site.sectors.forEach((az, idx) => drawSectorFan(site.lat, site.lng, az, CAL.BEAMWIDTH, 150, idx, true));
  const nb = getNeighbourSites(id);
  nb.forEach((n, ni) => {
    sectorLayer.addLayer(L.circleMarker([n.site.lat, n.site.lng], {
      radius: 6, fillColor: SITE_BORDER_COLORS[ni + 1] || '#aaa', color: '#000', weight: 1.2, fillOpacity: 0.85
    }).bindTooltip(`${n.id} (nb)`, { direction: 'top', offset: [0, -8] }));
    n.site.sectors?.forEach((az, si) => drawSectorFan(n.site.lat, n.site.lng, az, CAL.BEAMWIDTH, 120, si, false));
  });

  updateNeighbourBadge(nb);
  map.setView([site.lat, site.lng], 15);
  generateCoverage();
}

function updateNeighbourBadge(nb) {
  const el = document.getElementById('neighbourBadge');
  if (!el) return;
  el.textContent = `1st Tier: ${nb.length} site`;
  el.style.display = 'inline-block';
}

// ================================================
// SECTOR FAN
// ================================================
function drawSectorFan(lat, lng, az, bw, radius, idx, isMain) {
  const pts = [[lat, lng]];
  for (let i = 0; i <= 16; i++) {
    const ang = (az - bw / 2) + (i / 16) * bw;
    const p = destinationPoint(lat, lng, ang, radius);
    pts.push([p.lat, p.lng]);
  }
  pts.push([lat, lng]);
  const color = SECTOR_COLORS[idx % SECTOR_COLORS.length];
  L.polygon(pts, {
    color, fillColor: color,
    fillOpacity: isMain ? 0.15 : 0.06,
    weight: isMain ? 2 : 1,
    opacity: isMain ? 0.6 : 0.3,
    dashArray: isMain ? null : '4 4'
  }).addTo(sectorLayer).bindPopup(`<b>Sektor ${idx + 1}</b><br>Azimuth: ${az}°`);
}

// ================================================
// GEO UTILITIES
// ================================================
function destinationPoint(lat, lng, az, dist) {
  const R = 6378137, brng = az * Math.PI / 180, d = dist / R;
  const lat1 = lat * Math.PI / 180, lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
}

function calcDistance(a, b) {
  const R = 6378137, lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function bearingTo(lat1, lng1, lat2, lng2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
}

function antennaGainPattern(offset, bw, Am) {
  Am = Am || CAL.ANTENNA_Am;
  return -Math.min(12 * (offset / (bw / 2)) ** 2, Am);
}

function bestSectorGain(brng, sectors, bw) {
  if (!sectors?.length) return { gain: 0, sectorIdx: 0 };
  let best = -Infinity, idx = 0;
  sectors.forEach((az, i) => {
    const g = antennaGainPattern(Math.abs(((brng - az + 540) % 360) - 180), bw);
    if (g > best) { best = g; idx = i; }
  });
  return { gain: best, sectorIdx: idx };
}

// ================================================
// COVERAGE GENERATION
// ================================================
function generateCoverage() {
  if (!selectedSite || !siteIndex[selectedSite]) return;
  showLoadingWithProgress('Menghitung coverage + gap detection...', 0, null);
  const gridSize = parseInt(document.getElementById('gridSize').value);
  const radius = parseInt(document.getElementById('coverageRadius').value);
  const antennaHeight = parseInt(document.getElementById('antennaHeight').value);
  if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer = null; }
  clearGapLayer();

  setTimeout(() => {
    try {
      const mainSite = siteIndex[selectedSite];
      const neighbours = getNeighbourSites(selectedSite);
      const allSites = [
        { id: selectedSite, site: mainSite, isMain: true, siteColorIdx: 0 },
        ...neighbours.map((n, i) => ({ id: n.id, site: n.site, isMain: false, siteColorIdx: i + 1 }))
      ];
      const grids = calculateMultiSiteCoverage(allSites, gridSize, radius, antennaHeight, currentCoverageType);
      displayCoverageGrid(grids, currentCoverageType);

      const gapClusters = detectGaps(grids, allSites, gridSize);
      renderGapLayer(gapClusters, allSites);

      updateStatistics(grids, radius, antennaHeight, allSites, gapClusters);
      hideLoading();
    } catch (err) {
      console.error(err);
      alert('Error saat generate coverage: ' + err.message);
      hideLoading();
    }
  }, 400);
}

// ================================================
// MULTI-SITE COVERAGE CALCULATION
// ================================================
function calculateMultiSiteCoverage(allSites, gridSize, radius, antennaHeight, type) {
  const mainSite = allSites[0].site;
  const mpdLat = 111320;
  const mpdLon = 111320 * Math.cos(mainSite.lat * Math.PI / 180);
  const dLat = gridSize / mpdLat;
  const dLon = gridSize / mpdLon;

  const allLats = allSites.map(s => s.site.lat);
  const allLngs = allSites.map(s => s.site.lng);
  const minLat = Math.min(...allLats) - radius / mpdLat;
  const maxLat = Math.max(...allLats) + radius / mpdLat;
  const minLon = Math.min(...allLngs) - radius / mpdLon;
  const maxLon = Math.max(...allLngs) + radius / mpdLon;
  const grids = [];

  for (let lat = minLat; lat <= maxLat; lat += dLat) {
    for (let lon = minLon; lon <= maxLon; lon += dLon) {
      let coveredByAny = false;
      for (const { id, site } of allSites) {
        const dist = calcDistance({ lat: site.lat, lng: site.lng }, { lat, lng: lon });
        const brng = bearingTo(site.lat, site.lng, lat, lon);
        const survP = getEdgeSurvivalProb(dist, radius, brng, id);
        if (smoothHash(lat * 9973, lon * 9973, id.length * 17) < survP) { coveredByAny = true; break; }
      }
      if (!coveredByAny) continue;

      const siteRSRPs = allSites.map(({ id, site, isMain }) => {
        const dist = calcDistance({ lat: site.lat, lng: site.lng }, { lat, lng: lon });
        if (dist < 1) return { id, rsrp: CAL.TX_POWER, dist, sectorIdx: 0, isMain };
        const sc = site.scenario || 'uma';
        const co = site.condition || 'nlos';
        const brng = bearingTo(site.lat, site.lng, lat, lon);
        let gainDb = 0, sectorIdx = 0;
        if (site.sectors?.length) {
          const b = bestSectorGain(brng, site.sectors, CAL.BEAMWIDTH);
          gainDb = b.gain; sectorIdx = b.sectorIdx;
        }
        return { id, rsrp: computeRSRP(dist, brng, site.height || antennaHeight, gainDb, sc, co, lat, lon, id), dist, sectorIdx, isMain, scenario: sc, condition: co };
      });

      let best = siteRSRPs[0];
      siteRSRPs.forEach(s => { if (s.rsrp > best.rsrp) best = s; });

      const distFromMain = calcDistance({ lat: mainSite.lat, lng: mainSite.lng }, { lat, lng: lon });
      if (distFromMain > radius * 2.2) continue;

      const interfRSRPs = siteRSRPs.filter(s => s.id !== best.id).map(s => s.rsrp);

      let value, color, category;
      if (type === 'rsrp') {
        value = Math.round(best.rsrp * 10) / 10;
        color = getRSRPColor(value);
        category = getRSRPCategory(value);
      } else {
        value = Math.round(computeSINR_proper(best.rsrp, interfRSRPs) * 10) / 10;
        color = getSINRColor(value);
        category = getSINRCategory(value);
      }

      const se = allSites.find(s => s.id === best.id);
      grids.push({
        lat, lon, distFromMain,
        dist: best.dist, value, color, category,
        sectorIdx: best.sectorIdx,
        servingSiteId: best.id,
        isMain: best.isMain,
        siteColorIdx: se ? se.siteColorIdx : 0,
        isVoronoiBorder: siteRSRPs.some(s => s.id !== best.id && Math.abs(s.rsrp - best.rsrp) < 3.0),
        scenario: best.scenario || 'uma',
        condition: best.condition || 'nlos',
        rsrpValue: best.rsrp,
        allRSRPs: siteRSRPs.map(s => ({ id: s.id, rsrp: Math.round(s.rsrp * 10) / 10 })),
        bounds: [[lat, lon], [lat + dLat, lon], [lat + dLat, lon + dLon], [lat, lon + dLon]]
      });
    }
  }
  console.log(`[Coverage v5] ${grids.length} cells | ${allSites.length} sites`);
  return grids;
}

// ================================================
// GAP DETECTOR v6 — Blank Spot + Weak Coverage
// Scope: hanya dalam radius simulasi main site
// Blank spot hanya dihitung jika memang tanggung jawab cluster ini
// ================================================
function detectGaps(grids, allSites, gridSize) {
  // A. Grid-based: filter per kategori RSRP
  // Hanya ambil grid yang memang ada dalam simulasi (in-coverage, tapi sinyal buruk)
  const weakGrids  = grids.filter(g => g.rsrpValue >= CAL.GAP_RSRP_THRESHOLD_BLANK && g.rsrpValue < CAL.GAP_RSRP_THRESHOLD_WEAK);
  const blankGrids = grids.filter(g => g.rsrpValue < CAL.GAP_RSRP_THRESHOLD_BLANK);

  // B. Spatial blank spots — hanya dalam radius simulasi MAIN SITE saja
  // Kunci: scan hanya lingkaran radius dari main site, bukan bounding box gabungan semua site
  const mainSite = allSites[0].site;
  const mpdLat   = 111320;
  const mpdLon   = 111320 * Math.cos(mainSite.lat * Math.PI / 180);
  const radius   = parseInt(document.getElementById('coverageRadius').value);
  const dLat     = gridSize / mpdLat;
  const dLon     = gridSize / mpdLon;

  // Scan area: bounding box dari MAIN SITE saja ± radius
  const scanMinLat = mainSite.lat - radius / mpdLat;
  const scanMaxLat = mainSite.lat + radius / mpdLat;
  const scanMinLon = mainSite.lng - radius / mpdLon;
  const scanMaxLon = mainSite.lng + radius / mpdLon;

  // Build set dari grid yang sudah tercover oleh simulasi
  const coveredSet = new Set(grids.map(g => {
    const latKey = Math.round(g.lat / dLat);
    const lonKey = Math.round(g.lon / dLon);
    return `${latKey},${lonKey}`;
  }));

  // Seluruh site di jaringan (bukan hanya cluster simulasi)
  // dipakai untuk cek apakah titik kosong adalah tanggung jawab cluster ini
  const clusterIds = new Set(allSites.map(s => s.id));
  const allNetworkSites = Object.entries(siteIndex).map(([id, s]) => ({ id, site: s }));

  const spatialBlankGrids = [];
  for (let lat = scanMinLat; lat <= scanMaxLat; lat += dLat) {
    for (let lon = scanMinLon; lon <= scanMaxLon; lon += dLon) {
      // 1. Sudah tercover? skip
      const latKey = Math.round(lat / dLat);
      const lonKey = Math.round(lon / dLon);
      if (coveredSet.has(`${latKey},${lonKey}`)) continue;

      // 2. Harus dalam radius lingkaran main site (bukan hanya kotak)
      const distFromMain = calcDistance(
        { lat: mainSite.lat, lng: mainSite.lng }, { lat, lng: lon }
      );
      if (distFromMain > radius) continue;

      // 3. Cek apakah site terdekat di seluruh jaringan adalah bagian dari cluster ini
      // Jika ada site lain di luar cluster yang lebih dekat → bukan tanggung jawab kita → skip
      let closestId = null, closestDist = Infinity;
      for (const { id, site } of allNetworkSites) {
        const d = calcDistance({ lat: site.lat, lng: site.lng }, { lat, lng: lon });
        if (d < closestDist) { closestDist = d; closestId = id; }
      }
      if (closestId && !clusterIds.has(closestId)) continue;

      spatialBlankGrids.push({
        lat, lon,
        rsrpValue: -999,  // sentinel: no coverage at all
        bounds: [[lat, lon], [lat + dLat, lon], [lat + dLat, lon + dLon], [lat, lon + dLon]]
      });
    }
  }

  // C. Clustering helper
  function clusterGrids(inputGrids) {
    if (!inputGrids.length) return [];
    const clusterDistM = Math.max(CAL.GAP_CLUSTER_DIST_M, gridSize * 1.5);
    const clusters = [], assigned = new Array(inputGrids.length).fill(false);
    for (let i = 0; i < inputGrids.length; i++) {
      if (assigned[i]) continue;
      const cluster = [inputGrids[i]];
      assigned[i] = true;
      for (let j = i + 1; j < inputGrids.length; j++) {
        if (assigned[j]) continue;
        const d = calcDistance(
          { lat: inputGrids[i].lat, lng: inputGrids[i].lon },
          { lat: inputGrids[j].lat, lng: inputGrids[j].lon }
        );
        if (d <= clusterDistM) { cluster.push(inputGrids[j]); assigned[j] = true; }
      }
      clusters.push(cluster);
    }
    return clusters.filter(c => c.length >= CAL.GAP_MIN_CLUSTER_PX);
  }

  // D. Build metadata per cluster
  function buildClusterMeta(cells, type, clusterIdx) {
    const avgLat = cells.reduce((s, c) => s + c.lat, 0) / cells.length;
    const avgLon = cells.reduce((s, c) => s + c.lon, 0) / cells.length;
    const validRSRP = cells.filter(c => c.rsrpValue > -900);
    const avgRSRP = validRSRP.length
      ? validRSRP.reduce((s, c) => s + c.rsrpValue, 0) / validRSRP.length
      : null;
    const minRSRP = validRSRP.length ? Math.min(...validRSRP.map(c => c.rsrpValue)) : null;
    const maxDistFromCentroid = Math.max(
      ...cells.map(c => calcDistance({ lat: avgLat, lng: avgLon }, { lat: c.lat, lng: c.lon }))
    );
    const estimatedRadiusM = Math.max(maxDistFromCentroid + gridSize, gridSize * 2);
    let nearestSite = null, nearestDist = Infinity;
    allSites.forEach(({ id, site }) => {
      const d = calcDistance({ lat: avgLat, lng: avgLon }, { lat: site.lat, lng: site.lng });
      if (d < nearestDist) { nearestDist = d; nearestSite = id; }
    });
    return {
      clusterIdx,
      type,
      cells,
      centroidLat: avgLat,
      centroidLon: avgLon,
      avgRSRP: avgRSRP !== null ? Math.round(avgRSRP * 10) / 10 : null,
      minRSRP: minRSRP !== null ? Math.round(minRSRP * 10) / 10 : null,
      cellCount: cells.length,
      estimatedRadiusM: Math.round(estimatedRadiusM),
      nearestSiteId: nearestSite,
      nearestSiteDist: Math.round(nearestDist),
      areaSqKm: (cells.length * (gridSize / 1000) ** 2).toFixed(3),
    };
  }

  // E. Gabung & cluster
  const allBlankGrids = [...spatialBlankGrids, ...blankGrids];
  const blankClusters = clusterGrids(allBlankGrids).map((c, i) => buildClusterMeta(c, 'blank_spot', i));
  const weakClusters  = clusterGrids(weakGrids).map((c, i) => buildClusterMeta(c, 'weak_coverage', blankClusters.length + i));

  const all = [...blankClusters, ...weakClusters].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'blank_spot' ? -1 : 1;
    return b.cellCount - a.cellCount;
  });

  console.log(`[Gap Detector v5] ${blankClusters.length} blank spot + ${weakClusters.length} weak coverage`);
  return all;
}

// ================================================
// RENDER GAP LAYER
// ================================================
function renderGapLayer(gapClusters, allSites) {
  clearGapLayer();
  if (!gapClusters.length) { updateGapBadge(0, 0); return; }

  gapLayer = L.layerGroup().addTo(map);

  gapClusters.forEach((cluster, idx) => {
    const isBlank = cluster.type === 'blank_spot';
    const mainColor = isBlank ? '#ff3b30' : '#ff9500';

    // A. Convex hull polygon — tipis dan transparan, tidak menghalangi coverage
    const allPoints = [];
    cluster.cells.forEach(c => { c.bounds.forEach(p => allPoints.push(p)); });
    const hull = convexHull(allPoints);
    if (hull.length >= 3) {
      L.polygon(hull, {
        color: mainColor,
        fillColor: mainColor,
        fillOpacity: isBlank ? 0.08 : 0.05,
        weight: isBlank ? 1.5 : 1.2,
        opacity: 0.7,
        dashArray: '5 4',
      }).addTo(gapLayer);
    }

    // B. Marker icon — kecil dan semi-transparan agar tidak menutupi coverage
    const iconSymbol = isBlank ? '🚫' : '⚠️';
    const gapIcon = L.divIcon({
      className: '',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      html: `<div style="
        width:20px;height:20px;
        background:${mainColor};
        border:1.5px solid #fff;
        border-radius:50%;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 1px 4px rgba(0,0,0,0.3);
        font-size:9px;cursor:pointer;
        opacity:0.85;
      ">${iconSymbol}</div>`
    });

    const marker = L.marker([cluster.centroidLat, cluster.centroidLon], { icon: gapIcon }).addTo(gapLayer);

    // C. Popup
    const severity = cluster.cellCount > 20 ? (isBlank ? '🔴 Kritis' : '🟠 Kritis')
                   : cluster.cellCount > 8  ? (isBlank ? '🔴 Sedang' : '🟠 Sedang')
                   : (isBlank ? '🔴 Ringan' : '🟡 Ringan');

    const titleText    = isBlank ? `🚫 Blank Spot #${idx + 1}` : `⚠️ Weak Coverage Area #${idx + 1}`;
    const categoryText = isBlank ? 'No Service Area' : 'Degraded Coverage';
    const impactText   = isBlank ? 'No signal / cannot connect' : 'Low throughput, unstable connection';

    let rsrpRow = '';
    if (cluster.avgRSRP !== null) {
      rsrpRow = `
        <tr><td style="color:#888;padding:2px 0">Avg RSRP</td>
            <td><b style="color:${mainColor}">${cluster.avgRSRP} dBm</b></td></tr>
        <tr><td style="color:#888;padding:2px 0">Min RSRP</td>
            <td><b>${cluster.minRSRP} dBm</b></td></tr>`;
    } else {
      rsrpRow = `<tr><td colspan="2" style="color:#ff6b6b;padding:2px 0"><b>Tidak ada sinyal terdeteksi</b></td></tr>`;
    }

    marker.bindPopup(`
      <div style="font-family:Arial,sans-serif;min-width:240px">
        <div style="background:${mainColor};color:#fff;padding:8px 10px;margin:-14px -14px 10px;border-radius:4px 4px 0 0">
          <b>${titleText}</b>
          <span style="float:right;font-size:0.75rem">${severity}</span>
        </div>
        <table style="font-size:0.82rem;width:100%;border-collapse:collapse">
          ${rsrpRow}
          <tr><td style="color:#888;padding:2px 0">Kategori</td>
              <td><b>${categoryText}</b></td></tr>
          <tr><td style="color:#888;padding:2px 0">Impact</td>
              <td style="color:${mainColor}">${impactText}</td></tr>
          <tr><td style="color:#888;padding:2px 0">Luas Area</td>
              <td><b>${cluster.areaSqKm} km²</b> (${cluster.cellCount} sel)</td></tr>
          <tr><td style="color:#888;padding:2px 0">Est. Radius</td>
              <td><b>~${cluster.estimatedRadiusM} m</b></td></tr>
          <tr><td style="color:#888;padding:2px 0">Site Terdekat</td>
              <td><b style="color:#00c7be">${cluster.nearestSiteId}</b></td></tr>
          <tr><td style="color:#888;padding:2px 0">Jarak ke Site</td>
              <td><b>${cluster.nearestSiteDist} m</b></td></tr>
          <tr><td style="color:#888;padding:2px 0">Koordinat</td>
              <td style="font-size:0.75rem">${cluster.centroidLat.toFixed(5)}, ${cluster.centroidLon.toFixed(5)}</td></tr>
        </table>
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid #333">
          <button onclick="goToPlanning(${cluster.clusterIdx})" style="
            width:100%;padding:8px;
            background:linear-gradient(135deg,#1F3C88,#00c7be);
            color:#fff;border:none;border-radius:6px;
            font-size:0.82rem;font-weight:bold;cursor:pointer;
          ">📍 Rencanakan Site Baru di Sini</button>
        </div>
      </div>
    `, { maxWidth: 290 });
  });

  const blankCount = gapClusters.filter(c => c.type === 'blank_spot').length;
  const weakCount  = gapClusters.filter(c => c.type === 'weak_coverage').length;
  updateGapBadge(blankCount, weakCount);
  window._gapClusters = gapClusters;
  console.log(`[Gap Render] 🚫 ${blankCount} blank spot | ⚠️ ${weakCount} weak coverage`);
}

// ================================================
// REDIRECT KE PLANNING PAGE
// ================================================
function goToPlanning(clusterIdx) {
  const clusters = window._gapClusters;
  if (!clusters || !clusters[clusterIdx]) return;

  const gap  = clusters[clusterIdx];
  const site = siteIndex[gap.nearestSiteId];

  const payload = {
    source: 'coverage_gap_detector',
    timestamp: new Date().toISOString(),
    mainSiteId: selectedSite,
    gapType: gap.type,                         // 'blank_spot' | 'weak_coverage'
    recommendedLat: gap.centroidLat,
    recommendedLng: gap.centroidLon,
    gapIndex: clusterIdx + 1,
    avgRSRP_dBm: gap.avgRSRP,
    minRSRP_dBm: gap.minRSRP,
    estimatedRadius_m: gap.estimatedRadiusM,
    areaSqKm: parseFloat(gap.areaSqKm),
    cellCount: gap.cellCount,
    nearestSiteId: gap.nearestSiteId,
    nearestSiteDist_m: gap.nearestSiteDist,
    nearestSiteLat: site?.lat || null,
    nearestSiteLng: site?.lng || null,
    nearestSiteHeight: site?.height || null,
    nearestSiteClutter: site?.clutter || null,
    severityLabel: gap.cellCount > 20 ? 'Kritis' : gap.cellCount > 8 ? 'Sedang' : 'Ringan',
  };

  sessionStorage.setItem(GAP_PLANNING_KEY, JSON.stringify(payload));
  console.log('[Gap → Planning] Payload saved:', payload);
  window.location.href = PLANNING_PAGE;
}

// ================================================
// GAP LAYER TOGGLE
// ================================================
function toggleGapLayer() {
  if (!gapLayer) return;
  const btn = document.getElementById('toggleGapBtn');
  if (gapVisible) {
    map.removeLayer(gapLayer);
    gapVisible = false;
    if (btn) btn.textContent = '👁 Tampilkan Gap';
  } else {
    gapLayer.addTo(map);
    gapVisible = true;
    if (btn) btn.textContent = '🙈 Sembunyikan Gap';
  }
}

function clearGapLayer() {
  if (gapLayer) { map.removeLayer(gapLayer); gapLayer = null; }
  gapVisible = true;
  window._gapClusters = null;
  updateGapBadge(0, 0);   // FIX: dua argumen
}

function updateGapBadge(blankCount, weakCount) {
  const el = document.getElementById('gapBadge');
  if (!el) return;
  const total = (blankCount || 0) + (weakCount || 0);
  if (total === 0) {
    el.textContent = '✅ Tidak ada gap terdeteksi';
    el.style.background  = '#1a3a1a';
    el.style.color       = '#34c759';
    el.style.borderColor = '#34c759';
  } else {
    el.innerHTML = `🚫 ${blankCount} blank spot &nbsp;|&nbsp; ⚠️ ${weakCount} weak coverage`;
    el.style.background  = '#2a1515';
    el.style.color       = '#ff9500';
    el.style.borderColor = '#ff3b30';
  }
  el.style.display = 'inline-block';
}

// ================================================
// CONVEX HULL — Graham scan
// ================================================
function convexHull(points) {
  if (points.length < 3) return points;
  const pts = points.map(p => ({ x: p[1], y: p[0] }));
  pts.sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper].map(p => [p.y, p.x]);
}

// ================================================
// DISPLAY COVERAGE GRID
// ================================================
function displayCoverageGrid(grids, type) {
  const lg = L.layerGroup();
  const unit = type === 'rsrp' ? 'dBm' : 'dB';
  grids.forEach(grid => {
    const ml = `${grid.scenario.toUpperCase()} ${grid.condition.toUpperCase().replace('_', '/')}`;
    const bCol = grid.isVoronoiBorder ? SITE_BORDER_COLORS[grid.siteColorIdx] : grid.color;
    const bW = grid.isVoronoiBorder ? 1.2 : 0;
    const rows = grid.allRSRPs.sort((a, b) => b.rsrp - a.rsrp).map(s => {
      const sv = s.id === grid.servingSiteId;
      return `<tr style="${sv ? 'font-weight:bold;color:#00c7be' : 'color:#aaa'}"><td>${sv ? '▶' : '&nbsp;'} ${s.id}</td><td>${s.rsrp} dBm</td></tr>`;
    }).join('');
    L.polygon(grid.bounds, { color: bCol, fillColor: grid.color, fillOpacity: 0.72, weight: bW, opacity: bW ? 0.85 : 0 })
      .bindPopup(`
        <div style="font-family:Arial,sans-serif;min-width:200px">
          <h4 style="margin:0 0 6px 0;color:${grid.color}">${type.toUpperCase()}: ${grid.value} ${unit}</h4>
          <p style="margin:3px 0"><b>Category:</b> ${getCategoryName(grid.category)}</p>
          <p style="margin:3px 0"><b>Serving:</b> <span style="color:#00c7be">${grid.servingSiteId}</span>${grid.isMain ? ' <span style="color:#ffd000">(main)</span>' : ' (nb)'}</p>
          <p style="margin:3px 0"><b>Distance:</b> ${Math.round(grid.dist)} m</p>
          <p style="margin:3px 0"><b>Model:</b> ${ml}</p>
          <hr style="border-color:#333;margin:6px 0">
          <table style="font-size:0.78rem;width:100%">${rows}</table>
          ${grid.isVoronoiBorder ? '<p style="margin:4px 0;font-size:0.75rem;color:#ffcc00">⚡ Zona handover</p>' : ''}
        </div>
      `).addTo(lg);
  });
  coverageLayer = lg.addTo(map);
}

// ================================================
// STATISTICS & ANALYSIS
// ================================================
function updateStatistics(grids, radius, antennaHeight, allSites, gapClusters) {
  const gs = parseInt(document.getElementById('gridSize').value);
  const cats = {};
  grids.forEach(g => { cats[g.category] = (cats[g.category] || 0) + 1; });
  const total = grids.length || 1;

  document.getElementById('totalArea').textContent = `${(grids.length * (gs / 1000) ** 2).toFixed(2)} km²`;
  document.getElementById('excellentCoverage').textContent = `${((cats.S1 || 0) / total * 100).toFixed(1)}%`;
  document.getElementById('goodCoverage').textContent = `${((cats.S2 || 0) / total * 100).toFixed(1)}%`;
  document.getElementById('poorCoverage').textContent = `${(((cats.S4 || 0) + (cats.S5 || 0) + (cats.S6 || 0)) / total * 100).toFixed(1)}%`;

  document.getElementById('analysisResult').innerHTML =
    generateDynamicAnalysis(grids, cats, total, antennaHeight, allSites, gapClusters);
  updateMapLegend(cats, total);
}

// ================================================
// DYNAMIC ANALYSIS TEXT  — top-level function (FIX: tidak bersarang)
// ================================================
function generateDynamicAnalysis(grids, cats, total, antennaHeight, allSites, gapClusters) {
  const type = currentCoverageType === 'rsrp' ? 'RSRP' : 'SINR';
  const unit = currentCoverageType === 'rsrp' ? 'dBm' : 'dB';
  const avg  = arr => arr.length ? (arr.reduce((s, g) => s + g.value, 0) / arr.length).toFixed(1) : '-';
  const s1Pct   = (cats.S1 || 0) / total * 100;
  const s2Pct   = (cats.S2 || 0) / total * 100;
  const poorPct = ((cats.S4 || 0) + (cats.S5 || 0) + (cats.S6 || 0)) / total * 100;
  const borderPct = (grids.filter(g => g.isVoronoiBorder).length / total * 100).toFixed(1);
  const mainSite = allSites[0].site;
  const avgISD = allSites.length > 1
    ? (allSites.slice(1).reduce((sum, s) => sum + calcDistance({ lat: mainSite.lat, lng: mainSite.lng }, { lat: s.site.lat, lng: s.site.lng }), 0) / (allSites.length - 1)).toFixed(0)
    : '-';
  const ml = grids.length > 0
    ? `${grids[0].scenario.toUpperCase()} ${grids[0].condition.toUpperCase().replace('_', '/')}`
    : 'UMA NLOS';

  let html = '<div class="analysis-text">';
  html += `<div style="margin-bottom:10px;padding:6px 10px;background:#1a2a3a;border-left:3px solid #00c7be;border-radius:4px;font-size:0.82rem;">
    📡 <b style="color:#00c7be">${ml}</b> | 🗼 <b style="color:#ffcc00">${allSites.length} sites</b> | 📏 <b style="color:#ff9500">${avgISD}m ISD</b> | 📶 <b style="color:#34c759">30 MHz</b>
  </div>`;

  if (s1Pct > 50) {
    html += `<div class="analysis-success"><strong>Coverage Sangat Baik</strong><br>${s1Pct.toFixed(1)}% excellent.</div>`;
  } else if (poorPct > 40) {
    html += `<div class="analysis-warning"><strong>Coverage Perlu Perbaikan</strong><br>${poorPct.toFixed(1)}% ${type} buruk.</div>`;
  } else {
    html += `<div class="analysis-highlight"><strong>Coverage Memadai</strong><br>${s2Pct.toFixed(1)}% kategori good.</div>`;
  }

  // Gap summary
  if (gapClusters && gapClusters.length > 0) {
    const blankClusters = gapClusters.filter(c => c.type === 'blank_spot');
    const weakClusters  = gapClusters.filter(c => c.type === 'weak_coverage');
    const totalBlankArea = blankClusters.reduce((s, c) => s + parseFloat(c.areaSqKm), 0).toFixed(3);
    const totalWeakArea  = weakClusters.reduce((s, c) => s + parseFloat(c.areaSqKm), 0).toFixed(3);

    if (blankClusters.length > 0) {
      html += `<div style="margin:8px 0;padding:8px 10px;background:#2a1515;border-left:3px solid #ff3b30;border-radius:4px;font-size:0.82rem;">
        <b style="color:#ff3b30">🚫 ${blankClusters.length} Blank Spot Terdeteksi</b><br>
        Total area: <b>${totalBlankArea} km²</b> — <i>Prioritas utama perencanaan site baru</i><br>
        <span style="color:#aaa;font-size:0.78rem">Tidak ada sinyal / No Service Area</span>
      </div>`;
    }
    if (weakClusters.length > 0) {
      html += `<div style="margin:8px 0;padding:8px 10px;background:#2a1e10;border-left:3px solid #ff9500;border-radius:4px;font-size:0.82rem;">
        <b style="color:#ff9500">⚠️ ${weakClusters.length} Weak Coverage Area</b><br>
        Total area: <b>${totalWeakArea} km²</b> — <i>Throughput rendah, koneksi tidak stabil</i><br>
        <span style="color:#aaa;font-size:0.78rem">RSRP -120 ~ -105 dBm / Degraded service</span>
      </div>`;
    }
  } else {
    html += `<div style="margin:8px 0;padding:6px 10px;background:#1a3a1a;border-left:3px solid #34c759;border-radius:4px;font-size:0.82rem;">
      <b style="color:#34c759">✅ Tidak ada coverage gap signifikan</b>
    </div>`;
  }

  html += `<p><strong>Distribusi per Site:</strong></p><ul style="margin:4px 0;padding-left:18px;font-size:0.83rem;">`;
  allSites.forEach(({ id, isMain }) => {
    const sg = grids.filter(g => g.servingSiteId === id);
    html += `<li><b>${id}</b>${isMain ? ' ★' : ''}: ${(sg.length / total * 100).toFixed(1)}%, avg ${avg(sg)} ${unit}</li>`;
  });
  html += `</ul>`;
  html += `<p style="font-size:0.83rem"><strong>Zona Handover:</strong> <span style="color:#ffcc00">${borderPct}%</span> grid di batas antar site.</p>`;

  const close = grids.filter(g => g.dist <= 150);
  const med   = grids.filter(g => g.dist > 150 && g.dist <= 300);
  const far   = grids.filter(g => g.dist > 300);
  html += `<p><strong>Avg ${type} per Jarak:</strong></p><ul style="margin:4px 0;padding-left:18px;font-size:0.83rem;">`;
  if (close.length) html += `<li>0–150m: <b>${avg(close)} ${unit}</b></li>`;
  if (med.length)   html += `<li>150–300m: <b>${avg(med)} ${unit}</b></li>`;
  if (far.length)   html += `<li>>300m: <b>${avg(far)} ${unit}</b></li>`;
  html += '</ul>';

  const site = siteIndex[selectedSite];
  if (site && Math.abs(antennaHeight - site.height) > 5) {
    html += `<p style="font-size:0.83rem"><strong>Tinggi Antena:</strong> `;
    html += antennaHeight > site.height
      ? `Dinaikkan ${antennaHeight - site.height}m — meningkatkan jangkauan.`
      : `Diturunkan ${site.height - antennaHeight}m — mengurangi jangkauan.`;
    html += '</p>';
  }

  html += '</div>';
  return html;
}

// ================================================
// LEGEND  — top-level function (FIX: tidak bersarang)
// ================================================
function updateMapLegend(cats, total) {
  const legend = document.getElementById('mapLegend');
  const tbody  = document.getElementById('legendTableBody');
  const title  = document.getElementById('legendTitle');
  legend.style.display = 'block';
  const isRSRP = currentCoverageType === 'rsrp';
  title.textContent = isRSRP ? 'RSRP (dBm)' : 'SINR (dB)';

  const rows = isRSRP ? [
    { cat: 'S1', color: '#0042a5', range: '-85 ~ 0',     label: 'Excellent' },
    { cat: 'S2', color: '#00a955', range: '-95 ~ -85',   label: 'Good' },
    { cat: 'S3', color: '#70ff66', range: '-105 ~ -95',  label: 'Moderate' },
    { cat: 'S4', color: '#fffb00', range: '-120 ~ -105', label: 'Poor' },
    { cat: 'S5', color: '#ff3333', range: '-140 ~ -120', label: 'Very Bad' },
  ] : [
    { cat: 'S1', color: '#0042a5', range: '20 ~ 40',  label: 'Excellent' },
    { cat: 'S2', color: '#00a955', range: '10 ~ 20',  label: 'Good' },
    { cat: 'S3', color: '#70ff66', range: '0 ~ 10',   label: 'Moderate' },
    { cat: 'S4', color: '#fffb00', range: '-5 ~ 0',   label: 'Poor' },
    { cat: 'S5', color: '#ff3333', range: '-40 ~ -5', label: 'Very Bad' },
  ];

  tbody.innerHTML = '';
  rows.forEach(item => {
    const pct = total > 0 ? (((cats[item.cat] || 0) / total) * 100).toFixed(1) : '0.0';
    const row = document.createElement('tr');
    row.innerHTML = `<td><div class="color-box" style="background:${item.color}"></div></td><td>${item.range}</td><td style="color:#555;font-size:10px">${item.label}</td><td><b>${pct}%</b></td>`;
    tbody.appendChild(row);
  });

  // Blank spot legend row
  const bs = document.createElement('tr');
  bs.innerHTML = `<td><div class="color-box" style="background:#ff3b30;opacity:0.6;border:2px dashed #ff3b30"></div></td><td colspan="2" style="font-size:10px;color:#ff6b6b">🚫 Blank Spot</td><td></td>`;
  tbody.appendChild(bs);

  // Weak coverage legend row
  const wc = document.createElement('tr');
  wc.innerHTML = `<td><div class="color-box" style="background:#ff9500;opacity:0.5;border:2px dashed #ff9500"></div></td><td colspan="2" style="font-size:10px;color:#ffb340">⚠️ Weak Coverage</td><td></td>`;
  tbody.appendChild(wc);

  // Handover border legend row
  const br = document.createElement('tr');
  br.innerHTML = `<td><div class="color-box" style="background:repeating-linear-gradient(45deg,#fff,#fff 2px,#555 2px,#555 4px)"></div></td><td colspan="2" style="font-size:10px;color:#aaa">Border handover</td><td></td>`;
  tbody.appendChild(br);
}

// ================================================
// VISUALIZATION TOGGLE
// ================================================
function setActiveVisualization(type) {
  currentCoverageType = type;
  document.getElementById('visualizeRSRP')?.classList.toggle('active', type === 'rsrp');
  document.getElementById('visualizeSINR')?.classList.toggle('active', type === 'sinr');
  if (selectedSite && siteIndex[selectedSite]) generateCoverage();
}

// ================================================
// LOADING
// ================================================
function showLoadingWithProgress(text, progress, est) {
  hideLoading();
  const o = document.createElement('div');
  o.className = 'loading-overlay';
  o.id = 'loadingOverlay';
  o.innerHTML = `<div class="loading-content"><div class="spinner"></div>
    <p class="loading-text" id="loadingText">${text}</p>
    ${est !== null ? `<p class="loading-est">Estimasi: ~${est}s</p>
      <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progressBarFill" style="width:${progress}%"></div></div>
      <p class="progress-label" id="progressLabel">${progress}%</p>` : ''}
  </div>`;
  document.body.appendChild(o);
}

function showLoading(text = 'Memproses...') { showLoadingWithProgress(text, 0, null); }

function updateLoadingProgress(p, text) {
  const f = document.getElementById('progressBarFill');
  const l = document.getElementById('progressLabel');
  const t = document.getElementById('loadingText');
  if (f) f.style.width = `${p}%`;
  if (l) l.textContent = `${p}%`;
  if (t && text) t.textContent = text;
}

function hideLoading() { document.getElementById('loadingOverlay')?.remove(); }

console.log('Coverage.js v6 — Blank Spot scoped to main site radius + cluster ownership check loaded.');