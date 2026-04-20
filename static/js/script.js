// ================= GLOBAL =================
let map;
let siteLayer, sectorLayer;
let ringLayer, mainRouteLayer, altRouteLayer, samplingLayer;

let siteIndex = {};
let selectedSite = null;
let ringPoints = [];
let mainRouteData = null;
let altRouteData = null;

// ✅ NEWː track rute mana yang aktif untuk simulasi
let activeRoute = 'main'; // 'main' | 'alt'

const SESSION_KEY = 'siteIndexData'; // key sessionStorage

const SECTOR_COLORS = [
  '#ff2d55',
  '#00c7be',
  '#ffcc00',
  '#af52de',
  '#ff9500',
  '#34c759'
];

// ================= INIT MAP =================
document.addEventListener("DOMContentLoaded", () => {
  const mapElement = document.getElementById("map");
  if (!mapElement) {
    console.log('⏭️ Map element not found - skipping route map initialization');
    return;
  }

  map = L.map("map").setView([-6.2, 106.816], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);

  siteLayer = L.layerGroup().addTo(map);
  sectorLayer = L.layerGroup().addTo(map);
  samplingLayer = L.layerGroup().addTo(map);

  createSiteBadge();
  setupEventListeners();

  // ✅ Restore siteIndex dari sessionStorage kalau sudah pernah upload
  restoreSiteIndex();
});

// ================= RESTORE DARI SESSION =================
function restoreSiteIndex() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;

  try {
    const parsed = JSON.parse(saved);
    if (!parsed || Object.keys(parsed).length === 0) return;

    siteIndex = parsed;
    renderSitesOnMap();
    populateSiteSearch();

    const count = Object.keys(siteIndex).length;
    updateUploadStatus(`✅ ${count} site`);

    console.log(`✅ Restored ${count} sites from sessionStorage`);
  } catch (e) {
    console.warn('Gagal restore sessionStorage:', e);
    sessionStorage.removeItem(SESSION_KEY);
  }
}

// Render semua site ke peta (dipakai saat restore)
function renderSitesOnMap() {
  siteLayer.clearLayers();
  sectorLayer.clearLayers();

  // ✅ Pakai cluster group — otomatis kelompokkan marker berdekatan
  const clusterGroup = L.markerClusterGroup({
    chunkedLoading: true,          // render bertahap, tidak blocking UI
    chunkInterval: 100,            // render tiap 100ms sekali
    chunkDelay: 50,
    maxClusterRadius: 60,          // radius cluster dalam pixel
    disableClusteringAtZoom: 15,   // zoom 15+ tampilkan marker individual
    spiderfyOnMaxZoom: true
  });

  const bounds = [];

  Object.entries(siteIndex).forEach(([id, s]) => {
    bounds.push([s.lat, s.lng]);

    const marker = L.circleMarker([s.lat, s.lng], {
      radius: 7,
      fillColor: "#ffd000",
      color: "#000",
      weight: 1.5,
      fillOpacity: 1
    });

    // ✅ Tooltip hanya muncul saat hover — bukan permanent
    marker.bindTooltip(id, {
      permanent: false,    // ← INI perubahan paling penting
      direction: "top",
      offset: [0, -8],
      className: 'site-label'
    });

    // ✅ Popup dibuat saat diklik, bukan sebelumnya
    marker.bindPopup(`
            <b>SITE: ${id}</b><br>
            Lat: ${s.lat.toFixed(6)}<br>
            Lng: ${s.lng.toFixed(6)}<br>
            Height: ${s.height}m
        `);

    clusterGroup.addLayer(marker);
  });

  // Tambah cluster ke map
  siteLayer.addLayer(clusterGroup);

  if (bounds.length > 0) map.fitBounds(bounds);
}

