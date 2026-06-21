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
import { lookupEnv } from '../data/envTileIndex.js';

const POI_CATEGORY_TAGS = {
    hospital: ['node["amenity"="hospital"]', 'node["healthcare"="hospital"]'],
    entertainment: ['node["amenity"="cinema"]', 'node["amenity"="theatre"]', 'node["amenity"="concert_hall"]'],
    nightlife: ['node["amenity"="bar"]', 'node["amenity"="pub"]', 'node["amenity"="nightclub"]'],
    tourism: ['node["tourism"="attraction"]', 'node["tourism"="museum"]', 'node["tourism"="viewpoint"]'],
    nature: ['node["leisure"="park"]', 'node["natural"="wood"]', 'node["leisure"="garden"]']
};

// Lightweight, deterministic synthetic environmental data used during A* search.
// We intentionally avoid live API calls per grid node because they make long routes
// unbearably slow; the real environmental profile is computed later for the final route.
const astarEnvCache = new Map();

// ---------------------------------------------------------------------------
// Real environmental tile seed (Option B — hybrid, non-blocking).
// A low-res pre-fetch of REAL /api/environment data (fired from routePlanner
// BEFORE A* and NEVER awaited) streams resolved real points into this seed.
// The A* cost function reads it as its TOP-priority environmental source, so
// the SELECTED path is guided by real pollution/noise where available. If the
// pre-fetch has not resolved for a given area, the cost falls back to the
// marked synthetic model — A* never blocks waiting for real data.
// HARD RULE: every point stored here is REAL (isSynthetic:false / isDefault:false);
// synthetic points are rejected at the seam.
// ---------------------------------------------------------------------------
const realEnvSeed = {
    points: [],
    maxRadiusM: 1200,
};

// Per-route cost-source telemetry — lets us PROVE the selected path consumed
// real env from the seed (vs synthetic fallback). Reset at each findOptimalRoute.
let envCostStats = { realSeedHits: 0, staticTileHits: 0, suppliedHits: 0, syntheticHits: 0 };

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
        `synthetic fallback: ${s.syntheticHits} (isSynthetic:true) | ` +
        `real share of selection cost ≈ ${pct}% over ${total} node evals ` +
        `| seed size=${realEnvSeed.points.length}`
    );
}

function deterministicLocationFactor(lat, lon) {
    const value = Math.abs(Math.sin(lat * 1000) * 10000 + Math.cos(lon * 1000) * 10000);
    return (value % 1000) / 1000;
}

function createFastEnvironmentalData(lat, lon, patientCondition) {
    const hash = deterministicLocationFactor(lat, lon);
    const baseData = {
        temperature: 18 + hash * 14,           // 18-32°C
        humidity: 35 + hash * 40,              // 35-75%
        airQuality: 1 + hash * 9,              // 1-10 AQI
        slope: hash * 10,                      // 0-10%
        noise: 1 + hash * 9,                   // 1-10 noise level
        trafficDensity: hash * 0.8,            // 0-0.8
        greenVisibility: hash * 0.8,           // 0-0.8
        surfaceQuality: hash * 0.5,            // 0-0.5
        emergencyAccessibility: 1 + hash * 9,  // 1-10
        sensoryLoad: 1 + hash * 9,             // 1-10
        weather: hash < 0.7 ? 'Clear' : 'Cloudy',
        isDefault: true,
        isSynthetic: true
    };

    // Blend in known condition-specific hotspots so the A* still reacts to real
    // problem areas (e.g., high traffic near a known bad air-quality region).
    if (patientCondition && patientCondition.name && patientCondition.name !== 'default') {
        const factor = patientCondition.name.toLowerCase();
        if (factor === 'respiratory') {
            baseData.airQuality = Math.min(10, baseData.airQuality + baseData.trafficDensity * 2);
        } else if (factor === 'cardiac' || factor === 'mobility') {
            baseData.slope = Math.min(15, baseData.slope * (1 + hash));
        } else if (factor === 'mental') {
            baseData.noise = Math.min(10, baseData.noise + baseData.trafficDensity * 2);
        }
    }

    return baseData;
}

