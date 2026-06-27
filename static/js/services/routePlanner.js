/**
 * Smart Route Planner Service
 * 
 * This service orchestrates backend Environmental A* routes and direct fallback
 * routes for the map UI.
 */

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

function toLatLon(n) {
    return { lat: n.lat, lon: typeof n.lon !== 'undefined' ? n.lon : n.lng };
}

function buildMapboxWaypointSignature(routePoints, precision = 4) {
    return (Array.isArray(routePoints) ? routePoints : [])
        .map((point) => toLatLon(point))
        .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lon))
        .map((point) => `${point.lat.toFixed(precision)},${point.lon.toFixed(precision)}`)
        .join('|');
}

function appendPreferenceParams(params, preferences) {
    if (!preferences) return;
    ['nature', 'entertainment', 'nightlife', 'tourism', 'hospital'].forEach((key) => {
        if (preferences[key] !== undefined && preferences[key] !== null) {
            params.set(key, preferences[key]);
        }
    });
}

async function fetchBackendAstarRoutes(
    startPoint,
    endPoint,
    patientCondition,
    transportMode,
    numRoutes,
    preferences,
    distanceTolerance,
) {
    const params = new URLSearchParams({
        start: `${startPoint.lat},${startPoint.lon}`,
        end: `${endPoint.lat},${endPoint.lon}`,
        condition: patientCondition?.name || 'respiratory',
        transport_mode: transportMode || 'walking',
        distance_tolerance: distanceTolerance || 1,
        alternatives: numRoutes || 3,
    });
    appendPreferenceParams(params, preferences);

    const response = await fetch(`/api/backend_astar/?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || `backend A* failed (${response.status})`);
    }
    if (!payload || !Array.isArray(payload.routes)) {
        throw new Error('backend A* returned an invalid payload');
    }
    return payload;
}

function convertBackendAstarRoutesToPlannerFormat(payload, patientCondition, transportMode) {
    const routes = [];
    const acceptedWaypointSignatures = new Set();
    const backendRoutes = Array.isArray(payload?.routes) ? payload.routes : [];

    backendRoutes.forEach((route, index) => {
        const routePoints = (Array.isArray(route.waypoints) && route.waypoints.length >= 2)
            ? route.waypoints
            : route.path;
        if (!Array.isArray(routePoints) || routePoints.length < 2) {
            return;
        }

        const waypointSignature = buildMapboxWaypointSignature(routePoints);
        if (waypointSignature && acceptedWaypointSignatures.has(waypointSignature)) {
            console.info(`[RoutePlanner] Skipping duplicate backend A* route before render (${waypointSignature}).`);
            return;
        }
        if (waypointSignature) {
            acceptedWaypointSignatures.add(waypointSignature);
        }

        const pathLength = calculateRouteLength(route.path || routePoints);
        routes.push({
            name: index === 0
                ? `Backend Environmental A* Route`
                : `Backend Environmental A* Alternative ${index + 1}`,
            description:
                `Backend OSM street-graph A* ` +
                `(${route.path_node_count || routePoints.length} nodes, ${payload.timing_ms || '?'} ms)`,
            waypoints: routePoints.map((p) => L.latLng(p.lat, p.lon)),
            environmentalScore: Number.isFinite(route.astar_cost) ? route.astar_cost : index,
            coordinates: routePoints.map((p) => ({ lat: p.lat, lng: p.lon })),
            environmentDataList: [],
            transportMode: route.transport_mode || transportMode,
            length: pathLength,
            realDataPercentage: 100,
            dataSourceInfo: route.data_sources || {},
            routingEngine: 'backend_environmental_astar',
            astarRoutingBasis: route.routing_basis || 'street_graph',
            astarInternalCost: route.astar_cost,
            astarPathNodeCount: route.path_node_count,
            backendEnvScore: route.env_score,
            backendExplanation: route.explanation || null,
            backendTimingMs: payload.timing_ms,
            backendParallelism: payload.parallelism,
            astarAlternativeSignature: route.signature || `backend-astar-${index}`,
        });
    });

    return routes;
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
    const preferences = options.preferences || null;
    // Distance-tolerance slider (#percentageSlider, 1..10; 1 = baseline). Threaded
    // into backend A* so higher tolerance = longer, greener detours.
    const distanceTolerance = options.percentageSlider != null ? options.percentageSlider : 1;
    const usePatientAStar =
        patientCondition.isPatientMode &&
        patientCondition.name !== 'default' &&
        map;

    console.log(
        `[RoutePlanner] OD (${startPoint.lat}, ${startPoint.lon}) → (${endPoint.lat}, ${endPoint.lon}); ` +
            `condition=${patientCondition.name}; engine=${usePatientAStar ? 'backend_environmental_astar' : 'direct'}`
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

                const backendPayload = await withTimeout(
                    fetchBackendAstarRoutes(
                        startPoint,
                        endPoint,
                        patientCondition,
                        transportMode,
                        astarRouteCount,
                        preferences,
                        distanceTolerance,
                    ),
                    astarMs,
                    'Backend Environmental A*'
                );
                const routes = convertBackendAstarRoutesToPlannerFormat(
                    backendPayload,
                    patientCondition,
                    transportMode
                );

                if (routes.length > 0) {
                    let merged = [...routes];
                    merged.sort((a, b) => a.environmentalScore - b.environmentalScore);
                    merged[0].name = `Optimal ${patientCondition.name} Route (backend A*)`;
                    merged[0].isBest = true;
                    console.info(`[RoutePlanner] Backend A* produced ${merged.length} route(s).`);
                    return merged;
                }
                console.warn('[RoutePlanner] Backend A* returned no usable routes');
            } catch (astarError) {
                console.error('[RoutePlanner] Backend Environmental A* failed:', astarError);
                if (typeof toastr !== 'undefined') {
                    toastr.warning('Backend Environmental A* failed; using direct route.');
                }
            }
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
 * Calculate route length in meters
 * @param {Array} routePoints - Array of route points
 * @returns {Number} Length in meters
 */
function calculateRouteLength(routePoints) {
    // TODO2: with <2 points there is no geometry to measure. Return 0 (an honest
    // "unknown") instead of a fabricated 1000 m so the card-render fallback can use
    // the real Mapbox summary / coordinate length rather than printing a fake 1 km.
    if (!routePoints || routePoints.length < 2) return 0;

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
            // TODO2: carry the computed A→B length so the route card shows the real
            // distance instead of the hardcoded 1 km fallback downstream. Without
            // this the value was silently dropped here and routes.js fell back to a
            // default until (and only if) Mapbox geometry finalized.
            length: Number.isFinite(route.length) && route.length > 0 ? route.length : undefined,
            realDataPercentage: route.realDataPercentage || 0,
            originalScore: route.environmentalScore,
            routingEngine: route.routingEngine || 'unknown',
            astarPathNodeCount: route.astarPathNodeCount,
            astarInternalCost: route.astarInternalCost,
            // #4: carry the distinct-alternative marker into the routes.js layer.
            astarAlternativeSignature: route.astarAlternativeSignature,
        };
    });
}
 
