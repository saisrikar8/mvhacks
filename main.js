import mapboxgl from 'mapbox-gl';
import bbox from '@turf/bbox';
import buffer from '@turf/buffer';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { lineString } from '@turf/helpers';

const MB_TOKEN = import.meta.env.VITE_MAP_API_KEY;
mapboxgl.accessToken = MB_TOKEN;

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11',
    center: [-40, 22],
    zoom: 2.4,
    minZoom: 1.2,
    projection: 'globe',
    antialias: true
});

const loader = document.getElementById('loader');
const dash = document.getElementById('dash');
const legend = document.getElementById('legend');
const btnRoute = document.getElementById('btn-route');
const btnUndo = document.getElementById('btn-undo');
const btnClear = document.getElementById('btn-clear');
const toggleBathymetry = document.getElementById('toggle-bathymetry');
const toggleShallowPenalty = document.getElementById('toggle-shallow-penalty');

const BATHYMETRY_SOURCE_ID = 'mapbox-bathymetry-v2';
const BATHYMETRY_LAYER_FILL = 'bathymetry-depth-fill';
const BATHYMETRY_LAYER_SHALLOW = 'bathymetry-shallow-warn';

/** @type {mapboxgl.Marker[]} */
let routeMarkers = [];
/** @type {mapboxgl.Marker[]} */
let hazardMarkers = [];
/** @type {mapboxgl.LngLat[]} */
let routePoints = [];
/** @type {any[]} */
let currentResults = [];

function applyVibrantCoastalPalette() {
    try {
        if (map.getLayer('land')) {
            map.setPaintProperty('land', 'background-color', 'hsl(42, 44%, 93%)');
        }
        if (map.getLayer('land-structure-polygon')) {
            map.setPaintProperty('land-structure-polygon', 'fill-color', 'hsl(38, 36%, 91%)');
        }
        if (map.getLayer('water')) {
            map.setPaintProperty('water', 'fill-color', 'hsl(197, 82%, 58%)');
        }
        if (map.getLayer('waterway')) {
            map.setPaintProperty('waterway', 'line-color', 'hsl(200, 74%, 42%)');
        }
        if (map.getLayer('national-park')) {
            map.setPaintProperty('national-park', 'fill-color', 'hsl(122, 36%, 84%)');
        }
        for (const lid of ['waterway-label', 'water-line-label', 'water-point-label']) {
            if (!map.getLayer(lid)) continue;
            map.setPaintProperty(lid, 'text-color', 'hsl(205, 62%, 24%)');
            map.setPaintProperty(lid, 'text-halo-color', 'rgba(255,255,255,0.92)');
        }
    } catch (e) {
        console.warn('Coastal palette tweak skipped:', e);
    }
}

function firstSymbolLayerId() {
    const layers = map.getStyle()?.layers;
    if (!layers) return undefined;
    const sym = layers.find((l) => l.type === 'symbol');
    return sym?.id;
}

function addBathymetryLayers() {
    if (map.getSource(BATHYMETRY_SOURCE_ID)) return;
    try {
        map.addSource(BATHYMETRY_SOURCE_ID, {
            type: 'vector',
            url: 'mapbox://mapbox.mapbox-bathymetry-v2'
        });
    } catch (e) {
        console.warn('Bathymetry source failed:', e);
        return;
    }
    const beforeId = firstSymbolLayerId();
    const baseLayer = {
        id: BATHYMETRY_LAYER_FILL,
        type: 'fill',
        source: BATHYMETRY_SOURCE_ID,
        'source-layer': 'depth',
        minzoom: 0,
        maxzoom: 22,
        paint: {
            'fill-color': [
                'interpolate',
                ['linear'],
                ['get', 'min_depth'],
                0,
                'rgba(186, 230, 253, 0.42)',
                50,
                'rgba(125, 211, 252, 0.36)',
                200,
                'rgba(56, 189, 248, 0.32)',
                1000,
                'rgba(14, 116, 144, 0.38)',
                4000,
                'rgba(12, 74, 110, 0.45)',
                9000,
                'rgba(8, 47, 73, 0.5)'
            ],
            'fill-opacity': 0.72,
            'fill-outline-color': 'rgba(255,255,255,0.06)'
        }
    };
    const shallowLayer = {
        id: BATHYMETRY_LAYER_SHALLOW,
        type: 'fill',
        source: BATHYMETRY_SOURCE_ID,
        'source-layer': 'depth',
        minzoom: 0,
        maxzoom: 22,
        filter: ['all', ['has', 'min_depth'], ['<=', ['get', 'min_depth'], 200]],
        paint: {
            'fill-color': 'rgba(251, 191, 36, 0.22)',
            'fill-outline-color': 'rgba(234, 88, 12, 0.35)'
        }
    };
    try {
        if (beforeId) {
            map.addLayer(baseLayer, beforeId);
            map.addLayer(shallowLayer, beforeId);
        } else {
            map.addLayer(baseLayer);
            map.addLayer(shallowLayer);
        }
    } catch (e) {
        console.warn('Bathymetry layers failed:', e);
    }
}

function setBathymetryOverlayVisible(on) {
    for (const id of [BATHYMETRY_LAYER_FILL, BATHYMETRY_LAYER_SHALLOW]) {
        if (!map.getLayer(id)) continue;
        map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
}

if (toggleBathymetry) {
    toggleBathymetry.addEventListener('change', () => {
        setBathymetryOverlayVisible(!!toggleBathymetry.checked);
    });
}

map.on('load', () => {
    applyVibrantCoastalPalette();
    map.setFog({
        color: 'rgb(186, 224, 252)',
        'high-color': 'rgb(255, 242, 214)',
        'space-color': 'rgb(150, 196, 242)',
        'horizon-blend': 0.032,
        'star-intensity': 0.075
    });
    addBathymetryLayers();
    setBathymetryOverlayVisible(!!toggleBathymetry?.checked);
});

/** Coarse centerlines for major ship canals (Mapbox `waterway` often has minzoom 8 — these still work when zoomed out). */
const KNOWN_SHIP_CANALS = [
    lineString([
        [-79.942, 9.406], [-79.88, 9.32], [-79.78, 9.18], [-79.65, 9.08], [-79.55, 8.98], [-79.521, 8.913]
    ], { id: 'panama' }),
    lineString([
        [32.311, 31.265], [32.38, 31.15], [32.45, 30.85], [32.50, 30.4], [32.52, 30.0], [32.53, 29.95]
    ], { id: 'suez' }),
    lineString([
        [9.127, 53.889], [9.45, 54.02], [9.85, 54.15], [10.05, 54.28], [10.132, 54.321]
    ], { id: 'kiel' }),
    lineString([
        [22.993, 37.938], [22.999, 37.922], [23.006, 37.908]
    ], { id: 'corinth' })
];

function bboxOverlapsMap(bb, west, south, east, north) {
    const [minX, minY, maxX, maxY] = bb;
    return !(maxX < west || minX > east || maxY < south || minY > north);
}

/** Great-circle distance (km) for step counts along geodesics (matches globe line rendering). */
function haversineKm(lon1, lat1, lon2, lat2) {
    const R = 6371;
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r;
    const dLon = (lon2 - lon1) * r;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Spherical linear interpolation — positions along the geodesic Mapbox draws between two lng/lats on the globe.
 * @returns {[number, number]} [lng, lat]
 */
function interpolateGeodesic(lon1, lat1, lon2, lat2, t) {
    const φ1 = lat1 * (Math.PI / 180);
    const λ1 = lon1 * (Math.PI / 180);
    const φ2 = lat2 * (Math.PI / 180);
    const λ2 = lon2 * (Math.PI / 180);
    const d =
        2 *
        Math.asin(
            Math.min(
                1,
                Math.sqrt(
                    Math.sin((φ2 - φ1) / 2) ** 2 +
                        Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
                )
            )
        );
    if (d < 1e-12) return [lon1, lat1];
    const s = Math.sin(d);
    const a = Math.sin((1 - t) * d) / s;
    const b = Math.sin(t * d) / s;
    const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
    const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
    const z = a * Math.sin(φ1) + b * Math.sin(φ2);
    const φ = Math.atan2(z, Math.hypot(x, y));
    const λ = Math.atan2(y, x);
    return [(λ * 180) / Math.PI, (φ * 180) / Math.PI];
}

/** Reused for booleanPointInPolygon against Mapbox water features (avoids allocations in hot paths). */
const navigablePipPoint = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [0, 0] }
};

