/**
 * Headless benchmark runner — real PathPlanner stack (Mapbox + routePlanner.js + scores.js).
 */

import * as RoutePlanner from '../services/routePlanner.js';
import { Values as PatientConditionValues } from '../enums/patientCondition.js';
import * as Preferences from '../master/preferences.js';
import * as Environmental from '../services/environmental.js';
import * as PointOfInterests from '../services/pointOfInterest.js';
import * as Scores from '../master/scores.js';
import {
    selectBestWithinDetourPolicy,
    detourMetres,
    isMeaningfulImprovement,
    MAX_DETOUR_M,
    BETTER_SCORE_ENV_TOLERANCE_M,
} from './detourLimits.js';

const MAPBOX_TOKEN = globalThis.window?.MAPBOX_ACCESS_TOKEN || '';

let activeControls = [];
let sharedMapboxRouter = null;
const scoreCacheByOd = new Map();

function benchLog(msg) {
    console.log(`[benchmarkRunner] ${msg}`);
}

function subsampleCoordinates(coordinates, maxPoints = 16) {
    if (!coordinates?.length) return [];
    if (coordinates.length <= maxPoints) return coordinates;
    const step = Math.max(1, Math.floor(coordinates.length / maxPoints));
    const out = [];
    for (let i = 0; i < coordinates.length; i += step) {
        out.push(coordinates[i]);
    }
    const last = coordinates[coordinates.length - 1];
    const tail = out[out.length - 1];
    if (tail?.lat !== last?.lat || tail?.lng !== last?.lng) {
        out.push(last);
    }
    return out;
}

function haversineM(a, b) {
    const r = 6371000;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const dlat = ((b.lat - a.lat) * Math.PI) / 180;
    const dlon = ((b.lon - b.lon) * Math.PI) / 180;
    const x =
        Math.sin(dlat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return r * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function waypointPathLengthM(waypoints) {
    let d = 0;
    for (let i = 1; i < waypoints.length; i++) {
        d += haversineM(waypoints[i - 1], waypoints[i]);
    }
    return d;
}

function getMapboxRouter(profile = 'walking') {
    if (!sharedMapboxRouter) {
        sharedMapboxRouter = L.Routing.mapbox(MAPBOX_TOKEN, {
            profile: `mapbox/${profile}`,
            geometries: 'geojson',
            steps: false,
            alternatives: false,
        });
    }
    return sharedMapboxRouter;
}

async function mapWithConcurrency(items, limit, fn) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => worker()),
    );
    return results;
}

function routeScoreCacheKey(coordinates, label = '') {
    const pts = subsampleCoordinates(coordinates, 8)
        .map((c) => `${c.lat.toFixed(4)},${(c.lng ?? c.lon).toFixed(4)}`)
        .join('|');
    return `${label}|${pts}`;
}

function removeActiveControls() {
    const map = window.map;
    if (!map) return;
    activeControls.forEach((ctrl) => {
        try {
            map.removeControl(ctrl);
        } catch (e) {
            /* ignore */
        }
    });
    activeControls = [];
}

function mapboxRoute(waypoints, routeName, timeoutMs) {
    const limit = timeoutMs || window.BENCHMARK_MAPBOX_TIMEOUT_MS || 120000;
    return new Promise((resolve, reject) => {
        const map = window.map;
        if (!map) {
            reject(new Error('window.map not ready'));
            return;
        }

        const latLngs = waypoints.map((w) => {
            const lat = w.lat ?? w[0];
            const lon = w.lon ?? w.lng ?? w[1];
            return L.latLng(lat, lon);
        });

        const timer = setTimeout(() => {
            reject(new Error(`Mapbox routing timeout (${routeName})`));
        }, limit);

        const control = L.Routing.control({
            waypoints: latLngs,
            router: getMapboxRouter('walking'),
            routeWhileDragging: false,
            addWaypoints: false,
            createMarker: () => null,
            show: false,
            fitSelectedRoutes: false,
        });

        control.on('routesfound', (e) => {
            clearTimeout(timer);
            const route = e.routes && e.routes[0];
            if (!route || !route.summary) {
                reject(new Error(`Mapbox returned no route (${routeName})`));
                return;
            }
            resolve({
                routeName,
                distance_m: Math.round(route.summary.totalDistance),
                duration_s: Math.round(route.summary.totalTime),
                coordinates: (route.coordinates || []).map((c) => ({
                    lat: c.lat,
                    lng: c.lng,
                })),
            });
        });

        control.on('routingerror', (e) => {
            clearTimeout(timer);
            reject(new Error(`Mapbox error (${routeName}): ${JSON.stringify(e)}`));
        });

        control.addTo(map);
        activeControls.push(control);
        control.route();
    });
}