// ================= EVENTS =================
function setupEventListeners() {
  const fileInput = document.getElementById("fileInput");
  const siteSearch = document.getElementById("siteSearch");
  const btnGenerateRing = document.getElementById("btnGenerateRing");
  const btnMainRoute = document.getElementById("btnMainRoute");
  const btnAltRoute = document.getElementById("btnAltRoute");
  const btnSampling = document.getElementById("btnSampling");
  const resetBtn = document.getElementById("btnReset");
  const exportBtn = document.getElementById("btnExportKML");
  const simulateBtn = document.getElementById("btnSimulate");
  const clearSiteBtn = document.getElementById("btnClearSite");

  if (fileInput) fileInput.addEventListener("change", processXLSX);
  if (siteSearch) siteSearch.addEventListener("input", onSiteSelect);
  if (btnGenerateRing) btnGenerateRing.addEventListener("click", () => generateRing(150));
  if (btnMainRoute) btnMainRoute.addEventListener("click", generateMainRoute);
  if (btnAltRoute) btnAltRoute.addEventListener("click", generateAltRoute);
  if (btnSampling) btnSampling.addEventListener("click", generateSampling);
  if (resetBtn) resetBtn.addEventListener("click", resetAll);
  if (exportBtn) exportBtn.addEventListener("click", exportToKML);
  if (simulateBtn) simulateBtn.addEventListener("click", goToSimulation);

  // ✅ Tombol hapus data site (paksa upload ulang)
  if (clearSiteBtn) {
    clearSiteBtn.addEventListener("click", () => {
      if (!confirm("Hapus data site yang tersimpan? Kamu harus upload file XLSX lagi.")) return;
      sessionStorage.removeItem(SESSION_KEY);
      siteIndex = {};
      siteLayer.clearLayers();
      sectorLayer.clearLayers();
      populateSiteSearch();
      updateUploadStatus('');
      console.log('🗑️ Site data cleared from sessionStorage');
    });
  }
}

// ================= UPLOAD STATUS HELPER =================
function updateUploadStatus(msg) {
  const el = document.getElementById("uploadStatus");
  if (el) el.textContent = msg;
}

// ================= UI BADGE =================
function createSiteBadge() {
  const badge = L.control({ position: "topright" });
  badge.onAdd = () => {
    const div = L.DomUtil.create("div", "site-badge");
    div.id = "siteBadge";
    div.style.cssText =
      "background:linear-gradient(135deg, #1f3c88 0%, #2850b0 100%);color:#fff;padding:12px 18px;border-radius:10px;font-weight:bold;display:none;box-shadow:0 4px 12px rgba(31,60,136,0.3);border:2px solid rgba(255,255,255,0.2)";
    return div;
  };
  badge.addTo(map);
}

function updateSiteBadge(id) {
  const b = document.getElementById("siteBadge");
  if (b) {
    b.style.display = "block";
    b.innerHTML = `SITE ID: <span style="font-size:18px;letter-spacing:1px">${id}</span>`;
  }
}

// ================= GEO =================
function destinationPoint(lat, lng, az, dist) {
  const R = 6378137;
  const brng = az * Math.PI / 180;
  const d = dist / R;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
}

function bearing(a, b) {
  const y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  const x =
    Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) -
    Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
    Math.cos((b.lng - a.lng) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function distance(a, b) {
  const R = 6378137;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const a1 = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a1), Math.sqrt(1 - a1));
}

// ================= XLSX PROCESSING — upload ke Flask =================
async function processXLSX(e) {
  const file = e.target.files[0];
  if (!file) return;

  const fileSizeMB = file.size / (1024 * 1024);
  const estimatedSeconds = Math.max(5, Math.round(2 + fileSizeMB * 30));

  showLoadingWithProgress('Mengunggah dan memproses data site...', 0, estimatedSeconds);

  const startTime = Date.now();
  let progressInterval;

  try {
    // Animasi progress bar sementara menunggu response server
    let fakeProgress = 0;
    progressInterval = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      fakeProgress = Math.min(85, Math.round((elapsed / estimatedSeconds) * 85));
      const remaining = Math.max(0, estimatedSeconds - Math.round(elapsed));
      updateLoadingProgress(fakeProgress, `Memproses file... (~${remaining}s tersisa)`);
    }, 300);

    // ✅ Kirim file ke Flask via FormData
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/upload-site', {
      method: 'POST',
      body: formData
    });

    clearInterval(progressInterval);
    updateLoadingProgress(92, 'Menerima data dari server...');

    const json = await res.json();

    if (!res.ok || !json.success) {
      throw new Error(json.error || 'Upload gagal');
    }

    updateLoadingProgress(97, 'Menyusun tampilan peta...');
    await new Promise(r => setTimeout(r, 150));

    // ✅ Simpan ke siteIndex dan sessionStorage
    siteIndex = json.siteIndex;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));

    // Render ke peta
    renderSitesOnMap();
    populateSiteSearch();
    hideLoading();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const count = json.siteCount;

    updateUploadStatus(`✅ ${count} site`);
    alert(`✅ Berhasil load ${count} site dari "${json.filename}" dalam ${elapsed} detik.\n\nData tersimpan — tidak perlu upload ulang saat kembali ke halaman ini.`);

  } catch (err) {
    if (progressInterval) clearInterval(progressInterval);
    hideLoading();
    console.error('Error upload XLSX:', err);
    alert('❌ Gagal memproses file: ' + err.message);
  }

  // Reset input agar file yang sama bisa di-upload lagi jika perlu
  e.target.value = '';
}

