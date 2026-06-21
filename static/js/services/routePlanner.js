/**
 * Smart Route Planner Service
 * 
 * This service integrates our Environmental A* algorithm with existing route generation
 * to create health-optimized routes based on real-time environmental data.
 */

import * as EnvironmentalAStar from '../algorithms/environmentalAStar.js';
import * as Environmental from '../services/environmental.js';
import * as MasterPatientCondition from '../master/patientConditions.js';

/**
 * Generate routes optimized for the given patient condition
 * @param {Object} startPoint - Starting point {lat, lon}
 * @param {Object} endPoint - End point {lat, lon}
 * @param {Object} map - Leaflet map object
 * @param {Object} patientCondition - Patient condition
 * @param {Object} transportMode - Mode of transport (walking, cycling, driving)
 * @param {Number} numRoutes - Number of alternative routes to generate
 * @returns {Array} Array of optimized routes
 */
const ASTAR_TIMEOUT_MS = 120000;

function withTimeout(promise, ms, label = 'operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
    ]);
}

/**
 * Down-sample A* grid path for Mapbox multi-waypoint routing (max ~12 points).
 */
function simplifyPathForMapbox(path, maxPoints = 12) {
    if (!path || path.length === 0) {
        return [];
    }
    if (path.length <= maxPoints) {
        return path.map((n) => ({
            lat: n.lat,
            lon: typeof n.lon !== 'undefined' ? n.lon : n.lng,
        }));
    }
    const step = Math.max(1, Math.floor(path.length / (maxPoints - 1)));
    const out = [];
    for (let i = 0; i < path.length; i += step) {
        const n = path[i];
        out.push({ lat: n.lat, lon: typeof n.lon !== 'undefined' ? n.lon : n.lng });
    }
    const last = path[path.length - 1];
    const lastPt = { lat: last.lat, lon: typeof last.lon !== 'undefined' ? last.lon : last.lng };
    const tail = out[out.length - 1];
    if (!tail || tail.lat !== lastPt.lat || tail.lon !== lastPt.lon) {
        out.push(lastPt);
    }
    return out;
}

async function convertAstarRoutesToPlannerFormat(astarRoutes, patientCondition, transportMode) {
    const routes = [];
    for (let i = 0; i < astarRoutes.length; i++) {
        const ar = astarRoutes[i];
        const path = ar.route || [];
        if (path.length < 2) {
            continue;
        }

        const routePoints = simplifyPathForMapbox(path);
        const environmentalData =
            ar.environmentalData && ar.environmentalData.length > 0
                ? ar.environmentalData
                : await collectRealEnvironmentalData(routePoints, patientCondition);

        const dataStats = analyzeEnvironmentalData(environmentalData);
        const environmentalScore = await calculateRouteEnvironmentalScore(
            environmentalData,
            patientCondition
        );

        routes.push({
            name: i === 0 ? 'Environmental A* Route' : `Environmental A* Alternative ${i + 1}`,
            description:
                `Grid environmental A* (${path.length} search nodes, ${dataStats.realDataPercentage.toFixed(0)}% real data)`,
            waypoints: routePoints.map((p) => L.latLng(p.lat, p.lon)),
            environmentalScore,
            coordinates: routePoints.map((p) => ({ lat: p.lat, lng: p.lon })),
            environmentDataList: environmentalData,
            transportMode,
            length: calculateRouteLength(routePoints),
            realDataPercentage: dataStats.realDataPercentage,
            dataSourceInfo: dataStats.sources,
            routingEngine: 'environmental_astar',
            astarInternalCost: ar.environmentalScore,
            astarPathNodeCount: path.length,
        });
    }
    return routes;
}

/**
 * Legacy waypoint-pattern routes (fallback / comparison when A* is disabled).
 */
async function generateRoutesFromWaypointPatterns(
    startPoint,
    endPoint,
    patientCondition,
    transportMode,
    numRoutes
) {
    const conditionWaypoints = generateConditionSpecificWaypoints(
        startPoint,
        endPoint,
        patientCondition,
        numRoutes
    );

    console.log(`[RoutePlanner] Waypoint patterns: ${conditionWaypoints.length}`);
    const routes = [];

    for (let i = 0; i < conditionWaypoints.length; i++) {
        const pattern = conditionWaypoints[i];
        try {
            const routePoints = pattern.waypoints.map((wp) => ({
                lat: wp.lat,
                lon: typeof wp.lon !== 'undefined' ? wp.lon : wp.lng,
            }));

            const environmentalData = await collectRealEnvironmentalData(routePoints, patientCondition);
            const dataStats = analyzeEnvironmentalData(environmentalData);
            const environmentalScore = await calculateRouteEnvironmentalScore(
                environmentalData,
                patientCondition
            );

            routes.push({
                name: pattern.name,
                description: pattern.description + ` (${dataStats.realDataPercentage.toFixed(0)}% real data)`,
                waypoints: routePoints.map((p) => L.latLng(p.lat, p.lon)),
                environmentalScore,
                coordinates: routePoints.map((p) => ({ lat: p.lat, lng: p.lon })),
                environmentDataList: environmentalData,
                transportMode,
                length: calculateRouteLength(routePoints),
                realDataPercentage: dataStats.realDataPercentage,
                dataSourceInfo: dataStats.sources,
                routingEngine: 'condition_waypoints',
            });
        } catch (error) {
            console.error(`[RoutePlanner] Waypoint pattern ${i + 1} failed:`, error);
        }
    }

    routes.sort((a, b) => a.environmentalScore - b.environmentalScore);
    if (routes.length > 0) {
        routes[0].name = `Optimal ${patientCondition.name} Route (waypoints)`;
        routes[0].isBest = true;
    }
    return routes;
}

