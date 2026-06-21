/**
 * POIs-along-route: list the real points of interest a proposed route passes by.
 *
 * Data source is the backend /api/pois proxy (per category: parks, hospitals…),
 * which returns ONLY genuine OpenStreetMap elements (name may be null when
 * unnamed). No synthetic data is ever produced here; unnamed elements are
 * surfaced honestly by the caller and a name is never invented.
 */

// Max distance from the route polyline for a POI to count as "passed by".
export const POI_PROXIMITY_THRESHOLD_M = 150;

const EARTH_M_PER_DEG_LAT = 111320;

function toLatLon(point) {
    if (!point) {
        return null;
    }
    if (Array.isArray(point)) {
        const lon = Number(point[0]);
        const lat = Number(point[1]);
        return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    }
    const lat = Number(point.lat ?? point.latitude);
    const lon = Number(point.lon ?? point.lng ?? point.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function normalizeRoute(routeCoords) {
    if (!Array.isArray(routeCoords)) {
        return [];
    }
    return routeCoords.map(toLatLon).filter(Boolean);
}

/** Local equirectangular projection (metres) around a reference latitude. */
function makeProjector(refLat) {
    const mPerDegLon = EARTH_M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
    return ({ lat, lon }) => ({ x: lon * mPerDegLon, y: lat * EARTH_M_PER_DEG_LAT });
}

/** Distance (m) from point P to segment AB, plus the clamped projection fraction. */
function pointToSegment(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const abLenSq = abx * abx + aby * aby;
    let t = abLenSq === 0 ? 0 : (apx * abx + apy * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));
    const dx = p.x - (a.x + t * abx);
    const dy = p.y - (a.y + t * aby);
    return { distance: Math.hypot(dx, dy), t };
}

/**
 * Ordered, deduped list of POIs within `thresholdM` of the route polyline.
 * Category-agnostic: works for parks, hospitals, or any {name, lat, lon, kind}.
 * @param {Array} routeCoords - route points ({lat,lng}|{lat,lon}|[lon,lat]).
 * @param {Array} pois - real POIs ({name|null, lat, lon, kind}).
 * @param {number} thresholdM - proximity threshold in metres.
 * @returns {Array<{name: string|null, distanceM: number, latlng: {lat, lon}, kind: string|null}>}
 */
export function poisAlongRoute(routeCoords, pois, thresholdM = POI_PROXIMITY_THRESHOLD_M) {
    const route = normalizeRoute(routeCoords);
    if (route.length < 2 || !Array.isArray(pois) || pois.length === 0) {
        return [];
    }

    const refLat = route[0].lat;
    const project = makeProjector(refLat);
    const projectedRoute = route.map(project);

    // Cumulative metres to the start of each segment (for ordering along route).
    const cumulative = [0];
    for (let i = 1; i < projectedRoute.length; i++) {
        const prev = projectedRoute[i - 1];
        const curr = projectedRoute[i];
        cumulative[i] = cumulative[i - 1] + Math.hypot(curr.x - prev.x, curr.y - prev.y);
    }

    const matches = [];
    const seen = new Set();
    for (const poi of pois) {
        const latlng = toLatLon(poi);
        if (!latlng) {
            continue;
        }
        const p = project(latlng);

        let best = Infinity;
        let bestProgress = 0;
        for (let i = 1; i < projectedRoute.length; i++) {
            const { distance, t } = pointToSegment(p, projectedRoute[i - 1], projectedRoute[i]);
            if (distance < best) {
                best = distance;
                const segLen = cumulative[i] - cumulative[i - 1];
                bestProgress = cumulative[i - 1] + t * segLen;
            }
        }

        if (best > thresholdM) {
            continue;
        }

        const name = typeof poi.name === 'string' && poi.name.trim() ? poi.name.trim() : null;
        const dedupKey = name
            ? `n:${name.toLowerCase()}`
            : `c:${latlng.lat.toFixed(4)},${latlng.lon.toFixed(4)}`;
        if (seen.has(dedupKey)) {
            continue;
        }
        seen.add(dedupKey);

        matches.push({
            name,
            distanceM: Math.round(best),
            latlng,
            kind: typeof poi.kind === 'string' ? poi.kind : null,
            progress: bestProgress,
        });
    }

    matches.sort((a, b) => a.progress - b.progress);
    return matches.map(({ progress, ...rest }) => rest);
}

/** Padded bounding box around a route, for the /api/pois query. */
export function routeBoundingBox(routeCoords, padDeg = 0.002) {
    const route = normalizeRoute(routeCoords);
    if (route.length === 0) {
        return null;
    }
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    for (const { lat, lon } of route) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
    }
    return {
        minLat: minLat - padDeg,
        minLon: minLon - padDeg,
        maxLat: maxLat + padDeg,
        maxLon: maxLon + padDeg,
    };
}

const _poisCache = new Map();

/**
 * Fetch real POIs of a category for a bounding box from /api/pois (cached,
 * non-throwing). Returns [] on any failure so the UI degrades to an honest
 * empty state rather than inventing data.
 */
export async function fetchPoisForBounds(category, boundingBox, { timeoutMs = 8000 } = {}) {
    if (!boundingBox) {
        return [];
    }
    const key = [category, boundingBox.minLat, boundingBox.minLon, boundingBox.maxLat, boundingBox.maxLon]
        .map((value, index) => (index === 0 ? value : Number(value).toFixed(4)))
        .join(',');
    if (_poisCache.has(key)) {
        return _poisCache.get(key);
    }

    const params = new URLSearchParams({
        category,
        min_lat: boundingBox.minLat,
        min_lon: boundingBox.minLon,
        max_lat: boundingBox.maxLat,
        max_lon: boundingBox.maxLon,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`/api/pois?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        const pois = Array.isArray(data?.pois) ? data.pois : [];
        _poisCache.set(key, pois);
        return pois;
    } catch (error) {
        console.warn(`[poisAlongRoute] ${category} fetch failed:`, error?.message || error);
        return [];
    } finally {
        clearTimeout(timeoutId);
    }
}

/** Convenience: fetch a category's POIs for the route bbox and return the ordered along-route list. */
export async function getPoisAlongRoute(category, routeCoords, thresholdM = POI_PROXIMITY_THRESHOLD_M) {
    const boundingBox = routeBoundingBox(routeCoords);
    const pois = await fetchPoisForBounds(category, boundingBox);
    return poisAlongRoute(routeCoords, pois, thresholdM);
}