// ================= SEARCH =================
function populateSiteSearch() {
  const list = document.getElementById("siteList");
  if (!list) return;
  list.innerHTML = "";
  Object.keys(siteIndex).sort().forEach(id => {
    const o = document.createElement("option");
    o.value = id;
    list.appendChild(o);
  });
}

function onSiteSelect() {
  const id = document.getElementById("siteSearch").value.trim();
  if (!siteIndex[id]) return;

  selectedSite = id;
  updateSiteBadge(id);

  const el = document.getElementById("currentSite");
  if (el) el.textContent = id;

  sectorLayer.clearLayers();

  const s = siteIndex[id];
  s.sectors.forEach((az, idx) => {
    drawSectorFan(s.lat, s.lng, az, 65, 150, idx);
  });

  map.setView([s.lat, s.lng], 16);
}

// ================= SECTOR FAN =================
function drawSectorFan(lat, lng, az, beamwidth, radius, sectorIndex) {
  const start = az - beamwidth / 2;
  const end = az + beamwidth / 2;
  const pts = [[lat, lng]];

  for (let i = 0; i <= 16; i++) {
    const ang = start + (i / 16) * (end - start);
    const p = destinationPoint(lat, lng, ang, radius);
    pts.push([p.lat, p.lng]);
  }
  pts.push([lat, lng]);

  const color = SECTOR_COLORS[sectorIndex % SECTOR_COLORS.length];

  L.polygon(pts, {
    color, fillColor: color, fillOpacity: 0.15, weight: 2, opacity: 0.6
  }).addTo(sectorLayer)
    .bindPopup(`<b>Sektor ${sectorIndex + 1}</b><br>Azimuth: ${az}°<br>Beamwidth: ${beamwidth}°`);
}

// ================= RING =================
function generateRing(radius = 150) {
  if (!selectedSite) return alert("⚠️ Pilih site dulu");

  if (ringLayer) map.removeLayer(ringLayer);
  ringPoints = [];

  const s = siteIndex[selectedSite];
  for (let d = 0; d <= 360; d += 10) {
    ringPoints.push(destinationPoint(s.lat, s.lng, d, radius));
  }

  ringLayer = L.polyline(
    ringPoints.map(p => [p.lat, p.lng]),
    { color: "#00ffff", dashArray: "6 6", weight: 2 }
  ).addTo(map);

  alert(`✅ Ring radius ${radius}m berhasil dibuat`);
}

// ================= MAIN / ALT ROUTE =================
async function generateMainRoute() {
  if (!selectedSite) return alert("⚠️ Pilih site dulu");
  await buildRoute(150, false);
}

async function generateAltRoute() {
  if (!selectedSite) return alert("⚠️ Pilih site dulu");
  await buildRoute(250, true);
}

// ================= ACTIVE ROUTE SELECTOR =================
// ✅ Tampilkan UI toggle pemilihan rute aktif untuk simulasi
// ✅ Tampilkan selector dari HTML (bukan floating pill)
function showRouteSelector() {
  const selector = document.getElementById("routeSelector");
  if (selector) selector.style.display = "block";
  updateRouteSelectorUI();
}

// ✅ Update styling tombol sesuai activeRoute
function updateRouteSelectorUI() {
  const btnMain = document.getElementById("btnSelectMain");
  const btnAlt = document.getElementById("btnSelectAlt");
  if (!btnMain || !btnAlt) return;

  btnMain.className = "route-select-btn" + (activeRoute === 'main' ? " active-main" : "");
  btnAlt.className = "route-select-btn" + (activeRoute === 'alt' ? " active-alt" : "");
}