/**
 * True iff (lng,lat) lies inside any navigable water polygon (oceans + canal buffers), not grid voting.
 */
function pointInNavigableWater(navGrid, lng, lat) {
    const { west, south, east, north } = navGrid;
    if (lng < west || lng > east || lat < south || lat > north) return false;
    const b = navGrid.waterBuckets;
    if (!b || !navGrid.waterBucketCols) return gridIsWater(navGrid, lng, lat);
    navigablePipPoint.geometry.coordinates[0] = lng;
    navigablePipPoint.geometry.coordinates[1] = lat;
    const BI = navGrid.waterBucketCols;
    const BJ = navGrid.waterBucketRows;
    const bw = navGrid.waterBucketW;
    const bh = navGrid.waterBucketH;
    const ii = Math.min(BI - 1, Math.max(0, Math.floor((lng - west) / bw)));
    const jj = Math.min(BJ - 1, Math.max(0, Math.floor((lat - south) / bh)));
    const cand = b[ii + jj * BI];
    for (const item of cand) {
        const [minX, minY, maxX, maxY] = item.bb;
        if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
        if (booleanPointInPolygon(navigablePipPoint, item.f)) return true;
    }
    return false;
}

function waitMapIdle() {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(failSafe);
            resolve();
        };
        const failSafe = setTimeout(done, 15000);
        map.once('idle', done);
    });
}

/**
 * Raster of navigable water: ocean/sea polygons plus buffered ship canals (vector tile `waterway` + known corridors).
 */
function buildNavigabilityGrid() {
    const bounds = map.getBounds();
    const west = bounds.getWest();
    const south = bounds.getSouth();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    let w = east - west;
    if (w < 0) w += 360;
    const h = north - south;
    if (!(w > 0 && h > 0)) return null;

    const BI = 56;
    const BJ = 56;
    const bucketW = w / BI;
    const bucketH = h / BJ;

    const features = [];
    const extraPolys = [];

    const pushPolygonForNav = (polyFeature) => {
        if (!polyFeature?.geometry) return;
        const t = polyFeature.geometry.type;
        if (t !== 'Polygon' && t !== 'MultiPolygon') return;
        try {
            const bb = bbox(polyFeature);
            if (!bb || bb.length < 4) return;
            features.push({ f: polyFeature, bb });
            extraPolys.push(polyFeature);
        } catch {
            /* ignore */
        }
    };

    const rawWater = map.querySourceFeatures('composite', { sourceLayer: 'water' });
    for (const f of rawWater) {
        if (!f.geometry) continue;
        const t = f.geometry.type;
        if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
        try {
            const bb = bbox(f);
            if (!bb || bb.length < 4) continue;
            features.push({ f, bb });
        } catch {
            continue;
        }
    }

    const kmBufferKnown = 3.2;
    for (const line of KNOWN_SHIP_CANALS) {
        try {
            const bbLine = bbox(line);
            if (!bboxOverlapsMap(bbLine, west, south, east, north)) continue;
            const poly = buffer(line, kmBufferKnown, { units: 'kilometers' });
            pushPolygonForNav(poly);
        } catch {
            /* ignore */
        }
    }

    const kmBufferTileCanal = 1.1;
    const rawWays = map.querySourceFeatures('composite', {
        sourceLayer: 'waterway',
        filter: ['==', ['get', 'class'], 'canal']
    });
    for (const wf of rawWays) {
        if (!wf.geometry) continue;
        const gt = wf.geometry.type;
        if (gt !== 'LineString' && gt !== 'MultiLineString') continue;
        try {
            const poly = buffer(wf, kmBufferTileCanal, { units: 'kilometers' });
            pushPolygonForNav(poly);
        } catch {
            /* ignore */
        }
    }

    if (features.length === 0) return null;

    const buckets = Array.from({ length: BI * BJ }, () => []);
    for (const item of features) {
        const [minX, minY, maxX, maxY] = item.bb;
        let i0 = Math.floor((minX - west) / bucketW);
        let i1 = Math.floor((maxX - west) / bucketW);
        let j0 = Math.floor((minY - south) / bucketH);
        let j1 = Math.floor((maxY - south) / bucketH);
        i0 = Math.max(0, Math.min(BI - 1, i0));
        i1 = Math.max(0, Math.min(BI - 1, i1));
        j0 = Math.max(0, Math.min(BJ - 1, j0));
        j1 = Math.max(0, Math.min(BJ - 1, j1));
        for (let ii = i0; ii <= i1; ii++) {
            for (let jj = j0; jj <= j1; jj++) {
                buckets[ii + jj * BI].push(item);
            }
        }
    }

    const maxDim = 168;
    const stepLon = Math.max(w / maxDim, 0.028);
    const stepLat = Math.max(h / maxDim, 0.028);
    const cols = Math.max(1, Math.ceil(w / stepLon));
    const rows = Math.max(1, Math.ceil(h / stepLat));

    const grid = new Uint8Array(cols * rows);
    const pt = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [0, 0] }
    };

    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const lng = west + (i + 0.5) * stepLon;
            const lat = south + (j + 0.5) * stepLat;
            pt.geometry.coordinates[0] = lng;
            pt.geometry.coordinates[1] = lat;

            const ii = Math.min(BI - 1, Math.max(0, Math.floor(((lng - west) / w) * BI)));
            const jj = Math.min(BJ - 1, Math.max(0, Math.floor(((lat - south) / h) * BJ)));
            const cand = buckets[ii + jj * BI];
            let water = false;
            for (const item of cand) {
                const [minX, minY, maxX, maxY] = item.bb;
                if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
                if (booleanPointInPolygon(pt, item.f)) {
                    water = true;
                    break;
                }
            }
            grid[i + j * cols] = water ? 1 : 0;
        }
    }

    const minCell = Math.min(stepLon, stepLat);
    const sampleSpacing = Math.min(0.012, minCell * 0.22);

    return {
        west,
        south,
        east,
        north,
        stepLon,
        stepLat,
        cols,
        rows,
        grid,
        sampleSpacing,
        /** Buffered canal polygons + same as water fills for precise click tests */
        extraPolys,
        /** Spatial index for exact water tests along geodesics (primary land/water gate). */
        waterBuckets: buckets,
        waterBucketCols: BI,
        waterBucketRows: BJ,
        waterBucketW: bucketW,
        waterBucketH: bucketH
    };
}

function gridIsWater(navGrid, lng, lat) {
    const { west, south, stepLon, stepLat, cols, rows, grid } = navGrid;
    const i = Math.floor((lng - west) / stepLon);
    const j = Math.floor((lat - south) / stepLat);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
    return grid[i + j * cols] === 1;
}

/**
 * Closest navigable water to the click. If the point is already inside a water polygon, keep it
 * (exact hit). Otherwise snap to the nearest cell marked water in the search grid.
 */