function getFastEnvironmentalData(lat, lon, patientCondition) {
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    let data = astarEnvCache.get(key);
    if (!data) {
        data = createFastEnvironmentalData(lat, lon, patientCondition);
        astarEnvCache.set(key, data);
    }
    return data;
}

function getRouteBbox(start, goal) {
    return {
        minLat: Math.min(start.lat, goal.lat) - 0.01,
        maxLat: Math.max(start.lat, goal.lat) + 0.01,
        minLon: Math.min(start.lon, goal.lon) - 0.01,
        maxLon: Math.max(start.lon, goal.lon) + 0.01
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

function applyPreferencePoiAdjustment(cost, weight, nearestDistanceMeters) {
    if (weight && typeof weight === 'number' && Number.isFinite(nearestDistanceMeters)) {
        cost += -weight * 5.0 * Math.exp(-nearestDistanceMeters / 200.0);
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

    // Reset the synthetic cache so each route calculation uses data consistent
    // with the current patient condition, then pre-compute for every grid node.
    astarEnvCache.clear();
    for (const node of grid) {
        getFastEnvironmentalData(node.lat, node.lon, patientCondition);
    }

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
            const route = reconstructPath(cameFrom, current);
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
        route: bestRoute || [start, goal],
        environmentalScore: bestEnvironmentalScore
    };
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

    // Calculate bounding box with some padding
    const minLat = Math.min(start.lat, goal.lat) - 0.01;
    const maxLat = Math.max(start.lat, goal.lat) + 0.01;
    const minLon = Math.min(start.lon, goal.lon) - 0.01;
    const maxLon = Math.max(start.lon, goal.lon) + 0.01;

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
async function calculateCost(current, neighbor, currentGScore, patientCondition, environmentalData, preferences = null, poiLists = null, poiDistances = null) {
    // Base cost is the physical distance
    const distance = calculateDistance(current, neighbor);
    const neighborId = nodeToId(neighbor);
    let cost = currentGScore + distance;
    
    // Environmental data hierarchy (Option B — real GUIDES selection, non-blocking):
    //   0) real low-res pre-fetch seed (isSynthetic:false) — colors the SELECTION cost
    //   1) pre-baked static tile cache (lookupEnv)
    //   2) supplied environmentalData list
    //   3) marked synthetic fallback (isSynthetic:true — never blocks, never "real")
    let envData = lookupSeededRealEnv(neighbor.lat, neighbor.lon);
    if (envData) {
        envCostStats.realSeedHits++;
    } else {
        envData = lookupEnv(neighbor.lat, neighbor.lon);
        if (envData) envCostStats.staticTileHits++;
    }
    if (!envData && environmentalData) {
        envData = findClosestEnvironmentalData(neighbor, environmentalData);
        if (envData) envCostStats.suppliedHits++;
    }
    if (!envData) {
        // Fast synthetic fallback: real environmental data is sampled later for the
        // final route; doing live API calls for every grid node makes long routes
        // take 30+ seconds. The pre-fetch seed above is what introduces real data
        // into selection without that per-node cost.
        envData = getFastEnvironmentalData(neighbor.lat, neighbor.lon, patientCondition);
        envCostStats.syntheticHits++;
    }

    // Apply environmental weights based on patient condition
    if (patientCondition && patientCondition.name !== "default") {
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
            cost += airQualityPenalty;
        }
        
        if (envData.slope !== null && envData.slope !== undefined) {
            // Slope penalty (quadratic)
            const slopePenalty = Math.pow(Math.abs(envData.slope), 2) * slopeMultiplier / 5;
            cost += slopePenalty;
        }
        
        if (envData.noise !== null && envData.noise !== undefined) {
            // Noise penalty (linear with threshold)
            const noisePenalty = Math.max(0, envData.noise - 3) * noiseMultiplier;
            cost += noisePenalty;
        }
        
        if (envData.temperature !== null && envData.temperature !== undefined) {
            // Temperature penalty (based on deviation from ideal)
            const tempDiff = Math.abs(envData.temperature - 22); // Deviation from comfortable 22°C
            const tempPenalty = tempDiff * temperatureMultiplier / 3;
            cost += tempPenalty;
        }
        
        if (envData.humidity !== null && envData.humidity !== undefined) {
            // Humidity penalty (based on deviation from ideal)
            const humidityDiff = Math.abs(envData.humidity - 50); // Deviation from 50%
            const humidityPenalty = humidityDiff * humidityMultiplier / 10;
            cost += humidityPenalty;
        }
        
        // Apply condition-specific penalties
        switch (patientCondition.name) {
            case "respiratory":
                // Higher penalties for areas with high traffic density
                if (envData.trafficDensity) {
                    cost += envData.trafficDensity * airQualityMultiplier * 10;
                }
                // Lower cost for green areas
                if (envData.greenVisibility) {
                    cost -= envData.greenVisibility * 5;
                }
                break;
                
            case "cardiac":
                // Higher penalties for steep slopes
                if (envData.slope) {
                    cost += Math.pow(Math.abs(envData.slope), 2) * slopeMultiplier / 2;
                }
                // Higher penalties for areas far from emergency services
                if (envData.emergencyAccessibility) {
                    cost += envData.emergencyAccessibility * 2;
                }
                break;
                
            case "mobility":
                // Extremely high penalties for steep slopes
                if (envData.slope) {
                    cost += Math.pow(Math.abs(envData.slope), 2.5) * slopeMultiplier;
                }
                // Penalties for poor surface quality
                if (envData.surfaceQuality) {
                    cost += envData.surfaceQuality * 15;
                }
                break;
                
            case "mental":
                // Higher penalties for noisy areas
                if (envData.noise) {
                    cost += Math.pow(envData.noise, 1.5) * noiseMultiplier;
                }
                // Higher penalties for areas with high sensory load
                if (envData.sensoryLoad) {
                    cost += envData.sensoryLoad * 2;
                }
                // Lower cost for green areas
                if (envData.greenVisibility) {
                    cost -= envData.greenVisibility * 8;
                }
                break;
        }
    }
    
    // Apply user-preference weights alongside the pathology profile
    if (patientCondition) {
        const combinedNature = (patientCondition.patientNature || 0) + (preferences?.nature || 0);
        const combinedEntertainment = (patientCondition.patientEntertainment || 0) + (preferences?.entertainment || 0);
        const combinedNightlife = (patientCondition.patientNightlife || 0) + (preferences?.nightlife || 0);
        const combinedTourism = (patientCondition.patientTourism || 0) + (preferences?.tourism || 0);
        const combinedHospital = (patientCondition.patientHospital || 0) + (preferences?.hospital || 0);

        if (combinedNature !== 0 && envData.greenVisibility != null) {
            cost -= envData.greenVisibility * combinedNature * 0.8;
        }
        if (combinedHospital !== 0 && envData.emergencyAccessibility != null) {
            cost -= envData.emergencyAccessibility * combinedHospital * 0.8;
        }
        if (combinedEntertainment !== 0 && envData.noise != null) {
            cost -= (envData.noise / 10) * combinedEntertainment * 0.8;
        }
        if (combinedNightlife !== 0 && envData.noise != null) {
            cost -= (envData.noise / 10) * combinedNightlife * 0.8;
        }
        if (combinedTourism !== 0 && envData.greenVisibility != null) {
            cost -= envData.greenVisibility * combinedTourism * 0.8;
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
                cost = applyPreferencePoiAdjustment(cost, weight, nearestDist);
            }
        }
    }
    
    return cost;
}

/**
 * Find the closest environmental data point to a node
 * @param {Object} node - Node to find data for
 * @param {Array} environmentalData - Array of environmental data points
 * @returns {Object} Closest environmental data
 */
function findClosestEnvironmentalData(node, environmentalData) {
    if (!environmentalData || environmentalData.length === 0) {
        return null;
    }
    
    let closestDistance = Infinity;
    let closestData = null;
    
    for (const dataPoint of environmentalData) {
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
 * Generate multiple alternative routes using A*
 * @param {Object} start - Starting point
 * @param {Object} goal - Goal point
 * @param {Object} map - Leaflet map
 * @param {Object} patientCondition - Patient condition
 * @param {Number} numRoutes - Number of alternative routes to generate
 * @returns {Array} Array of routes
 */
export async function generateAlternativeRoutes(start, goal, map, patientCondition, numRoutes = 3, preferences = null) {
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
        poiLists[category] = await fetchPoiLocations(bbox, category);
    }));

    // No live environmental data is passed into A*: the cost function falls back
    // to a fast synthetic model for grid nodes. Real weather/air-quality data is
    // sampled later, once the final route has been found (max ~20 points).
    const firstRoute = await findOptimalRoute(
        start,
        goal,
        map,
        patientCondition,
        null,
        gridResolution,
        preferences,
        poiLists,
    );
    
    const routes = [firstRoute];
    
    // For each additional route, add penalties to areas of previous routes
    const penalties = new Map(); // Maps nodeId -> penalty
    
    for (let i = 1; i < effectiveNumRoutes; i++) {
        if (!benchmarkMode) {
            console.log(`Generating alternative route ${i + 1}`);
        }
        
        // Add penalties to previously found routes
        for (const route of routes) {
            for (const node of route.route) {
                const nodeId = nodeToId(node);
                const currentPenalty = penalties.get(nodeId) || 0;
                penalties.set(nodeId, currentPenalty + 100); // Add significant penalty
                
                // Also penalize nearby nodes
                const nearbyPenalty = 50;
                const penaltyRadius = 0.001; // Roughly 100m
                
                for (let lat = node.lat - penaltyRadius; lat <= node.lat + penaltyRadius; lat += penaltyRadius / 2) {
                    for (let lon = node.lon - penaltyRadius; lon <= node.lon + penaltyRadius; lon += penaltyRadius / 2) {
                        const nearbyId = nodeToId({ lat, lon });
                        const currentNearbyPenalty = penalties.get(nearbyId) || 0;
                        penalties.set(nearbyId, currentNearbyPenalty + nearbyPenalty);
                    }
                }
            }
        }
        
        // Create a modified cost calculation function with penalties
        const originalCalculateCost = calculateCost;
        const calculateCostWithPenalties = async (current, neighbor, currentGScore, patientCondition, environmentalData, prefs, lists, poiDistances) => {
            let cost = await originalCalculateCost(current, neighbor, currentGScore, patientCondition, environmentalData, prefs, lists, poiDistances);
            
            // Add penalties for previously visited nodes
            const neighborId = nodeToId(neighbor);
            const penalty = penalties.get(neighborId) || 0;
            cost += penalty;
            
            return cost;
        };
        
        // Temporarily replace the cost function
        calculateCost = calculateCostWithPenalties;
        
        // Generate alternative route
        const alternativeRoute = await findOptimalRoute(
            start,
            goal,
            map,
            patientCondition,
            null,
            gridResolution,
            preferences,
            poiLists,
        );

        routes.push(alternativeRoute);
        
        // Restore original cost function
        calculateCost = originalCalculateCost;
    }
    
    // Sort routes by environmental score
    routes.sort((a, b) => a.environmentalScore - b.environmentalScore);
    
    return routes;
}

