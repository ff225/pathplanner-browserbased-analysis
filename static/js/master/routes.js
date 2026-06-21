import * as LoadingScreen from '../utils/loadingScreen.js';
import * as GenericUtils from '../utils/generic.js';
import * as MasterPreferences from '../master/preferences.js'
import * as MasterPatientCondition from '../master/patientConditions.js';
import * as Scores from '../master/scores.js';
import * as Environmental from '../services/environmental.js';
import * as PointOfInterests from '../services/pointOfInterest.js';
import * as RoutePlanner from '../services/routePlanner.js';

const MAPBOX_ACCESS_TOKEN = globalThis.window?.MAPBOX_ACCESS_TOKEN || '';
const ROUTE_COORDINATE_PRECISION = 5;
const ROUTE_PREVIEW_DURATION_MS = 15000;
const ROUTE_PREVIEW_FOLLOW_ZOOM = 17;
const ROUTE_PREVIEW_CAMERA_THROTTLE_MS = 80;
const routePreviewState = {
    marker: null,
    animationFrame: null,
    activeButton: null,
    activeRoutePanelId: null,
    restoreView: null,
    followZoom: null,
    lastCameraUpdateAt: 0
};

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
const MAPBOX_DIRECTIONS_LANGUAGE = 'it';
const MAPBOX_DIRECTIONS_ROUTING_OPTIONS = Object.freeze({
    alternatives: true,
    steps: true
});
const MAPBOX_DIRECTIONS_REQUEST_PARAMETERS = Object.freeze({
    banner_instructions: true,
    voice_instructions: true,
    language: MAPBOX_DIRECTIONS_LANGUAGE
});

function getMapboxDirectionsRequestParameters(overrides = {}) {
    return {
        ...MAPBOX_DIRECTIONS_REQUEST_PARAMETERS,
        ...overrides
    };
}

function getThemeColor(variableName, fallback) {
    try {
        if (!globalThis.document || typeof globalThis.getComputedStyle !== 'function') {
            return fallback;
        }

        const value = globalThis.getComputedStyle(globalThis.document.documentElement)
            .getPropertyValue(variableName)
            .trim();
        return value || fallback;
    } catch (error) {
        return fallback;
    }
}

function getRouteBaseColor(route) {
    return route && route.isDirectRoute
        ? getThemeColor('--route-direct', '#1e40af')
        : getThemeColor('--route-optimized', '#16a34a');
}

function getRouteSelectedColor() {
    return getThemeColor('--route-primary-strong', getThemeColor('--route-primary', '#f59e0b'));
}

function getRouteLineStyles(route, isSelected) {
    if (isSelected) {
        return [
            { color: getThemeColor('--route-selected-outline', '#111827'), opacity: 0.45, weight: 12 },
            { color: getThemeColor('--route-selected-halo', '#ffffff'), opacity: 0.95, weight: 9 },
            { color: getRouteSelectedColor(), opacity: 1, weight: 6 }
        ];
    }

    return [{
        color: getRouteBaseColor(route),
        opacity: 0.65,
        weight: 4,
        dashArray: route && route.isDirectRoute ? null : '8,8'
    }];
}

function getRouteLineStyle(route, isSelected) {
    if (isSelected) {
        return {
            color: getRouteSelectedColor(),
            weight: 8,
            opacity: 1,
            lineCap: 'round',
            lineJoin: 'round'
        };
    }

    return {
        color: getRouteBaseColor(route),
        weight: 4,
        opacity: 0.65,
        dashArray: route && route.isDirectRoute ? null : '8,8'
    };
}

function getRouteLineLayer(route) {
    if (!route || !route.routingControl) {
        return null;
    }

    if (route.routingControl._routes && route.routingControl._routes.length > 0 && route.routingControl._routes[0].line) {
        return route.routingControl._routes[0].line;
    }

    return route.routingControl._line || null;
}

function syncRoutingControlLineOptions(route, isSelected) {
    if (!route || !route.routingControl) {
        return;
    }

    const existingLineOptions = route.routingControl.options.lineOptions || {};
    route.routingControl.options.lineOptions = {
        ...existingLineOptions,
        styles: getRouteLineStyles(route, isSelected),
        missingRouteTolerance: existingLineOptions.missingRouteTolerance || 100
    };
}

function applyRouteLineStyle(route, isSelected) {
    syncRoutingControlLineOptions(route, isSelected);

    const routeLine = getRouteLineLayer(route);
    if (routeLine && typeof routeLine.setStyle === 'function') {
        routeLine.setStyle(getRouteLineStyle(route, isSelected));
    }

    if (isSelected && routeLine && typeof routeLine.bringToFront === 'function') {
        routeLine.bringToFront();
    }
}

function formatDistanceMeters(distanceMeters) {
    const distance = Number.parseFloat(distanceMeters);
    if (!Number.isFinite(distance)) {
        return '';
    }

    if (distance < 1000) {
        return `${Math.max(0, Math.round(distance))} m`;
    }

    const formatter = new Intl.NumberFormat('it-IT', {
        maximumFractionDigits: distance < 10000 ? 1 : 0
    });
    return `${formatter.format(distance / 1000)} km`;
}

