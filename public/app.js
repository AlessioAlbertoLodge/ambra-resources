'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  type: 'solar',
  region: 'us',
  scale: 'utility',
  mode: 'resource',
  curtailment: true,
  plants: [],
  sortCol: 'capacity_ac',
  sortDir: 'desc',
};
let rawPlants = [];

// ── Opportunity constants ─────────────────────────────────────────────────────
const MW_PER_SYSTEM   = 9;        // MW solar per 100kW compute block
const REV_PER_SYSTEM  = 1480090;  // $/yr per 100kW system (64 GPUs × $3.3/hr × 8760 hrs × 80% util)

function plantRevenue(plant) {
  return (plant.capacity_ac / MW_PER_SYSTEM) * REV_PER_SYSTEM;
}

function fmtRevenue(usd) {
  if (usd >= 1e9) return { v: (usd / 1e9).toFixed(1), u: 'B$/yr' };
  if (usd >= 1e6) return { v: (usd / 1e6).toFixed(1), u: 'M$/yr' };
  return { v: Math.round(usd / 1e3).toLocaleString(), u: 'k$/yr' };
}

// ── Map setup ─────────────────────────────────────────────────────────────────
const map = L.map('map', {
  zoomControl: true,
  attributionControl: true,
  doubleClickZoom: false,
}).setView([39, -98], 4);

// ── Tile layers (ESRI — free, no API key, {z}/{y}/{x} ordering) ───────────────
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

const darkBase = L.tileLayer(`${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
  attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>',
  maxZoom: 16,
});
const darkLabels = L.tileLayer(`${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 16, opacity: 0.8,
});
const satBase = L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
  attribution: 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>',
  maxZoom: 18,
});
const satLabels = L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 18, opacity: 0.9,
});

// Start on dark view
darkBase.addTo(map);
darkLabels.addTo(map);

function setMapView(view) {
  const isSat = view === 'satellite';
  document.body.classList.toggle('sat', isSat);
  if (isSat) {
    map.removeLayer(darkBase);
    map.removeLayer(darkLabels);
    satBase.addTo(map);
    satLabels.addTo(map);
  } else {
    map.removeLayer(satBase);
    map.removeLayer(satLabels);
    darkBase.addTo(map);
    darkLabels.addTo(map);
  }
}