function nearestNavigableFromGrid(lng, lat, navGrid) {
    if (navGrid.waterBuckets && pointInNavigableWater(navGrid, lng, lat)) {
        return { lng, lat };
    }
    if (!navGrid.waterBuckets && gridIsWater(navGrid, lng, lat)) {
        return { lng, lat };
    }
    const { west, south, stepLon, stepLat, cols, rows, grid } = navGrid;
    let best = null;
    let bestD = Infinity;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            if (grid[i + j * cols] !== 1) continue;
            const clng = west + (i + 0.5) * stepLon;
            const clat = south + (j + 0.5) * stepLat;
            const d = dist({ lng, lat }, { lng: clng, lat: clat });
            if (d < bestD) {
                bestD = d;
                best = { lng: clng, lat: clat };
            }
        }
    }
    return best;
}

/**
 * Build the displayed path on water only. Shore connectors (pin → first sea node) are added only
 * if the geodesic stays in water; otherwise the line starts/ends at open water so it never crosses land.
 */
function mergeShoreConnectorLegs(navGrid, userStart, userEnd, seaPathCoords) {
    if (seaPathCoords.length === 0) return [];
    const eps = 1e-5;
    const out = [];
    const u0 = { lng: userStart.lng, lat: userStart.lat };
    const u1 = { lng: userEnd.lng, lat: userEnd.lat };
    const firstSea = { lng: seaPathCoords[0][0], lat: seaPathCoords[0][1] };
    const lastSea = {
        lng: seaPathCoords[seaPathCoords.length - 1][0],
        lat: seaPathCoords[seaPathCoords.length - 1][1]
    };

    if (dist(u0, firstSea) > eps) {
        if (segmentNavigableStrict(navGrid, u0.lng, u0.lat, firstSea.lng, firstSea.lat)) {
            out.push([u0.lng, u0.lat]);
        }
    }
    for (const c of seaPathCoords) {
        out.push(c);
    }
    if (dist(u1, lastSea) > eps) {
        if (segmentNavigableStrict(navGrid, lastSea.lng, lastSea.lat, u1.lng, u1.lat)) {
            out.push([u1.lng, u1.lat]);
        }
    }
    return out;
}

const HAZARD_GRID_COLS = 10;
const HAZARD_GRID_ROWS = 10;

