/**
 * Environmental A* Pathfinding Algorithm
 * Adapted from the paper "Personalized and Safe Route Planning for Asthma Patients Using Real-Time Environmental Data"
 * 
 * This algorithm extends the traditional A* pathfinding algorithm by incorporating environmental factors
 * such as air quality, weather conditions, elevation changes, and noise levels into the cost function.
 */

import * as Environmental from '../services/environmental.js';
import * as AirQuality from '../services/airQuality.js';
import * as Weather from '../services/weather.js';
import * as Elevation from '../services/elevation.js';
import { fetchPoisForBounds } from '../services/poisAlongRoute.js';

const POI_CATEGORY_TAGS = {
    hospital: ['node["amenity"="hospital"]', 'node["healthcare"="hospital"]'],
    entertainment: ['node["amenity"="cinema"]', 'node["amenity"="theatre"]', 'node["amenity"="concert_hall"]'],
    nightlife: ['node["amenity"="bar"]', 'node["amenity"="pub"]', 'node["amenity"="nightclub"]'],
    tourism: ['node["tourism"="attraction"]', 'node["tourism"="museum"]', 'node["tourism"="viewpoint"]'],
    nature: ['node["leisure"="park"]', 'node["natural"="wood"]', 'node["leisure"="garden"]']
};

// A* POI categories the backend /api/pois proxy serves with REAL OSM data
// (server-side mirror fallback), mapped to the proxy's category names. These are
// fetched through the proxy below so real parks/hospitals reach the A* cost even
// when a direct browser→Overpass call is blocked (CORS) or down. Categories not
// listed here still query Overpass directly.
const BACKEND_POI_CATEGORY = {
    nature: 'parks',
    hospital: 'hospitals',
    entertainment: 'entertainment',
    nightlife: 'nightlife',
    tourism: 'tourism'
};

// ---------------------------------------------------------------------------
// Real environmental tile seed.
// A low-res pre-fetch of REAL /api/environment data (awaited up to a bounded
// deadline before A*) streams resolved real points into this seed.
// The A* cost function reads it as its TOP-priority environmental source, so
// the SELECTED path is guided by real pollution where available. If the
// pre-fetch has not resolved for a given area, that factor is skipped rather
// than replaced with synthetic data.
// HARD RULE: every point stored here is REAL (isSynthetic:false / isDefault:false);
// synthetic points are rejected at the seam.
// ---------------------------------------------------------------------------
const realEnvSeed = {
    points: [],
    maxRadiusM: 1200,
};

// Per-route cost-source telemetry — lets us prove how much of the selected path
// consumed real env from the seed. Reset at each findOptimalRoute.
let envCostStats = { realSeedHits: 0, staticTileHits: 0, suppliedHits: 0, syntheticHits: 0 };

// ---------------------------------------------------------------------------
// Distance-tolerance slider (UI #percentageSlider, range 1..10, default 1).
// Wires the slider into the A* search so HIGHER tolerance = the algorithm is
// willing to take LONGER detours through GREENER areas:
//   - widens the search bbox so green detours off the straight line are
//     actually reachable as grid nodes (TOLERANCE_BBOX_GAIN);
//   - amplifies the green/nature reward in the cost function so the longer
//     green path out-competes the short grey one (TOLERANCE_GREEN_GAIN).
// Slider = 1 (x1.0) keeps the legacy 0.01° bbox and unscaled reward, so the
// baseline is bit-identical to before this wiring.
// ---------------------------------------------------------------------------
const TOLERANCE_BASE_PADDING_DEG = 0.01; // legacy bbox half-padding at slider=1
const TOLERANCE_BBOX_GAIN = 0.12;        // +12% bbox padding per slider step >1
const TOLERANCE_GREEN_GAIN = 0.30;       // +30% green reward per slider step >1
let distanceToleranceFactor = 1;         // 1.0 = baseline (slider x1.0)

/**
 * Set the distance-tolerance factor from the UI slider value (1..10). Values
 * <=1 or non-finite reset to the baseline (1.0) so behaviour is unchanged.
 * @param {number|string} sliderValue
 * @returns {number} the clamped tolerance factor in effect
 */
export function setDistanceTolerance(sliderValue) {
    const s = Number(sliderValue);
    distanceToleranceFactor = Number.isFinite(s) && s > 1 ? Math.min(s, 10) : 1;
    return distanceToleranceFactor;
}

export function getDistanceTolerance() {
    return distanceToleranceFactor;
}

// Search-bbox half-padding in degrees, scaled by the current tolerance.
function tolerancePaddingDeg() {
    return TOLERANCE_BASE_PADDING_DEG * (1 + (distanceToleranceFactor - 1) * TOLERANCE_BBOX_GAIN);
}

// Multiplier (>=1) applied to the green/nature reward, scaled by tolerance.
function toleranceGreenScale() {
    return 1 + (distanceToleranceFactor - 1) * TOLERANCE_GREEN_GAIN;
}

/**
 * Drop all seeded real points. Call before each route so a route never reuses
 * the previous route's real field.
 */
export function clearRealEnvTiles() {
    realEnvSeed.points = [];
}

/**
 * Seed REAL environmental points consumed by the A* selection cost.
 * @param {Array} points - [{lat, lon, data}] where data is a real env object
 *                          (isDefault:false / isSynthetic:false). Synthetic or
 *                          default points are rejected (HARD honesty rule).
 * @param {Number} [maxRadiusM] - nearest-neighbour match radius for lookup.
 */
export function seedRealEnvTiles(points, maxRadiusM) {
    if (typeof maxRadiusM === 'number' && maxRadiusM > 0) {
        realEnvSeed.maxRadiusM = maxRadiusM;
    }
    if (!Array.isArray(points)) return;
    for (const p of points) {
        if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number' || !p.data) continue;
        // HARD RULE: only real data may be seeded as real. Never let synthetic in.
        if (p.data.isDefault === true || p.data.isSynthetic === true) continue;
        const data = { ...p.data, isSynthetic: false, isDefault: false };
        realEnvSeed.points.push({ lat: p.lat, lon: p.lon, data });
    }
}

/** Number of real points currently seeded (telemetry / proof). */
export function getRealEnvSeedSize() {
    return realEnvSeed.points.length;
}

/** Snapshot of per-route cost-source telemetry (telemetry / proof). */
export function getEnvCostStats() {
    return { ...envCostStats };
}

/**
 * Nearest-neighbour lookup over the real seed. Returns the real env object
 * (isSynthetic:false) for the closest seeded point within maxRadiusM, else null
 * so the caller falls back to the next tier.
 */
function lookupSeededRealEnv(lat, lon) {
    const pts = realEnvSeed.points;
    if (pts.length === 0) return null;
    let best = null;
    let bestDist = Infinity;
    for (const p of pts) {
        const d = calculateDistance({ lat, lon }, p);
        if (d < bestDist) {
            bestDist = d;
            best = p;
        }
    }
    return best && bestDist <= realEnvSeed.maxRadiusM ? best.data : null;
}

/** Log the per-route cost-source breakdown (real-seed vs synthetic). */
function logEnvCostStats() {
    const s = envCostStats;
    const realTotal = s.realSeedHits + s.staticTileHits;
    const total = realTotal + s.suppliedHits + s.syntheticHits;
    const pct = total > 0 ? ((realTotal / total) * 100).toFixed(1) : '0.0';
    console.log(
        `[A* env-cost] real-seed hits: ${s.realSeedHits} (isSynthetic:false), ` +
        `static-tile: ${s.staticTileHits}, supplied: ${s.suppliedHits}, ` +
        `missing real env: ${s.syntheticHits} (no synthetic fallback) | ` +
        `real share of selection cost ≈ ${pct}% over ${total} node evals ` +
        `| seed size=${realEnvSeed.points.length}`
    );
}

function getRouteBbox(start, goal) {
    const pad = tolerancePaddingDeg();
    return {
        minLat: Math.min(start.lat, goal.lat) - pad,
        maxLat: Math.max(start.lat, goal.lat) + pad,
        minLon: Math.min(start.lon, goal.lon) - pad,
        maxLon: Math.max(start.lon, goal.lon) + pad
    };
}

function normalizeStreetGraphMode(transportMode) {
    if (transportMode === 'driving' || transportMode === 'car') return 'car';
    if (transportMode === 'cycling') return 'cycling';
    return 'walking';
}

