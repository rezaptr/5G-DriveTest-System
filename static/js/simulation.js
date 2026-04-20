// ================= SIMULATION PAGE JAVASCRIPT =================
(function () {
  'use strict';

  const mapElement = document.getElementById('map-simulation');
  if (!mapElement) return;

  let simMap;
  let simSiteLayer, simRouteLayer, simSamplingLayer, simHeatmapLayer;
  let driveTestData = null;
  let samplingPoints = [];
  let rsrpResults = [];

  const SECTOR_COLORS = ['#ff2d55', '#00c7be', '#ffcc00', '#af52de', '#ff9500', '#34c759'];

// ── Calibration constants ────────────────────────────────────────────────────
const CAL = {
  TX_POWER  : 46,
  FREQUENCY : 2300,   // MHz — 3GPP UMa/UMi valid di 0.5–6 GHz ✓
  BANDWIDTH : 30,
  MOBILE_H  : 1.5,
  SHADOW_STD: 5.0,
  ANTENNA_Am: 6,
  BEAMWIDTH : 35,

  // ── SINR Gaussian Mixture Model (tidak berubah) ────────────────────────────
  SINR_P_GOOD    : 0.60,
  SINR_GOOD_BASE : 20,
  SINR_GOOD_STD  : 5.5,
  SINR_BAD_BASE  : 6,
  SINR_BAD_STD   : 4.5,
  SINR_SLOPE     : 0.2,
  SINR_RSRP_REF  : -90,
  SINR_FLOOR     : -10,
  SINR_CEIL      : 30,

  // ── Clutter loss (tetap dipakai sebagai koreksi tambahan) ─────────────────
  //CLUTTER_REF_M : 100,
  //CLUTTER_COEF  : 3.5,   // dikurangi sedikit karena 3GPP sudah lebih akurat

  // ── Shadow fading std-dev per skenario (3GPP TR 38.901 Table 7.4.1) ───────
  SHADOW_STD_MAP: {
    uma_los : 4.0,
    uma_nlos: 6.0,
    umi_los : 4.0,
    umi_nlos: 7.82,
    rma_los : 4.0,
    rma_nlos: 8.0,
  },
};

  // ── Reproducible pseudo-random (Mulberry32) ──────────────────────────────────
  // Menggantikan Math.random() agar hasil simulasi KONSISTEN setiap run.
  // Seed di-generate sekali saat Generate Sampling, dipakai ulang di RSRP & SINR.
  let _rngState = 0;

  function seedRng(seed) {
    _rngState = seed >>> 0;
  }

  function rng() {
    _rngState += 0x6D2B79F5;
    let t = _rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function gaussianRandom(mean, std) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  let activeSeed = 0;

  // ── Init ────────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('map-simulation')) return;
    loadDriveTestData();
    initSimulationMap();
    setupEventListeners();
  });

  // ── Load data from sessionStorage ──────────────────────────────────────────
  function loadDriveTestData() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'flex';
    try {
      const raw = sessionStorage.getItem('driveTestData');
      if (!raw) throw new Error('Tidak ada data rute. Kembali ke Route Planning dan generate rute terlebih dahulu.');
      driveTestData = JSON.parse(raw);
      if (!driveTestData.siteId) throw new Error('Data tidak valid: siteId tidak ditemukan');
      if (!driveTestData.site?.lat || !driveTestData.site?.lng) throw new Error('Data tidak valid: koordinat site tidak lengkap');
      if (!driveTestData.mainRoute?.coords?.length) throw new Error('Data tidak valid: rute utama tidak ditemukan');

      populateSiteInfo();
      populateRouteData();
      setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 800);
    } catch (e) {
      console.error('Error loading data:', e);
      if (overlay) overlay.innerHTML = `
        <div class="spinner"></div>
        <h2 style="color:#e74c3c;">Error Loading Data</h2>
        <p>${e.message}</p><p style="margin-top:20px;">Redirecting ke Route Planning...</p>`;
      setTimeout(() => { window.location.href = '/route'; }, 3000);
    }
  }

  function populateSiteInfo() {
    const h = driveTestData.site.height || 30;
    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('infoSiteId', driveTestData.siteId);
    s('infoLat', driveTestData.site.lat.toFixed(6));
    s('infoLng', driveTestData.site.lng.toFixed(6));
    s('infoSectors', driveTestData.site.sectors.length);
    s('infoHeight', `${h} m`);
    s('paramHeight', `${h} m`);
    s('paramFreq', `${CAL.FREQUENCY} MHz`);
    s('paramBW', `${CAL.BANDWIDTH} MHz`);
    s('paramTxPower', `${CAL.TX_POWER} dBm`);
  }

  function populateRouteData() {
    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('routeDistance', `${(driveTestData.mainRoute.distance / 1000).toFixed(2)} km`);
    s('routeTime', `${Math.round(driveTestData.mainRoute.duration / 60)} menit`);
  }

  // ── Map ─────────────────────────────────────────────────────────────────────
  function initSimulationMap() {
    if (!driveTestData) return;
    simMap = L.map('map-simulation').setView([driveTestData.site.lat, driveTestData.site.lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(simMap);
    simSiteLayer = L.layerGroup().addTo(simMap);
    simRouteLayer = L.layerGroup().addTo(simMap);
    simSamplingLayer = L.layerGroup().addTo(simMap);
    simHeatmapLayer = L.layerGroup().addTo(simMap);

    L.circleMarker([driveTestData.site.lat, driveTestData.site.lng], {
      radius: 10, fillColor: '#ffd000', color: '#000', weight: 3, fillOpacity: 1
    }).addTo(simSiteLayer)
      .bindPopup(`<b>SITE: ${driveTestData.siteId}</b><br>Height: ${driveTestData.site.height || 30}m<br>Sectors: ${driveTestData.site.sectors.length}`);

    (driveTestData.site.sectors || []).forEach((az, i) =>
      drawSectorFan(driveTestData.site.lat, driveTestData.site.lng, az, 65, 150, i));

    const coords = driveTestData.activeRouteData.coords.map(p => [p.lat, p.lng]);
    const mainLine = L.polyline(coords, { color: '#0066ff', weight: 5, opacity: 0.7 })
      .addTo(simRouteLayer)
      .bindPopup(`<b>Main Route</b><br>${(driveTestData.mainRoute.distance / 1000).toFixed(2)} km`);

    if (driveTestData.altRoute?.coords) {
      L.polyline(driveTestData.altRoute.coords.map(p => [p.lat, p.lng]),
        { color: '#ff8800', weight: 4, opacity: 0.5 }).addTo(simRouteLayer);
    }
    try { simMap.fitBounds(mainLine.getBounds(), { padding: [50, 50] }); }
    catch { simMap.setView([driveTestData.site.lat, driveTestData.site.lng], 15); }
  }

  function drawSectorFan(lat, lng, az, bw, radius, idx) {
    const pts = [[lat, lng]];
    for (let i = 0; i <= 16; i++) {
      const ang = (az - bw / 2) + (i / 16) * bw;
      const p = destPoint(lat, lng, ang, radius);
      pts.push([p.lat, p.lng]);
    }
    pts.push([lat, lng]);
    const c = SECTOR_COLORS[idx % SECTOR_COLORS.length];
    L.polygon(pts, { color: c, fillColor: c, fillOpacity: 0.15, weight: 2, opacity: 0.6 })
      .addTo(simSiteLayer)
      .bindPopup(`<b>Sektor ${idx + 1}</b><br>Azimuth: ${az}°`);
  }

  // ── Event listeners ─────────────────────────────────────────────────────────
  function setupEventListeners() {
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('btnBackToRoute', () => window.location.href = '/route');
    on('btnGenerateSampling', generateSamplingPoints);
    on('btnCalculateRSRP', calculateRSRP);
    on('btnCalculateSINR', calculateSINR);
    on('btnExportCSV', exportToCSV);
    const mdl = document.getElementById('propagationModel');
    if (mdl) mdl.addEventListener('change', e => {
      const el = document.getElementById('paramModel');
      if (el) el.textContent = e.target.value.replace('_', ' ').toUpperCase();
    });
  }

  // ── Sampling points — interpolasi geodesik tepat 10 m ────────────────────────
  //
  // Pendekatan lama (SALAH):
  //   step = Math.floor(coords.length / nPts)
  //   → loncat per INDEX array, bukan per jarak.
  //   → Kalau coords padat di tikungan & jarang di jalan lurus,
  //     interval antar titik sampling bisa 3 m di satu segmen dan 40 m di segmen lain.
  //
  // Pendekatan baru (BENAR — geodesic walk):
  //   Jalan sepanjang polyline secara kumulatif meter demi meter.
  //   Setiap kali akumulasi jarak mencapai kelipatan INTERVAL_M (10 m),
  //   tempatkan titik dengan interpolasi linear antara dua vertex terdekat.
  //   → Jarak antar titik sampling SELALU tepat 10 m (±presisi floating point).
  //
  const SAMPLING_INTERVAL_M = 10;

  function generateSamplingPoints() {
    if (!driveTestData?.mainRoute) return alert('Data rute tidak ditemukan!');
    simSamplingLayer.clearLayers();
    samplingPoints = [];

    // Seed baru dibuat sekali per sesi Generate Sampling.
    activeSeed = Math.floor(Date.now() % 2147483647);
    console.log(`[RNG] Seed aktif sesi ini: ${activeSeed}`);

    const coords = driveTestData.activeRouteData.coords;
    if (coords.length < 2) return alert('Rute terlalu pendek!');

    // ── Geodesic walk: tempatkan titik setiap SAMPLING_INTERVAL_M meter ──────
    let accumulated = 0;          // jarak yang sudah "dilewati" sejak titik terakhir
    let nextTarget = 0;          // jarak target titik berikutnya dari awal rute

    // Titik pertama selalu disertakan (km-0)
    samplingPoints.push({ lat: coords[0].lat, lng: coords[0].lng });

    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];
      const segLen = haversineDistance(prev.lat, prev.lng, curr.lat, curr.lng);

      if (segLen === 0) continue;  // skip titik duplikat

      // Segmen ini mungkin melewati beberapa target sekaligus (jika segmen panjang)
      while (accumulated + segLen >= nextTarget + SAMPLING_INTERVAL_M) {
        nextTarget += SAMPLING_INTERVAL_M;

        // Berapa meter dari awal segmen ini sampai ke titik target?
        const distFromPrev = nextTarget - accumulated;
        const ratio = distFromPrev / segLen;   // 0..1 dalam segmen ini

        // Interpolasi linear lat/lng (cukup akurat untuk jarak pendek <500 m)
        const interpLat = prev.lat + ratio * (curr.lat - prev.lat);
        const interpLng = prev.lng + ratio * (curr.lng - prev.lng);

        samplingPoints.push({ lat: interpLat, lng: interpLng });

        L.circleMarker([interpLat, interpLng], {
          radius: 3, fillColor: '#00ff00', color: '#000', weight: 1, fillOpacity: 0.8
        }).addTo(simSamplingLayer)
          .bindPopup(
            `<b>Sampling Point ${samplingPoints.length}</b><br>` +
            `Lat: ${interpLat.toFixed(6)}<br>` +
            `Lng: ${interpLng.toFixed(6)}<br>` +
            `Jarak dari awal: ${((samplingPoints.length - 1) * SAMPLING_INTERVAL_M).toFixed(0)} m`
          );
      }

      accumulated += segLen;
    }

    // Validasi jarak antar titik di console (debugging)
    if (samplingPoints.length >= 2) {
      const gaps = [];
      for (let i = 1; i < Math.min(samplingPoints.length, 6); i++) {
        gaps.push(haversineDistance(
          samplingPoints[i - 1].lat, samplingPoints[i - 1].lng,
          samplingPoints[i].lat, samplingPoints[i].lng
        ).toFixed(2) + ' m');
      }
      console.log(`[Sampling] Interval 5 titik pertama: ${gaps.join(', ')} (target: ${SAMPLING_INTERVAL_M} m)`);
    }

    const el = document.getElementById('samplingCount');
    if (el) el.textContent = samplingPoints.length;

    const totalDist = (driveTestData.mainRoute.distance / 1000).toFixed(2);
    alert(
      `Berhasil generate ${samplingPoints.length} titik sampling\n` +
      `Interval: ${SAMPLING_INTERVAL_M} m (konsisten, geodesik)\n` +
      `Panjang rute: ${totalDist} km`
    );

    ['btnCalculateRSRP', 'btnCalculateSINR'].forEach(id => {
      const b = document.getElementById(id); if (b) b.disabled = false;
    });
  }

  // ── Antenna gain pattern (3GPP TR 36.942) ───────────────────────────────────
  function antennaGain(angularOffset_deg) {
    const ratio = angularOffset_deg / (CAL.BEAMWIDTH / 2);
    return -Math.min(12 * ratio * ratio, CAL.ANTENNA_Am);
  }

  function bestSectorGain(brng, sectors) {
    if (!sectors || sectors.length === 0) return { bestGain: 0, sectorIdx: 0, interferenceDb: -20 };
    let bestGain = -Infinity, bestIdx = 0, totalLinear = 0;
    sectors.forEach((az, i) => {
      const offset = Math.abs(((brng - az + 540) % 360) - 180);
      const g = antennaGain(offset);
      totalLinear += Math.pow(10, g / 10);
      if (g > bestGain) { bestGain = g; bestIdx = i; }
    });
    const bestLinear = Math.pow(10, bestGain / 10);
    const interLinear = Math.max(totalLinear - bestLinear, 1e-9);
    const interferenceDb = 10 * Math.log10(interLinear / bestLinear);
    return { bestGain, sectorIdx: bestIdx, interferenceDb };
  }