// ✅ Set rute aktif
function setActiveRoute(type) {
  activeRoute = type;
  updateRouteSelectorUI();
  console.log(`✅ Rute aktif: ${type === 'main' ? '🔵 Rute Utama' : '🟠 Rute Alternatif'}`);
}

// ================= SAMPLING =================
function generateSampling() {
  if (!mainRouteLayer || !selectedSite) {
    return alert("⚠️ Generate rute utama dulu sebelum membuat titik sampling");
  }

  samplingLayer.clearLayers();

  const s = siteIndex[selectedSite];
  const pts = mainRouteLayer.getLatLngs();
  const samplingPoints = {};

  s.sectors.forEach((az, idx) => {
    let bestPoint = null;
    let minAngleDiff = Infinity;

    pts.forEach((p, i) => {
      if (i === 0) return;
      const dir = bearing({ lat: s.lat, lng: s.lng }, { lat: p.lat, lng: p.lng });
      let angleDiff = Math.abs(dir - az);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;

      if (angleDiff < 30 && angleDiff < minAngleDiff) {
        minAngleDiff = angleDiff;
        bestPoint = p;
      }
    });

    if (bestPoint) {
      samplingPoints[idx] = bestPoint;
      const color = SECTOR_COLORS[idx % SECTOR_COLORS.length];
      L.circleMarker(bestPoint, {
        radius: 6, fillColor: color, color: '#000', weight: 2, fillOpacity: 1
      }).addTo(samplingLayer)
        .bindPopup(`<b>📍 Titik Sampling Sektor ${idx + 1}</b><br>Azimuth: ${az}°`);
    }
  });

  updateSamplingLegend(s.sectors);

  const found = Object.values(samplingPoints).filter(p => p !== null).length;
  updateElement("samplingCount", `${found} dari ${s.sectors.length} sektor`);
  alert(`✅ Berhasil generate ${found} titik sampling dari ${s.sectors.length} sektor`);
}

function updateSamplingLegend(sectors) {
  const legend = document.getElementById("samplingLegend");
  const content = document.getElementById("legendContent");
  if (!legend || !content) return;

  content.innerHTML = '';
  sectors.forEach((az, idx) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.style.cssText = "display:flex;align-items:center;margin-bottom:8px;font-size:13px";

    const dot = document.createElement("div");
    dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${SECTOR_COLORS[idx % SECTOR_COLORS.length]};margin-right:8px;border:2px solid #333`;

    const text = document.createElement("span");
    text.textContent = `Sektor ${idx + 1} (${az}°)`;

    item.appendChild(dot);
    item.appendChild(text);
    content.appendChild(item);
  });

  legend.style.display = "block";
}

// ================= ROUTE BUILDER =================
async function buildRoute(radius, isAlt) {
  if (!selectedSite) return;

  const routeType = isAlt ? "alternatif" : "utama";
  updateRouteInfo({ loading: true, type: routeType });
  generateRing(radius);

  const coords = ringPoints.map(p => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (!json.routes || json.routes.length === 0) throw new Error("Tidak ada rute ditemukan");

    const route = json.routes[0];
    const pts = route.geometry.coordinates.map(c => [c[1], c[0]]);

    if (isAlt && altRouteLayer) map.removeLayer(altRouteLayer);
    if (!isAlt && mainRouteLayer) map.removeLayer(mainRouteLayer);

    const layer = L.polyline(pts, {
      color: isAlt ? "#ff8800" : "#0066ff", weight: 5, opacity: 0.7
    }).addTo(map);

    if (isAlt) { altRouteLayer = layer; altRouteData = route; }
    else { mainRouteLayer = layer; mainRouteData = route; }

    map.fitBounds(layer.getBounds());
    updateRouteInfo(route, isAlt);

    // ✅ Aktifkan tombol simulasi setelah rute pertama berhasil di-generate
    // ✅ Jika alt route selesai, otomatis set activeRoute = 'alt' dan tampilkan selector
    if (isAlt) {
      activeRoute = 'alt';
      showRouteSelector();
    } else {
      // Rute utama selesai: tampilkan selector hanya jika alt route sudah ada
      if (altRouteLayer) showRouteSelector();
      const btn = document.getElementById("btnSimulate");
      if (btn) { btn.disabled = false; btn.style.opacity = "1"; btn.style.cursor = "pointer"; }
    }

    // ✅ Pastikan btnSimulate aktif setelah rute manapun berhasil
    const btn = document.getElementById("btnSimulate");
    if (btn) { btn.disabled = false; btn.style.opacity = "1"; btn.style.cursor = "pointer"; }

  } catch (e) {
    console.error(e);
    updateRouteInfo({ error: true, message: e.message || "Route error - cek koneksi" });
  }
}