async function fetchStreetGraphForBounds(bbox, transportMode = 'walking') {
    if (!window._astarStreetGraphCache) {
        window._astarStreetGraphCache = {};
    }

    const mode = normalizeStreetGraphMode(transportMode);
    const cacheKey = `${mode}:${bbox.minLat.toFixed(5)},${bbox.minLon.toFixed(5)},${bbox.maxLat.toFixed(5)},${bbox.maxLon.toFixed(5)}`;
    if (window._astarStreetGraphCache[cacheKey]) {
        return window._astarStreetGraphCache[cacheKey];
    }

    const params = new URLSearchParams({
        mode,
        min_lat: bbox.minLat,
        min_lon: bbox.minLon,
        max_lat: bbox.maxLat,
        max_lon: bbox.maxLon
    });

    const response = await fetch(`/api/street_graph?${params.toString()}`);
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `street graph lookup failed (${response.status})`);
    }

    const payload = await response.json();
    const graph = buildStreetGraph(payload);
    window._astarStreetGraphCache[cacheKey] = graph;
    return graph;
}

function buildStreetGraph(payload) {
    const nodeMap = new Map();
    const adjacency = new Map();
    const rawNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
    const rawWays = Array.isArray(payload?.ways) ? payload.ways : [];
    const graphMode = payload?.mode || 'walking';

    for (const raw of rawNodes) {
        const id = String(raw.id);
        const lat = Number(raw.lat);
        const lon = Number(raw.lon);
        if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const node = { lat, lon, _streetId: id };
        nodeMap.set(id, node);
        adjacency.set(id, []);
    }

    for (const way of rawWays) {
        const refs = Array.isArray(way.nodes) ? way.nodes.map(String) : [];
        for (let i = 0; i < refs.length - 1; i++) {
            const a = nodeMap.get(refs[i]);
            const b = nodeMap.get(refs[i + 1]);
            if (!a || !b) continue;
            const distance = calculateDistance(a, b);
            if (!Number.isFinite(distance) || distance <= 0) continue;
            adjacency.get(a._streetId).push({
                node: b,
                distance,
                wayId: way.id,
                highway: way.highway,
                name: way.name
            });

            const oneway = String(way.oneway || '').toLowerCase();
            const respectOneway = graphMode === 'car';
            if (!respectOneway || (oneway !== 'yes' && oneway !== '1' && oneway !== 'true')) {
                adjacency.get(b._streetId).push({
                    node: a,
                    distance,
                    wayId: way.id,
                    highway: way.highway,
                    name: way.name
                });
            }
        }
    }

    const nodes = [...nodeMap.values()];
    const edgeCount = [...adjacency.values()].reduce((sum, edges) => sum + edges.length, 0);
    if (nodes.length < 2 || edgeCount === 0) {
        throw new Error('street graph has no connected road edges');
    }

    return {
        nodes,
        nodeMap,
        adjacency,
        mode: graphMode,
        source: payload?.source || 'OpenStreetMap-Overpass',
        count: payload?.count || { nodes: nodes.length, edges: edgeCount }
    };
}

function nearestStreetNode(point, nodes) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const node of nodes) {
        const distance = calculateDistance(point, node);
        if (distance < nearestDistance) {
            nearest = node;
            nearestDistance = distance;
        }
    }
    return { node: nearest, distance: nearestDistance };
}

function nearestStreetNodes(point, nodes, maxCount = 8, maxSnapMeters = 1200) {
    return nodes
        .map(node => ({ node, distance: calculateDistance(point, node) }))
        .filter(candidate => Number.isFinite(candidate.distance))
        .sort((a, b) => a.distance - b.distance)
        .filter(candidate => candidate.distance <= maxSnapMeters)
        .slice(0, maxCount);
}

function computeStreetGraphComponents(adjacency) {
    const componentByNode = new Map();
    const componentSizes = new Map();
    let componentId = 0;

    for (const nodeId of adjacency.keys()) {
        if (componentByNode.has(nodeId)) continue;

        const stack = [nodeId];
        componentByNode.set(nodeId, componentId);
        let size = 0;

        while (stack.length > 0) {
            const currentId = stack.pop();
            size++;
            for (const edge of adjacency.get(currentId) || []) {
                const nextId = edge.node?._streetId;
                if (!nextId || componentByNode.has(nextId)) continue;
                componentByNode.set(nextId, componentId);
                stack.push(nextId);
            }
        }

        componentSizes.set(componentId, size);
        componentId++;
    }

    return { componentByNode, componentSizes };
}

function selectSharedComponentEndpointSnaps(start, goal, graphNodes, adjacency) {
    const { componentByNode, componentSizes } = computeStreetGraphComponents(adjacency);
    const startCandidates = nearestStreetNodes(start, graphNodes, 32, 2000);
    const goalCandidates = nearestStreetNodes(goal, graphNodes, 32, 2000);
    let best = null;

    for (const s of startCandidates) {
        const sComponent = componentByNode.get(s.node._streetId);
        if (sComponent == null) continue;
        for (const g of goalCandidates) {
            const gComponent = componentByNode.get(g.node._streetId);
            if (sComponent !== gComponent) continue;
            const size = componentSizes.get(sComponent) || 0;
            const score = s.distance + g.distance - Math.min(size, 20000) / 100;
            if (!best || score < best.score) {
                best = { componentId: sComponent, score };
            }
        }
    }

    if (!best) {
        return null;
    }

    const inComponent = candidate => componentByNode.get(candidate.node._streetId) === best.componentId;
    return {
        componentId: best.componentId,
        startSnaps: startCandidates.filter(inComponent).slice(0, 8),
        goalSnaps: goalCandidates.filter(inComponent).slice(0, 8)
    };
}

function cloneStreetAdjacency(adjacency) {
    const copy = new Map();
    for (const [id, edges] of adjacency.entries()) {
        copy.set(id, edges.slice());
    }
    return copy;
}

function connectEndpoint(adjacency, nodeMap, endpoint, id, graphNodes, maxSnapMeters = 1200, preferredSnaps = null) {
    const snaps = preferredSnaps?.length
        ? preferredSnaps
        : nearestStreetNodes(endpoint, graphNodes, 8, maxSnapMeters);
    if (snaps.length === 0) {
        throw new Error(`no real street node within ${maxSnapMeters}m of endpoint`);
    }

    const endpointNode = { lat: endpoint.lat, lon: endpoint.lon, _streetId: id };
    nodeMap.set(id, endpointNode);
    adjacency.set(id, snaps.map(snap => ({
        node: snap.node,
        distance: snap.distance,
        wayId: 'endpoint',
        highway: 'endpoint'
    })));
    for (const snap of snaps) {
        if (!adjacency.has(snap.node._streetId)) {
            adjacency.set(snap.node._streetId, []);
        }
        adjacency.get(snap.node._streetId).push({
            node: endpointNode,
            distance: snap.distance,
            wayId: 'endpoint',
            highway: 'endpoint'
        });
    }
    return endpointNode;
}

function instantiateStreetGraphWithEndpoints(streetGraph, start, goal) {
    const adjacency = cloneStreetAdjacency(streetGraph.adjacency);
    const nodeMap = new Map(streetGraph.nodeMap);
    const graphNodes = streetGraph.nodes;
    const sharedSnaps = selectSharedComponentEndpointSnaps(start, goal, graphNodes, adjacency);
    if (sharedSnaps) {
        console.log(
            `[street-graph] Anchoring endpoints to shared component ${sharedSnaps.componentId} ` +
            `(${sharedSnaps.startSnaps.length} start snap(s), ${sharedSnaps.goalSnaps.length} goal snap(s))`
        );
    }
    const startNode = connectEndpoint(
        adjacency,
        nodeMap,
        start,
        '__start__',
        graphNodes,
        1200,
        sharedSnaps?.startSnaps
    );
    const goalNode = connectEndpoint(
        adjacency,
        nodeMap,
        goal,
        '__goal__',
        graphNodes,
        1200,
        sharedSnaps?.goalSnaps
    );
    return {
        nodes: [...graphNodes, startNode, goalNode],
        nodeMap,
        adjacency,
        startNode,
        goalNode
    };
}