// ── Cluster groups ────────────────────────────────────────────────────────────
function makeClusterGroup(type) {
  const isSolar = type === 'solar';
  const color    = isSolar ? '#ff8c00' : '#4db8ff';
  const bg       = isSolar ? 'rgba(255,140,0,0.18)'  : 'rgba(77,184,255,0.18)';
  const glow     = isSolar ? 'rgba(255,140,0,0.45)'  : 'rgba(77,184,255,0.45)';
  const glowOuter= isSolar ? 'rgba(255,140,0,0.15)'  : 'rgba(77,184,255,0.15)';

  return L.markerClusterGroup({
    maxClusterRadius: 30,       // tighter grouping → clusters split earlier on zoom-out
    disableClusteringAtZoom: 7, // at zoom 7+ every marker always renders individually
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    spiderfyOnMaxZoom: true,
    chunkedLoading: true,
    chunkInterval: 100,
    chunkDelay: 50,
    iconCreateFunction(cluster) {
      const n = cluster.getChildCount();
      const size = n < 50 ? 30 : n < 200 ? 36 : n < 1000 ? 44 : 52;
      const label = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      return L.divIcon({
        html: `<div class="cl-icon" style="
          width:${size}px;height:${size}px;
          background:${bg};
          border:1.5px solid ${color};
          color:${color};
          box-shadow:0 0 10px ${glow},0 0 22px ${glowOuter};
          border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          font-family:'Inter',system-ui,sans-serif;
          font-size:${size < 36 ? 11 : 12}px;font-weight:700;
          cursor:pointer;
          backdrop-filter:blur(2px);
        ">${label}</div>`,
        className: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    },
  });
}

let solarCluster = makeClusterGroup('solar');
let windCluster  = makeClusterGroup('wind');
solarCluster.addTo(map);
windCluster.addTo(map);

// id → { marker, plant, clusterGroup }
const markersById = new Map();

// ── Preset bounds ─────────────────────────────────────────────────────────────
const REGION_BOUNDS = {
  us:    L.latLngBounds([[22, -130], [52, -62]]),
  eu:    L.latLngBounds([[34, -12],  [72, 42]]),
  us_eu: L.latLngBounds([[22, -130], [72, 42]]),
};

// ── Marker helpers ────────────────────────────────────────────────────────────
function capacityToRadius(capMW) {
  // min 5px so even tiny plants are clearly visible; max 16px for the largest
  return Math.max(3, Math.min(10, 3 + Math.log10(Math.max(capMW, 1)) * 2.2));
}

const CURTAIL_COLORS = {
  High: { fill: '#cc0000', stroke: '#ee3333' },
  Mid:  { fill: '#e65c00', stroke: '#ff7722' },
  Low:  { fill: '#ffd700', stroke: '#ffe94d' },
};

function markerColors(plant) {
  if (plant.type === 'solar') {
    if (state.mode === 'opportunity') {
      // Opportunity: Beach Head (red) = High curtailment only, Long Term (orange) = everything else
      return (plant.curtailment_risk === 'High' || plant.curtailment_risk === 'Mid')
        ? { fill: '#cc0000', stroke: '#ee3333' }
        : { fill: '#ff8c00', stroke: '#ffb347' };
    }
    // Resource: color by curtailment risk when toggle is on
    if (state.curtailment && plant.curtailment_risk && plant.curtailment_risk !== 'Unknown') {
      return CURTAIL_COLORS[plant.curtailment_risk] || { fill: '#ff8c00', stroke: '#ffb347' };
    }
    return { fill: '#ff8c00', stroke: '#ffb347' };
  }
  return { fill: '#4db8ff', stroke: '#80ccff' };
}

function makeMarker(plant) {
  const r = capacityToRadius(plant.capacity_ac);
  const { fill, stroke } = markerColors(plant);
  return L.circleMarker([plant.lat, plant.lng], {
    radius: r,
    fillColor:   fill,
    color:       stroke,
    weight: 1,
    fillOpacity: 0.88,
    opacity: 1,
    className:   plant.type === 'solar' ? 'marker-solar' : 'marker-wind',
    interactive: true,
    bubblingMouseEvents: false,
  });
}

function buildPopup(plant) {
  const loc = [plant.county, plant.state].filter(Boolean).join(', ');
  return `
    <div class="popup-name">${esc(plant.name)}</div>
    ${plant.utility_name ? `<div class="popup-row"><span>Utility</span><span class="val">${esc(plant.utility_name)}</span></div>` : ''}
    ${plant.source ? `<div class="popup-row"><span>Source</span><span class="val">${esc(plant.source)}</span></div>` : ''}
    ${plant.caiso_node ? `<div class="popup-row popup-divider"><span>Node</span><span class="val">${esc(plant.caiso_node)}</span></div>` : ''}
    ${plant.curtailment_risk && plant.curtailment_risk !== 'Unknown' ? `
    <div class="popup-row"><span>Curtailment</span><span class="val curtail-badge curtail-${plant.curtailment_risk.toLowerCase()}">${plant.curtailment_risk}</span></div>
    <div class="popup-row"><span>MCC avg</span><span class="val">${plant.mcc_avg != null ? plant.mcc_avg.toFixed(2) + ' $/MWh' : '—'}</span></div>
    <div class="popup-row"><span>Neg. hours</span><span class="val">${plant.mcc_pct_neg != null ? plant.mcc_pct_neg.toFixed(1) + '%' : '—'}</span></div>` : ''}
    <div class="popup-row"><span>AC</span><span class="val">${plant.capacity_ac.toFixed(1)} MW</span></div>
    ${plant.capacity_dc != null ? `<div class="popup-row"><span>DC</span><span class="val">${plant.capacity_dc.toFixed(1)} MW</span></div>` : ''}
    <div class="popup-row"><span>Location</span><span class="val">${esc(loc)}</span></div>
    ${plant.year ? `<div class="popup-row"><span>Year</span><span class="val">${plant.year}</span></div>` : ''}
    <div class="popup-row"><span>Type</span><span class="val">${cap1(plant.type)}</span></div>
  `.trim();
}

// ── Render markers ─────────────────────────────────────────────────────────────
function renderMarkers(plants) {
  // Remove old cluster groups and create fresh ones so chunkedLoading resets cleanly
  map.removeLayer(solarCluster);
  map.removeLayer(windCluster);
  markersById.clear();

  solarCluster = makeClusterGroup('solar');
  windCluster  = makeClusterGroup('wind');

  const solarBatch = [];
  const windBatch  = [];

  for (const plant of plants) {
    const marker = makeMarker(plant);

    marker.bindPopup(buildPopup(plant), {
      closeButton: false,
      maxWidth: 230,
      offset: [0, -2],
    });

    marker.on('mouseover', () => {
      marker.openPopup();
      highlightRow(plant.id);
    });
    marker.on('mouseout', () => {
      marker.closePopup();
      clearRowHighlight();
    });
    marker.on('dblclick', () => {
      map.setView([plant.lat, plant.lng], 14, { animate: true });
    });

    const grp = plant.type === 'solar' ? solarBatch : windBatch;
    grp.push(marker);
    markersById.set(plant.id, {
      marker,
      plant,
      clusterGroup: plant.type === 'solar' ? solarCluster : windCluster,
    });
  }

  // addLayers is much faster than individual addLayer calls
  if (solarBatch.length) solarCluster.addLayers(solarBatch);
  if (windBatch.length)  windCluster.addLayers(windBatch);

  solarCluster.addTo(map);
  windCluster.addTo(map);

  document.getElementById('map-empty').classList.toggle('hidden', plants.length > 0);
}

function fitBounds(region, plants) {
  if (plants.length === 0) {
    map.fitBounds(REGION_BOUNDS[region] || REGION_BOUNDS.us_eu, { padding: [30, 30] });
    return;
  }
  const bounds = L.latLngBounds(plants.map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function fmtCap(mw) {
  if (mw >= 1000) return { v: (mw / 1000).toFixed(1), u: 'GW' };
  return { v: mw < 10 ? mw.toFixed(1) : Math.round(mw).toLocaleString(), u: 'MW' };
}

function renderMetrics(plants) {
  const regionLabel = { us: 'US', eu: 'EU', us_eu: 'US + EU' };
  const region = regionLabel[state.region] ?? state.region.toUpperCase();

  if (state.mode === 'opportunity') {
    const totalRev = plants.reduce((s, p) => s + plantRevenue(p), 0);
    const avgRev   = plants.length ? totalRev / plants.length : 0;
    const rev = fmtRevenue(totalRev);
    const avg = fmtRevenue(avgRev);

    const byType = { solar: { count: 0, rev: 0 }, wind: { count: 0, rev: 0 } };
    for (const p of plants) {
      if (byType[p.type]) { byType[p.type].count++; byType[p.type].rev += plantRevenue(p); }
    }

    document.querySelector('#m-plants .metric-label').textContent = 'Nodes';
    document.querySelector('#m-plants .metric-value').textContent = plants.length.toLocaleString();
    document.querySelector('#m-capacity .metric-label').textContent = 'Revenue / yr';
    document.querySelector('#m-capacity .metric-value').innerHTML = `${rev.v}<span class="metric-unit">${rev.u}</span>`;
    document.querySelector('#m-avg .metric-label').textContent = 'Per Node';
    document.querySelector('#m-avg .metric-value').innerHTML = `${avg.v}<span class="metric-unit">${avg.u}</span>`;
    document.querySelector('#m-region .metric-label').textContent = 'Region';
    document.querySelector('#m-region .metric-value').textContent = region;

    const sr = fmtRevenue(byType.solar.rev);
    document.getElementById('solar-count').textContent = byType.solar.count.toLocaleString();
    document.getElementById('solar-cap').textContent   = `${sr.v} ${sr.u}`;
    const wr = fmtRevenue(byType.wind.rev);
    document.getElementById('wind-count').textContent  = byType.wind.count.toLocaleString();
    document.getElementById('wind-cap').textContent    = `${wr.v} ${wr.u}`;

  } else {
    const m = computeMetrics(plants);
    const tot = fmtCap(m.totalCapacityAC);
    const avg = fmtCap(m.avgCapacity);

    document.querySelector('#m-plants .metric-label').textContent = 'Plants';
    document.querySelector('#m-plants .metric-value').textContent = m.total.toLocaleString();
    document.querySelector('#m-capacity .metric-label').textContent = 'Total Capacity';
    document.querySelector('#m-capacity .metric-value').innerHTML = `${tot.v}<span class="metric-unit">${tot.u}</span>`;
    document.querySelector('#m-avg .metric-label').textContent = 'Avg. Plant';
    document.querySelector('#m-avg .metric-value').innerHTML = `${avg.v}<span class="metric-unit">${avg.u}</span>`;
    document.querySelector('#m-region .metric-label').textContent = 'Region';
    document.querySelector('#m-region .metric-value').textContent = region;

    const sc = fmtCap(m.byType.solar.capacity);
    document.getElementById('solar-count').textContent = m.byType.solar.count.toLocaleString();
    document.getElementById('solar-cap').textContent   = `${sc.v} ${sc.u}`;
    const wc = fmtCap(m.byType.wind.capacity);
    document.getElementById('wind-count').textContent  = m.byType.wind.count.toLocaleString();
    document.getElementById('wind-cap').textContent    = `${wc.v} ${wc.u}`;
  }
}

// ── Table ─────────────────────────────────────────────────────────────────────
const TABLE_MAX = 500;

function sortPlants(plants) {
  const col = state.sortCol;
  const dir = state.sortDir === 'asc' ? 1 : -1;

  return [...plants].sort((a, b) => {
    let av, bv;
    if      (col === 'capacity_ac') { av = a.capacity_ac; bv = b.capacity_ac; }
    else if (col === 'revenue')     { av = plantRevenue(a); bv = plantRevenue(b); }
    else if (col === 'name')        { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
    else if (col === 'location')    { av = `${a.state}${a.county}`.toLowerCase(); bv = `${b.state}${b.county}`.toLowerCase(); }
    else if (col === 'utility_name'){ av = (a.utility_name || '').toLowerCase(); bv = (b.utility_name || '').toLowerCase(); }
    else if (col === 'type')        { av = a.type; bv = b.type; }
    else return 0;
    return av < bv ? -dir : av > bv ? dir : 0;
  });
}

function setTableHeaders(cols) {
  const thead = document.querySelector('#plants-table thead tr');
  thead.innerHTML = cols.map(({ col, label }) => {
    const sort = state.sortCol === col
      ? (state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc') : '';
    return `<th data-col="${col}" class="${sort}">${label} <span class="sort-icon"></span></th>`;
  }).join('');
  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortCol = col; state.sortDir = col === 'capacity_ac' || col === 'revenue' ? 'desc' : 'asc'; }
      renderTable(state.plants);
    });
  });
}

function renderTable(plants) {
  if (state.mode === 'opportunity') {
    renderOpportunityTable(plants);
  } else {
    renderResourceTable(plants);
  }
}

function renderResourceTable(plants) {
  setTableHeaders([
    { col: 'name',         label: 'Name'     },
    { col: 'capacity_ac',  label: 'MW'       },
    { col: 'location',     label: 'Location' },
    { col: 'utility_name', label: 'Utility'  },
    { col: 'type',         label: 'Type'     },
  ]);

  const countEl = document.getElementById('table-count');
  const tbody   = document.getElementById('plants-tbody');

  if (plants.length === 0) {
    countEl.textContent = '0 plants';
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No plants match this filter.</td></tr>';
    return;
  }

  const shown = sortPlants(plants).slice(0, TABLE_MAX);
  countEl.textContent = plants.length > TABLE_MAX
    ? `Showing ${TABLE_MAX.toLocaleString()} of ${plants.length.toLocaleString()} plants`
    : `${plants.length.toLocaleString()} plant${plants.length !== 1 ? 's' : ''}`;

  const frag = document.createDocumentFragment();
  for (const plant of shown) {
    const loc = [plant.county, plant.state].filter(Boolean).join(', ');
    const tr  = document.createElement('tr');
    tr.dataset.id = plant.id;
    tr.innerHTML = `
      <td class="cell-name" title="${esc(plant.name)}">${esc(plant.name)}</td>
      <td class="cell-cap">${plant.capacity_ac.toFixed(1)}</td>
      <td>${esc(loc)}</td>
      <td class="cell-utility" title="${esc(plant.utility_name)}">${esc(plant.utility_name || '—')}</td>
      <td><span class="type-badge ${plant.type}">${cap1(plant.type)}</span></td>`;
    tr.addEventListener('mouseenter', () => { highlightMarker(plant.id, true);  tr.classList.add('row-hl'); });
    tr.addEventListener('mouseleave', () => { highlightMarker(plant.id, false); tr.classList.remove('row-hl'); });
    tr.addEventListener('click', () => panToPlant(plant.id));
    frag.appendChild(tr);
  }
  tbody.textContent = '';
  tbody.appendChild(frag);
}

function renderOpportunityTable(plants) {
  setTableHeaders([
    { col: 'name',     label: 'Name'       },
    { col: 'revenue',  label: 'Revenue/yr' },
    { col: 'capacity_ac', label: 'MW'      },
    { col: 'location', label: 'Location'   },
    { col: 'type',     label: 'Type'       },
  ]);

  if (state.sortCol === 'capacity_ac' && state.mode === 'opportunity') {
    state.sortCol = 'revenue';
  }

  const countEl = document.getElementById('table-count');
  const tbody   = document.getElementById('plants-tbody');

  if (plants.length === 0) {
    countEl.textContent = '0 nodes';
    tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No plants match this filter.</td></tr>';
    return;
  }

  const shown = sortPlants(plants).slice(0, TABLE_MAX);
  countEl.textContent = plants.length > TABLE_MAX
    ? `Showing ${TABLE_MAX.toLocaleString()} of ${plants.length.toLocaleString()} nodes`
    : `${plants.length.toLocaleString()} node${plants.length !== 1 ? 's' : ''}`;

  const frag = document.createDocumentFragment();
  for (const plant of shown) {
    const loc = [plant.county, plant.state].filter(Boolean).join(', ');
    const rev = fmtRevenue(plantRevenue(plant));
    const tr  = document.createElement('tr');
    tr.dataset.id = plant.id;
    tr.innerHTML = `
      <td class="cell-name" title="${esc(plant.name)}">${esc(plant.name)}</td>
      <td class="cell-cap">${rev.v} <span style="opacity:0.6;font-size:10px">${rev.u}</span></td>
      <td class="cell-cap">${plant.capacity_ac.toFixed(1)}</td>
      <td>${esc(loc)}</td>
      <td><span class="type-badge ${plant.type}">${cap1(plant.type)}</span></td>`;
    tr.addEventListener('mouseenter', () => { highlightMarker(plant.id, true);  tr.classList.add('row-hl'); });
    tr.addEventListener('mouseleave', () => { highlightMarker(plant.id, false); tr.classList.remove('row-hl'); });
    tr.addEventListener('click', () => panToPlant(plant.id));
    frag.appendChild(tr);
  }
  tbody.textContent = '';
  tbody.appendChild(frag);
}

// ── Cross-highlight ───────────────────────────────────────────────────────────
function highlightRow(id) {
  document.querySelectorAll('#plants-tbody tr[data-id]').forEach(tr => {
    const on = tr.dataset.id === id;
    tr.classList.toggle('row-hl', on);
    if (on) tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function clearRowHighlight() {
  document.querySelectorAll('#plants-tbody tr.row-hl').forEach(tr => tr.classList.remove('row-hl'));
}

function highlightMarker(id, on) {
  const entry = markersById.get(id);
  if (!entry) return;
  if (on) entry.marker.openPopup();
  else    entry.marker.closePopup();
}

function panToPlant(id) {
  const entry = markersById.get(id);
  if (!entry) return;
  // zoomToShowLayer unclusters + pans to the marker, then fires the callback
  entry.clusterGroup.zoomToShowLayer(entry.marker, () => {
    setTimeout(() => entry.marker.openPopup(), 120);
  });
}

// ── Fetch & render ─────────────────────────────────────────────────────────────
function computeMetrics(plants) {
  const totalAC = plants.reduce((s, p) => s + p.capacity_ac, 0);
  const avg = plants.length ? totalAC / plants.length : 0;
  const byType = { solar: { count: 0, capacity: 0 }, wind: { count: 0, capacity: 0 } };
  for (const p of plants) {
    if (byType[p.type]) { byType[p.type].count++; byType[p.type].capacity += p.capacity_ac; }
  }
  return { total: plants.length, totalCapacityAC: totalAC, avgCapacity: avg, byType };
}

function applyFiltersAndRender() {
  const filtered = state.scale === 'utility'
    ? rawPlants.filter(p => p.capacity_ac >= 1)
    : rawPlants;
  state.plants = filtered;
  renderMetrics(filtered);
  renderTable(filtered);
  renderMarkers(filtered);
  fitBounds(state.region, filtered);
}

async function refresh() {
  try {
    const res = await fetch(`/api/plants?type=${state.type}&region=${state.region}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    rawPlants = data.plants;
    applyFiltersAndRender();
  } catch (err) {
    console.error('Failed to load plants:', err);
  }
}

// ── Controls ──────────────────────────────────────────────────────────────────
function initControls() {
  document.getElementById('type-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#type-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.type = btn.dataset.value;
    refresh();
  });

  document.getElementById('region-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#region-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.region = btn.dataset.value;
    refresh();
  });

  document.getElementById('view-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#view-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setMapView(btn.dataset.value);
  });

  document.getElementById('scale-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#scale-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.scale = btn.dataset.value;
    applyFiltersAndRender();
  });

  document.getElementById('curtail-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#curtail-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.curtailment = btn.dataset.value === 'on';
    renderMarkers(state.plants);
  });

  document.getElementById('mode-selector').addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    const isOpp = state.mode === 'opportunity';
    document.getElementById('curtail-control').classList.toggle('hidden', isOpp);
    document.getElementById('legend-control').classList.toggle('hidden', !isOpp);
    if (isOpp) {
      state.sortCol = 'revenue';
      state.sortDir = 'desc';
    } else {
      state.sortCol = 'capacity_ac';
      state.sortDir = 'desc';
    }
    renderMetrics(state.plants);
    renderTable(state.plants);
    renderMarkers(state.plants);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s)  { return String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c]); }
function cap1(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

// ── Panel toggle ──────────────────────────────────────────────────────────────
document.getElementById('panel-toggle').addEventListener('click', () => {
  const collapsed = document.getElementById('app').classList.toggle('panel-collapsed');
  document.getElementById('panel-toggle').innerHTML = collapsed ? '&#x276F;' : '&#x276E;';
  map.invalidateSize();
});

// ── Sources toggle ────────────────────────────────────────────────────────────
document.getElementById('sources-btn').addEventListener('click', () => {
  const btn = document.getElementById('sources-btn');
  const isOpen = btn.classList.toggle('active');
  document.getElementById('sources-panel').classList.toggle('hidden', !isOpen);
  document.getElementById('metrics-section').classList.toggle('hidden', isOpen);
  document.getElementById('controls-section').classList.toggle('hidden', isOpen);
  document.getElementById('table-section').classList.toggle('hidden', isOpen);
  btn.textContent = isOpen ? 'Close' : 'Sources';
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initControls();
refresh();