function mapEnvironmentalDataToCoordinates(environmentDataList, coordinates) {
    if (!environmentDataList?.length || !coordinates?.length) return [];
    return environmentDataList.map((env, index) => {
        const coordinate =
            index < coordinates.length ? coordinates[index] : coordinates[coordinates.length - 1];
        return {
            lat: coordinate?.lat || 0,
            lon: coordinate?.lng || coordinate?.lon || 0,
            environmentData: env,
        };
    });
}

function minimalPoiData() {
    return {
        natureCount: 3,
        entertainmentCount: 2,
        nightlifeCount: 1,
        tourismCount: 2,
        hospitalCount: 1,
        restingAreaCount: 3,
        parkBenchCount: 5,
        flatPathwayCount: 4,
        wheelchairAccessCount: 2,
        quietAreaCount: 2,
    };
}

function resolveNumericScore(value, fallback = null) {
    if (typeof value === 'number' && !Number.isNaN(value)) return value;
    if (typeof value === 'string' && value !== 'N/A') {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return fallback;
}

function toRouteGeometry(coordinates) {
    return {
        coordinates: coordinates.map((c) => ({
            lat: c.lat,
            lng: c.lng ?? c.lon,
        })),
    };
}

async function scoreRoutedPath(coordinates, patientCondition, preferences, cacheLabel = '') {
    const cacheKey = routeScoreCacheKey(coordinates, cacheLabel);
    if (scoreCacheByOd.has(cacheKey)) {
        return scoreCacheByOd.get(cacheKey);
    }

    const sampled = subsampleCoordinates(
        coordinates,
        window.BENCHMARK_MAX_ENV_SAMPLES || 8,
    );
    const routeGeometry = toRouteGeometry(sampled);
    const maxRetries = window.BENCHMARK_FAST ? 1 : 3;
    let environmentDataList = [];

    window.useRealTimeData = true;
    window.REAL_DATA_ONLY = false;

    for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
        try {
            environmentDataList = await Environmental.getRouteEnvironmentalData(
                routeGeometry,
                patientCondition,
                false,
            );
            if (environmentDataList?.length >= 4) break;
        } catch (err) {
            console.warn('[benchmarkRunner] env fetch', err);
        }
        if (retryCount < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    let poiCounts = minimalPoiData();
    if (!window.BENCHMARK_SKIP_POI) {
        try {
            poiCounts = await PointOfInterests.getRoutePOIs(routeGeometry);
        } catch (err) {
            console.warn('[benchmarkRunner] POI fetch failed, using minimal', err);
        }
    }

    const mappedEnv = mapEnvironmentalDataToCoordinates(environmentDataList, sampled);
    const scoreData = await Scores.calculateAllScores(
        poiCounts,
        mappedEnv,
        preferences,
        patientCondition,
    );

    let environmentScore = resolveNumericScore(scoreData.environmentScore);
    let totalScore = resolveNumericScore(scoreData.score);

    let scoringNote = 'browser_mapbox_js_scores';
    if (environmentScore === null) {
        environmentScore = 5.0;
        scoringNote = 'browser_fallback_default';
    }
    if (totalScore === null) {
        totalScore = environmentScore;
    }

    const result = {
        environmentScore,
        totalScore,
        poiScore: resolveNumericScore(scoreData.poiScore, 0),
        realDataPercentage: resolveNumericScore(scoreData.realDataPercentage, 0),
        scoring_method: scoringNote,
        env_samples: environmentDataList.length,
    };
    scoreCacheByOd.set(cacheKey, result);
    return result;
}

function patientConditionFor(key) {
    return { ...(PatientConditionValues[key] || PatientConditionValues.respiratory) };
}

function normalizePoint(p) {
    return { lat: p.lat ?? p[0], lon: p.lon ?? p.lng ?? p[1] };
}

function isDirectPattern(name) {
    return /direct/i.test(name || '');
}

function isConditionWaypointPattern(pattern) {
    return (
        pattern?.routingEngine === 'condition_waypoints' ||
        /Green Air|Low Pollution|Low Exertion|Nature Therapy|Clean Air/i.test(
            pattern?.name || '',
        )
    );
}

function pickPatternsToRoute(patterns, baselineDistanceM) {
    const maxRoute = window.BENCHMARK_MAX_PATTERNS_TO_ROUTE || 2;
    const softCap = MAX_DETOUR_M + BETTER_SCORE_ENV_TOLERANCE_M;

    const filtered = (patterns || []).filter((p) => {
        if (!p?.waypoints || p.waypoints.length < 2) return false;
        if (isDirectPattern(p.name)) return false;
        const wps = p.waypoints.map((wp) => ({
            lat: wp.lat,
            lon: typeof wp.lng !== 'undefined' ? wp.lng : wp.lon,
        }));
        const est = waypointPathLengthM(wps);
        return est <= baselineDistanceM + softCap * 1.35;
    });

    filtered.sort((a, b) => {
        const aWp = isConditionWaypointPattern(a) ? 0 : 1;
        const bWp = isConditionWaypointPattern(b) ? 0 : 1;
        if (aWp !== bWp) return aWp - bWp;
        return (a.environmentalScore ?? 999) - (b.environmentalScore ?? 999);
    });

    return filtered.slice(0, maxRoute);
}

export async function runOdPair({
    startLat,
    startLon,
    endLat,
    endLon,
    condition = 'respiratory',
}) {
    const t0 = Date.now();
    const map = window.map;
    if (!map) throw new Error('Map not initialized');

    const start = normalizePoint({ lat: startLat, lon: startLon });
    const end = normalizePoint({ lat: endLat, lon: endLon });
    const patientCondition = patientConditionFor(condition);
    const preferences = window.currentPreferences || { ...Preferences.DEFAULT };

    window.currentPatientCondition = patientCondition;
    if (!window.dataCache) {
        window.dataCache = {};
    }
    scoreCacheByOd.clear();
    removeActiveControls();

    map.setView([(start.lat + end.lat) / 2, (start.lon + end.lon) / 2], 13);

    benchLog('Mapbox direct…');
    let standardRoute;
    try {
        standardRoute = await mapboxRoute([start, end], 'Direct Route');
    } catch (mapErr) {
        removeActiveControls();
        throw new Error('Mapbox direct failed: ' + mapErr.message);
    }
    benchLog(`direct ${standardRoute.distance_m}m (${Date.now() - t0}ms)`);

    const standardScores = await scoreRoutedPath(
        standardRoute.coordinates,
        patientCondition,
        preferences,
        'direct',
    );
    benchLog(`direct scored env=${standardScores.environmentScore} (${Date.now() - t0}ms)`);

    const baselineDistanceM = standardRoute.distance_m;
    const directMinM = window.BENCHMARK_DIRECT_MIN_M || 0;
    const directMaxM = window.BENCHMARK_DIRECT_MAX_M || Infinity;
    if (
        window.BENCHMARK_PEDESTRIAN_MODE &&
        directMinM > 0 &&
        (baselineDistanceM < directMinM || baselineDistanceM > directMaxM)
    ) {
        benchLog(
            `skip: direct ${baselineDistanceM}m outside pedestrian band ${directMinM}-${directMaxM}m`,
        );
        removeActiveControls();
        return {
            engine: 'browser_ui',
            condition,
            skipped: true,
            skip_reason: 'direct_outside_pedestrian_band',
            standard: {
                route_name: standardRoute.routeName,
                distance_m: baselineDistanceM,
                duration_s: standardRoute.duration_s,
                env_score: standardScores.environmentScore,
                scoring_method: standardScores.scoring_method,
            },
            pedestrian_band_m: { min: directMinM, max: directMaxM },
            elapsed_ms: Date.now() - t0,
        };
    }

    const isShortDirect =
        window.BENCHMARK_PEDESTRIAN_MODE &&
        baselineDistanceM >= directMinM &&
        baselineDistanceM <= directMaxM;
    if (isShortDirect) {
        window.BENCHMARK_MAX_PATTERNS_TO_ROUTE = Math.max(
            window.BENCHMARK_MAX_PATTERNS_TO_ROUTE || 2,
            3,
        );
        window.BENCHMARK_ASTAR_GRID_M = 100;
        benchLog(
            `pedestrian short direct ${baselineDistanceM}m — extra patterns + 100m A* grid`,
        );
    }

    benchLog('generateOptimizedRoutes…');
    const astarNumRoutes = window.BENCHMARK_ASTAR_NUM_ROUTES ?? 1;
    const optimizedPatterns = await RoutePlanner.generateOptimizedRoutes(
        start,
        end,
        map,
        patientCondition,
        'walking',
        astarNumRoutes,
        { includeWaypointPatterns: true },
    );

    const toRoute = pickPatternsToRoute(optimizedPatterns, baselineDistanceM);
    benchLog(`${toRoute.length}/${optimizedPatterns?.length || 0} patterns to Mapbox-route`);

    const mapboxConcurrency = window.BENCHMARK_MAPBOX_CONCURRENCY || 1;
    const patternJobs = toRoute.map((pattern) => {
        const wps = pattern.waypoints.map((wp) => ({
            lat: wp.lat,
            lon: typeof wp.lng !== 'undefined' ? wp.lng : wp.lon,
        }));
        return {
            pattern,
            wps,
            name: pattern.name || 'Optimized Route',
        };
    });

    const patternResults = await mapWithConcurrency(
        patternJobs,
        mapboxConcurrency,
        async ({ wps, name, pattern }) => {
            try {
                benchLog(`Mapbox ${name}…`);
                const routed = await mapboxRoute(wps, name);
                const scores = await scoreRoutedPath(
                    routed.coordinates,
                    patientCondition,
                    preferences,
                    name,
                );
                return { ok: true, routed, scores, name, routing_engine: pattern?.routingEngine || 'unknown' };
            } catch (err) {
                console.warn('[benchmarkRunner] pattern failed', name, err);
                return { ok: false };
            }
        },
    );

    const candidates = [];
    for (const pr of patternResults) {
        if (!pr?.ok) continue;
        const { routed, scores, name, routing_engine } = pr;
        candidates.push({
            route_name: routed.routeName,
            distance_m: routed.distance_m,
            duration_s: routed.duration_s,
            coordinates: routed.coordinates,
            env_score: scores.environmentScore,
            total_score: scores.totalScore,
            scoring_method: scores.scoring_method,
            env_samples: scores.env_samples,
            detour_m: detourMetres(routed.distance_m, baselineDistanceM),
            pattern_name: name,
            routing_engine,
        });
        benchLog(
            `${name} detour=${detourMetres(routed.distance_m, baselineDistanceM)}m env=${scores.environmentScore}`,
        );
    }

    const baselineEnv = standardScores.environmentScore;
    const selection = selectBestWithinDetourPolicy(
        candidates,
        baselineDistanceM,
        baselineEnv,
    );
    let chosen = selection.chosen;

    let optimizedRoute;
    let optimizedScores;
    let optimizedEngine;
    let detourSelectionReason = selection.reason;

    if (
        chosen &&
        chosen.distance_m === baselineDistanceM &&
        !isMeaningfulImprovement(chosen, baselineEnv)
    ) {
        chosen = null;
        detourSelectionReason = 'mapbox_collapsed_to_direct';
    }

    if (chosen) {
        optimizedRoute = {
            routeName: chosen.route_name,
            distance_m: chosen.distance_m,
            duration_s: chosen.duration_s,
            coordinates: chosen.coordinates,
        };
        optimizedScores = {
            environmentScore: chosen.env_score,
            totalScore: chosen.total_score,
            scoring_method: chosen.scoring_method,
            env_samples: chosen.env_samples,
        };
        optimizedEngine = chosen.routing_engine || 'unknown';
    } else {
        optimizedRoute = { ...standardRoute, routeName: 'Fallback Direct (no gain)' };
        optimizedScores = { ...standardScores };
        optimizedEngine = 'fallback_direct';
        if (detourSelectionReason === 'no_candidates') {
            detourSelectionReason = 'fallback_direct';
        }
    }

    removeActiveControls();

    const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
    const elapsedMs = Date.now() - t0;
    benchLog(`done ${elapsedMs}ms`);

    return {
        engine: 'browser_ui',
        condition,
        elapsed_ms: elapsedMs,
        standard: {
            route_name: standardRoute.routeName,
            distance_m: num(standardRoute.distance_m),
            duration_s: num(standardRoute.duration_s),
            env_score: num(standardScores.environmentScore),
            total_score: num(standardScores.totalScore),
            scoring_method: standardScores.scoring_method,
            env_samples: standardScores.env_samples,
        },
        optimized: {
            route_name: optimizedRoute.routeName,
            distance_m: num(optimizedRoute.distance_m),
            duration_s: num(optimizedRoute.duration_s),
            env_score: num(optimizedScores.environmentScore),
            total_score: num(optimizedScores.totalScore),
            scoring_method: optimizedScores.scoring_method,
            env_samples: optimizedScores.env_samples,
            detour_m: num(detourMetres(optimizedRoute.distance_m, baselineDistanceM)),
            detour_selection: detourSelectionReason,
            routing_engine: optimizedEngine,
        },
        detour_policy: {
            max_detour_m: MAX_DETOUR_M,
            better_score_tolerance_m: BETTER_SCORE_ENV_TOLERANCE_M,
        },
        routes_collected: optimizedPatterns?.length ?? 0,
        patterns_routed: candidates.length,
    };
}