async function fetchPoiLocations(bbox, category) {
    if (!window._astarPoiCache) {
        window._astarPoiCache = {};
    }
    const cacheKey = `${category}:${bbox.minLat.toFixed(5)},${bbox.minLon.toFixed(5)},${bbox.maxLat.toFixed(5)},${bbox.maxLon.toFixed(5)}`;
    if (window._astarPoiCache[cacheKey]) {
        return window._astarPoiCache[cacheKey];
    }

    // Prefer the backend /api/pois proxy for the categories it serves: it returns
    // ONLY genuine OSM elements (never synthetic) and has a server-side mirror
    // fallback, so real parks/hospitals reach the A* POI cost even when a direct
    // browser→Overpass call is blocked (CORS) or down. On failure we degrade to an
    // empty list (honest no-weighting) — never synthetic.
    const backendCategory = BACKEND_POI_CATEGORY[category];
    if (backendCategory) {
        const realPois = await fetchPoisForBounds(
            backendCategory,
            { minLat: bbox.minLat, minLon: bbox.minLon, maxLat: bbox.maxLat, maxLon: bbox.maxLon },
            { timeoutMs: 12000 }
        );
        const pois = realPois
            .map(p => ({ lat: Number(p.lat), lon: Number(p.lon) }))
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
        window._astarPoiCache[cacheKey] = pois;
        return pois;
    }

    const tags = POI_CATEGORY_TAGS[category];
    if (!tags) return [];

    const bboxStr = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
    const union = tags.map(tag => `${tag}(${bboxStr});`).join('');
    const query = `[out:json][timeout:8];(${union});out center;`;

    try {
        // POI fetching must not block route calculation. If Overpass is slow or
        // unreachable we fall back to an empty list and let greenVisibility / other
        // environmental proxies drive the preference cost.
        const POI_FETCH_TIMEOUT_MS = 3500;
        const response = await Promise.race([
            fetch('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `data=${encodeURIComponent(query)}`
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('POI fetch timeout')), POI_FETCH_TIMEOUT_MS)
            )
        ]);
        if (!response.ok) {
            throw new Error(`Overpass error: ${response.status}`);
        }
        const data = await response.json();
        const pois = (data.elements || []).map(el => {
            const lat = el.lat ?? el.center?.lat;
            const lon = el.lon ?? el.center?.lon;
            if (lat == null || lon == null) return null;
            return { lat, lon };
        }).filter(Boolean);

        window._astarPoiCache[cacheKey] = pois;
        return pois;
    } catch (error) {
        console.warn(`POI fetch for ${category} failed or timed out, continuing without POIs:`, error.message);
        window._astarPoiCache[cacheKey] = [];
        return [];
    }
}

async function fetchPoiLocationsWithBudget(bbox, category, budgetMs = 30000) {
    let timedOut = false;
    const fetchPromise = fetchPoiLocations(bbox, category)
        .catch(error => {
            console.warn(`POI fetch for ${category} failed, continuing without POIs:`, error.message);
            return [];
        });

    return Promise.race([
        fetchPromise.then(pois => (timedOut ? [] : pois)),
        new Promise(resolve => {
            setTimeout(() => {
                timedOut = true;
                resolve([]);
            }, budgetMs);
        })
    ]);
}

function nearestPoiDistance(point, poiList) {
    if (!poiList || poiList.length === 0) return Infinity;
    let minDist = Infinity;
    for (const poi of poiList) {
        const d = calculateDistance(point, poi);
        if (d < minDist) minDist = d;
    }
    return minDist;
}

function buildPoiSpatialIndex(poiList, cellSizeMeters = 200) {
    if (!poiList || poiList.length === 0) return null;
    const refLat = poiList[0].lat;
    const latMetersPerDegree = 111320;
    const lonMetersPerDegree = 111320 * Math.cos(refLat * Math.PI / 180) || 1;
    const cellSizeLat = cellSizeMeters / latMetersPerDegree;
    const cellSizeLon = cellSizeMeters / lonMetersPerDegree;
    const cells = new Map();
    for (const poi of poiList) {
        const key = `${Math.floor(poi.lat / cellSizeLat)},${Math.floor(poi.lon / cellSizeLon)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(poi);
    }
    return { cells, cellSizeLat, cellSizeLon };
}

function nearestPoiDistanceWithIndex(point, spatialIndex) {
    if (!spatialIndex || !spatialIndex.cells || spatialIndex.cells.size === 0) return Infinity;
    const { cells, cellSizeLat, cellSizeLon } = spatialIndex;
    const cellLat = Math.floor(point.lat / cellSizeLat);
    const cellLon = Math.floor(point.lon / cellSizeLon);
    let minDist = Infinity;
    for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
            const key = `${cellLat + dLat},${cellLon + dLon}`;
            const pois = cells.get(key);
            if (!pois) continue;
            for (const poi of pois) {
                const d = calculateDistance(point, poi);
                if (d < minDist) minDist = d;
            }
        }
    }
    return minDist;
}

function precomputePoiDistances(grid, poiLists) {
    const poiDistances = {};
    const spatialIndices = {};
    for (const category in poiLists) {
        spatialIndices[category] = buildPoiSpatialIndex(poiLists[category], 200);
    }
    for (const node of grid) {
        const nodeId = nodeToId(node);
        const distances = {};
        for (const category in poiLists) {
            distances[category] = nearestPoiDistanceWithIndex(node, spatialIndices[category]);
        }
        poiDistances[nodeId] = distances;
    }
    return poiDistances;
}

function isRealEnvironmentData(data) {
    return data && data.isDefault !== true && data.isSynthetic !== true;
}

function applyPreferencePoiAdjustment(cost, weight, nearestDistanceMeters, category) {
    if (weight && typeof weight === 'number' && Number.isFinite(nearestDistanceMeters)) {
        const targetRadiusM = category === 'nature' || category === 'tourism' ? 900 : 650;
        const normalizedDistance = Math.min(1, Math.max(0, nearestDistanceMeters / targetRadiusM));
        const toleranceScale = category === 'nature' || category === 'tourism'
            ? toleranceGreenScale()
            : 1;
        if (weight > 0) {
            // Positive preference: being far from the preferred POI is worse.
            cost += weight * 8.0 * normalizedDistance * toleranceScale;
        } else {
            // Negative preference: being close to the unwanted POI is worse.
            cost += Math.abs(weight) * 8.0 * (1 - normalizedDistance) * toleranceScale;
        }
    }
    return cost;
}

/**
 * Main Environmental A* pathfinding function
 * @param {Object} start - Starting point {lat, lon}
 * @param {Object} goal - Goal point {lat, lon}
 * @param {Object} map - Leaflet map object
 * @param {Object} patientCondition - Patient condition profile
 * @param {Array} environmentalData - Pre-loaded environmental data, if available
 * @param {Number} gridResolution - Resolution of the search grid (in meters)
 * @returns {Object} Best route found
 */
export async function findOptimalRoute(start, goal, map, patientCondition, environmentalData = null, gridResolution = 100, preferences = null, poiLists = null) {
    console.log("Starting Environmental A* pathfinding algorithm");
    console.log(`Start: (${start.lat}, ${start.lon}), Goal: (${goal.lat}, ${goal.lon})`);
    console.log(`Patient condition: ${patientCondition.name}`);

    // Create a search grid around the route
    const grid = createSearchGrid(start, goal, gridResolution);
    console.log(`Created search grid with ${grid.length} nodes`);

    // Reset per-route cost-source telemetry (real-seed vs synthetic accounting).
    envCostStats = { realSeedHits: 0, staticTileHits: 0, suppliedHits: 0, syntheticHits: 0 };

    // Precompute nearest-POI distances for all grid nodes once
    const poiDistances = poiLists ? precomputePoiDistances(grid, poiLists) : null;
    
    // Initialize open and closed sets
    const openSet = new PriorityQueue();
    const closedSet = new Set();
    
    // Initialize distance and environmental scores
    const gScore = {}; // Cost from start to current node
    const fScore = {}; // Estimated total cost (g + heuristic)
    const cameFrom = {}; // Path reconstruction
    
    // Add start node to open set
    const startNodeId = nodeToId(start);
    gScore[startNodeId] = 0;
    fScore[startNodeId] = estimateHeuristic(start, goal, patientCondition);
    openSet.enqueue(start, fScore[startNodeId]);
    
    // Track the best environmental factors found
    let bestEnvironmentalScore = Infinity;
    let bestRoute = null;
    
    // Main A* loop
    while (!openSet.isEmpty()) {
        // Get node with lowest f-score
        const current = openSet.dequeue();
        const currentId = nodeToId(current);
        
        // Check if we've reached the goal
        if (isGoalReached(current, goal)) {
            // Force the EXACT A/B endpoints: the goal-reaching node is only within
            // 50 m of B, so snap/append B (and guarantee A) before returning.
            const route = forceExactEndpoints(reconstructPath(cameFrom, current), start, goal);
            console.log(`Goal reached! Path found with ${route.length} nodes`);
            logEnvCostStats();
            return {
                route: route,
                environmentalScore: gScore[currentId]
            };
        }
        
        // Add to closed set
        closedSet.add(currentId);
        
        // Get neighbors
        const neighbors = getNeighbors(current, grid, gridResolution);
        
        // Process each neighbor
        for (const neighbor of neighbors) {
            const neighborId = nodeToId(neighbor);
            
            // Skip if already evaluated
            if (closedSet.has(neighborId)) continue;
            
            // Calculate tentative g-score (distance + environmental factors)
            const tentativeGScore = await calculateCost(current, neighbor, gScore[currentId], patientCondition, environmentalData, preferences, poiLists, poiDistances);
            
            // Check if this path is better than any previous one
            const neighborInOpenSet = openSet.contains(neighborId);
            if (!neighborInOpenSet || tentativeGScore < gScore[neighborId]) {
                // This is a better path, record it
                cameFrom[neighborId] = current;
                gScore[neighborId] = tentativeGScore;
                fScore[neighborId] = tentativeGScore + estimateHeuristic(neighbor, goal, patientCondition);
                
                if (!neighborInOpenSet) {
                    openSet.enqueue(neighbor, fScore[neighborId]);
                } else {
                    openSet.updatePriority(neighborId, fScore[neighborId]);
                }
                
                // Check if this is the best environmental score so far
                if (tentativeGScore < bestEnvironmentalScore && 
                    calculateDistance(neighbor, goal) < calculateDistance(start, goal) * 0.2) {
                    bestEnvironmentalScore = tentativeGScore;
                    bestRoute = reconstructPath(cameFrom, neighbor);
                }
            }
        }
    }
    
    // If we get here, no path was found - return the best partial route
    console.log("No complete path found, returning best partial route");
    logEnvCostStats();
    return {
        route: forceExactEndpoints(bestRoute || [start, goal], start, goal),
        environmentalScore: bestEnvironmentalScore
    };
}

export async function findOptimalRouteOnStreetGraph(start, goal, streetGraph, patientCondition, environmentalData = null, preferences = null, poiLists = null) {
    console.log("Starting Environmental A* on real OSM street graph");
    console.log(`Start: (${start.lat}, ${start.lon}), Goal: (${goal.lat}, ${goal.lon})`);
    console.log(`Street graph: ${streetGraph.nodes.length} OSM nodes`);

    const graph = instantiateStreetGraphWithEndpoints(streetGraph, start, goal);
    envCostStats = { realSeedHits: 0, staticTileHits: 0, suppliedHits: 0, syntheticHits: 0 };

    const poiDistances = poiLists ? precomputePoiDistances(graph.nodes, poiLists) : null;
    const openSet = new PriorityQueue();
    const closedSet = new Set();
    const gScore = {};
    const fScore = {};
    const cameFrom = {};

    const startNodeId = nodeToId(graph.startNode);
    const goalNodeId = graph.goalNode._streetId;
    gScore[startNodeId] = 0;
    fScore[startNodeId] = estimateHeuristic(graph.startNode, graph.goalNode, patientCondition);
    openSet.enqueue(graph.startNode, fScore[startNodeId]);

    while (!openSet.isEmpty()) {
        const current = openSet.dequeue();
        const currentId = nodeToId(current);

        if (current._streetId === goalNodeId) {
            const route = forceExactEndpoints(reconstructPath(cameFrom, current), start, goal);
            console.log(`Street-graph goal reached! Path found with ${route.length} OSM nodes`);
            logEnvCostStats();
            return {
                route,
                environmentalScore: gScore[currentId],
                routingBasis: 'street_graph',
                streetGraphNodeCount: streetGraph.nodes.length
            };
        }

        closedSet.add(currentId);
        const streetNeighbors = graph.adjacency.get(current._streetId) || [];
        for (const edge of streetNeighbors) {
            const neighbor = edge.node;
            const neighborId = nodeToId(neighbor);
            if (closedSet.has(neighborId)) continue;

            const tentativeGScore = await calculateCost(
                current,
                neighbor,
                gScore[currentId],
                patientCondition,
                environmentalData,
                preferences,
                poiLists,
                poiDistances,
                edge
            );

            const neighborInOpenSet = openSet.contains(neighborId);
            if (!neighborInOpenSet || tentativeGScore < gScore[neighborId]) {
                cameFrom[neighborId] = current;
                gScore[neighborId] = tentativeGScore;
                fScore[neighborId] = tentativeGScore + estimateHeuristic(neighbor, graph.goalNode, patientCondition);

                if (!neighborInOpenSet) {
                    openSet.enqueue(neighbor, fScore[neighborId]);
                } else {
                    openSet.updatePriority(neighborId, fScore[neighborId]);
                }
            }
        }
    }

    console.warn("No connected OSM street-graph path found for A*");
    logEnvCostStats();
    return null;
}

/**
 * Creates a search grid around the start and goal points
 * @param {Object} start - Starting point
 * @param {Object} goal - Goal point
 * @param {Number} resolution - Grid resolution in meters
 * @returns {Array} Grid of nodes
 */
function createSearchGrid(start, goal, resolution) {
    const grid = [];

    // Calculate bounding box with tolerance-scaled padding (slider widens it so
    // longer green detours become reachable grid nodes; baseline 0.01° at x1.0).
    const pad = tolerancePaddingDeg();
    const minLat = Math.min(start.lat, goal.lat) - pad;
    const maxLat = Math.max(start.lat, goal.lat) + pad;
    const minLon = Math.min(start.lon, goal.lon) - pad;
    const maxLon = Math.max(start.lon, goal.lon) + pad;

    // Calculate grid size
    const latMetersPerDegree = 111320; // at equator
    const lonMetersPerDegree = 111320 * Math.cos(((start.lat + goal.lat) / 2) * Math.PI / 180);

    const latStep = resolution / latMetersPerDegree;
    const lonStep = resolution / lonMetersPerDegree;

    // Generate grid points and a cell index for O(1) neighbor lookup.
    // The previous O(N^2) grid scan made long routes take 30+ seconds.
    const cells = new Map();
    let row = 0;
    for (let lat = minLat; lat <= maxLat; lat += latStep) {
        let col = 0;
        for (let lon = minLon; lon <= maxLon; lon += lonStep) {
            const node = { lat, lon, _row: row, _col: col };
            grid.push(node);
            const key = `${row},${col}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(node);
            col++;
        }
        row++;
    }

    grid.minLat = minLat;
    grid.minLon = minLon;
    grid.latStep = latStep;
    grid.lonStep = lonStep;
    grid.spatialCells = cells;

    return grid;
}

