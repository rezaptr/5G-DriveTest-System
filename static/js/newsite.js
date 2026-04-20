// ================================================
// NEW SITE PLANNING JAVASCRIPT
// Model propagasi: 3GPP TR 38.901 (UMa/UMi/RMa LOS/NLOS)
// Clutter dipilih manual oleh perencana RF (tidak ada shapefile)
// Konsisten dengan coverage.js & simulation.js
// ================================================

let map;
let sectorLayer, coverageLayer;
let newSiteMarker       = null;
let currentSiteLocation = null;
let currentCoverageType = 'rsrp';
let sectorCount         = 3;
let azimuths            = [];

const BEAMWIDTH = 35;

const SECTOR_COLORS = [
  '#ff2d55', '#00c7be', '#ffcc00',
  '#af52de', '#ff9500', '#34c759'
];

// ================================================
// CALIBRATION CONSTANTS — identik dengan simulation.js & coverage.js
// ================================================
const CAL = {
  TX_POWER  : 46,
  FREQUENCY : 2300,
  MOBILE_H  : 1.5,
  ANTENNA_Am: 15,

  SINR_P_GOOD    : 0.60,
  SINR_GOOD_BASE : 20,
  SINR_GOOD_STD  : 5.5,
  SINR_BAD_BASE  : 6,
  SINR_BAD_STD   : 4.5,
  SINR_SLOPE     : 0.2,
  SINR_RSRP_REF  : -90,
  SINR_FLOOR     : -10,
  SINR_CEIL      : 30,

  CLUTTER_REF_M : 100,
  CLUTTER_COEF  : 3.5,

  SHADOW_STD_MAP: {
    uma_los : 4.0,
    uma_nlos: 6.0,
    umi_los : 4.0,
    umi_nlos: 7.82,
    rma_los : 4.0,
    rma_nlos: 8.0,
  },
};

// ── Clutter → 3GPP scenario mapping (sama dengan app.py) ─────────────────────
const CLUTTER_MAP = {
  'dense_urban': { scenario: 'umi', condition: 'nlos',     label: 'Dense Urban'  },
  'metropolitan':{ scenario: 'umi', condition: 'nlos',     label: 'Metropolitan' },
  'urban'      : { scenario: 'uma', condition: 'nlos',     label: 'Urban'        },
  'sub_urban'  : { scenario: 'uma', condition: 'los_nlos', label: 'Sub Urban'    },
  'rural'      : { scenario: 'rma', condition: 'los',      label: 'Rural'        },
};

function resolveClutter(clutterKey) {
  return CLUTTER_MAP[clutterKey] || { scenario: 'uma', condition: 'nlos', label: 'Urban' };
}