// ================= INFO =================
function updateRouteInfo(route, isAlt = false) {
  const infoDiv = document.getElementById("infoText");
  if (!infoDiv) return;

  if (route.loading) {
    infoDiv.textContent = `⏳ Generating rute ${route.type}...`;
    infoDiv.classList.add("show");
    return;
  }
  if (route.error) {
    infoDiv.textContent = `❌ ${route.message}`;
    infoDiv.classList.add("show");
    return;
  }

  const dist = (route.distance / 1000).toFixed(2);
  const dur = Math.round(route.duration / 60);
  const speed = Math.round((route.distance / route.duration) * 3.6);
  const icon = isAlt ? "🟠" : "🔵";
  const type = isAlt ? "ALT ROUTE" : "MAIN ROUTE";

  let msg = `${icon} ${type} OK | ${dist} km | ${dur} menit | ${speed} km/jam`;
  const warns = [];

  if (dur > 20) warns.push("⚠️ Potensi akses sulit");
  if (speed < 25) warns.push("🏘️ Indikasi perumahan");
  if (speed > 50) warns.push("🛣️ Jalan besar");

  let roadAnalysis = { residential: 0, deadEnd: 0 };
  if (route.legs?.[0]?.steps) {
    roadAnalysis = analyzeRoadTypes(route.legs[0].steps);
    if (roadAnalysis.residential > 30) warns.push("🏘️ Mayoritas komplek");
    if (roadAnalysis.deadEnd > 0) warns.push(`⚠️ ${roadAnalysis.deadEnd} potensi gang buntu`);
  }

  if (warns.length) msg += " | " + warns.join(" | ");

  infoDiv.innerHTML = msg;
  infoDiv.classList.add("show");

  if (isAlt) {
    updateElement("altDistance", `${dist} km`);
    updateElement("altTime", `${dur} menit`);
    updateElement("altSpeed", `${speed} km/jam`);
    updateElement("altStatus", "✅ Aktif");
  } else {
    updateElement("totalDistance", `${dist} km`);
    updateElement("estTime", `${dur} menit`);
    updateElement("avgSpeed", `${speed} km/jam`);
    updateElement("statusDeadEnd",
      roadAnalysis.deadEnd > 0
        ? `❌ ${roadAnalysis.deadEnd} Potensi Gang Buntu`
        : `✅ Tidak ada gang buntu terdeteksi`
    );
    updateElement("statusRoadType",
      roadAnalysis.residential > 50 ? `🏘️ Wilayah Kompleks (${roadAnalysis.residential}%)` :
        roadAnalysis.residential > 30 ? `🏘️ Sebagian Kompleks (${roadAnalysis.residential}%)` :
          `🛣️ Jalan Umum/Besar`
    );
  }
}

