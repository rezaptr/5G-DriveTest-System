// ================= SIMULATION DT v14.0 =================
// Pendekatan: HYBRID ADVANCED — DISTRIBUTION-AWARE
//
// Peningkatan dari v13:
//
//   [SOL-1] Global Gain Correction (G)
//      - G = median(RSRP_actual) - median(RSRP_sim_before_noise)
//      - Dihitung otomatis dari data, clamp ±10 dB
//      - Mengoreksi systematic offset tanpa menyentuh bias segment
//
//   [SOL-2] Adaptive Clutter Loss  f(dist)
//      - CL(d) = base_CL × [nearScale + (farScale-nearScale)·sigmoid(d)]
//      - Dekat (<transitionM): nearScale (~0.3) → LOS dominan
//      - Jauh  (>transitionM): farScale  (~1.1) → lebih banyak obstacle
//      - Nilai base dikalibrasi ulang (urban 5→3, dense 8→5)
//
//   [SOL-3] Distribution-Based Calibration (Histogram Matching)
//      - Dry-run simulasi → bandingkan histogram sim vs aktual per bin RSRP
//      - adj[bin] = mean_actual[bin] - mean_sim[bin], clamp ±6 dB
//      - Diaplikasikan setelah G, sebelum noise
//
//   [SOL-4] Tail Compression (Nonlinear)
//      - Threshold: -115 dBm
//      - RSRP_out = threshold + (RSRP_sim - threshold) × 0.6
//      - Hard floor: -140 dBm
//
//   [SOL-5] SINR Model 3-Var (tanpa b·dist)
//      - SINR = a·RSRP + b·log10(dist) + c
//      - Hapus komponen b·dist yang menyebabkan instabilitas antar site
//      - Zone-conditional noise: std berbeda per zona RSRP (kuat/menengah/lemah)
//      - Ceiling compression: SINR > 30 dB dikompres
//
//   [SOL-6] Sample-Adaptive Bias Blending (Anti-Overfit)
//      - α = n / (n + K),  K=10 (default)
//      - bias_final = α·bias_lokal + (1-α)·bias_global
//      - Segment dengan < 5 sampel → bias mendekati global
//      - Std juga di-blend
//
// Formula akhir:
//   rsrp3gpp   = TX_POWER + antenna_gain - PL_3GPP - CL_adaptive(d) + NF_corr
//   rsrp_pre   = rsrp3gpp + bias_seg_blended + G_global
//   rsrp_raw   = rsrp_pre + distAdj[bin_RSRP] + spatialNoise(lat,lng,std_blended)
//   RSRP_sim   = tailCompression(rsrp_raw)
//
//   SINR_sim   = a·RSRP_sim + b·log10(dist) + c
//              + zoneNoise(rsrp_zone)
//              → ceilingCompression(>30 dB)
// =======================================================
(function () {
  'use strict';

  if (!document.getElementById('map-dt-sim')) return;

  // ── State ─────────────────────────────────────────────────────────────────
  let dtMap;
  let siteLayer, dtPointLayer, heatmapLayer;
  let siteIndex  = {};
  let primarySite = null;
  let dtPoints   = [];
  let simPoints  = [];
  let simResults = [];
  let calibration = null;

  const SESSION_KEY    = 'siteIndexData';
  const SECTOR_COLORS  = ['#ff2d55','#00c7be','#ffcc00','#af52de','#ff9500','#34c759'];

  // ════════════════════════════════════════════════════════════════════════
  // [1] KONSTANTA SISTEM
  // ════════════════════════════════════════════════════════════════════════
  const CAL = {
    TX_POWER   : 46,     // dBm
    FREQUENCY  : 2300,   // MHz
    MOBILE_H   : 1.5,    // m
    ANTENNA_Am : 25,     // dB front-back ratio
    BEAMWIDTH  : 65,     // derajat HPBW
    NF_THRESH  : 150,    // m near-field threshold
    NF_MAX     : -4,     // dB near-field max correction
  };

  // ════════════════════════════════════════════════════════════════════════
  // [2] TA DISTANCE SEGMENTS
  // ════════════════════════════════════════════════════════════════════════
  const DISTANCE_SEGMENTS = [
    { ta:0, min:0,     max:39    },
    { ta:1, min:39,    max:117   },
    { ta:2, min:117,   max:273   },
    { ta:3, min:273,   max:507   },
    { ta:4, min:507,   max:975   },
    { ta:5, min:975,   max:1755  },
    { ta:6, min:1755,  max:3315  },
    { ta:7, min:3315,  max:7215  },
    { ta:8, min:7215,  max:15015 },
  ];

  function getSegmentIndex(distM) {
    for (let i = 0; i < DISTANCE_SEGMENTS.length; i++) {
      if (distM >= DISTANCE_SEGMENTS[i].min && distM < DISTANCE_SEGMENTS[i].max) return i;
    }
    return DISTANCE_SEGMENTS.length - 1;
  }

  // ════════════════════════════════════════════════════════════════════════
  // [SOL-2] ADAPTIVE CLUTTER LOSS
  //
  // CL(d) = base × [nearScale + (farScale - nearScale) × sigmoid(x)]
  // x     = (d - transitionM) / transitionM
  //
  // Nilai base dikurangi dari v13 (empiris lebih akurat):
  //   dense_urban: 8 → 5 dB base
  //   urban:       5 → 3 dB base
  //   suburban:    2 → 1.5 dB base
  //
  // nearScale < 1.0 → dekat site, LOS dominan → CL berkurang
  // farScale  > 1.0 → jauh dari site → lebih banyak obstacle
  // ════════════════════════════════════════════════════════════════════════
  const CLUTTER_LOSS_CFG = {
    dense_urban : { base:5.0,  nearScale:0.25, farScale:1.2, transitionM:300 },
    urban       : { base:3.0,  nearScale:0.30, farScale:1.1, transitionM:250 },
    suburban    : { base:1.5,  nearScale:0.40, farScale:1.0, transitionM:200 },
    rural       : { base:0.0,  nearScale:1.0,  farScale:1.0, transitionM:100 },
    indoor      : { base:10.0, nearScale:0.8,  farScale:1.0, transitionM:50  },
    highway     : { base:-1.5, nearScale:1.0,  farScale:0.9, transitionM:200 },
  };

  /**
   * Hitung adaptive clutter loss berdasarkan jarak
   * @param {Object} site
   * @param {number} distM - jarak dalam meter
   * @returns {number} clutter loss dalam dB
   */
  function getAdaptiveClutterLoss(site, distM) {
    const key = (site.clutter || 'urban').toLowerCase().replace(/\s+/g,'_');
    const cfg  = CLUTTER_LOSS_CFG[key] || CLUTTER_LOSS_CFG['urban'];
    const x    = (distM - cfg.transitionM) / cfg.transitionM;
    const sig  = 1 / (1 + Math.exp(-2 * x));
    const fac  = cfg.nearScale + (cfg.farScale - cfg.nearScale) * sig;
    return cfg.base * fac;
  }

  // ════════════════════════════════════════════════════════════════════════
  // RNG: Mulberry32 (seedable)
  // ════════════════════════════════════════════════════════════════════════
  let _rng = 0;
  const seedRng = s => { _rng = s >>> 0; };
  const rng = () => {
    _rng += 0x6D2B79F5;
    let t = _rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussRng = (m, s) => {
    let u = 0, v = 0;
    while (!u) u = rng();
    while (!v) v = rng();
    return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  let activeSeed = 0;

  // ════════════════════════════════════════════════════════════════════════
  // SPATIAL SEMI-DETERMINISTIC NOISE (tidak berubah dari v13)
  // Titik berdekatan (~55m) mendapat noise yang berkorelasi
  // ════════════════════════════════════════════════════════════════════════
  const SPATIAL_GRID_SIZE = 0.0005;

  function hashInt(n) {
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = (n >>> 16) ^ n;
    return n >>> 0;
  }

  function spatialNoise(lat, lng, std, globalSeed) {
    const cellLat = Math.round(lat / SPATIAL_GRID_SIZE);
    const cellLng = Math.round(lng / SPATIAL_GRID_SIZE);
    const s1 = hashInt(cellLat * 73856093 ^ cellLng * 19349663 ^ globalSeed);
    const s2 = hashInt(s1 + 2654435761);
    const u1 = (s1 >>> 0) / 4294967296 + 1e-10;
    const u2 = (s2 >>> 0) / 4294967296 + 1e-10;
    const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return z * std;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PATH LOSS 3GPP TR 38.901 (tidak berubah dari v13)
  // ════════════════════════════════════════════════════════════════════════
  function pathLoss(sc, cond, d2D, freq, hBS, hUT) {
    const d    = Math.max(d2D, 10), hU = hUT || 1.5, fc = freq / 1000, c = 3e8;
    const d3D  = Math.sqrt(d * d + (hBS - hU) ** 2);

    const pLOS_UMa = d2 => {
      if (d2 <= 18) return 1;
      const C = hU <= 13 ? 0 : Math.pow((hU - 13) / 10, 1.5);
      return (18/d2 + Math.exp(-d2/63)*(1-18/d2)) * (1 + C*1.25*Math.pow(d2/100,3)*Math.exp(-d2/150));
    };
    const pLOS_UMi = d2 => d2 <= 18 ? 1 : 18/d2 + Math.exp(-d2/36)*(1-18/d2);

    switch (sc) {
      case 'uma': {
        const dBP = 4*(hBS-1)*(hU-1)*(freq*1e6)/c;
        const pL  = d <= dBP
          ? 28 + 22*Math.log10(d3D) + 20*Math.log10(fc)
          : 28 + 40*Math.log10(d3D) + 20*Math.log10(fc) - 9*Math.log10(dBP**2+(hBS-hU)**2);
        if (cond==='los') return pL;
        const pN = Math.max(13.54+39.08*Math.log10(d3D)+20*Math.log10(fc)-0.6*(hU-1.5), pL);
        if (cond==='nlos') return pN;
        const p = pLOS_UMa(d); return p*pL + (1-p)*pN;
      }
      case 'umi': {
        const dBP = 4*(hBS-1)*(hU-1)*(freq*1e6)/c;
        const pL  = d <= dBP
          ? 32.4 + 21*Math.log10(d3D) + 20*Math.log10(fc)
          : 32.4 + 40*Math.log10(d3D) + 20*Math.log10(fc) - 9.5*Math.log10(dBP**2+(hBS-hU)**2);
        if (cond==='los') return pL;
        const pN = Math.max(22.4+35.3*Math.log10(d3D)+21.3*Math.log10(fc)-0.3*(hU-1.5), pL);
        if (cond==='nlos') return pN;
        const p = pLOS_UMi(d); return p*pL + (1-p)*pN;
      }
      case 'rma': {
        const h=5, W=20, dBP=2*Math.PI*hBS*hU*(freq*1e6)/c;
        const A1=Math.min(0.03*Math.pow(h,1.72),10), A2=Math.min(0.044*Math.pow(h,1.72),14.77), A3=0.002*Math.log10(h);
        let pL;
        if (d <= dBP) {
          pL = 20*Math.log10(40*Math.PI*d3D*fc/3) + A1*Math.log10(d3D) - A2 + A3*d3D;
        } else {
          const db = Math.sqrt(dBP**2+(hBS-hU)**2);
          pL = 20*Math.log10(40*Math.PI*db*fc/3) + A1*Math.log10(db) - A2 + A3*db + 40*Math.log10(d3D/db);
        }
        if (cond==='los') return pL;
        return Math.max(
          161.04 - 7.1*Math.log10(W) + 7.5*Math.log10(h)
          - (24.37 - 3.7*(h/hBS)**2)*Math.log10(hBS)
          + (43.42 - 3.1*Math.log10(hBS))*(Math.log10(d3D)-3)
          + 20*Math.log10(fc) - (3.2*(Math.log10(11.75*hU))**2-4.97),
          pL
        );
      }
      default:
        return 28 + 22*Math.log10(d3D) + 20*Math.log10(fc);
    }
  }

  function antennaGain(angOff) {
    return -Math.min(12 * (angOff / (CAL.BEAMWIDTH / 2)) ** 2, CAL.ANTENNA_Am);
  }

  function bestSectorGain(brng, sectors) {
    if (!sectors || !sectors.length) return { gain:0, idx:0 };
    let best = -Infinity, idx = 0;
    sectors.forEach((az, i) => {
      const g = antennaGain(Math.abs(((brng - az + 540) % 360) - 180));
      if (g > best) { best = g; idx = i; }
    });
    return { gain:best, idx };
  }

  /**
   * Hitung RSRP_3GPP dengan adaptive clutter loss
   */
  function computeRsrp3gpp(pt, site) {
    const dist    = haversine(pt.lat, pt.lng, site.lat, site.lng);
    const brng    = calcBearing(site.lat, site.lng, pt.lat, pt.lng);
    const sectors = normalizeSectors(site);
    const scenario  = (site.scenario  || 'uma').toLowerCase();
    const condition = (site.condition || 'nlos').toLowerCase();

    const gainDb = sectors.length ? bestSectorGain(brng, sectors).gain : 0;
    const pl     = pathLoss(scenario, condition, Math.max(dist, 10),
                            CAL.FREQUENCY, site.height || 30, CAL.MOBILE_H);
    const cl     = getAdaptiveClutterLoss(site, dist);  // [SOL-2]
    const nfCorr = dist < CAL.NF_THRESH
                   ? CAL.NF_MAX * (1 - dist / CAL.NF_THRESH) : 0;

    return {
      rsrp3gpp: CAL.TX_POWER + gainDb - pl - cl + nfCorr,
      dist, gainDb, pl, cl, nfCorr,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // RSRP BIN DEFINITIONS (untuk distribusi matching & tail compression)
  // ════════════════════════════════════════════════════════════════════════
  const RSRP_BINS = [
    { label:'≥-85',       min:-85,  max:0    },
    { label:'-95~-85',    min:-95,  max:-85  },
    { label:'-105~-95',   min:-105, max:-95  },
    { label:'-115~-105',  min:-115, max:-105 },
    { label:'-125~-115',  min:-125, max:-115 },
    { label:'<-125',      min:-200, max:-125 },
  ];

  // ════════════════════════════════════════════════════════════════════════
  // [SOL-4] TAIL COMPRESSION
  //
  // Titik dengan RSRP < -115 dBm dikompres ke atas (nonlinear)
  // Mengurangi porsi tail yang terlalu tebal
  // ════════════════════════════════════════════════════════════════════════
  const TAIL_THRESHOLD   = -115;   // dBm
  const TAIL_COMPRESSION = 0.6;    // faktor kompresi (0=semua ke threshold, 1=tidak berubah)
  const TAIL_HARD_FLOOR  = -140;   // dBm, batas absolut

  function applyTailCompression(rsrp) {
    if (rsrp >= TAIL_THRESHOLD) return rsrp;
    const compressed = TAIL_THRESHOLD + (rsrp - TAIL_THRESHOLD) * TAIL_COMPRESSION;
    return Math.max(TAIL_HARD_FLOOR, compressed);
  }

  // ════════════════════════════════════════════════════════════════════════
  // [SOL-6] SAMPLE-ADAPTIVE BIAS BLENDING
  //
  // α = n / (n + K)
  // bias_final = α·bias_lokal + (1-α)·bias_global
  //
  // K=10: perlu ~20 sampel agar α=0.67 (67% trust ke lokal)
  //       dengan <5 sampel α≈0.3 → bias mendekati global (aman)
  // ════════════════════════════════════════════════════════════════════════
  const BIAS_BLEND_K = 10;

  function blendedBias(localBias, globalBias, n) {
    const alpha = n / (n + BIAS_BLEND_K);
    return {
      bias  : alpha * localBias + (1 - alpha) * globalBias,
      alpha : +alpha.toFixed(3),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // CALIBRATION — SEGMENT BASED + SOL-1 + SOL-3 + SOL-6
  // ════════════════════════════════════════════════════════════════════════
  function calibrateSegmentBased(site) {
    const buckets = DISTANCE_SEGMENTS.map(() => ({
      deltas: [], rsrps: [], sinrPairs: [],
    }));

    simPoints.forEach(pt => {
      if (pt.rsrp === null) return;
      const { rsrp3gpp, dist } = computeRsrp3gpp(pt, site);
      const segIdx = getSegmentIndex(dist);
      buckets[segIdx].deltas.push(pt.rsrp - rsrp3gpp);
      buckets[segIdx].rsrps.push({ rsrp: pt.rsrp, dist });
      if (pt.sinr !== null)
        buckets[segIdx].sinrPairs.push({ rsrp:pt.rsrp, dist, sinr:pt.sinr });
    });

    const allDeltas = buckets.flatMap(b => b.deltas);
    if (allDeltas.length < 5) return null;

    const globalBias = mean(allDeltas);
    const globalStd  = Math.max(0.5, stdDev(allDeltas));

    // ── [SOL-6] Blended segments ────────────────────────────────────────
    const segments = buckets.map((b, i) => {
      const seg = DISTANCE_SEGMENTS[i];
      if (!b.deltas.length) {
        return { ...seg, bias:null, std:null, count:0, alpha:0, localBias:null };
      }
      const localBias = mean(b.deltas);
      const localStd  = Math.max(0.5, stdDev(b.deltas));
      const { bias, alpha } = blendedBias(localBias, globalBias, b.deltas.length);
      const blendedStd      = alpha * localStd + (1 - alpha) * globalStd;
      return {
        ta: seg.ta, min: seg.min, max: seg.max,
        bias, std: blendedStd,
        count: b.deltas.length,
        alpha, localBias: +localBias.toFixed(2),
      };
    });

    // Forward + backward fill untuk segment kosong
    let lastValid = null;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].bias !== null) { lastValid = segments[i]; }
      else if (lastValid)            { segments[i].bias = lastValid.bias; segments[i].std = lastValid.std; }
    }
    lastValid = null;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].bias !== null) { lastValid = segments[i]; }
      else if (lastValid)            { segments[i].bias = lastValid.bias; segments[i].std = lastValid.std; }
    }
    segments.forEach(s => {
      if (s.bias === null) { s.bias = globalBias; s.std = globalStd; }
    });

    // ── [SOL-1] Global Gain Correction ──────────────────────────────────
    const G = computeGlobalGainCorrection(site, segments, globalBias);

    // ── [SOL-5] SINR 3-Var Model ────────────────────────────────────────
    const allSinrPairs = buckets.flatMap(b => b.sinrPairs);
    const sinrModel    = allSinrPairs.length >= 8
                         ? fitSINR3Var(allSinrPairs)
                         : null;

    // ── [SOL-3] Distribution Adjustment ─────────────────────────────────
    const distAdj = computeDistributionAdjustment(site, segments, globalBias, G);

    const residuals  = allDeltas.map(d => d - globalBias);
    const rmse3gpp   = rmse(allDeltas);
    const rmseAfter  = rmse(residuals);

    return {
      globalBias, globalStd,
      rmse3gpp, rmseAfter,
      segments,
      sinrModel,
      globalGain : G,
      distAdj,
      nPaired    : allDeltas.length,
      nSinr      : allSinrPairs.length,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // [SOL-1] GLOBAL GAIN CORRECTION
  //
  // G = median(RSRP_actual) - median(RSRP_sim_before_noise)
  // Sim menggunakan bias_segment (sudah blended) untuk konsistensi
  // ════════════════════════════════════════════════════════════════════════
  function computeGlobalGainCorrection(site, segments, globalBias) {
    const pairedPoints = simPoints.filter(p => p.rsrp !== null);
    if (pairedPoints.length < 5) return 0;

    const rsrpSimList = pairedPoints.map(pt => {
      const { rsrp3gpp, dist } = computeRsrp3gpp(pt, site);
      const segIdx  = getSegmentIndex(dist);
      const biasSeg = segments[segIdx]?.bias ?? globalBias;
      return rsrp3gpp + biasSeg;
    });

    const rsrpActualList = pairedPoints.map(p => p.rsrp);
    const G = medianArr(rsrpActualList) - medianArr(rsrpSimList);

    // Clamp agar tidak over-correct
    const Gclamped = Math.max(-10, Math.min(10, G));
    console.log(`[GainCorr] G_raw=${G.toFixed(2)}, G_clamped=${Gclamped.toFixed(2)} dB`);
    return Gclamped;
  }

  // ════════════════════════════════════════════════════════════════════════
  // [SOL-3] DISTRIBUTION ADJUSTMENT (Histogram Matching per RSRP Bin)
  //
  // Dry-run (tanpa noise) → bandingkan mean per bin sim vs aktual
  // Adj[bin] = mean_actual[bin] - mean_sim[bin], clamp ±6 dB
  // ════════════════════════════════════════════════════════════════════════
  function computeDistributionAdjustment(site, segments, globalBias, G) {
    const pairs = simPoints
      .filter(p => p.rsrp !== null)
      .map(pt => {
        const { rsrp3gpp, dist } = computeRsrp3gpp(pt, site);
        const segIdx  = getSegmentIndex(dist);
        const biasSeg = segments[segIdx]?.bias ?? globalBias;
        const rsrpSim = rsrp3gpp + biasSeg + G;  // deterministic (tanpa noise)
        return { rsrpSim, rsrpActual: pt.rsrp };
      });

    if (!pairs.length) return null;

    const adj = RSRP_BINS.map((bin, i) => {
      const inSim    = pairs.filter(p => p.rsrpSim    >= bin.min && p.rsrpSim    < bin.max);
      const inActual = pairs.filter(p => p.rsrpActual >= bin.min && p.rsrpActual < bin.max);

      const meanSim    = inSim.length    ? mean(inSim.map(p => p.rsrpSim))       : null;
      const meanActual = inActual.length ? mean(inActual.map(p => p.rsrpActual)) : null;

      let adjustment = 0;
      if (meanActual !== null && meanSim !== null) {
        adjustment = Math.max(-6, Math.min(6, meanActual - meanSim));
      }

      return {
        binIdx   : i,
        label    : bin.label,
        nSim     : inSim.length,
        nActual  : inActual.length,
        pctSim   : pairs.length ? inSim.length    / pairs.length : 0,
        pctActual: pairs.length ? inActual.length / pairs.length : 0,
        adj      : adjustment,
      };
    });

    console.log('[DistAdj]', adj.map(a => `${a.label}:${a.adj>0?'+':''}${a.adj.toFixed(1)}dB(n=${a.nSim})`).join(' | '));
    return adj;
  }

  /**
   * Lookup distribution adjustment berdasarkan nilai RSRP sebelum noise
   */
  function getDistributionAdjustment(rsrpPre, distAdj) {
    if (!distAdj) return 0;
    const binIdx = RSRP_BINS.findIndex(b => rsrpPre >= b.min && rsrpPre < b.max);
    if (binIdx < 0) return 0;
    return distAdj[binIdx]?.adj ?? 0;
  }

  // ════════════════════════════════════════════════════════════════════════
  // [SOL-5] SINR MODEL 3-VAR
  //
  // SINR = a·RSRP + b·log10(dist) + c
  //
  // Alasan menghapus b·dist:
  //   - dist dan log10(dist) berkorelasi tinggi → multikolinearitas
  //   - b·dist menyebabkan SINR turun linear tanpa batas → tidak fisik
  //   - log10(dist) sudah cukup untuk menangkap hubungan non-linear
  //   - Model 3-var lebih stabil lintas site (generalizes better)
  //
  // Zone-conditional noise:
  //   - Zona kuat (RSRP ≥ -90): noise kecil (kondisi LOS/near-LOS)
  //   - Zona menengah (-105 ~ -90): noise sedang
  //   - Zona lemah (< -105): noise besar (banyak multipath/NLOS)
  //
  // Ceiling compression (>30 dB):
  //   - SINR > 30 dB sangat jarang di kondisi nyata
  //   - Kompres dengan faktor 0.4
  // ════════════════════════════════════════════════════════════════════════
  function fitSINR3Var(pairs) {
    const n = pairs.length;
    if (n < 5) return null;

    // Bangun matriks desain X (n×3): [RSRP, log10(dist), 1]
    const X = pairs.map(p => [
      p.rsrp,
      Math.log10(Math.max(p.dist, 10)),
      1,
    ]);
    const y = pairs.map(p => p.sinr);

    // X'X (3×3) dan X'y (3×1)
    const XtX = [[0,0,0],[0,0,0],[0,0,0]];
    const Xty = [0,0,0];
    for (let i = 0; i < n; i++) {
      for (let r = 0; r < 3; r++) {
        Xty[r] += X[i][r] * y[i];
        for (let c = 0; c < 3; c++) XtX[r][c] += X[i][r] * X[i][c];
      }
    }

    const beta = gaussElim3(XtX, Xty);
    if (!beta) {
      const lr = linearRegression(pairs.map(p => ({ x:p.rsrp, y:p.sinr })));
      return { a:lr.slope, b:0, c:lr.intercept, r2:lr.r2, zoneNoise:null,
               noiseStd:3.0, type:'linear_fallback' };
    }

    const [a, b, c] = beta;
    const yPred = pairs.map(p => a*p.rsrp + b*Math.log10(Math.max(p.dist,10)) + c);
    const yMean = mean(y);
    const ssTot = y.reduce((s, yi) => s + (yi - yMean)**2, 0);
    const ssRes = y.reduce((s, yi, i) => s + (yi - yPred[i])**2, 0);
    const r2    = ssTot > 0 ? Math.max(0, 1 - ssRes/ssTot) : 0;
    const noiseStd = Math.max(1.0, Math.sqrt(ssRes / Math.max(n-3, 1)));

    // Zone-conditional noise
    const zoneNoise = computeSINRZoneNoise(pairs, yPred);

    return { a, b, c, r2, zoneNoise, noiseStd, type:'3var' };
  }

  /**
   * Hitung std residual per zona RSRP untuk noise kondisional
   */
  function computeSINRZoneNoise(pairs, yPred) {
    const zones = [
      { label:'strong', min:-90,  max:0,    residuals:[] },
      { label:'mid',    min:-105, max:-90,  residuals:[] },
      { label:'weak',   min:-200, max:-105, residuals:[] },
    ];
    pairs.forEach((p, i) => {
      const z = zones.find(z => p.rsrp >= z.min && p.rsrp < z.max);
      if (z) z.residuals.push(p.sinr - yPred[i]);
    });
    return zones.map(z => ({
      label: z.label,
      min  : z.min,
      max  : z.max,
      std  : z.residuals.length >= 3
             ? Math.max(1.0, stdDev(z.residuals))
             : 3.0,
      n    : z.residuals.length,
    }));
  }

  /**
   * Hitung SINR simulasi dengan zone noise + ceiling compression
   */
  function computeSinrSim(rsrpSim, dist, sinrModel, globalSeed, lat, lng) {
    if (!sinrModel) {
      return Math.max(-10, Math.min(30, rsrpSim + 90));
    }

    const sinrBase = sinrModel.a * rsrpSim
                   + sinrModel.b * Math.log10(Math.max(dist, 10))
                   + sinrModel.c;

    // Pilih noise std berdasarkan zona RSRP
    let noiseStd = sinrModel.noiseStd;
    if (sinrModel.zoneNoise) {
      const zone = sinrModel.zoneNoise.find(z => rsrpSim >= z.min && rsrpSim < z.max);
      if (zone) noiseStd = zone.std;
    }

    // Spatial noise untuk SINR (seed berbeda dari RSRP agar tidak berkorelasi sempurna)
    const sinrNoise = spatialNoise(lat, lng, noiseStd, globalSeed + 31337);
    let sinrRaw = sinrBase + sinrNoise;

    // Ceiling compression: SINR > 30 dB dikompres
    if (sinrRaw > 30) {
      sinrRaw = 30 + (sinrRaw - 30) * 0.4;
    }

    return Math.max(-10, Math.min(40, sinrRaw));
  }

  // ════════════════════════════════════════════════════════════════════════
  // GAUSS ELIMINASI 3×3
  // ════════════════════════════════════════════════════════════════════════
  function gaussElim3(A, b) {
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < 3; col++) {
      let maxRow = col;
      for (let row = col+1; row < 3; row++)
        if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
      [M[col], M[maxRow]] = [M[maxRow], M[col]];
      if (Math.abs(M[col][col]) < 1e-12) return null;
      for (let row = col+1; row < 3; row++) {
        const f = M[row][col] / M[col][col];
        for (let k = col; k <= 3; k++) M[row][k] -= f * M[col][k];
      }
    }
    const x = [0,0,0];
    for (let row = 2; row >= 0; row--) {
      x[row] = M[row][3];
      for (let k = row+1; k < 3; k++) x[row] -= M[row][k] * x[k];
      x[row] /= M[row][row];
    }
    return x;
  }

  // ════════════════════════════════════════════════════════════════════════
  // GAUSS ELIMINASI 4×4 (dipertahankan untuk kompatibilitas / debug)
  // ════════════════════════════════════════════════════════════════════════
  function gaussElim4(A, b) {
    const M = A.map((row, i) => [...row, b[i]]);
    const n = 4;
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let row = col+1; row < n; row++)
        if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
      [M[col], M[maxRow]] = [M[maxRow], M[col]];
      if (Math.abs(M[col][col]) < 1e-12) return null;
      for (let row = col+1; row < n; row++) {
        const f = M[row][col] / M[col][col];
        for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let row = n-1; row >= 0; row--) {
      x[row] = M[row][n];
      for (let k = row+1; k < n; k++) x[row] -= M[row][k] * x[k];
      x[row] /= M[row][row];
    }
    return x;
  }

  function linearRegression(pairs) {
    const n = pairs.length;
    let sX=0,sY=0,sXX=0,sXY=0,sYY=0;
    pairs.forEach(p => { sX+=p.x; sY+=p.y; sXX+=p.x*p.x; sXY+=p.x*p.y; sYY+=p.y*p.y; });
    const denom = n*sXX - sX*sX;
    const slope = denom ? (n*sXY - sX*sY)/denom : 0;
    const intercept = (sY - slope*sX)/n;
    const yMean = sY/n, ssTot = sYY - n*yMean*yMean;
    const ssRes = pairs.reduce((s,p) => { const r=p.y-(slope*p.x+intercept); return s+r*r; }, 0);
    const r2    = ssTot > 0 ? Math.max(0, 1-ssRes/ssTot) : 0;
    return { slope, intercept, r2 };
  }

  // ════════════════════════════════════════════════════════════════════════
  // MODEL EVALUASI
  // ════════════════════════════════════════════════════════════════════════
  function evaluateModel(results) {
    const paired  = results.filter(r => r.rsrp_actual != null);
    const pairedS = results.filter(r => r.sinr_actual != null);
    if (!paired.length) return null;

    const rsrpDiffs = paired.map(r => parseFloat(r.rsrp) - r.rsrp_actual);
    const sinrDiffs = pairedS.map(r => parseFloat(r.sinr) - r.sinr_actual);

    const rsrpStats = computeStats(rsrpDiffs);
    const sinrStats = pairedS.length ? computeStats(sinrDiffs) : null;

    const segStats = DISTANCE_SEGMENTS.map((seg, i) => {
      const sp = paired.filter(r => {
        const d = parseFloat(r.distance);
        return d >= seg.min && d < seg.max;
      });
      if (!sp.length) return { ta:seg.ta, min:seg.min, max:seg.max, n:0, me:null, rmse:null };
      const diffs = sp.map(r => parseFloat(r.rsrp) - r.rsrp_actual);
      return { ta:seg.ta, min:seg.min, max:seg.max, n:sp.length, ...computeStats(diffs) };
    }).filter(s => s.n > 0);

    // Distribusi matching stats
    const distStats = RSRP_BINS.map(bin => {
      const cSim    = results.filter(r => { const v=parseFloat(r.rsrp); return v>=bin.min&&v<bin.max; }).length;
      const cActual = paired.filter(r => r.rsrp_actual>=bin.min&&r.rsrp_actual<bin.max).length;
      const pSim    = results.length ? (cSim/results.length*100).toFixed(1) : '0';
      const pActual = paired.length  ? (cActual/paired.length*100).toFixed(1) : '0';
      return { label:bin.label, pSim, pActual, diff:(parseFloat(pSim)-parseFloat(pActual)).toFixed(1) };
    });

    return { rsrp:rsrpStats, sinr:sinrStats, segments:segStats,
             distStats, nPaired:paired.length, nPairedSinr:pairedS.length };
  }

  function computeStats(diffs) {
    const n  = diffs.length;
    const me = mean(diffs);
    const ma = diffs.reduce((s,d) => s+Math.abs(d), 0) / n;
    const rm = Math.sqrt(diffs.reduce((s,d) => s+d*d, 0) / n);
    return { me:+me.toFixed(3), mae:+ma.toFixed(3), rmse:+rm.toFixed(3), n };
  }

  // ── Statistik dasar ──────────────────────────────────────────────────────
  const mean = arr => arr.reduce((s,v) => s+v, 0) / arr.length;
  const rmse = arr => Math.sqrt(arr.reduce((s,d) => s+d*d, 0) / arr.length);

  function stdDev(arr) {
    if (arr.length < 2) return 3.0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s,v) => s+(v-m)**2, 0) / (arr.length-1));
  }

  function medianArr(arr) {
    const s = [...arr].sort((a,b) => a-b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  }

  // ════════════════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupEventListeners();
    loadSiteIndex();
  });

  function initMap() {
    dtMap = L.map('map-dt-sim').setView([-6.2, 106.82], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom:19, attribution:'© OpenStreetMap' }
    ).addTo(dtMap);
    siteLayer    = L.layerGroup().addTo(dtMap);
    dtPointLayer = L.layerGroup().addTo(dtMap);
    heatmapLayer = L.layerGroup().addTo(dtMap);
  }

  function setupEventListeners() {
    byId('dtCsvInput')?.addEventListener('change', handleCsvUpload);
    byId('btnRunSimulation')?.addEventListener('click', runSimulation);
    byId('btnExportCSV')?.addEventListener('click', exportCSV);
    byId('btnBackToSim')?.addEventListener('click', () => window.location.href = '/simulation');
    byId('btnDebugSite')?.addEventListener('click', showDebug);
  }

  // ════════════════════════════════════════════════════════════════════════
  // LOAD SITE INDEX
  // ════════════════════════════════════════════════════════════════════════
  function loadSiteIndex() {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        const p = JSON.parse(saved);
        if (p && Object.keys(p).length > 0) { siteIndex = p; onSiteIndexLoaded('sessionStorage'); return; }
      } catch {}
    }
    setStatus('siteStatus','⏳ Memuat data site...','info');
    fetch('/api/get-site').then(r => r.json()).then(data => {
      if (!data.has_site || !data.siteIndex) {
        setStatus('siteStatus','⚠️ Belum ada data site.','warn'); return;
      }
      siteIndex = data.siteIndex;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(siteIndex));
      onSiteIndexLoaded('server');
    }).catch(() => setStatus('siteStatus','⚠️ Tidak bisa mengambil data site.','warn'));
  }

  function onSiteIndexLoaded(source) {
    const count = Object.keys(siteIndex).length;
    setStatus('siteStatus',`✅ ${count} site (${source})`,'ok');
    setText('infoTotalSites', count);
    renderAllSites();
    if (simPoints.length) autoDetectAndCalibrate();
  }

  // ════════════════════════════════════════════════════════════════════════
  // AUTO-DETECT PRIMARY SITE + CALIBRATE
  // ════════════════════════════════════════════════════════════════════════
  function autoDetectAndCalibrate() {
    if (!Object.keys(siteIndex).length || !dtPoints.length) return;

    const cLat = dtPoints.reduce((s,p) => s+p.lat, 0) / dtPoints.length;
    const cLng = dtPoints.reduce((s,p) => s+p.lng, 0) / dtPoints.length;

    let bestId=null, bestSite=null, minDist=Infinity;
    Object.entries(siteIndex).forEach(([id,s]) => {
      const d = haversine(cLat, cLng, s.lat, s.lng);
      if (d < minDist) { minDist=d; bestId=id; bestSite=s; }
    });
    if (!bestId) return;

    primarySite = { id:bestId, ...bestSite };

    const distKm = (minDist/1000).toFixed(2);
    setStatus('siteMatchStatus',
      `🎯 Site terdeteksi: <b>${bestId}</b> — ${distKm} km dari centroid`,'ok');

    const s = bestSite;
    setText('dispSiteId', bestId);
    setText('dispSiteCoord', `${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}`);
    setText('dispSiteHeight', `${s.height||30} m`);
    const sectors = normalizeSectors(s);
    setText('dispSiteSectors',
      sectors.length ? `${sectors.length} sektor (${sectors.map(a=>a+'°').join(', ')})` : 'Omni');
    setText('dispSiteModel', `${(s.scenario||'uma').toUpperCase()} ${(s.condition||'nlos').toUpperCase()}`);
    setText('dispSiteClutter', s.clutter||'—');

    highlightPrimarySiteOnMap(bestId);

    if (simPoints.length) {
      calibration = calibrateSegmentBased(bestSite);
      displayCalibrationInfo();
      if (calibration) enableBtn('btnRunSimulation');
    }
  }

  function displayCalibrationInfo() {
    if (!calibration) {
      setStatus('modelStatus','⚠️ Tidak cukup data untuk kalibrasi.','warn'); return;
    }
    const c = calibration;
    const segsWithData = c.segments.filter(s => s.count > 0);
    const quality = c.rmseAfter < 5 ? 'ok' : c.rmseAfter < 10 ? 'warn' : 'error';

    const segInfo = segsWithData.map(s =>
      `<span style="font-size:11px">TA${s.ta}(${s.count}pt,α=${s.alpha}): ` +
      `local=${s.localBias!==null?(s.localBias>0?'+':'')+s.localBias:'n/a'} ` +
      `blend=${s.bias>0?'+':''}${s.bias.toFixed(1)}, σ=${s.std.toFixed(1)}</span>`
    ).join(' | ');

    const distAdjInfo = c.distAdj
      ? c.distAdj.filter(a => a.nSim > 0 || a.nActual > 0)
          .map(a => `<span style="font-size:11px">${a.label}: adj=${a.adj>0?'+':''}${a.adj.toFixed(1)}dB ` +
               `(sim=${(a.pctSim*100).toFixed(0)}% vs act=${(a.pctActual*100).toFixed(0)}%)</span>`)
          .join(' | ')
      : 'N/A';

    setStatus('modelStatus',
      `✅ Kalibrasi v14 dari <b>${c.nPaired} titik</b> aktual<br>` +
      `Global bias: ${c.globalBias>0?'+':''}${c.globalBias.toFixed(1)} dB | ` +
      `Global σ: ${c.globalStd.toFixed(1)} dB | ` +
      `<b>G_gain: ${c.globalGain>0?'+':''}${c.globalGain.toFixed(2)} dB</b><br>` +
      `RMSE 3GPP+CL: ${c.rmse3gpp.toFixed(1)} → setelah koreksi: <b>${c.rmseAfter.toFixed(1)} dB</b>` +
      (c.sinrModel ? `<br>SINR 3-var [${c.sinrModel.type}]: ` +
        `a=${c.sinrModel.a.toFixed(3)}, b=${c.sinrModel.b.toFixed(3)}, ` +
        `c=${c.sinrModel.c.toFixed(2)}, R²=${c.sinrModel.r2.toFixed(3)}` : '') +
      `<br><b>TA-Segment (blended bias):</b><br><div style="margin-top:4px;line-height:1.7">${segInfo}</div>` +
      `<br><b>Distribution Adj:</b><br><div style="margin-top:4px;line-height:1.7">${distAdjInfo}</div>`,
      quality
    );

    setText('infoCalibN',    c.nPaired);
    setText('infoCalibBias', `${c.globalBias>0?'+':''}${c.globalBias.toFixed(2)} dB`);
    setText('infoCalibStd',  `${c.globalStd.toFixed(2)} dB`);
    setText('infoCalibRmse', `${c.rmse3gpp.toFixed(1)} → ${c.rmseAfter.toFixed(1)} dB`);
    setText('infoSinrR2',    c.sinrModel ? c.sinrModel.r2.toFixed(3) : 'N/A');
    setText('infoGlobalGain',`${c.globalGain>0?'+':''}${c.globalGain.toFixed(2)} dB`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // RUN SIMULATION — FORMULA LENGKAP v14
  //
  // Per titik:
  //   1. rsrp3gpp   = PL_3GPP + CL_adaptive(d) + antenna + NF_corr
  //   2. rsrp_pre   = rsrp3gpp + bias_seg_blended + G_global
  //   3. dist_adj   = lookup dari histogram matching table
  //   4. rsrp_raw   = rsrp_pre + dist_adj + spatialNoise(lat,lng,std_blended)
  //   5. RSRP_sim   = tailCompression(rsrp_raw)
  //   6. SINR_sim   = 3var(RSRP_sim,dist) + zoneNoise + ceilingCompress
  // ════════════════════════════════════════════════════════════════════════
  function runSimulation() {
    if (!simPoints.length)               return alert('Upload CSV DT aktual terlebih dahulu!');
    if (!Object.keys(siteIndex).length)  return alert('Data site belum dimuat!');
    if (!primarySite)                    return alert('Primary site belum terdeteksi!');
    if (!calibration)                    return alert('Kalibrasi gagal. Pastikan CSV punya data RSRP aktual.');

    activeSeed = Math.floor(Date.now() % 2147483647);
    seedRng(activeSeed);
    heatmapLayer.clearLayers();
    simResults = [];

    const site = siteIndex[primarySite.id];
    const cal  = calibration;
    const G    = cal.globalGain ?? 0;

    simPoints.forEach((pt, idx) => {
      // Step 1 — RSRP_3GPP dengan adaptive CL
      const { rsrp3gpp, dist, gainDb, pl, cl, nfCorr } = computeRsrp3gpp(pt, site);

      // Step 2 — Segment lookup (blended bias + std)
      const segIdx  = getSegmentIndex(dist);
      const seg     = cal.segments[segIdx];
      const biasSeg = seg.bias ?? cal.globalBias;
      const stdSeg  = seg.std  ?? cal.globalStd;

      // Step 3 — RSRP_pre = 3GPP + blended_bias + G
      const rsrpPre = rsrp3gpp + biasSeg + G;

      // Step 4 — Distribution adjustment
      const dAdj = getDistributionAdjustment(rsrpPre, cal.distAdj);

      // Step 5 — Spatial noise + tail compression
      const noise    = spatialNoise(pt.lat, pt.lng, stdSeg, activeSeed);
      const rsrpRaw  = rsrpPre + dAdj + noise;
      const rsrpSim  = applyTailCompression(rsrpRaw);           // [SOL-4]

      // Step 6 — SINR 3-var + zone noise + ceiling compress
      const sinrSim  = computeSinrSim(rsrpSim, dist, cal.sinrModel, activeSeed, pt.lat, pt.lng);

      simResults.push({
        index       : idx + 1,
        lat         : pt.lat,
        lng         : pt.lng,
        distance    : dist.toFixed(1),
        ta_seg      : seg.ta,
        rsrp3gpp    : rsrp3gpp.toFixed(1),
        clutter_loss: cl.toFixed(1),
        bias_seg    : biasSeg.toFixed(2),
        gain_g      : G.toFixed(2),
        dist_adj    : dAdj.toFixed(2),
        rsrp        : rsrpSim.toFixed(1),
        sinr        : sinrSim.toFixed(1),
        rsrp_actual : pt.rsrp,
        sinr_actual : pt.sinr,
        pci         : pt.pci ?? '—',
        siteId      : primarySite.id,
        gainDb      : gainDb.toFixed(1),
        pl          : pl.toFixed(1),
      });

      // Visualisasi di peta
      L.circleMarker([pt.lat, pt.lng], {
        radius:6, fillColor:rsrpColor(rsrpSim),
        color:'#333', weight:0.5, fillOpacity:0.92,
      }).addTo(heatmapLayer).bindPopup(
        `<b>Titik ${idx+1}</b> | TA${seg.ta} | d:${dist.toFixed(0)}m<br>` +
        `3GPP:${rsrp3gpp.toFixed(1)} CL:${cl.toFixed(1)} Bias:${biasSeg.toFixed(1)} G:${G.toFixed(1)} dAdj:${dAdj.toFixed(1)}<br>` +
        `<b>RSRP Sim:${rsrpSim.toFixed(1)} dBm</b> | Aktual:${pt.rsrp!=null?pt.rsrp.toFixed(1)+' dBm':'—'}` +
        (pt.rsrp!=null ? `<br>Δ RSRP:${(rsrpSim-pt.rsrp).toFixed(1)} dB` : '') +
        `<br>SINR Sim:${sinrSim.toFixed(1)} dB | Aktual:${pt.sinr!=null?pt.sinr.toFixed(1)+' dB':'—'}` +
        (pt.sinr!=null ? `<br>Δ SINR:${(sinrSim-pt.sinr).toFixed(1)} dB` : '')
      );
    });

    updateLegend();
    renderStats();
    enableBtn('btnExportCSV');

    const evalResult = evaluateModel(simResults);
    if (evalResult) {
      const r = evalResult.rsrp;
      const distCheck = evalResult.distStats
        .map(d => `  ${d.label}: sim ${d.pSim}% vs aktual ${d.pActual}% (Δ${d.diff}%)`)
        .join('\n');
      alert(
        `✅ Simulasi v14 selesai!\n${simResults.length} titik | Seed:${activeSeed}\n\n` +
        `📶 RSRP\n  ME:${r.me>0?'+':''}${r.me} dB | RMSE:${r.rmse} dB | MAE:${r.mae} dB\n\n` +
        (evalResult.sinr
          ? `📡 SINR\n  ME:${evalResult.sinr.me} dB | RMSE:${evalResult.sinr.rmse} dB\n\n` : '') +
        `📊 Distribusi RSRP\n${distCheck}\n\n` +
        (r.rmse<6 ? '🎯 Model baik (RMSE < 6 dB)!'
          : r.rmse<10 ? '⚠️ RMSE sedang, cek clutter & kondisi'
          : '❌ RMSE tinggi, cek data DT & site config')
      );
    } else {
      alert(`✅ Simulasi selesai — ${simResults.length} titik.`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // LEGEND & STATS
  // ════════════════════════════════════════════════════════════════════════
  function updateLegend() {
    const legend = byId('dtLegend'), tbody = byId('dtLegendBody');
    if (!legend || !tbody) return;
    const B = [
      { label:'-85 ~ 0 dBm',     color:'#0042a5', fn:v=>v>=-85&&v<0    },
      { label:'-95 ~ -85 dBm',   color:'#00a955', fn:v=>v>=-95&&v<-85  },
      { label:'-105 ~ -95 dBm',  color:'#70ff66', fn:v=>v>=-105&&v<-95 },
      { label:'-120 ~ -105 dBm', color:'#fffb00', fn:v=>v>=-120&&v<-105},
      { label:'-140 ~ -120 dBm', color:'#ff3333', fn:v=>v>=-140&&v<-120},
      { label:'< -140 dBm',      color:'#800000', fn:v=>v<-140         },
    ];
    const total = simResults.length || 1;
    tbody.innerHTML = B.map(b => {
      const cnt = simResults.filter(r => b.fn(parseFloat(r.rsrp))).length;
      return `<tr>
        <td><div style="width:13px;height:13px;background:${b.color};border-radius:3px;display:inline-block;"></div></td>
        <td>${b.label}</td>
        <td><b>${((cnt/total)*100).toFixed(1)}%</b></td>
      </tr>`;
    }).join('');
    legend.style.display = 'block';
  }

  function renderStats() {
    const box = byId('resultBox'); if (!box) return;
    const total    = simResults.length;
    const pairedR  = simResults.filter(r => r.rsrp_actual != null);
    const pairedS  = simResults.filter(r => r.sinr_actual != null);
    const cal      = calibration;

    const statBlock = (pairs, key, actKey, unit, okRmse, warnRmse) => {
      if (!pairs.length) return '';
      const diffs   = pairs.map(r => parseFloat(r[key]) - r[actKey]);
      const stats   = computeStats(diffs);
      const avgSim  = (simResults.reduce((s,r) => s+parseFloat(r[key]),0)/total).toFixed(1);
      const avgAct  = (pairs.reduce((s,r) => s+r[actKey],0)/pairs.length).toFixed(1);
      return `<div class="stat-grid">
        <div class="stat-cell"><span class="stat-lbl">Avg Sim</span><span class="stat-val">${avgSim} ${unit}</span></div>
        <div class="stat-cell"><span class="stat-lbl">Avg Aktual</span><span class="stat-val">${avgAct} ${unit}</span></div>
        <div class="stat-cell ${Math.abs(stats.me)<=2?'stat-ok':Math.abs(stats.me)<=5?'':'stat-warn'}">
          <span class="stat-lbl">Mean Error</span><span class="stat-val">${stats.me>0?'+':''}${stats.me} dB</span></div>
        <div class="stat-cell ${stats.rmse<=okRmse?'stat-ok':stats.rmse<=warnRmse?'':'stat-warn'}">
          <span class="stat-lbl">RMSE</span><span class="stat-val">${stats.rmse} dB</span></div>
        <div class="stat-cell"><span class="stat-lbl">MAE</span><span class="stat-val">${stats.mae} dB</span></div>
        <div class="stat-cell"><span class="stat-lbl">n paired</span><span class="stat-val">${pairs.length}</span></div>
      </div>`;
    };

    const evalResult = evaluateModel(simResults);

    const segTableRows = evalResult?.segments.map(s =>
      `<tr>
        <td>TA ${s.ta} (${s.min}–${s.max}m)</td>
        <td>${s.n}</td>
        <td>${s.me>0?'+':''}${s.me}</td>
        <td>${s.rmse}</td>
      </tr>`
    ).join('') || '';

    // Distribusi matching table
    const distMatchRows = evalResult?.distStats.map(d => {
      const diff = parseFloat(d.diff);
      const cls  = Math.abs(diff) <= 5 ? '' : Math.abs(diff) <= 10 ? 'style="color:orange"' : 'style="color:red"';
      return `<tr><td>${d.label}</td><td>${d.pSim}%</td><td>${d.pActual}%</td>
              <td ${cls}>${diff>0?'+':''}${d.diff}%</td></tr>`;
    }).join('') || '';

    const skipped = dtPoints.length - simPoints.length;
    const sinrModelInfo = cal?.sinrModel
      ? (cal.sinrModel.type === '3var'
        ? `SINR = ${cal.sinrModel.a.toFixed(3)}·RSRP + ${cal.sinrModel.b.toFixed(3)}·log10(d) + ${cal.sinrModel.c.toFixed(2)}`
        : `SINR = ${cal.sinrModel.a.toFixed(3)}·RSRP + ${cal.sinrModel.c.toFixed(2)} (linear fallback)`)
      : 'Fallback: RSRP+90';

    box.innerHTML = `
      <h3>📶 Hasil Simulasi v14 — Distribution-Aware</h3>
      <p class="result-meta">
        ${total} titik | Adaptive CL + Gain G + DistAdj + TailCompression + SINR 3-var
        ${skipped>0?`<br><span style="color:#ffcc66;">⚠ ${skipped} titik tanpa RSRP dilewati</span>`:''}
      </p>
      <small style="color:#aaa;">SINR: ${sinrModelInfo} | G=${cal?.globalGain>0?'+':''}${cal?.globalGain?.toFixed(2)||'0'} dB</small>

      <div class="stat-section-title" style="margin-top:8px;">📶 RSRP</div>
      ${statBlock(pairedR,'rsrp','rsrp_actual','dBm',5,10)}

      <div class="stat-section-title" style="margin-top:10px;">📡 SINR</div>
      ${statBlock(pairedS,'sinr','sinr_actual','dB',3,6)}

      ${segTableRows ? `
      <div class="stat-section-title" style="margin-top:10px;">📍 Akurasi per TA-Segment</div>
      <table class="dist-table">
        <thead><tr><th>Segment</th><th>n</th><th>ME (dB)</th><th>RMSE (dB)</th></tr></thead>
        <tbody>${segTableRows}</tbody>
      </table>` : ''}

      ${distMatchRows ? `
      <div class="stat-section-title" style="margin-top:10px;">📊 Distribusi RSRP — Sim vs Aktual</div>
      <table class="dist-table">
        <thead><tr><th>RSRP (dBm)</th><th>Sim %</th><th>Aktual %</th><th>Δ %</th></tr></thead>
        <tbody>${distMatchRows}</tbody>
      </table>
      <small style="color:#aaa;">Target: |Δ| &lt; 10% per bin</small>` : ''}

      <div class="result-footer">✅ Siap dibandingkan di Analysis &amp; Comparison</div>`;
    box.style.display = 'block';
  }

  // ════════════════════════════════════════════════════════════════════════
  // DEBUG
  // ════════════════════════════════════════════════════════════════════════
  function showDebug() {
    if (!calibration) { alert('Kalibrasi belum tersedia. Upload CSV terlebih dahulu.'); return; }
    const c    = calibration;
    const site = siteIndex[primarySite?.id];
    const lines = [
      `=== Distribution-Aware v14: ${primarySite?.id||'?'} ===`, '',
      `Site: lat=${site?.lat?.toFixed(6)}, lng=${site?.lng?.toFixed(6)}`,
      `Scenario: ${site?.scenario||'uma'} ${site?.condition||'nlos'}`,
      `Height: ${site?.height||30}m | Clutter: ${site?.clutter||'urban'}`,
      `Sectors: [${normalizeSectors(site||{}).join(', ')}]`, '',
      `=== Kalibrasi (${c.nPaired} titik paired) ===`,
      `  Global bias:     ${c.globalBias>0?'+':''}${c.globalBias.toFixed(2)} dB`,
      `  Global σ:        ${c.globalStd.toFixed(2)} dB`,
      `  Global Gain G:   ${c.globalGain>0?'+':''}${c.globalGain.toFixed(2)} dB  [SOL-1]`,
      `  RMSE sebelum:    ${c.rmse3gpp.toFixed(2)} dB`,
      `  RMSE setelah:    ${c.rmseAfter.toFixed(2)} dB`, '',
      `=== TA-Segment (blended bias) [SOL-6] ===`,
      ...c.segments.filter(s => s.count>0).map(s =>
        `  TA${s.ta} (${s.min}–${s.max}m): n=${s.count}, α=${s.alpha}, ` +
        `local=${s.localBias!==null?(s.localBias>0?'+':'')+s.localBias:'n/a'}, ` +
        `blend=${s.bias>0?'+':''}${s.bias.toFixed(2)}, σ=${s.std.toFixed(2)}`
      ), '',
      `=== Distribution Adjustment [SOL-3] ===`,
      ...(c.distAdj||[]).map(a =>
        `  ${a.label}: adj=${a.adj>0?'+':''}${a.adj.toFixed(2)}dB ` +
        `(sim=${(a.pctSim*100).toFixed(1)}% act=${(a.pctActual*100).toFixed(1)}% n=${a.nSim})`
      ), '',
      `=== Tail Compression [SOL-4] ===`,
      `  Threshold: ${TAIL_THRESHOLD} dBm | Factor: ${TAIL_COMPRESSION} | Floor: ${TAIL_HARD_FLOOR} dBm`,
      `  Contoh: -120 → ${applyTailCompression(-120).toFixed(1)} | -130 → ${applyTailCompression(-130).toFixed(1)} | -145 → ${applyTailCompression(-145).toFixed(1)}`, '',
      `=== SINR 3-Var Model [SOL-5] ===`,
      c.sinrModel ? (
        c.sinrModel.type === '3var'
          ? `  SINR = ${c.sinrModel.a.toFixed(4)}·RSRP + ${c.sinrModel.b.toFixed(4)}·log10(d) + ${c.sinrModel.c.toFixed(3)}\n` +
            `  R²=${c.sinrModel.r2.toFixed(4)} | global_noise_σ=${c.sinrModel.noiseStd.toFixed(2)} dB\n` +
            (c.sinrModel.zoneNoise
              ? c.sinrModel.zoneNoise.map(z => `  Zone ${z.label}: σ=${z.std.toFixed(2)} dB (n=${z.n})`).join('\n')
              : '')
          : `  Fallback linear: SINR=${c.sinrModel.a.toFixed(4)}·RSRP+${c.sinrModel.c.toFixed(3)}\n  R²=${c.sinrModel.r2.toFixed(4)}`
      ) : '  Tidak ada data SINR (n < 8)', '',
      `=== Contoh prediksi ===`,
    ];

    if (site) {
      [50,150,300,500,1000,2000].forEach(d => {
        const fakePt = { lat: site.lat + d/111320, lng: site.lng };
        const { rsrp3gpp, cl } = computeRsrp3gpp(fakePt, site);
        const segIdx  = getSegmentIndex(d);
        const seg     = c.segments[segIdx];
        const rsrpPre = rsrp3gpp + (seg.bias??c.globalBias) + c.globalGain;
        const dAdj    = getDistributionAdjustment(rsrpPre, c.distAdj);
        const rsrpFin = applyTailCompression(rsrpPre + dAdj);
        lines.push(
          `  d≈${d}m [TA${seg.ta}]: 3GPP=${rsrp3gpp.toFixed(1)} CL=${cl.toFixed(1)} ` +
          `bias=${seg.bias?.toFixed(1)} G=${c.globalGain.toFixed(1)} ` +
          `dAdj=${dAdj.toFixed(1)} → ${rsrpFin.toFixed(1)} dBm`
        );
      });
    }

    alert(lines.join('\n'));
  }

  // ════════════════════════════════════════════════════════════════════════
  // NORMALIZE SECTORS
  // ════════════════════════════════════════════════════════════════════════
  function normalizeSectors(site) {
    if (!Array.isArray(site.sectors) || !site.sectors.length) return [];
    return site.sectors.map(s => {
      if (typeof s === 'object' && s !== null) return parseFloat(s.azimuth ?? s.az ?? 0);
      const n = parseFloat(s); return isNaN(n) ? 0 : n;
    });
  }

  function renderAllSites() {
    siteLayer.clearLayers();
    Object.entries(siteIndex).forEach(([id,s]) => {
      L.circleMarker([s.lat, s.lng], { radius:4, fillColor:'#aab8d8', color:'#556', weight:1, fillOpacity:0.9 })
        .addTo(siteLayer)
        .bindPopup(`<b>${id}</b><br>H:${s.height}m | Clutter:${s.clutter||'N/A'}`);
    });
  }

  function drawSectorFan(lat, lng, az, bw, radius, idx, highlight) {
    const pts = [[lat,lng]];
    for (let i = 0; i <= 16; i++) {
      const ang = (az - bw/2) + (i/16) * bw;
      const p   = destPoint(lat, lng, ang, radius);
      pts.push([p.lat, p.lng]);
    }
    pts.push([lat,lng]);
    const c = SECTOR_COLORS[idx % SECTOR_COLORS.length];
    L.polygon(pts, { color:c, fillColor:c, fillOpacity:highlight?0.2:0.07,
                     weight:highlight?2.5:1, opacity:highlight?0.85:0.4 })
      .addTo(siteLayer).bindPopup(`<b>Sektor ${idx+1}</b> | Az:${az}°`);
  }

  function highlightPrimarySiteOnMap(primaryId) {
    siteLayer.clearLayers();
    Object.entries(siteIndex).forEach(([id,s]) => {
      const isPrimary = id === primaryId;
      L.circleMarker([s.lat, s.lng], {
        radius:isPrimary?13:4, fillColor:isPrimary?'#ffd000':'#aab8d8',
        color:isPrimary?'#000':'#556', weight:isPrimary?3:1, fillOpacity:1,
      }).addTo(siteLayer)
        .bindPopup(`${isPrimary?'⭐ ':''}<b>${id}</b><br>H:${s.height}m | Clutter:${s.clutter||'N/A'}`);
      if (isPrimary) normalizeSectors(s).forEach((az,i) => drawSectorFan(s.lat,s.lng,az,65,300,i,true));
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // CSV UPLOAD & PARSING (tidak berubah dari v13)
  // ════════════════════════════════════════════════════════════════════════
  function handleCsvUpload(e) {
    const file = e.target.files[0]; if (!file) return;
    setStatus('csvStatus','⏳ Membaca CSV...','info');
    if (typeof Papa !== 'undefined') {
      Papa.parse(file, {
        header:true, dynamicTyping:false, skipEmptyLines:true,
        complete: r => processCsvData(r.data, r.meta.fields),
        error:    () => setStatus('csvStatus','❌ Gagal membaca file','error'),
      });
    } else {
      const reader = new FileReader();
      reader.onload = ev => {
        const lines = ev.target.result.split('\n').filter(l => l.trim());
        const delim = lines[0].includes('\t') ? '\t' : ',';
        const fields = lines[0].split(delim).map(h => h.trim().replace(/"/g,''));
        const rows   = lines.slice(1).map(line => {
          const vals = line.split(delim).map(v => v.trim().replace(/"/g,''));
          const obj  = {}; fields.forEach((h,i) => obj[h] = vals[i]??''); return obj;
        });
        processCsvData(rows, fields);
      };
      reader.readAsText(file);
    }
  }

  function detectCols(headers) {
    const find = cands => {
      for (const h of headers) {
        const hl = h.toLowerCase().replace(/[\s()]/g,'');
        if (cands.some(c => hl===c || hl.startsWith(c))) return h;
      }
      return null;
    };
    return {
      lat  : find(['latitude','lat','lintang','y']),
      lng  : find(['longitude','lon','lng','long','bujur','x']),
      rsrp : find(['rsrpdbm','rsrp','ltersrp','nrrsrp','signal']),
      sinr : find(['sinrdb','sinr','ltsinr','nrsinr','snr']),
      pci  : find(['pci','physicalcellid','physicalcell','pcid','nrpci','ltepci','cellid']),
    };
  }

  const parseNum  = v => { if (v===null||v===undefined||v==='') return null; const n=parseFloat(v); return isNaN(n)?null:n; };
  const parseInt2 = v => { if (v===null||v===undefined||v==='') return null; const n=parseInt(v,10); return isNaN(n)?null:n; };

  function processCsvData(rows, headers) {
    const cols = detectCols(headers || Object.keys(rows[0]||{}));
    if (!cols.lat || !cols.lng) {
      setStatus('csvStatus',`❌ Kolom Lat/Lng tidak ditemukan. Header: ${(headers||[]).slice(0,8).join(', ')}`,'error');
      return;
    }

    const raw = rows.map(r => ({
      lat  : parseNum(r[cols.lat]),
      lng  : parseNum(r[cols.lng]),
      rsrp : cols.rsrp  ? parseNum(r[cols.rsrp])  : null,
      sinr : cols.sinr  ? parseNum(r[cols.sinr])  : null,
      pci  : cols.pci   ? parseInt2(r[cols.pci])  : null,
    })).filter(p =>
      p.lat!==null && p.lng!==null && !isNaN(p.lat) && !isNaN(p.lng) &&
      p.lat!==0 && p.lng!==0 && Math.abs(p.lat)<=90 && Math.abs(p.lng)<=180
    );

    const noGlitch = [];
    raw.forEach((pt,i) => {
      if (i===0) { noGlitch.push(pt); return; }
      if (haversine(noGlitch.at(-1).lat, noGlitch.at(-1).lng, pt.lat, pt.lng) <= 500) noGlitch.push(pt);
    });
    dtPoints  = noGlitch.filter((pt,i) => i===0 || pt.lat!==noGlitch[i-1].lat || pt.lng!==noGlitch[i-1].lng);
    simPoints = dtPoints.filter(p => p.rsrp !== null);

    const filtered      = rows.length - dtPoints.length;
    const noRsrpCount   = dtPoints.length - simPoints.length;
    if (dtPoints.length < 3)  { setStatus('csvStatus',`❌ Terlalu sedikit titik (${dtPoints.length})`,'error'); return; }
    if (simPoints.length < 5) { setStatus('csvStatus','⚠️ Minimal 5 titik RSRP diperlukan.','warn'); return; }

    let totalDist = 0;
    for (let i=1; i<dtPoints.length; i++)
      totalDist += haversine(dtPoints[i-1].lat,dtPoints[i-1].lng,dtPoints[i].lat,dtPoints[i].lng);

    dtPointLayer.clearLayers(); heatmapLayer.clearLayers(); simResults=[]; calibration=null;

    L.polyline(dtPoints.map(p=>[p.lat,p.lng]), { color:'#aaa',weight:2,opacity:0.4,dashArray:'4 4' })
      .addTo(dtPointLayer).bindPopup(`Rute GPS — ${dtPoints.length} titik`);

    simPoints.forEach(p => {
      L.circleMarker([p.lat,p.lng], { radius:3,fillColor:'#00cc88',color:'none',fillOpacity:0.55 })
        .addTo(dtPointLayer)
        .bindPopup(`RSRP:${p.rsrp} dBm${p.sinr!==null?` | SINR:${p.sinr} dB`:''}${p.pci!==null?` | PCI:${p.pci}`:''}`);
    });

    try { dtMap.fitBounds(L.latLngBounds(dtPoints.map(p=>[p.lat,p.lng])), { padding:[50,50] }); } catch {}
    const guide = byId('mapGuide'); if (guide) guide.style.display='none';

    setStatus('csvStatus',
      `✅ ${dtPoints.length} GPS | ${simPoints.length} ber-RSRP | ${noRsrpCount} dilewati | ~${(totalDist/1000).toFixed(2)} km`,'ok');
    setText('infoRawPoints',  dtPoints.length);
    setText('infoSimPoints',  simPoints.length);
    setText('infoNoRsrp',     noRsrpCount);
    setText('infoFiltered',   filtered);
    setText('infoRouteDist',  `${(totalDist/1000).toFixed(2)} km`);
    setText('infoHasRSRP',    `✓ ${simPoints.length}`);
    setText('infoHasSINR',    simPoints.filter(p=>p.sinr!==null).length>0
                               ? `✓ ${simPoints.filter(p=>p.sinr!==null).length}` : '✗');

    const colEl = byId('csvColInfo');
    if (colEl) {
      colEl.textContent = `Kolom — Lat:"${cols.lat}" Lng:"${cols.lng}"`
        + (cols.rsrp ? ` RSRP:"${cols.rsrp}"` : '')
        + (cols.sinr ? ` SINR:"${cols.sinr}"` : '')
        + (cols.pci  ? ` PCI:"${cols.pci}"`   : ' (no PCI)');
      colEl.style.display = 'block';
    }

    if (Object.keys(siteIndex).length) autoDetectAndCalibrate();
    else setStatus('siteMatchStatus','⚠️ Menunggu data site...','warn');
  }

  // ════════════════════════════════════════════════════════════════════════
  // EXPORT CSV
  // ════════════════════════════════════════════════════════════════════════
  function exportCSV() {
    if (!simResults.length) return alert('Jalankan simulasi terlebih dahulu!');
    const hasActR = simResults.some(r => r.rsrp_actual != null);
    const hasActS = simResults.some(r => r.sinr_actual != null);

    let csv = 'Point,Lat,Lng,Distance(m),TA_Seg,PCI,SiteID,' +
              'RSRP_3GPP(dBm),CL(dB),Bias_Seg(dB),Gain_G(dB),DistAdj(dB),' +
              'RSRP_Sim(dBm),SINR_Sim(dB)';
    if (hasActR) csv += ',RSRP_Aktual(dBm),Delta_RSRP(dB)';
    if (hasActS) csv += ',SINR_Aktual(dB),Delta_SINR(dB)';
    csv += '\n';

    simResults.forEach(r => {
      csv += `${r.index},${r.lat},${r.lng},${r.distance},${r.ta_seg},${r.pci},${r.siteId},` +
             `${r.rsrp3gpp},${r.clutter_loss},${r.bias_seg},${r.gain_g},${r.dist_adj},` +
             `${r.rsrp},${r.sinr}`;
      if (hasActR) {
        const d = r.rsrp_actual!=null ? (parseFloat(r.rsrp)-r.rsrp_actual).toFixed(2) : '';
        csv += `,${r.rsrp_actual??''},${d}`;
      }
      if (hasActS) {
        const d = r.sinr_actual!=null ? (parseFloat(r.sinr)-r.sinr_actual).toFixed(2) : '';
        csv += `,${r.sinr_actual??''},${d}`;
      }
      csv += '\n';
    });

    const blob = new Blob([csv], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const ts   = new Date().toISOString().slice(0,19).replace(/:/g,'-');
    const a    = document.createElement('a');
    a.href = url; a.download = `SimDT_v14_${ts}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ════════════════════════════════════════════════════════════════════════
  // GEO UTILS
  // ════════════════════════════════════════════════════════════════════════
  function haversine(la1,lo1,la2,lo2) {
    const R=6378137, dLa=(la2-la1)*Math.PI/180, dLo=(lo2-lo1)*Math.PI/180;
    const a=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function calcBearing(la1,lo1,la2,lo2) {
    const p1=la1*Math.PI/180, p2=la2*Math.PI/180, dl=(lo2-lo1)*Math.PI/180;
    return (Math.atan2(Math.sin(dl)*Math.cos(p2), Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI+360)%360;
  }
  function destPoint(lat,lng,az,dist) {
    const R=6378137, b=az*Math.PI/180, d=dist/R;
    const la1=lat*Math.PI/180, lo1=lng*Math.PI/180;
    const la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(b));
    const lo2=lo1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la1), Math.cos(d)-Math.sin(la1)*Math.sin(la2));
    return { lat:la2*180/Math.PI, lng:lo2*180/Math.PI };
  }
  function rsrpColor(v) {
    if (v>=-85)  return '#0042a5';
    if (v>=-95)  return '#00a955';
    if (v>=-105) return '#70ff66';
    if (v>=-120) return '#fffb00';
    if (v>=-140) return '#ff3333';
    return '#800000';
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function byId(id)       { return document.getElementById(id); }
  function setText(id,v)  { const e=byId(id); if(e) e.textContent=v; }
  function enableBtn(id)  { const e=byId(id); if(e) e.disabled=false; }
  function setStatus(id,msg,type) {
    const e=byId(id); if(!e) return;
    e.innerHTML=msg; e.className=`status-msg status-${type}`;
  }

})();

console.log('simulation_dt.js v14.0 — Distribution-Aware: Adaptive CL + Global Gain G + Histogram Matching + Tail Compression + SINR 3-var + Blended Bias');