// ================================================
// PATH LOSS — 3GPP TR 38.901 (identik dengan simulation.js & coverage.js)
// ================================================
function pathLoss(scenario, condition, dist_m, freq_mhz, hBS, hUT) {
  const d    = Math.max(dist_m, 10);
  const f    = freq_mhz / 1000;
  const hUT_ = hUT || CAL.MOBILE_H;

  switch (scenario) {
    case 'uma': {
      const pl_los = 28.0 + 22 * Math.log10(d) + 20 * Math.log10(f);
      if (condition === 'los') return pl_los;
      const pl_nlos = 13.54 + 39.08 * Math.log10(d)
        + 20 * Math.log10(f) - 0.6 * (hUT_ - 1.5);
      if (condition === 'nlos') return Math.max(pl_nlos, pl_los);
      if (condition === 'los_nlos') {
        const pLos = Math.exp(-d / 200);
        return pLos * pl_los + (1 - pLos) * Math.max(pl_nlos, pl_los);
      }
      return Math.max(pl_nlos, pl_los);
    }

    case 'umi': {
      const pl_los = 32.4 + 21 * Math.log10(d) + 20 * Math.log10(f);
      if (condition === 'los') return pl_los;
      const pl_nlos = 22.4 + 35.3 * Math.log10(d)
        + 21.3 * Math.log10(f) - 0.3 * (hUT_ - 1.5);
      if (condition === 'nlos') return Math.max(pl_nlos, pl_los);
      if (condition === 'los_nlos') {
        const pLos = Math.exp(-d / 100);
        return pLos * pl_los + (1 - pLos) * Math.max(pl_nlos, pl_los);
      }
      return Math.max(pl_nlos, pl_los);
    }

    case 'rma': {
      const h    = 5;
      const W    = 20;
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
// RSRP & SINR COMPUTE — identik dengan coverage.js
// ================================================
function computeRSRP(dist, antennaHeight, gainDb, scenario, condition) {
  const pl          = pathLoss(scenario, condition, Math.max(dist, 10), CAL.FREQUENCY, antennaHeight, CAL.MOBILE_H);
  const clutterLoss = dist > CAL.CLUTTER_REF_M
    ? CAL.CLUTTER_COEF * Math.log10(dist / CAL.CLUTTER_REF_M)
    : 0;
  const shadowKey   = `${scenario}_${condition === 'los_nlos' ? 'nlos' : condition}`;
  const shadowStd   = CAL.SHADOW_STD_MAP[shadowKey] || 6.0;
  const shadow      = gaussianRandom(0, shadowStd);
  return CAL.TX_POWER + gainDb - pl - clutterLoss + shadow;
}

function computeSINR(dist, rsrp) {
  const rawOffset    = CAL.SINR_SLOPE * (rsrp - CAL.SINR_RSRP_REF);
  const rsrpOffset   = Math.max(-4, Math.min(4, rawOffset));
  const distFactor   = Math.max(0, (dist - 100) / 200);
  const dynamicPGood = Math.max(0.15, CAL.SINR_P_GOOD - distFactor * 0.45);

  let sinr;
  if (Math.random() < dynamicPGood) {
    sinr = gaussianRandom(CAL.SINR_GOOD_BASE + rsrpOffset, CAL.SINR_GOOD_STD);
  } else {
    sinr = gaussianRandom(CAL.SINR_BAD_BASE + rsrpOffset, CAL.SINR_BAD_STD);
  }
  return Math.max(CAL.SINR_FLOOR, Math.min(CAL.SINR_CEIL, sinr));
}

// ================================================
// COLOR & CATEGORY
// ================================================
function getRSRPColor(v) {
  if (v >= -85)  return '#0042a5';
  if (v >= -95)  return '#00a955';
  if (v >= -105) return '#70ff66';
  if (v >= -120) return '#fffb00';
  if (v >= -140) return '#ff3333';
  return '#800000';
}

function getSINRColor(v) {
  if (v >= 20)  return '#0042a5';
  if (v >= 10)  return '#00a955';
  if (v >= 0)   return '#70ff66';
  if (v >= -5)  return '#fffb00';
  if (v >= -40) return '#ff3333';
  return '#800000';
}

function getRSRPCategory(v) {
  if (v >= -85)  return 'S1';
  if (v >= -95)  return 'S2';
  if (v >= -105) return 'S3';
  if (v >= -120) return 'S4';
  if (v >= -140) return 'S5';
  return 'S6';
}

function getSINRCategory(v) {
  if (v >= 20)  return 'S1';
  if (v >= 10)  return 'S2';
  if (v >= 0)   return 'S3';
  if (v >= -5)  return 'S4';
  if (v >= -40) return 'S5';
  return 'S6';
}

// ================================================
// INITIALIZATION
// ================================================
document.addEventListener('DOMContentLoaded', function () {
  initializeMap();
  attachEventListeners();
  generateAzimuthInputs();
  updateClutterBadge();   // tampilkan model awal
});

function initializeMap() {
  map = L.map('newsiteMap').setView([-6.2088, 106.8456], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19
  }).addTo(map);
  sectorLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
}

function attachEventListeners() {
  document.getElementById('setSiteLocationBtn').addEventListener('click', setSiteFromInput);
  document.getElementById('clearSiteBtn').addEventListener('click', clearSite);

  document.getElementById('sectorCount').addEventListener('change', function () {
    sectorCount = parseInt(this.value);
    generateAzimuthInputs();
    if (currentSiteLocation) updateSite();
  });

  document.getElementById('antennaHeight').addEventListener('input', function () {
    updateHeightBadge();
    if (currentSiteLocation) autoRegenerate();
  });

  // ── Clutter selector — menggantikan propagationModel dropdown ─────────────
  document.getElementById('clutterSelect').addEventListener('change', function () {
    updateClutterBadge();
    if (currentSiteLocation) autoRegenerate();
  });

  document.getElementById('visualizeRSRP').addEventListener('click', () => setActiveVisualization('rsrp'));
  document.getElementById('visualizeSINR').addEventListener('click', () => setActiveVisualization('sinr'));

  document.getElementById('gridSize').addEventListener('change', autoRegenerate);
  document.getElementById('coverageRadius').addEventListener('change', autoRegenerate);
}

// ── Baca clutter yang dipilih → resolve ke scenario/condition ────────────────
function getSelectedClutter() {
  const key = document.getElementById('clutterSelect')?.value || 'urban';
  return resolveClutter(key);
}

function updateClutterBadge() {
  const clutter = getSelectedClutter();
  const modelLabel = `${clutter.scenario.toUpperCase()} ${clutter.condition.toUpperCase().replace('_', '/')}`;

  const elModel = document.getElementById('paramModel');
  if (elModel) elModel.textContent = modelLabel;
}

function updateHeightBadge() {
  const h = parseInt(document.getElementById('antennaHeight').value);
  document.getElementById('heightBadge').textContent = `${h}m`;
}

// ================================================
// AZIMUTH INPUTS
// ================================================
function generateAzimuthInputs() {
  const container = document.getElementById('azimuthInputs');
  container.innerHTML = '';
  const step = 360 / sectorCount;

  for (let i = 0; i < sectorCount; i++) {
    const defaultAz = Math.round(i * step);
    const color     = SECTOR_COLORS[i % SECTOR_COLORS.length];

    const grp = document.createElement('div');
    grp.className = 'azimuth-group';
    grp.innerHTML = `
      <label>
        <span class="sector-dot" style="background:${color}"></span>
        Sektor ${i + 1}
      </label>
      <input type="number" id="azimuth${i}" value="${defaultAz}" min="0" max="359" step="1">
    `;
    container.appendChild(grp);

    document.getElementById(`azimuth${i}`).addEventListener('input', function () {
      if (currentSiteLocation) updateSite();
    });
  }
}

function getAzimuths() {
  return Array.from({ length: sectorCount }, (_, i) => {
    const v = parseFloat(document.getElementById(`azimuth${i}`)?.value);
    return isFinite(v) ? v : 0;
  });
}

// ================================================
// MAP INTERACTION
// ================================================
function onMapClick(e) {
  document.getElementById('siteLatitude').value  = e.latlng.lat.toFixed(6);
  document.getElementById('siteLongitude').value = e.latlng.lng.toFixed(6);
  placeSite(e.latlng.lat, e.latlng.lng);
}

function setSiteFromInput() {
  const lat = parseFloat(document.getElementById('siteLatitude').value);
  const lng = parseFloat(document.getElementById('siteLongitude').value);
  if (!isFinite(lat) || !isFinite(lng))  { alert('Masukkan koordinat yang valid'); return; }
  if (lat < -90  || lat > 90)            { alert('Latitude harus antara -90 dan 90'); return; }
  if (lng < -180 || lng > 180)           { alert('Longitude harus antara -180 dan 180'); return; }
  placeSite(lat, lng);
}

function placeSite(lat, lng) {
  currentSiteLocation = { lat, lng };

  const instructions = document.getElementById('mapInstructions');
  if (instructions) instructions.style.display = 'none';
  document.getElementById('clearSiteBtn').style.display = 'flex';

  if (newSiteMarker) map.removeLayer(newSiteMarker);

  const markerIcon = L.divIcon({
    className: '',
    html: `<div class="new-site-pin"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 24]
  });

  newSiteMarker = L.marker([lat, lng], { icon: markerIcon, draggable: true }).addTo(map);
  newSiteMarker.bindPopup(`
    <b>Site Baru</b><br>Lat: ${lat.toFixed(6)}<br>Lng: ${lng.toFixed(6)}
  `).openPopup();

  newSiteMarker.on('dragend', function (e) {
    const p = e.target.getLatLng();
    document.getElementById('siteLatitude').value  = p.lat.toFixed(6);
    document.getElementById('siteLongitude').value = p.lng.toFixed(6);
    currentSiteLocation = { lat: p.lat, lng: p.lng };
    updateSite();
  });

  document.getElementById('currentLocation').style.display = 'flex';
  document.getElementById('locationText').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

  map.setView([lat, lng], 16);
  updateSite();
}

function updateSite() {
  if (!currentSiteLocation) return;
  sectorLayer.clearLayers();
  azimuths = getAzimuths();
  azimuths.forEach((az, idx) =>
    drawSectorFan(currentSiteLocation.lat, currentSiteLocation.lng, az, BEAMWIDTH, 200, idx));
  generateCoverage();
}

function clearSite() {
  if (newSiteMarker) { map.removeLayer(newSiteMarker); newSiteMarker = null; }
  sectorLayer.clearLayers();
  if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer = null; }
  currentSiteLocation = null;

  document.getElementById('siteLatitude').value  = '';
  document.getElementById('siteLongitude').value = '';
  document.getElementById('currentLocation').style.display = 'none';
  document.getElementById('clearSiteBtn').style.display    = 'none';
  document.getElementById('mapInstructions').style.display = 'block';
  document.getElementById('mapLegend').style.display       = 'none';

  document.getElementById('analysisResult').innerHTML = `
    <div class="waiting-state">
      <i class="fas fa-hand-pointer"></i>
      <p>Klik peta atau masukkan koordinat untuk memulai prediksi</p>
    </div>`;
  ['totalArea','excellentCoverage','goodCoverage','poorCoverage']
    .forEach(id => { document.getElementById(id).textContent = id === 'totalArea' ? '0 km²' : '0%'; });
}

// ================================================
// SECTOR FAN
// ================================================
function drawSectorFan(lat, lng, az, beamwidth, radius, idx) {
  const start = az - beamwidth / 2;
  const end   = az + beamwidth / 2;
  const pts   = [[lat, lng]];
  for (let i = 0; i <= 20; i++) {
    const ang = start + (i / 20) * (end - start);
    const p   = destinationPoint(lat, lng, ang, radius);
    pts.push([p.lat, p.lng]);
  }
  pts.push([lat, lng]);
  const color = SECTOR_COLORS[idx % SECTOR_COLORS.length];
  L.polygon(pts, { color, fillColor: color, fillOpacity: 0.18, weight: 2, opacity: 0.7 })
    .addTo(sectorLayer)
    .bindPopup(`<b>Sektor ${idx + 1}</b><br>Azimuth: ${az}°<br>Beamwidth: ${beamwidth}°`);
}

// ================================================
// GEO UTILITIES
// ================================================
function destinationPoint(lat, lng, az, dist) {
  const R    = 6378137;
  const brng = az * Math.PI / 180;
  const d    = dist / R;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
  const lng2 = lng1 + Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
  return { lat: lat2*180/Math.PI, lng: lng2*180/Math.PI };
}

function calcDistance(a, b) {
  const R    = 6378137;
  const lat1 = a.lat*Math.PI/180, lat2 = b.lat*Math.PI/180;
  const dLat = (b.lat-a.lat)*Math.PI/180;
  const dLng = (b.lng-a.lng)*Math.PI/180;
  const s    = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}

function bearingTo(lat1, lng1, lat2, lng2) {
  const p1 = lat1*Math.PI/180, p2 = lat2*Math.PI/180;
  const dl = (lng2-lng1)*Math.PI/180;
  const y  = Math.sin(dl)*Math.cos(p2);
  const x  = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (Math.atan2(y,x)*180/Math.PI + 360) % 360;
}

// ================================================
// ANTENNA GAIN PATTERN
// ================================================
function antennaGainPattern(angOffset) {
  const ratio = angOffset / (BEAMWIDTH / 2);
  return -Math.min(12 * ratio * ratio, CAL.ANTENNA_Am);
}

function bestSectorGain(brng, sectors) {
  if (!sectors || sectors.length === 0) return { gain: 0, sectorIdx: 0, interferenceDb: -20 };
  let bestGain = -Infinity, bestIdx = 0, totalLinear = 0;
  sectors.forEach((az, i) => {
    const offset = Math.abs(((brng - az + 540) % 360) - 180);
    const g      = antennaGainPattern(offset);
    totalLinear += Math.pow(10, g / 10);
    if (g > bestGain) { bestGain = g; bestIdx = i; }
  });
  const bestLinear  = Math.pow(10, bestGain / 10);
  const interLinear = Math.max(totalLinear - bestLinear, 1e-9);
  return { gain: bestGain, sectorIdx: bestIdx, interferenceDb: 10 * Math.log10(interLinear / bestLinear) };
}

function gaussianRandom(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v);
}

// ================================================
// COVERAGE GENERATION
// ================================================
function autoRegenerate() {
  if (currentSiteLocation) generateCoverage();
}

function setActiveVisualization(type) {
  currentCoverageType = type;
  document.getElementById('visualizeRSRP').classList.toggle('active', type === 'rsrp');
  document.getElementById('visualizeSINR').classList.toggle('active', type === 'sinr');
  if (currentSiteLocation) generateCoverage();
}

function generateCoverage() {
  if (!currentSiteLocation) return;
  showLoading('Menghitung prediksi coverage...');

  const gridSize      = parseInt(document.getElementById('gridSize').value);
  const radius        = parseInt(document.getElementById('coverageRadius').value);
  const antennaHeight = parseInt(document.getElementById('antennaHeight').value);
  const clutter       = getSelectedClutter();   // { scenario, condition, label }

  if (coverageLayer) { map.removeLayer(coverageLayer); coverageLayer = null; }

  setTimeout(() => {
    try {
      const grids = calculateCoverage(currentSiteLocation, gridSize, radius, antennaHeight, clutter);
      displayCoverageGrid(grids);
      updateStatistics(grids, antennaHeight, clutter);
      hideLoading();
    } catch (err) {
      console.error('Error generating coverage:', err);
      alert('Error saat generate coverage prediction');
      hideLoading();
    }
  }, 300);
}

function calculateCoverage(site, gridSize, radius, antennaHeight, clutter) {
  const grids  = [];
  const mpdLat = 111320;
  const mpdLon = 111320 * Math.cos(site.lat * Math.PI / 180);

  const dLat   = gridSize / mpdLat;
  const dLon   = gridSize / mpdLon;
  const rLat   = radius / mpdLat;
  const rLon   = radius / mpdLon;

  const { scenario, condition } = clutter;
  const isOmni = !azimuths || azimuths.length === 0;

  for (let lat = site.lat - rLat; lat <= site.lat + rLat; lat += dLat) {
    for (let lon = site.lng - rLon; lon <= site.lng + rLon; lon += dLon) {
      const dist = calcDistance({ lat: site.lat, lng: site.lng }, { lat, lng: lon });
      if (dist < 1) continue;

      const edgeRatio = dist / radius;
      if (edgeRatio > 1.06) continue;
      if (edgeRatio > 0.80) {
        const dropProb = Math.pow((edgeRatio - 0.80) / 0.26, 2.0);
        if (Math.random() < dropProb) continue;
      }

      let gainDb = 0, sectorIdx = 0;
      if (!isOmni) {
        const brg  = bearingTo(site.lat, site.lng, lat, lon);
        const best = bestSectorGain(brg, azimuths);
        gainDb    = best.gain;
        sectorIdx = best.sectorIdx;
      }

      const rsrp = computeRSRP(dist, antennaHeight, gainDb, scenario, condition);

      let value, color, category;
      if (currentCoverageType === 'rsrp') {
        value    = Math.round(rsrp * 10) / 10;
        color    = getRSRPColor(value);
        category = getRSRPCategory(value);
      } else {
        const sinr = computeSINR(dist, rsrp);
        value    = Math.round(sinr * 10) / 10;
        color    = getSINRColor(value);
        category = getSINRCategory(value);
      }

      grids.push({
        lat, lon, dist, value, color, category, sectorIdx,
        scenario, condition,
        bounds: [
          [lat,        lon],
          [lat + dLat, lon],
          [lat + dLat, lon + dLon],
          [lat,        lon + dLon]
        ]
      });
    }
  }
  return grids;
}

// ================================================
// DISPLAY
// ================================================
function displayCoverageGrid(grids) {
  const lg   = L.layerGroup();
  const unit = currentCoverageType === 'rsrp' ? 'dBm' : 'dB';
  const type = currentCoverageType.toUpperCase();

  grids.forEach(grid => {
    const modelLabel = `${grid.scenario.toUpperCase()} ${grid.condition.toUpperCase().replace('_', '/')}`;
    L.polygon(grid.bounds, {
      color: grid.color, fillColor: grid.color, fillOpacity: 0.72, weight: 0
    })
    .bindPopup(`
      <div style="font-family:Arial,sans-serif;">
        <h4 style="margin:0 0 6px 0;color:${grid.color}">${type}: ${grid.value} ${unit}</h4>
        <p style="margin:3px 0"><b>Kategori:</b> ${getCategoryName(grid.category)}</p>
        <p style="margin:3px 0"><b>Jarak:</b> ${Math.round(grid.dist)} m</p>
        <p style="margin:3px 0"><b>Sektor:</b> ${grid.sectorIdx + 1}</p>
        <p style="margin:3px 0"><b>Model:</b> ${modelLabel}</p>
      </div>
    `)
    .addTo(lg);
  });

  coverageLayer = lg.addTo(map);
  console.log(`[Newsite] Rendered ${grids.length} cells | ${grids[0]?.scenario} ${grids[0]?.condition}`);
}

// ================================================
// STATISTICS & ANALYSIS
// ================================================
function updateStatistics(grids, antennaHeight, clutter) {
  const gridArea  = (parseInt(document.getElementById('gridSize').value) / 1000) ** 2;
  const totalArea = (grids.length * gridArea).toFixed(2);
  const cats      = {};
  grids.forEach(g => { cats[g.category] = (cats[g.category] || 0) + 1; });
  const total = grids.length || 1;

  document.getElementById('totalArea').textContent         = `${totalArea} km²`;
  document.getElementById('excellentCoverage').textContent = `${((cats.S1||0)/total*100).toFixed(1)}%`;
  document.getElementById('goodCoverage').textContent      = `${((cats.S2||0)/total*100).toFixed(1)}%`;
  document.getElementById('poorCoverage').textContent      = `${(((cats.S4||0)+(cats.S5||0)+(cats.S6||0))/total*100).toFixed(1)}%`;

  document.getElementById('analysisResult').innerHTML = buildAnalysisHTML(grids, cats, total, antennaHeight, clutter);
  updateMapLegend(cats, total);
}

function buildAnalysisHTML(grids, cats, total, antennaHeight, clutter) {
  const type       = currentCoverageType === 'rsrp' ? 'RSRP' : 'SINR';
  const unit       = currentCoverageType === 'rsrp' ? 'dBm' : 'dB';
  const modelLabel = `${clutter.scenario.toUpperCase()} ${clutter.condition.toUpperCase().replace('_', '/')}`;

  const close  = grids.filter(g => g.dist <= 150);
  const medium = grids.filter(g => g.dist > 150 && g.dist <= 300);
  const far    = grids.filter(g => g.dist > 300);
  const avg    = arr => arr.length ? (arr.reduce((s,g)=>s+g.value,0)/arr.length).toFixed(1) : '-';

  const s1Pct   = (cats.S1||0)/total*100;
  const s2Pct   = (cats.S2||0)/total*100;
  const poorPct = ((cats.S4||0)+(cats.S5||0)+(cats.S6||0))/total*100;

  let html = '<div class="analysis-text">';

  // ── Info badge: clutter + model yang digunakan ────────────────────────────
  html += `<div style="margin-bottom:10px;padding:6px 10px;background:#1a2a3a;
    border-left:3px solid #00c7be;border-radius:4px;font-size:0.82rem;">
    🗺️ Clutter: <b style="color:#ffcc00">${clutter.label}</b> &nbsp;|&nbsp;
    📡 Model: <b style="color:#00c7be">${modelLabel}</b> &nbsp;|&nbsp;
    🏗️ Tinggi: <b style="color:#ff9500">${antennaHeight}m</b> &nbsp;|&nbsp;
    📶 Sektor: <b>${sectorCount}</b>
  </div>`;

  // ── Verdict ───────────────────────────────────────────────────────────────
  if (s1Pct > 50) {
    html += `<div class="analysis-success">
      <strong>✅ Prediksi Coverage Sangat Baik</strong><br>
      ${s1Pct.toFixed(1)}% area excellent — cocok untuk kondisi ${clutter.label}.
    </div>`;
  } else if (poorPct > 40) {
    html += `<div class="analysis-warning">
      <strong>⚠️ Coverage Kurang Optimal</strong><br>
      ${poorPct.toFixed(1)}% area buruk. Naikkan tinggi antena atau pindahkan lokasi site.
    </div>`;
  } else {
    html += `<div class="analysis-highlight">
      <strong>📊 Coverage Memadai</strong><br>
      ${s2Pct.toFixed(1)}% area dalam kategori good.
    </div>`;
  }

  // ── Per-distance breakdown ────────────────────────────────────────────────
  html += '<p><strong>Prediksi per Jarak:</strong></p><ul style="margin:8px 0;padding-left:18px;">';
  if (close.length)  html += `<li><strong>0–150m:</strong> rata-rata ${avg(close)} ${unit}</li>`;
  if (medium.length) html += `<li><strong>150–300m:</strong> rata-rata ${avg(medium)} ${unit}</li>`;
  if (far.length)    html += `<li><strong>>300m:</strong> rata-rata ${avg(far)} ${unit}</li>`;
  html += '</ul>';

  // ── Signal degradation ────────────────────────────────────────────────────
  const ac = avg(close), af = avg(far);
  if (ac !== '-' && af !== '-') {
    const deg = Math.abs(parseFloat(ac)-parseFloat(af)).toFixed(1);
    html += `<p><strong>Degradasi:</strong> Penurunan ${deg} ${unit} dari dekat ke jauh.`;
    if (parseFloat(deg) > 25) html += ' Pertimbangkan penambahan penguat sinyal atau repeater.';
    html += '</p>';
  }

  // ── Rekomendasi kontekstual per clutter ──────────────────────────────────
  html += `<p><strong>💡 Rekomendasi:</strong><br>`;
  if (clutter.scenario === 'umi') {
    html += `Area ${clutter.label} dengan kondisi UMi NLOS — path loss tinggi karena bangunan rapat. `;
    if (antennaHeight < 25) html += 'Naikkan tinggi antena minimal 25–30m untuk penetrasi optimal.';
    else html += 'Tinggi antena sudah memadai untuk lingkungan urban padat.';
  } else if (clutter.scenario === 'rma') {
    html += `Area Rural (RMa LOS) — propagasi lebih baik, jangkauan lebih luas. `;
    html += antennaHeight >= 30
      ? 'Konfigurasi sudah optimal untuk area rural.'
      : 'Tinggi antena bisa diturunkan untuk efisiensi biaya di area rural.';
  } else {
    // UMa
    if (poorPct > 30) {
      html += 'Naikkan tinggi antena untuk memperluas coverage di area Urban. ';
    } else if (s1Pct < 20 && antennaHeight < 40) {
      html += 'Tinggi antena masih bisa ditingkatkan untuk hasil lebih optimal. ';
    } else {
      html += 'Konfigurasi site sudah optimal untuk area yang direncanakan. ';
    }
  }
  if (sectorCount < 3) {
    html += 'Pertimbangkan menambah jumlah sektor untuk coverage yang lebih merata.';
  }
  html += '</p>';

  html += '</div>';
  return html;
}

function getMostCommon(grids) {
  const cnt = {};
  grids.forEach(g => { cnt[g.category] = (cnt[g.category]||0) + 1; });
  return Object.keys(cnt).reduce((a,b) => cnt[a]>cnt[b] ? a : b, 'S3');
}

function getCategoryName(cat) {
  return { S1:'Excellent', S2:'Good', S3:'Moderate', S4:'Poor', S5:'Bad', S6:'Very Bad' }[cat] || 'Unknown';
}

// ================================================
// LEGEND
// ================================================
function updateMapLegend(cats, total) {
  const legend = document.getElementById('mapLegend');
  const tbody  = document.getElementById('legendTableBody');
  const title  = document.getElementById('legendTitle');
  legend.style.display = 'block';

  const isRSRP = currentCoverageType === 'rsrp';
  title.textContent = isRSRP ? 'RSRP (dBm)' : 'SINR (dB)';

  const rows = isRSRP ? [
    { cat:'S1', color:'#0042a5', range:'-85 ~ 0',     label:'Excellent' },
    { cat:'S2', color:'#00a955', range:'-95 ~ -85',   label:'Good'      },
    { cat:'S3', color:'#70ff66', range:'-105 ~ -95',  label:'Moderate'  },
    { cat:'S4', color:'#fffb00', range:'-120 ~ -105', label:'Poor'      },
    { cat:'S5', color:'#ff3333', range:'-140 ~ -120', label:'Very Bad'  }
  ] : [
    { cat:'S1', color:'#0042a5', range:'20 ~ 40',     label:'Excellent' },
    { cat:'S2', color:'#00a955', range:'10 ~ 20',     label:'Good'      },
    { cat:'S3', color:'#70ff66', range:'0 ~ 10',      label:'Moderate'  },
    { cat:'S4', color:'#fffb00', range:'-5 ~ 0',      label:'Poor'      },
    { cat:'S5', color:'#ff3333', range:'-40 ~ -5',    label:'Very Bad'  }
  ];

  tbody.innerHTML = '';
  rows.forEach(item => {
    const pct = total > 0 ? (((cats[item.cat]||0)/total)*100).toFixed(1) : '0.0';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><div class="color-box" style="background:${item.color}"></div></td>
      <td>${item.range}</td>
      <td style="color:#666;font-size:10px;">${item.label}</td>
      <td><b>${pct}%</b></td>
    `;
    tbody.appendChild(row);
  });
}

// ================================================
// LOADING
// ================================================
function showLoading(text = 'Memproses...') {
  hideLoading();
  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';
  overlay.id = 'loadingOverlay';
  overlay.innerHTML = `
    <div class="loading-content">
      <div class="spinner"></div>
      <p class="loading-text">${text}</p>
    </div>`;
  document.body.appendChild(overlay);
}

function hideLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.remove();
}

const GAP_PLANNING_KEY = 'gapPlanningData';

function restoreGapPlanningData() {
  const saved = sessionStorage.getItem(GAP_PLANNING_KEY);
  if (!saved) {
    console.log('Tidak ada data gap planning');
    return;
  }

  try {
    const data = JSON.parse(saved);
    console.log('Data dari coverage:', data);

    // ============================================
    // AMBIL KOORDINAT YANG BENAR
    // ============================================
    const lat = data.recommendedLat;
    const lng = data.recommendedLng;

    if (!lat || !lng) {
      console.warn('Koordinat tidak ditemukan di payload');
      return;
    }

    // ============================================
    // PREFILL INPUT
    // ============================================
    const latInput = document.getElementById('lat');
    const lngInput = document.getElementById('lng');

    if (latInput) latInput.value = lat.toFixed(6);
    if (lngInput) lngInput.value = lng.toFixed(6);

    // ============================================
    // HANDLE MAP
    // ============================================
    if (typeof map !== 'undefined') {
      const latlng = [lat, lng];

      map.setView(latlng, 16);

      // hapus marker lama
      if (window.planningMarker) {
        map.removeLayer(window.planningMarker);
      }

      // marker baru
      window.planningMarker = L.marker(latlng, {
        draggable: true
      }).addTo(map);

      window.planningMarker.bindPopup(`
        <b>📡 Candidate New Site</b><br>
        Gap #${data.gapIndex}<br>
        Avg RSRP: ${data.avgRSRP_dBm} dBm<br>
        Min RSRP: ${data.minRSRP_dBm} dBm<br>
        Radius: ${data.estimatedRadius_m} m<br>
        Severity: <b>${data.severityLabel}</b><br>
        Nearest Site: ${data.nearestSiteId}
      `).openPopup();

      // update input kalau marker digeser
      window.planningMarker.on('dragend', function (e) {
        const pos = e.target.getLatLng();

        if (latInput) latInput.value = pos.lat.toFixed(6);
        if (lngInput) lngInput.value = pos.lng.toFixed(6);
      });
    }

  } catch (e) {
    console.error('Error parsing gap planning data:', e);
    sessionStorage.removeItem(GAP_PLANNING_KEY);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  restoreGapPlanningData();
});

console.log('newsite.js (3GPP TR 38.901 — manual clutter selection) loaded.');