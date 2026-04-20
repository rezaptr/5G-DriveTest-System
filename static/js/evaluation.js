// ================================================
// EVALUATION PAGE
// ================================================

// Global Variables
let map;
let routeLayer, siteLayer, spiderLayer;
let simulationData = null;
let currentMetric = 'rsrp';
let cdfChart = null;
let siteLatLng = null; // ✅ Titik acuan site

// ================================================
// LEGEND DEFINITIONS
// ================================================
const RSRP_LEGEND = [
  { label: '-85 ~ 0',     color: '#0042a5', fn: v => v >= -85  && v < 0    },
  { label: '-95 ~ -85',   color: '#00a955', fn: v => v >= -95  && v < -85  },
  { label: '-105 ~ -95',  color: '#70ff66', fn: v => v >= -105 && v < -95  },
  { label: '-120 ~ -105', color: '#fffb00', fn: v => v >= -120 && v < -105 },
  { label: '-140 ~ -120', color: '#ff3333', fn: v => v >= -140 && v < -120 },
  { label: '< -140',      color: '#800000', fn: v => v < -140  },
];

const SINR_LEGEND = [
  { label: '20 ~ 40',  color: '#0042a5', fn: v => v >= 20  && v < 40  },
  { label: '10 ~ 20',  color: '#00a955', fn: v => v >= 10  && v < 20  },
  { label: '0 ~ 10',   color: '#70ff66', fn: v => v >= 0   && v < 10  },
  { label: '-5 ~ 0',   color: '#fffb00', fn: v => v >= -5  && v < 0   },
  { label: '-40 ~ -5', color: '#ff3333', fn: v => v >= -40 && v < -5  },
  { label: '< -40',    color: '#800000', fn: v => v < -40  },
];

function getLegendBuckets(metric) {
  return metric === 'rsrp' ? RSRP_LEGEND : SINR_LEGEND;
}

function getColorForValue(value, metric) {
  const hit = getLegendBuckets(metric).find(b => b.fn(value));
  return hit ? hit.color : '#cccccc';
}

// TA Distance Segments
const DISTANCE_SEGMENTS = [
  { ta: 0, min: 0,     max: 39    },
  { ta: 1, min: 39,    max: 117   },
  { ta: 2, min: 117,   max: 273   },
  { ta: 3, min: 273,   max: 507   },
  { ta: 4, min: 507,   max: 975   },
  { ta: 5, min: 975,   max: 1755  },
  { ta: 6, min: 1755,  max: 3315  },
  { ta: 7, min: 3315,  max: 7215  },
  { ta: 8, min: 7215,  max: 15015 },
];

// ================================================
// INITIALIZATION
// ================================================
document.addEventListener('DOMContentLoaded', function () {
  initializeMap();
  attachEventListeners();
  console.log('Evaluation page initialized');
});

function initializeMap() {
  map = L.map('evaluationMap').setView([-6.2088, 106.8456], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19
  }).addTo(map);
  routeLayer  = L.layerGroup().addTo(map);
  siteLayer   = L.layerGroup().addTo(map);
  spiderLayer = L.layerGroup().addTo(map); // ✅ Layer khusus spider lines
}

function attachEventListeners() {
  document.getElementById('uploadSimResultBtn')?.addEventListener('click', () => {
    document.getElementById('simResultInput').click();
  });
  document.getElementById('simResultInput')?.addEventListener('change', handleSimUpload);
  document.getElementById('evaluateBtn')?.addEventListener('click', evaluateResults);
  document.getElementById('parameterSelect')?.addEventListener('change', (e) => {
    currentMetric = e.target.value;
    if (simulationData) displayRouteOnMap();
  });

  // ✅ Live update saat input lat/lng site berubah
  document.getElementById('siteLat')?.addEventListener('change', updateSiteAndRedraw);
  document.getElementById('siteLng')?.addEventListener('change', updateSiteAndRedraw);
}