// ================================================================
// RSRP CALCULATION — model 3GPP dipilih otomatis dari clutter data
// ================================================================
function calculateRSRP() {
  if (!samplingPoints.length) return alert('Generate titik sampling terlebih dahulu!');

  // ── Ambil scenario & condition dari data site ──────────────────────────────
  const scenario  = driveTestData.site.scenario  || 'uma';
  const condition = driveTestData.site.condition || 'nlos';
  const clutter   = driveTestData.site.clutter   || 'N/A';

  // Update label di UI (dropdown diganti jadi display)
  const modelLabel = `${scenario.toUpperCase()} ${condition.toUpperCase().replace('_', '/')}`;
  const elModel = document.getElementById('paramModel');
  if (elModel) elModel.textContent = modelLabel;

  const elClutter = document.getElementById('paramClutter');
  if (elClutter) elClutter.textContent = clutter;

  seedRng(activeSeed);

  simHeatmapLayer.clearLayers();
  rsrpResults = [];

  const antennaHeight = driveTestData.site.height || 30;
  const sectors       = driveTestData.site.sectors || [];
  const isOmni        = sectors.length === 0;

  // Shadow std-dev sesuai skenario
  const shadowKey = `${scenario}_${condition === 'los_nlos' ? 'nlos' : condition}`;
  const shadowStd = CAL.SHADOW_STD_MAP[shadowKey] || CAL.SHADOW_STD;

  samplingPoints.forEach((point, idx) => {
    const dist = haversineDistance(
      driveTestData.site.lat, driveTestData.site.lng, point.lat, point.lng);

    let gainDb = 0, sectorIdx = 0, bearingDeg = 'N/A';
    if (!isOmni) {
      bearingDeg = bearing(driveTestData.site.lat, driveTestData.site.lng, point.lat, point.lng);
      const best = bestSectorGain(bearingDeg, sectors);
      gainDb    = best.bestGain;
      sectorIdx = best.sectorIdx;
    }

    const pl     = pathLoss(scenario, condition, Math.max(dist, 10), CAL.FREQUENCY, antennaHeight, CAL.MOBILE_H);
    const shadow = gaussianRandom(0, shadowStd);

    // Clutter loss — koreksi tambahan di atas model 3GPP
    const rsrp = CAL.TX_POWER + gainDb - pl + shadow;

    rsrpResults.push({
      index       : idx + 1,
      lat         : point.lat,
      lng         : point.lng,
      distance    : dist.toFixed(1),
      bearing     : isOmni ? 'N/A' : bearingDeg.toFixed(1),
      sectorIdx   : sectorIdx + 1,
      antennaGain : gainDb.toFixed(1),
      pathLoss    : pl.toFixed(1),
      rsrp        : rsrp.toFixed(1),
      antennaHeight,
      scenario    : modelLabel,
      clutter     : clutter,
    });

    L.circleMarker([point.lat, point.lng], {
      radius: 5, fillColor: rsrpColor(rsrp), color: '#000', weight: 1, fillOpacity: 0.9
    }).addTo(simHeatmapLayer)
      .bindPopup(`
        <b>Point ${idx + 1}</b><br>
        Distance: ${dist.toFixed(0)} m<br>
        Clutter: <b>${clutter}</b><br>
        Model: <b>${modelLabel}</b><br>
        Serving Sector: ${isOmni ? 'Omni' : sectorIdx + 1}<br>
        Antenna Gain: <b>${gainDb.toFixed(1)} dB</b><br>
        Path Loss: ${pl.toFixed(1)} dB<br>
        <b>RSRP: ${rsrp.toFixed(1)} dBm</b>
      `);
  });

  updateLegend('RSRP');
  showResultBox('RSRP');
  document.getElementById('btnExportCSV').disabled = false;

  const avgRSRP = (rsrpResults.reduce((s, r) => s + parseFloat(r.rsrp), 0) / rsrpResults.length).toFixed(1);
  const inBeam  = rsrpResults.filter(r => parseFloat(r.antennaGain) > -CAL.ANTENNA_Am * 0.5).length;
  alert(
    `Kalkulasi RSRP selesai — ${rsrpResults.length} titik\n` +
    `Model: ${modelLabel} (Clutter: ${clutter})\n` +
    `Avg RSRP: ${avgRSRP} dBm\n` +
    `Titik dalam beam: ${inBeam} / ${rsrpResults.length}`
  );
}
  // ================================================================
  // SINR CALCULATION — GAUSSIAN MIXTURE MODEL (DIKALIBRASI ULANG v3)
  //
  // Perubahan utama vs versi sebelumnya:
  //   1. Seed RNG dikunci ke (activeSeed+1) → konsisten setiap klik
  //   2. SINR_GOOD_BASE 15→20: center state "good" di batas Sangat Bagus
  //   3. SINR_P_GOOD 0.45→0.60: lebih banyak titik ke state bagus
  //   4. SINR_GOOD_STD 4→5.5: ekor atas lebih tebal, mengisi 20~30 dB
  //   5. SINR_CEIL 25→30: tidak memotong distribusi atas secara artifisial
  //   6. rsrpOffset dibatasi ±4 dB (interference-limited system)
  // ================================================================
  function calculateSINR() {
    if (!rsrpResults.length) return alert('Hitung RSRP terlebih dahulu!');

    seedRng(activeSeed + 1);       // seed berbeda dari RSRP, tapi tetap deterministik

    rsrpResults.forEach((result, idx) => {
      const rsrp = parseFloat(result.rsrp);

      // Kontribusi RSRP ke SINR — dibatasi ±4 dB (interference-limited)
      const rawOffset = CAL.SINR_SLOPE * (rsrp - CAL.SINR_RSRP_REF);
      const rsrpOffset = Math.max(-4, Math.min(4, rawOffset));

      let sinr;
      const distance = parseFloat(result.distance);

      // Dynamic p_good: probabilitas sinyal bagus menurun seiring jarak.
      // Di 0-100m: p_good = SINR_P_GOOD (0.60) — penuh
      // Di 300m  : p_good turun ~0.20 (interference makin tinggi di cell edge)
      // Minimum  : 0.15 (selalu ada sedikit peluang kondisi bagus)
      const distFactor = Math.max(0, (distance - 100) / 200);  // 0 @ 100m, 1 @ 300m
      const dynamicPGood = Math.max(0.15, CAL.SINR_P_GOOD - distFactor * 0.45);

      if (rng() < dynamicPGood) {
        sinr = gaussianRandom(CAL.SINR_GOOD_BASE + rsrpOffset, CAL.SINR_GOOD_STD);
      } else {
        sinr = gaussianRandom(CAL.SINR_BAD_BASE + rsrpOffset, CAL.SINR_BAD_STD);
      }

      sinr = Math.max(CAL.SINR_FLOOR, Math.min(CAL.SINR_CEIL, sinr));
      rsrpResults[idx].sinr = sinr.toFixed(1);
    });

    simHeatmapLayer.clearLayers();
    rsrpResults.forEach(result => {
      const sinr = parseFloat(result.sinr);
      L.circleMarker([result.lat, result.lng], {
        radius: 5, fillColor: sinrColor(sinr), color: '#000', weight: 1, fillOpacity: 0.9
      }).addTo(simHeatmapLayer)
        .bindPopup(`
          <b>Point ${result.index}</b><br>
          Distance: ${result.distance} m<br>
          Serving Sector: ${result.sectorIdx}<br>
          RSRP: ${result.rsrp} dBm<br>
          <b>SINR: ${result.sinr} dB</b>
        `);
    });

    updateLegend('SINR');
    showResultBox('SINR');

    // Log distribusi ke console untuk validasi
    const total = rsrpResults.length;
    const bands = [
      { label: '≥20 dB', fn: v => v >= 20 },
      { label: '10~20 dB', fn: v => v >= 10 && v < 20 },
      { label: '0~10 dB', fn: v => v >= 0 && v < 10 },
      { label: '-5~0 dB', fn: v => v >= -5 && v < 0 },
      { label: '<-5 dB', fn: v => v < -5 },
    ];
    console.table(bands.map(b => {
      const cnt = rsrpResults.filter(r => b.fn(parseFloat(r.sinr))).length;
      return { Rentang: b.label, Count: cnt, Pct: ((cnt / total) * 100).toFixed(1) + '%' };
    }));

    const avgSINR = (rsrpResults.reduce((s, r) => s + parseFloat(r.sinr), 0) / total).toFixed(1);
    const pct20up = ((rsrpResults.filter(r => parseFloat(r.sinr) >= 20).length / total) * 100).toFixed(1);
    const pct1020 = ((rsrpResults.filter(r => parseFloat(r.sinr) >= 10 && parseFloat(r.sinr) < 20).length / total) * 100).toFixed(1);
    const pct010 = ((rsrpResults.filter(r => parseFloat(r.sinr) >= 0 && parseFloat(r.sinr) < 10).length / total) * 100).toFixed(1);
    alert(`Kalkulasi SINR selesai\nAvg SINR: ${avgSINR} dB\n\nDistribusi:\n≥20 dB (Sangat Bagus): ${pct20up}%\n10~20 dB (Bagus): ${pct1020}%\n0~10 dB (Normal): ${pct010}%`);
  }