/**
 * Get neighboring nodes from the grid using the pre-built cell index.
 * @param {Object} node - Current node
 * @param {Array} grid - Search grid (with spatialCells property)
 * @param {Number} resolution - Grid resolution
 * @returns {Array} Neighboring nodes
 */
function getNeighbors(node, grid, resolution) {
    const latMetersPerDegree = 111320;
    const lonMetersPerDegree = 111320 * Math.cos(node.lat * Math.PI / 180);

    const latRadius = resolution / latMetersPerDegree;
    const lonRadius = resolution / lonMetersPerDegree;

    const cells = grid.spatialCells;
    let row = node._row;
    let col = node._col;

    // Start/goal are not grid nodes; map them to the nearest cell.
    if (row == null || col == null) {
        row = Math.round((node.lat - grid.minLat) / grid.latStep);
        col = Math.round((node.lon - grid.minLon) / grid.lonStep);
    }

    // Tolerance guards two float pitfalls that otherwise return ZERO neighbors
    // (the open set then drains after the start node → "No complete path found"):
    //   1) adjacent rows differ by exactly latStep, but accumulated-float makes
    //      latDiff a sub-ULP larger than latRadius, so a bare `<=` rejects it;
    //   2) the grid builds lonStep from cos(midLat) while this fn computes
    //      lonRadius from cos(node.lat) — off-centre rows never match.
    // The 3×3 cell scan already bounds candidates to truly-adjacent cells, so a
    // 1.5× tolerance only restores correct 8-connectivity (no over-connection).
    const NEIGHBOR_TOLERANCE = 1.5;
    const latLimit = latRadius * NEIGHBOR_TOLERANCE;
    const lonLimit = lonRadius * NEIGHBOR_TOLERANCE;

    const neighbors = [];
    for (let dRow = -1; dRow <= 1; dRow++) {
        for (let dCol = -1; dCol <= 1; dCol++) {
            const cellNodes = cells.get(`${row + dRow},${col + dCol}`);
            if (!cellNodes) continue;
            for (const gridNode of cellNodes) {
                if (gridNode === node) continue;
                const latDiff = Math.abs(gridNode.lat - node.lat);
                const lonDiff = Math.abs(gridNode.lon - node.lon);
                if (latDiff <= latLimit && lonDiff <= lonLimit) {
                    neighbors.push(gridNode);
                }
            }
        }
    }

    return neighbors;
}

/**
 * Calculate cost between two nodes
 * @param {Object} current - Current node
 * @param {Object} neighbor - Neighbor node
 * @param {Number} currentGScore - G-score of current node
 * @param {Object} patientCondition - Patient condition profile
 * @param {Array} environmentalData - Pre-loaded environmental data
 * @returns {Number} Cost value (g-score)
 */