// ================================================
// SITE INPUT — baca lat/lng dari toolbar
// ================================================
function updateSiteAndRedraw() {
  const lat = parseFloat(document.getElementById('siteLat')?.value);
  const lng = parseFloat(document.getElementById('siteLng')?.value);

  if (isFinite(lat) && isFinite(lng)) {
    siteLatLng = { lat, lng };
    console.log(`Site updated: ${lat}, ${lng}`);
  } else {
    siteLatLng = null;
  }

  if (simulationData?.length) displayRouteOnMap();
}

// ================================================
// FILE UPLOAD
// ================================================
function handleSimUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  showLoading('Memuat hasil simulasi...');
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'csv' || ext === 'txt') {
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (results) => processSimulationData(results.data),
      error: (err) => { alert('❌ Error membaca CSV: ' + err.message); hideLoading(); }
    });
  } else if (ext === 'xlsx' || ext === 'xls') {
    const reader = new FileReader();
    reader.onload = function (evt) {
      try {
        const wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
        processSimulationData(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]));
      } catch (err) {
        alert('❌ Error membaca Excel: ' + err.message);
        hideLoading();
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function processSimulationData(rows) {
  simulationData = [];

  rows.forEach((row, idx) => {
    const point    = parseFloat(row.Point || row.point || idx + 1);
    const lat      = parseFloat(row.Lat  || row.lat  || row.LAT  || row.Latitude);
    const lng      = parseFloat(row.Lng  || row.lng  || row.LONG || row.LON || row.Longitude);
    const rsrp     = parseFloat(row['RSRP(dBm)'] || row.RSRP || row.rsrp || row['RSRP (dBm)'] || row['RSRP_Sim(dBm)']);
    const sinr     = parseFloat(row['SINR(dB)']  || row.SINR || row.sinr || row['SINR (dB)'] || row['SINR_Sim(dB)'] || row['SINR_Sim_Physical(dB)']);
    const distance = parseFloat(
      row['Distance(m)'] || row.Distance || row.distance || row['DISTANCE(m)'] || 0
    );

    if (isFinite(lat) && isFinite(lng) && (isFinite(rsrp) || isFinite(sinr))) {
      simulationData.push({
        point,
        lat, lng,
        rsrp:     isFinite(rsrp) ? rsrp : null,
        sinr:     isFinite(sinr) ? sinr : null,
        distance: isFinite(distance) ? distance : 0,
      });
    }
  });

  if (simulationData.length === 0) {
    hideLoading();
    alert('❌ Tidak ada data valid.\n\nFile harus memiliki kolom:\n- Lat/Lng\n- RSRP(dBm) dan/atau SINR(dB)\n- Distance(m)');
    return;
  }

  simulationData.sort((a, b) => a.distance - b.distance);

  // ✅ Jika belum ada input site, coba tebak dari titik dengan distance terkecil
  if (!siteLatLng) {
    autoDetectSite();
  }

  const hasDist = simulationData.some(p => p.distance > 0);
  const distInfo = hasDist
    ? `Jarak: ${simulationData[0].distance.toFixed(0)}m – ${simulationData[simulationData.length-1].distance.toFixed(0)}m`
    : 'Kolom Distance(m) tidak ditemukan';

  document.getElementById('simStatus').textContent = `Sim: ✓ ${simulationData.length} pts`;
  document.getElementById('simStatus').classList.add('uploaded');

  displayRouteOnMap();
  hideLoading();
  checkReadyForEvaluation();

  console.log(`Loaded ${simulationData.length} points. ${distInfo}`);
}

// ✅ Auto-detect posisi site dari titik dengan distance paling kecil
function autoDetectSite() {
  const closestPt = simulationData.reduce((a, b) => a.distance < b.distance ? a : b);
  const latInput  = document.getElementById('siteLat');
  const lngInput  = document.getElementById('siteLng');

  // Hanya isi jika field kosong
  if (latInput && !latInput.value) latInput.value = closestPt.lat.toFixed(6);
  if (lngInput && !lngInput.value) lngInput.value = closestPt.lng.toFixed(6);

  siteLatLng = { lat: closestPt.lat, lng: closestPt.lng };
  console.log('Site auto-detected:', siteLatLng);
}

function checkReadyForEvaluation() {
  const btn = document.getElementById('evaluateBtn');
  if (btn && simulationData?.length > 0) btn.disabled = false;
}

// ================================================
// MAP DISPLAY — Spider Mode
// ================================================
function displayRouteOnMap() {
  routeLayer.clearLayers();
  spiderLayer.clearLayers();
  siteLayer.clearLayers();

  if (!simulationData?.length) return;

  const metric  = currentMetric === 'both' ? 'rsrp' : currentMetric;
  const counts  = Array(6).fill(0);
  const buckets = getLegendBuckets(metric);

  // ✅ Render site marker jika ada
  if (siteLatLng) {
    const siteIcon = L.divIcon({
      className: '',
      html: `<div class="site-marker-icon">
               <div class="site-pulse"></div>
               <i class="fas fa-broadcast-tower"></i>
             </div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    L.marker([siteLatLng.lat, siteLatLng.lng], { icon: siteIcon })
      .addTo(siteLayer)
      .bindPopup(`<b>📡 Site</b><br>Lat: ${siteLatLng.lat.toFixed(6)}<br>Lng: ${siteLatLng.lng.toFixed(6)}`);
  }

  // ✅ Gambar spider lines: dari site ke tiap titik sampling
  simulationData.forEach((point) => {
    const value = metric === 'rsrp' ? point.rsrp : point.sinr;
    if (value === null) return;

    const color = getColorForValue(value, metric);
    const bIdx  = buckets.findIndex(b => b.fn(value));
    if (bIdx >= 0) counts[bIdx]++;

    // Spider line dari site ke titik sampling
    if (siteLatLng) {
      L.polyline(
        [[siteLatLng.lat, siteLatLng.lng], [point.lat, point.lng]],
        { color: color, weight: 1.8, opacity: 0.55, dashArray: '4 3' }
      ).addTo(spiderLayer);
    }

    // Titik sampling
    L.circleMarker([point.lat, point.lng], {
      radius: 5,
      fillColor: color,
      color: '#000',
      weight: 0.8,
      fillOpacity: 0.9
    }).addTo(routeLayer)
      .bindPopup(`
        <b>Point ${point.point}</b><br>
        Jarak dari Site: <b>${point.distance.toFixed(0)} m</b><br>
        ${metric.toUpperCase()}: <b>${value.toFixed(1)} ${metric === 'rsrp' ? 'dBm' : 'dB'}</b>
      `);
  });

  updateMapLegend(counts, simulationData.length, metric);

  // Fit bounds mencakup semua titik + site
  const allLatLng = simulationData.map(p => [p.lat, p.lng]);
  if (siteLatLng) allLatLng.push([siteLatLng.lat, siteLatLng.lng]);
  map.fitBounds(allLatLng);
}

function updateMapLegend(counts, total, metric) {
  const legend = document.getElementById('mapLegend');
  const title  = document.getElementById('legendTitle');
  const tbody  = document.getElementById('legendTableBody');
  if (!legend || !title || !tbody) return;

  legend.style.display = 'block';
  title.textContent = metric === 'rsrp' ? 'RSRP (dBm)' : 'SINR (dB)';
  tbody.innerHTML = '';

  getLegendBuckets(metric).forEach((b, i) => {
    const pct = total > 0 ? ((counts[i] / total) * 100).toFixed(1) : '0.0';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><div class="color-box" style="background:${b.color}"></div></td>
      <td>${b.label}</td>
      <td><b>${pct}%</b></td>`;
    tbody.appendChild(row);
  });
}

// ================================================
// EVALUATION
// ================================================
function evaluateResults() {
  if (!simulationData?.length) {
    alert('⚠️ Upload hasil simulasi terlebih dahulu');
    return;
  }

  showLoading('Mengevaluasi hasil simulasi...');
  setTimeout(() => {
    try {
      generateSegmentTable();
      generateCDFChart();
      generateConclusion();
      hideLoading();
    } catch (err) {
      console.error(err);
      alert('❌ Error saat evaluasi: ' + err.message);
      hideLoading();
    }
  }, 400);
}

// ================================================
// SEGMENT TABLE (TA)
// ================================================
function generateSegmentTable() {
  const tbody = document.getElementById('segmentTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  let hasData = false;

  DISTANCE_SEGMENTS.forEach(seg => {
    const pts = simulationData.filter(p => p.distance >= seg.min && p.distance < seg.max);
    if (!pts.length) return;
    hasData = true;

    const domRSRP = dominantCategory(pts, 'rsrp');
    const domSINR = dominantCategory(pts, 'sinr');

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${seg.ta}</td>
      <td>${seg.min} – ${seg.max} m</td>
      <td><span class="category-badge ${badgeClass(domRSRP)}">${categoryLabel(domRSRP)}</span></td>
      <td><span class="category-badge ${badgeClass(domSINR)}">${categoryLabel(domSINR)}</span></td>`;
    tbody.appendChild(row);
  });

  if (!hasData) {
    tbody.innerHTML = '<tr><td colspan="4" class="no-data">Kolom Distance(m) tidak ditemukan atau semua jarak = 0</td></tr>';
  }
}

function dominantCategory(pts, metric) {
  const tally   = {};
  const buckets = getLegendBuckets(metric);

  pts.forEach(p => {
    const v = metric === 'rsrp' ? p.rsrp : p.sinr;
    if (v === null) return;
    const idx = buckets.findIndex(b => b.fn(v));
    const key = idx >= 0 ? buckets[idx].label : '?';
    tally[key] = (tally[key] || 0) + 1;
  });

  return Object.keys(tally).length
    ? Object.keys(tally).reduce((a, b) => tally[a] > tally[b] ? a : b)
    : '-';
}

function categoryLabel(label) { return label; }

function badgeClass(label) {
  const rsrpIdx = RSRP_LEGEND.findIndex(b => b.label === label);
  const sinrIdx = SINR_LEGEND.findIndex(b => b.label === label);
  const idx     = rsrpIdx >= 0 ? rsrpIdx : sinrIdx;
  const classes = ['sangat-baik', 'baik', 'normal', 'agak-buruk', 'buruk', 'sangat-buruk'];
  return classes[idx] ?? 'normal';
}

// ================================================
// CDF CHART
// ================================================
function generateCDFChart() {
  if (cdfChart) { cdfChart.destroy(); cdfChart = null; }

  const ctx = document.getElementById('cdfChart');
  if (!ctx) return;

  const rsrpVals = simulationData.map(p => p.rsrp).filter(v => v !== null).sort((a, b) => a - b);
  const sinrVals = simulationData.map(p => p.sinr).filter(v => v !== null).sort((a, b) => a - b);

  function buildCCDF(sorted) {
    const n = sorted.length;
    return sorted.map((v, i) => ({
      x: v,
      y: parseFloat(((1 - i / n) * 100).toFixed(2))
    }));
  }

  const rsrpCCDF = buildCCDF(rsrpVals);
  const sinrCCDF = buildCCDF(sinrVals);

  cdfChart = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'RSRP (dBm)',
          data: rsrpCCDF,
          borderColor: '#1F3C88',
          backgroundColor: 'rgba(31,60,136,0.08)',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          yAxisID: 'y',
          xAxisID: 'xRSRP',
          fill: true,
        },
        {
          label: 'SINR (dB)',
          data: sinrCCDF,
          borderColor: '#28a745',
          backgroundColor: 'rgba(40,167,69,0.06)',
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          yAxisID: 'y',
          xAxisID: 'xSINR',
          fill: true,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          callbacks: {
            title: (items) => items.map(i => {
              const unit = i.dataset.label.includes('RSRP') ? 'dBm' : 'dB';
              return `${i.dataset.label}: ${parseFloat(i.parsed.x).toFixed(1)} ${unit}`;
            }).join('  |  '),
            label: (item) => `${item.parsed.y.toFixed(1)}% titik ≥ nilai ini`,
          }
        },
      },
      scales: {
        y: {
          title: { display: true, text: '% Titik ≥ Nilai (CCDF)', font: { weight: 'bold' } },
          min: 0, max: 100,
          ticks: { callback: v => v + '%' },
          grid: { color: 'rgba(0,0,0,0.07)' }
        },
        xRSRP: {
          type: 'linear', position: 'bottom',
          title: { display: true, text: 'RSRP (dBm)', color: '#1F3C88', font: { weight: 'bold' } },
          ticks: { color: '#1F3C88' },
          grid: { color: 'rgba(31,60,136,0.08)' }
        },
        xSINR: {
          type: 'linear', position: 'top',
          title: { display: true, text: 'SINR (dB)', color: '#28a745', font: { weight: 'bold' } },
          ticks: { color: '#28a745' },
          grid: { display: false }
        }
      }
    }
  });

  renderCDFSummary(rsrpVals, sinrVals);
  console.log('CDF chart generated');
}

function renderCDFSummary(rsrpVals, sinrVals) {
  const el = document.getElementById('cdfSummary');
  if (!el) return;

  function pctAbove(vals, threshold) {
    if (!vals.length) return 0;
    return (vals.filter(v => v >= threshold).length / vals.length * 100).toFixed(1);
  }

  const rsrpRows = [
    { label: 'Sangat Baik (≥ -85 dBm)',  pct: pctAbove(rsrpVals, -85),  color: '#0042a5' },
    { label: 'Baik (≥ -95 dBm)',          pct: pctAbove(rsrpVals, -95),  color: '#00a955' },
    { label: 'Normal (≥ -105 dBm)',        pct: pctAbove(rsrpVals, -105), color: '#70cc44' },
    { label: 'Buruk (≥ -120 dBm)',         pct: pctAbove(rsrpVals, -120), color: '#e0b800' },
  ];

  const sinrRows = [
    { label: 'Sangat Baik (≥ 20 dB)',  pct: pctAbove(sinrVals, 20), color: '#0042a5' },
    { label: 'Baik (≥ 10 dB)',         pct: pctAbove(sinrVals, 10), color: '#00a955' },
    { label: 'Normal (≥ 0 dB)',        pct: pctAbove(sinrVals,  0), color: '#70cc44' },
    { label: 'Buruk (≥ -5 dB)',        pct: pctAbove(sinrVals, -5), color: '#e0b800' },
  ];

  const makeTable = (rows, metricLabel) => `
    <div class="cdf-summary-block">
      <h4>${metricLabel}</h4>
      <table class="cdf-summary-table">
        ${rows.map(r => `
          <tr>
            <td><span class="cdf-dot" style="background:${r.color}"></span>${r.label}</td>
            <td class="cdf-pct">${r.pct}%</td>
            <td class="cdf-bar-cell"><div class="cdf-bar" style="width:${r.pct}%;background:${r.color}"></div></td>
          </tr>`).join('')}
      </table>
    </div>`;

  el.innerHTML = makeTable(rsrpRows, 'RSRP Coverage') + makeTable(sinrRows, 'SINR Quality');
}

// ================================================
// CONCLUSION
// ================================================
function generateConclusion() {
  const rsrpVals = simulationData.map(p => p.rsrp).filter(v => v !== null);
  const sinrVals = simulationData.map(p => p.sinr).filter(v => v !== null);

  const pctAbove = (vals, thr) => vals.length ? vals.filter(v => v >= thr).length / vals.length * 100 : 0;

  const rsrpGood = pctAbove(rsrpVals, -95);
  const rsrpPoor = 100 - pctAbove(rsrpVals, -120);
  const sinrGood = pctAbove(sinrVals, 10);
  const sinrPoor = 100 - pctAbove(sinrVals, -5);

  let statusHtml;
  if (rsrpGood >= 70 && sinrGood >= 70) {
    statusHtml = `<div class="conclusion-success">
      <strong>✅ Kualitas Layanan Sangat Baik</strong><br>
      Coverage RSRP ≥ -95 dBm: <b>${rsrpGood.toFixed(1)}%</b> dari rute.
      SINR ≥ 10 dB: <b>${sinrGood.toFixed(1)}%</b>. Layanan di rute ini sudah optimal.
    </div>`;
  } else if (rsrpPoor > 20 || sinrPoor > 20) {
    statusHtml = `<div class="conclusion-warning">
      <strong>⚠️ Terdapat Area Bermasalah</strong><br>
      RSRP di bawah -120 dBm: <b>${rsrpPoor.toFixed(1)}%</b> titik.
      SINR di bawah -5 dB: <b>${sinrPoor.toFixed(1)}%</b> titik.
      Perlu review parameter site atau penambahan coverage.
    </div>`;
  } else {
    statusHtml = `<div class="conclusion-highlight">
      <strong>📊 Kualitas Layanan Memadai</strong><br>
      Distribusi sinyal sepanjang rute dalam batas yang dapat diterima.
      Beberapa titik mungkin dapat ditingkatkan dengan optimasi parameter.
    </div>`;
  }

  const hasDist = simulationData.some(p => p.distance > 0);
  const distNote = hasDist
    ? `Rentang jarak dari site: ${simulationData[0].distance.toFixed(0)}m – ${simulationData[simulationData.length-1].distance.toFixed(0)}m`
    : 'Kolom Distance(m) tidak terdeteksi di CSV';

  const siteNote = siteLatLng
    ? `Koordinat site: ${siteLatLng.lat.toFixed(6)}, ${siteLatLng.lng.toFixed(6)}`
    : 'Koordinat site belum diinput';

  const html = `<div class="conclusion-text">
    ${statusHtml}
    <p><strong>Detail:</strong></p>
    <ul>
      <li>Total titik sampling: <b>${simulationData.length}</b></li>
      <li>${siteNote}</li>
      <li>${distNote}</li>
      <li>RSRP ≥ -85 dBm (Sangat Baik): <b>${pctAbove(rsrpVals, -85).toFixed(1)}%</b></li>
      <li>RSRP ≥ -95 dBm (Baik+): <b>${pctAbove(rsrpVals, -95).toFixed(1)}%</b></li>
      <li>SINR ≥ 20 dB (Sangat Baik): <b>${pctAbove(sinrVals, 20).toFixed(1)}%</b></li>
      <li>SINR ≥ 10 dB (Baik+): <b>${pctAbove(sinrVals, 10).toFixed(1)}%</b></li>
    </ul>
    <p><strong>Rekomendasi:</strong></p>
    <ul>
      ${rsrpPoor > 15 || sinrPoor > 15
        ? '<li>Review parameter propagasi (tinggi antena, azimuth, tilt)</li><li>Pertimbangkan penambahan site atau repeater di area lemah</li>'
        : '<li>Coverage sudah optimal. Pertahankan konfigurasi saat ini.</li>'}
    </ul>
  </div>`;

  const el = document.getElementById('conclusionContent');
  if (el) el.innerHTML = html;
}

// ================================================
// UTILITY
// ================================================
function showLoading(text = 'Memproses...') {
  hideLoading();
  const el = document.createElement('div');
  el.className = 'loading-overlay';
  el.id = 'loadingOverlay';
  el.innerHTML = `<div class="loading-content"><div class="spinner"></div><p class="loading-text">${text}</p></div>`;
  document.body.appendChild(el);
}

function hideLoading() {
  document.getElementById('loadingOverlay')?.remove();
}

console.log('Evaluation.js loaded — Spider mode, Site anchor, Distance from CSV');