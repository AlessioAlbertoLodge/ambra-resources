# Ambra Energy Resources

Interactive map of utility-scale solar and wind assets across the US and Europe, with curtailment risk overlay for US solar.

Live at **[app.ambra-energy.com](https://app.ambra-energy.com)**

---

## Stack

- **Server** — Node.js / Express, serves static files + `/api/plants` JSON endpoint
- **Map** — Leaflet.js with MarkerClusterGroup, ESRI tile layers
- **Data** — CSV files parsed at boot into memory, no database
- **Hosting** — Vercel (serverless), auto-deploys from `main`

## Repo structure

```
energy-viz/
├── server.js          # Express server + data loading pipeline
├── vercel.json        # Vercel deployment config
├── public/
│   ├── index.html
│   ├── app.js         # Map, markers, controls, table
│   └── style.css
└── data/
    ├── solar_farms_us.csv       # USGS USPVDB
    ├── wind_farms_us.csv        # EIA Form 860
    ├── solar_farms_es.csv       # REE ESIOS
    ├── wind_farms_es.csv        # REE ESIOS / MINETUR
    ├── solar_farms_uk.csv       # REPD (DESNZ)
    ├── wind_farms_uk.csv        # REPD (DESNZ)
    ├── solar_farms_nl.csv       # Zon op Kaart (RVO)
    ├── solar_farms_de.csv       # Marktstammdatenregister (MaStR)
    ├── wind_farms_de.csv        # Marktstammdatenregister (MaStR)
    ├── plants_it.csv            # OpenStreetMap
    └── curtailment/
        ├── solar_farms_caiso_curtailment_mcc.csv
        └── solar_farms_us_node_LMPs_curtailment.csv
```

## Adding a new country

Append an entry to `DATA_SOURCES` in `server.js`:

```js
{ file: 'data/solar_farms_XX.csv', region: 'eu', source: 'SOURCE_NAME', defaultType: 'solar' }
```

The loader handles multiple column name conventions automatically (`ylat`/`latitude`/`lat`, `p_cap_ac`/`capacity_mw`/`mw`/`net_capacity_kw`, etc.). Use `capacityScale: 0.001` if the source file is in kW.

## Curtailment

US solar curtailment risk is derived from LMP node prices (GridStatus) matched to the nearest pricing node per plant. The MCC (Marginal Cost of Congestion) component is used as a congestion proxy. ERCOT uses an approximated MCC: `SPP_node − HB_HUBAVG`. See the Sources panel in the app for full methodology.
