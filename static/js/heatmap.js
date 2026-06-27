document.addEventListener("DOMContentLoaded", function() {
    var map = window.map;
    if (!map) {
        console.error('[heatmap] Leaflet map not available');
        return;
    }

    var markers = L.markerClusterGroup();

    var allStationMarkers = {};
    var activeLayerIds = new Set();
    var pendingAirLayerIds = new Set();

    var heatLayers = {};
    var layerMarkers = {};
    var layerStates = {};
    var layerStatusElement = document.getElementById('layerStatus');
    var layerLegendElement = document.getElementById('layerLegend');

    var AIR_LAYER_IDS = ['pm25', 'pm10', 'no2', 'o3'];
    var ALL_LAYER_IDS = AIR_LAYER_IDS.concat(['pollen']);

    var HEAT_GRADIENT = {
        0.0: '#38bdf8',
        0.35: '#22c55e',
        0.62: '#f59e0b',
        0.82: '#ef4444',
        1.0: '#7f1d1d'
    };

    var AIR_GRADIENT_STOPS = [
        { color: '#38bdf8', position: '0%' },
        { color: '#22c55e', position: '35%' },
        { color: '#f59e0b', position: '62%' },
        { color: '#ef4444', position: '82%' },
        { color: '#7f1d1d', position: '100%' }
    ];

    var POLLEN_GRADIENT_STOPS = [
        { color: '#d9f99d', position: '0%' },
        { color: '#84cc16', position: '25%' },
        { color: '#eab308', position: '50%' },
        { color: '#f97316', position: '75%' },
        { color: '#a16207', position: '100%' }
    ];

    var baseHeatOptions = {
        radius: 75,
        blur: 70,
        max: 1.0,
        minOpacity: 0.32,
        gradient: HEAT_GRADIENT
    };

    var pollenHeatOptions = {
        radius: 80,
        blur: 75,
        max: 1.0,
        minOpacity: 0.28,
        gradient: {
            0.0: '#d9f99d',
            0.25: '#84cc16',
            0.5: '#eab308',
            0.75: '#f97316',
            1.0: '#a16207'
        }
    };

    var LAYER_CONFIG = {
        pm25: {
            label: 'PM2.5',
            unit: 'µg/m³',
            referenceMax: 25,
            highLabel: '25+ µg/m³',
            gradientStops: AIR_GRADIENT_STOPS,
            markerColor: '#2563eb',
            emptyMessage: 'No PM2.5 readings are available in the latest station dataset.',
            meaning: 'Fine particulate matter (≤2.5 µm) that can travel deep into the lungs.',
            source: 'Real point measurements interpolated across the city view as health risk. Cooler blue/green is lower exposure; amber/red is higher exposure.'
        },
        pm10: {
            label: 'PM10',
            unit: 'µg/m³',
            referenceMax: 50,
            highLabel: '50+ µg/m³',
            gradientStops: AIR_GRADIENT_STOPS,
            markerColor: '#7c3aed',
            emptyMessage: 'No PM10 readings are available in the latest station dataset.',
            meaning: 'Inhalable particulate matter (≤10 µm), often from dust, traffic, and combustion.',
            source: 'Real point measurements interpolated across the city view as health risk. Cooler blue/green is lower exposure; amber/red is higher exposure.'
        },
        no2: {
            label: 'NO₂',
            unit: 'µg/m³',
            referenceMax: 200,
            highLabel: '200+ µg/m³',
            gradientStops: AIR_GRADIENT_STOPS,
            markerColor: '#dc2626',
            emptyMessage: 'No NO₂ readings are available in the latest station dataset.',
            meaning: 'Nitrogen dioxide, mainly tied to combustion and roadside traffic pollution.',
            source: 'Real point measurements interpolated across the city view as health risk. Cooler blue/green is lower exposure; amber/red is higher exposure.'
        },
        o3: {
            label: 'O₃',
            unit: 'µg/m³',
            referenceMax: 180,
            highLabel: '180+ µg/m³',
            gradientStops: AIR_GRADIENT_STOPS,
            markerColor: '#ea580c',
            emptyMessage: 'No O₃ readings are available in the latest station dataset.',
            meaning: 'Ground-level ozone, a secondary pollutant that often rises on sunny stagnant days.',
            source: 'Real point measurements interpolated across the city view as health risk. Cooler blue/green is lower exposure; amber/red is higher exposure.'
        },
        pollen: {
            label: 'Pollen',
            unit: 'grains/m³',
            referenceMax: 120,
            highLabel: '120+ grains/m³',
            gradientStops: POLLEN_GRADIENT_STOPS,
            markerColor: '#65a30d',
            emptyMessage: 'No pollen data is available for this area or season.',
            meaning: 'Total airborne pollen forecast near the selected start point.',
            source: 'Real Open-Meteo pollen forecast, rendered as an areal field around the selected city.'
        }
    };

    var stationDataState = {
        loading: true,
        loaded: false,
        error: null,
        stationCount: 0,
        sourceLabel: 'stations'
    };

    var AIR_SAMPLE_GRID_SIZE = 4;
    var CITY_HEAT_GRID_SIZE = 8;
    var CITY_HEAT_RADIUS_M = 7000;
    var MAX_AIR_SAMPLE_SPAN_M = 16000;

    function initializeLayerStates() {
        ALL_LAYER_IDS.forEach(function(layerId) {
            heatLayers[layerId] = null;
            layerMarkers[layerId] = [];
            layerStates[layerId] = {
                status: layerId === 'pollen' ? 'idle' : 'loading',
                count: 0,
                min: null,
                max: null,
                total: null,
                dominantLabel: null,
                message: ''
            };
        });
    }

    initializeLayerStates();

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatNumber(value) {
        var numeric = Number(value);
        if (!isFinite(numeric)) {
            return 'n/d';
        }
        var rounded = Math.round(numeric * 10) / 10;
        return Math.abs(rounded % 1) < 0.001 ? rounded.toFixed(0) : rounded.toFixed(1);
    }

    function normalizeToUnit(value, referenceMax, minVisible) {
        var numeric = Number(value);
        if (!isFinite(numeric) || numeric <= 0) {
            return 0;
        }
        return Math.max(minVisible || 0.06, Math.min(1, numeric / referenceMax));
    }

    function readMeasurement(stazione, layerId) {
        if (!stazione || stazione[layerId] === null || stazione[layerId] === undefined || stazione[layerId] === '') {
            return null;
        }
        var value = Number(stazione[layerId]);
        return isFinite(value) ? value : null;
    }

    function stationLatLng(stazione) {
        var lat = Number(stazione && stazione.lat);
        var lng = Number(stazione && stazione.lng);
        if (!isFinite(lat) || !isFinite(lng)) {
            return null;
        }
        return { lat: lat, lng: lng };
    }

    function offsetPoint(centerLat, centerLng, offsetX, offsetY) {
        var metresPerDegLng = 111000 * Math.cos(centerLat * Math.PI / 180);
        if (!isFinite(metresPerDegLng) || Math.abs(metresPerDegLng) < 1) {
            metresPerDegLng = 1;
        }
        return [
            centerLat + offsetY / 111000,
            centerLng + offsetX / metresPerDegLng
        ];
    }

    function distanceMetres(a, b) {
        var lat1 = a.lat * Math.PI / 180;
        var lat2 = b.lat * Math.PI / 180;
        var dLat = (b.lat - a.lat) * Math.PI / 180;
        var dLng = (b.lng - a.lng) * Math.PI / 180;
        var sinLat = Math.sin(dLat / 2);
        var sinLng = Math.sin(dLng / 2);
        var h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
        return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function cityBoundsAround(center, radiusM) {
        var north = offsetPoint(center.lat, center.lon, 0, radiusM);
        var south = offsetPoint(center.lat, center.lon, 0, -radiusM);
        var east = offsetPoint(center.lat, center.lon, radiusM, 0);
        var west = offsetPoint(center.lat, center.lon, -radiusM, 0);
        return {
            north: north[0],
            south: south[0],
            east: east[1],
            west: west[1]
        };
    }

    function mapBoundsAsPlainObject() {
        if (!map.getBounds) {
            return null;
        }
        var bounds = map.getBounds();
        if (!bounds || !bounds.getNorth || !bounds.getSouth || !bounds.getEast || !bounds.getWest) {
            return null;
        }
        return {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
    }

    function boundsSpanMetres(bounds) {
        var centerLat = (bounds.north + bounds.south) / 2;
        return {
            height: distanceMetres({ lat: bounds.south, lng: bounds.west }, { lat: bounds.north, lng: bounds.west }),
            width: distanceMetres({ lat: centerLat, lng: bounds.west }, { lat: centerLat, lng: bounds.east })
        };
    }

    function citySizedAirBounds() {
        var center = resolveAirLayerCenter();
        var visibleBounds = mapBoundsAsPlainObject();
        if (!visibleBounds) {
            return cityBoundsAround(center, CITY_HEAT_RADIUS_M);
        }

        var span = boundsSpanMetres(visibleBounds);
        if (span.height <= MAX_AIR_SAMPLE_SPAN_M && span.width <= MAX_AIR_SAMPLE_SPAN_M) {
            return visibleBounds;
        }
        return cityBoundsAround(center, CITY_HEAT_RADIUS_M);
    }

    function expandBounds(bounds, padRatio) {
        var latPad = Math.max((bounds.north - bounds.south) * padRatio, 0.012);
        var lngPad = Math.max((bounds.east - bounds.west) * padRatio, 0.012);
        return {
            north: bounds.north + latPad,
            south: bounds.south - latPad,
            east: bounds.east + lngPad,
            west: bounds.west - lngPad
        };
    }

    function boundsFromSourcePoints(points) {
        var bounds = null;
        points.forEach(function(point) {
            if (!bounds) {
                bounds = { north: point.lat, south: point.lat, east: point.lng, west: point.lng };
                return;
            }
            bounds.north = Math.max(bounds.north, point.lat);
            bounds.south = Math.min(bounds.south, point.lat);
            bounds.east = Math.max(bounds.east, point.lng);
            bounds.west = Math.min(bounds.west, point.lng);
        });
        return bounds;
    }

    function buildGridPoints(bounds, gridSize) {
        var points = [];
        var rows = Math.max(2, gridSize);
        var cols = Math.max(2, gridSize);
        for (var row = 0; row < rows; row++) {
            var latRatio = rows === 1 ? 0.5 : row / (rows - 1);
            var lat = bounds.south + (bounds.north - bounds.south) * latRatio;
            for (var col = 0; col < cols; col++) {
                var lngRatio = cols === 1 ? 0.5 : col / (cols - 1);
                var lng = bounds.west + (bounds.east - bounds.west) * lngRatio;
                points.push({ lat: lat, lon: lng });
            }
        }
        return points;
    }

    function buildInterpolatedHeatData(sourcePoints) {
        if (!sourcePoints.length) {
            return [];
        }

        var sourceBounds = boundsFromSourcePoints(sourcePoints);
        var bounds = expandBounds(sourceBounds || citySizedAirBounds(), 0.55);
        var heatData = [];

        buildGridPoints(bounds, CITY_HEAT_GRID_SIZE).forEach(function(gridPoint) {
            var target = { lat: gridPoint.lat, lng: gridPoint.lon };
            var numerator = 0;
            var denominator = 0;
            var directIntensity = null;

            sourcePoints.forEach(function(sourcePoint) {
                var metres = distanceMetres(target, sourcePoint);
                if (metres < 120) {
                    directIntensity = Math.max(directIntensity || 0, sourcePoint.intensity);
                    return;
                }
                var weight = 1 / Math.pow(Math.max(metres, 120), 1.7);
                numerator += sourcePoint.intensity * weight;
                denominator += weight;
            });

            var intensity = directIntensity !== null ? directIntensity : (denominator ? numerator / denominator : 0);
            if (intensity > 0) {
                heatData.push([target.lat, target.lng, Math.max(0.04, intensity * 0.88)]);
            }
        });

        sourcePoints.forEach(function(point) {
            heatData.push([point.lat, point.lng, point.intensity]);
        });

        return heatData;
    }

    function recordStats(stats, value) {
        stats.count += 1;
        stats.min = stats.min === null ? value : Math.min(stats.min, value);
        stats.max = stats.max === null ? value : Math.max(stats.max, value);
    }

    function buildStationPopup(stazione) {
        function pollutantLine(layerId) {
            var config = LAYER_CONFIG[layerId];
            var value = readMeasurement(stazione, layerId);
            var label = escapeHtml(config.label);
            var renderedValue = value !== null ? formatNumber(value) + ' ' + config.unit : 'N/A';
            return '<strong>' + label + '</strong>: ' + escapeHtml(renderedValue);
        }

        return '<b>' + escapeHtml(stazione.nome || 'Station') + ' (' + escapeHtml(stazione.cod || 'n/d') + ')</b><br>' +
            escapeHtml(stazione.ind || '') + '<br>' +
            escapeHtml(stazione.com || '') + ', ' + escapeHtml(stazione.prov || '') + '<hr>' +
            pollutantLine('pm10') + '<hr>' +
            pollutantLine('pm25') + '<hr>' +
            pollutantLine('no2') + '<hr>' +
            pollutantLine('o3');
    }

    function updateLayerButton(layerId) {
        var button = document.getElementById(layerId);
        if (!button) {
            return;
        }
        var active = activeLayerIds.has(layerId);
        var loading = pendingAirLayerIds.has(layerId) || (layerId === 'pollen' && pollenState.loading);
        button.classList.toggle('active-layer', active);
        button.classList.toggle('loading', loading);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.setAttribute('aria-busy', loading ? 'true' : 'false');
    }

    function updateAllLayerButtons() {
        ALL_LAYER_IDS.forEach(updateLayerButton);
    }

    function buildGradientCss(stops) {
        return 'linear-gradient(90deg, ' + stops.map(function(stop) {
            return stop.color + ' ' + stop.position;
        }).join(', ') + ')';
    }

    function layerSummary(layerId) {
        var config = LAYER_CONFIG[layerId];
        var state = layerStates[layerId];

        if (layerId === 'pollen') {
            if (state && state.total !== null) {
                var dominant = state.dominantLabel ? ', highest: ' + state.dominantLabel : '';
                return config.label + ': ' + formatNumber(state.total) + ' ' + config.unit + dominant;
            }
            return config.label + ': active';
        }

        if (!state || !state.count) {
            return config.label + ': no readings';
        }
        var pointWord = stationDataState.sourceLabel || (state.count === 1 ? 'station' : 'stations');
        return config.label + ': ' + state.count + ' ' + pointWord + ' (' +
            formatNumber(state.min) + '-' + formatNumber(state.max) + ' ' + config.unit + ')';
    }

    function defaultStatusMessage(activeIds) {
        if (activeIds.length) {
            var hasAirLayer = activeIds.some(function(layerId) {
                return AIR_LAYER_IDS.indexOf(layerId) !== -1 && layerStates[layerId] && layerStates[layerId].count;
            });
            var suffix = hasAirLayer
                ? '. Numbered circles are grouped markers; zoom in or click them to inspect individual points.'
                : '';
            return 'Showing ' + activeIds.map(layerSummary).join(' | ') + suffix;
        }
        if (stationDataState.loading) {
            return 'Air-quality station data is loading. Pollen loads from Open-Meteo for the selected start point.';
        }
        if (stationDataState.error) {
            return 'Air-quality station data could not be loaded. Pollen can still be requested.';
        }
        if (stationDataState.stationCount === 0) {
            return 'No air-quality data points were returned. Pollen can still be requested.';
        }
        return 'Air-quality layers ready from ' + stationDataState.stationCount + ' ' +
            stationDataState.sourceLabel + '. Numbered circles may group nearby points. Pollen loads from Open-Meteo.';
    }

    function buildLegendItem(layerId) {
        var config = LAYER_CONFIG[layerId];
        var state = layerStates[layerId] || {};
        var detail;

        if (layerId === 'pollen' && state.total !== null) {
            detail = 'Current total: ' + formatNumber(state.total) + ' ' + config.unit;
            if (state.dominantLabel) {
                detail += ' · highest: ' + state.dominantLabel;
            }
        } else if (state.count) {
            var pointLabel = stationDataState.sourceLabel || (state.count === 1 ? 'station' : 'stations');
            detail = state.count + ' ' + pointLabel +
                ' · observed ' + formatNumber(state.min) + '-' + formatNumber(state.max) + ' ' + config.unit;
        } else if (state.status === 'loading') {
            detail = 'Loading current values...';
        } else {
            detail = config.emptyMessage;
        }

        return '<div class="layer-legend-item">' +
            '<div class="layer-legend-heading">' +
                '<span>' + escapeHtml(config.label) + '</span>' +
                '<span class="layer-legend-unit">' + escapeHtml(config.unit) + '</span>' +
            '</div>' +
            '<div class="layer-legend-bar" style="background:' + buildGradientCss(config.gradientStops) + ';" aria-hidden="true"></div>' +
            '<div class="layer-legend-scale">' +
                '<span>Lower exposure</span><span>' + escapeHtml(config.highLabel) + '</span>' +
            '</div>' +
            '<div class="layer-legend-meaning">' + escapeHtml(config.meaning) + '</div>' +
            '<div class="layer-legend-detail">' + escapeHtml(detail) + '</div>' +
            '<div class="layer-legend-source">' + escapeHtml(config.source) + '</div>' +
            '<div class="layer-legend-note">Heat colors are interpolated from real point values; marker numbers are clusters, not extra measurements.</div>' +
        '</div>';
    }

    function renderLayerUI(message) {
        updateAllLayerButtons();

        var activeIds = ALL_LAYER_IDS.filter(function(layerId) {
            return activeLayerIds.has(layerId);
        });
        var statusMessage = message || defaultStatusMessage(activeIds);

        if (layerStatusElement) {
            layerStatusElement.textContent = statusMessage;
            layerStatusElement.hidden = !statusMessage;
        }

        if (layerLegendElement) {
            if (activeIds.length) {
                layerLegendElement.innerHTML = activeIds.map(buildLegendItem).join('');
                layerLegendElement.hidden = false;
            } else {
                layerLegendElement.innerHTML = '';
                layerLegendElement.hidden = true;
            }
        }
    }

    // ---- Real pollen layer (Open-Meteo, tied to the selected city) ----
    var POLLEN_TYPE_LABELS = {
        alder: 'Alder',
        birch: 'Birch',
        grass: 'Grass',
        mugwort: 'Mugwort',
        olive: 'Olive',
        ragweed: 'Ragweed'
    };
    // Total grains/m³ mapped to the top of the gradient (a strong, real pollen day).
    var POLLEN_REFERENCE_MAX = LAYER_CONFIG.pollen.referenceMax;
    var pollenState = { loadedKey: null, loading: false, hasData: false };

    // Deterministic areal spread: the Open-Meteo value is a single ~11km grid cell
    // for the whole city, so we render it as a uniform field of fixed sample points
    // (center + concentric rings, offsets in metres). The intensity carried by every
    // point is the REAL measured level — only the positions are interpolated.
    var POLLEN_SPREAD_OFFSETS = (function() {
        var offsets = [[0, 0]];
        var rings = [1200, 2400, 3600, 4800];
        rings.forEach(function(radius, ringIndex) {
            var count = 8 + ringIndex * 4;
            for (var k = 0; k < count; k++) {
                var angle = (2 * Math.PI * k) / count;
                offsets.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
            }
        });
        return offsets;
    })();

    function notifyPollen(message, level) {
        if (window.toastr && typeof window.toastr[level] === 'function') {
            window.toastr[level](message);
        } else {
            console.info('[pollen] ' + message);
        }
    }

    function resolvePollenCenter() {
        // Same coords source the search/markers use: the selected start point.
        var startInput = document.getElementById('startPoint');
        if (startInput && startInput.dataset.lat && startInput.dataset.lon) {
            var sLat = parseFloat(startInput.dataset.lat);
            var sLon = parseFloat(startInput.dataset.lon);
            if (isFinite(sLat) && isFinite(sLon)) {
                return { lat: sLat, lon: sLon };
            }
        }
        var center = map.getCenter ? map.getCenter() : null;
        if (center && isFinite(center.lat) && isFinite(center.lng)) {
            return { lat: center.lat, lon: center.lng };
        }
        return { lat: 44.645819, lon: 10.925719 };
    }

    function resolveAirLayerCenter() {
        var startInput = document.getElementById('startPoint');
        if (startInput && startInput.dataset.lat && startInput.dataset.lon) {
            var sLat = parseFloat(startInput.dataset.lat);
            var sLon = parseFloat(startInput.dataset.lon);
            if (isFinite(sLat) && isFinite(sLon)) {
                return { lat: sLat, lon: sLon };
            }
        }
        var center = map.getCenter ? map.getCenter() : null;
        if (center && isFinite(center.lat) && isFinite(center.lng)) {
            return { lat: center.lat, lon: center.lng };
        }
        return { lat: 44.645819, lon: 10.925719 };
    }

    function pollenCenterKey(center) {
        return center.lat.toFixed(3) + ',' + center.lon.toFixed(3);
    }

    function buildPollenHeatData(center, intensity) {
        var metresPerDegLng = 111000 * Math.cos(center.lat * Math.PI / 180) || 1;
        return POLLEN_SPREAD_OFFSETS.map(function(offset) {
            var lat = center.lat + offset[1] / 111000;
            var lng = center.lon + offset[0] / metresPerDegLng;
            return [lat, lng, intensity];
        });
    }

    function dominantPollenLabel(payload) {
        var dominant = null;
        Object.keys(POLLEN_TYPE_LABELS).forEach(function(type) {
            var entry = payload.pollen && payload.pollen[type];
            var value = entry && entry.value !== null && entry.value !== undefined ? Number(entry.value) : null;
            if (value !== null && isFinite(value) && (!dominant || value > dominant.value)) {
                dominant = { label: POLLEN_TYPE_LABELS[type], value: value };
            }
        });
        return dominant ? dominant.label + ' (' + formatNumber(dominant.value) + ' grains/m³)' : null;
    }

    function buildPollenPopup(payload) {
        var rows = '';
        Object.keys(POLLEN_TYPE_LABELS).forEach(function(type) {
            var entry = payload.pollen && payload.pollen[type];
            var hasValue = entry && entry.value !== null && entry.value !== undefined;
            var value = hasValue ? formatNumber(entry.value) + ' grains/m³' : 'n/d';
            rows += '<div>' + escapeHtml(POLLEN_TYPE_LABELS[type]) + ': <strong>' + escapeHtml(value) + '</strong></div>';
        });
        var when = payload.timestamp ? '<br><small>' + escapeHtml(payload.timestamp) + ' UTC</small>' : '';
        return '<strong>Pollen (Open-Meteo, real)</strong><br>' + rows +
            '<hr style="margin:4px 0">Total: ' + escapeHtml(formatNumber(payload.total) + ' grains/m³') + when;
    }

    function removeHeatLayer(layerId) {
        if (heatLayers[layerId] && map.hasLayer(heatLayers[layerId])) {
            map.removeLayer(heatLayers[layerId]);
        }
    }

    function removePollenLayer() {
        removeHeatLayer('pollen');
    }

    function focusLayerOnMap(layerId) {
        var layerMarkerList = layerMarkers[layerId] || [];
        if (!layerMarkerList.length || !map.fitBounds) {
            return;
        }
        var bounds = L.latLngBounds(layerMarkerList.map(function(marker) {
            return marker.getLatLng();
        }));
        if (!bounds.isValid()) {
            return;
        }
        if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
            map.setView(bounds.getCenter(), Math.max(map.getZoom ? map.getZoom() : 13, 13), { animate: true });
            return;
        }
        map.fitBounds(bounds.pad(0.35), { maxZoom: 14, animate: true });
    }

    function activateLayer(layerId) {
        var heat = heatLayers[layerId];
        if (!heat) {
            return false;
        }
        if (!map.hasLayer(heat)) {
            map.addLayer(heat);
        }
        activeLayerIds.add(layerId);
        updateVisibleMarkers();
        focusLayerOnMap(layerId);
        return true;
    }

    function deactivateLayer(layerId) {
        removeHeatLayer(layerId);
        activeLayerIds.delete(layerId);
        updateVisibleMarkers();
    }

    function loadPollenLayer(center, onReady) {
        pollenState.loading = true;
        layerStates.pollen.status = 'loading';
        layerStates.pollen.message = 'Loading pollen forecast near the selected point...';
        renderLayerUI(layerStates.pollen.message);

        var url = '/api/pollen/?lat=' + encodeURIComponent(center.lat) +
            '&lon=' + encodeURIComponent(center.lon);

        fetch(url)
            .then(function(response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            })
            .then(function(payload) {
                pollenState.loading = false;
                pollenState.loadedKey = pollenCenterKey(center);
                removePollenLayer();

                if (!payload || payload.status !== 'available') {
                    pollenState.hasData = false;
                    heatLayers.pollen = null;
                    layerMarkers.pollen = [];
                    layerStates.pollen = {
                        status: 'empty',
                        count: 0,
                        min: null,
                        max: null,
                        total: null,
                        dominantLabel: null,
                        message: LAYER_CONFIG.pollen.emptyMessage
                    };
                    notifyPollen('No pollen data for this area (off-season or outside Europe).', 'info');
                    renderLayerUI(layerStates.pollen.message);
                    onReady(false);
                    return;
                }

                pollenState.hasData = true;
                var total = Number(payload.total);
                var intensity = normalizeToUnit(total, POLLEN_REFERENCE_MAX, 0.08);
                var dominantLabel = dominantPollenLabel(payload);

                heatLayers.pollen = L.heatLayer(buildPollenHeatData(center, intensity), pollenHeatOptions);

                var marker = L.circleMarker([payload.lat, payload.lon], {
                    radius: 8,
                    color: '#65a30d',
                    fillColor: '#84cc16',
                    fillOpacity: 0.75
                }).bindPopup(buildPollenPopup(payload));
                marker._pathplannerStationCode = 'pollen-' + pollenCenterKey(center);
                layerMarkers.pollen = [marker];
                layerStates.pollen = {
                    status: 'ready',
                    count: 1,
                    min: null,
                    max: null,
                    total: isFinite(total) ? total : 0,
                    dominantLabel: dominantLabel,
                    message: ''
                };
                onReady(true);
            })
            .catch(function(error) {
                pollenState.loading = false;
                pollenState.hasData = false;
                heatLayers.pollen = null;
                layerMarkers.pollen = [];
                layerStates.pollen = {
                    status: 'error',
                    count: 0,
                    min: null,
                    max: null,
                    total: null,
                    dominantLabel: null,
                    message: 'Could not load pollen data.'
                };
                console.error('[pollen] fetch failed', error);
                notifyPollen('Could not load pollen data.', 'error');
                renderLayerUI(layerStates.pollen.message);
                onReady(false);
            });
    }

    function updateVisibleMarkers() {
        var seenMarkerIds = {};

        markers.clearLayers();
        activeLayerIds.forEach(function(id) {
            var layerMarkerList = layerMarkers[id];
            if (layerMarkerList) {
                layerMarkerList.forEach(function(marker) {
                    var markerId = marker._pathplannerStationCode || L.stamp(marker);
                    if (!seenMarkerIds[markerId]) {
                        markers.addLayer(marker);
                        seenMarkerIds[markerId] = true;
                    }
                });
            }
        });

        if (markers.getLayers().length > 0) {
            map.addLayer(markers);
        } else if (map.hasLayer(markers)) {
            map.removeLayer(markers);
        }
    }

    function toggleAirLayer(layerId) {
        var config = LAYER_CONFIG[layerId];

        if (activeLayerIds.has(layerId)) {
            deactivateLayer(layerId);
            renderLayerUI();
            return;
        }

        if (stationDataState.loading) {
            if (pendingAirLayerIds.has(layerId)) {
                pendingAirLayerIds.delete(layerId);
                renderLayerUI(config.label + ' request cancelled. Station data is still loading.');
            } else {
                pendingAirLayerIds.add(layerId);
                renderLayerUI(config.label + ' will appear when station data finishes loading.');
            }
            return;
        }

        if (stationDataState.error) {
            renderLayerUI('Air-quality station data could not be loaded. ' + config.label + ' is unavailable; pollen can still be requested.');
            return;
        }

        if (!layerStates[layerId] || layerStates[layerId].status !== 'ready' || !heatLayers[layerId]) {
            renderLayerUI(config.emptyMessage);
            return;
        }

        activateLayer(layerId);
        renderLayerUI();
    }

    function registerLayerButton(layerId) {
        var button = document.getElementById(layerId);
        if (!button) {
            return;
        }
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-busy', 'false');
        button.addEventListener('click', function() {
            if (layerId === 'pollen') {
                togglePollen();
                return;
            }
            toggleAirLayer(layerId);
        });
    }

    function togglePollen() {
        if (activeLayerIds.has('pollen')) {
            deactivateLayer('pollen');
            renderLayerUI();
            return;
        }

        if (pollenState.loading) {
            renderLayerUI('Pollen forecast is still loading.');
            return;
        }

        var center = resolvePollenCenter();
        var key = pollenCenterKey(center);
        var needsLoad = !pollenState.loadedKey || pollenState.loadedKey !== key;

        var activate = function(hasData) {
            if (!hasData) {
                renderLayerUI(layerStates.pollen.message || LAYER_CONFIG.pollen.emptyMessage);
                return;
            }
            activateLayer('pollen');
            renderLayerUI();
        };

        if (needsLoad) {
            loadPollenLayer(center, activate);
        } else {
            activate(pollenState.hasData);
        }
    }

    function resetAirLayersForError(message) {
        AIR_LAYER_IDS.forEach(function(layerId) {
            heatLayers[layerId] = null;
            layerMarkers[layerId] = [];
            pendingAirLayerIds.delete(layerId);
            activeLayerIds.delete(layerId);
            layerStates[layerId] = {
                status: 'error',
                count: 0,
                min: null,
                max: null,
                total: null,
                dominantLabel: null,
                message: message
            };
        });
        updateVisibleMarkers();
    }

    function applyPendingAirLayers() {
        var requestedLayerIds = Array.from(pendingAirLayerIds);
        var lastMessage = null;

        pendingAirLayerIds.clear();
        requestedLayerIds.forEach(function(layerId) {
            if (layerStates[layerId] && layerStates[layerId].status === 'ready' && heatLayers[layerId]) {
                activateLayer(layerId);
            } else {
                lastMessage = LAYER_CONFIG[layerId].emptyMessage;
            }
        });

        renderLayerUI(lastMessage);
    }

    function buildAirQualityLayers(data) {
        var heatDataByLayer = {};
        var markersByLayer = {};
        var statsByLayer = {};
        var sourcePointsByLayer = {};

        AIR_LAYER_IDS.forEach(function(layerId) {
            heatDataByLayer[layerId] = [];
            markersByLayer[layerId] = [];
            statsByLayer[layerId] = { count: 0, min: null, max: null };
            sourcePointsByLayer[layerId] = [];
        });

        data.forEach(function(stazione) {
            var position = stationLatLng(stazione);
            if (!position) {
                return;
            }

            var marker = L.marker([position.lat, position.lng]).bindPopup(buildStationPopup(stazione));
            marker._pathplannerStationCode = stazione.cod || (position.lat + ',' + position.lng);
            allStationMarkers[marker._pathplannerStationCode] = marker;

            AIR_LAYER_IDS.forEach(function(layerId) {
                var value = readMeasurement(stazione, layerId);
                if (value === null) {
                    return;
                }

                var intensity = normalizeToUnit(value, LAYER_CONFIG[layerId].referenceMax, 0.06);
                sourcePointsByLayer[layerId].push({
                    lat: position.lat,
                    lng: position.lng,
                    intensity: intensity
                });
                markersByLayer[layerId].push(marker);
                recordStats(statsByLayer[layerId], value);
            });
        });

        AIR_LAYER_IDS.forEach(function(layerId) {
            var stats = statsByLayer[layerId];
            layerMarkers[layerId] = markersByLayer[layerId];
            heatDataByLayer[layerId] = buildInterpolatedHeatData(sourcePointsByLayer[layerId]);

            if (heatDataByLayer[layerId].length) {
                heatLayers[layerId] = L.heatLayer(heatDataByLayer[layerId], baseHeatOptions);
                layerStates[layerId] = {
                    status: 'ready',
                    count: stats.count,
                    min: stats.min,
                    max: stats.max,
                    total: null,
                    dominantLabel: null,
                    message: ''
                };
            } else {
                heatLayers[layerId] = null;
                layerStates[layerId] = {
                    status: 'empty',
                    count: 0,
                    min: null,
                    max: null,
                    total: null,
                    dominantLabel: null,
                    message: LAYER_CONFIG[layerId].emptyMessage
                };
            }
        });
    }

    function measurementValue(payload, pollutant) {
        var measurements = Array.isArray(payload && payload.measurements) ? payload.measurements : [];
        var match = measurements.find(function(measurement) {
            return measurement && measurement.parameter === pollutant && measurement.value !== null && measurement.value !== undefined;
        });
        var value = match ? Number(match.value) : null;
        return isFinite(value) ? value : null;
    }

    function stationFromAirSample(payload, fallbackLat, fallbackLon, index) {
        var coords = payload && payload.coordinates ? payload.coordinates : {};
        var lat = Number(coords.latitude);
        var lon = Number(coords.longitude);
        return {
            nome: payload && payload.station ? payload.station : 'Open-Meteo air grid',
            prov: '',
            ind: payload && payload.timestamp ? payload.timestamp + ' UTC' : '',
            com: payload && payload.provider ? payload.provider : 'Open-Meteo',
            cod: 'air-sample-' + index,
            lat: isFinite(lat) ? lat : fallbackLat,
            lng: isFinite(lon) ? lon : fallbackLon,
            pm25: measurementValue(payload, 'pm25'),
            pm10: measurementValue(payload, 'pm10'),
            no2: measurementValue(payload, 'no2'),
            o3: measurementValue(payload, 'o3')
        };
    }

    function fetchSampledAirQualityLayers() {
        var samplePoints = buildGridPoints(citySizedAirBounds(), AIR_SAMPLE_GRID_SIZE);

        renderLayerUI('No saved station readings found. Loading real air-quality samples across the visible city area...');

        return Promise.all(samplePoints.map(function(point, index) {
            var url = '/api/air_quality/?lat=' + encodeURIComponent(point.lat) +
                '&lon=' + encodeURIComponent(point.lon);
            return fetch(url)
                .then(function(response) {
                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status);
                    }
                    return response.json();
                })
                .then(function(payload) {
                    if (!payload || payload.isDefault) {
                        return null;
                    }
                    return stationFromAirSample(payload, point.lat, point.lon, index);
                })
                .catch(function(error) {
                    console.warn('[heatmap] air-quality sample failed:', error);
                    return null;
                });
        })).then(function(samples) {
            return samples.filter(function(sample) {
                return sample !== null;
            });
        });
    }

    // Register all toggles before any API returns so chips never go dead.
    ALL_LAYER_IDS.forEach(registerLayerButton);
    renderLayerUI();

    // When the selected city changes, refresh an active pollen layer to match it.
    var pollenStartInput = document.getElementById('startPoint');
    if (pollenStartInput) {
        pollenStartInput.addEventListener('change', function() {
            if (!activeLayerIds.has('pollen') || pollenState.loading) {
                return;
            }
            var center = resolvePollenCenter();
            if (pollenState.loadedKey === pollenCenterKey(center)) {
                return;
            }
            removePollenLayer();
            layerStates.pollen.status = 'loading';
            renderLayerUI('Refreshing pollen forecast for the selected start point...');
            loadPollenLayer(center, function(hasData) {
                if (hasData) {
                    activateLayer('pollen');
                } else {
                    activeLayerIds.delete('pollen');
                    updateVisibleMarkers();
                }
                renderLayerUI(hasData ? null : layerStates.pollen.message);
            });
        });
    }

    // Fetch real station data and build pollutant heatmaps. If the local DB has
    // no station rows, use real provider samples around the current map area.
    fetch('/api/stazioni_dati/')
        .then(function(response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        })
        .then(function(data) {
            if (!Array.isArray(data)) {
                throw new Error('Unexpected station payload');
            }

            if (data.length > 0) {
                stationDataState.loading = false;
                stationDataState.loaded = true;
                stationDataState.error = null;
                stationDataState.stationCount = data.length;
                stationDataState.sourceLabel = data.length === 1 ? 'station' : 'stations';

                buildAirQualityLayers(data);
                applyPendingAirLayers();
                return;
            }

            return fetchSampledAirQualityLayers().then(function(samples) {
                stationDataState.loading = false;
                stationDataState.loaded = true;
                stationDataState.error = null;
                stationDataState.stationCount = samples.length;
                stationDataState.sourceLabel = samples.length === 1 ? 'real sample' : 'real samples';

                buildAirQualityLayers(samples);
                applyPendingAirLayers();
            });
        })
        .catch(function(error) {
            var message = 'Air-quality station data could not be loaded.';
            stationDataState.loading = false;
            stationDataState.loaded = false;
            stationDataState.error = error && error.message ? error.message : String(error);
            console.error('[heatmap] Error fetching station data:', error);
            resetAirLayersForError(message);
            renderLayerUI(message + ' PM2.5, PM10, NO₂, and O₃ are unavailable; pollen can still be requested.');
        });
});