function calculateStreetEdgePenalty(edgeContext, patientCondition, preferences = null) {
    if (!edgeContext?.highway || !patientCondition || patientCondition.name === 'default') {
        return 0;
    }

    const highway = String(edgeContext.highway);
    const patientName = patientCondition.name;
    let penalty = 0;

    if (['motorway', 'trunk', 'primary'].includes(highway)) {
        penalty += (patientCondition.airQualitySensitivity || 1) * 1.6;
        penalty += (patientCondition.noiseSensitivity || 1) * 0.9;
    } else if (['secondary', 'tertiary'].includes(highway)) {
        penalty += (patientCondition.airQualitySensitivity || 1) * 0.8;
        penalty += (patientCondition.noiseSensitivity || 1) * 0.4;
    }

    if (highway === 'steps') {
        if (patientName === 'mobility') penalty += 80;
        else if (patientName === 'arthritis') penalty += 55;
        else if (patientName === 'cardiac') penalty += 35;
        else if (patientName === 'respiratory') penalty += 20;
    }

    if (['footway', 'pedestrian', 'path', 'living_street', 'cycleway'].includes(highway)) {
        const natureWeight = (patientCondition.patientNature || 0) + (preferences?.nature || 0);
        penalty -= Math.max(0, natureWeight) * 0.35 * toleranceGreenScale();
    }

    return penalty;
}

async function calculateCost(current, neighbor, currentGScore, patientCondition, environmentalData, preferences = null, poiLists = null, poiDistances = null, edgeContext = null) {
    // Base cost is the physical distance.
    const distance = calculateDistance(current, neighbor);
    const neighborId = nodeToId(neighbor);
    // P0 audit fix: accumulate a NET environmental penalty (positive worsens, the
    // green/POI rewards subtract from it) into `penalty` instead of mutating the
    // running cost directly. The edge increment is then `distance + max(0, penalty)`,
    // so an arc can never cost LESS than its physical distance and never goes
    // negative. This keeps the straight-line heuristic admissible/consistent
    // (no negative weights → A* stays correct) while greener arcs still cost
    // strictly less, down to the physical-distance floor.
    let penalty = 0;

    // Real-only environmental data hierarchy:
    //   0) real low-res pre-fetch seed (isSynthetic:false)
    //   1) supplied real environmentalData list
    // Missing real values are skipped instead of replaced with synthetic/defaults.
    let envData = lookupSeededRealEnv(neighbor.lat, neighbor.lon);
    if (envData) {
        envCostStats.realSeedHits++;
    }
    if (!envData && environmentalData) {
        envData = findClosestRealEnvironmentalData(neighbor, environmentalData);
        if (envData) envCostStats.suppliedHits++;
    }
    if (!envData) {
        envCostStats.syntheticHits++;
    }

    // Apply environmental weights based on patient condition
    if (envData && patientCondition && patientCondition.name !== "default") {
        // Base multipliers
        const airQualityMultiplier = patientCondition.airQualitySensitivity || 1;
        const slopeMultiplier = patientCondition.slopeSensitivity || 1;
        const noiseMultiplier = patientCondition.noiseSensitivity || 1;
        const temperatureMultiplier = patientCondition.temperatureSensitivity || 1;
        const humidityMultiplier = patientCondition.humiditySensitivity || 1;
        
        // Add penalties based on environmental factors
        if (envData.airQuality !== null && envData.airQuality !== undefined) {
            // Air quality penalty (exponential for poor air quality)
            const airQualityPenalty = Math.pow(Math.max(0, envData.airQuality - 4), 2) * airQualityMultiplier;
            penalty += airQualityPenalty;
        }

        if (envData.slope !== null && envData.slope !== undefined) {
            // Slope penalty (quadratic)
            const slopePenalty = Math.pow(Math.abs(envData.slope), 2) * slopeMultiplier / 5;
            penalty += slopePenalty;
        }

        if (envData.noise !== null && envData.noise !== undefined) {
            // Noise penalty (linear with threshold)
            const noisePenalty = Math.max(0, envData.noise - 3) * noiseMultiplier;
            penalty += noisePenalty;
        }

        if (envData.temperature !== null && envData.temperature !== undefined) {
            // Temperature penalty (based on deviation from ideal)
            const tempDiff = Math.abs(envData.temperature - 22); // Deviation from comfortable 22°C
            const tempPenalty = tempDiff * temperatureMultiplier / 3;
            penalty += tempPenalty;
        }

        if (envData.humidity !== null && envData.humidity !== undefined) {
            // Humidity penalty (based on deviation from ideal)
            const humidityDiff = Math.abs(envData.humidity - 50); // Deviation from 50%
            const humidityPenalty = humidityDiff * humidityMultiplier / 10;
            penalty += humidityPenalty;
        }
        
        // Apply condition-specific penalties
        switch (patientCondition.name) {
            case "respiratory":
                // Higher penalties for areas with high traffic density
                if (envData.trafficDensity) {
                    penalty += envData.trafficDensity * airQualityMultiplier * 10;
                }
                // Lower cost for green areas (scaled by distance tolerance)
                if (envData.greenVisibility) {
                    penalty -= envData.greenVisibility * 5 * toleranceGreenScale();
                }
                break;

            case "cardiac":
                // Higher penalties for steep slopes
                if (envData.slope) {
                    penalty += Math.pow(Math.abs(envData.slope), 2) * slopeMultiplier / 2;
                }
                // Higher penalties for areas far from emergency services
                if (envData.emergencyAccessibility) {
                    penalty += envData.emergencyAccessibility * 2;
                }
                break;

            case "mobility":
                // Extremely high penalties for steep slopes
                if (envData.slope) {
                    penalty += Math.pow(Math.abs(envData.slope), 2.5) * slopeMultiplier;
                }
                // Penalties for poor surface quality
                if (envData.surfaceQuality) {
                    penalty += envData.surfaceQuality * 15;
                }
                break;

            case "mental":
                // Higher penalties for noisy areas
                if (envData.noise) {
                    penalty += Math.pow(envData.noise, 1.5) * noiseMultiplier;
                }
                // Higher penalties for areas with high sensory load
                if (envData.sensoryLoad) {
                    penalty += envData.sensoryLoad * 2;
                }
                // Lower cost for green areas (scaled by distance tolerance)
                if (envData.greenVisibility) {
                    penalty -= envData.greenVisibility * 8 * toleranceGreenScale();
                }
                break;
        }
    }
    
    // Apply user-preference weights alongside the pathology profile
    if (envData && patientCondition) {
        const combinedNature = (patientCondition.patientNature || 0) + (preferences?.nature || 0);
        const combinedEntertainment = (patientCondition.patientEntertainment || 0) + (preferences?.entertainment || 0);
        const combinedNightlife = (patientCondition.patientNightlife || 0) + (preferences?.nightlife || 0);
        const combinedTourism = (patientCondition.patientTourism || 0) + (preferences?.tourism || 0);
        const combinedHospital = (patientCondition.patientHospital || 0) + (preferences?.hospital || 0);

        if (combinedNature !== 0 && envData.greenVisibility != null) {
            penalty -= envData.greenVisibility * combinedNature * 0.8 * toleranceGreenScale();
        }
        if (combinedHospital !== 0 && envData.emergencyAccessibility != null) {
            penalty -= envData.emergencyAccessibility * combinedHospital * 0.8;
        }
        if (combinedEntertainment !== 0 && envData.noise != null) {
            penalty -= (envData.noise / 10) * combinedEntertainment * 0.8;
        }
        if (combinedNightlife !== 0 && envData.noise != null) {
            penalty -= (envData.noise / 10) * combinedNightlife * 0.8;
        }
        if (combinedTourism !== 0 && envData.greenVisibility != null) {
            penalty -= envData.greenVisibility * combinedTourism * 0.8 * toleranceGreenScale();
        }
    }

    // Apply POI-based preference adjustments when real POI data is available
    if (poiLists || poiDistances) {
        const poiCategories = ['nature', 'entertainment', 'nightlife', 'tourism', 'hospital'];
        const distances = poiDistances?.[neighborId];
        for (const category of poiCategories) {
            const patientKey = 'patient' + category.charAt(0).toUpperCase() + category.slice(1);
            const weight = (patientCondition?.[patientKey] || 0) + (preferences?.[category] || 0);
            if (weight !== 0) {
                const nearestDist = distances?.[category] ?? nearestPoiDistance(neighbor, poiLists?.[category]);
                penalty = applyPreferencePoiAdjustment(penalty, weight, nearestDist, category);
            }
        }
    }

    // P0 audit fix: floor the net penalty at 0 so the edge increment is always
    // >= physical distance (NO negative arc weights). Greener/closer-to-POI arcs
    // are still cheaper, but never below the straight-line distance. The penalty
    // model was tuned around ~100 m grid cells; scale it by edge length so real
    // OSM graph edges do not accidentally prefer many tiny segments or punish a
    // single long segment out of proportion.
    penalty += calculateStreetEdgePenalty(edgeContext, patientCondition, preferences);
    const edgeScale = Math.max(0.25, distance / 100);
    return currentGScore + distance + Math.max(0, penalty) * edgeScale;
}

