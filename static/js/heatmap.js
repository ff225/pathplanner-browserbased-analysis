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

    function generatePollenDemoData() {
        var center = map.getCenter ? map.getCenter() : { lat: 44.645819, lng: 10.925719 };
        var heatData = [];
        var demoMarkers = [];
        var types = ['Grass', 'Birch', 'Olive', 'Ragweed'];

        for (var i = 0; i < 90; i++) {
            var angle = Math.random() * Math.PI * 2;
            var distance = Math.random() * 6000;
            var lat = center.lat + (distance * Math.cos(angle)) / 111000;
            var lng = center.lng + (distance * Math.sin(angle)) / (111000 * Math.cos(center.lat * Math.PI / 180));
            var value = Math.round(10 + Math.random() * 130);
            heatData.push([lat, lng, value]);

            if (i % 6 === 0) {
                var type = types[Math.floor(Math.random() * types.length)];
                var marker = L.circleMarker([lat, lng], {
                    radius: 7,
                    color: '#65a30d',
                    fillColor: '#84cc16',
                    fillOpacity: 0.7
                }).bindPopup('<strong>Pollen demo station</strong><br>' + type + ' pollen: ' + value + ' grains/m³');
                demoMarkers.push(marker);
            }
        }

        return { heatData: heatData, markers: demoMarkers };
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

    // Pollen demo layer is generated immediately and does not depend on the station API.
    var pollenDemo = generatePollenDemoData();
    heatLayers.pollen = L.heatLayer(pollenDemo.heatData, pollenHeatOptions);
    layerMarkers.pollen = pollenDemo.markers;
    registerLayerButton('pollen');

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