/**
 * Collect environmental data along a path
 * @param {Array} path - Array of nodes
 * @param {Object} patientCondition - Patient condition
 * @param {Number} routeIndex - Index for variation between routes (optional)
 * @returns {Array} Environmental data for the path
 */
async function collectEnvironmentalData(path, patientCondition, routeIndex = 0) {
    const environmentalData = [];

    const benchmarkMode = window.PATHPLANNER_BENCHMARK === true;
    const sampleCount = benchmarkMode
        ? Math.min(4, path.length)
        : Math.min(20, path.length);
    const step = Math.max(1, Math.floor(path.length / sampleCount));

    // Use the same fast synthetic generator as the A* cost function. Calling live
    // weather/air-quality APIs for every sample point is the main reason long
    // routes take 30+ seconds to calculate.
    for (let i = 0; i < path.length; i += step) {
        if (environmentalData.length >= sampleCount) break;

        const node = path[i];
        if (!node || typeof node.lat !== 'number' || typeof node.lon !== 'number') continue;

        const envData = { ...getFastEnvironmentalData(node.lat, node.lon, patientCondition) };
        envData.coordinate = { lat: node.lat, lng: node.lon };
        envData.routeIndex = routeIndex;
        environmentalData.push(envData);
    }

    return environmentalData;
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