/**
 * Find the closest environmental data point to a node
 * @param {Object} node - Node to find data for
 * @param {Array} environmentalData - Array of environmental data points
 * @returns {Object} Closest environmental data
 */
function findClosestRealEnvironmentalData(node, environmentalData) {
    if (!environmentalData || environmentalData.length === 0) {
        return null;
    }
    
    let closestDistance = Infinity;
    let closestData = null;
    
    for (const dataPoint of environmentalData) {
        if (!isRealEnvironmentData(dataPoint)) {
            continue;
        }
        if (dataPoint.coordinate) {
            const distance = calculateDistance(
                node, 
                { lat: dataPoint.coordinate.lat, lon: dataPoint.coordinate.lng }
            );
            
            if (distance < closestDistance) {
                closestDistance = distance;
                closestData = dataPoint;
            }
        }
    }
    
    return closestData;
}

/**
 * Calculate straight-line distance between two nodes
 * @param {Object} a - First node
 * @param {Object} b - Second node
 * @returns {Number} Distance in meters
 */
function calculateDistance(a, b) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = a.lat * Math.PI / 180;
    const φ2 = b.lat * Math.PI / 180;
    const Δφ = (b.lat - a.lat) * Math.PI / 180;
    const Δλ = (b.lon - a.lon) * Math.PI / 180;

    const x = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
    
    return R * c;
}

/**
 * Estimate heuristic cost from node to goal
 * @param {Object} node - Current node
 * @param {Object} goal - Goal node
 * @param {Object} patientCondition - Patient condition
 * @returns {Number} Heuristic estimate
 */
function estimateHeuristic(node, goal, patientCondition) {
    // Base heuristic is straight-line distance
    const distance = calculateDistance(node, goal);
    
    // We could adjust this heuristic based on expected environmental conditions
    // but a simple distance heuristic ensures admissibility
    return distance;
}

/**
 * Check if we've reached the goal
 * @param {Object} node - Current node
 * @param {Object} goal - Goal node
 * @returns {Boolean} True if goal reached
 */
function isGoalReached(node, goal) {
    // Goal is reached if within 50 meters
    return calculateDistance(node, goal) < 50;
}

/**
 * Convert node to string ID for tracking
 * @param {Object} node - Node to convert
 * @returns {String} Node ID
 */
function nodeToId(node) {
    return `${node.lat.toFixed(6)},${node.lon.toFixed(6)}`;
}

/**
 * Reconstruct path from start to current node
 * @param {Object} cameFrom - Map of node parents
 * @param {Object} current - Current node
 * @returns {Array} Path from start to current
 */
function reconstructPath(cameFrom, current) {
    const path = [current];
    let currentId = nodeToId(current);

    while (cameFrom[currentId]) {
        current = cameFrom[currentId];
        path.unshift(current);
        currentId = nodeToId(current);
    }

    return path;
}

/**
 * Force the EXACT requested A (start) and B (goal) as the first/last path nodes.
 *
 * The A* search runs on a free grid whose nodes do NOT coincide with the real
 * endpoints, and goal is "reached" at any grid node within 50 m of B. Without
 * this snap the reconstructed corridor begins/ends on an off-target grid node,
 * so downstream Mapbox/ORS snapping would route from/to the wrong point. We snap
 * an endpoint already within 0.5 m to the exact coordinate, otherwise append the
 * exact endpoint so the corridor is completed to A/B.
 * @param {Array} route - reconstructed A* path
 * @param {Object} start - exact A {lat, lon}
 * @param {Object} goal - exact B {lat, lon}
 * @returns {Array} path whose endpoints are exactly A and B
 */
function forceExactEndpoints(route, start, goal) {
    const startNode = { lat: start.lat, lon: start.lon };
    const goalNode = { lat: goal.lat, lon: goal.lon };
    if (!Array.isArray(route) || route.length === 0) {
        return [startNode, goalNode];
    }
    const path = route.slice();
    const SNAP_TOLERANCE_M = 0.5;

    if (calculateDistance(path[0], startNode) > SNAP_TOLERANCE_M) {
        path.unshift(startNode);
    } else {
        path[0] = startNode;
    }

    if (calculateDistance(path[path.length - 1], goalNode) > SNAP_TOLERANCE_M) {
        path.push(goalNode);
    } else {
        path[path.length - 1] = goalNode;
    }

    return path;
}

/**
 * Priority queue implementation for A*
 */
class PriorityQueue {
    constructor() {
        this.elements = [];
        this.idMap = {}; // Maps node IDs to indices
    }
    
    isEmpty() {
        return this.elements.length === 0;
    }
    
    enqueue(element, priority) {
        const id = nodeToId(element);
        const entry = { element, priority, id };
        this.elements.push(entry);
        this.idMap[id] = this.elements.length - 1;
        this.bubbleUp(this.elements.length - 1);
    }
    
    dequeue() {
        if (this.isEmpty()) {
            return null;
        }
        
        const top = this.elements[0].element;
        const end = this.elements.pop();
        delete this.idMap[nodeToId(top)];
        
        if (!this.isEmpty()) {
            this.elements[0] = end;
            this.idMap[end.id] = 0;
            this.sinkDown(0);
        }
        
        return top;
    }
    
    updatePriority(id, priority) {
        if (this.idMap[id] === undefined) {
            return false;
        }
        
        const index = this.idMap[id];
        const oldPriority = this.elements[index].priority;
        this.elements[index].priority = priority;
        
        if (priority < oldPriority) {
            this.bubbleUp(index);
        } else {
            this.sinkDown(index);
        }
        
        return true;
    }
    
    contains(id) {
        return this.idMap[id] !== undefined;
    }
    
    bubbleUp(index) {
        const element = this.elements[index];
        
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            const parent = this.elements[parentIndex];
            
            if (element.priority >= parent.priority) {
                break;
            }
            
            // Swap with parent
            this.elements[parentIndex] = element;
            this.elements[index] = parent;
            
            // Update ID map
            this.idMap[element.id] = parentIndex;
            this.idMap[parent.id] = index;
            
            index = parentIndex;
        }
    }
    
    sinkDown(index) {
        const length = this.elements.length;
        const element = this.elements[index];
        
        while (true) {
            const leftChildIndex = 2 * index + 1;
            const rightChildIndex = 2 * index + 2;
            let swapIndex = null;
            
            if (leftChildIndex < length) {
                const leftChild = this.elements[leftChildIndex];
                if (leftChild.priority < element.priority) {
                    swapIndex = leftChildIndex;
                }
            }
            
            if (rightChildIndex < length) {
                const rightChild = this.elements[rightChildIndex];
                if (
                    (swapIndex === null && rightChild.priority < element.priority) ||
                    (swapIndex !== null && rightChild.priority < this.elements[swapIndex].priority)
                ) {
                    swapIndex = rightChildIndex;
                }
            }
            
            if (swapIndex === null) {
                break;
            }
            
            // Swap with child
            this.elements[index] = this.elements[swapIndex];
            this.elements[swapIndex] = element;
            
            // Update ID map
            this.idMap[this.elements[index].id] = index;
            this.idMap[element.id] = swapIndex;
            
            index = swapIndex;
        }
    }
}

/**
 * Build a stable signature for an A* grid path so identical alternatives are
 * rejected before Mapbox snapping can turn them into duplicate UI cards.
 */
const ASTAR_ROUTE_SIGNATURE_PRECISION = 4;
const ASTAR_ALTERNATIVE_MAX_ATTEMPTS = 5;