/** Initial great-circle bearing from (lng1,lat1) toward (lng2,lat2), degrees 0–360 (0 = north). */
function edgeBearingDeg(lng1, lat1, lng2, lat2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Smallest `min_depth` from Tilequery (Mapbox Bathymetry v2); large sentinel if unknown. */
async function tilequeryMinDepth(lng, lat) {
    if (!MB_TOKEN) return { minDepthM: 1e6 };
    const url =
        `https://api.mapbox.com/v4/mapbox.mapbox-bathymetry-v2/tilequery/` +
        `${encodeURIComponent(lng)},${encodeURIComponent(lat)}.json?access_token=${encodeURIComponent(MB_TOKEN)}&limit=10`;
    try {
        const r = await fetch(url);
        if (!r.ok) return { minDepthM: 1e6 };
        const j = await r.json();
        const feats = j.features || [];
        let m = 1e9;
        for (const f of feats) {
            const v = f.properties?.min_depth;
            if (typeof v === 'number' && !Number.isNaN(v)) m = Math.min(m, v);
        }
        return { minDepthM: m >= 1e8 ? 1e6 : m };
    } catch {
        return { minDepthM: 1e6 };
    }
}

async function runPool(tasks, concurrency) {
    const results = new Array(tasks.length);
    let i = 0;
    async function worker() {
        for (;;) {
            const k = i++;
            if (k >= tasks.length) return;
            results[k] = await tasks[k]();
        }
    }
    const n = Math.min(concurrency, Math.max(1, tasks.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}

/**
 * Bilinear sample of marine + wind fields over the search area (Open-Meteo batched).
 * Optional Mapbox bathymetry Tilequery grid for shallow-water routing (same cell layout).
 * @returns {Promise<null | object>}
 */
async function buildHazardFieldForNavGrid(navGrid, opts = {}) {
    const includeBathymetrySamples = !!opts.includeBathymetrySamples;
    const { west, south, east, north } = navGrid;
    let w = east - west;
    if (w < 0) w += 360;
    const h = north - south;
    const cols = HAZARD_GRID_COLS;
    const rows = HAZARD_GRID_ROWS;
    const lats = [];
    const lngs = [];
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            lats.push(south + (j + 0.5) / rows * h);
            lngs.push(west + (i + 0.5) / cols * w);
        }
    }
    const latStr = lats.map((x) => x.toFixed(4)).join(',');
    const lngStr = lngs.map((x) => x.toFixed(4)).join(',');
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${latStr}&longitude=${lngStr}&current=wave_height,ocean_current_velocity,ocean_current_direction`;
    const windUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latStr}&longitude=${lngStr}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;
    try {
        const [mr, wr] = await Promise.all([fetch(marineUrl), fetch(windUrl)]);
        if (!mr.ok || !wr.ok) return null;
        const mData = await mr.json();
        const wData = await wr.json();
        const mList = Array.isArray(mData) ? mData : [mData];
        const wList = Array.isArray(wData) ? wData : [wData];
        const n = cols * rows;
        const wave = new Float32Array(n);
        const curSpd = new Float32Array(n);
        const curDirDeg = new Float32Array(n);
        const windMs = new Float32Array(n);
        const windFromDeg = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            const m = mList[k] || {};
            const wc = wList[k] || {};
            wave[k] = Number(m.current?.wave_height) || 0;
            let cv = Number(m.current?.ocean_current_velocity);
            if (Number.isNaN(cv)) cv = 0;
            curSpd[k] = cv;
            curDirDeg[k] = Number(m.current?.ocean_current_direction) || 0;
            windMs[k] = Number(wc.current?.wind_speed_10m) || 0;
            windFromDeg[k] = Number(wc.current?.wind_direction_10m) || 0;
        }
        const out = {
            west, south, east, north, cols, rows, wave, curSpd, curDirDeg, windMs, windFromDeg
        };
        if (includeBathymetrySamples) {
            const minDepth = new Float32Array(n);
            minDepth.fill(1e6);
            const tasks = lats.map((lat, k) => async () => {
                const r = await tilequeryMinDepth(lngs[k], lat);
                minDepth[k] = r.minDepthM;
            });
            await runPool(tasks, 24);
            out.minDepth = minDepth;
        }
        return out;
    } catch {
        return null;
    }
}

function sampleHazardAt(hf, lng, lat) {
    if (!hf) {
        return { wave: 0, curSpd: 0, curDirDeg: 0, windMs: 0, windFromDeg: 0 };
    }
    let bw = hf.east - hf.west;
    if (bw < 0) bw += 360;
    const bh = hf.north - hf.south;
    let fx = ((lng - hf.west) / bw) * hf.cols - 0.5;
    let fy = ((lat - hf.south) / bh) * hf.rows - 0.5;
    fx = Math.max(0, Math.min(hf.cols - 1.001, fx));
    fy = Math.max(0, Math.min(hf.rows - 1.001, fy));
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const i1 = Math.min(hf.cols - 1, i0 + 1);
    const j1 = Math.min(hf.rows - 1, j0 + 1);
    const tx = fx - i0;
    const ty = fy - j0;
    const idx = (ii, jj) => jj * hf.cols + ii;
    const lerp = (a, b, t) => a + (b - a) * t;
    const sampleScalar = (arr) => {
        const v00 = arr[idx(i0, j0)];
        const v10 = arr[idx(i1, j0)];
        const v01 = arr[idx(i0, j1)];
        const v11 = arr[idx(i1, j1)];
        return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
    };
    const angBlend = (arr) => {
        const u = (ii, jj) => {
            const a = arr[idx(ii, jj)] * Math.PI / 180;
            return { x: Math.sin(a), y: Math.cos(a) };
        };
        const mix = (p, q, t) => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
        const p00 = u(i0, j0);
        const p10 = u(i1, j0);
        const p01 = u(i0, j1);
        const p11 = u(i1, j1);
        const p0 = mix(p00, p10, tx);
        const p1 = mix(p01, p11, tx);
        const p = mix(p0, p1, ty);
        return (Math.atan2(p.x, p.y) * 180 / Math.PI + 360) % 360;
    };
    return {
        wave: sampleScalar(hf.wave),
        curSpd: sampleScalar(hf.curSpd),
        curDirDeg: angBlend(hf.curDirDeg),
        windMs: sampleScalar(hf.windMs),
        windFromDeg: angBlend(hf.windFromDeg)
    };
}

/**
 * Bilinear sample of bathymetry `min_depth` grid (meters). Returns large value if absent.
 */
function sampleMinDepthAt(hf, lng, lat) {
    if (!hf?.minDepth) return 1e6;
    let bw = hf.east - hf.west;
    if (bw < 0) bw += 360;
    const bh = hf.north - hf.south;
    let fx = ((lng - hf.west) / bw) * hf.cols - 0.5;
    let fy = ((lat - hf.south) / bh) * hf.rows - 0.5;
    fx = Math.max(0, Math.min(hf.cols - 1.001, fx));
    fy = Math.max(0, Math.min(hf.rows - 1.001, fy));
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const i1 = Math.min(hf.cols - 1, i0 + 1);
    const j1 = Math.min(hf.rows - 1, j0 + 1);
    const tx = fx - i0;
    const ty = fy - j0;
    const idx = (ii, jj) => jj * hf.cols + ii;
    const arr = hf.minDepth;
    const lerp = (a, b, t) => a + (b - a) * t;
    const v00 = arr[idx(i0, j0)];
    const v10 = arr[idx(i1, j0)];
    const v01 = arr[idx(i0, j1)];
    const v11 = arr[idx(i1, j1)];
    return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
}

/**
 * Mapbox docs: inside a depth polygon, true depth is less than `min_depth` (meters).
 * Smaller `min_depth` ⇒ shallower ceiling ⇒ higher routing penalty when enabled.
 */
function shallowWaterCostTerm(minDepthM) {
    if (minDepthM >= 1e5 || minDepthM > 600) return 0;
    const cap = 320;
    const t = Math.max(0, (cap - minDepthM) / cap);
    const shelf = minDepthM < 90 ? 0.45 : 0;
    return 0.55 * t * t + shelf;
}

/**
 * Per-edge cost multipliers for A*. Intentionally different objectives:
 * - `distance` (fastest): ignore marine data — uniform cost → shortest geographic path.
 * - `safety` (safest): cost dominated by sea state (waves emphasized); distance is not the goal.
 * - `time` (balanced): blend of baseline distance-like cost and sea state.
 * When the hazard field is null or nearly uniform, fastest vs balanced can coincide (same topology).
 */
function edgeSafetyMultiplier(hazardField, lng1, lat1, lng2, lat2, mode = 'safety') {
    if (mode === 'distance') {
        return 1;
    }
    if (!hazardField) {
        return 1;
    }

    const mlng = (lng1 + lng2) / 2;
    const mlat = (lat1 + lat2) / 2;
    const s = sampleHazardAt(hazardField, mlng, mlat);
    const H = edgeBearingDeg(lng1, lat1, lng2, lat2);
    const rad = (x) => (x * Math.PI) / 180;
    const curAlign = Math.cos(rad(H - s.curDirDeg));
    const crossCur = Math.abs(Math.sin(rad(H - s.curDirDeg)));
    const curTerm =
        0.02 * s.curSpd * (0.35 + 0.65 * crossCur) + 0.014 * s.curSpd * Math.max(0, -curAlign);
    const windTo = (s.windFromDeg + 180) % 360;
    const headWind = Math.max(0, -Math.cos(rad(H - windTo)));
    const crossWind = Math.abs(Math.sin(rad(H - s.windFromDeg)));
    const windTerm = 0.085 * s.windMs * (headWind * 1.15 + crossWind * 0.45);
    const waveTerm = 0.22 * s.wave * s.wave + 0.08 * s.wave;
    const debrisProxy = 0.12 * Math.min(1, s.wave / 3.5) * Math.min(1, s.windMs / 14);

    const md = sampleMinDepthAt(hazardField, mlng, mlat);
    const depthTerm = hazardField.minDepth ? shallowWaterCostTerm(md) : 0;

    const marineExposure = waveTerm + curTerm + windTerm + debrisProxy;

    if (mode === 'safety') {
        const waveForward = 0.28 * s.wave * s.wave + 0.12 * s.wave;
        const seaOnly =
            waveForward * 2.25 + curTerm * 1.05 + windTerm * 0.85 + debrisProxy * 1.1 + depthTerm * 1.15;
        return Math.min(8.5, Math.max(0.34, 0.28 + seaOnly * 2.65));
    }

    const blended = 1.0 + marineExposure * 0.92 + depthTerm * 0.62;
    return Math.min(6.8, Math.max(0.88, blended));
}

/**
 * Fast geodesic check for A*: samples the same great circle the globe draws, but uses the
 * water bitmask only (no polygon tests) — millions of calls during search.
 */
function segmentNavigableFast(navGrid, lng1, lat1, lng2, lat2) {
    const km = haversineKm(lng1, lat1, lng2, lat2);
    if (km < 1e-4) return gridIsWater(navGrid, lng1, lat1);
    const midLat = (lat1 + lat2) / 2;
    const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const kmPerDegLon = 111.32 * cosLat;
    const minCellKm = Math.min(navGrid.stepLon * kmPerDegLon, navGrid.stepLat * 110.574);
    const spacingKm = Math.min(2.8, Math.max(0.45, minCellKm * 0.42));
    const steps = Math.min(52, Math.max(12, Math.ceil(km / spacingKm)));
    const { west, south, stepLon, stepLat, cols, rows, grid } = navGrid;
    let lastKey = '';
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const [lng, lat] = interpolateGeodesic(lng1, lat1, lng2, lat2, t);
        const i = Math.floor((lng - west) / stepLon);
        const j = Math.floor((lat - south) / stepLat);
        const key = `${i},${j}`;
        if (key === lastKey) continue;
        lastKey = key;
        if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
        if (grid[i + j * cols] !== 1) return false;
    }
    return true;
}

/**
 * Strict geodesic check: polygon hit-test (runs only on final route geometry, not inside A*).
 */
function segmentNavigableStrict(navGrid, lng1, lat1, lng2, lat2) {
    const km = haversineKm(lng1, lat1, lng2, lat2);
    if (km < 1e-4) return pointInNavigableWater(navGrid, lng1, lat1);
    const midLat = (lat1 + lat2) / 2;
    const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const kmPerDegLon = 111.32 * cosLat;
    const kmPerDegLat = 110.574;
    const minCellKm = Math.min(navGrid.stepLon * kmPerDegLon, navGrid.stepLat * kmPerDegLat);
    const spacingKm = Math.min(2.2, Math.max(0.32, Math.min(minCellKm * 0.36, navGrid.sampleSpacing * kmPerDegLon)));
    const steps = Math.min(72, Math.max(20, Math.ceil(km / spacingKm)));
    let lastKey = '';
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const [lng, lat] = interpolateGeodesic(lng1, lat1, lng2, lat2, t);
        const i = Math.floor((lng - navGrid.west) / navGrid.stepLon);
        const j = Math.floor((lat - navGrid.south) / navGrid.stepLat);
        const key = `${i},${j}`;
        if (key === lastKey) continue;
        lastKey = key;
        if (!pointInNavigableWater(navGrid, lng, lat)) return false;
    }
    return true;
}

/**
 * Insert vertices along each geodesic leg so Mapbox’s rendered great circles cannot “shortcut”
 * over land between sparse A* nodes (~0.2° apart is usually enough; shore legs get more points).
 */
function densifyPathCoordsGeodesic(coords, maxChordKm) {
    if (!coords || coords.length < 2) return coords ? coords.slice() : [];
    const cap = Math.max(4, maxChordKm);
    const out = [];
    for (let k = 0; k < coords.length - 1; k++) {
        const a = coords[k];
        const b = coords[k + 1];
        if (k === 0) out.push([a[0], a[1]]);
        const km = haversineKm(a[0], a[1], b[0], b[1]);
        const n = Math.max(1, Math.ceil(km / cap));
        for (let s = 1; s < n; s++) {
            const t = s / n;
            out.push(interpolateGeodesic(a[0], a[1], b[0], b[1], t));
        }
        out.push([b[0], b[1]]);
    }
    const dedup = [];
    for (const p of out) {
        const prev = dedup[dedup.length - 1];
        if (!prev || haversineKm(p[0], p[1], prev[0], prev[1]) > 0.02) dedup.push(p);
    }
    return dedup;
}

function gridCellKey(lng, lat, res) {
    const i = Math.round(lng / res);
    const j = Math.round(lat / res);
    return `${i},${j}`;
}

function heapSiftUp(h, i) {
    const x = h[i];
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p].f <= x.f) break;
        h[i] = h[p];
        i = p;
    }
    h[i] = x;
}

function heapSiftDown(h, i) {
    const n = h.length;
    const x = h[i];
    while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && h[c + 1].f < h[c].f) c++;
        if (x.f <= h[c].f) break;
        h[i] = h[c];
        i = c;
    }
    h[i] = x;
}

function heapPush(h, item) {
    h.push(item);
    heapSiftUp(h, h.length - 1);
}

function heapPop(h) {
    if (h.length === 0) return null;
    const out = h[0];
    const last = h.pop();
    if (h.length > 0) {
        h[0] = last;
        heapSiftDown(h, 0);
    }
    return out;
}

/**
 * Fit map so the whole plausible detour area is loaded; queryRenderedFeatures only sees rendered tiles.
 */
function clampLat(lat) {
    return Math.max(-90, Math.min(90, lat));
}

async function ensureRouteSearchViewport(points) {
    const b = new mapboxgl.LngLatBounds();
    /** Degrees around each stop so the bbox includes nearby coast (grid is built from map bounds). */
    const coastPad = 10;
    for (const p of points) {
        b.extend([p.lng, p.lat]);
        b.extend([p.lng - coastPad, clampLat(p.lat - coastPad)]);
        b.extend([p.lng + coastPad, clampLat(p.lat + coastPad)]);
    }
    const west = b.getWest();
    const east = b.getEast();
    const south = b.getSouth();
    const north = b.getNorth();
    let dx = east - west;
    if (dx < 0) dx += 360;
    const dy = north - south;
    const span = Math.max(dx, dy, 0.75);
    const pad = Math.max(span * 1.15 + 2, 5);
    let swLat = clampLat(south - pad);
    let neLat = clampLat(north + pad);
    if (swLat >= neLat) {
        swLat = clampLat(south - Math.min(pad, 0.5));
        neLat = clampLat(north + Math.min(pad, 0.5));
    }
    if (swLat >= neLat) {
        const mid = clampLat((south + north) / 2);
        swLat = clampLat(mid - 0.05);
        neLat = clampLat(mid + 0.05);
    }
    map.fitBounds(
        [[west - pad, swLat], [east + pad, neLat]],
        { duration: 0, padding: 48 }
    );
    await waitMapIdle();
}

function reconstructWaterPath(cameFrom, lastLng, lastLat, startPt, endPt, res) {
    const startKey = gridCellKey(startPt.lng, startPt.lat, res);
    const coords = [];
    let lng = lastLng;
    let lat = lastLat;
    for (;;) {
        coords.push([lng, lat]);
        const k = gridCellKey(lng, lat, res);
        if (k === startKey) break;
        const p = cameFrom.get(k);
        if (!p) return [];
        lng = p.lng;
        lat = p.lat;
    }
    coords.reverse();
    if (coords.length > 0) coords[0] = [startPt.lng, startPt.lat];
    coords.push([endPt.lng, endPt.lat]);
    return coords;
}

/**
 * A* on a lat/lng grid between two navigable sea points.
 * @param {(typeof segmentNavigableFast) | (typeof segmentNavigableStrict)} [opts.segmentCheck]
 */
function findSeaPathBetween(startSea, endSea, navGrid, hazardField, mode = 'safety', opts = {}) {
    const gridResolution = opts.gridResolution ?? 0.26;
    const closeEnough = opts.closeEnough ?? 0.62;
    const maxIterations = opts.maxIterations ?? 45000;
    const segmentCheck = opts.segmentCheck ?? segmentNavigableFast;

    const endPt = { lng: endSea.lng, lat: endSea.lat };
    const startPt = { lng: startSea.lng, lat: startSea.lat };

    const res = gridResolution;
    const cardCost = res;
    const diagCost = res * Math.SQRT2;
    const neighbors = [
        [0, res], [0, -res], [res, 0], [-res, 0],
        [res, res], [res, -res], [-res, res], [-res, -res]
    ];

    const open = [];
    const gScore = new Map();
    const cameFrom = new Map();
    const closed = new Set();

    const sk = gridCellKey(startPt.lng, startPt.lat, res);
    gScore.set(sk, 0);
    const hScale = hazardField
        ? mode === 'distance'
            ? 1
            : mode === 'time'
              ? 1.1
              : 1.22
        : 1;
    heapPush(open, { f: dist(startPt, endPt) * hScale, lng: startPt.lng, lat: startPt.lat, g: 0 });

    let iterations = 0;

    while (open.length > 0 && iterations < maxIterations) {
        iterations++;
        const current = heapPop(open);
        if (!current) break;

        const ck = gridCellKey(current.lng, current.lat, res);
        const bestG = gScore.get(ck);
        if (bestG === undefined || current.g > bestG + 1e-8) continue;
        if (closed.has(ck)) continue;
        closed.add(ck);

        if (dist(current, endPt) < closeEnough) {
            if (segmentCheck(navGrid, current.lng, current.lat, endPt.lng, endPt.lat)) {
                return reconstructWaterPath(cameFrom, current.lng, current.lat, startPt, endPt, res);
            }
        }

        for (const [dLng, dLat] of neighbors) {
            const baseStep = dLng !== 0 && dLat !== 0 ? diagCost : cardCost;
            const nextLng = current.lng + dLng;
            const nextLat = current.lat + dLat;

            if (!segmentCheck(navGrid, current.lng, current.lat, nextLng, nextLat)) continue;

            const nk = gridCellKey(nextLng, nextLat, res);
            if (closed.has(nk)) continue;

            const mult = edgeSafetyMultiplier(hazardField, current.lng, current.lat, nextLng, nextLat, mode);
            const tentativeG = current.g + baseStep * mult;
            if (tentativeG >= (gScore.get(nk) ?? Infinity)) continue;

            cameFrom.set(nk, { lng: current.lng, lat: current.lat });
            gScore.set(nk, tentativeG);
            const h = dist({ lng: nextLng, lat: nextLat }, endPt) * hScale;
            heapPush(open, { f: tentativeG + h, lng: nextLng, lat: nextLat, g: tentativeG });
        }
    }
    return [];
}

/** Coarse → fine search; final entries use strict edge checks so the path survives polygon validation. */
const SEA_PATH_SEARCH_ATTEMPTS = [
    { gridResolution: 0.3, closeEnough: 0.72, maxIterations: 38000, segmentCheck: segmentNavigableFast },
    { gridResolution: 0.24, closeEnough: 0.58, maxIterations: 52000, segmentCheck: segmentNavigableFast },
    { gridResolution: 0.19, closeEnough: 0.46, maxIterations: 68000, segmentCheck: segmentNavigableFast },
    { gridResolution: 0.15, closeEnough: 0.38, maxIterations: 85000, segmentCheck: segmentNavigableFast },
    { gridResolution: 0.12, closeEnough: 0.32, maxIterations: 110000, segmentCheck: segmentNavigableStrict }
];

/**
 * Land → water (snap if needed) → A* on sea → water → land. Every displayed leg, including shore
 * connectors, must lie entirely in navigable water when sampled on the geodesic (no land crossings).
 */
function pathEntirelyOverWater(navGrid, pathLngLat) {
    if (!pathLngLat || pathLngLat.length < 2) return true;
    for (let i = 0; i < pathLngLat.length - 1; i++) {
        const a = pathLngLat[i];
        const b = pathLngLat[i + 1];
        if (!segmentNavigableStrict(navGrid, a[0], a[1], b[0], b[1])) return false;
    }
    return true;
}

function findOceanicPath(start, end, navGrid, hazardField, mode = 'safety') {
    const startSea = nearestNavigableFromGrid(start.lng, start.lat, navGrid);
    if (!startSea) {
        return { path: [], err: 'snap_start' };
    }
    const endSea = nearestNavigableFromGrid(end.lng, end.lat, navGrid);
    if (!endSea) {
        return { path: [], err: 'snap_end' };
    }
    for (const att of SEA_PATH_SEARCH_ATTEMPTS) {
        const seaCoords = findSeaPathBetween(startSea, endSea, navGrid, hazardField, mode, att);
        if (seaCoords.length < 2) continue;
        const merged = mergeShoreConnectorLegs(navGrid, start, end, seaCoords);
        if (merged.length < 2) continue;
        if (pathEntirelyOverWater(navGrid, merged)) {
            return { path: merged, err: null };
        }
    }
    return { path: [], err: 'no_route' };
}

function dist(p1, p2) {
    return Math.sqrt(Math.pow(p2.lng - p1.lng, 2) + Math.pow(p2.lat - p1.lat, 2));
}

function coordsNearlyEqual(a, b) {
    return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}

/** Chain findOceanicPath for each leg; dedupe shared vertices between segments. */
function computeChainedRoute(points, navGrid, hazardField, mode = 'safety') {
    let full = [];
    for (let i = 0; i < points.length - 1; i++) {
        const r = findOceanicPath(points[i], points[i + 1], navGrid, hazardField, mode);
        if (r.err) {
            return { path: [], err: r.err, legIndex: i };
        }
        const seg = r.path;
        if (i === 0) {
            full = seg.slice();
        } else if (seg.length > 0 && full.length > 0 && coordsNearlyEqual(full[full.length - 1], seg[0])) {
            full.push(...seg.slice(1));
        } else {
            full.push(...seg);
        }
    }
    return { path: full, err: null, legIndex: -1 };
}

function safetyTier(maxWave, maxWindMs, maxCur) {
    const score = maxWave * 1.4 + maxWindMs * 0.35 + maxCur * 0.08;
    if (score < 1.2) return { label: 'LOW', color: '#0369a1' };
    if (score < 2.4) return { label: 'MODERATE', color: '#ca8a04' };
    if (score < 4) return { label: 'ELEVATED', color: '#ea580c' };
    return { label: 'HIGH', color: '#dc2626' };
}

/** Same weighting as the dashboard tier, for hourly buckets (no directional terms). */
function seaStateScore(wave, windMs, cur) {
    const w = Number(wave) || 0;
    const wi = Number(windMs) || 0;
    const c = Number(cur) || 0;
    return w * 1.4 + wi * 0.35 + c * 0.08;
}

function formatUtcHourLabel(isoTime) {
    if (!isoTime || typeof isoTime !== 'string') return '—';
    const d = new Date(isoTime);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
        timeZoneName: 'short'
    });
}

/**
 * Best single hour + longest calmer window from Open-Meteo hourly marine + wind at one point.
 * @returns {Promise<{ recommended: string, window: string, detail: string } | null>}
 */
async function fetchDepartureOutlook(lat, lng) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
    const marineUrl =
        `https://marine-api.open-meteo.com/v1/marine?latitude=${la.toFixed(4)}&longitude=${ln.toFixed(4)}` +
        '&hourly=wave_height,ocean_current_velocity&forecast_days=3';
    const windUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${la.toFixed(4)}&longitude=${ln.toFixed(4)}` +
        '&hourly=wind_speed_10m&wind_speed_unit=ms&forecast_days=3';
    try {
        const [mr, wr] = await Promise.all([fetch(marineUrl), fetch(windUrl)]);
        if (!mr.ok || !wr.ok) return null;
        const mj = await mr.json();
        const wj = await wr.json();
        const times = mj.hourly?.time || [];
        const waves = mj.hourly?.wave_height || [];
        const curs = mj.hourly?.ocean_current_velocity || [];
        const winds = wj.hourly?.wind_speed_10m || [];
        const n = Math.min(times.length, waves.length, curs.length, winds.length);
        if (n < 6) return null;

        const moderate = 2.15;
        const scores = [];
        for (let i = 0; i < n; i++) {
            scores.push(seaStateScore(waves[i], winds[i], curs[i]));
        }

        let bestI = 0;
        for (let i = 1; i < n; i++) {
            if (scores[i] < scores[bestI]) bestI = i;
        }

        let runStart = 0;
        let runLen = 0;
        let bestStart = 0;
        let bestLen = 0;
        for (let i = 0; i <= n; i++) {
            const ok = i < n && scores[i] < moderate;
            if (ok) {
                if (runLen === 0) runStart = i;
                runLen++;
            } else {
                if (runLen > bestLen) {
                    bestLen = runLen;
                    bestStart = runStart;
                }
                runLen = 0;
            }
        }

        const recommended = formatUtcHourLabel(times[bestI]);
        let window;
        let detail;
        if (bestLen >= 3) {
            const t0 = times[bestStart];
            const t1 = times[bestStart + bestLen - 1];
            window = `${formatUtcHourLabel(t0)} → ${formatUtcHourLabel(t1)}`;
            detail = `${bestLen} consecutive hours under a moderate sea-state threshold (heuristic at route midpoint).`;
        } else {
            window = 'No extended calm window in the next ~3 days at this point.';
            detail =
                'Conditions rarely stay below the moderate threshold for 3+ hours; consider shorter legs, different timing, or local forecasts.';
        }

        return { recommended, window, detail };
    } catch {
        return null;
    }
}

/**
 * Sample along polyline + hazard field for dashboard (marine + wind).
 */
async function analyzeRouteData(path, hazardField) {
    if (path.length < 2) {
        return {
            maxWave: 0,
            maxWindMs: 0,
            maxCur: 0,
            avgHazardMult: 1,
            debrisNote: '—',
            samples: [],
            shallowAlongRoute: [],
            depthNote: '—'
        };
    }
    const n = path.length;
    const idxs = new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1]);
    const samplesPoints = [...idxs].filter((i) => i >= 0 && i < n).sort((a, b) => a - b).map((i) => path[i]);

    const lats = samplesPoints.map((p) => p[1].toFixed(3)).join(',');
    const lngs = samplesPoints.map((p) => p[0].toFixed(3)).join(',');
    const marineUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lats}&longitude=${lngs}&current=wave_height,ocean_current_velocity`;
    const windUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&current=wind_speed_10m&wind_speed_unit=ms`;

    let maxWave = 0;
    let maxCur = 0;
    let maxWindMs = 0;
    let samples = [];
    /** @type {{ lng: number, lat: number, minDepthM: number }[]} */
    let shallowAlongRoute = [];

    try {
        const depthTasks = samplesPoints.map((p) => () => tilequeryMinDepth(p[0], p[1]));
        const [mr, wr] = await Promise.all([fetch(marineUrl), fetch(windUrl)]);
        const depthResults = await runPool(depthTasks, 16);
        const mData = await mr.json();
        const wData = await wr.json();
        const mList = Array.isArray(mData) ? mData : [mData];
        const wList = Array.isArray(wData) ? wData : [wData];
        for (let k = 0; k < mList.length; k++) {
            const wave = Number(mList[k].current?.wave_height) || 0;
            const cur = Number(mList[k].current?.ocean_current_velocity) || 0;
            const wind = Number(wList[k]?.current?.wind_speed_10m) || 0;
            maxWave = Math.max(maxWave, wave);
            maxCur = Math.max(maxCur, cur);
            maxWindMs = Math.max(maxWindMs, wind);
            const d = depthResults[k]?.minDepthM ?? 1e6;
            samples.push({
                lng: samplesPoints[k][0],
                lat: samplesPoints[k][1],
                waveHeight: wave,
                currentVel: cur,
                windSpeed: wind,
                depthCeilingM: d < 1e5 ? d : null
            });
            if (d < 220) {
                shallowAlongRoute.push({ lng: samplesPoints[k][0], lat: samplesPoints[k][1], minDepthM: d });
            }
        }
    } catch {
        /* keep zeros */
    }

    let multSum = 0;
    let multN = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        multSum += edgeSafetyMultiplier(hazardField, a[0], a[1], b[0], b[1], 'safety');
        multN++;
    }
    const avgHazardMult = multN ? multSum / multN : 1;
    const debrisNote =
        maxWave > 3 || maxWindMs > 14
            ? 'Higher drift / debris risk in rough seas (no live debris layer — use local notices).'
            : 'No global debris feed; proxy from sea state only.';

    const depthNote =
        shallowAlongRoute.length > 0
            ? `Bathymetry v2 (Tilequery): ${shallowAlongRoute.length} sample point(s) on shallow shelf (min_depth ≤ ~220 m). Not a draft survey.`
            : 'Bathymetry: no shallow shelf hits at sampled points (or no data).';

    return { maxWave, maxWindMs, maxCur, avgHazardMult, debrisNote, samples, shallowAlongRoute, depthNote };
}

/**
 * UI & INTERACTION
 */
function makeRouteMarkerElement(index, total) {
    const el = document.createElement('div');
    const isFirst = index === 0;
    const isLast = index === total - 1;
    const bg = isFirst ? '#00ff88' : isLast ? '#ff4444' : '#ffc940';
    el.style.cssText =
        `width:26px;height:26px;border-radius:50%;background:${bg};color:#010b19;` +
        'font:bold 12px monospace;display:flex;align-items:center;justify-content:center;' +
        `border:2px solid #010b19;box-shadow:0 0 0 1px ${bg};cursor:pointer;`;
    el.textContent = String(index + 1);
    return el;
}

function refreshAllMarkers() {
    routeMarkers.forEach((m, i) => {
        const el = m.getElement();
        if (!el) return;
        const isFirst = i === 0;
        const isLast = i === routeMarkers.length - 1;
        const bg = isFirst ? '#00ff88' : isLast ? '#ff4444' : '#ffc940';
        el.style.background = bg;
        el.style.boxShadow = `0 0 0 1px ${bg}`;
        el.textContent = String(i + 1);
    });
}

function addRoutePoint(lngLat) {
    routePoints.push(lngLat);
    const el = makeRouteMarkerElement(routePoints.length - 1, routePoints.length);
    const m = new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    routeMarkers.push(m);
    refreshAllMarkers();
    btnRoute.disabled = routePoints.length < 2;
}

function undoLastPoint() {
    if (routeMarkers.length === 0) return;
    routeMarkers.pop().remove();
    routePoints.pop();
    refreshAllMarkers();
    btnRoute.disabled = routePoints.length < 2;
}

function clearRouteOverlays() {
    for (const m of routeMarkers) m.remove();
    for (const m of hazardMarkers) m.remove();
    routeMarkers = [];
    hazardMarkers = [];
    routePoints = [];
    currentResults = [];
    btnRoute.disabled = true;
    ['route-safety', 'route-time', 'route-distance'].forEach(id => {
        if (map.getLayer(id + '-line')) map.removeLayer(id + '-line');
        if (map.getSource(id)) map.removeSource(id);
    });
    dash.style.display = 'none';
    legend.style.display = 'none';
}

btnRoute.addEventListener('click', () => {
    (async () => {
        if (routePoints.length < 2) return;
        loader.style.display = 'block';
        try {
            await ensureRouteSearchViewport(routePoints);
            const navGrid = buildNavigabilityGrid();
            const shallowPenaltyOn = !!toggleShallowPenalty?.checked;
            const hazardField = navGrid
                ? await buildHazardFieldForNavGrid(navGrid, { includeBathymetrySamples: shallowPenaltyOn })
                : null;

            if (!navGrid) {
                dash.style.display = 'block';
                dash.innerHTML = `<div style="font-size: 10px; color: #888; margin-bottom: 5px;">SAFETY ROUTING</div>
                                 <span style="color:#ff8866;">Could not read water polygons. Wait and try again.</span>`;
                return;
            }

            const modes = [
                { id: 'distance', label: 'Fastest path', color: '#0369a1' },
                { id: 'safety', label: 'Safest (waves & sea state)', color: '#dc2626' },
                { id: 'time', label: 'Balanced', color: '#ca8a04' }
            ];

            const results = await Promise.all(
                modes.map(async (m) => {
                    const chain = computeChainedRoute(routePoints, navGrid, hazardField, m.id);
                    if (chain.path.length >= 2) {
                        const stats = await analyzeRouteData(chain.path, hazardField);
                        return { mode: m, path: chain.path, stats };
                    }
                    return { mode: m, path: [], err: chain.err, legIndex: chain.legIndex };
                })
            );

            const validResults = results.filter((r) => r.path.length >= 2);
            if (validResults.length === 0) {
                const r0 = results.find((r) => r.err) || results[0];
                const hint =
                    r0.err === 'snap_start'
                        ? 'No navigable water near the start in this view. Zoom or pan so the ocean is on screen.'
                        : r0.err === 'snap_end'
                          ? 'No navigable water near the end in this view. Zoom or pan so the ocean is on screen.'
                          : 'No continuous sea between these stops in the region Mapbox loaded. Zoom out so the whole crossing fits, then compute route again.';
                dash.style.display = 'block';
                dash.innerHTML = `<div style="font-size: 10px; color: #888; margin: 10px 16px;">ROUTING ERROR</div>
                                 <div style="color:#ff4444; padding: 0 16px 10px;">${hint}</div>`;
                return;
            }

            currentResults = validResults;
            drawMultipleRoutes(validResults);
            const refPath = validResults[0].path;
            const mid = refPath[Math.floor(refPath.length / 2)];
            const launchOutlook = mid ? await fetchDepartureOutlook(mid[1], mid[0]) : null;
            updateMultiDash(validResults, launchOutlook);

            if (validResults.length > 0) {
                selectRoute(validResults[0].mode.id);
            }
        } catch (err) {
            console.error(err);
        } finally {
            loader.style.display = 'none';
        }
    })();
});

function drawMultipleRoutes(validResults) {
    validResults.forEach(res => {
        const sourceId = `route-${res.mode.id}`;
        const layerId = `${sourceId}-line`;
        const dense = densifyPathCoordsGeodesic(res.path, 32);
        const geojson = { 'type': 'Feature', 'geometry': { 'type': 'LineString', 'coordinates': dense } };

        if (map.getSource(sourceId)) {
            map.getSource(sourceId).setData(geojson);
        } else {
            map.addSource(sourceId, { 'type': 'geojson', 'data': geojson });
            map.addLayer({
                'id': layerId, 'type': 'line', 'source': sourceId,
                'layout': { 'line-join': 'round', 'line-cap': 'round' },
                'paint': {
                    'line-color': res.mode.color,
                    'line-width': 4,
                    'line-opacity': 0.4,
                    'line-dasharray': res.mode.id === 'distance' ? [2, 1] : [1, 0]
                }
            });
        }
    });
}

function selectRoute(modeId) {
    const selectedRes = currentResults.find(r => r.mode.id === modeId);
    if (!selectedRes) return;

    // Update UI selection
    document.querySelectorAll('.route-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.mode === modeId);
    });

    // Update Map Layers
    currentResults.forEach(res => {
        const layerId = `route-${res.mode.id}-line`;
        const isSelected = res.mode.id === modeId;
        if (map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'line-width', isSelected ? 7 : 4);
            map.setPaintProperty(layerId, 'line-opacity', isSelected ? 1.0 : 0.3);
            if (isSelected) {
                map.moveLayer(layerId); // Bring selected to front
            }
        }
    });

    // Update Hazard Markers
    hazardMarkers.forEach(m => m.remove());
    hazardMarkers = [];

    if (selectedRes.stats.shallowAlongRoute?.length) {
        for (const sh of selectedRes.stats.shallowAlongRoute) {
            const el = document.createElement('div');
            el.style.cssText =
                `width:18px;height:18px;background:#fff7ed;border:2px solid #ea580c;border-radius:50%;` +
                'display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:9px;font-weight:700;' +
                'color:#9a3412;box-shadow:0 1px 3px rgba(0,0,0,0.2);';
            el.textContent = 'S';
            const popup = new mapboxgl.Popup({
                closeButton: false,
                closeOnClick: false,
                offset: 12
            }).setHTML(
                `<div style="font-family:'Google Sans',sans-serif;font-size:12px;padding:4px 8px;">` +
                `<b>Shallow water</b><br/>Bathymetry min_depth ≤ ~220 m (Tilequery). Not for draft planning.</div>`
            );
            el.addEventListener('mouseenter', () => {
                popup.setLngLat([sh.lng, sh.lat]).addTo(map);
            });
            el.addEventListener('mouseleave', () => {
                popup.remove();
            });
            hazardMarkers.push(new mapboxgl.Marker({ element: el }).setLngLat([sh.lng, sh.lat]).addTo(map));
        }
    }

    if (selectedRes.stats.samples) {
        selectedRes.stats.samples.forEach(s => {
            const el = document.createElement('div');
            el.className = 'hazard-marker';
            el.style.cssText = `width:18px;height:18px;background:white;border:2px solid ${selectedRes.mode.color};border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px;box-shadow: 0 1px 3px rgba(0,0,0,0.2);`;
            
            let label = 'H';
            let detail = 'General Hazard';
            let innerHTML = `<div style="width:10px;height:10px;background:${selectedRes.mode.color};border-radius:2px;"></div>`;
            if (s.waveHeight > 2.5) {
                label = 'W';
                detail = `High Waves: ${s.waveHeight.toFixed(1)}m`;
                innerHTML = `<div style="font-weight:bold;color:${selectedRes.mode.color};">W</div>`;
            } else if (s.windSpeed > 10) {
                label = 'F';
                detail = `Strong Wind: ${s.windSpeed.toFixed(1)} m/s`;
                innerHTML = `<div style="font-weight:bold;color:${selectedRes.mode.color};">F</div>`;
            } else if (s.currentVel > 0.5) {
                label = 'C';
                detail = `Strong Current: ${s.currentVel.toFixed(1)} m/s`;
                innerHTML = `<div style="font-weight:bold;color:${selectedRes.mode.color};">C</div>`;
            }
            
            el.innerHTML = innerHTML;
            
            const popup = new mapboxgl.Popup({
                closeButton: false,
                closeOnClick: false,
                offset: 12
            }).setHTML(`<div style="font-family:'Google Sans',sans-serif;font-size:12px;padding:4px 8px;"><b>${detail}</b></div>`);

            el.addEventListener('mouseenter', () => {
                popup.setLngLat([s.lng, s.lat]).addTo(map);
            });
            el.addEventListener('mouseleave', () => {
                popup.remove();
            });

            const marker = new mapboxgl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
            hazardMarkers.push(marker);
        });
    }

    // Fit map to selected route
    if (selectedRes.path.length >= 2) {
        const coordinates = selectedRes.path;
        const bounds = coordinates.reduce((acc, coord) => {
            return acc.extend(coord);
        }, new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));
        map.fitBounds(bounds, { padding: 80, duration: 1000 });
    }
}