// ================================================================
// PATH LOSS MODELS — 3GPP TR 38.901 (valid 0.5–6 GHz, incl. 2300 MHz)
//
// Parameter:
//   scenario  : 'uma' | 'umi' | 'rma'
//   condition : 'los' | 'nlos' | 'los_nlos'
//   dist_m    : jarak 2D dalam meter
//   freq_mhz  : frekuensi dalam MHz
//   hBS       : tinggi antena BS (meter)
//   hUT       : tinggi UE (meter, default 1.5)
//
// Catatan los_nlos (suburban):
//   Probabilitas LOS = exp(-dist_m / 200) — makin jauh makin NLOS.
//   Path loss = blend probabilistik antara LOS dan NLOS.
// ================================================================
f/**
 * pathLoss()
 * @param {string}  scenario   'uma' | 'umi' | 'rma'
 * @param {string}  condition  'los' | 'nlos' | 'los_nlos'
 * @param {number}  d2D_m      jarak 2D [meter]
 * @param {number}  freq_mhz   frekuensi [MHz]
 * @param {number}  hBS        tinggi antena BS [meter]
 * @param {number}  hUT        tinggi UE [meter, default 1.5]
 * @returns {number}            path loss [dB]
 */
function pathLoss(scenario, condition, d2D_m, freq_mhz, hBS, hUT) {
  const d2D = Math.max(d2D_m, 10);         // minimum 10 m per spec
  const hUT_ = hUT || 1.5;
  const fc   = freq_mhz / 1000;            // GHz — rumus 3GPP pakai GHz
  const c    = 3e8;                         // m/s
 
  // 3D distance (selalu lebih besar dari d2D, penting untuk akurasi)
  const d3D  = Math.sqrt(d2D * d2D + (hBS - hUT_) * (hBS - hUT_));
 
  // ── helper: LOS probability UMa (3GPP Table 7.4.2-1) ──────────────────────
  // Dipakai untuk mode 'los_nlos' (blend probabilistik)
  function pLOS_UMa(d) {
    if (d <= 18) return 1.0;
    const C = hUT_ <= 13
      ? 0
      : Math.pow((hUT_ - 13) / 10, 1.5);
    return (18 / d + Math.exp(-d / 63) * (1 - 18 / d)) * (1 + C * (5 / 4) * Math.pow(d / 100, 3) * Math.exp(-d / 150));
  }
 
  // helper: LOS probability UMi (3GPP Table 7.4.2-1)
  function pLOS_UMi(d) {
    if (d <= 18) return 1.0;
    return 18 / d + Math.exp(-d / 36) * (1 - 18 / d);
  }
 
  switch (scenario) {
 
    // ════════════════════════════════════════════════════════════════════════
    // UMa — Urban Macro  (3GPP TR 38.901 Table 7.4.1-1)
    // Applicable: hBS = 25m, hUT = 1.5–22.5m, d2D = 10m–5km
    // ════════════════════════════════════════════════════════════════════════
    case 'uma': {
      // Effective environment height hE
      // Simplified: gunakan hE=1m (konservatif, valid untuk hUT ≤ 13m)
      const hE   = 1.0;
      const hBS_ = hBS  - hE;
      const hUT_eff = hUT_ - hE;
 
      // Breakpoint distance (3GPP eq. 7.4.1-1)
      const dBP  = 4 * hBS_ * hUT_eff * (freq_mhz * 1e6) / c;   // meter
 
      // ── UMa-LOS (dual-slope) ──────────────────────────────────────────────
      let pl_los;
      if (d2D <= dBP) {
        pl_los = 28.0 + 22 * Math.log10(d3D) + 20 * Math.log10(fc);
      } else {
        pl_los = 28.0 + 40 * Math.log10(d3D) + 20 * Math.log10(fc)
          - 9 * Math.log10(dBP * dBP + (hBS - hUT_) * (hBS - hUT_));
      }
 
      if (condition === 'los') return pl_los;
 
      // ── UMa-NLOS (3GPP Table 7.4.1-1, from TR36.873) ─────────────────────
      const pl_nlos_uma = 13.54
        + 39.08 * Math.log10(d3D)
        + 20    * Math.log10(fc)
        - 0.6   * (hUT_ - 1.5);
      // Must be >= LOS path loss
      const pl_nlos = Math.max(pl_nlos_uma, pl_los);
 
      if (condition === 'nlos') return pl_nlos;
 
      // ── Probabilistic blend (suburban / los_nlos) ─────────────────────────
      const p = pLOS_UMa(d2D);
      return p * pl_los + (1 - p) * pl_nlos;
    }
 
    // ════════════════════════════════════════════════════════════════════════
    // UMi-Street Canyon  (3GPP TR 38.901 Table 7.4.1-1)
    // Applicable: hBS = 10m, hUT = 1.5–22.5m, d2D = 10m–5km
    // ════════════════════════════════════════════════════════════════════════
    case 'umi': {
      const hE   = 1.0;   // UMi: hE = 1m (fixed per spec)
      const hBS_ = hBS  - hE;
      const hUT_eff = hUT_ - hE;
 
      const dBP  = 4 * hBS_ * hUT_eff * (freq_mhz * 1e6) / c;
 
      // ── UMi-LOS (dual-slope) ──────────────────────────────────────────────
      let pl_los;
      if (d2D <= dBP) {
        pl_los = 32.4 + 21 * Math.log10(d3D) + 20 * Math.log10(fc);
      } else {
        pl_los = 32.4 + 40 * Math.log10(d3D) + 20 * Math.log10(fc)
          - 9.5 * Math.log10(dBP * dBP + (hBS - hUT_) * (hBS - hUT_));
      }
 
      if (condition === 'los') return pl_los;
 
      // ── UMi-NLOS ──────────────────────────────────────────────────────────
      const pl_nlos_umi = 22.4
        + 35.3 * Math.log10(d3D)
        + 21.3 * Math.log10(fc)
        - 0.3  * (hUT_ - 1.5);
      const pl_nlos = Math.max(pl_nlos_umi, pl_los);
 
      if (condition === 'nlos') return pl_nlos;
 
      const p = pLOS_UMi(d2D);
      return p * pl_los + (1 - p) * pl_nlos;
    }
 
    // ════════════════════════════════════════════════════════════════════════
    // RMa — Rural Macro  (3GPP TR 38.901 Table 7.4.1-1)
    // Applicable: hBS = 10–150m, hUT = 1–10m, d2D = 10m–10km (LOS) / 5km (NLOS)
    // ════════════════════════════════════════════════════════════════════════
    case 'rma': {
      const h = 5;      // avg building height rural [m] — spec default 5m
      const W = 20;     // avg street width rural [m]    — spec default 20m
 
      // RMa breakpoint (3GPP Eq. 7.4.1-4)
      const dBP_rma = 2 * Math.PI * hBS * hUT_ * (freq_mhz * 1e6) / c;
 
      // ── RMa-LOS (dual-slope per 3GPP Table 7.4.1-1) ──────────────────────
      const A1 = Math.min(0.03 * Math.pow(h, 1.72), 10);
      const A2 = Math.min(0.044 * Math.pow(h, 1.72), 14.77);
      const A3 = 0.002 * Math.log10(h);
 
      let pl_los;
      if (d2D <= dBP_rma) {
        pl_los = 20 * Math.log10(40 * Math.PI * d3D * fc / 3)
          + A1 * Math.log10(d3D)
          - A2
          + A3 * d3D;
      } else {
        // Beyond breakpoint
        const d3D_BP = Math.sqrt(dBP_rma * dBP_rma + (hBS - hUT_) * (hBS - hUT_));
        pl_los = 20 * Math.log10(40 * Math.PI * d3D_BP * fc / 3)
          + A1 * Math.log10(d3D_BP)
          - A2
          + A3 * d3D_BP
          + 40 * Math.log10(d3D / d3D_BP);
      }
 
      if (condition === 'los') return pl_los;
 
      // ── RMa-NLOS (3GPP Table 7.4.1-1) ────────────────────────────────────
      const pl_nlos_rma = 161.04
        - 7.1  * Math.log10(W)
        + 7.5  * Math.log10(h)
        - (24.37 - 3.7 * Math.pow(h / hBS, 2)) * Math.log10(hBS)
        + (43.42 - 3.1 * Math.log10(hBS)) * (Math.log10(d3D) - 3)
        + 20   * Math.log10(fc)
        - (3.2 * Math.pow(Math.log10(11.75 * hUT_), 2) - 4.97);
 
      return Math.max(pl_nlos_rma, pl_los);
    }
 
    default:
      // fallback: UMa-LOS simplified
      return 28.0 + 22 * Math.log10(d3D) + 20 * Math.log10(fc);
  }
}

  // ── Geo utilities ────────────────────────────────────────────────────────────
  function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6378137;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearing(lat1, lng1, lat2, lng2) {
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dl = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function destPoint(lat, lng, az, dist) {
    const R = 6378137, brng = az * Math.PI / 180, d = dist / R;
    const lat1 = lat * Math.PI / 180, lng1 = lng * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
  }

  // ── Color mapping ─────────────────────────────────────────────────────────────
  function rsrpColor(v) {
    if (v >= -85) return '#0042a5';
    if (v >= -95) return '#00a955';
    if (v >= -105) return '#70ff66';
    if (v >= -120) return '#fffb00';
    if (v >= -140) return '#ff3333';
    return '#800000';
  }

  function sinrColor(v) {
    if (v >= 20) return '#0042a5';
    if (v >= 10) return '#00a955';
    if (v >= 0) return '#70ff66';
    if (v >= -5) return '#fffb00';
    if (v >= -40) return '#ff3333';
    return '#800000';
  }

  // ── Legend ────────────────────────────────────────────────────────────────────
  function updateLegend(type) {
    const legend = document.getElementById('rsrpLegend');
    const tbody = document.getElementById('legendTableBody');
    const title = document.getElementById('legendTitle');
    if (!legend || !tbody) return;
    if (title) title.textContent = type === 'RSRP' ? 'RSRP (dBm)' : 'SINR (dB)';

    const isRSRP = type === 'RSRP';
    const key = isRSRP ? 'rsrp' : 'sinr';
    const buckets = isRSRP ? [
      { label: '-85 ~ -0', color: '#0042a5', fn: v => v >= -85 && v < 0 },
      { label: '-95 ~ -85', color: '#00a955', fn: v => v >= -95 && v < -85 },
      { label: '-105 ~ -95', color: '#70ff66', fn: v => v >= -105 && v < -95 },
      { label: '-120 ~ -105', color: '#fffb00', fn: v => v >= -120 && v < -105 },
      { label: '-140 ~ -120', color: '#ff3333', fn: v => v >= -140 && v < -120 },
      { label: '< -140', color: '#800000', fn: v => v < -140 },
    ] : [
      { label: '20 ~ 40', color: '#0042a5', fn: v => v >= 20 && v < 40 },
      { label: '10 ~ 20', color: '#00a955', fn: v => v >= 10 && v < 20 },
      { label: '0 ~ 10', color: '#70ff66', fn: v => v >= 0 && v < 10 },
      { label: '-5 ~ 0', color: '#fffb00', fn: v => v >= -5 && v < 0 },
      { label: '-40 ~ -5', color: '#ff3333', fn: v => v >= -40 && v < -5 },
      { label: '< -40', color: '#800000', fn: v => v < -40 },
    ];

    const total = rsrpResults.length || 1;
    tbody.innerHTML = buckets.map(b => {
      const cnt = rsrpResults.filter(r => b.fn(parseFloat(r[key] || 0))).length;
      return `<tr>
        <td><div style="width:16px;height:16px;background:${b.color};border-radius:3px;border:1px solid #ccc;display:inline-block;"></div></td>
        <td>${b.label}</td>
        <td><b>${((cnt / total) * 100).toFixed(1)}%</b></td>
      </tr>`;
    }).join('');
    legend.style.display = 'block';
  }

  // ── Result box ────────────────────────────────────────────────────────────────
  function showResultBox(type) {
    const box = document.getElementById('resultBox');
    if (!box) return;
    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (type === 'RSRP') {
      s('resultTitle', 'Kalkulasi RSRP Selesai');
      s('resultStats', `${rsrpResults.length} titik dianalisis`);
      s('resultMessage', 'Data RSRP siap untuk diekspor');
    } else {
      s('resultTitle', 'Kalkulasi SINR Selesai');
      s('resultStats', `${rsrpResults.length} titik dengan RSRP + SINR`);
      s('resultMessage', 'Simulasi lengkap, siap diekspor');
    }
    box.style.display = 'block';
  }

  // ── Export CSV ────────────────────────────────────────────────────────────────
  function exportToCSV() {
    if (!rsrpResults.length) return alert('Belum ada data untuk diekspor!');
    const hasSINR = !!rsrpResults[0].sinr;

    let csv = 'Point,Lat,Lng,Distance(m),Bearing(deg),ServingSector,AntennaGain(dB),PathLoss(dB),ClutterLoss(dB),Clutter,Model,RSRP(dBm)';
    if (hasSINR) csv += ',SINR(dB)';
    csv += '\n';
    rsrpResults.forEach(r => {
      csv += `${r.index},${r.lat},${r.lng},${r.distance},${r.bearing},${r.sectorIdx},${r.antennaGain},${r.pathLoss},${r.clutterLoss},${r.clutter},${r.scenario},${r.rsrp}`;
      if (hasSINR) csv += `,${r.sinr}`;
      csv += '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `DriveTest_${driveTestData.siteId}_${ts}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert(`Data berhasil diekspor!\nIncluded: RSRP${hasSINR ? ', SINR' : ''}, Antenna Gain, Bearing, Serving Sector`);
  }

  window.generateSamplingPoints = generateSamplingPoints;
  window.calculateRSRP = calculateRSRP;
  window.calculateSINR = calculateSINR;
  window.exportToCSV = exportToCSV;

})();

console.log('Simulation.js loaded - — 3GPP TR 38.901 V16.1.0 dual-slope corrected');