function updateElement(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function analyzeRoadTypes(steps) {
  const analysis = { residential: 0, deadEnd: 0, totalDistance: 0 };
  steps.forEach(step => {
    const dist = step.distance || 0;
    analysis.totalDistance += dist;
    const name = (step.name || "").toLowerCase();
    if (name.includes("residential") || name.includes("perumahan") ||
      name.includes("komplek") || name.includes("gang")) {
      analysis.residential += dist;
    }
    if (step.maneuver?.type === "turn" && step.maneuver?.modifier === "uturn") {
      analysis.deadEnd++;
    }
  });
  if (analysis.totalDistance > 0) {
    analysis.residential = Math.round((analysis.residential / analysis.totalDistance) * 100);
  }
  return analysis;
}

// ================= RESET =================
function resetAll() {
  if (!confirm("Reset semua rute dan data? Site data akan tetap tersimpan.")) return;

  if (ringLayer) map.removeLayer(ringLayer);
  if (mainRouteLayer) map.removeLayer(mainRouteLayer);
  if (altRouteLayer) map.removeLayer(altRouteLayer);
  sectorLayer.clearLayers();
  samplingLayer.clearLayers();

  ringLayer = mainRouteLayer = altRouteLayer = mainRouteData = altRouteData = null;
  ringPoints = [];

  // ✅ Reset state rute aktif dan sembunyikan selector
  activeRoute = 'main';
  const selector = document.getElementById("routeSelector");
  if (selector) selector.style.display = "none";

  const infoDiv = document.getElementById("infoText");
  if (infoDiv) infoDiv.classList.remove("show");

  const legend = document.getElementById("samplingLegend");
  if (legend) legend.style.display = "none";

  ["totalDistance", "estTime", "avgSpeed", "samplingCount", "altDistance", "altTime", "altSpeed"]
    .forEach(id => updateElement(id, "-"));
  updateElement("altStatus", "Belum di-generate");
  updateElement("statusDeadEnd", "⏳ Menunggu analisis rute...");
  updateElement("statusRoadType", "⏳ Menunggu analisis jalan...");

  const btn = document.getElementById("btnSimulate");
  if (btn) { btn.disabled = true; btn.style.opacity = "0.5"; btn.style.cursor = "not-allowed"; }

  // Gambar ulang sector dari site yang terpilih
  if (selectedSite && siteIndex[selectedSite]) {
    const s = siteIndex[selectedSite];
    map.setView([s.lat, s.lng], 16);
    s.sectors.forEach((az, idx) => drawSectorFan(s.lat, s.lng, az, 65, 150, idx));
  }

  alert("✅ Reset berhasil! Data site tetap tersimpan.");
}

// ================= KML EXPORT =================
function exportToKML() {
  if (!mainRouteLayer && !altRouteLayer) return alert("⚠️ Belum ada rute yang di-generate!");
  downloadKML(generateKML());
}

function generateKML() {
  const siteInfo = selectedSite ? siteIndex[selectedSite] : null;
  const siteName = selectedSite || "Unknown_Site";

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>Route ${esc(siteName)}</name>
<description>Generated by Drive Test Planner 5G</description>
<Style id="mainRouteStyle"><LineStyle><color>ffff6600</color><width>4</width></LineStyle></Style>
<Style id="altRouteStyle"><LineStyle><color>ff0088ff</color><width>4</width></LineStyle></Style>
<Style id="siteStyle"><IconStyle><color>ff00d0ff</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-circle.png</href></Icon></IconStyle></Style>
<Style id="samplingStyle"><IconStyle><color>ff00ff00</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon></IconStyle></Style>
`;

  if (siteInfo) {
    kml += `<Placemark><name>Site ${esc(siteName)}</name>
<description>Lat ${siteInfo.lat.toFixed(6)} Lng ${siteInfo.lng.toFixed(6)} Height ${siteInfo.height}m</description>
<styleUrl>#siteStyle</styleUrl>
<Point><coordinates>${siteInfo.lng},${siteInfo.lat},0</coordinates></Point></Placemark>\n`;
  }

  if (mainRouteLayer) {
    const c = mainRouteLayer.getLatLngs().map(p => `${p.lng},${p.lat},0`).join(' ');
    kml += `<Placemark><name>Main Route</name><styleUrl>#mainRouteStyle</styleUrl>
<LineString><tessellate>1</tessellate><coordinates>${c}</coordinates></LineString></Placemark>\n`;
  }

  if (altRouteLayer) {
    const c = altRouteLayer.getLatLngs().map(p => `${p.lng},${p.lat},0`).join(' ');
    kml += `<Placemark><name>Alt Route</name><styleUrl>#altRouteStyle</styleUrl>
<LineString><tessellate>1</tessellate><coordinates>${c}</coordinates></LineString></Placemark>\n`;
  }

  if (samplingLayer?.getLayers().length > 0) {
    samplingLayer.getLayers().forEach((marker, idx) => {
      const ll = marker.getLatLng();
      kml += `<Placemark><name>Point ${idx + 1}</name><styleUrl>#samplingStyle</styleUrl>
<Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point></Placemark>\n`;
    });
  }

  kml += `</Document>\n</kml>`;
  return kml;
}

function downloadKML(content) {
  const siteName = selectedSite || "DriveTest";
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `Route_${siteName}_${timestamp}.kml`;
  const blob = new Blob([content], { type: 'application/vnd.google-earth.kml+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  alert(`✅ KML berhasil di-export: ${filename}`);
}

// ================= GO TO SIMULATION =================
function goToSimulation() {
  if (!selectedSite || !mainRouteLayer || !mainRouteData) {
    return alert("⚠️ Generate rute utama terlebih dahulu!");
  }

  // ✅ Validasi: jika activeRoute = 'alt', pastikan alt route sudah ada
  if (activeRoute === 'alt' && (!altRouteLayer || !altRouteData)) {
    return alert("⚠️ Rute alternatif belum di-generate!");
  }

  const siteData = siteIndex[selectedSite];

  // ✅ Pilih layer dan data sesuai activeRoute
  const chosenLayer = activeRoute === 'alt' ? altRouteLayer : mainRouteLayer;
  const chosenData = activeRoute === 'alt' ? altRouteData : mainRouteData;
  const routeLabel = activeRoute === 'alt' ? 'alt' : 'main';

  const driveTestData = {
    siteId: selectedSite,
    activeRoute: routeLabel, // ✅ kirim info rute mana yang dipakai
    site: {
      lat: siteData.lat,
      lng: siteData.lng,
      height: siteData.height || 30,
      sectors: siteData.sectors,
      clutter: siteData.clutter || 'N/A',
      scenario: siteData.scenario || 'uma',
      condition: siteData.condition || 'nlos',
    },
    mainRoute: {
      coords: mainRouteLayer.getLatLngs().map(p => ({ lat: p.lat, lng: p.lng })),
      distance: mainRouteData.distance,
      duration: mainRouteData.duration
    },
    altRoute: altRouteData ? {
      coords: altRouteLayer.getLatLngs().map(p => ({ lat: p.lat, lng: p.lng })),
      distance: altRouteData.distance,
      duration: altRouteData.duration
    } : null,
    // ✅ Rute yang benar-benar dipakai untuk simulasi
    activeRouteData: {
      coords: chosenLayer.getLatLngs().map(p => ({ lat: p.lat, lng: p.lng })),
      distance: chosenData.distance,
      duration: chosenData.duration
    },
    samplingPoints: samplingLayer?.getLayers().length > 0
      ? samplingLayer.getLayers().map(m => { const ll = m.getLatLng(); return { lat: ll.lat, lng: ll.lng }; })
      : [],
    timestamp: new Date().toISOString()
  };

  try {
    sessionStorage.setItem('driveTestData', JSON.stringify(driveTestData));
    window.location.href = '/drivetest';
  } catch (e) {
    console.error("❌ Error saving data:", e);
    alert("❌ Error menyimpan data: " + e.message);
  }
}

// ================= LOADING =================
function showLoadingWithProgress(text, progress, estimatedSeconds) {
  hideLoading();
  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';
  overlay.id = 'loadingOverlay';
  overlay.innerHTML = `
    <div class="loading-content">
      <div class="spinner"></div>
      <p class="loading-text" id="loadingText">${text}</p>
      ${estimatedSeconds !== null ? `
        <p class="loading-est" id="loadingEst">Estimasi waktu: ~${estimatedSeconds} detik</p>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" id="progressBarFill" style="width:${progress}%"></div>
        </div>
        <p class="progress-label" id="progressLabel">${progress}%</p>
      ` : ''}
    </div>`;
  document.body.appendChild(overlay);
}

function showLoading(text = 'Memproses...') { showLoadingWithProgress(text, 0, null); }

function updateLoadingProgress(progress, text) {
  const fill = document.getElementById('progressBarFill');
  const label = document.getElementById('progressLabel');
  const txt = document.getElementById('loadingText');
  if (fill) fill.style.width = `${progress}%`;
  if (label) label.textContent = `${progress}%`;
  if (txt && text) txt.textContent = text;
}

function hideLoading() {
  document.getElementById('loadingOverlay')?.remove();
}

console.log('✅ script.js loaded — upload via Flask, restore via sessionStorage');