function updateMultiDash(validResults, launchOutlook = null) {
    dash.style.display = 'block';
    legend.style.display = 'block';
    let html = '';

    if (launchOutlook) {
        html += `<div style="font-size: 11px; color: #70757a; margin: 10px 16px 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Departure &amp; launch window</div>
            <div style="padding: 0 16px 10px; font-size: 12px; color: #3c4043; line-height: 1.45; border-bottom: 1px solid #f1f3f4;">
                <div style="margin-bottom: 6px;"><span style="color:#70757a;">Recommended departure (calmest hour):</span><br/>
                <b style="color:#0f766e;">${launchOutlook.recommended}</b></div>
                <div style="margin-bottom: 6px;"><span style="color:#70757a;">Safer launch window:</span><br/>
                <b>${launchOutlook.window}</b></div>
                <div style="font-size: 11px; color: #70757a;">${launchOutlook.detail}</div>
            </div>`;
    } else if (validResults.length) {
        html += `<div style="font-size: 11px; color: #70757a; margin: 10px 16px 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Departure &amp; launch window</div>
            <div style="padding: 0 16px 10px; font-size: 12px; color: #70757a; border-bottom: 1px solid #f1f3f4;">Hourly outlook unavailable (network or API).</div>`;
    }

    const depthNote0 = validResults[0]?.stats?.depthNote;
    if (depthNote0) {
        html += `<div style="font-size: 11px; color: #70757a; margin: 10px 16px 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Depth awareness</div>
            <div style="padding: 0 16px 10px; font-size: 11px; color: #4d5156; line-height: 1.45; border-bottom: 1px solid #f1f3f4;">${depthNote0}</div>`;
    }

    html += `<div style="font-size: 11px; color: #70757a; margin: 10px 16px 4px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Recommended Routes</div>`;
    validResults.forEach(r => {
        const roughNm = r.path.length * 25;
        const tier = safetyTier(r.stats.maxWave, r.stats.maxWindMs, r.stats.maxCur);
        html += `
            <div class="route-item" data-mode="${r.mode.id}" onclick="window.selectRoute('${r.mode.id}')">
                <div style="display: flex; align-items: baseline; gap: 8px;">
                    <b style="color:${r.mode.color}; font-size: 15px;">${r.mode.label}</b>
                    <span style="color: #70757a; font-size: 13px;">~${roughNm.toFixed(0)} nm</span>
                </div>
                <div style="font-size:12px; margin-top: 4px; color: #4d5156;">
                    Risk: <span style="color:${tier.color}; font-weight: bold;">${tier.label}</span> • 
                    Max Wave: ${r.stats.maxWave.toFixed(1)}m
                </div>
            </div>
        `;
    });
    dash.innerHTML = html;
}

// Expose selectRoute to global scope for onclick handlers
window.selectRoute = selectRoute;

map.on('click', (e) => {
    if (e.originalEvent?.target?.closest?.('#route-toolbar')) return;
    addRoutePoint(e.lngLat);
});

btnUndo.addEventListener('click', () => undoLastPoint());
btnClear.addEventListener('click', () => clearRouteOverlays());

function drawRoute(coords, stats) {
    // Legacy function replaced by drawMultipleRoutes
    drawMultipleRoutes([{ mode: { id: 'safety', color: '#dc2626' }, path: coords, stats }]);
}

function updateDash(stats, path) {
    // Legacy function replaced by updateMultiDash
    updateMultiDash([{ mode: { id: 'safety', label: 'Safety-First', color: '#dc2626' }, path: path, stats }]);
}
