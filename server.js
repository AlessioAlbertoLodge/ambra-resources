'use strict';

const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(compression());
const PORT = process.env.PORT || 3000;

// ── Data pipeline ─────────────────────────────────────────────────────────────
// To add new regions or energy types, append an entry here.
// The CSV's p_tech_pri column drives type: "PV" → "solar", "WIND" → "wind".
// The region field controls ?region= filtering on the API.
const DATA_SOURCES = [
  { file: 'data/solar_farms_us.csv', region: 'us',  source: 'EIA'  },
  { file: 'data/wind_farms_us.csv',  region: 'us',  source: 'EIA'  },
  { file: 'data/solar_farms_es.csv', region: 'eu',  source: 'REE'  },
  { file: 'data/solar_farms_uk.csv', region: 'eu',  source: 'REPD' },
  { file: 'data/wind_farms_uk.csv',  region: 'eu',  source: 'REPD' },
  { file: 'data/solar_farms_nl.csv', region: 'eu',  source: 'RVO',     defaultType: 'solar' },
  { file: 'data/plants_it.csv',      region: 'eu',  source: 'OSM',     typeCol: 'source'    },
  { file: 'data/wind_farms_es.csv',  region: 'eu',  source: 'MINETUR', defaultType: 'wind'  },
  { file: 'data/solar_farms_de.csv',  region: 'eu',  source: 'MaStR',   defaultType: 'solar', capacityScale: 0.001 },
  { file: 'data/wind_farms_de.csv',  region: 'eu',  source: 'MaStR',   defaultType: 'wind',  capacityScale: 0.001 },
];

let plants = [];
let curtailmentMap = new Map(); // case_id → { mcc_avg, mcc_pct_neg, curtailment_risk, caiso_node }

function loadCurtailmentFile(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  for (const row of records) {
    const avg = parseFloat(row.mcc_avg_2025);
    const pct = parseFloat(row.mcc_pct_neg_hrs_2025);
    curtailmentMap.set(String(row.case_id), {
      mcc_avg:          Number.isFinite(avg) ? +avg.toFixed(3) : null,
      mcc_pct_neg:      Number.isFinite(pct) ? +pct.toFixed(1) : null,
      curtailment_risk: (row.curtailment_risk || 'Unknown').trim(),
      caiso_node:       (row.closest_node_id || '').trim(),
      curtailment_iso:  (row.mcc_source_iso || '').trim(),
    });
  }
  return records.length;
}

function loadCurtailmentData() {
  loadCurtailmentFile(path.join(__dirname, 'data/curtailment/solar_farms_caiso_curtailment_mcc.csv'));
  loadCurtailmentFile(path.join(__dirname, 'data/curtailment/solar_farms_us_node_LMPs_curtailment.csv'));
  console.log(`  Curtailment data: ${curtailmentMap.size} US solar plants`);
}

function detectDelimiter(header) {
  const tabs = (header.match(/\t/g) || []).length;
  const commas = (header.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

function parseTechType(raw) {
  const t = (raw || '').trim().toUpperCase();
  if (t === 'PV' || t === 'SOLAR') return 'solar';
  if (t.includes('WIND')) return 'wind';
  return 'other';
}

// Read first non-empty value from a list of column name candidates
function getField(row, ...keys) {
  for (const k of keys) {
    if (k && row[k] !== undefined && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}

function loadSource(source) {
  const filePath = path.join(__dirname, source.file);
  if (!fs.existsSync(filePath)) {
    console.warn(`  [skip] ${source.file} — file not found`);
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const header = content.split(/\r?\n/)[0];
  const delimiter = detectDelimiter(header);

  const records = parse(content, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  let added = 0;
  for (const row of records) {
    // skip decommissioned plants (Spain MINETUR uses 'baja'; MaStR uses operating_status=35 for active)
    if (getField(row, 'baja')) continue;
    const opStatus = getField(row, 'operating_status');
    if (opStatus && opStatus !== '35') continue;

    const lat   = parseFloat(getField(row, 'ylat', 'latitude', 'lat'));
    const lng   = parseFloat(getField(row, 'xlong', 'longitude', 'lon'));
    const rawCap = parseFloat(getField(row, 'p_cap_ac', 'capacity_mw', 'mw', 'net_capacity_kw', 'gross_capacity_kw'));
    const capAC = Number.isFinite(rawCap) ? rawCap * (source.capacityScale || 1) : NaN;

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) continue;
    if (!Number.isFinite(capAC) || capAC <= 0) continue;

    const capDC  = parseFloat(getField(row, 'p_cap_dc'));
    const rawType = source.typeCol ? (row[source.typeCol] || '') : getField(row, 'p_tech_pri');
    const type   = source.defaultType || parseTechType(rawType);
    const caseId = getField(row, 'case_id', 'objectid');

    plants.push({
      id:           caseId || `${source.region}-${source.source}-${added}`,
      name:         getField(row, 'p_name', 'wind_park_name', 'plant_name', 'name', 'descripcion', 'operator') || 'Unknown',
      lat, lng,
      capacity_ac:  capAC,
      capacity_dc:  Number.isFinite(capDC) ? capDC : null,
      state:        getField(row, 'p_state', 'province', 'provincia', 'district'),
      county:       getField(row, 'p_county', 'municipality', 'municipio'),
      year:         parseInt(getField(row, 'p_year', 'year_realized', 'alta', 'commissioning_date'), 10) || null,
      type,
      region:       source.region,
      plant_type:   getField(row, 'p_type'),
      utility_name: getField(row, 'utility_name', 'operator_name', 'operator'),
      source:       source.source,
      ...curtailmentMap.get(caseId),
    });
    added++;
  }

  return added;
}

function boot() {
  console.log('\nLoading energy data…');
  plants = [];
  loadCurtailmentData();
  for (const src of DATA_SOURCES) {
    const n = loadSource(src);
    if (n > 0) console.log(`  ${src.file}: ${n.toLocaleString()} valid plants`);
  }
  console.log(`  Total: ${plants.length.toLocaleString()} plants ready\n`);
}

// ── Static & SPA routing ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// REY dashboard — serve index.html for all /rey/* paths (client-side routing)
app.get('/rey', (req, res) => res.redirect('/rey/'));
app.get('/rey/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rey', 'index.html'));
});

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/plants', (req, res) => {
  const { type = 'both', region = 'us' } = req.query;

  let list = plants;

  if (type === 'solar') list = list.filter(p => p.type === 'solar');
  else if (type === 'wind') list = list.filter(p => p.type === 'wind');
  // 'both' keeps all types

  if (region === 'us') list = list.filter(p => p.region === 'us');
  else if (region === 'eu') list = list.filter(p => p.region === 'eu');
  // 'us_eu' keeps all regions

  const totalAC = list.reduce((s, p) => s + p.capacity_ac, 0);
  const avg = list.length ? totalAC / list.length : 0;

  const byType = {
    solar: { count: 0, capacity: 0 },
    wind: { count: 0, capacity: 0 },
  };
  for (const p of list) {
    if (byType[p.type]) {
      byType[p.type].count++;
      byType[p.type].capacity += p.capacity_ac;
    }
  }

  res.json({
    plants: list,
    metrics: {
      total: list.length,
      totalCapacityAC: totalAC,
      avgCapacity: avg,
      byType,
    },
  });
});

boot();

// Local dev: start the HTTP server.
// Vercel: imports this file as a module and uses the exported app directly.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Energy Viz  →  http://localhost:${PORT}\n`);
  });
}

module.exports = app;
