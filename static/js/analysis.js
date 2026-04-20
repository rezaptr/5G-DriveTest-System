// ================================================
// ANALYSIS PAGE - DT vs SIMULASI COMPARISON
// ================================================

// Global Variables
let dtMap, simMap;
let dtData = null;
let simData = null;
let dtLayer, simLayer;
let currentDTMetric = 'rsrp';
let currentSimMetric = 'rsrp';

// ================================================
// LEGEND DEFINITIONS (sesuai coverage.js)
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
  const buckets = getLegendBuckets(metric);
  const hit = buckets.find(b => b.fn(value));
  return hit ? hit.color : '#cccccc';
}

function getBucketIndex(value, metric) {
  return getLegendBuckets(metric).findIndex(b => b.fn(value));
}

// ================================================
// INITIALIZATION
// ================================================
document.addEventListener('DOMContentLoaded', function() {
  console.log('Analysis page initialized');
  initializeMaps();
  attachEventListeners();
});

function initializeMaps() {
  try {
    dtMap = L.map('dtMap').setView([-6.2088, 106.8456], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19
    }).addTo(dtMap);
    dtLayer = L.layerGroup().addTo(dtMap);

    simMap = L.map('simMap').setView([-6.2088, 106.8456], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19
    }).addTo(simMap);
    simLayer = L.layerGroup().addTo(simMap);

    console.log('Maps initialized successfully');
  } catch (error) {
    console.error('Error initializing maps:', error);
  }
}

function attachEventListeners() {
  document.getElementById('uploadDTBtn')?.addEventListener('click', () => {
    document.getElementById('dtFileInput').click();
  });
  document.getElementById('uploadSimBtn')?.addEventListener('click', () => {
    document.getElementById('simFileInput').click();
  });

  document.getElementById('dtFileInput')?.addEventListener('change', handleDTUpload);
  document.getElementById('simFileInput')?.addEventListener('change', handleSimUpload);

  // ✅ DUA TOMBOL — masing-masing pass metric-nya
  document.getElementById('processRSRPBtn')?.addEventListener('click', () => processAnalysis('rsrp'));
  document.getElementById('processSINRBtn')?.addEventListener('click', () => processAnalysis('sinr'));

  document.getElementById('dtMetric')?.addEventListener('change', (e) => {
    currentDTMetric = e.target.value;
    if (dtData) displayDTData();
  });
  document.getElementById('simMetric')?.addEventListener('change', (e) => {
    currentSimMetric = e.target.value;
    if (simData) displaySimData();
  });

  console.log('Event listeners attached');
}

// ================================================
// FILE UPLOAD HANDLERS
// ================================================
function handleDTUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  showLoading('Memuat Drive Test data...');

  Papa.parse(file, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    complete: function(results) {
      try {
        dtData = processDTData(results.data);
        displayDTData();
        hideLoading();
        document.getElementById('dtStatus').textContent = 'DT: ✓ Uploaded';
        document.getElementById('dtStatus').classList.add('uploaded');
        checkReadyForAnalysis();
      } catch (error) {
        console.error('Error processing DT data:', error);
        alert('❌ Error memproses data Drive Test');
        hideLoading();
      }
    },
    error: function() {
      alert('❌ Error membaca file Drive Test');
      hideLoading();
    }
  });
}

function handleSimUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  showLoading('Memuat Simulasi data...');
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'csv' || ext === 'txt') {
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: function(results) {
        try {
          simData = processSimData(results.data);
          displaySimData();
          hideLoading();
          document.getElementById('simStatus').textContent = 'Sim: ✓ Uploaded';
          document.getElementById('simStatus').classList.add('uploaded');
          checkReadyForAnalysis();
        } catch (error) {
          console.error('Error processing Sim data:', error);
          alert('❌ Error memproses data Simulasi');
          hideLoading();
        }
      },
      error: function() {
        alert('❌ Error membaca file Simulasi');
        hideLoading();
      }
    });
  } else if (ext === 'xlsx' || ext === 'xls') {
    const reader = new FileReader();
    reader.onload = function(evt) {
      try {
        const data = new Uint8Array(evt.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        simData = processSimData(rows);
        displaySimData();
        hideLoading();
        document.getElementById('simStatus').textContent = 'Sim: ✓ Uploaded';
        document.getElementById('simStatus').classList.add('uploaded');
        checkReadyForAnalysis();
      } catch (error) {
        alert('❌ Error membaca file Excel');
        hideLoading();
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function checkReadyForAnalysis() {
  const ready = dtData && simData && dtData.length > 0 && simData.length > 0;
  ['processRSRPBtn', 'processSINRBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !ready;
  });
}

// ================================================
// DATA PROCESSING
// ================================================
function processDTData(rows) {
  const out = [];
  rows.forEach(row => {
    const lat  = parseFloat(row.Latitude  || row.LAT  || row.lat  || row.Lat);
    const lng  = parseFloat(row.Longitude || row.LONG || row.lng  || row.Lng  || row.LON);
    const rsrp = parseFloat(row.RSRP || row.rsrp || row['RSRP (dBm)'] || row['RSRP(dBm)'] || row['RSRP_Sim(dBm)']);
    const sinr = parseFloat(row.SINR || row.sinr || row['SINR (dB)']  || row['SINR(dB)'] || row['SINR_Sim(dB)']);
    if (isFinite(lat) && isFinite(lng) && (isFinite(rsrp) || isFinite(sinr))) {
      out.push({ lat, lng, rsrp: isFinite(rsrp) ? rsrp : null, sinr: isFinite(sinr) ? sinr : null });
    }
  });
  console.log(`Processed ${out.length} valid DT points`);
  return out;
}

function processSimData(rows) {
  return processDTData(rows);
}

// ================================================
// DATA DISPLAY
// ================================================
function displayDTData() {
  dtLayer.clearLayers();
  if (!dtData?.length) return;

  const metric = currentDTMetric;
  const counts = Array(6).fill(0);

  dtData.forEach(point => {
    const value = metric === 'rsrp' ? point.rsrp : point.sinr;
    if (value === null) return;
    const color = getColorForValue(value, metric);
    const idx   = getBucketIndex(value, metric);
    if (idx >= 0) counts[idx]++;

    L.circleMarker([point.lat, point.lng], {
      radius: 5, fillColor: color, color: '#000', weight: 1, fillOpacity: 0.8
    }).addTo(dtLayer)
      .bindPopup(`<b>Drive Test</b><br>${metric.toUpperCase()}: ${value.toFixed(1)} ${metric === 'rsrp' ? 'dBm' : 'dB'}`);
  });

  updateLegendTable('dt', counts, dtData.length, metric);
  dtMap.fitBounds(dtData.map(p => [p.lat, p.lng]));
}

function displaySimData() {
  simLayer.clearLayers();
  if (!simData?.length) return;

  const metric = currentSimMetric;
  const counts = Array(6).fill(0);

  simData.forEach(point => {
    const value = metric === 'rsrp' ? point.rsrp : point.sinr;
    if (value === null) return;
    const color = getColorForValue(value, metric);
    const idx   = getBucketIndex(value, metric);
    if (idx >= 0) counts[idx]++;

    L.circleMarker([point.lat, point.lng], {
      radius: 5, fillColor: color, color: '#000', weight: 1, fillOpacity: 0.8
    }).addTo(simLayer)
      .bindPopup(`<b>Simulasi</b><br>${metric.toUpperCase()}: ${value.toFixed(1)} ${metric === 'rsrp' ? 'dBm' : 'dB'}`);
  });

  updateLegendTable('sim', counts, simData.length, metric);
  simMap.fitBounds(simData.map(p => [p.lat, p.lng]));
}

// ================================================
// LEGEND TABLE
// ================================================
function updateLegendTable(mapType, counts, total, metric) {
  const legendId = mapType === 'dt' ? 'dtLegend'      : 'simLegend';
  const titleId  = mapType === 'dt' ? 'dtLegendTitle' : 'simLegendTitle';
  const bodyId   = mapType === 'dt' ? 'dtLegendBody'  : 'simLegendBody';

  const legend = document.getElementById(legendId);
  const title  = document.getElementById(titleId);
  const tbody  = document.getElementById(bodyId);
  if (!legend || !title || !tbody) return;

  legend.style.display = 'block';
  title.textContent = metric === 'rsrp' ? 'RSRP (dBm)' : 'SINR (dB)';
  tbody.innerHTML = '';

  getLegendBuckets(metric).forEach((bucket, i) => {
    const pct = total > 0 ? ((counts[i] / total) * 100).toFixed(1) : '0.0';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><div class="color-box" style="background-color:${bucket.color}"></div></td>
      <td>${bucket.label}</td>
      <td><b>${pct}%</b></td>`;
    tbody.appendChild(row);
  });
}

// ================================================
// COMPARISON ANALYSIS — dipanggil dengan metric
// ================================================
function processAnalysis(metric) {
  if (!dtData || !simData) {
    alert('⚠️ Upload kedua file terlebih dahulu');
    return;
  }
  if (!dtData.length || !simData.length) {
    alert('⚠️ Data kosong, pastikan file berisi data yang valid');
    return;
  }

  const metricLabel = metric === 'rsrp' ? 'RSRP' : 'SINR';
  showLoading(`Memproses analisis ${metricLabel}...`);

  setTimeout(() => {
    try {
      const dtStats  = calculateStatistics(dtData,  metric);
      const simStats = calculateStatistics(simData, metric);

      console.log(`[${metricLabel}] DT stats:`,  dtStats);
      console.log(`[${metricLabel}] Sim stats:`, simStats);

      // Update judul tabel
      const tableTitle = document.getElementById('analysisTableTitle');
      if (tableTitle) tableTitle.textContent = `Hasil Perbandingan — ${metricLabel}`;

      updateComparisonTable(dtStats, simStats, metric);
      generateOverallAnalysis(dtStats, simStats, metric);

      hideLoading();
    } catch (error) {
      console.error('Error in analysis:', error);
      alert('❌ Error saat memproses analisis: ' + error.message);
      hideLoading();
    }
  }, 400);
}

// ================================================
// STATISTICS — berbasis 6 bucket (sesuai legend)
// ================================================
function calculateStatistics(data, metric) {
  const counts = Array(6).fill(0);
  let total = 0;

  data.forEach(point => {
    const value = metric === 'rsrp' ? point.rsrp : point.sinr;
    if (value === null) return;
    const idx = getBucketIndex(value, metric);
    if (idx >= 0) counts[idx]++;
    total++;
  });

  const pcts = counts.map(c => total > 0 ? (c / total * 100) : 0);
  return { counts, pcts, total };
}

// ================================================
// COMPARISON TABLE — 6 baris sesuai legend
// ================================================
function updateComparisonTable(dtStats, simStats, metric) {
  const buckets = getLegendBuckets(metric);
  const tbody = document.getElementById('comparisonTableBody');
  if (!tbody) return;

  tbody.innerHTML = '';

  buckets.forEach((bucket, i) => {
    const dtPct  = dtStats.pcts[i].toFixed(1);
    const simPct = simStats.pcts[i].toFixed(1);
    const delta  = (simStats.pcts[i] - dtStats.pcts[i]);
    const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%';

    let deltaClass = 'neutral';
    if (Math.abs(delta) >= 5) deltaClass = delta > 0 ? 'positive' : 'negative';

    const analysis = generateBucketAnalysis(delta, i);

    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="category-cell">
        <span class="bucket-dot" style="background:${bucket.color}"></span>
        ${bucket.label} ${metric === 'rsrp' ? 'dBm' : 'dB'}
      </td>
      <td class="data-cell">${dtPct}%</td>
      <td class="data-cell">${simPct}%</td>
      <td class="delta-cell ${deltaClass}">${deltaStr}</td>
      <td class="analysis-cell">${analysis}</td>`;
    tbody.appendChild(row);
  });
}

function generateBucketAnalysis(delta, bucketIdx) {
  const abs = Math.abs(delta).toFixed(1);
  if (Math.abs(delta) < 5) return 'Sesuai dengan hasil Drive Test';

  const isGood = bucketIdx <= 1; // bucket 0 & 1 = kualitas baik
  if (delta > 0) {
    return isGood
      ? `Simulasi overestimate (+${abs}%)`
      : `Simulasi prediksi lebih buruk (+${abs}%)`;
  } else {
    return isGood
      ? `Simulasi underestimate (-${abs}%)`
      : `Simulasi prediksi lebih baik (-${abs}%)`;
  }
}

// ================================================
// OVERALL ANALYSIS — avg delta SEMUA 6 bucket
// ================================================
function generateOverallAnalysis(dtStats, simStats, metric) {
  const metricLabel = metric === 'rsrp' ? 'RSRP' : 'SINR';
  const buckets = getLegendBuckets(metric);

  // ✅ Rata-rata delta dari SEMUA bucket (|Δ1|+|Δ2|+...+|Δ6|) / 6
  const avgDelta = buckets.reduce((sum, _, i) => {
    return sum + Math.abs(simStats.pcts[i] - dtStats.pcts[i]);
  }, 0) / buckets.length;

  // Bucket kualitas baik (0 & 1)
  const goodDtTotal  = dtStats.pcts[0]  + dtStats.pcts[1];
  const goodSimTotal = simStats.pcts[0] + simStats.pcts[1];

  let statusHtml;
  if (avgDelta < 5) {
    statusHtml = `
      <div class="analysis-success">
        <strong>✅ Model Simulasi Sangat Akurat (${metricLabel})</strong><br>
        Rata-rata selisih semua kategori hanya ${avgDelta.toFixed(1)}%. Model memberikan prediksi yang sangat mendekati Drive Test real.
      </div>`;
  } else if (avgDelta < 10) {
    statusHtml = `
      <div class="analysis-highlight">
        <strong>📊 Model Simulasi Cukup Akurat (${metricLabel})</strong><br>
        Rata-rata selisih ${avgDelta.toFixed(1)}%. Model cukup baik namun beberapa parameter dapat disesuaikan lebih lanjut.
      </div>`;
  } else if (avgDelta < 15) {
    statusHtml = `
      <div class="analysis-warning">
        <strong>⚠️ Model Perlu Penyesuaian (${metricLabel})</strong><br>
        Selisih rata-rata ${avgDelta.toFixed(1)}% cukup signifikan. Review parameter propagasi (tinggi antena, path loss model, dll).
      </div>`;
  } else {
    statusHtml = `
      <div class="analysis-warning" style="border-color:#c0392b">
        <strong>🔴 Deviasi Tinggi (${metricLabel})</strong><br>
        Selisih rata-rata ${avgDelta.toFixed(1)}% sangat signifikan. Kemungkinan ada mismatch antara kondisi lapangan dan model propagasi.
      </div>`;
  }

  const html = `
    <div class="analysis-text">
      ${statusHtml}
      <p><strong>Detail Perbandingan (${metricLabel}):</strong></p>
      <ul>
        <li>Total Point DT: <b>${dtStats.total}</b></li>
        <li>Total Point Simulasi: <b>${simStats.total}</b></li>
        <li>Coverage Kualitas Baik (bucket 1+2) — DT: <b>${goodDtTotal.toFixed(1)}%</b> | Sim: <b>${goodSimTotal.toFixed(1)}%</b></li>
        <li>Avg delta semua kategori: <b>${avgDelta.toFixed(1)}%</b></li>
      </ul>
    </div>`;

  const el = document.getElementById('overallAnalysisContent');
  if (el) el.innerHTML = html;
}

// ================================================
// UTILITY
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
  document.getElementById('loadingOverlay')?.remove();
}

console.log('Analysis.js loaded — dual RSRP/SINR analysis');