function formatDurationSeconds(durationSeconds) {
    const duration = Number.parseFloat(durationSeconds);
    if (!Number.isFinite(duration)) {
        return '';
    }

    const totalMinutes = Math.max(1, Math.round(duration / 60));
    if (totalMinutes < 60) {
        return `${totalMinutes} min`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

function getRouteDirectionSteps(route) {
    const routeControl = route?.routingControl;
    const candidates = [
        route?.instructions,
        route?.route?.instructions,
        routeControl?._selectedRoute?.instructions,
        routeControl?._routes?.[0]?.instructions
    ];

    const instructionList = candidates.find(candidate => Array.isArray(candidate) && candidate.length > 0);
    if (instructionList) {
        return instructionList;
    }

    const legs = route?.route?.legs || route?.legs || routeControl?._selectedRoute?.legs || routeControl?._routes?.[0]?.legs;
    if (Array.isArray(legs)) {
        return legs.flatMap(leg => Array.isArray(leg?.steps) ? leg.steps : []);
    }

    return [];
}

function getInstructionRoad(instruction) {
    const roadCandidates = [
        instruction?.road,
        instruction?.name,
        instruction?.maneuver?.street_name,
        instruction?.maneuver?.street_names
    ];

    for (const candidate of roadCandidates) {
        if (Array.isArray(candidate) && candidate.length > 0) {
            const joinedRoad = candidate.filter(Boolean).join(', ').trim();
            if (joinedRoad) return joinedRoad;
        }
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return '';
}

function getInstructionText(instruction) {
    const road = getInstructionRoad(instruction);
    const textCandidates = [
        instruction?.text,
        instruction?.instruction,
        instruction?.maneuver?.instruction,
        instruction?.bannerInstructions?.[0]?.primary?.text,
        instruction?.voiceInstructions?.[0]?.announcement
    ];
    const baseText = textCandidates.find(candidate => typeof candidate === 'string' && candidate.trim())?.trim() || '';

    if (!baseText && road) {
        return `Continua su ${road}`;
    }

    if (baseText && road && !baseText.toLocaleLowerCase('it-IT').includes(road.toLocaleLowerCase('it-IT'))) {
        return `${baseText} su ${road}`;
    }

    return baseText || 'Prosegui sul percorso';
}

function getInstructionType(instruction) {
    return instruction?.type || instruction?.maneuver?.type || instruction?.modifier || instruction?.maneuver?.modifier || 'Continue';
}

function getInstructionModifier(instruction) {
    return instruction?.modifier || instruction?.maneuver?.modifier || '';
}

function getManeuverLabel(instruction) {
    const type = String(getInstructionType(instruction));
    const modifier = String(getInstructionModifier(instruction)).toLocaleLowerCase('en-US');
    const normalizedType = type.replace(/\s+/g, '');
    const labels = {
        Head: 'Partenza',
        Continue: 'Continua',
        Straight: 'Dritto',
        SlightRight: 'Leggera destra',
        Right: 'Destra',
        SharpRight: 'Destra stretta',
        SlightLeft: 'Leggera sinistra',
        Left: 'Sinistra',
        SharpLeft: 'Sinistra stretta',
        Uturn: 'Inversione',
        UTurn: 'Inversione',
        Roundabout: 'Rotonda',
        Rotary: 'Rotonda',
        Merge: 'Immissione',
        Fork: 'Bivio',
        OnRamp: 'Rampa',
        OffRamp: 'Uscita',
        DestinationReached: 'Arrivo',
        WaypointReached: 'Tappa'
    };

    if (labels[normalizedType]) {
        return labels[normalizedType];
    }

    if (modifier.includes('right')) return 'Destra';
    if (modifier.includes('left')) return 'Sinistra';
    if (modifier.includes('straight')) return 'Dritto';

    return type.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function getManeuverIconSvg(instruction) {
    const value = `${getInstructionType(instruction)} ${getInstructionModifier(instruction)}`.toLocaleLowerCase('en-US');

    if (value.includes('destination') || value.includes('arrive')) {
        return '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M6 21V4m0 0h10l-2 4 2 4H6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    if (value.includes('roundabout') || value.includes('rotary')) {
        return '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M8 16a6 6 0 1 0-1.5-5.9M8 16H4v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    if (value.includes('left')) {
        return '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M9 5 4 10l5 5M4 10h9a6 6 0 0 1 6 6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    if (value.includes('right')) {
        return '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="m15 5 5 5-5 5M20 10h-9a6 6 0 0 0-6 6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    if (value.includes('uturn') || value.includes('u-turn')) {
        return '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M7 7a5 5 0 0 1 10 0v12M7 7l4-4M7 7l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    return '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M12 19V5m0 0-5 5m5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function renderRouteDirections(route, container) {
    if (!container) {
        return;
    }

    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }

    const routeName = route?.routeName || route?.name || 'Percorso selezionato';
    const heading = L.DomUtil.create('div', 'turn-directions-header', container);
    const title = L.DomUtil.create('div', 'turn-directions-title', heading);
    title.textContent = `Indicazioni - ${routeName}`;

    const distanceSummary = formatDistanceMeters(route?.length || route?.route?.summary?.totalDistance);
    const durationSummary = formatDurationSeconds(route?.duration || route?.route?.summary?.totalTime);
    const summaryValues = [distanceSummary, durationSummary].filter(Boolean);
    if (summaryValues.length > 0) {
        const summary = L.DomUtil.create('div', 'turn-directions-summary', heading);
        summary.textContent = summaryValues.join(' / ');
    }

    const steps = getRouteDirectionSteps(route);
    if (!steps.length) {
        const emptyState = L.DomUtil.create('div', 'turn-directions-empty', container);
        emptyState.textContent = 'Indicazioni non disponibili per questo percorso.';
        return;
    }

    const list = L.DomUtil.create('ol', 'turn-directions-list', container);
    steps.forEach((instruction, index) => {
        const item = L.DomUtil.create('li', 'turn-directions-step', list);

        const icon = L.DomUtil.create('span', 'turn-directions-icon', item);
        icon.innerHTML = getManeuverIconSvg(instruction);

        const body = L.DomUtil.create('span', 'turn-directions-body', item);
        const type = L.DomUtil.create('span', 'turn-directions-type', body);
        type.textContent = `${index + 1}. ${getManeuverLabel(instruction)}`;

        const text = L.DomUtil.create('span', 'turn-directions-text', body);
        text.textContent = getInstructionText(instruction);

        const distance = L.DomUtil.create('span', 'turn-directions-distance', item);
        distance.textContent = formatDistanceMeters(instruction?.distance) || '-';
    });
}

function updateRouteDirectionsPanel(route, directionsPanel) {
    if (!directionsPanel) {
        return;
    }

    renderRouteDirections(route, directionsPanel);
}

function renderDirectionsSidebar(route) {
    const panel = document.getElementById('directionsPanel');
    const list = document.getElementById('directionsList');
    const summary = document.getElementById('directionsSummary');
    const empty = document.getElementById('directionsEmpty');
    if (!panel || !list) {
        return;
    }

    const routeName = route?.routeName || route?.name || 'Selected route';
    const distance = formatDistanceMeters(route?.length || route?.route?.summary?.totalDistance);
    const duration = formatDurationSeconds(route?.duration || route?.route?.summary?.totalTime);

    if (summary) {
        summary.innerHTML = '';
        const badges = [];
        if (distance) badges.push(`Distance: ${distance}`);
        if (duration) badges.push(`Duration: ${duration}`);
        badges.forEach(text => {
            const span = document.createElement('span');
            span.textContent = text;
            summary.appendChild(span);
        });
    }

    list.innerHTML = '';
    const steps = getRouteDirectionSteps(route);
    if (!steps.length) {
        if (empty) empty.hidden = false;
        return;
    }
    if (empty) empty.hidden = true;

    steps.forEach((instruction, index) => {
        const li = document.createElement('li');
        li.className = 'directions-step';
        li.innerHTML = `
            <span class="directions-step-icon" aria-hidden="true">${getManeuverIconSvg(instruction)}</span>
            <span class="directions-step-body">
                <span class="directions-step-type">${index + 1}. ${getManeuverLabel(instruction)}</span>
                <span class="directions-step-text">${getInstructionText(instruction)}</span>
            </span>
            <span class="directions-step-distance">${formatDistanceMeters(instruction?.distance) || '-'}</span>
        `;
        list.appendChild(li);
    });

    const title = panel.querySelector('.directions-title');
    if (title) {
        title.textContent = routeName;
    }
}

function setDirectionsSidebarOpen(open) {
    document.body.classList.toggle('directions-open', open);
    const panel = document.getElementById('directionsPanel');
    const toggle = document.getElementById('directionsToggle');
    if (panel) {
        panel.setAttribute('aria-hidden', String(!open));
    }
    if (toggle) {
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Close turn-by-turn directions' : 'Open turn-by-turn directions');
        toggle.setAttribute('title', open ? 'Close directions' : 'Turn-by-turn directions');
    }
}

function openDirectionsSidebar() {
    setDirectionsSidebarOpen(true);
}

function clearElementChildren(element) {
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

function isTechnicalRouteDescription(description) {
    return /A\* Cost|Grid environmental A\*|search nodes|nodes explored|heuristic|raw A\*/i.test(description);
}

function getUserFacingRouteDescription(route) {
    const description = typeof route?.description === 'string' ? route.description.trim() : '';
    if (description && !isTechnicalRouteDescription(description)) {
        return description;
    }

    const baseDescription = route?.isDirectRoute
        ? 'Percorso diretto standard'
        : 'Percorso ottimizzato per il profilo clinico';

    const realDataMatch = description.match(/\b\d+(?:\.\d+)?%\s*real data\b/i);
    return realDataMatch ? `${baseDescription} (${realDataMatch[0]})` : baseDescription;
}

/**
 * Compute the environmental-data provenance badge for a route.
 * Synthetic fallback must never be shown with the green REAL state.
 */
function getRouteEnvDataBadge(route) {
    if (!route || route.isDirectRoute) {
        return null;
    }

    let realPct = (typeof route.realDataPercentage === 'number' && Number.isFinite(route.realDataPercentage))
        ? route.realDataPercentage
        : null;
    const list = Array.isArray(route.environmentDataList) ? route.environmentDataList : null;

    if (realPct === null && list && list.length > 0) {
        const realCount = list.filter(point => point && !point.isDefault && !point.isSynthetic && !point.isEnhanced).length;
        realPct = (realCount / list.length) * 100;
    }

    if (realPct === null) {
        return null;
    }

    if (realPct === 100) {
        return {
            cssClass: 'env-real-badge--ok',
            label: 'REAL 100%',
            title: "All of this route's environmental data is real from /api/environment."
        };
    }

    const clampedPct = Math.min(100, Math.max(0, realPct));
    if (clampedPct > 0) {
        const realDisplayPct = Math.min(99, Math.max(1, Math.round(clampedPct)));
        const syntheticDisplayPct = 100 - realDisplayPct;
        return {
            cssClass: 'env-real-badge--synthetic',
            label: `MIXED ${realDisplayPct}% REAL · ${syntheticDisplayPct}% SYNTH`,
            title: `${realDisplayPct}% real environmental data from /api/environment; ${syntheticDisplayPct}% synthetic fallback.`
        };
    }

    return {
        cssClass: 'env-real-badge--synthetic',
        label: 'SYNTHETIC',
        title: 'Real environmental data was unavailable for this route; values are synthetic fallback data.'
    };
}

function renderRouteSelectorInfo(routeInfo, route, index, isSelected) {
    if (!routeInfo) {
        return;
    }

    clearElementChildren(routeInfo);
    routeInfo.className = 'route-card-content';

    const heading = L.DomUtil.create('div', 'route-card-heading', routeInfo);
    const name = L.DomUtil.create('span', 'route-card-name', heading);
    name.textContent = route.routeName || route.name || `Route ${index + 1}`;
    name.style.fontWeight = isSelected ? 'bold' : 'normal';

    const routeType = L.DomUtil.create(
        'span',
        route.isDirectRoute ? 'route-type-label route-type-label-direct' : 'route-type-label route-type-label-optimized',
        heading
    );
    routeType.textContent = route.isDirectRoute ? 'DIRECT' : 'OPTIMIZED';

    const envBadge = getRouteEnvDataBadge(route);
    if (envBadge) {
        const badgeEl = L.DomUtil.create('span', `env-real-badge ${envBadge.cssClass}`, heading);
        badgeEl.textContent = envBadge.label;
        badgeEl.title = envBadge.title;
    }

    const distanceSummary = formatDistanceMeters(route?.length || route?.route?.summary?.totalDistance);
    const durationSummary = formatDurationSeconds(route?.duration || route?.route?.summary?.totalTime);
    const summaryValues = [distanceSummary, durationSummary].filter(Boolean);
    if (summaryValues.length > 0) {
        const meta = L.DomUtil.create('div', 'route-card-meta', routeInfo);
        meta.textContent = summaryValues.join(' / ');
    }

    const description = L.DomUtil.create('div', 'route-card-description', routeInfo);
    description.textContent = getUserFacingRouteDescription(route);
}

function parseCoordinateValue(value) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function coordinateToLatLon(coordinate) {
    if (!coordinate) {
        return null;
    }

    if (Array.isArray(coordinate)) {
        const lon = parseCoordinateValue(coordinate[0]);
        const lat = parseCoordinateValue(coordinate[1]);
        return lat === null || lon === null ? null : { lat, lon };
    }

    const lat = parseCoordinateValue(coordinate.lat ?? coordinate.latitude);
    const lon = parseCoordinateValue(coordinate.lng ?? coordinate.lon ?? coordinate.longitude);
    return lat === null || lon === null ? null : { lat, lon };
}

function flattenCoordinateList(coordinates) {
    if (!Array.isArray(coordinates)) {
        return [];
    }

    return coordinates.reduce((flattened, coordinate) => {
        if (Array.isArray(coordinate) && coordinate.length > 0 && (Array.isArray(coordinate[0]) || typeof coordinate[0] === 'object')) {
            flattened.push(...flattenCoordinateList(coordinate));
        } else {
            flattened.push(coordinate);
        }
        return flattened;
    }, []);
}

function getRouteCoordinates(route) {
    if (!route) {
        return [];
    }

    const routeLine = getRouteLineLayer(route);
    const lineCoordinates = routeLine && typeof routeLine.getLatLngs === 'function'
        ? flattenCoordinateList(routeLine.getLatLngs())
        : [];
    const routeControl = route.routingControl;

    const candidates = [
        route.route?.coordinates,
        routeControl?._selectedRoute?.coordinates,
        routeControl?._routes?.[0]?.coordinates,
        lineCoordinates,
        route.coordinates,
        route.originalWaypoints,
        route.waypoints
    ].map(flattenCoordinateList);

    const fullGeometry = candidates.find(coordinates => coordinates.length > 2);
    if (fullGeometry) {
        return fullGeometry;
    }

    return candidates.find(coordinates => coordinates.length > 1) || [];
}

function normalizeRoutePreviewPath(route) {
    const leaflet = globalThis.L;
    const coordinates = getRouteCoordinates(route);
    const path = [];

    coordinates
        .map(coordinateToLatLon)
        .filter(Boolean)
        .forEach(({ lat, lon }) => {
            const previous = path[path.length - 1];
            if (previous && coordinatesNearlyEqual(previous.lat, lat) && coordinatesNearlyEqual(previous.lng, lon)) {
                return;
            }

            path.push(leaflet && typeof leaflet.latLng === 'function'
                ? leaflet.latLng(lat, lon)
                : { lat, lng: lon });
        });

    return path;
}

function getLatLngLongitude(latLng) {
    return latLng?.lng ?? latLng?.lon ?? latLng?.longitude;
}

function distanceBetweenLatLngs(start, end) {
    if (start && typeof start.distanceTo === 'function') {
        return start.distanceTo(end);
    }

    const startLat = parseCoordinateValue(start?.lat);
    const startLon = parseCoordinateValue(getLatLngLongitude(start));
    const endLat = parseCoordinateValue(end?.lat);
    const endLon = parseCoordinateValue(getLatLngLongitude(end));

    if ([startLat, startLon, endLat, endLon].some(value => value === null)) {
        return 0;
    }

    const earthRadiusMeters = 6371000;
    const toRadians = degrees => degrees * Math.PI / 180;
    const deltaLat = toRadians(endLat - startLat);
    const deltaLon = toRadians(endLon - startLon);
    const a = Math.sin(deltaLat / 2) ** 2 +
        Math.cos(toRadians(startLat)) * Math.cos(toRadians(endLat)) *
        Math.sin(deltaLon / 2) ** 2;

    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildRoutePreviewTrack(path) {
    const segmentLengths = [];
    let totalLength = 0;

    for (let i = 1; i < path.length; i++) {
        const segmentLength = distanceBetweenLatLngs(path[i - 1], path[i]);
        segmentLengths.push(segmentLength);
        totalLength += segmentLength;
    }

    return { path, segmentLengths, totalLength };
}

function captureRoutePreviewView(map) {
    if (!map || typeof map.getCenter !== 'function' || typeof map.getZoom !== 'function') {
        return null;
    }

    return {
        center: map.getCenter(),
        zoom: map.getZoom()
    };
}

function getRoutePreviewFollowZoom(map) {
    if (!map || typeof map.getZoom !== 'function') {
        return ROUTE_PREVIEW_FOLLOW_ZOOM;
    }

    const currentZoom = Number(map.getZoom());
    const preferredZoom = Math.max(
        Number.isFinite(currentZoom) ? currentZoom + 2 : ROUTE_PREVIEW_FOLLOW_ZOOM,
        ROUTE_PREVIEW_FOLLOW_ZOOM
    );
    const maxZoom = typeof map.getMaxZoom === 'function' ? Number(map.getMaxZoom()) : NaN;

    return Number.isFinite(maxZoom) ? Math.min(preferredZoom, maxZoom) : preferredZoom;
}

function restoreRoutePreviewView(map, animate = true) {
    const restoreView = routePreviewState.restoreView;
    routePreviewState.restoreView = null;
    routePreviewState.followZoom = null;
    routePreviewState.lastCameraUpdateAt = 0;

    if (!map || !restoreView || !restoreView.center || typeof map.setView !== 'function') {
        return;
    }

    map.setView(restoreView.center, restoreView.zoom, {
        animate,
        duration: animate ? 0.45 : 0
    });
}

function focusRoutePreviewCamera(map, latLng, timestamp, force = false) {
    if (!map || !latLng) {
        return;
    }

    const frameTime = Number.isFinite(timestamp) ? timestamp : Date.now();
    if (!force && frameTime - routePreviewState.lastCameraUpdateAt < ROUTE_PREVIEW_CAMERA_THROTTLE_MS) {
        return;
    }

    routePreviewState.lastCameraUpdateAt = frameTime;
    const followZoom = routePreviewState.followZoom ?? getRoutePreviewFollowZoom(map);
    routePreviewState.followZoom = followZoom;
    const currentZoom = typeof map.getZoom === 'function' ? Number(map.getZoom()) : followZoom;
    const shouldZoom = force || !Number.isFinite(currentZoom) || Math.abs(currentZoom - followZoom) > 0.25;

    if (shouldZoom && typeof map.setView === 'function') {
        map.setView(latLng, followZoom, {
            animate: true,
            duration: 0.35,
            easeLinearity: 0.25
        });
        return;
    }

    if (typeof map.panTo === 'function') {
        map.panTo(latLng, {
            animate: true,
            duration: 0.22,
            easeLinearity: 0.25
        });
    }
}

function interpolateRoutePreviewPosition(track, targetDistance) {
    const { path, segmentLengths } = track;
    let distanceSoFar = 0;

    for (let i = 0; i < segmentLengths.length; i++) {
        const segmentLength = segmentLengths[i];
        const segmentStart = path[i];
        const segmentEnd = path[i + 1];

        if (segmentLength <= 0) {
            continue;
        }

        if (distanceSoFar + segmentLength >= targetDistance) {
            const segmentProgress = Math.max(0, Math.min(1, (targetDistance - distanceSoFar) / segmentLength));
            const lat = segmentStart.lat + (segmentEnd.lat - segmentStart.lat) * segmentProgress;
            const startLon = getLatLngLongitude(segmentStart);
            const endLon = getLatLngLongitude(segmentEnd);
            const lng = startLon + (endLon - startLon) * segmentProgress;
            const leaflet = globalThis.L;

            return leaflet && typeof leaflet.latLng === 'function'
                ? leaflet.latLng(lat, lng)
                : { lat, lng };
        }

        distanceSoFar += segmentLength;
    }

    return path[path.length - 1];
}

function createRoutePreviewIcon() {
    const leaflet = globalThis.L;

    if (!leaflet || typeof leaflet.divIcon !== 'function') {
        return null;
    }

    return leaflet.divIcon({
        className: 'route-preview-cursor',
        html: '<span class="route-preview-cursor-core" aria-hidden="true"></span>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
}

function resetRoutePreviewButton(button) {
    if (!button) {
        return;
    }

    button.removeAttribute('data-preview-state');
    button.removeAttribute('aria-busy');
}

function setRoutePreviewButtonState(button, state) {
    if (!button) {
        return;
    }

    button.dataset.previewState = state;
    button.setAttribute('aria-busy', state === 'running' ? 'true' : 'false');
}

function notifyRoutePreviewUnavailable(message) {
    if (globalThis.toastr && typeof globalThis.toastr.warning === 'function') {
        globalThis.toastr.warning(message);
    } else {
        console.warn(`[route-preview] ${message}`);
    }
}

function stopRoutePreview(map, options = {}) {
    const { restoreView = true, animateRestore = true } = options;

    if (routePreviewState.animationFrame !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(routePreviewState.animationFrame);
    }

    if (routePreviewState.marker) {
        try {
            if (map && typeof map.hasLayer === 'function' && map.hasLayer(routePreviewState.marker)) {
                map.removeLayer(routePreviewState.marker);
            } else if (typeof routePreviewState.marker.remove === 'function') {
                routePreviewState.marker.remove();
            }
        } catch (error) {
            console.warn('[route-preview] Error removing preview marker:', error);
        }
    }

    if (restoreView) {
        restoreRoutePreviewView(map, animateRestore);
    } else {
        routePreviewState.restoreView = null;
        routePreviewState.followZoom = null;
        routePreviewState.lastCameraUpdateAt = 0;
    }

    resetRoutePreviewButton(routePreviewState.activeButton);
    routePreviewState.marker = null;
    routePreviewState.animationFrame = null;
    routePreviewState.activeButton = null;
    routePreviewState.activeRoutePanelId = null;
}

function startRoutePreview(map, route, button) {
    const leaflet = globalThis.L;

    stopRoutePreview(map, { restoreView: false });

    if (!map || !leaflet || typeof leaflet.marker !== 'function') {
        notifyRoutePreviewUnavailable('Route preview is not available on this map.');
        return false;
    }

    const path = normalizeRoutePreviewPath(route);
    if (path.length < 2) {
        notifyRoutePreviewUnavailable('Select a route with geometry before previewing it.');
        return false;
    }

    const track = buildRoutePreviewTrack(path);
    if (track.totalLength <= 0) {
        notifyRoutePreviewUnavailable('This route is too short to preview.');
        return false;
    }

    const icon = createRoutePreviewIcon();
    const markerOptions = {
        interactive: false,
        keyboard: false,
        zIndexOffset: 1200
    };

    if (icon) {
        markerOptions.icon = icon;
    }

    const marker = leaflet.marker(path[0], markerOptions).addTo(map);
    routePreviewState.marker = marker;
    routePreviewState.activeButton = button || null;
    routePreviewState.activeRoutePanelId = route?.routePanelId || null;
    routePreviewState.restoreView = captureRoutePreviewView(map);
    routePreviewState.followZoom = getRoutePreviewFollowZoom(map);
    routePreviewState.lastCameraUpdateAt = 0;
    setRoutePreviewButtonState(button, 'running');

    const startedAt = typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : Date.now();
    focusRoutePreviewCamera(map, path[0], startedAt, true);
    const requestFrame = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : callback => globalThis.setTimeout(() => callback(Date.now()), 16);

    const animate = timestamp => {
        const elapsed = timestamp - startedAt;
        const linearProgress = Math.max(0, Math.min(1, elapsed / ROUTE_PREVIEW_DURATION_MS));
        const progress = easeInOutCubic(linearProgress);
        const targetDistance = track.totalLength * progress;
        const previewPosition = interpolateRoutePreviewPosition(track, targetDistance);
        marker.setLatLng(previewPosition);
        focusRoutePreviewCamera(map, previewPosition, timestamp);

        if (progress < 1) {
            routePreviewState.animationFrame = requestFrame(animate);
            return;
        }

        routePreviewState.animationFrame = null;
        setRoutePreviewButtonState(button, 'complete');
        restoreRoutePreviewView(map);
    };

    routePreviewState.animationFrame = requestFrame(animate);
    return true;
}

function getSelectedRouteIndexFromPanel(container, routes, fallbackIndex = 0) {
    const selectedRadio = container?.querySelector?.('input[name="route-selection"]:checked') ||
        globalThis.document?.querySelector?.('#directionsRouteSelector .directions-route-card input[name="route-selection"]:checked');
    const selectedIndex = selectedRadio ? Number.parseInt(selectedRadio.dataset.index, 10) : NaN;

    if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < routes.length) {
        return selectedIndex;
    }

    const bestRouteIndex = routes.findIndex(route => route.isBest);
    if (bestRouteIndex !== -1) {
        return bestRouteIndex;
    }

    return Math.max(0, Math.min(fallbackIndex, routes.length - 1));
}

function buildRouteGeometryKey(route) {
    const coordinates = getRouteCoordinates(route);
    const normalizedCoordinates = coordinates
        .map(coordinateToLatLon)
        .filter(Boolean)
        .map(({ lat, lon }) => `${lat.toFixed(ROUTE_COORDINATE_PRECISION)},${lon.toFixed(ROUTE_COORDINATE_PRECISION)}`);

    return normalizedCoordinates.join('|');
}

function hashString(value) {
    const stringValue = String(value || '');
    let hash = 0;

    for (let i = 0; i < stringValue.length; i++) {
        hash = ((hash << 5) - hash + stringValue.charCodeAt(i)) | 0;
    }

    return Math.abs(hash).toString(36) || '0';
}

function ensureRouteIdentity(route, routeIndex = 0) {
    if (!route) {
        return {
            routePanelId: `route-missing-${routeIndex}`,
            routeGeometryHash: 'missing'
        };
    }

    const routeName = route.routeName || route.name || `Route ${routeIndex + 1}`;
    const geometryKey = buildRouteGeometryKey(route) || route.routeGeometryKey;
    const fallbackKey = [
        routeName,
        route.startPoint?.lat,
        route.startPoint?.lon,
        route.endPoint?.lat,
        route.endPoint?.lon
    ].join('|');
    const routeKey = geometryKey || fallbackKey;
    const routeGeometryHash = hashString(routeKey);

    route.routeGeometryKey = routeKey;
    route.routeGeometryHash = routeGeometryHash;
    if (!route.routePanelId) {
        route.routePanelId = `route-${routeGeometryHash}-${routeIndex}`;
    }

    return {
        routePanelId: route.routePanelId,
        routeGeometryHash: route.routeGeometryHash
    };
}

function routeScoreValue(route) {
    const score = Number.parseFloat(route?.score);
    return Number.isFinite(score) ? score : -Infinity;
}

function routeRawCostValue(route) {
    const rawCost = Number.parseFloat(route?.rawAStarScore);
    return Number.isFinite(rawCost) ? rawCost : Infinity;
}

function shouldReplaceDuplicateRoute(existingRoute, candidateRoute) {
    if (!existingRoute) {
        return true;
    }

    if (candidateRoute?.isBest && !existingRoute.isBest) {
        return true;
    }

    if (existingRoute.isDirectRoute !== candidateRoute?.isDirectRoute) {
        return candidateRoute && candidateRoute.isDirectRoute === false;
    }

    const candidateScore = routeScoreValue(candidateRoute);
    const existingScore = routeScoreValue(existingRoute);
    if (candidateScore !== existingScore) {
        return candidateScore > existingScore;
    }

    return routeRawCostValue(candidateRoute) < routeRawCostValue(existingRoute);
}

function removeRouteControlFromMap(route, map, currentRouting) {
    if (!route || !route.routingControl) {
        return;
    }

    const control = route.routingControl;

    try {
        if (map && typeof map.hasLayer === 'function' && map.hasLayer(control)) {
            map.removeControl(control);
        }
    } catch (error) {
        console.warn('[removeRouteControlFromMap] Error removing route control:', error);
    }

    if (currentRouting && Array.isArray(currentRouting.routingControls)) {
        const controlIndex = currentRouting.routingControls.indexOf(control);
        if (controlIndex > -1) {
            currentRouting.routingControls.splice(controlIndex, 1);
        }
    }

    if (control._container) {
        if (typeof $ === 'function') {
            $(control._container).hide();
        } else {
            control._container.style.display = 'none';
        }
    }

    [control._line, getRouteLineLayer(route), control._routes?.[0]?.line].forEach(line => {
        try {
            if (line && map && typeof map.hasLayer === 'function' && map.hasLayer(line)) {
                map.removeLayer(line);
            }
        } catch (error) {
            console.warn('[removeRouteControlFromMap] Error removing route line:', error);
        }
    });

    try {
        if (control.getPlan) {
            control.getPlan().setWaypoints([]);
        }
    } catch (error) {
        console.warn('[removeRouteControlFromMap] Error clearing route waypoints:', error);
    }

    route.removedFromMap = true;
}

function deduplicateRoutesForComparison(routes, map, currentRouting) {
    if (!Array.isArray(routes) || routes.length <= 1) {
        return Array.isArray(routes) ? routes : [];
    }

    const uniqueRoutes = [];
    const seenByGeometry = new Map();
    const duplicateRoutes = [];

    routes.forEach((route, index) => {
        const identity = ensureRouteIdentity(route, index);
        const routeKey = identity.routeGeometryHash || `route-${index}`;
        const existing = seenByGeometry.get(routeKey);

        if (!existing) {
            uniqueRoutes.push(route);
            seenByGeometry.set(routeKey, {
                route,
                uniqueIndex: uniqueRoutes.length - 1
            });
            return;
        }

        if (shouldReplaceDuplicateRoute(existing.route, route)) {
            duplicateRoutes.push(existing.route);
            uniqueRoutes[existing.uniqueIndex] = route;
            seenByGeometry.set(routeKey, {
                route,
                uniqueIndex: existing.uniqueIndex
            });
            return;
        }

        duplicateRoutes.push(route);
    });

    duplicateRoutes.forEach(route => removeRouteControlFromMap(route, map, currentRouting));

    if (duplicateRoutes.length > 0) {
        routes.splice(0, routes.length, ...uniqueRoutes);
        console.info(`[deduplicateRoutesForComparison] Collapsed ${duplicateRoutes.length} duplicate route(s) from the comparison panel.`);
    }

    return routes;
}

function coordinatesNearlyEqual(first, second, tolerance = 0.0001) {
    const firstValue = parseCoordinateValue(first);
    const secondValue = parseCoordinateValue(second);
    return firstValue !== null && secondValue !== null && Math.abs(firstValue - secondValue) < tolerance;
}

function csvRouteMatchesRouteData(existingRoute, routeData) {
    if (!existingRoute || !routeData) {
        return false;
    }

    if (existingRoute.route_panel_id && routeData.route_panel_id && existingRoute.route_panel_id === routeData.route_panel_id) {
        return true;
    }

    if (
        existingRoute.route_geometry_hash &&
        routeData.route_geometry_hash &&
        existingRoute.route_geometry_hash === routeData.route_geometry_hash &&
        existingRoute.patient_condition === routeData.patient_condition &&
        existingRoute.transport_mode === routeData.transport_mode
    ) {
        return true;
    }

    return (
        existingRoute.path_type === routeData.path_type &&
        existingRoute.patient_condition === routeData.patient_condition &&
        coordinatesNearlyEqual(existingRoute.start_lat, routeData.start_lat) &&
        coordinatesNearlyEqual(existingRoute.start_lon, routeData.start_lon) &&
        coordinatesNearlyEqual(existingRoute.end_lat, routeData.end_lat) &&
        coordinatesNearlyEqual(existingRoute.end_lon, routeData.end_lon)
    );
}

function getCsvDataStore(csvData) {
    if (globalThis.window && Array.isArray(globalThis.window.csvData)) {
        return globalThis.window.csvData;
    }

    return Array.isArray(csvData) ? csvData : null;
}

function addRouteDataToCsv(routeData, csvData, logPrefix) {
    const csvStore = getCsvDataStore(csvData);
    if (!csvStore) {
        console.warn(`[${logPrefix}] csvData is not available or not an array:`, csvData);
        return false;
    }

    const routeExists = csvStore.some(existingRoute => csvRouteMatchesRouteData(existingRoute, routeData));
    if (routeExists) {
        console.log(`[${logPrefix}] Route ${routeData.path_type} for ${routeData.patient_condition} already exists in csvData.`);
        return false;
    }

    csvStore.push(routeData);
    console.log(`[${logPrefix}] Added route ${routeData.path_type} for ${routeData.patient_condition} to csvData. Count: ${csvStore.length}`);
    return true;
}

function buildRouteDataMatcher(route, currentPatientCondition) {
    const identity = ensureRouteIdentity(route);
    return {
        route_panel_id: identity.routePanelId,
        route_geometry_hash: identity.routeGeometryHash,
        path_type: route.routeName || route.name || 'Default Route',
        patient_condition: currentPatientCondition?.name || route.patient_condition || 'none',
        transport_mode: route.transportMode || 'walking',
        start_lat: route.startPoint?.lat,
        start_lon: route.startPoint?.lon,
        end_lat: route.endPoint?.lat,
        end_lon: route.endPoint?.lon
    };
}

function removeRouteFromCsvData(route, csvData, currentPatientCondition) {
    const targets = [];
    if (globalThis.window && Array.isArray(globalThis.window.csvData)) {
        targets.push(globalThis.window.csvData);
    }
    if (Array.isArray(csvData) && !targets.includes(csvData)) {
        targets.push(csvData);
    }

    if (targets.length === 0) {
        return 0;
    }

    const routeMatcher = buildRouteDataMatcher(route, currentPatientCondition);
    let removedCount = 0;

    targets.forEach(target => {
        for (let index = target.length - 1; index >= 0; index--) {
            if (csvRouteMatchesRouteData(target[index], routeMatcher)) {
                target.splice(index, 1);
                removedCount++;
            }
        }
    });

    return removedCount;
}

// Add the createMapboxRouter function
function createMapboxRouter(profile = 'walking') {
    return L.Routing.mapbox(MAPBOX_ACCESS_TOKEN, {
        profile: `mapbox/${profile}`,
        geometries: 'geojson',
        steps: true,
        alternatives: true,
        language: MAPBOX_DIRECTIONS_LANGUAGE,
        routingOptions: { ...MAPBOX_DIRECTIONS_ROUTING_OPTIONS },
        requestParameters: getMapboxDirectionsRequestParameters()
    });
}

// Moved displayFallbackRoute to module scope
function displayFallbackRoute(map, currentRouting, waypointInputs, additionalInfos, startLat, startLon, endLat, endLon) {
    console.warn("No optimized routes found or primary routing failed, displaying direct route with Mapbox as fallback.");
    try {
        const startLatLng = L.latLng(startLat || 44.6471, startLon || 10.6292);
        const endLatLng = L.latLng(endLat || 44.6499, endLon || 10.6368);

        var fallbackControl = L.Routing.control({
            waypoints: [startLatLng, endLatLng],
            routeWhileDragging: false,
            fitSelectedRoutes: true,
            show: false,
            showAlternatives: false, // Keep it simple for fallback
            lineOptions: {
                styles: getRouteLineStyles({ isDirectRoute: true }, true),
                missingRouteTolerance: 100
            },
            router: L.Routing.mapbox(MAPBOX_ACCESS_TOKEN, {
                profile: 'mapbox/' + (additionalInfos.transportMode || 'walking'),
                steps: true,
                language: MAPBOX_DIRECTIONS_LANGUAGE,
                routingOptions: { ...MAPBOX_DIRECTIONS_ROUTING_OPTIONS },
                requestParameters: getMapboxDirectionsRequestParameters()
            }),
            createMarker: function() { return null; }
        }).addTo(map);

        fallbackControl.on('routingerror', function(e) {
            console.error("Mapbox fallback route also failed:", e);
            toastr.error("Could not calculate any route between these points.");
        });

        currentRouting.routingControls.push(fallbackControl);
        toastr.info("Showing direct route as fallback.");
    } catch (error) {
        console.error("Error creating Mapbox fallback route:", error);
        toastr.error("Unable to display any fallback route.");
    }
}

// Add the analytics helper function at the top of the file
function collectRouteAnalyticsData(route, condition, preferences, routeIndex) {
    console.log(`[collectRouteAnalyticsData] Processing route: ${route.routeName}, condition: ${condition.name}`);

    // Format timestamp
    const now = new Date();
    const timestamp = now.toISOString();

    // Use custom route name if available
    let routeName = 'Default Route';
    if (route.name) {
        routeName = route.name;
    } else if (route.routeName) {
        routeName = route.routeName;
    } else if (routeIndex === 0) {
        routeName = 'Best Route';
    } else {
        routeName = `Alternative Route ${routeIndex}`;
    }
    const routeIdentity = ensureRouteIdentity(route, routeIndex);

    // Basic route data
    const routeData = {
        timestamp: timestamp,
        city: "Reggio Emilia",
        path_type: routeName,
        route_panel_id: routeIdentity.routePanelId,
        route_geometry_hash: routeIdentity.routeGeometryHash,
        start_lat: route.startPoint?.lat || "",
        start_lon: route.startPoint?.lon || "",
        end_lat: route.endPoint?.lat || "",
        end_lon: route.endPoint?.lon || "",
        length_shortest_path: route.shortestLength || route.length,
        length_this_path: route.length || 0,
        multiplier_factor: ((route.length || 0) / (route.shortestLength || route.length)).toFixed(2),
        path_score: route.score ? route.score.toFixed(1) : "0",
        routing_mode: "preference",
        patient_condition: condition.name || "none",
        preference_label: preferences.label || "default",
        transport_mode: route.transportMode || "walking",
        data_source: "real_api", // Will be updated based on actual data
        real_data_percent: "0" // Will be updated based on actual data
    };

    // Environmental data processing
    if (route.environmentDataList && route.environmentDataList.length > 0) {
        console.log(`[collectRouteAnalyticsData] Found ${route.environmentDataList.length} environmental data points for route`);

        // Filter to only use real API data points
        const realDataPoints = route.environmentDataList.filter(point =>
            !point.isDefault && !point.isSynthetic && !point.isEnhanced
        );

        console.log(`[collectRouteAnalyticsData] Found ${realDataPoints.length}/${route.environmentDataList.length} real API data points`);

        // Calculate real data percentage
        const realDataPercent = route.environmentDataList.length > 0 ?
            (realDataPoints.length / route.environmentDataList.length) * 100 : 0;

        routeData.real_data_percent = realDataPercent.toFixed(1);
        routeData.data_source = realDataPercent >= 50 ? "real_api" : "mixed_data";
        routeData.env_data_count = route.environmentDataList.length;
        routeData.real_data_count = realDataPoints.length;

        // Determine which data set to use (real only or all)
        const dataToUse = realDataPoints.length >= 3 ? realDataPoints : route.environmentDataList;
        console.log(`[collectRouteAnalyticsData] Using ${dataToUse === realDataPoints ? 'real-only' : 'mixed'} data for statistics (${dataToUse.length} points)`);

        // Extract environmental statistics - Temperature
        const temperatureValues = dataToUse
            .filter(point => point.temperature !== null && point.temperature !== undefined)
            .map(point => point.temperature);

        if (temperatureValues.length > 0) {
            const sum = temperatureValues.reduce((total, val) => total + val, 0);
            routeData.temperature = (sum / temperatureValues.length).toFixed(1);
            routeData.temperature_min = Math.min(...temperatureValues).toFixed(1);
            routeData.temperature_max = Math.max(...temperatureValues).toFixed(1);
            routeData.temperature_points = temperatureValues.length;
        } else {
            routeData.temperature = "N/A";
            routeData.temperature_min = "N/A";
            routeData.temperature_max = "N/A";
            routeData.temperature_points = 0;
        }

        // Extract environmental statistics - Humidity
        const humidityValues = dataToUse
            .filter(point => point.humidity !== null && point.humidity !== undefined)
            .map(point => point.humidity);

        if (humidityValues.length > 0) {
            const sum = humidityValues.reduce((total, val) => total + val, 0);
            routeData.humidity = (sum / humidityValues.length).toFixed(1);
            routeData.humidity_min = Math.min(...humidityValues).toFixed(1);
            routeData.humidity_max = Math.max(...humidityValues).toFixed(1);
        } else {
            routeData.humidity = "N/A";
            routeData.humidity_min = "N/A";
            routeData.humidity_max = "N/A";
        }

        // Extract environmental statistics - Air Quality
        const airQualityValues = dataToUse
            .filter(point => point.airQuality !== null && point.airQuality !== undefined)
            .map(point => point.airQuality);

        if (airQualityValues.length > 0) {
            const sum = airQualityValues.reduce((total, val) => total + val, 0);
            routeData.air_quality = (sum / airQualityValues.length).toFixed(1);
            routeData.air_quality_min = Math.min(...airQualityValues).toFixed(1);
            routeData.air_quality_max = Math.max(...airQualityValues).toFixed(1);
            routeData.air_quality_points = airQualityValues.length;
        } else {
            routeData.air_quality = "N/A";
            routeData.air_quality_min = "N/A";
            routeData.air_quality_max = "N/A";
            routeData.air_quality_points = 0;
        }

        // Extract environmental statistics - Weather
        const weatherValues = dataToUse
            .filter(point => point.weather)
            .map(point => point.weather);

        if (weatherValues.length > 0) {
            // Find most common weather condition
            const weatherCounts = {};
            weatherValues.forEach(weather => {
                weatherCounts[weather] = (weatherCounts[weather] || 0) + 1;
            });

            let mostFrequent = weatherValues[0];
            let maxCount = 0;

            for (const weather in weatherCounts) {
                if (weatherCounts[weather] > maxCount) {
                    mostFrequent = weather;
                    maxCount = weatherCounts[weather];
                }
            }

            routeData.weather_condition = mostFrequent;
        } else {
            routeData.weather_condition = "N/A";
        }

        // Extract environmental statistics - Slope
        const slopeValues = dataToUse
            .filter(point => point.slope !== null && point.slope !== undefined)
            .map(point => Math.abs(point.slope));

        if (slopeValues.length > 0) {
            const sum = slopeValues.reduce((total, val) => total + val, 0);
            routeData.avg_slope = (sum / slopeValues.length).toFixed(2);
            routeData.max_slope = Math.max(...slopeValues).toFixed(2);
            routeData.slope_points = slopeValues.length;
        } else {
            routeData.avg_slope = "N/A";
            routeData.max_slope = "N/A";
            routeData.slope_points = 0;
        }

        // Extract environmental statistics - Noise
        const noiseValues = dataToUse
            .filter(point => point.noise !== null && point.noise !== undefined)
            .map(point => point.noise);

        if (noiseValues.length > 0) {
            const sum = noiseValues.reduce((total, val) => total + val, 0);
            routeData.avg_noise = (sum / noiseValues.length).toFixed(1);
            routeData.max_noise = Math.max(...noiseValues).toFixed(1);
        } else {
            routeData.avg_noise = "N/A";
            routeData.max_noise = "N/A";
        }

        // Environmental scores directly from route object - Use raw scores without scaling
        routeData.env_score = route.environmentScore ? route.environmentScore.toFixed(1) : "N/A";

        // Add environmental data stats
        routeData.env_data_quality = (route.environmentDataList.length / (route.coordinates?.length || 1)).toFixed(2);

        // Log detailed summary
        console.log(`[collectRouteAnalyticsData] Environmental data summary for ${routeName}:`);
        console.log(`- Temperature: ${routeData.temperature} (${routeData.temperature_min}-${routeData.temperature_max})`);
        console.log(`- Air Quality: ${routeData.air_quality} (${routeData.air_quality_min}-${routeData.air_quality_max})`);
        console.log(`- Slope: ${routeData.avg_slope} (max: ${routeData.max_slope})`);
        console.log(`- Real Data: ${routeData.real_data_percent}% (${realDataPoints.length}/${route.environmentDataList.length})`);

    } else {
        // No environmental data found - mark clearly as missing data
        console.warn(`[collectRouteAnalyticsData] No environmentDataList found for ${routeName}`);
        routeData.temperature = "MISSING";
        routeData.humidity = "MISSING";
        routeData.air_quality = "MISSING";
        routeData.weather_condition = "MISSING";
        routeData.avg_slope = "MISSING";
        routeData.max_slope = "MISSING";
        routeData.avg_noise = "MISSING";
        routeData.max_noise = "MISSING";
        routeData.env_score = route.environmentScore ? route.environmentScore.toFixed(1) : "MISSING";
        routeData.env_data_quality = "0.00";
        routeData.data_source = "missing";
        routeData.real_data_percent = "0.0";
    }

    // POI counts
    if (route.poiCounts) {
        routeData.num_poi_nature = route.poiCounts.natureCount || 0;
        routeData.num_poi_entertainment = route.poiCounts.entertainmentCount || 0;
        routeData.num_poi_nightlife = route.poiCounts.nightlifeCount || 0;
        routeData.num_poi_tourism = route.poiCounts.tourismCount || 0;
        routeData.num_poi_hospital = route.poiCounts.hospitalCount || 0;

        // Specialized POIs for explainability
        routeData.rest_areas = route.poiCounts.restingAreaCount || 0;
        routeData.park_benches = route.poiCounts.parkBenchCount || 0;
        routeData.pharmacies = route.poiCounts.pharmacyCount || 0;
        routeData.wheelchair_access = route.poiCounts.wheelchairAccessCount || 0;
        routeData.flat_pathways = route.poiCounts.flatPathwayCount || 0;
        routeData.public_toilets = route.poiCounts.publicToiletCount || 0;
        routeData.quiet_areas = route.poiCounts.quietAreaCount || 0;
        routeData.water_fountains = route.poiCounts.waterFountainCount || 0;
        routeData.cafes = route.poiCounts.cafeCount || 0;
    }

    // Patient sensitivity values
    if (condition.isPatientMode && condition.name !== "default") {
        routeData.temperature_sensitivity = condition.temperatureSensitivity || 0;
        routeData.humidity_sensitivity = condition.humiditySensitivity || 0;
        routeData.air_quality_sensitivity = condition.airQualitySensitivity || 0;
        routeData.slope_sensitivity = condition.slopeSensitivity || 0;
        routeData.noise_sensitivity = condition.noiseSensitivity || 0;
    }

    // POI weights
    routeData.poi_nature_weight = preferences.nature || 0;
    routeData.poi_entertainment_weight = preferences.entertainment || 0;
    routeData.poi_nightlife_weight = preferences.nightlife || 0;
    routeData.poi_tourism_weight = preferences.tourism || 0;
    routeData.poi_hospital_weight = preferences.hospital || 0;

    // Score breakdown - Use raw scores without scaling
    routeData.total_score = route.score ? route.score.toFixed(1) : "0";
    routeData.env_score = route.environmentScore ? route.environmentScore.toFixed(1) : "0";
    routeData.poi_score = route.poiScore ? route.poiScore.toFixed(1) : "0";
    routeData.specialized_poi_score = route.specializedPoiScore ? route.specializedPoiScore.toFixed(1) : "0";

    console.log(`[collectRouteAnalyticsData] Generated data for route: ${routeName}, score: ${routeData.total_score}, real data: ${routeData.real_data_percent}%`);
    return routeData;
}

// Modify the generateConditionSpecificRoutes function
async function generateConditionSpecificRoutes(condition, waypoints, transportMode, currentPreferences) {
    try {
        console.log(`[generateConditionSpecificRoutes] Environmental A* + Mapbox for ${condition.name}`);

        const map = window.map || null;
        if (!map) {
            console.warn("[generateConditionSpecificRoutes] No map — cannot run grid A*");
            return generateDefaultRoutePatterns(condition, waypoints, transportMode);
        }

        const optimizedRoutes = await RoutePlanner.generateOptimizedRoutes(
            waypoints.start,
            waypoints.end,
            map,
            condition,
            transportMode,
            condition.isPatientMode ? 3 : 2,
            { preferAStar: true, preferences: currentPreferences }
        );

        console.log(`[generateConditionSpecificRoutes] ${optimizedRoutes.length} route(s) for ${condition.name}`);
        optimizedRoutes.forEach((route, index) => {
            console.log(`  Route ${index + 1}: ${route.name} [${route.routingEngine || 'unknown'}], score: ${route.environmentalScore}`);
        });

        if (optimizedRoutes.length === 0) {
            console.warn("[generateConditionSpecificRoutes] No routes from RoutePlanner");
            return generateDefaultRoutePatterns(condition, waypoints, transportMode);
        }

        // Convert to the format expected by the route function
        const routePatterns = RoutePlanner.convertToRoutesFormat(optimizedRoutes);

        console.log(`[generateConditionSpecificRoutes] Generated ${routePatterns.length} total routes for ${condition.name}`);
        return routePatterns;

    } catch (error) {
        console.error("[generateConditionSpecificRoutes] Error generating routes with A*:", error);
        // Fall back to the original implementation if A* fails
        return generateDefaultRoutePatterns(condition, waypoints, transportMode);
    }
}

/**
 * Generate waypoints specifically tailored for each patient condition
 * @param {Object} condition - Patient condition object
 * @param {Object} waypoints - Start and end waypoints
 * @returns {Array} Array of waypoint pattern objects
 */
function generateConditionWaypoints(condition, waypoints) {
    // Calculate base values for alternative routes
    const startLat = parseFloat(waypoints.start.lat);
    const startLon = parseFloat(waypoints.start.lon);
    const endLat = parseFloat(waypoints.end.lat);
    const endLon = parseFloat(waypoints.end.lon);

    // Calculate midpoint for alternative routes
    const midLat = (startLat + endLat) / 2;
    const midLon = (startLon + endLon) / 2;

    // Calculate distance between points to determine reasonable offsets
    const latDiff = Math.abs(startLat - endLat);
    const lonDiff = Math.abs(startLon - endLon);

    // Calculate offsets in different directions (larger than default for more distinct routes)
    const offset = Math.max(latDiff, lonDiff) * 0.5; // 50% of the total distance

    console.log(`[generateConditionWaypoints] Generating waypoints for ${condition.name} condition`);
    console.log(`  Start: ${startLat},${startLon} | End: ${endLat},${endLon}`);
    console.log(`  Midpoint: ${midLat},${midLon} | Offset: ${offset}`);

    const waypointPatterns = [];

    // Generate different patterns based on patient condition
    switch(condition.name) {
        case "respiratory":
            // For respiratory conditions, prioritize:
            // 1. Clean air (parks, away from main roads)
            // 2. Low pollution areas
            // 3. Flat terrain (to minimize exertion)

            // Route 1: Green route through parks (north-east path)
            waypointPatterns.push({
                name: "Green Air Route",
                description: "Route through parks and areas with better air quality",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.7, lon: midLon + offset * 0.7 }, // Northeast path through parks
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 2: Low traffic route (skirting around main roads)
            waypointPatterns.push({
                name: "Low Pollution Route",
                description: "Route that avoids high traffic and pollution areas",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat - offset * 0.3, lon: midLon + offset * 0.9 }, // Southeast path away from city center
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 3: Flat terrain route
            waypointPatterns.push({
                name: "Low Exertion Route",
                description: "Route with minimal elevation changes to reduce breathing effort",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.2, lon: midLon - offset * 0.8 }, // Northwest path on flat ground
                    { lat: endLat, lon: endLon }
                ]
            });
            break;

        case "cardiac":
            // For cardiac conditions, prioritize:
            // 1. Flat terrain (avoid hills)
            // 2. Emergency access (near medical facilities)
            // 3. Rest opportunities

            // Route 1: Flat terrain route
            waypointPatterns.push({
                name: "Heart-Friendly Flat Route",
                description: "Route with minimal elevation changes to reduce cardiac strain",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat, lon: midLon + offset * 0.9 }, // Eastern path (typically flatter)
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 2: Medical access route
            waypointPatterns.push({
                name: "Medical Access Route",
                description: "Route passing near hospitals and medical facilities",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat - offset * 0.8, lon: midLon - offset * 0.2 }, // Southwest path near hospital district
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 3: Rest stops route
            waypointPatterns.push({
                name: "Rest Areas Route",
                description: "Route with frequent benches and rest opportunities",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.6, lon: midLon - offset * 0.5 }, // Northwest path through parks with benches
                    { lat: endLat, lon: endLon }
                ]
            });
            break;

        case "mobility":
            // For mobility conditions, prioritize:
            // 1. Flat terrain (no slopes)
            // 2. Smooth surfaces (well-maintained paths)
            // 3. Accessibility features (curb cuts, wide paths)

            // Route 1: Wheelchair accessible route
            waypointPatterns.push({
                name: "Wheelchair Accessible Route",
                description: "Route optimized for wheelchair access and mobility devices",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.1, lon: midLon - offset * 0.7 }, // Western path with accessibility features
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 2: Smooth surface route
            waypointPatterns.push({
                name: "Smooth Surface Route",
                description: "Route with well-maintained, even surfaces",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat - offset * 0.5, lon: midLon + offset * 0.5 }, // Southeast path on main sidewalks
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 3: Flat terrain route
            waypointPatterns.push({
                name: "Zero-Slope Route",
                description: "Route that avoids any inclines or slopes",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat, lon: midLon + offset * 0.8 }, // Eastern path on flat ground
                    { lat: endLat, lon: endLon }
                ]
            });
            break;

        case "mental":
            // For mental health conditions, prioritize:
            // 1. Quiet areas (low noise)
            // 2. Green spaces (parks, nature)
            // 3. Low sensory load (away from crowds)

            // Route 1: Nature therapy route
            waypointPatterns.push({
                name: "Nature Therapy Route",
                description: "Route through parks and green spaces for mental wellbeing",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.7, lon: midLon + offset * 0.4 }, // Northeast path through major parks
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 2: Quiet zone route
            waypointPatterns.push({
                name: "Quiet Zone Route",
                description: "Route through low-noise areas for reduced stress",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat - offset * 0.6, lon: midLon + offset * 0.6 }, // Southeast path through residential areas
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 3: Low stimulation route
            waypointPatterns.push({
                name: "Low Stimulation Route",
                description: "Route with minimal sensory overload and crowds",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.3, lon: midLon - offset * 0.9 }, // Northwest path away from busy areas
                    { lat: endLat, lon: endLon }
                ]
            });
            break;

        case "arthritis":
            // For arthritis conditions, prioritize:
            // 1. Smooth surfaces (well-maintained paths)
            // 2. Flat terrain (no slopes)
            // 3. Rest opportunities (benches)

            // Route 1: Joint-friendly surface route
            waypointPatterns.push({
                name: "Joint-Friendly Surface Route",
                description: "Route with smooth surfaces that minimize joint stress",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat - offset * 0.4, lon: midLon - offset * 0.8 }, // Southwest path on smooth surfaces
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 2: Flat terrain route
            waypointPatterns.push({
                name: "Zero-Incline Route",
                description: "Route with no inclines to reduce joint stress",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat, lon: midLon + offset * 0.7 }, // Eastern path on flat ground
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 3: Rest areas route
            waypointPatterns.push({
                name: "Rest Spot Route",
                description: "Route with frequent benches and rest opportunities",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.8, lon: midLon + offset * 0.3 }, // Northeast path with rest areas
                    { lat: endLat, lon: endLon }
                ]
            });
            break;

        case "diabetes":
            // For diabetes conditions, prioritize:
            // 1. Moderate exercise (some gentle slopes)
            // 2. Access to services (pharmacies, food)
            // 3. Rest opportunities

            // Route 1: Moderate exercise route
            waypointPatterns.push({
                name: "Moderate Exercise Route",
                description: "Route with gentle inclines for appropriate exercise",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.6, lon: midLon + offset * 0.6 }, // Northeast path with gentle slopes
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 2: Services access route
            waypointPatterns.push({
                name: "Services Access Route",
                description: "Route passing near pharmacies and food services",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat - offset * 0.7, lon: midLon + offset * 0.3 }, // Southeast path through commercial areas
                    { lat: endLat, lon: endLon }
                ]
            });

            // Route 3: Rest and recovery route
            waypointPatterns.push({
                name: "Rest and Recovery Route",
                description: "Route with places to rest and access water/food",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.2, lon: midLon - offset * 0.6 }, // Northwest path with amenities
                    { lat: endLat, lon: endLon }
                ]
            });
            break;

        default:
            // Default route patterns for unknown conditions
            waypointPatterns.push({
                name: "Alternative Route A",
                description: "Northern alternative path",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat + offset * 0.7, lon: midLon }, // Northern path
                    { lat: endLat, lon: endLon }
                ]
            });

            waypointPatterns.push({
                name: "Alternative Route B",
                description: "Eastern alternative path",
                waypoints: [
                    { lat: startLat, lon: startLon },
                    { lat: midLat, lon: midLon + offset * 0.7 }, // Eastern path
                    { lat: endLat, lon: endLon }
                ]
            });
    }

    // Log the generated waypoint patterns
    console.log(`[generateConditionWaypoints] Generated ${waypointPatterns.length} waypoint patterns for ${condition.name}`);
    waypointPatterns.forEach((pattern, index) => {
        console.log(`  Pattern ${index+1}: ${pattern.name} - ${pattern.description}`);
    });

    return waypointPatterns;
}

// Keep the original implementation as a fallback
function generateDefaultRoutePatterns(condition, waypoints, transportMode) {
        // Generate different route patterns based on patient condition
        const routePatterns = [];

        // Add direct route for all conditions
        routePatterns.push({
            name: "Direct Route",
            description: "Shortest path between points",
            waypoints: [
                { lat: waypoints.start.lat, lon: waypoints.start.lon },
                { lat: waypoints.end.lat, lon: waypoints.end.lon }
            ]
        });

        if (condition.isPatientMode) {
            // Calculate midpoint for alternative routes
            const midLat = (parseFloat(waypoints.start.lat) + parseFloat(waypoints.end.lat)) / 2;
            const midLon = (parseFloat(waypoints.start.lon) + parseFloat(waypoints.end.lon)) / 2;

            // Calculate distance between points to determine reasonable offsets
            const latDiff = Math.abs(parseFloat(waypoints.start.lat) - parseFloat(waypoints.end.lat));
            const lonDiff = Math.abs(parseFloat(waypoints.start.lon) - parseFloat(waypoints.end.lon));
            const offset = Math.max(latDiff, lonDiff) * 0.3; // 30% of the total distance

            switch(condition.name) {
                case "respiratory":
                    // Add routes that prioritize green areas and low traffic
                    routePatterns.push({
                        name: "Low Pollution Route",
                        description: "Route that avoids highly polluted areas",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat + offset, lon: midLon }, // Northern path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });

                    routePatterns.push({
                        name: "Green Route",
                        description: "Route through park areas with better air quality",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat, lon: midLon + offset }, // Eastern path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });
                    break;

                case "cardiac":
                    // Add routes that are flat and near medical facilities
                    routePatterns.push({
                        name: "Flat Terrain Route",
                        description: "Route that minimizes elevation changes",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat, lon: midLon + offset }, // Eastern path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });

                    routePatterns.push({
                        name: "Medical Access Route",
                        description: "Route near medical facilities",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat - offset, lon: midLon }, // Southern path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });
                    break;

                case "mental":
                    // Add routes that are quiet and have nature
                    routePatterns.push({
                        name: "Quiet Route",
                        description: "Route that minimizes noise exposure",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat + offset, lon: midLon + offset }, // Northeast path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });

                    routePatterns.push({
                        name: "Nature Route",
                        description: "Route with natural elements for relaxation",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat - offset, lon: midLon + offset }, // Southeast path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });
                    break;

                case "mobility":
                    // Add routes with accessible paths
                    routePatterns.push({
                        name: "Accessible Route",
                        description: "Route optimized for wheelchair access",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat - offset, lon: midLon - offset }, // Southwest path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });

                    routePatterns.push({
                        name: "Flat Path Route",
                        description: "Route with minimal slopes",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat, lon: midLon - offset }, // Western path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });
                    break;

                case "arthritis":
                    // Add routes that are flat and have rest areas
                    routePatterns.push({
                        name: "Joint-Friendly Route",
                        description: "Route with smooth surfaces and minimal inclines",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat, lon: midLon - offset }, // Western path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });

                    routePatterns.push({
                        name: "Rest Area Route",
                        description: "Route with benches and rest opportunities",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat + offset, lon: midLon - offset }, // Northwest path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });
                    break;

                case "diabetes":
                    // Add routes with medical facilities and moderate exercise
                    routePatterns.push({
                        name: "Health Services Route",
                        description: "Route passing near pharmacies and health services",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat - offset, lon: midLon }, // Southern path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });

                    routePatterns.push({
                        name: "Moderate Exercise Route",
                        description: "Route with appropriate inclines for safe exercise",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat + offset, lon: midLon + offset }, // Northeast path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });
                    break;

                default:
                    // Default route patterns
                    routePatterns.push({
                        name: "Alternative Route A",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat + offset, lon: midLon }, // Northern path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });

                    routePatterns.push({
                        name: "Alternative Route B",
                        waypoints: [
                            { lat: waypoints.start.lat, lon: waypoints.start.lon },
                            { lat: midLat, lon: midLon + offset }, // Eastern path
                            { lat: waypoints.end.lat, lon: waypoints.end.lon }
                        ]
                    });
            }
        }

        return routePatterns;
}

// Move the setupRouteControlPanel function definition to module level
// so it can be used by both route() and routeWithPrecalculatedRoutes()

function getRouteSelectorContainer() {
    return document.getElementById('directionsRouteSelector');
}

function clearRouteSelectorContainer() {
    const container = getRouteSelectorContainer();
    if (container) {
        container.innerHTML = '';
    }
}

/**
 * Set up the route control panel UI for selecting different routes
 * @param {Object} map - Leaflet map object
 * @param {Array} routes - Array of route objects
 * @param {Object} currentRouting - Current routing state
 */
function setupRouteControlPanel(map, routes, currentRouting, currentPatientCondition, currentPreferences, csvData) {
    routes = Array.isArray(routes) ? routes : [];
    console.log(`[setupRouteControlPanel] Setting up control panel with ${routes.length} routes. Condition: ${currentPatientCondition ? currentPatientCondition.name : 'N/A'}, Prefs: ${currentPreferences ? currentPreferences.label : 'N/A'}`);
    stopRoutePreview(map);
    window.RouteStepSimulator && window.RouteStepSimulator.stop();

    // Remove existing route selector content from the directions panel
    clearRouteSelectorContainer();

    // Aggressively remove all existing routing controls from the map first
    // This ensures a clean slate before adding the new ones if routes were from a *previous* search.
    if (currentRouting.routingControls && currentRouting.routingControls.length > 0) {
        currentRouting.routingControls.forEach(control => {
            if (control && map.hasLayer(control)) {
                try {
                    map.removeControl(control);
                    console.log(`[setupRouteControlPanel] Aggressively removed old control.`);
                } catch (e) {
                    console.warn(`[setupRouteControlPanel] Error aggressively removing old control:`, e);
                }
            }
        });
    }
    currentRouting.routingControls = []; // Reset for the new set of routes
    routes = deduplicateRoutesForComparison(routes, map, currentRouting);

    if (routes.length === 0) {
        clearRouteSelectorContainer();
        console.warn("[setupRouteControlPanel] No routes available after de-duplication.");
        return;
    }

    // Ensure all routes have valid scores
    routes.forEach((route, index) => {
        ensureRouteIdentity(route, index);
        if (route.score === undefined || route.score === null) route.score = 5.0;
        if (route.environmentScore === undefined || route.environmentScore === null) route.environmentScore = 5.0;
        if (route.poiScore === undefined || route.poiScore === null) route.poiScore = 5.0;
        console.log(`[setupRouteControlPanel] Route: ${route.routeName || route.name || 'Unnamed'}, Raw Score: ${route.score ? route.score.toFixed(1) : 'N/A'}, EnvScore: ${route.environmentScore ? route.environmentScore.toFixed(1) : 'N/A'}, POI: ${route.poiScore ? route.poiScore.toFixed(1) : 'N/A'}`);
    });

    const bestRouteIndex = routes.findIndex(route => route.isBest);
    const optimizedRouteIndex = routes.findIndex(route => !route.isDirectRoute);
    const initialSelectedIndex = bestRouteIndex !== -1 ? bestRouteIndex : (optimizedRouteIndex !== -1 ? optimizedRouteIndex : 0);

    // Pre-process to add only the selected route's control to the map initially
    routes.forEach((route, index) => {
        if (route.routingControl) {
            try {
                const routeLine = getRouteLineLayer(route);
                syncRoutingControlLineOptions(route, index === initialSelectedIndex);
                if (index === initialSelectedIndex) {
                    console.log(`[setupRouteControlPanel] Initially adding selected route line ${index}: ${route.routeName || route.name}`);
                    if (!map.hasLayer(route.routingControl)) {
                        route.routingControl.addTo(map);
                        currentRouting.routingControls.push(route.routingControl); // Add to managed list
                    }
                    if (route.routingControl._container) {
                        $(route.routingControl._container).hide();
                    }
                    if (routeLine) {
                        if (!map.hasLayer(routeLine)) map.addLayer(routeLine);
                        applyRouteLineStyle(route, true);
                    }
                    route.removedFromMap = false;
                } else {
                    // For non-selected routes, ensure their controls are NOT on the map
                    // and containers are hidden. They will be added if selected later.
                    console.log(`[setupRouteControlPanel] Initially ensuring route ${index} (${route.routeName || route.name}) is HIDDEN and REMOVED`);
                    if (map.hasLayer(route.routingControl)) {
                        map.removeControl(route.routingControl);
                    }
                    if (route.routingControl._container) {
                        $(route.routingControl._container).hide();
                    }
                    if (routeLine && map.hasLayer(routeLine)) {
                        map.removeLayer(routeLine);
                    }
                    route.removedFromMap = true;
                }
            } catch (e) {
                console.warn(`[setupRouteControlPanel] Error setting initial visibility for route ${index} (${route.routeName || route.name}):`, e);
            }
        }
    });

    function removeRouteAtIndex(routeIndex) {
        stopRoutePreview(map);
        window.RouteStepSimulator && window.RouteStepSimulator.stop();
        const routeToRemove = routes[routeIndex];
        if (!routeToRemove) {
            return;
        }

        const checkedRadio = document.querySelector('#directionsRouteSelector .directions-route-card input[name="route-selection"]:checked');
        const currentSelectedIndex = checkedRadio ? parseInt(checkedRadio.dataset.index, 10) : initialSelectedIndex;
        const routeName = routeToRemove.routeName || routeToRemove.name || `Route ${routeIndex + 1}`;

        removeRouteControlFromMap(routeToRemove, map, currentRouting);
        const removedCsvRows = removeRouteFromCsvData(routeToRemove, csvData, currentPatientCondition);
        routes.splice(routeIndex, 1);

        if (typeof window.updateDownloadButtonText === 'function') {
            window.updateDownloadButtonText();
        }

        if (routes.length === 0) {
            clearRouteSelectorContainer();
            toastr.info(`Removed ${routeName}. No comparison routes remain.`);
            console.log(`[setupRouteControlPanel] Removed ${routeName}; removed ${removedCsvRows} CSV row(s).`);
            return;
        }

        let nextSelectedIndex = currentSelectedIndex;
        if (routeIndex === currentSelectedIndex) {
            nextSelectedIndex = Math.min(routeIndex, routes.length - 1);
        } else if (routeIndex < currentSelectedIndex) {
            nextSelectedIndex = currentSelectedIndex - 1;
        }
        nextSelectedIndex = Math.max(0, Math.min(nextSelectedIndex, routes.length - 1));

        routes.forEach((route, index) => {
            route.isBest = index === nextSelectedIndex;
        });

        console.log(`[setupRouteControlPanel] Removed ${routeName}; removed ${removedCsvRows} CSV row(s). Reselecting index ${nextSelectedIndex}.`);
        toastr.info(`Removed ${routeName} from comparison.`);
        setupRouteControlPanel(map, routes, currentRouting, currentPatientCondition, currentPreferences, csvData);
    }

    const selectorContainer = getRouteSelectorContainer();
    if (selectorContainer) {
        selectorContainer.innerHTML = '';

        const previewButton = document.createElement('button');
        previewButton.type = 'button';
        previewButton.className = 'directions-route-preview';
        previewButton.innerHTML = '<span class="route-preview-button-icon" aria-hidden="true"></span><span>Preview route</span>';
        previewButton.setAttribute('aria-label', 'Preview selected route from start to arrival');
        previewButton.title = 'Preview selected route';

        const stopPreviewButton = document.createElement('button');
        stopPreviewButton.type = 'button';
        stopPreviewButton.className = 'directions-route-preview directions-route-preview--stop';
        stopPreviewButton.innerHTML = '<span class="route-preview-button-icon" aria-hidden="true"></span><span>Stop preview</span>';
        stopPreviewButton.setAttribute('aria-label', 'Stop route preview');
        stopPreviewButton.title = 'Stop preview';
        stopPreviewButton.disabled = true;

        const setPreviewControlsRunning = (running) => {
            const selectedRoute = routes[getSelectedRouteIndexFromPanel(selectorContainer, routes, initialSelectedIndex)];
            const canPreview = normalizeRoutePreviewPath(selectedRoute).length >= 2;
            if (running) {
                previewButton.disabled = true;
                setRoutePreviewButtonState(previewButton, 'running');
                stopPreviewButton.disabled = false;
            } else {
                previewButton.disabled = !canPreview;
                previewButton.title = canPreview ? 'Preview selected route' : 'Select a route with geometry first';
                resetRoutePreviewButton(previewButton);
                stopPreviewButton.disabled = true;
            }
        };

        const updatePreviewButtonState = () => {
            const selectedRoute = routes[getSelectedRouteIndexFromPanel(selectorContainer, routes, initialSelectedIndex)];
            const canPreview = normalizeRoutePreviewPath(selectedRoute).length >= 2;
            previewButton.disabled = !canPreview;
            previewButton.title = canPreview ? 'Preview selected route' : 'Select a route with geometry first';
        };

        previewButton.addEventListener('click', () => {
            const selectedRoute = routes[getSelectedRouteIndexFromPanel(selectorContainer, routes, initialSelectedIndex)];
            if (!selectedRoute) {
                return;
            }

            if (typeof window.RouteStepSimulator === 'undefined' || !window.RouteStepSimulator.start) {
                startRoutePreview(map, selectedRoute, previewButton);
                return;
            }

            stopRoutePreview(map, { restoreView: false });
            window.RouteStepSimulator.stop();
            setPreviewControlsRunning(true);

            const transportMode = document.getElementById('transportMode')?.value || 'walking';
            const speedByMode = {
                walking: 1.2,
                cycling: 4,
                driving: 12
            };
            const started = window.RouteStepSimulator.start({
                map,
                route: selectedRoute,
                directionsListElement: document.getElementById('directionsList'),
                speedMps: speedByMode[transportMode] || speedByMode.walking,
                followCamera: true,
                onStepEnter: (index, el) => {
                    el.classList.add('directions-step--active');
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                },
                onStepLeave: (index, el) => el.classList.remove('directions-step--active'),
                onDone: () => {
                    setPreviewControlsRunning(false);
                }
            });

            if (!started) {
                setPreviewControlsRunning(false);
            }
        });

        stopPreviewButton.addEventListener('click', () => {
            window.RouteStepSimulator.stop();
            stopRoutePreview(map);
            setPreviewControlsRunning(false);
        });

        selectorContainer.appendChild(previewButton);
        selectorContainer.appendChild(stopPreviewButton);

        if (routes.length === 2) {
            const directRoute = routes.find(r => r.isDirectRoute);
            const optimizedRoute = routes.find(r => !r.isDirectRoute);
            if (directRoute && optimizedRoute && directRoute.length && optimizedRoute.length) {
                const directLength = (directRoute.length / 1000).toFixed(2);
                const optimizedLength = (optimizedRoute.length / 1000).toFixed(2);
                const lengthDiff = ((optimizedRoute.length - directRoute.length) / directRoute.length * 100).toFixed(0);
                const directScore = directRoute.score || 0;
                const optimizedScore = optimizedRoute.score || 0;
                const scoreDiff = ((optimizedScore - directScore) / Math.max(1, directScore) * 100).toFixed(0);
                const isLonger = optimizedRoute.length > directRoute.length;
                const isBetterScore = optimizedScore > directScore;

                const comparisonText = document.createElement('div');
                comparisonText.className = 'directions-summary';
                comparisonText.innerHTML = `
                    <span>${isLonger ? '↑' : '↓'} ${Math.abs(lengthDiff)}% distance</span>
                    <span>${isBetterScore ? '↑' : '↓'} ${Math.abs(scoreDiff)}% score</span>
                `;
                selectorContainer.appendChild(comparisonText);
            }
        }

        routes.forEach((route, index) => {
            const routeCard = document.createElement('div');
            routeCard.className = 'directions-route-card' + (index === initialSelectedIndex ? ' directions-route-card--selected' : '');
            routeCard.dataset.routePanelId = route.routePanelId;

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'route-selection';
            radio.checked = index === initialSelectedIndex;
            radio.dataset.index = index;

            const info = document.createElement('div');
            info.className = 'directions-route-card-info';
            renderRouteSelectorInfo(info, route, index, index === initialSelectedIndex);

            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'directions-route-card-remove';
            removeButton.innerHTML = '&times;';
            removeButton.title = `Remove ${route.routeName || route.name || `Route ${index + 1}`}`;
            removeButton.setAttribute('aria-label', removeButton.title);

            routeCard.appendChild(radio);
            routeCard.appendChild(info);
            routeCard.appendChild(removeButton);
            selectorContainer.appendChild(routeCard);

            radio.addEventListener('change', function () {
                if (!this.checked) return;
                const selectedIdx = parseInt(this.dataset.index, 10);
                console.log(`[setupRouteControlPanel] Radio changed. Selected route index: ${selectedIdx}`);
                stopRoutePreview(map);
                window.RouteStepSimulator && window.RouteStepSimulator.stop();

                routes.forEach((r, i) => {
                    r.isBest = (i === selectedIdx);
                    if (r.routingControl) {
                        try {
                            if (i === selectedIdx) {
                                console.log(`[setupRouteControlPanel] SHOWING selected route: ${i} (${r.routeName || r.name})`);
                                syncRoutingControlLineOptions(r, true);
                                if (r.originalWaypoints && r.originalWaypoints.length > 0) {
                                    r.routingControl.getPlan().setWaypoints(r.originalWaypoints);
                                } else {
                                    console.warn(`[setupRouteControlPanel] Route ${i} has no originalWaypoints to set!`);
                                    const currentWaypoints = r.routingControl.getWaypoints();
                                    if (currentWaypoints && currentWaypoints.length > 0 && currentWaypoints[0].latLng) {
                                        r.routingControl.getPlan().setWaypoints(currentWaypoints);
                                    } else {
                                        console.error(`[setupRouteControlPanel] Cannot show route ${i}, no valid waypoints found.`);
                                        return;
                                    }
                                }

                                if (!map.hasLayer(r.routingControl)) {
                                    r.routingControl.addTo(map);
                                    if (!currentRouting.routingControls.includes(r.routingControl)) {
                                        currentRouting.routingControls.push(r.routingControl);
                                    }
                                }

                                r.routingControl.once('routesfound', function(e) {
                                    console.log(`[setupRouteControlPanel] Routes found for selected route ${i}, applying style.`);
                                    const latestRoutePath = e.routes?.[0];
                                    if (latestRoutePath) {
                                        r.route = latestRoutePath;
                                        r.length = latestRoutePath.summary ? latestRoutePath.summary.totalDistance : r.length;
                                        r.duration = latestRoutePath.summary ? latestRoutePath.summary.totalTime : r.duration;
                                        r.instructions = Array.isArray(latestRoutePath.instructions) ? latestRoutePath.instructions : r.instructions;
                                    }
                                    const routeLine = latestRoutePath?.line || getRouteLineLayer(r);
                                    if (routeLine) {
                                        routeLine.setStyle(getRouteLineStyle(r, true));
                                        if (typeof routeLine.bringToFront === 'function') routeLine.bringToFront();
                                    }
                                    applyRouteLineStyle(r, true);
                                    renderDirectionsSidebar(r);
                                });
                                r.routingControl.route();

                                if (r.routingControl._container) {
                                    $(r.routingControl._container).hide();
                                }
                                r.removedFromMap = false;
                            } else {
                                console.log(`[setupRouteControlPanel] HIDING non-selected route: ${i} (${r.routeName || r.name})`);
                                syncRoutingControlLineOptions(r, false);
                                removeRouteControlFromMap(r, map, currentRouting);
                            }
                        } catch (e) {
                            console.warn(`[setupRouteControlPanel] Error toggling route ${i} visibility/style:`, e);
                        }
                    }
                });

                const selectedRouteData = routes[selectedIdx];
                renderDirectionsSidebar(selectedRouteData);

                document.querySelectorAll('.directions-route-card').forEach((item, i) => {
                    const isSelected = (i === selectedIdx);
                    const currentRouteForStyle = routes[i];
                    if (!currentRouteForStyle) return;
                    item.classList.toggle('directions-route-card--selected', isSelected);
                    const textElement = item.querySelector('.route-card-name');
                    if (textElement) textElement.style.fontWeight = isSelected ? 'bold' : 'normal';
                });
                updatePreviewButtonState();

                if (typeof Scores !== 'undefined' && Scores.extractScoreData) {
                    try {
                        const selectedRouteData = routes[selectedIdx];
                        Scores.extractScoreData(
                            selectedRouteData,
                            selectedRouteData.environmentDataList || [],
                            currentPreferences,
                            currentPatientCondition
                        );
                    } catch (error) {
                        console.warn("[setupRouteControlPanel] Error extracting score data:", error);
                    }
                }
            });

            removeButton.addEventListener('click', function(e) {
                e.stopPropagation();
                removeRouteAtIndex(index);
            });

            routeCard.addEventListener('click', function(e) {
                if (e.target === removeButton || removeButton.contains(e.target)) {
                    return;
                }
                if (e.target !== radio) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });

        updatePreviewButtonState();
        renderDirectionsSidebar(routes[initialSelectedIndex]);
    }

    // Make sure we trigger the change event for the initially selected route
    // This ensures the correct route is displayed and its data extracted on load
    setTimeout(() => {
        const initialRadio = document.querySelector(`#directionsRouteSelector .directions-route-card input[data-index="${initialSelectedIndex}"]`);
        if (initialRadio) {
            console.log(`[setupRouteControlPanel] Triggering change for initial radio: index ${initialSelectedIndex}`);
            const changeEvent = new Event('change', { bubbles: true });
            initialRadio.dispatchEvent(changeEvent);
        } else if (routes.length > 0 && typeof Scores !== 'undefined' && Scores.extractScoreData) {
            console.log("[setupRouteControlPanel] No radio found, but routes exist. Extracting data for route 0.");
            Scores.extractScoreData(routes[0], routes[0].environmentDataList || [], currentPreferences, currentPatientCondition);
        }
    }, 150); // Slightly increased timeout to ensure DOM is fully ready

    openDirectionsSidebar();
}

// Internal helper function to format scores for display
function formatScore(score) {
    if (score === undefined || score === null) {
        return "N/A";
    }
    return typeof score === 'number' ? score.toFixed(1) : "0.0";
}

async function route(
    currentRouting = {
        routingControl: null,
        routingControls: []
    },
    currentPreferences = MasterPreferences.DEFAULT,
    currentPatientCondition = MasterPatientCondition.DEFAULT,
    waypointInputs = {
        start: {
            lat: 0,
            lon: 0
        },
        end: {
            lat: 0,
            lon: 0
        }},
    additionalInfos = {
        transportMode: 'driving',
        percentageSlider: 1,
        preCalculatedRoutes: null // New parameter to accept pre-calculated routes from A*
    },
    map,
    document,
    csvData) {

    console.log("[route] Function called. Condition:", currentPatientCondition ? currentPatientCondition.name : 'N/A', "Transport:", additionalInfos.transportMode);

    // Check if we're using pre-calculated routes from A*
    if (additionalInfos.preCalculatedRoutes && Array.isArray(additionalInfos.preCalculatedRoutes)) {
        console.log(`[route] Using ${additionalInfos.preCalculatedRoutes.length} pre-calculated routes from A* algorithm`);

        // Use the pre-calculated routes instead of generating new ones
        return routeWithPrecalculatedRoutes(
            currentRouting,
            currentPreferences,
            currentPatientCondition,
            waypointInputs,
            additionalInfos,
            map,
            document,
            csvData
        );
    }

    // Ensure we're using the global csvData
    if (!csvData && window.csvData) {
        console.log("[route] Using global window.csvData since no csvData was provided");
        csvData = window.csvData;
    }

    if (Environmental.startRouteCalculation) {
        console.log("[route] Calling Environmental.startRouteCalculation()");
        Environmental.startRouteCalculation();
    } else {
        console.warn("[route] Environmental.startRouteCalculation is not defined!");
    }

    let startLat, startLon, endLat, endLon; // Declare here for broader scope if needed by fallback in main catch

    // Ensure allRoutes is initialized here and accessible to handleOnRouteFound
    const allRoutes = [];
    let currentRoute = {
        score: -Infinity, environmentScore: null, routingControl: null,
        route: null, length: null, poiCounts: null
    };
    let numberOfRoutes = (currentPatientCondition && currentPatientCondition.isPatientMode && currentPatientCondition.name !== 'default') ? 3 : 1; // Adjusted default for non-patient

    // DEFINE handleOnRouteFound HERE, within the scope of route() so it can access allRoutes, etc.
    async function handleOnRouteFound(e, routeControl, createdRoute, initialLeafletWaypoints) {
        try {
            console.log(`[handleOnRouteFound] Called for route: ${createdRoute.routeName}`);
            createdRoute.originalWaypoints = initialLeafletWaypoints; // Store original L.LatLng waypoints

            const routePath = e.routes[0];
            if (!routePath) {
                console.warn(`[handleOnRouteFound] No route data in event for ${createdRoute.routeName}`);
                return;
            }

            createdRoute.route = routePath;
            createdRoute.length = routePath.summary ? routePath.summary.totalDistance : null;
            createdRoute.duration = routePath.summary ? routePath.summary.totalTime : null;
            createdRoute.instructions = Array.isArray(routePath.instructions) ? routePath.instructions : [];
            if (routePath.coordinates && routePath.coordinates.length > 0) {
                createdRoute.coordinates = routePath.coordinates;
            }

            // Add to allRoutes immediately
            const routeExists = allRoutes.some(r => r.routingControl === createdRoute.routingControl);
            if (!routeExists) {
                allRoutes.push(createdRoute); // Add the route object to the shared array
                console.log(`[handleOnRouteFound] Added ${createdRoute.routeName} to allRoutes. Count: ${allRoutes.length}`);
            } else {
                console.log(`[handleOnRouteFound] Route ${createdRoute.routeName} already in allRoutes.`);
            }

            // Fetch environmental data - FORCE using only real API data
            console.log(`[handleOnRouteFound] Fetching environmental data for ${createdRoute.routeName}`);
            window.useRealTimeData = true; // Force real-time data usage
            window.REAL_DATA_ONLY = true; // Force real data only

            // Clear any global environmental cache to ensure fresh data
            if (window.dataCache) {
                console.log("[handleOnRouteFound] Clearing global environmental data cache to get fresh data");
                window.dataCache = {};
            }

            // Implement improved retry logic for environmental data
            let environmentDataList = [];
            let retryCount = 0;
            const maxRetries = 5; // Increased retries
            let hasEnoughRealData = false;

            while (retryCount < maxRetries && !hasEnoughRealData) {
                try {
                    // Force refresh on retries
                    const forceRefresh = retryCount > 0;
                    environmentDataList = await Environmental.getRouteEnvironmentalData(routePath, currentPatientCondition, forceRefresh);

                    // Check if we have enough real API data
                    if (environmentDataList && environmentDataList.length > 0) {
                        // Track real data vs simulated data
                        let realDataPoints = 0;
                        let totalDataPoints = 0;

                        environmentDataList.forEach(point => {
                            if (point.temperature !== null) totalDataPoints++;
                            if (point.airQuality !== null) totalDataPoints++;
                            if (point.slope !== null) totalDataPoints++;

                            // Count as real data if not marked as default, synthetic, or enhanced
                            if (point.temperature !== null && !point.isDefault && !point.isSynthetic && !point.isEnhanced) {
                                realDataPoints++;
                            }
                            if (point.airQuality !== null && !point.isDefault && !point.isSynthetic && !point.isEnhanced) {
                                realDataPoints++;
                            }
                            if (point.slope !== null && !point.isDefault && !point.isSynthetic && !point.isEnhanced) {
                                realDataPoints++;
                            }
                        });

                        const realDataRatio = totalDataPoints > 0 ? realDataPoints / totalDataPoints : 0;
                        console.log(`[handleOnRouteFound] Real data percentage: ${(realDataRatio * 100).toFixed(1)}% (${realDataPoints}/${totalDataPoints} data points)`);

                        // If we have at least 50% real data, consider it good enough
                        if (realDataRatio >= 0.5) {
                            hasEnoughRealData = true;
                            console.log(`[handleOnRouteFound] Got sufficient real API data on attempt ${retryCount+1}`);
                        } else if (retryCount < maxRetries - 1) {
                            console.warn(`[handleOnRouteFound] Only ${(realDataRatio * 100).toFixed(1)}% real data on attempt ${retryCount+1}, retrying...`);
                            retryCount++;
                            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                            continue;
                        } else {
                            console.warn(`[handleOnRouteFound] Using available data despite only having ${(realDataRatio * 100).toFixed(1)}% real data after ${retryCount+1} attempts`);
                            hasEnoughRealData = true; // Use what we have on last attempt
                        }
                    } else {
                        if (retryCount < maxRetries - 1) {
                            console.warn(`[handleOnRouteFound] No environmental data returned on attempt ${retryCount+1}, retrying...`);
                            retryCount++;
                            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                            continue;
                        } else {
                            console.error(`[handleOnRouteFound] Failed to get any environmental data after ${maxRetries} attempts`);
                            break;
                        }
                    }
                } catch (envError) {
                    console.error(`[handleOnRouteFound] Error fetching env data (attempt ${retryCount+1}):`, envError);
                    if (retryCount < maxRetries - 1) {
                        retryCount++;
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                    } else {
                        console.error(`[handleOnRouteFound] Failed to get environmental data after ${maxRetries} attempts due to errors`);
                        break;
                    }
                }
            }

            // Store environmental data in route object
            // Ensure the structure matches what getEnvironmentalData returns, including top-level flags
            createdRoute.environmentDataList = environmentDataList.map(envDataPoint => {
                return {
                    // Retain original coordinate if it was on the point, otherwise create one
                    lat: envDataPoint.coordinate?.lat || createdRoute.coordinates[environmentDataList.indexOf(envDataPoint)]?.lat || 0,
                    lon: envDataPoint.coordinate?.lng || envDataPoint.coordinate?.lon || createdRoute.coordinates[environmentDataList.indexOf(envDataPoint)]?.lng || 0,
                    environmentData: envDataPoint // The entire rich object from getEnvironmentalData
                };
            });
            console.log(`[handleOnRouteFound] Stored ${createdRoute.environmentDataList.length} enriched environmental data points for ${createdRoute.routeName}`);

            // Fetch POI data
            console.log(`[handleOnRouteFound] Fetching POI data for ${createdRoute.routeName}`);
            let poiData;
            try {
                poiData = await PointOfInterests.getRoutePOIs(routePath);
            } catch (poiError) {
                console.error(`[handleOnRouteFound] Error fetching POI data for ${createdRoute.routeName}:`, poiError);
                // Use minimal POI data if API call fails
                poiData = createMinimalPOIData();
            }
            createdRoute.poiCounts = poiData;

            // Calculate scores - using the renamed function to avoid duplicate declaration issue
            console.log(`[handleOnRouteFound] Calculating scores for ${createdRoute.routeName}`);
            const mappedEnvData = mapEnvironmentalDataToCoordinates(environmentDataList, createdRoute.coordinates);

            let scoreDataResult; // Renamed to avoid conflict with createdRoute.scoreData if it exists
            try {
                scoreDataResult = await Scores.calculateAllScores(
                    createdRoute.poiCounts,
                    mappedEnvData, // This should be the array of {environmentData: {...}, lat, lon} from getEnvironmentalData
                    currentPreferences,
                    currentPatientCondition
                );

                console.log(`[handleOnRouteFound] Score calculation result for ${createdRoute.routeName}:`, JSON.stringify(scoreDataResult, null, 2));
                if (scoreDataResult.realDataPercentage) {
                    console.log(`[handleOnRouteFound] Score calculation used ${scoreDataResult.realDataPercentage.toFixed(1)}% real data`);
                }
            } catch (error) {
                console.error(`[handleOnRouteFound] Score calculation error for ${createdRoute.routeName}:`, error);
                scoreDataResult = null; // Ensure it's null on error
            }

            // Ensure scores are not null and assign them directly to createdRoute
            if (!scoreDataResult) {
                createdRoute.score = 5.0; // Default fallback
                createdRoute.environmentScore = 5.0;
                createdRoute.poiScore = 5.0;
                createdRoute.specializedPoiScore = 0.0; // Default to 0 for specialized
                createdRoute.realDataPercentage = 0;
                createdRoute.envStats = {}; // Add empty envStats if scoring failed completely
            } else {
                // Assign all calculated scores and stats to the route object directly
                createdRoute.score = scoreDataResult.score; // This is the final total score
                createdRoute.environmentScore = scoreDataResult.environmentScore;
                createdRoute.poiScore = scoreDataResult.poiScore;
                createdRoute.specializedPoiScore = scoreDataResult.specializedPoiScore;
                createdRoute.realDataPercentage = scoreDataResult.realDataPercentage;
                // Pass along the detailed envStats from calculateAllScores for extractScoreData
                createdRoute.envStats = scoreDataResult.envStats;
            }

            // Ensure the score is not zero or undefined - if so, give it a default value (should be less necessary now)
            if (typeof createdRoute.score !== 'number' || Number.isNaN(createdRoute.score)) createdRoute.score = 5.0;
            if (typeof createdRoute.environmentScore !== 'number' || Number.isNaN(createdRoute.environmentScore)) createdRoute.environmentScore = 5.0;
            if (typeof createdRoute.poiScore !== 'number' || Number.isNaN(createdRoute.poiScore)) createdRoute.poiScore = 5.0;
            if (typeof createdRoute.specializedPoiScore !== 'number' || Number.isNaN(createdRoute.specializedPoiScore)) createdRoute.specializedPoiScore = 0.0;

            console.log(`[handleOnRouteFound] Final scores assigned to ${createdRoute.routeName}: Total=${createdRoute.score}, Env=${createdRoute.environmentScore}, POI=${createdRoute.poiScore}, Specialized=${createdRoute.specializedPoiScore}, RealData=${createdRoute.realDataPercentage}%`);

            // Update the route in allRoutes array
            const existingRouteIndex = allRoutes.findIndex(r => r.routingControl === createdRoute.routingControl);
            if (existingRouteIndex !== -1) {
                allRoutes[existingRouteIndex] = { ...allRoutes[existingRouteIndex], ...createdRoute };
            } else if (!allRoutes.some(r => r.routingControl === createdRoute.routingControl)) {
                 allRoutes.push(createdRoute);
            }

	            // If all routes have been processed, select the best and create control panel
	            if (allRoutes.length >= numberOfRoutes) {
                    deduplicateRoutesForComparison(allRoutes, map, currentRouting);
	                // Select the best route
	                currentRoute = selectBestRoute(allRoutes, currentPatientCondition);

	                // Add route data to CSV collection
                allRoutes.forEach((route, index) => {
                    // Ensure route has startPoint and endPoint
                    if (!route.startPoint) {
                        route.startPoint = waypointInputs.start;
                    }
                    if (!route.endPoint) {
                        route.endPoint = waypointInputs.end;
                    }

                    // Collect analytics data for CSV export
                    const routeExportData = collectRouteAnalyticsData(
                        route,
                        currentPatientCondition,
                        currentPreferences,
                        index
	                    );

                        addRouteDataToCsv(routeExportData, csvData, 'handleOnRouteFound');
	                });

                // Show notification that routes are ready for download
                toastr.success(`${allRoutes.length} routes collected for ${currentPatientCondition.name} condition. Click Download to export.`);

                // Update download button if function exists
                if (typeof window.updateDownloadButtonText === 'function') {
                    window.updateDownloadButtonText();
                }

	                // Set up the route control panel
	                setupRouteControlPanel(map, allRoutes, currentRouting, currentPatientCondition, currentPreferences, csvData);
	            }
        } catch (error) {
            console.error(`[handleOnRouteFound] Error processing route ${createdRoute.routeName}:`, error);
            // Still add the route with default values
            createdRoute.score = 5.0;
            createdRoute.environmentScore = 5.0;
            createdRoute.poiScore = 5.0;

            const existingRouteIndex = allRoutes.findIndex(r => r.routingControl === createdRoute.routingControl);
            if (existingRouteIndex === -1) {
                allRoutes.push(createdRoute);
            }
        }
    }

    // Select the best route based on scores
    function selectBestRoute(routes, condition) {
        // Ensure all routes have valid scores
        routes.forEach(route => {
            if (route.score === undefined || route.score === null) {
                route.score = 5.0; // Default score if undefined
            }
        });

        // Get the route with the highest score
        let bestRoute = routes[0];
        for (let i = 1; i < routes.length; i++) {
            // Safely compare scores, handling potential undefined values
            const currentScore = parseFloat(routes[i].score) || 0;
            const bestScore = parseFloat(bestRoute.score) || 0;

            if (currentScore > bestScore) {
                bestRoute = routes[i];
            }
        }

        console.log(`[selectBestRoute] Selected best route: ${bestRoute.routeName}, Score: ${bestRoute.score}`);
        return bestRoute;
    }

    try { // TOP-LEVEL TRY BLOCK FOR THE ENTIRE ROUTE FUNCTION

        // Initializations and Validations
        if (GenericUtils.checkIfAnyNaN(
            waypointInputs.start.lat, waypointInputs.start.lon,
            waypointInputs.end.lat, waypointInputs.end.lon
        )) {
            toastr.error("Invalid start or end point coordinates.");
            return;
        }

        startLat = parseFloat(waypointInputs.start.lat);
        startLon = parseFloat(waypointInputs.start.lon);
        endLat = parseFloat(waypointInputs.end.lat);
        endLon = parseFloat(waypointInputs.end.lon);

        if (isNaN(startLat) || isNaN(startLon) || isNaN(endLat) || isNaN(endLon)) {
            toastr.error("Parsed coordinates are invalid.");
            return;
        }

        // Clear existing routes and UI elements from the map
        if (currentRouting.routingControl && map.hasLayer(currentRouting.routingControl)) {
            try { map.removeControl(currentRouting.routingControl); } catch (e) { console.warn("Error removing main RC"); }
        }
        if (currentRouting.routingControls && Array.isArray(currentRouting.routingControls)) {
            currentRouting.routingControls.forEach(control => {
                if (control && map.hasLayer(control)) try { map.removeControl(control); } catch (e) { console.warn("Error removing array RC");}
            });
            currentRouting.routingControls = [];
        }
        clearRouteSelectorContainer();
        if (window.routeInfoLabels) {
            window.routeInfoLabels.forEach(l => { if (l && l._map) map.removeLayer(l); });
            window.routeInfoLabels = [];
        }

        var waypoints = [L.latLng(startLat, startLon), L.latLng(endLat, endLon)];
        // Don't show loading screen here if it's already shown by routing.js
        // LoadingScreen.show(document, `Calculating ${currentPatientCondition.isPatientMode ? currentPatientCondition.name + ' optimized' : ''} route...`); // Show loading screen before async operations

        try {
            console.log("[route-async-block] Async processing begins.");

            if (currentPatientCondition.isPatientMode) {
                console.log(`[route-async-block] Generating alternative routes for ${currentPatientCondition.name} condition`);
                numberOfRoutes = Math.min(3, numberOfRoutes);
            } else {
                numberOfRoutes = Math.min(2, numberOfRoutes);
            }
            toastr.info(`Calculating optimal ${currentPatientCondition.name} route...`);

            const routePromises = []; // Define routePromises here

            if (currentPatientCondition.isPatientMode) {
                const routePatterns = await generateConditionSpecificRoutes(
                    currentPatientCondition, waypointInputs, additionalInfos.transportMode, currentPreferences
                );
                console.log("[route-async-block] Generated route patterns:", routePatterns);
                if (!routePatterns || routePatterns.length === 0) {
                    console.error("[route-async-block] No valid route patterns generated.");
                    throw new Error("No route patterns generated for patient mode.");
                }

                // Direct Route Promise
                routePromises.push(new Promise(async (resolveRoutePromise) => {
	                    const directRouteControl = L.Routing.control({
	                        waypoints,
                            show: false,
	                        router: createMapboxRouter('walking'),
	                        createMarker: function() { return null; },
                            lineOptions: {
                                styles: getRouteLineStyles({ isDirectRoute: true }, false),
                                missingRouteTolerance: 100
                            }
	                    });

                    // Explicitly add to map first
                    directRouteControl.addTo(map);
                    currentRouting.routingControls.push(directRouteControl);

                    directRouteControl.on('routesfound', (e) => {
                        console.log("[route-async-block] Direct route found.");
                        const createdRoute = {
                            routeName: "Direct Route",
                            isDirectRoute: true, // Mark as direct
                            ...GenericUtils.createRoute(waypointInputs.start, waypointInputs.end),
                            routingControl: directRouteControl
                        };
                        handleOnRouteFound(e, directRouteControl, createdRoute, waypoints); // Pass 'waypoints'
                        resolveRoutePromise(true);
                    });
                    directRouteControl.on('routingerror', (e) => { console.error("Direct route error:", e); resolveRoutePromise(false); });
                    directRouteControl.route();
                }));

                // Alternate Routes Promises
                for (let i = 1; i < routePatterns.length && routePromises.length < numberOfRoutes; i++) { // Ensure we use pattern index and respect numberOfRoutes
                    if (!routePatterns[i]) continue;
                    routePromises.push(new Promise(async (resolveRoutePromise) => {
                        const pattern = routePatterns[i];
                        const altRouteWaypointsForControl = pattern.waypoints.map(wp => L.latLng(wp.lat, wp.lon));

                        const altRouteControl = L.Routing.control({
                            waypoints: altRouteWaypointsForControl,
                            show: false,
                            router: createMapboxRouter('walking'),
	                            createMarker: function() { return null; },
	                            lineOptions: {
	                                styles: getRouteLineStyles({ isDirectRoute: false }, false),
                                    missingRouteTolerance: 100
	                            }
	                        });

                        // Explicitly add to map first
                        altRouteControl.addTo(map);
                        currentRouting.routingControls.push(altRouteControl);

                        altRouteControl.on('routesfound', (e) => {
                            console.log(`[route-async-block] Alt route ${pattern.name} found.`);
                            const createdRoute = {
                                routeName: pattern.name,
                                isDirectRoute: false, // Mark as not direct
                                ...GenericUtils.createRoute(waypointInputs.start, waypointInputs.end),
                                routingControl: altRouteControl
                            };
                            handleOnRouteFound(e, altRouteControl, createdRoute, altRouteWaypointsForControl); // Pass 'altRouteWaypointsForControl'
                            resolveRoutePromise(true);
                        });
                        altRouteControl.on('routingerror', (e) => { console.error(`Alt route ${pattern.name} error:`, e); resolveRoutePromise(false); });
                        altRouteControl.route();
                    }));
                }

            } else { // Non-patient mode
                routePromises.push(new Promise((resolveRoutePromise) => {
                    const directRouteControl = L.Routing.control({
                        waypoints,
                        show: false,
                        router: createMapboxRouter(additionalInfos.transportMode || 'walking'),
	                        createMarker: function() { return null; },
	                        lineOptions: {
	                            styles: getRouteLineStyles({ isDirectRoute: true }, false),
                                missingRouteTolerance: 100
	                        }
	                    });

                    directRouteControl.addTo(map);
                    currentRouting.routingControls.push(directRouteControl);

                    directRouteControl.on('routesfound', async (e) => {
                        console.log("[route-async-block] Non-patient direct route found.");
                        const createdRoute = {
                            routeName: "Direct Route",
                            isDirectRoute: true, // Mark as direct
                            ...GenericUtils.createRoute(waypointInputs.start, waypointInputs.end),
                            routingControl: directRouteControl
                        };
                        await handleOnRouteFound(e, directRouteControl, createdRoute, waypoints); // Pass 'waypoints'
                        resolveRoutePromise(true);
                    });

                    directRouteControl.on('routingerror', (e) => {
                        console.error("Non-patient direct route error:", e);
                        resolveRoutePromise(false);
                    });

                    directRouteControl.route();
                }));
            }

            await Promise.all(routePromises);
            console.log("[route-async-block] All route generation promises resolved. Total routes in allRoutes after processing:", allRoutes.length);

	            if (allRoutes.length === 0) {
	                console.warn("[route-async-block] No valid routes were created (allRoutes is empty).");
	                throw new Error("No routes generated by async block and processed by handleOnRouteFound.");
	            }

                deduplicateRoutesForComparison(allRoutes, map, currentRouting);
	            currentRoute = selectBestRoute(allRoutes, currentPatientCondition);
	            if (!currentRoute) {
                console.warn("[route-async-block] selectBestRoute did not return a valid route. Using first available from allRoutes.");
                currentRoute = allRoutes.length > 0 ? allRoutes[0] : null;
                if (!currentRoute) {
                    console.error("[route-async-block] Critical error: No best route and allRoutes is empty after attempting selection.");
                    throw new Error("No best route selectable and allRoutes is empty after selection attempt.");
                }
            }

            console.log("[route-async-block] Best route selected:", currentRoute.routeName, "Score:", currentRoute.score);

            // Display routes in UI instead of calling the problematic displayBestRoute function
            showBestRoute();

            // A local function to show the best route
            function showBestRoute() {
                console.log(`[route] Displaying ${allRoutes.length} routes with best route: ${currentRoute?.routeName || 'Unknown'}`);

                // Apply styling to each route but don't control visibility here
                // (visibility will be managed by setupRouteControlPanel radio buttons)
	                allRoutes.forEach(route => {
	                    if (route.routingControl) {
	                        const isBest = (route === currentRoute);
                            route.isBest = isBest;

	                        try {
	                            // Set line style only - don't control visibility here
	                            if (route.routingControl._container) {
                                    syncRoutingControlLineOptions(route, isBest);

	                                // Don't hide/show containers here - let radio buttons handle this
	                                // The setupRouteControlPanel will manage visibility
                            }
                        } catch (error) {
                            console.error(`[route] Error styling route: ${error.message}`);
                        }
                    }
                });

	                // Let the setupRouteControlPanel function handle the control panel creation
	                // and route visibility management
	                setupRouteControlPanel(map, allRoutes, currentRouting, currentPatientCondition, currentPreferences, csvData);

                // Hide loading screen immediately after routes are displayed
                LoadingScreen.hide(document);
                console.log("[route] LoadingScreen hidden after setupRouteControlPanel");
            }

        } catch (errorInAsyncBlock) {
            console.error("[route] Error during async route generation/processing block:", errorInAsyncBlock);
            // Hide loading screen on error
            LoadingScreen.hide(document);
            displayFallbackRoute(map, currentRouting, waypointInputs, additionalInfos, startLat, startLon, endLat, endLon);
        }

    } catch (errorInMainRouteFunction) { // Catches errors from the main setup, or if rethrown from async block
        console.error("[route] Error in main function execution (outside async block):", errorInMainRouteFunction);
        displayFallbackRoute(map, currentRouting, waypointInputs, additionalInfos, startLat, startLon, endLat, endLon);
    } finally { // TOP-LEVEL FINALLY BLOCK
        LoadingScreen.hide(document); // Always hide loading screen
        if (Environmental.finalizeRouteCalculation) {
            console.log("[route] Calling Environmental.finalizeRouteCalculation() in main finally block.");
            Environmental.finalizeRouteCalculation();
        } else {
            console.warn("[route] Environmental.finalizeRouteCalculation is not defined in main finally block!");
        }

        // CRITICAL FIX: Ensure routes are always added to csvData
        console.log("[route] Adding routes to csvData in finally block, routes count:", allRoutes.length);

	        // Force direct addition to window.csvData to guarantee it works
	        if (allRoutes && allRoutes.length > 0) {
	            if (!window.csvData) {
	                window.csvData = [];
	            }
                deduplicateRoutesForComparison(allRoutes, map, currentRouting);

	            // Add each route directly to window.csvData
	            allRoutes.forEach((route, index) => {
	                if (!route.startPoint) route.startPoint = waypointInputs.start;
	                if (!route.endPoint) route.endPoint = waypointInputs.end;

                // Generate route data
                const routeData = collectRouteAnalyticsData(
                    {
                        ...route,
                        startPoint: waypointInputs.start,
                        endPoint: waypointInputs.end,
                        transportMode: additionalInfos.transportMode || 'walking'
                    },
                    currentPatientCondition,
                    currentPreferences,
	                    index
	                );

                    addRouteDataToCsv(routeData, window.csvData, 'route');
	            });

            // Show a notification
            toastr.success(`${allRoutes.length} routes collected. Total in CSV: ${window.csvData.length}`);

            // Update the download button
            if (typeof window.updateDownloadButtonText === 'function') {
                window.updateDownloadButtonText();
            }
        } else {
            console.warn("[route] No routes available to add to csvData in finally block");
        }

        console.log("[route] Main route function execution complete (including finally block).");
    }
}

// New helper function to create minimal POI data
function createMinimalPOIData() {
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
        quietAreaCount: 2
    };
}

/**
 * Route with pre-calculated routes from A* algorithm
 * This function handles routes that were already calculated by the A* algorithm
 */
async function routeWithPrecalculatedRoutes(
    currentRouting,
    currentPreferences,
    currentPatientCondition,
    waypointInputs,
    additionalInfos,
    map,
    document,
    csvData
) {
    try {
        console.log("[routeWithPrecalculatedRoutes] Processing pre-calculated routes. Condition:", currentPatientCondition ? currentPatientCondition.name : 'N/A');

        if (Environmental.startRouteCalculation) {
            Environmental.startRouteCalculation();
        }

        // Clear existing routes first
        if (currentRouting.routingControls && Array.isArray(currentRouting.routingControls)) {
            currentRouting.routingControls.forEach(control => {
                if (control && map.hasLayer(control)) {
                    try { map.removeControl(control); } catch (e) { console.warn("Error removing control:", e); }
                }
            });
            currentRouting.routingControls = [];
        }

        const preCalculatedRoutes = additionalInfos.preCalculatedRoutes;
        const allRoutes = [];

        console.log(`[routeWithPrecalculatedRoutes] Processing ${preCalculatedRoutes.length} pre-calculated routes`);

        // Create Leaflet routing controls for each pre-calculated route
        for (let i = 0; i < preCalculatedRoutes.length; i++) {
            const route = preCalculatedRoutes[i];

            console.log(`[routeWithPrecalculatedRoutes] Processing route ${i+1}: ${route.name}`);

            // Create waypoints from route data
            const waypoints = route.waypoints.map(wp => L.latLng(wp.lat, wp.lon));

	            // Create routing control
                const initialRouteStyle = getRouteLineStyles({ isDirectRoute: false }, i === 0);

	            const routingControl = L.Routing.control({
	                waypoints: waypoints,
	                routeWhileDragging: false,
	                fitSelectedRoutes: true,
                    show: false,
	                showAlternatives: false,
	                lineOptions: {
	                    styles: initialRouteStyle,
	                    missingRouteTolerance: 100
	                },
                router: createMapboxRouter(additionalInfos.transportMode || 'walking'),
                createMarker: function() { return null; }
            });

            // DO NOT add to map here. setupRouteControlPanel will handle it.
            // DO NOT push to currentRouting.routingControls here. setupRouteControlPanel will handle it.

            // Generate synthetic environmental data if not present
            let environmentDataList = [];

            // If we're missing environmental data, create synthetic data
            if (!route.environmentDataList || route.environmentDataList.length === 0) {
                console.log(`[routeWithPrecalculatedRoutes] Generating synthetic environmental data for route ${i+1}`);

                // Create synthetic environmental data for this route
                environmentDataList = createLocationBasedEnvironmentalData(
                    route.coordinates || [
                        { lat: waypointInputs.start.lat, lng: waypointInputs.start.lon },
                        { lat: waypointInputs.end.lat, lng: waypointInputs.end.lon }
                    ],
                    20 // Generate 20 data points along the route
                );
            } else {
                // Use existing environmental data
                environmentDataList = route.environmentDataList;
                console.log(`[routeWithPrecalculatedRoutes] Using existing environmental data for route ${i+1}: ${environmentDataList.length} points`);
            }

            // Normalize the environment score to a 0-10 scale
            // Default to 5.0 if score is invalid (Infinity, NaN, etc.)
            let normalizedScore = 5.0;
            const originalAStarCost = route.environmentalScore; // Preserve the raw A* cost

            if (route.environmentalScore !== undefined &&
                isFinite(route.environmentalScore) &&
                !isNaN(route.environmentalScore)) {
                // Convert to a 0-10 scale where lower original score is better
                normalizedScore = Math.max(0, Math.min(10, 10 - (route.environmentalScore / 50)));
        } else {
                console.log(`[routeWithPrecalculatedRoutes] Invalid environmentalScore (${route.environmentalScore}), using default 5.0`);
            }

            // Create route object with all data
            const routeObject = {
                routeName: route.name || `Route ${i+1}`,
                name: route.name || `Route ${i+1}`,
                description: route.description || "",
                routingControl: routingControl,
                score: normalizedScore, // This is the normalized score for general use
                environmentScore: normalizedScore, // Also use normalized for consistency in other parts
                rawAStarScore: originalAStarCost, // Store the original A* cost for panel display
                poiScore: 5.0,
                specializedPoiScore: 5.0,
                startPoint: waypointInputs.start,
                endPoint: waypointInputs.end,
                transportMode: additionalInfos.transportMode,
                waypoints: waypoints, // These are L.LatLng objects already
                originalWaypoints: waypoints, // Store L.LatLng waypoints here as well
                coordinates: route.coordinates || waypoints.map(wp => ({ lat: wp.lat, lng: wp.lng })),
                length: route.length || 1000,
                shortestLength: route.shortestLength || route.length || 1000,
                environmentDataList: environmentDataList, // Add the environmental data
                isBest: i === 0, // Explicitly mark first route as best
                removedFromMap: false // All routes will be on the map, styled by setupRouteControlPanel
            };

            // Generate POI counts if missing
            if (!routeObject.poiCounts) {
                routeObject.poiCounts = {
                    natureCount: 2 + Math.floor(Math.random() * 3),
                    entertainmentCount: 1 + Math.floor(Math.random() * 2),
                    nightlifeCount: Math.floor(Math.random() * 2),
                    tourismCount: 1 + Math.floor(Math.random() * 2),
                    hospitalCount: Math.floor(Math.random() * 2),
                    restingAreaCount: 1 + Math.floor(Math.random() * 3),
                    parkBenchCount: 2 + Math.floor(Math.random() * 4),
                    flatPathwayCount: 1 + Math.floor(Math.random() * 3)
                };
            }

            // === Dynamic POI scoring ===
            try {
                // Map env data to coordinate structure expected by the scoring util
                const mappedEnv = mapEnvironmentalDataToCoordinates(routeObject.environmentDataList, routeObject.coordinates);
                const scoreRes = await Scores.calculateAllScores(
                    routeObject.poiCounts,
                    mappedEnv,
                    currentPreferences,
                    currentPatientCondition
                );

                if (scoreRes && typeof scoreRes.poiScore === 'number') {
                    routeObject.poiScore = scoreRes.poiScore;
                    routeObject.specializedPoiScore = scoreRes.specializedPoiScore;
                    // Optionally keep total / env scores intact – objective is only POI
                } else {
                    console.warn('[routeWithPrecalculatedRoutes] calculateAllScores returned invalid POI data – keeping default values');
                }
            } catch (scoreErr) {
                console.warn('[routeWithPrecalculatedRoutes] Failed to calculate dynamic POI score:', scoreErr);
            }

            // Store in array
            allRoutes.push(routeObject);

	            // Add to CSV data
                const routeExportData = collectRouteAnalyticsData(
                    routeObject,
                    currentPatientCondition,
                    currentPreferences,
                    i
                );
                addRouteDataToCsv(routeExportData, csvData, 'routeWithPrecalculatedRoutes');
	        }

            deduplicateRoutesForComparison(allRoutes, map, currentRouting);
	        console.log(`[routeWithPrecalculatedRoutes] Created ${allRoutes.length} routes, control panel setup will manage map addition.`);

	        // Set up route control panel
	        setupRouteControlPanel(map, allRoutes, currentRouting, currentPatientCondition, currentPreferences, csvData);

        toastr.success(`Generated ${allRoutes.length} routes using A* algorithm for ${currentPatientCondition.name} condition`);
        if (typeof window.updateDownloadButtonText === 'function') window.updateDownloadButtonText();
        return true;
    } catch (error) {
        console.error("[routeWithPrecalculatedRoutes] Error processing pre-calculated routes:", error);
        toastr.error("Error processing routes");
        return false;
    } finally {
        if (Environmental.finalizeRouteCalculation) Environmental.finalizeRouteCalculation();
    }
}

// New helper function to safely map environmental data to coordinates
function mapEnvironmentalDataToCoordinates(environmentDataList, coordinates) {
    if (!environmentDataList || environmentDataList.length === 0 || !coordinates || coordinates.length === 0) {
        console.warn("[mapEnvironmentalDataToCoordinates] Missing data, returning empty array");
        return [];
    }

    return environmentDataList.map((env, index) => {
        // Find corresponding coordinate, using last point if we run out
        const coordinate = index < coordinates.length ?
            coordinates[index] :
            coordinates[coordinates.length - 1];

        return {
            lat: coordinate?.lat || 0,
            lon: coordinate?.lng || 0,
            environmentData: env
        };
    });
}

export {
    route,
    collectRouteAnalyticsData,
    renderDirectionsSidebar,
    openDirectionsSidebar
}