function normalizeRouteNode(node) {
    if (!node) {
        return null;
    }

    const lat = Number.parseFloat(node.lat);
    const lon = Number.parseFloat(node.lon ?? node.lng);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function getRoutePathNodes(routeResult) {
    return Array.isArray(routeResult?.route) ? routeResult.route : [];
}

function buildRouteGridSignature(routeResult, precision = ASTAR_ROUTE_SIGNATURE_PRECISION) {
    const normalizedNodes = [];

    getRoutePathNodes(routeResult)
        .map(normalizeRouteNode)
        .filter(Boolean)
        .forEach(node => {
            const previous = normalizedNodes[normalizedNodes.length - 1];
            const key = `${node.lat.toFixed(precision)},${node.lon.toFixed(precision)}`;
            if (!previous || previous.key !== key) {
                normalizedNodes.push({ key });
            }
        });

    return normalizedNodes.map(node => node.key).join('|');
}

function addRoutePenalties(penalties, routeResult, nodePenalty = 100, nearbyPenalty = 50) {
    for (const node of getRoutePathNodes(routeResult)) {
        const normalizedNode = normalizeRouteNode(node);
        if (!normalizedNode) {
            continue;
        }

        const nodeId = nodeToId(normalizedNode);
        const currentPenalty = penalties.get(nodeId) || 0;
        penalties.set(nodeId, currentPenalty + nodePenalty);

        // Also penalize nearby nodes so small grid shifts do not immediately
        // recreate the same corridor.
        const penaltyRadius = 0.001; // Roughly 100m
        for (let lat = normalizedNode.lat - penaltyRadius; lat <= normalizedNode.lat + penaltyRadius; lat += penaltyRadius / 2) {
            for (let lon = normalizedNode.lon - penaltyRadius; lon <= normalizedNode.lon + penaltyRadius; lon += penaltyRadius / 2) {
                const nearbyId = nodeToId({ lat, lon });
                const currentNearbyPenalty = penalties.get(nearbyId) || 0;
                penalties.set(nearbyId, currentNearbyPenalty + nearbyPenalty);
            }
        }
    }
}

/**
 * Generate multiple alternative routes using A*
 * @param {Object} start - Starting point
 * @param {Object} goal - Goal point
 * @param {Object} map - Leaflet map
 * @param {Object} patientCondition - Patient condition
 * @param {Number} numRoutes - Number of alternative routes to generate
 * @returns {Array} Array of routes
 */
export async function generateAlternativeRoutes(start, goal, map, patientCondition, numRoutes = 3, preferences = null, distanceTolerance = 1, transportMode = 'walking') {
    // Apply the UI distance-tolerance slider for this whole route calculation:
    // widens the search bbox and amplifies the green reward (slider=1 = baseline).
    setDistanceTolerance(distanceTolerance);

    const benchmarkMode = window.PATHPLANNER_BENCHMARK === true;
    const effectiveNumRoutes = benchmarkMode
        ? Math.min(numRoutes, window.BENCHMARK_ASTAR_NUM_ROUTES ?? 1)
        : numRoutes;
    const gridResolution = benchmarkMode
        ? (window.BENCHMARK_ASTAR_GRID_M || 150)
        : 100;

    if (!benchmarkMode) {
        console.log(
            `Generating ${effectiveNumRoutes} alternative routes for ${patientCondition.name} condition`,
        );
    }

    const bbox = getRouteBbox(start, goal);
    const categories = ['nature', 'entertainment', 'nightlife', 'tourism', 'hospital'];
    const activeCategories = categories.filter(category => {
        const patientKey = 'patient' + category.charAt(0).toUpperCase() + category.slice(1);
        return ((patientCondition?.[patientKey] || 0) + (preferences?.[category] || 0)) !== 0;
    });

    const poiLists = {};
    await Promise.all(activeCategories.map(async category => {
        poiLists[category] = await fetchPoiLocationsWithBudget(bbox, category);
    }));

    const useLegacyGridAstar = window.PATHPLANNER_USE_GRID_ASTAR === true;
    let streetGraph = null;
    if (!useLegacyGridAstar) {
        try {
            streetGraph = await fetchStreetGraphForBounds(bbox, transportMode);
            if (!benchmarkMode) {
                console.log(
                    `[generateAlternativeRoutes] Using real OSM street graph ` +
                    `(${streetGraph.count?.nodes ?? streetGraph.nodes.length} nodes)`
                );
            }
        } catch (error) {
            console.warn(
                '[generateAlternativeRoutes] Real OSM street graph unavailable; ' +
                'skipping environmental A* instead of falling back to an artificial grid:',
                error.message
            );
            return [];
        }
    }

    const runAstar = () => streetGraph
        ? findOptimalRouteOnStreetGraph(
            start,
            goal,
            streetGraph,
            patientCondition,
            null,
            preferences,
            poiLists,
        )
        : findOptimalRoute(
            start,
            goal,
            map,
            patientCondition,
            null,
            gridResolution,
            preferences,
            poiLists,
        );

    // A* consumes only real env seed/supplied data plus real POIs. Missing
    // environmental fields are skipped, not replaced with synthetic values.
    const firstRoute = await runAstar();
    
    const routes = [];
    const acceptedRouteSignatures = new Set();

    function acceptDistinctRoute(routeResult, label) {
        if (!routeResult) {
            return false;
        }

        const signature = buildRouteGridSignature(routeResult);
        if (signature && acceptedRouteSignatures.has(signature)) {
            if (!benchmarkMode) {
                console.warn(`[generateAlternativeRoutes] Skipping duplicate ${label}; A* grid signature already accepted.`);
            }
            return false;
        }

        routeResult.routeGridSignature = signature;
        routes.push(routeResult);
        if (signature) {
            acceptedRouteSignatures.add(signature);
        }
        return true;
    }

    acceptDistinctRoute(firstRoute, 'primary route');

    // For each additional route, add penalties to areas of previous routes.
    const penalties = new Map(); // Maps nodeId -> penalty
    addRoutePenalties(penalties, firstRoute);

    while (routes.length < effectiveNumRoutes) {
        const routeNumber = routes.length + 1;
        if (!benchmarkMode) {
            console.log(`Generating alternative route ${routeNumber}`);
        }

        let acceptedAlternative = false;

        for (let attempt = 0; attempt < ASTAR_ALTERNATIVE_MAX_ATTEMPTS; attempt++) {
            // Create a modified cost calculation function with penalties
            const originalCalculateCost = calculateCost;
            const calculateCostWithPenalties = async (current, neighbor, currentGScore, patientCondition, environmentalData, prefs, lists, poiDistances, edgeContext) => {
                let cost = await originalCalculateCost(current, neighbor, currentGScore, patientCondition, environmentalData, prefs, lists, poiDistances, edgeContext);

                // Add penalties for previously visited nodes
                const neighborId = nodeToId(neighbor);
                const penalty = penalties.get(neighborId) || 0;
                cost += penalty;

                return cost;
            };

            let alternativeRoute = null;
            try {
                // Temporarily replace the cost function
                calculateCost = calculateCostWithPenalties;

                // Generate alternative route
                alternativeRoute = await runAstar();
            } finally {
                // Restore original cost function even if A* fails
                calculateCost = originalCalculateCost;
            }

            if (acceptDistinctRoute(alternativeRoute, `alternative route ${routeNumber} attempt ${attempt + 1}`)) {
                addRoutePenalties(penalties, alternativeRoute);
                acceptedAlternative = true;
                break;
            }

            // Increase penalties around the duplicate corridor and retry.
            addRoutePenalties(
                penalties,
                alternativeRoute,
                150 * (attempt + 1),
                75 * (attempt + 1)
            );
        }

        if (!acceptedAlternative) {
            if (!benchmarkMode) {
                console.warn(`[generateAlternativeRoutes] Could only produce ${routes.length} distinct A* route(s).`);
            }
            break;
        }
    }
    
    // Sort routes by environmental score
    routes.sort((a, b) => a.environmentalScore - b.environmentalScore);
    
    return routes;
}

/**
 * Convert A* route to Leaflet format
 * @param {Array} route - A* route
 * @returns {Array} Leaflet-compatible route
 */
export function convertToLeafletRoute(route) {
    return route.map(node => L.latLng(node.lat, node.lon));
}

/**
 * Calculate the environmental cost of a path node based on patient condition
 * @param {Object} node - Path node with lat/lon coordinates
 * @param {Object} patientCondition - Patient condition with sensitivities
 * @returns {Promise<number>} - Cost value (higher is worse)
 */
export async function calculateEnvironmentalCost(node, patientCondition) {
    if (!node || !node.lat || !node.lon) {
        console.error("Invalid node provided to calculateEnvironmentalCost:", node);
        return 1000; // Default high cost for invalid nodes
    }
    
    try {
        console.log(`[calculateEnvironmentalCost] Getting data for ${node.lat.toFixed(6)}, ${node.lon.toFixed(6)}`);
        const envData = await Environmental.getPointEnvironmentalData(node.lat, node.lon, patientCondition);
        
        // If data fetch failed, return moderate cost
        if (!envData) return 500;
        
        // Base cost starts at 50 (neutral)
        let baseCost = 50;
        
        // Track if this uses real or simulated data
        const isRealData = !envData.isDefault;
        
        // Calculate condition-specific cost based on environmental factors
        // IMPORTANT: Lower is better for A* algorithm
        
        if (patientCondition && patientCondition.name !== "default") {
            switch(patientCondition.name) {
                case "respiratory":
                    // For respiratory conditions, air quality is most important
                    if (envData.airQuality !== null) {
                        // Air quality has exponential impact (worse air = much higher cost)
                        baseCost += Math.pow(envData.airQuality, 2) * 5;
                    }
                    
                    // Steep slopes require more exertion (breathing difficulty)
                    if (envData.slope !== null) {
                        baseCost += Math.pow(envData.slope, 1.5) * 3;
                    }
                    
                    // Temperature extremes can affect breathing
                    if (envData.temperature !== null) {
                        const optimalTemp = 22; // 22°C is optimal
                        const tempDiff = Math.abs(envData.temperature - optimalTemp);
                        baseCost += tempDiff * 2;
                    }
                    
                    // Traffic exposure increases respiratory issues
                    if (envData.trafficDensity !== null) {
                        baseCost += envData.trafficDensity * 100;
                    }
                    
                    // Green areas improve air quality
                    if (envData.greenVisibility !== null) {
                        baseCost -= envData.greenVisibility * 50;
                    }
                    break;
                    
                case "cardiac":
                    // For cardiac conditions, slope is most important
                    if (envData.slope !== null) {
                        // Steeper slopes have exponential impact on cardiac strain
                        baseCost += Math.pow(envData.slope, 2) * 8;
                    }
                    
                    // Emergency access is critical
                    if (envData.emergencyAccessibility !== null) {
                        baseCost += envData.emergencyAccessibility * 10;
                    }
                    
                    // Rest opportunities reduce cardiac strain
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 60;
                    }
                    
                    // Temperature extremes affect cardiac function
                    if (envData.temperature !== null) {
                        const optimalTemp = 22; // 22°C is optimal
                        const tempDiff = Math.abs(envData.temperature - optimalTemp);
                        baseCost += tempDiff * 3;
                    }
                    
                    // Air quality affects heart
                    if (envData.airQuality !== null) {
                        baseCost += envData.airQuality * 3;
                    }
                    break;
                    
                case "mobility":
                    // For mobility conditions, slope and surface quality are most important
                    if (envData.slope !== null) {
                        // Any slope is problematic - use higher exponent for steeper penalty
                        baseCost += Math.pow(envData.slope, 2.5) * 10;
                    }
                    
                    // Surface quality is critical
                    if (envData.surfaceQuality !== null) {
                        baseCost += envData.surfaceQuality * 150;
                    }
                    
                    // Street width affects mobility device usage
                    if (envData.streetWidth !== null) {
                        // Narrower streets are more difficult
                        baseCost += Math.max(0, (4 - envData.streetWidth)) * 30;
                    }
                    
                    // Accessibility features are beneficial
                    if (envData.accessibilityFeatures !== null) {
                        baseCost -= envData.accessibilityFeatures * 80;
                    }
                    
                    // Rest opportunities
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 40;
                    }
                    break;
                    
                case "mental":
                    // For mental conditions, noise and green space are most important
                    if (envData.noise !== null) {
                        // Noise has exponential impact on mental wellbeing
                        baseCost += Math.pow(envData.noise, 1.8) * 5;
                    }
                    
                    // Green spaces are highly beneficial
                    if (envData.greenVisibility !== null) {
                        baseCost -= envData.greenVisibility * 100;
                    }
                    
                    // Sensory load affects mental wellbeing
                    if (envData.sensoryLoad !== null) {
                        baseCost += envData.sensoryLoad * 8;
                    }
                    
                    // Traffic density increases stress
                    if (envData.trafficDensity !== null) {
                        baseCost += envData.trafficDensity * 80;
                    }
                    
                    // Weather affects mood
                    if (envData.weather) {
                        if (envData.weather.includes("Clear") || envData.weather.includes("Sun")) {
                            baseCost -= 30;
                        } else if (envData.weather.includes("Rain") || envData.weather.includes("Cloud")) {
                            baseCost += 20;
                        }
                    }
                    break;
                    
                case "arthritis":
                    // For arthritis conditions, surface quality and temperature are most important
                    if (envData.surfaceQuality !== null) {
                        baseCost += envData.surfaceQuality * 120;
                    }
                    
                    // Slopes affect joints
                    if (envData.slope !== null) {
                        baseCost += Math.pow(envData.slope, 1.8) * 7;
                    }
                    
                    // Cold temperatures worsen joint pain
                    if (envData.temperature !== null) {
                        // Cold is worse than hot for arthritis
                        if (envData.temperature < 20) {
                            baseCost += Math.pow(20 - envData.temperature, 1.5) * 4;
                        } else if (envData.temperature > 30) {
                            baseCost += (envData.temperature - 30) * 2;
                        }
                    }
                    
                    // Rest opportunities are important
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 70;
                    }
                    
                    // Humidity affects joints
                    if (envData.humidity !== null) {
                        if (envData.humidity > 60) {
                            baseCost += (envData.humidity - 60) * 0.5;
                        }
                    }
                    break;
                    
                case "diabetes":
                    // For diabetes, moderate exercise with service access is important
                    
                    // Moderate slopes provide good exercise
                    if (envData.slope !== null) {
                        // Gentle slopes (1-4%) are beneficial, steeper slopes are problematic
                        const optimalSlope = 2.5;
                        const slopeDiff = Math.abs(envData.slope - optimalSlope);
                        
                        if (envData.slope <= 4) {
                            // Gentle slopes get a bonus
                            baseCost -= (4 - slopeDiff) * 10;
                        } else {
                            // Steeper slopes get a penalty
                            baseCost += (envData.slope - 4) * 15;
                        }
                    }
                    
                    // Access to services
                    if (envData.emergencyAccessibility !== null) {
                        baseCost += envData.emergencyAccessibility * 8;
                    }
                    
                    // Food access is important for blood sugar management
                    if (envData.foodAccess !== null) {
                        baseCost -= envData.foodAccess * 60;
                    }
                    
                    // Rest opportunities
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 50;
                    }
                    
                    // Temperature extremes
                    if (envData.temperature !== null) {
                        const optimalTemp = 22;
                        const tempDiff = Math.abs(envData.temperature - optimalTemp);
                        
                        if (tempDiff > 8) {
                            // Large temperature deviations are problematic
                            baseCost += (tempDiff - 8) * 10;
                        }
                    }
                    break;
                    
                default:
                    // For default/unknown conditions, use a general cost model
                    if (envData.airQuality !== null) baseCost += envData.airQuality * 3;
                    if (envData.slope !== null) baseCost += envData.slope * 5;
                    if (envData.noise !== null) baseCost += envData.noise * 2;
                    break;
            }
        } else {
            // Default cost calculation for non-patient mode
            if (envData.airQuality !== null) baseCost += envData.airQuality * 3;
            if (envData.slope !== null) baseCost += envData.slope * 5;
            if (envData.noise !== null) baseCost += envData.noise * 2;
        }
        
        // Ensure cost is never negative or extremely high
        const finalCost = Math.max(10, Math.min(1000, baseCost));
        
        // Slight bonus for real data
        const realDataCost = isRealData ? finalCost * 0.9 : finalCost;
        
        // Debug info
        console.log(`[calculateEnvironmentalCost] Node (${node.lat.toFixed(6)}, ${node.lon.toFixed(6)}) - Cost: ${realDataCost.toFixed(2)} - Using ${isRealData ? 'REAL' : 'SIMULATED'} data`);
        
        return realDataCost;
    } catch (error) {
        console.error("Error calculating environmental cost:", error);
        return 500; // Default moderate cost on error
    }
}