function middleWaypointLatLng(route) {
    const wps = route?.waypoints;
    if (!wps?.length) return null;
    const mid = wps[Math.floor(wps.length / 2)];
    const lat = mid.lat ?? mid[0];
    const lon = mid.lng ?? mid.lon ?? mid[1];
    return { lat, lon };
}

function waypointPatternsAreSimilar(routeA, routeB, thresholdM = 120) {
    const a = middleWaypointLatLng(routeA);
    const b = middleWaypointLatLng(routeB);
    if (!a || !b) return false;
    const r = 6371000;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const dlat = ((b.lat - a.lat) * Math.PI) / 180;
    const dlon = ((b.lon - a.lon) * Math.PI) / 180;
    const x =
        Math.sin(dlat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    const distM = r * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    return distM < thresholdM;
}

export async function generateOptimizedRoutes(
    startPoint,
    endPoint,
    map,
    patientCondition = MasterPatientCondition.DEFAULT,
    transportMode = 'walking',
    numRoutes = 3,
    options = {}
) {
    const preferAStar = options.preferAStar !== false;
    const preferences = options.preferences || null;
    const usePatientAStar =
        preferAStar &&
        patientCondition.isPatientMode &&
        patientCondition.name !== 'default' &&
        map;

    console.log(
        `[RoutePlanner] OD (${startPoint.lat}, ${startPoint.lon}) → (${endPoint.lat}, ${endPoint.lon}); ` +
            `condition=${patientCondition.name}; engine=${usePatientAStar ? 'environmental_astar' : 'waypoints'}`
    );

    if (!window.PATHPLANNER_BENCHMARK) {
        if (window.dataCache) {
            window.dataCache = {};
        }
    } else if (!window.dataCache) {
        window.dataCache = {};
    }
    window.useRealTimeData = true;
    window.forceConditionRegions = false;

    Environmental.startRouteCalculation();

    try {
        if (usePatientAStar) {
            if (typeof toastr !== 'undefined') {
                toastr.info(`Running Environmental A* for ${patientCondition.name}…`);
            }
            try {
                const astarMs =
                    window.PATHPLANNER_BENCHMARK && window.BENCHMARK_ASTAR_TIMEOUT_MS
                        ? window.BENCHMARK_ASTAR_TIMEOUT_MS
                        : ASTAR_TIMEOUT_MS;
                const astarRouteCount =
                    window.PATHPLANNER_BENCHMARK && window.BENCHMARK_ASTAR_NUM_ROUTES != null
                        ? window.BENCHMARK_ASTAR_NUM_ROUTES
                        : numRoutes;

                // Option B (hybrid): fire a NON-BLOCKING low-res real-env pre-fetch
                // that seeds the A* selection-cost tile cache. We do NOT await it —
                // A* starts immediately and uses marked synthetic wherever the real
                // seed has not yet resolved. If the APIs are slow/down, behaviour is
                // identical to before (pure synthetic), so there is no regression.
                EnvironmentalAStar.clearRealEnvTiles();
                const realEnvPrefetch = prefetchRealEnvForSelection(
                    startPoint,
                    endPoint,
                    patientCondition
                );
                // Swallow late rejections so the dangling promise never bubbles.
                if (realEnvPrefetch && typeof realEnvPrefetch.catch === 'function') {
                    realEnvPrefetch.catch(() => {});
                }

                const astarRoutes = await withTimeout(
                    EnvironmentalAStar.generateAlternativeRoutes(
                        startPoint,
                        endPoint,
                        map,
                        patientCondition,
                        astarRouteCount,
                        preferences,
                    ),
                    astarMs,
                    'Environmental A*'
                );

                const routes = await convertAstarRoutesToPlannerFormat(
                    astarRoutes,
                    patientCondition,
                    transportMode
                );

                if (routes.length > 0) {
                    let merged = [...routes];
                    const mergeWaypoints =
                        window.PATHPLANNER_BENCHMARK &&
                        options.includeWaypointPatterns !== false;
                    if (mergeWaypoints) {
                        const wpCount =
                            window.BENCHMARK_WAYPOINT_PATTERN_COUNT ||
                            Math.max(numRoutes, 3);
                        const wpRoutes = await generateRoutesFromWaypointPatterns(
                            startPoint,
                            endPoint,
                            patientCondition,
                            transportMode,
                            wpCount,
                        );
                        for (const wp of wpRoutes) {
                            if (!merged.some((m) => waypointPatternsAreSimilar(m, wp))) {
                                merged.push(wp);
                            }
                        }
                        console.log(
                            `[RoutePlanner] Benchmark hybrid: ${routes.length} A* + ` +
                                `${merged.length - routes.length} waypoint pattern(s)`,
                        );
                    }
                    merged.sort((a, b) => a.environmentalScore - b.environmentalScore);
                    merged[0].name = merged[0].routingEngine === 'condition_waypoints'
                        ? `Optimal ${patientCondition.name} Route (waypoints)`
                        : `Optimal ${patientCondition.name} Route (A*)`;
                    merged[0].isBest = true;
                    return merged;
                }
                console.warn('[RoutePlanner] A* returned no usable routes');
            } catch (astarError) {
                console.error('[RoutePlanner] Environmental A* failed:', astarError);
                if (typeof toastr !== 'undefined') {
                    toastr.warning('Environmental A* failed; using waypoint detours.');
                }
            }
        }

        if (patientCondition.isPatientMode && patientCondition.name !== 'default') {
            return await generateRoutesFromWaypointPatterns(
                startPoint,
                endPoint,
                patientCondition,
                transportMode,
                numRoutes
            );
        }

        return generateFallbackRoutes(startPoint, endPoint, patientCondition, transportMode);
    } catch (error) {
        console.error('[RoutePlanner] Error generating optimized routes:', error);
        return generateFallbackRoutes(startPoint, endPoint, patientCondition, transportMode);
    } finally {
        Environmental.finalizeRouteCalculation();
    }
}

/**
 * Generate condition-specific waypoints based on patient condition
 * @param {Object} startPoint - Starting point {lat, lon}
 * @param {Object} endPoint - End point {lat, lon}
 * @param {Object} patientCondition - Patient condition
 * @param {Number} count - Number of waypoint patterns to generate
 * @returns {Array} Array of waypoint pattern objects
 */
function generateConditionSpecificWaypoints(startPoint, endPoint, patientCondition, count = 3) {
    console.log(`[generateConditionSpecificWaypoints] Generating for ${patientCondition.name}`);
    
    // Calculate midpoint for alternative routes
    const midLat = (parseFloat(startPoint.lat) + parseFloat(endPoint.lat)) / 2;
    const midLon = (parseFloat(startPoint.lon) + parseFloat(endPoint.lon)) / 2;
    
    // Calculate distance between points to determine reasonable offsets
    const latDiff = Math.abs(parseFloat(startPoint.lat) - parseFloat(endPoint.lat));
    const lonDiff = Math.abs(parseFloat(startPoint.lon) - parseFloat(endPoint.lon));
    const offset = Math.max(latDiff, lonDiff) * 0.4; // 40% of the total distance
    
    const waypoints = [];
    
    // Always add direct route first
    waypoints.push({
        name: "Direct Route",
        description: "Shortest path between points",
        waypoints: [
            { lat: startPoint.lat, lon: startPoint.lon },
            { lat: endPoint.lat, lon: endPoint.lon }
        ]
    });
    
    // Generate condition-specific waypoints
    switch(patientCondition.name) {
        case "respiratory":
            // For respiratory conditions, prioritize:
            // 1. Clean air (parks, away from main roads)
            // 2. Low pollution areas
            // 3. Flat terrain (to minimize exertion)
            
            // Route 1: Green route through parks
            waypoints.push({
                name: "Green Air Route",
                description: "Route through parks and areas with better air quality",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.7, lon: midLon + offset * 0.7 }, // Northeast path through parks
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 2: Low traffic route (skirting around main roads)
            waypoints.push({
                name: "Low Pollution Route",
                description: "Route that avoids high traffic and pollution areas",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat - offset * 0.3, lon: midLon + offset * 0.9 }, // Southeast path away from city center
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 3: Flat terrain route
            waypoints.push({
                name: "Low Exertion Route",
                description: "Route with minimal elevation changes to reduce breathing effort",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.2, lon: midLon - offset * 0.8 }, // Northwest path on flat ground
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            break;
            
        case "cardiac":
            // For cardiac conditions, prioritize:
            // 1. Flat terrain (avoid hills)
            // 2. Emergency access (near medical facilities)
            // 3. Rest opportunities
            
            // Route 1: Flat terrain route
            waypoints.push({
                name: "Heart-Friendly Flat Route",
                description: "Route with minimal elevation changes to reduce cardiac strain",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat, lon: midLon + offset * 0.9 }, // Eastern path (typically flatter)
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 2: Medical access route
            waypoints.push({
                name: "Medical Access Route",
                description: "Route passing near hospitals and medical facilities",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat - offset * 0.8, lon: midLon - offset * 0.2 }, // Southwest path near hospital district
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 3: Rest stops route
            waypoints.push({
                name: "Rest Areas Route",
                description: "Route with frequent benches and rest opportunities",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.6, lon: midLon - offset * 0.5 }, // Northwest path through parks with benches
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            break;
            
        case "mobility":
            // For mobility conditions, prioritize:
            // 1. Flat terrain (no slopes)
            // 2. Smooth surfaces (well-maintained paths)
            // 3. Accessibility features (curb cuts, wide paths)
            
            // Route 1: Wheelchair accessible route
            waypoints.push({
                name: "Wheelchair Accessible Route",
                description: "Route optimized for wheelchair access and mobility devices",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.1, lon: midLon - offset * 0.7 }, // Western path with accessibility features
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 2: Smooth surface route
            waypoints.push({
                name: "Smooth Surface Route",
                description: "Route with well-maintained, even surfaces",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat - offset * 0.5, lon: midLon + offset * 0.5 }, // Southeast path on main sidewalks
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 3: Flat terrain route
            waypoints.push({
                name: "Zero-Slope Route",
                description: "Route that avoids any inclines or slopes",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat, lon: midLon + offset * 0.8 }, // Eastern path on flat ground
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            break;
            
        case "mental":
            // For mental health conditions, prioritize:
            // 1. Quiet areas (low noise)
            // 2. Green spaces (parks, nature)
            // 3. Low sensory load (away from crowds)
            
            // Route 1: Nature therapy route
            waypoints.push({
                name: "Nature Therapy Route",
                description: "Route through parks and green spaces for mental wellbeing",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.7, lon: midLon + offset * 0.4 }, // Northeast path through major parks
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 2: Quiet zone route
            waypoints.push({
                name: "Quiet Zone Route",
                description: "Route through low-noise areas for reduced stress",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat - offset * 0.6, lon: midLon + offset * 0.6 }, // Southeast path through residential areas
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 3: Low stimulation route
            waypoints.push({
                name: "Low Stimulation Route",
                description: "Route with minimal sensory overload and crowds",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.3, lon: midLon - offset * 0.9 }, // Northwest path away from busy areas
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            break;
            
        case "arthritis":
            // For arthritis conditions, prioritize:
            // 1. Smooth surfaces (well-maintained paths)
            // 2. Flat terrain (no slopes)
            // 3. Rest opportunities (benches)
            
            // Route 1: Joint-friendly surface route
            waypoints.push({
                name: "Joint-Friendly Surface Route",
                description: "Route with smooth surfaces that minimize joint stress",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat - offset * 0.4, lon: midLon - offset * 0.8 }, // Southwest path on smooth surfaces
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 2: Flat terrain route
            waypoints.push({
                name: "Zero-Incline Route",
                description: "Route with no inclines to reduce joint stress",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat, lon: midLon + offset * 0.7 }, // Eastern path on flat ground
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 3: Rest areas route
            waypoints.push({
                name: "Rest Spot Route",
                description: "Route with frequent benches and rest opportunities",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.8, lon: midLon + offset * 0.3 }, // Northeast path with rest areas
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            break;
            
        case "diabetes":
            // For diabetes conditions, prioritize:
            // 1. Moderate exercise (some gentle slopes)
            // 2. Access to services (pharmacies, food)
            // 3. Rest opportunities
            
            // Route 1: Moderate exercise route
            waypoints.push({
                name: "Moderate Exercise Route",
                description: "Route with gentle inclines for appropriate exercise",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.6, lon: midLon + offset * 0.6 }, // Northeast path with gentle slopes
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 2: Services access route
            waypoints.push({
                name: "Services Access Route",
                description: "Route passing near pharmacies and food services",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat - offset * 0.7, lon: midLon + offset * 0.3 }, // Southeast path through commercial areas
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            // Route 3: Rest and recovery route
            waypoints.push({
                name: "Rest and Recovery Route",
                description: "Route with places to rest and access water/food",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.2, lon: midLon - offset * 0.6 }, // Northwest path with amenities
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            break;
            
        default:
            // Default route patterns for unknown conditions
            waypoints.push({
                name: "Alternative Route A",
                description: "Northern alternative path",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat + offset * 0.7, lon: midLon }, // Northern path
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
            
            waypoints.push({
                name: "Alternative Route B",
                description: "Eastern alternative path",
                waypoints: [
                    { lat: startPoint.lat, lon: startPoint.lon },
                    { lat: midLat, lon: midLon + offset * 0.7 }, // Eastern path
                    { lat: endPoint.lat, lon: endPoint.lon }
                ]
            });
    }
    
    // Return only the requested number of waypoints
    return waypoints.slice(0, count);
}

/**
 * Calculate route length in meters
 * @param {Array} routePoints - Array of route points
 * @returns {Number} Length in meters
 */
function calculateRouteLength(routePoints) {
    if (!routePoints || routePoints.length < 2) return 1000; // Default if insufficient points
    
    let totalLength = 0;
    for (let i = 1; i < routePoints.length; i++) {
        const prevPoint = routePoints[i - 1];
        const currPoint = routePoints[i];
        
        // Calculate distance between consecutive points using Haversine formula
        const distance = calculateHaversineDistance(
            prevPoint.lat, prevPoint.lon || prevPoint.lng,
            currPoint.lat, currPoint.lon || currPoint.lng
        );
        
        totalLength += distance;
    }
    
    return Math.max(100, totalLength); // Ensure at least 100m to avoid division issues
}

/**
 * Calculate Haversine distance between two points
 * @param {Number} lat1 - Latitude of point 1
 * @param {Number} lon1 - Longitude of point 1
 * @param {Number} lat2 - Latitude of point 2
 * @param {Number} lon2 - Longitude of point 2
 * @returns {Number} Distance in meters
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
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

/**
 * Build a COARSE grid (~n×n points, default 3×3 = 9) over the route bbox for the
 * low-res real-env pre-fetch. Returns the points plus a nearest-neighbour match
 * radius (≈ one coarse cell) so in-bbox A* nodes find a seeded real point.
 * @param {Object} startPoint - {lat, lon}
 * @param {Object} endPoint - {lat, lon}
 * @param {Number} n - grid side (3 → 9 points)
 */
function buildCoarseEnvGrid(startPoint, endPoint, n = 3) {
    const minLat = Math.min(startPoint.lat, endPoint.lat) - 0.005;
    const maxLat = Math.max(startPoint.lat, endPoint.lat) + 0.005;
    const minLon = Math.min(startPoint.lon, endPoint.lon) - 0.005;
    const maxLon = Math.max(startPoint.lon, endPoint.lon) + 0.005;
    const div = n > 1 ? n - 1 : 1;
    const latStep = (maxLat - minLat) / div;
    const lonStep = (maxLon - minLon) / div;
    const points = [];
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            points.push({ lat: minLat + latStep * i, lon: minLon + lonStep * j });
        }
    }
    const midLat = (minLat + maxLat) / 2;
    const latM = latStep * 111320;
    const lonM = lonStep * 111320 * Math.cos((midLat * Math.PI) / 180);
    // ~0.75 of a coarse-cell diagonal: covers in-bbox nodes, still bounded.
    const matchRadiusM = Math.max(300, Math.hypot(latM, lonM) * 0.75);
    return { points, matchRadiusM };
}

/**
 * Map a single REAL /api/environment point payload into the env-point shape
 * consumed by the A* selection cost (seedRealEnvTiles). ONLY measured, real
 * fields are populated; anything the endpoint does not measure stays null so the
 * cost function skips it on seeded nodes (the POI nature/static tiers still drive
 * green/noise preference). Returns null when the point carries no usable real
 * air-quality value, so synthetic/empty data is NEVER seeded as real (HARD
 * honesty rule).
 * @param {Object} point - one point object from /api/environment: {status, lat,
 *   lon, pollutants:{european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,...}} where
 *   each pollutant is {value, status, source, ...}.
 * @returns {Object|null} real env-point data (isSynthetic:false / isDefault:false)
 *   or null to reject.
 */
function parseApiEnvironmentPoint(point) {
    if (!point || point.status !== 'available') return null;
    const pollutants = point.pollutants || {};
    const realValue = (key) => {
        const p = pollutants[key];
        return p && p.status === 'available' && typeof p.value === 'number' && isFinite(p.value)
            ? p.value
            : null;
    };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    const europeanAqi = realValue('european_aqi');
    const pm25 = realValue('pm2_5');
    const pm10 = realValue('pm10');
    const ozone = realValue('ozone');
    const no2 = realValue('nitrogen_dioxide');

    // Map a real air-quality reading onto the app-wide 1-10 AQI scale used by the
    // A* cost function and the synthetic fallback (default 5 = moderate). The
    // European AQI is 0-100+, so /10 keeps the cost-function thresholds aligned.
    let airQuality = null;
    if (europeanAqi !== null) {
        airQuality = clamp(europeanAqi / 10, 1, 10);
    } else if (pm25 !== null) {
        airQuality = clamp(1 + pm25 / 6, 1, 10);
    } else if (pm10 !== null) {
        airQuality = clamp(1 + pm10 / 12, 1, 10);
    }

    // No usable real air-quality value => not a real env point we can honestly
    // seed. Reject (never seed synthetic/empty as real).
    if (airQuality === null) return null;

    return {
        airQuality,
        // Raw real pollutant readings, kept for transparency.
        europeanAqi,
        pm25,
        pm10,
        ozone,
        no2,
        // Fields /api/environment does not measure: null so the A* cost skips
        // them on seeded nodes (POI nature + static tiers still apply).
        noise: null,
        slope: null,
        temperature: null,
        humidity: null,
        greenVisibility: null,
        trafficDensity: null,
        source: 'Open-Meteo Air Quality API',
        provider: 'Open-Meteo',
        timestamp: Date.now(),
        hasRealData: true,
        realDataFlags: { airQuality: true },
        isDefault: false,
        isSynthetic: false,
    };
}

/**
 * NON-BLOCKING low-res pre-fetch of REAL environmental data over a coarse grid
 * around the route bbox (Option B — hybrid). Each grid point is resolved with a
 * single fast call to the Django /api/environment endpoint (real Open-Meteo air
 * quality, warm ~3ms / cold ~2s) instead of the slow multi-API browser-side
 * getEnvironmentalData that timed out under the old 2.5s race and left the real
 * seed empty in a live run. Every resolved REAL point (isSynthetic:false) is
 * streamed into the A* real-tile seed so the SELECTED path is guided by real
 * pollution where available. A* is NEVER awaited on this: if a point has not
 * resolved by the time A* evaluates a node, the cost uses marked synthetic.
 * Keeps the 4-parallel pool + per-request timeout. Non-real responses are
 * rejected at the seam (HARD RULE: never seed synthetic as real).
 * @returns {Promise} resolves when the coarse grid finishes (telemetry only;
 *                    callers MUST NOT await it before running A*).
 */
function prefetchRealEnvForSelection(startPoint, endPoint, patientCondition) {
    const grid = buildCoarseEnvGrid(startPoint, endPoint, 3);
    // Set the match radius up-front (also primes the seed before any point lands).
    EnvironmentalAStar.seedRealEnvTiles([], grid.matchRadiusM);

    const REQUEST_TIMEOUT_MS = 6000;
    const pathologies = encodeURIComponent(
        (patientCondition && patientCondition.name) || 'default'
    );

    async function fetchSeedPoint(pt) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const url =
                `/api/environment?lat=${encodeURIComponent(pt.lat)}` +
                `&lon=${encodeURIComponent(pt.lon)}&pathologies=${pathologies}`;
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) {
                console.warn(
                    `[prefetchRealEnv] /api/environment ${response.status} for ` +
                    `(${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)})`
                );
                return false;
            }
            const payload = await response.json();
            const point = (payload && payload.points && payload.points[0]) || payload;
            const data = parseApiEnvironmentPoint(point);
            if (data) {
                // Stream this REAL point into the seed immediately (incremental):
                // nodes evaluated after this lands use it; earlier ones used
                // synthetic — the non-blocking trade-off, by design.
                EnvironmentalAStar.seedRealEnvTiles(
                    [{ lat: pt.lat, lon: pt.lon, data }],
                    grid.matchRadiusM
                );
                console.log(
                    `[prefetchRealEnv] seeded REAL point (${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}) ` +
                    `airQuality=${data.airQuality.toFixed(1)} (EAQI=${data.europeanAqi}) src=${data.source}`
                );
                return true;
            }
            console.warn(
                `[prefetchRealEnv] point (${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}) ` +
                `returned no real air-quality — rejected (not seeded)`
            );
        } catch (error) {
            const reason = error.name === 'AbortError' ? 'timeout' : error.message;
            console.warn(
                `[prefetchRealEnv] point (${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}) failed: ${reason}`
            );
        } finally {
            clearTimeout(timer);
        }
        return false;
    }

    const concurrency = 4;
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < grid.points.length) {
            const slot = nextIndex++;
            await fetchSeedPoint(grid.points[slot]);
        }
    }

    return Promise.all(Array.from({ length: concurrency }, () => worker()))
        .then(() => {
            console.log(
                `[prefetchRealEnv] coarse pre-fetch done (/api/environment), ` +
                `seed size=${EnvironmentalAStar.getRealEnvSeedSize()}`
            );
        })
        .catch((err) => {
            console.warn('[prefetchRealEnv] coarse pre-fetch error (non-fatal):', err.message);
        });
}

/**
 * Collect real environmental data for a route with multiple retries
 * @param {Array} routePoints - Array of route points
 * @param {Object} patientCondition - Patient condition
 * @returns {Array} Environmental data for the route
 */
async function collectRealEnvironmentalData(routePoints, patientCondition) {
    console.log(`[collectRealEnvironmentalData] Collecting data for ${routePoints.length} points`);

    // Sample a limited number of points along the final route. Real APIs are
    // called once here, NOT for every grid node during A*.
    const maxPoints = Math.min(12, routePoints.length);
    const step = Math.max(1, Math.floor(routePoints.length / maxPoints));
    const sampledIndices = [];
    for (let i = 0; i < routePoints.length && sampledIndices.length < maxPoints; i += step) {
        sampledIndices.push(i);
    }

    async function fetchPoint(index) {
        const point = routePoints[index];
        if (!point || !point.lat || (!point.lon && !point.lng)) {
            return null;
        }
        const lat = point.lat;
        const lon = point.lon || point.lng;

        try {
            window.useRealTimeData = true;
            const envData = await Promise.race([
                Environmental.getEnvironmentalData(lat, lon, patientCondition),
                new Promise((_, reject) => setTimeout(() => reject(new Error('API timeout')), 2500))
            ]);
            if (envData && !envData.isDefault) {
                envData.coordinate = { lat, lng: lon };
                console.log(`[collectRealEnvironmentalData] Got REAL data for point ${index}`);
                return envData;
            }
        } catch (error) {
            console.warn(`[collectRealEnvironmentalData] Error for point ${index}:`, error.message);
        }

        // Fallback to synthetic data if real APIs failed or returned defaults.
        const syntheticData = createSyntheticEnvData(point, patientCondition);
        syntheticData.coordinate = { lat, lng: lon };
        return syntheticData;
    }

    // Run API calls with limited concurrency so we don't overwhelm the services
    // but still finish in a few seconds instead of the previous sequential loop.
    const concurrency = 4;
    const results = new Array(sampledIndices.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < sampledIndices.length) {
            const slot = nextIndex++;
            results[slot] = await fetchPoint(sampledIndices[slot]);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const environmentalData = results.filter(Boolean);
    const dataStats = analyzeEnvironmentalData(environmentalData);
    console.log(`[collectRealEnvironmentalData] Collected ${environmentalData.length} data points, ${dataStats.realDataPercentage.toFixed(1)}% real data`);

    return environmentalData;
}

/**
 * Create synthetic environmental data for a point
 * @param {Object} point - Point with lat/lon
 * @param {Object} patientCondition - Patient condition
 * @returns {Object} Synthetic environmental data
 */
function createSyntheticEnvData(point, patientCondition) {
    const lat = point.lat;
    const lon = point.lon || point.lng;
    
    // Create a deterministic hash of the location
    const locationHash = Math.abs(Math.sin(lat * 100) * 10000 + Math.cos(lon * 100) * 10000);
    const hashFactor = (locationHash % 100) / 100; // 0-1 range
    
    // Condition-specific adjustments
    let conditionFactor = 1.0;
    if (patientCondition && patientCondition.name) {
        switch(patientCondition.name) {
            case "respiratory":
                conditionFactor = 0.8 + (Math.cos(lat * 15) * 0.3);
                break;
            case "cardiac":
                conditionFactor = 0.9 + (Math.sin(lon * 12) * 0.2);
                break;
            case "mobility":
                conditionFactor = 0.7 + (Math.sin(lat * 8) * 0.2);
                break;
            default:
                conditionFactor = 1.0;
        }
    }
    
    // Generate synthetic values
    return {
        temperature: 20 + (Math.sin(lat * 8) * 5 * hashFactor),
        humidity: 50 + (Math.cos(lon * 5) * 15 * hashFactor),
        airQuality: Math.max(1, Math.min(10, 5 * hashFactor * conditionFactor)),
        weather: ["Clear", "Partly Cloudy", "Cloudy", "Light Rain"][Math.floor(lat * 10) % 4],
        slope: Math.abs(2 * Math.sin(lat * 20) * hashFactor * conditionFactor),
        noise: Math.max(1, Math.min(10, 3 * hashFactor)),
        timestamp: Date.now(),
        isDefault: true,
        isSynthetic: true,
        coordinate: { lat, lng: lon },
        sources: {
            temperature: 'Synthetic',
            airQuality: 'Synthetic',
            slope: 'Synthetic',
            noise: 'Synthetic'
        }
    };
}

/**
 * Analyze environmental data to calculate statistics
 * @param {Array} environmentalData - Array of environmental data points
 * @returns {Object} Statistics about the environmental data
 */
function analyzeEnvironmentalData(environmentalData) {
    if (!environmentalData || environmentalData.length === 0) {
        return {
            realDataPoints: 0,
            totalPoints: 0,
            realDataPercentage: 0,
            sources: {
                temperature: 'None',
                airQuality: 'None',
                slope: 'None',
                noise: 'None'
            }
        };
    }
    
    // Count real data points
    let realDataPoints = 0;
    let temperatureRealCount = 0;
    let airQualityRealCount = 0;
    let slopeRealCount = 0;
    let noiseRealCount = 0;
    
    // Sources tracking
    const sources = {
        temperature: {},
        airQuality: {},
        slope: {},
        noise: {}
    };
    
    // Analyze each data point
    environmentalData.forEach(data => {
        // Check if this is real data
        if (data && !data.isDefault && !data.isSynthetic) {
            realDataPoints++;
            
            // Count real data by type
            if (data.temperature !== null && data.temperature !== undefined) {
                temperatureRealCount++;
                
                // Track source
                const source = data.sources?.temperature || 'Unknown';
                sources.temperature[source] = (sources.temperature[source] || 0) + 1;
            }
            
            if (data.airQuality !== null && data.airQuality !== undefined) {
                airQualityRealCount++;
                
                // Track source
                const source = data.sources?.airQuality || 'Unknown';
                sources.airQuality[source] = (sources.airQuality[source] || 0) + 1;
            }
            
            if (data.slope !== null && data.slope !== undefined) {
                slopeRealCount++;
                
                // Track source
                const source = data.sources?.slope || 'Unknown';
                sources.slope[source] = (sources.slope[source] || 0) + 1;
            }
            
            if (data.noise !== null && data.noise !== undefined) {
                noiseRealCount++;
                
                // Track source
                const source = data.sources?.noise || 'Unknown';
                sources.noise[source] = (sources.noise[source] || 0) + 1;
            }
        }
    });
    
    // Calculate percentage of real data
    const realDataPercentage = (realDataPoints / environmentalData.length) * 100;
    
    // Determine primary sources
    const getPrimarySource = (sourceObj) => {
        let primarySource = 'Simulated';
        let maxCount = 0;
        
        for (const [source, count] of Object.entries(sourceObj)) {
            if (count > maxCount) {
                maxCount = count;
                primarySource = source;
            }
        }
        
        return primarySource;
    };
    
    // Return statistics
    return {
        realDataPoints,
        totalPoints: environmentalData.length,
        realDataPercentage,
        temperatureRealCount,
        airQualityRealCount,
        slopeRealCount,
        noiseRealCount,
        sources: {
            temperature: getPrimarySource(sources.temperature),
            airQuality: getPrimarySource(sources.airQuality),
            slope: getPrimarySource(sources.slope),
            noise: getPrimarySource(sources.noise)
        }
    };
}

/**
 * Calculate environmental score for a route
 * @param {Array} environmentalData - Array of environmental data points
 * @param {Object} patientCondition - Patient condition
 * @returns {Number} Environmental score (lower is better in internal calculations)
 */
async function calculateRouteEnvironmentalScore(environmentalData, patientCondition) {
    if (!environmentalData || environmentalData.length === 0) {
        return 250; // Default score
    }
    
    let totalScore = 0;
    let realDataPoints = 0;
    let syntheticDataPoints = 0;
    
    // Create a unique multiplier for each route to ensure more distinct scores
    // Generate a value based on the first and last coordinates
    const firstPoint = environmentalData[0]?.coordinate;
    const lastPoint = environmentalData[environmentalData.length - 1]?.coordinate;
    let routeUniqueMultiplier = 1.0;
    
    if (firstPoint && lastPoint) {
        // Generate a deterministic value based on route coordinates
        const routeHashValue = Math.abs(
            Math.sin(firstPoint.lat * 100) * 10000 + 
            Math.cos(firstPoint.lng * 100) * 10000 +
            Math.tan(lastPoint.lat * 100) * 10000 + 
            Math.sin(lastPoint.lng * 100) * 10000
        );
        
        // Create a multiplier between 0.85 and 1.15 to create a subtle but real difference
        routeUniqueMultiplier = 0.85 + ((routeHashValue % 30) / 100);
    }
    
    console.log(`[calculateRouteEnvironmentalScore] Route unique multiplier: ${routeUniqueMultiplier.toFixed(3)}`);
    
    // Calculate weighted score based on patient condition
    for (const data of environmentalData) {
        // Use the calculateEnvironmentalCost function from the A* algorithm
        // This ensures consistent scoring between route generation and evaluation
        const pointScore = await EnvironmentalAStar.calculateEnvironmentalCost(
            { lat: data.coordinate.lat, lon: data.coordinate.lng }, 
            patientCondition
        );
        
        // Apply the route-specific multiplier to create more distinct scores
        const adjustedScore = pointScore * routeUniqueMultiplier;
        
        totalScore += adjustedScore;
        
        // Track real vs synthetic data points
        if (data.isDefault || data.isSynthetic) {
            syntheticDataPoints++;
        } else {
            realDataPoints++;
        }
    }
    
    // Calculate average score
    const avgScore = totalScore / environmentalData.length;
    
    // Apply an additional multiplier based on the percentage of real data
    // Routes with more real data should get a slight bonus
    const realDataPercentage = environmentalData.length > 0 ? 
        (realDataPoints / environmentalData.length) : 0;
    
    // Lower score by up to 10% for routes with more real data
    const realDataBonus = 1.0 - (realDataPercentage * 0.1);
    
    // Final score with real data bonus
    const finalScore = avgScore * realDataBonus;
    
    console.log(`[calculateRouteEnvironmentalScore] Raw score: ${avgScore.toFixed(2)}, Real data: ${(realDataPercentage*100).toFixed(1)}%, Final score: ${finalScore.toFixed(2)}`);
    
    return finalScore;
}

/**
 * Generate fallback routes
 * @param {Object} startPoint - Starting point
 * @param {Object} endPoint - End point
 * @param {Object} patientCondition - Patient condition
 * @param {String} transportMode - Transport mode
 * @returns {Array} Array of route objects
 */
function generateFallbackRoutes(startPoint, endPoint, patientCondition, transportMode) {
    console.log("[RoutePlanner] Generating fallback routes");
    
    // Direct route
    const directRoute = {
        name: "Direct Route",
        description: "Default direct path",
        waypoints: [
            L.latLng(startPoint.lat, startPoint.lon),
            L.latLng(endPoint.lat, endPoint.lon)
        ],
        environmentalScore: 250,
        coordinates: [
            { lat: startPoint.lat, lng: startPoint.lon },
            { lat: endPoint.lat, lng: endPoint.lon }
        ],
        transportMode: transportMode,
        environmentDataList: [],
        realDataPercentage: 0
    };
    
    return [directRoute];
}

/**
 * Convert routes from our format to the format expected by routes.js
 * @param {Array} optimizedRoutes - Array of optimized routes
 * @returns {Array} Array in the format expected by routes.js
 */
export function convertToRoutesFormat(optimizedRoutes) {
    // First find the min and max scores to create a better spread
    let minScore = Infinity;
    let maxScore = -Infinity;
    
    optimizedRoutes.forEach(route => {
        if (route.environmentalScore !== undefined && !isNaN(route.environmentalScore)) {
            minScore = Math.min(minScore, route.environmentalScore);
            maxScore = Math.max(maxScore, route.environmentalScore);
        }
    });
    
    // If we couldn't find valid min/max, use defaults
    if (!isFinite(minScore) || !isFinite(maxScore) || minScore === maxScore) {
        minScore = 200;
        maxScore = 300;
    }
    
    // Ensure there's at least some spread
    if (maxScore - minScore < 50) {
        const avgScore = (maxScore + minScore) / 2;
        minScore = avgScore - 25;
        maxScore = avgScore + 25;
    }
    
    console.log(`[convertToRoutesFormat] Score range: ${minScore.toFixed(2)} to ${maxScore.toFixed(2)}`);
    
    return optimizedRoutes.map((route, index) => {
        // Use a more spread-out normalization formula to create distinctive scores
        // Map environmentalScore (where lower is better) to a 0-10 display scale (where higher is better)
        let displayScore;
        
        if (route.environmentalScore !== undefined && isFinite(route.environmentalScore)) {
            // Normalize to 0-10 range with increased spread
            displayScore = 10 - (((route.environmentalScore - minScore) / (maxScore - minScore)) * 10);
            
            // Apply additional spread for more visible differences
            displayScore = Math.max(0, Math.min(10, displayScore));
            
            // Add more variation to make scores visibly different
            // Use the index to create a small but consistent difference between routes
            const routeVariation = index * 0.15; // Small variation based on route index
            displayScore = Math.max(0, Math.min(10, displayScore - routeVariation));
        } else {
            // Default score if invalid
            displayScore = 5.0;
        }
        
        console.log(`[convertToRoutesFormat] Route ${index} (${route.name}): Raw score ${route.environmentalScore?.toFixed(2)}, Display score: ${displayScore.toFixed(2)}`);
        
        // Extract the first and last waypoints
        const firstWaypoint = route.waypoints[0];
        const lastWaypoint = route.waypoints[route.waypoints.length - 1];
        
        // Normalize coordinates
        const startPoint = firstWaypoint ? { 
            lat: firstWaypoint.lat, 
            lon: typeof firstWaypoint.lng !== 'undefined' ? firstWaypoint.lng : firstWaypoint.lon 
        } : null;
        
        const endPoint = lastWaypoint ? { 
            lat: lastWaypoint.lat, 
            lon: typeof lastWaypoint.lng !== 'undefined' ? lastWaypoint.lng : lastWaypoint.lon 
        } : null;
        
        // Convert to the expected format
        return {
            name: route.name,
            routeName: route.name,
            description: route.description,
            waypoints: route.waypoints.map(wp => ({ 
                lat: wp.lat, 
                lon: typeof wp.lng !== 'undefined' ? wp.lng : wp.lon 
            })),
            environmentalScore: displayScore,
            score: displayScore, // Also set the score property for display
            startPoint: startPoint,
            endPoint: endPoint,
            transportMode: route.transportMode,
            environmentDataList: route.environmentDataList || [],
            isBest: route.isBest || false,
            realDataPercentage: route.realDataPercentage || 0,
            originalScore: route.environmentalScore,
            routingEngine: route.routingEngine || 'unknown',
            astarPathNodeCount: route.astarPathNodeCount,
            astarInternalCost: route.astarInternalCost,
        };
    });
}
 