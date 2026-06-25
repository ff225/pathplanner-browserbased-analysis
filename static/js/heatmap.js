document.addEventListener("DOMContentLoaded", function() {
    var map = window.map;
    if (!map) {
        console.error('[heatmap] Leaflet map not available');
        return;
    }

    var markers = L.markerClusterGroup();

    var allStationMarkers = {};
    var activeLayerIds = new Set();

    var heatLayers = {};
    var layerMarkers = {};

    var baseHeatOptions = {
        radius: 55,
        blur: 100,
        gradient: {
            0.0: 'blue',
            0.2: 'cyan',
            0.4: 'lime',
            0.6: 'yellow',
            0.8: 'orange',
            1.0: 'red'
        }
    };

    var pollenHeatOptions = {
        radius: 48,
        blur: 85,
        max: 1.0,
        gradient: {
            0.0: '#d9f99d',
            0.25: '#84cc16',
            0.5: '#eab308',
            0.75: '#f97316',
            1.0: '#a16207'
        }
    };

    function generateDummyPoints(centerLat, centerLng, value, numPoints, maxDistance) {
        var points = [];
        for (var i = 0; i < numPoints; i++) {
            var angle = Math.random() * Math.PI * 2;
            var distance = Math.random() * maxDistance;
            var offsetLat = centerLat + (distance * Math.cos(angle)) / 111000;
            var offsetLng = centerLng + (distance * Math.sin(angle)) / (111000 * Math.cos(centerLat * Math.PI / 180));
            points.push([offsetLat, offsetLng, value * 0.2]);
        }
        return points;
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
    var POLLEN_REFERENCE_MAX = 120;
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

    function buildPollenPopup(payload) {
        var rows = '';
        Object.keys(POLLEN_TYPE_LABELS).forEach(function(type) {
            var entry = payload.pollen && payload.pollen[type];
            var hasValue = entry && entry.value !== null && entry.value !== undefined;
            var value = hasValue ? entry.value + ' grains/m³' : 'n/d';
            rows += '<div>' + POLLEN_TYPE_LABELS[type] + ': <strong>' + value + '</strong></div>';
        });
        var when = payload.timestamp ? '<br><small>' + payload.timestamp + ' UTC</small>' : '';
        return '<strong>Pollen (Open-Meteo, real)</strong><br>' + rows +
            '<hr style="margin:4px 0">Total: ' + payload.total + ' grains/m³' + when;
    }

    function removePollenLayer() {
        if (heatLayers.pollen && map.hasLayer(heatLayers.pollen)) {
            map.removeLayer(heatLayers.pollen);
        }
    }

    function loadPollenLayer(center, onReady) {
        pollenState.loading = true;
        var url = '/api/pollen/?lat=' + encodeURIComponent(center.lat) +
            '&lon=' + encodeURIComponent(center.lon);

        fetch(url)
            .then(function(response) { return response.json(); })
            .then(function(payload) {
                pollenState.loading = false;
                pollenState.loadedKey = pollenCenterKey(center);
                removePollenLayer();

                if (!payload || payload.status !== 'available') {
                    pollenState.hasData = false;
                    heatLayers.pollen = null;
                    layerMarkers.pollen = [];
                    notifyPollen('No pollen data for this area (off-season or outside Europe).', 'info');
                    onReady(false);
                    return;
                }

                pollenState.hasData = true;
                var intensity = Math.max(0.08, Math.min(1, payload.total / POLLEN_REFERENCE_MAX));
                heatLayers.pollen = L.heatLayer(buildPollenHeatData(center, intensity), pollenHeatOptions);

                var marker = L.circleMarker([payload.lat, payload.lon], {
                    radius: 8,
                    color: '#65a30d',
                    fillColor: '#84cc16',
                    fillOpacity: 0.75
                }).bindPopup(buildPollenPopup(payload));
                layerMarkers.pollen = [marker];
                onReady(true);
            })
            .catch(function(error) {
                pollenState.loading = false;
                pollenState.hasData = false;
                heatLayers.pollen = null;
                layerMarkers.pollen = [];
                console.error('[pollen] fetch failed', error);
                notifyPollen('Could not load pollen data.', 'error');
                onReady(false);
            });
    }

    function updateVisibleMarkers() {
        markers.clearLayers();
        activeLayerIds.forEach(function(id) {
            var layerMarkerList = layerMarkers[id];
            if (layerMarkerList) {
                layerMarkerList.forEach(function(marker) {
                    markers.addLayer(marker);
                });
            }
        });

        if (markers.getLayers().length > 0) {
            map.addLayer(markers);
        } else if (map.hasLayer(markers)) {
            map.removeLayer(markers);
        }
    }

    function toggleLayer(layerId) {
        var heat = heatLayers[layerId];
        var button = document.getElementById(layerId);
        if (!heat || !button) {
            return;
        }

        if (activeLayerIds.has(layerId)) {
            if (map.hasLayer(heat)) {
                map.removeLayer(heat);
            }
            activeLayerIds.delete(layerId);
            button.classList.remove('active-layer');
        } else {
            if (!map.hasLayer(heat)) {
                map.addLayer(heat);
            }
            activeLayerIds.add(layerId);
            button.classList.add('active-layer');
        }

        updateVisibleMarkers();
    }

    function registerLayerButton(layerId) {
        var button = document.getElementById(layerId);
        if (!button) {
            return;
        }
        button.addEventListener('click', function() {
            toggleLayer(layerId);
        });
    }

    function togglePollen() {
        var button = document.getElementById('pollen');
        if (!button) {
            return;
        }

        if (activeLayerIds.has('pollen')) {
            removePollenLayer();
            activeLayerIds.delete('pollen');
            button.classList.remove('active-layer');
            updateVisibleMarkers();
            return;
        }

        if (pollenState.loading) {
            return;
        }

        var center = resolvePollenCenter();
        var key = pollenCenterKey(center);
        var needsLoad = !pollenState.loadedKey || pollenState.loadedKey !== key;

        var activate = function(hasData) {
            if (!hasData) {
                // Honest empty state: no markers, no heat — only the note already shown.
                return;
            }
            activeLayerIds.add('pollen');
            button.classList.add('active-layer');
            if (heatLayers.pollen && !map.hasLayer(heatLayers.pollen)) {
                map.addLayer(heatLayers.pollen);
            }
            updateVisibleMarkers();
        };

        if (needsLoad) {
            button.classList.add('loading');
            loadPollenLayer(center, function(hasData) {
                button.classList.remove('loading');
                activate(hasData);
            });
        } else {
            activate(pollenState.hasData);
        }
    }

    // Real pollen layer fetches Open-Meteo data lazily for the selected city.
    var pollenButton = document.getElementById('pollen');
    if (pollenButton) {
        pollenButton.addEventListener('click', togglePollen);
    }

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
            loadPollenLayer(center, function(hasData) {
                var button = document.getElementById('pollen');
                if (hasData) {
                    if (heatLayers.pollen && !map.hasLayer(heatLayers.pollen)) {
                        map.addLayer(heatLayers.pollen);
                    }
                } else {
                    activeLayerIds.delete('pollen');
                    if (button) {
                        button.classList.remove('active-layer');
                    }
                }
                updateVisibleMarkers();
            });
        });
    }

    // Fetch real station data and build pollutant heatmaps.
    fetch('/api/stazioni_dati/')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            var pm10HeatData = [];
            var pm25HeatData = [];
            var no2HeatData = [];
            var o3HeatData = [];

            var pm10Markers = [];
            var pm25Markers = [];
            var no2Markers = [];
            var o3Markers = [];

            data.forEach(function(stazione) {
                var marker = L.marker([stazione.lat, stazione.lng]);
                var popupContent =
                    '<b>' + stazione.nome + ' (' + stazione.cod + ')</b><br>' +
                    stazione.ind + '<br>' + stazione.com + ', ' + stazione.prov + '<hr>' +
                    '<strong>PM10</strong>: ' + (stazione.pm10 !== null ? stazione.pm10 + ' µg/m³' : 'N/A') + '<hr>' +
                    '<strong>PM2.5</strong>: ' + (stazione.pm25 !== null ? stazione.pm25 + ' µg/m³' : 'N/A') + '<hr>' +
                    '<strong>NO2</strong>: ' + (stazione.no2 !== null ? stazione.no2 + ' µg/m³' : 'N/A') + '<hr>' +
                    '<strong>O3</strong>: ' + (stazione.o3 !== null ? stazione.o3 + ' µg/m³' : 'N/A');
                marker.bindPopup(popupContent);

                allStationMarkers[stazione.cod] = marker;

                if (stazione.pm10 !== null) {
                    pm10HeatData.push([stazione.lat, stazione.lng, stazione.pm10]);
                    pm10HeatData = pm10HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.pm10, 200, 1000));
                    pm10Markers.push(marker);
                }
                if (stazione.pm25 !== null) {
                    pm25HeatData.push([stazione.lat, stazione.lng, stazione.pm25]);
                    pm25HeatData = pm25HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.pm25, 200, 1000));
                    pm25Markers.push(marker);
                }
                if (stazione.no2 !== null) {
                    no2HeatData.push([stazione.lat, stazione.lng, stazione.no2]);
                    no2HeatData = no2HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.no2, 200, 1000));
                    no2Markers.push(marker);
                }
                if (stazione.o3 !== null) {
                    o3HeatData.push([stazione.lat, stazione.lng, stazione.o3]);
                    o3HeatData = o3HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.o3, 200, 1000));
                    o3Markers.push(marker);
                }
            });

            heatLayers.pm10 = L.heatLayer(pm10HeatData, baseHeatOptions);
            heatLayers.pm25 = L.heatLayer(pm25HeatData, baseHeatOptions);
            heatLayers.no2 = L.heatLayer(no2HeatData, baseHeatOptions);
            heatLayers.o3 = L.heatLayer(o3HeatData, baseHeatOptions);

            layerMarkers.pm10 = pm10Markers;
            layerMarkers.pm25 = pm25Markers;
            layerMarkers.no2 = no2Markers;
            layerMarkers.o3 = o3Markers;

            ['pm10', 'pm25', 'no2', 'o3'].forEach(registerLayerButton);
        })
        .catch(function(error) {
            console.error('[heatmap] Error fetching station data:', error);
        });
});