/**
 * Custom heuristic function for A* that includes environmental factors
 * @param {Object} node - Current node
 * @param {Object} goal - Goal node
 * @param {Object} patientCondition - Patient condition
 * @returns {number} - Heuristic value
 */
export function environmentalHeuristic(node, goal, patientCondition) {
    // Base heuristic: direct distance to goal (in meters)
    const distance = haversineDistance(
        node.lat, node.lon,
        goal.lat, goal.lon
    );
    
    // Calculate condition-specific heuristic factors
    let heuristicMultiplier = 1.0;
    
    if (patientCondition && patientCondition.name !== "default") {
        switch(patientCondition.name) {
            case "respiratory":
                // Respiratory patients prefer slightly longer but better air quality routes
                heuristicMultiplier = 0.85;
                break;
                
            case "cardiac":
                // Cardiac patients need flatter routes even if slightly longer
                heuristicMultiplier = 0.8;
                break;
                
            case "mobility":
                // Mobility patients need accessible routes even if longer
                heuristicMultiplier = 0.75;
                break;
                
            case "mental":
                // Mental health patients benefit from scenic/calm routes
                heuristicMultiplier = 0.85;
                break;
                
            case "arthritis":
                // Arthritis patients need smooth surfaces even if longer
                heuristicMultiplier = 0.8;
                break;
                
            case "diabetes":
                // Diabetes patients need moderate exercise and service access
                heuristicMultiplier = 0.9;
                break;
                
            default:
                heuristicMultiplier = 1.0;
        }
    }
    
    // Apply the multiplier to encourage exploration of potentially better routes
    // A lower heuristic allows the algorithm to explore more paths
    return distance * heuristicMultiplier;
}

/**
 * Calculate distance between two points using the Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} - Distance in meters
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
}
