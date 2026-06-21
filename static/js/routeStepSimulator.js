/**
 * Route Step Simulator
 *
 * Standalone, self-contained module that animates a cursor along a route,
 * one turn-by-turn step at a time, while exposing hooks to highlight the
 * active step in a directions sidebar.
 *
 * Contract:
 *   window.RouteStepSimulator = { start(options), stop() }
 */
(function (global) {
  'use strict';

  const L = global.L;
  const ROUTE_PREVIEW_FOLLOW_ZOOM = 17;
  const ROUTE_PREVIEW_CAMERA_THROTTLE_MS = 80;
  const ROUTE_PREVIEW_MIN_TOTAL_MS = 8000;
  const ROUTE_PREVIEW_MAX_TOTAL_MS = 45000;
  const MIN_STEP_DURATION_MS = 1500;
  const MAX_STEP_DURATION_MS = 10000;

  let activeRun = null;

  // --------------------------------------------------------------------------
  // Coordinate / geometry helpers (copied/adapted from routes.js)
  // --------------------------------------------------------------------------

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
      if (
        Array.isArray(coordinate) &&
        coordinate.length > 0 &&
        (Array.isArray(coordinate[0]) || typeof coordinate[0] === 'object')
      ) {
        flattened.push(...flattenCoordinateList(coordinate));
      } else {
        flattened.push(coordinate);
      }
      return flattened;
    }, []);
  }

  function getRouteLineLayer(route) {
    if (!route || !route.routingControl) {
      return null;
    }

    if (
      route.routingControl._routes &&
      route.routingControl._routes.length > 0 &&
      route.routingControl._routes[0].line
    ) {
      return route.routingControl._routes[0].line;
    }

    return route.routingControl._line || null;
  }

  function getRouteCoordinates(route) {
    if (!route) {
      return [];
    }

    const routeLine = getRouteLineLayer(route);
    const lineCoordinates =
      routeLine && typeof routeLine.getLatLngs === 'function'
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

    const fullGeometry = candidates.find((coordinates) => coordinates.length > 2);
    if (fullGeometry) {
      return fullGeometry;
    }

    return candidates.find((coordinates) => coordinates.length > 1) || [];
  }

  function coordinatesNearlyEqual(a, b) {
    return Math.abs(a - b) < 1e-9;
  }

  function normalizeRoutePreviewPath(route) {
    const coordinates = getRouteCoordinates(route);
    const path = [];

    coordinates
      .map(coordinateToLatLon)
      .filter(Boolean)
      .forEach(({ lat, lon }) => {
        const previous = path[path.length - 1];
        if (
          previous &&
          coordinatesNearlyEqual(previous.lat, lat) &&
          coordinatesNearlyEqual(previous.lng, lon)
        ) {
          return;
        }

        path.push(L && typeof L.latLng === 'function' ? L.latLng(lat, lon) : { lat, lng: lon });
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

    if ([startLat, startLon, endLat, endLon].some((value) => value === null)) {
      return 0;
    }

    const earthRadiusMeters = 6371000;
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const deltaLat = toRadians(endLat - startLat);
    const deltaLon = toRadians(endLon - startLon);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(toRadians(startLat)) *
        Math.cos(toRadians(endLat)) *
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
        const segmentProgress = Math.max(
          0,
          Math.min(1, (targetDistance - distanceSoFar) / segmentLength)
        );
        const lat = segmentStart.lat + (segmentEnd.lat - segmentStart.lat) * segmentProgress;
        const startLon = getLatLngLongitude(segmentStart);
        const endLon = getLatLngLongitude(segmentEnd);
        const lng = startLon + (endLon - startLon) * segmentProgress;

        return L && typeof L.latLng === 'function' ? L.latLng(lat, lng) : { lat, lng };
      }

      distanceSoFar += segmentLength;
    }

    return path[path.length - 1];
  }

  function createRoutePreviewIcon() {
    if (!L || typeof L.divIcon !== 'function') {
      return null;
    }

    return L.divIcon({
      className: 'route-preview-cursor',
      html: '<span class="route-preview-cursor-core" aria-hidden="true"></span>',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
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

  function focusRoutePreviewCamera(map, latLng, timestamp, force, run) {
    if (!map || !latLng || !run.followCamera) {
      return;
    }

    const frameTime = Number.isFinite(timestamp) ? timestamp : Date.now();
    if (!force && frameTime - run.lastCameraUpdateAt < ROUTE_PREVIEW_CAMERA_THROTTLE_MS) {
      return;
    }

    run.lastCameraUpdateAt = frameTime;
    const followZoom = run.followZoom ?? getRoutePreviewFollowZoom(map);
    run.followZoom = followZoom;
    const currentZoom = typeof map.getZoom === 'function' ? Number(map.getZoom()) : followZoom;
    const shouldZoom =
      force || !Number.isFinite(currentZoom) || Math.abs(currentZoom - followZoom) > 0.25;

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

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // --------------------------------------------------------------------------
  // Step extraction and path splitting
  // --------------------------------------------------------------------------

  function getRouteDirectionSteps(route) {
    const routeControl = route?.routingControl;
    const candidates = [
      route?.instructions,
      route?.route?.instructions,
      routeControl?._selectedRoute?.instructions,
      routeControl?._routes?.[0]?.instructions
    ];

    const instructionList = candidates.find(
      (candidate) => Array.isArray(candidate) && candidate.length > 0
    );
    if (instructionList) {
      return instructionList;
    }

    const legs =
      route?.route?.legs ||
      route?.legs ||
      routeControl?._selectedRoute?.legs ||
      routeControl?._routes?.[0]?.legs;
    if (Array.isArray(legs)) {
      return legs.flatMap((leg) => (Array.isArray(leg?.steps) ? leg.steps : []));
    }

    return [];
  }

  function parseStepLocation(step) {
    if (!step) {
      return null;
    }

    const loc = step.maneuver?.location ?? step.location;
    if (!loc) {
      return null;
    }

    // {lat, lng} / {lat, lon} object
    if (typeof loc.lat === 'number' || typeof loc.latitude === 'number') {
      const lat = parseCoordinateValue(loc.lat ?? loc.latitude);
      const lon = parseCoordinateValue(loc.lng ?? loc.lon ?? loc.longitude);
      if (lat !== null && lon !== null) {
        return { lat, lng: lon };
      }
    }

    // Array, typically [lon, lat] (Mapbox / OSRM style)
    if (Array.isArray(loc) && loc.length >= 2) {
      const parsed = coordinateToLatLon(loc);
      if (parsed) {
        return { lat: parsed.lat, lng: parsed.lon };
      }
    }

    return null;
  }

  function findNearestPathIndex(path, target, minIndex, maxIndex) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    const end = Number.isInteger(maxIndex) ? Math.min(maxIndex, path.length - 1) : path.length - 1;

    for (let i = Math.max(0, minIndex); i <= end; i++) {
      const d = distanceBetweenLatLngs(path[i], target);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  function findPathIndexAtDistance(track, targetDistance) {
    const { path, segmentLengths } = track;
    if (targetDistance <= 0 || segmentLengths.length === 0) {
      return 0;
    }

    let distanceSoFar = 0;
    for (let i = 0; i < segmentLengths.length; i++) {
      if (distanceSoFar + segmentLengths[i] >= targetDistance) {
        return i + 1;
      }
      distanceSoFar += segmentLengths[i];
    }

    return path.length - 1;
  }

  function splitPathIntoStepSegments(path, steps) {
    const segments = [];
    if (!steps.length) {
      return segments;
    }

    const track = buildRoutePreviewTrack(path);
    const totalPathLength = track.totalLength;
    const totalStepDistance = steps.reduce(
      (sum, step) => sum + (Number.isFinite(step?.distance) && step.distance > 0 ? step.distance : 0),
      0
    );
    const hasReliableDistances = totalStepDistance > 0 && totalPathLength > 0;

    const splitIndices = [0];
    let lastIndex = 0;
    let stepDistanceSoFar = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let locIndex = -1;

      if (hasReliableDistances && Number.isFinite(step?.distance) && step.distance > 0) {
        stepDistanceSoFar += step.distance;
        const targetDistance = (stepDistanceSoFar / totalStepDistance) * totalPathLength;
        locIndex = findPathIndexAtDistance(track, targetDistance);
      }

      const location = parseStepLocation(step);
      if (location) {
        const searchWindow = 6;
        const searchStart = Math.max(lastIndex, locIndex >= 0 ? locIndex - searchWindow : lastIndex);
        const searchEnd = locIndex >= 0
          ? Math.min(path.length - 1, locIndex + searchWindow)
          : path.length - 1;
        const nearestIndex = findNearestPathIndex(path, location, searchStart, searchEnd);
        if (nearestIndex >= 0) {
          locIndex = nearestIndex;
        }
      } else if (
        locIndex < 0 &&
        Number.isInteger(step?.index) &&
        step.index >= lastIndex &&
        step.index < path.length
      ) {
        locIndex = step.index;
      }

      if (locIndex < 0) {
        // Fallback: distribute remaining indices evenly across remaining steps.
        const remainingSteps = steps.length - i;
        const available = Math.max(0, path.length - 1 - lastIndex);
        locIndex = lastIndex + Math.max(0, Math.round(available / remainingSteps));
      }

      locIndex = Math.max(lastIndex, Math.min(path.length - 1, locIndex));

      // Non-final steps must advance at least one path point so every step has
      // a meaningful segment to animate over.
      if (locIndex <= lastIndex && i < steps.length - 1) {
        locIndex = Math.min(lastIndex + 1, path.length - 1);
      }

      splitIndices.push(locIndex);
      lastIndex = locIndex;
    }

    // Ensure the final step reaches the end of the path.
    splitIndices[splitIndices.length - 1] = path.length - 1;

    for (let i = 0; i < steps.length; i++) {
      const start = splitIndices[i];
      const end = splitIndices[i + 1];
      let segmentPath = path.slice(start, end + 1);

      if (segmentPath.length < 2) {
        const fallbackPoint = segmentPath[0] || path[path.length - 1] || path[0];
        segmentPath = [fallbackPoint, fallbackPoint];
      }

      segments.push({ path: segmentPath });
    }

    return segments;
  }

  // --------------------------------------------------------------------------
  // Lifecycle helpers
  // --------------------------------------------------------------------------

  function removeMarker(run) {
    if (!run || !run.marker) {
      return;
    }

    try {
      if (run.map && typeof run.map.hasLayer === 'function' && run.map.hasLayer(run.marker)) {
        run.map.removeLayer(run.marker);
      } else if (typeof run.marker.remove === 'function') {
        run.marker.remove();
      }
    } catch (error) {
      console.warn('[RouteStepSimulator] Error removing preview marker:', error);
    }
  }

  function leaveCurrentStep(run) {
    if (run.enteredStepIndex >= 0 && typeof run.onStepLeave === 'function') {
      const item = run.items[run.enteredStepIndex];
      try {
        run.onStepLeave(run.enteredStepIndex, item);
      } catch (error) {
        console.warn('[RouteStepSimulator] onStepLeave error:', error);
      }
    }
    run.enteredStepIndex = -1;
  }

  function enterStep(run, index) {
    run.currentStepIndex = index;
    run.enteredStepIndex = index;
    if (typeof run.onStepEnter === 'function') {
      const item = run.items[index];
      try {
        run.onStepEnter(index, item);
      } catch (error) {
        console.warn('[RouteStepSimulator] onStepEnter error:', error);
      }
    }
  }

  function cleanupRun(run) {
    if (!run) {
      return;
    }

    if (run.animationFrame !== null && typeof global.cancelAnimationFrame === 'function') {
      global.cancelAnimationFrame(run.animationFrame);
    }

    removeMarker(run);
    run.animationFrame = null;
    run.marker = null;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  function start(options) {
    stop();

    const {
      map,
      route,
      directionsListElement,
      stepDurationMs = 15000,
      speedMps,
      followCamera = true,
      onStepEnter,
      onStepLeave,
      onDone
    } = options || {};

    if (!map || !L || typeof L.marker !== 'function') {
      console.warn('[RouteStepSimulator] Leaflet map is not available.');
      return false;
    }

    const path = normalizeRoutePreviewPath(route);
    if (path.length < 2) {
      console.warn('[RouteStepSimulator] Route has insufficient geometry for a step preview.');
      return false;
    }

    const steps = getRouteDirectionSteps(route);
    if (!steps.length) {
      console.warn('[RouteStepSimulator] No turn-by-turn instructions found for this route.');
      return false;
    }

    const segments = splitPathIntoStepSegments(path, steps);
    if (!segments.length) {
      console.warn('[RouteStepSimulator] Could not split route into step segments.');
      return false;
    }

    let totalLength = 0;
    segments.forEach((segment) => {
      segment.track = buildRoutePreviewTrack(segment.path);
      segment.startDistance = totalLength;
      totalLength += segment.track.totalLength;
    });

    let totalDurationMs;
    if (typeof speedMps === 'number' && speedMps > 0 && totalLength > 0) {
      totalDurationMs = (totalLength / speedMps) * 1000;
    } else {
      totalDurationMs = stepDurationMs * segments.length;
    }
    totalDurationMs = Math.max(
      ROUTE_PREVIEW_MIN_TOTAL_MS,
      Math.min(ROUTE_PREVIEW_MAX_TOTAL_MS, totalDurationMs)
    );

    const items = directionsListElement
      ? Array.from(directionsListElement.querySelectorAll('.directions-step'))
      : [];

    const icon = createRoutePreviewIcon();
    const markerOptions = {
      interactive: false,
      keyboard: false,
      zIndexOffset: 1200
    };
    if (icon) {
      markerOptions.icon = icon;
    }

    const marker = L.marker(path[0], markerOptions).addTo(map);

    const run = {
      map,
      marker,
      followCamera,
      totalDurationMs,
      totalLength,
      segments,
      items,
      onStepEnter,
      onStepLeave,
      onDone,
      currentStepIndex: 0,
      enteredStepIndex: -1,
      stepStartTime: 0,
      animationFrame: null,
      followZoom: null,
      lastCameraUpdateAt: 0
    };

    activeRun = run;

    const requestFrame =
      typeof global.requestAnimationFrame === 'function'
        ? global.requestAnimationFrame.bind(global)
        : (callback) => global.setTimeout(() => callback(Date.now()), 16);

    enterStep(run, 0);

    const startTime =
      typeof global.performance?.now === 'function' ? global.performance.now() : Date.now();
    run.stepStartTime = startTime;
    focusRoutePreviewCamera(map, path[0], startTime, true, run);

    function findSegmentIndexAtDistance(targetDistance) {
      for (let i = 0; i < run.segments.length; i++) {
        const segment = run.segments[i];
        if (targetDistance >= segment.startDistance && targetDistance <= segment.startDistance + segment.track.totalLength) {
          return i;
        }
      }
      return run.segments.length - 1;
    }

    const animate = (timestamp) => {
      if (!activeRun || activeRun !== run) {
        return;
      }

      const elapsed = timestamp - run.stepStartTime;
      const globalProgress = Math.max(0, Math.min(1, elapsed / run.totalDurationMs));
      const targetDistance = run.totalLength * globalProgress;
      const segmentIndex = findSegmentIndexAtDistance(targetDistance);
      const segment = run.segments[segmentIndex];
      const segmentDistance = targetDistance - segment.startDistance;
      const previewPosition = interpolateRoutePreviewPosition(segment.track, segmentDistance);

      if (segmentIndex !== run.currentStepIndex) {
        leaveCurrentStep(run);
        enterStep(run, segmentIndex);
      }

      run.marker.setLatLng(previewPosition);
      focusRoutePreviewCamera(map, previewPosition, timestamp, false, run);

      if (globalProgress < 1) {
        run.animationFrame = requestFrame(animate);
        return;
      }

      run.animationFrame = null;
      leaveCurrentStep(run);
      if (typeof run.onDone === 'function') {
        try {
          run.onDone();
        } catch (error) {
          console.warn('[RouteStepSimulator] onDone error:', error);
        }
      }
    };

    run.animationFrame = requestFrame(animate);
    return true;
  }

  function stop() {
    if (!activeRun) {
      return;
    }

    leaveCurrentStep(activeRun);
    cleanupRun(activeRun);
    activeRun = null;
  }

  global.RouteStepSimulator = { start, stop };
})(globalThis);
