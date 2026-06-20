document.addEventListener("DOMContentLoaded", function() {
    var markers = L.markerClusterGroup(); // Initialize the cluster group
    var pm10Layer = L.layerGroup();
    var pm25Layer = L.layerGroup();
    var no2Layer = L.layerGroup();
    var o3Layer = L.layerGroup();

    var allMarkers = {}; // Store markers by station code for easier control

    // Function to generate dummy points around a station
    function generateDummyPoints(centerLat, centerLng, value, numPoints, maxDistance) {
        var points = [];
        for (var i = 0; i < numPoints; i++) {
            var angle = Math.random() * Math.PI * 2; // Random angle
            var distance = Math.random() * maxDistance; // Random distance within max radius
            var offsetLat = centerLat + (distance * Math.cos(angle)) / 111000; // 111000 meters in 1 degree of latitude
            var offsetLng = centerLng + (distance * Math.sin(angle)) / (111000 * Math.cos(centerLat * Math.PI / 180));
            points.push([offsetLat, offsetLng, value * 0.2]); // Reduced value for dummy points
        }
        return points;
    }

    // Fetch station data from the API
    fetch('/api/stazioni_dati/')
        .then(response => response.json())
        .then(data => {
            // console.log('Data received:', data); // Log the received data
            var pm10HeatData = [];
            var pm25HeatData = [];
            var no2HeatData = [];
            var o3HeatData = [];

            // Iterate over each station and add markers and heatmap points
            data.forEach(stazione => {
                var marker = L.marker([stazione.lat, stazione.lng]);
                var popupContent = 
                    `<b>${stazione.nome} (${stazione.cod})</b><br>${stazione.ind}<br>${stazione.com}, ${stazione.prov}<hr>
                    <strong>PM10</strong>: ${stazione.pm10 !== null ? stazione.pm10 + ' µg/m³' : 'N/A'}<hr>
                    <strong>PM2.5</strong>: ${stazione.pm25 !== null ? stazione.pm25 + ' µg/m³' : 'N/A'}<hr>
                    <strong>NO2</strong>: ${stazione.no2 !== null ? stazione.no2 + ' µg/m³' : 'N/A'}<hr>
                    <strong>O3</strong>: ${stazione.o3 !== null ? stazione.o3 + ' µg/m³' : 'N/A'}`;
                marker.bindPopup(popupContent);

                // Store markers in a dictionary for easy control
                allMarkers[stazione.cod] = marker;

                // Add real data to the heatmap and generate dummy points
                if (stazione.pm10 !== null) {
                    pm10HeatData.push([stazione.lat, stazione.lng, stazione.pm10]);
                    pm10HeatData = pm10HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.pm10, 200, 1000));
                    pm10Layer.addLayer(L.circleMarker([stazione.lat, stazione.lng], { radius: 8 }).bindPopup(popupContent));
                }
                if (stazione.pm25 !== null) {
                    pm25HeatData.push([stazione.lat, stazione.lng, stazione.pm25]);
                    pm25HeatData = pm25HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.pm25, 200, 1000));
                    pm25Layer.addLayer(L.circleMarker([stazione.lat, stazione.lng], { radius: 8 }).bindPopup(popupContent));
                }
                if (stazione.no2 !== null) {
                    no2HeatData.push([stazione.lat, stazione.lng, stazione.no2]);
                    no2HeatData = no2HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.no2, 200, 1000));
                    no2Layer.addLayer(L.circleMarker([stazione.lat, stazione.lng], { radius: 8 }).bindPopup(popupContent));
                }
                if (stazione.o3 !== null) {
                    o3HeatData.push([stazione.lat, stazione.lng, stazione.o3]);
                    o3HeatData = o3HeatData.concat(generateDummyPoints(stazione.lat, stazione.lng, stazione.o3, 200, 1000));
                    o3Layer.addLayer(L.circleMarker([stazione.lat, stazione.lng], { radius: 8 }).bindPopup(popupContent));
                }
            });

            var heatOptions = {
                radius: 55, // Heatmap area size
                blur: 100, // Level of blur for the heatmap
                gradient: { // Custom color gradient for the heatmap
                    0.0: 'blue',
                    0.2: 'cyan',
                    0.4: 'lime',
                    0.6: 'yellow',
                    0.8: 'orange',
                    1.0: 'red'
                }
            };

            // Create heatmaps for each pollutant
            var pm10Heat = L.heatLayer(pm10HeatData, heatOptions);
            var pm25Heat = L.heatLayer(pm25HeatData, heatOptions);
            var no2Heat = L.heatLayer(no2HeatData, heatOptions);
            var o3Heat = L.heatLayer(o3HeatData, heatOptions);

            // Function to toggle the heatmap layer and markers
            function toggleLayer(layer, buttonId, heatMarkers) {
                var button = document.getElementById(buttonId);

                if (map.hasLayer(layer)) {
                    map.removeLayer(layer);
                    button.classList.remove('active-layer');
                    markers.clearLayers(); // Remove all markers when the layer is deactivated
                } else {
                    // Remove any active layers before adding the selected one
                    [pm10Heat, pm25Heat, no2Heat, o3Heat].forEach(l => {
                        if (map.hasLayer(l)) {
                            map.removeLayer(l);
                        }
                    });
                    ['pm10', 'pm25', 'no2', 'o3'].forEach(id => {
                        document.getElementById(id).classList.remove('active-layer');
                    });

                    map.addLayer(layer);
                    button.classList.add('active-layer');

                    // Add markers related to the current layer
                    markers.clearLayers(); // Clear all markers before adding new ones
                    heatMarkers.forEach(m => {
                        markers.addLayer(m); // Add the correct markers for the current heat layer
                    });
                    map.addLayer(markers); // Add the cluster group to the map
                }
            }

            // Event listeners for buttons to toggle heatmaps and markers
            document.getElementById('pm10').addEventListener('click', function() {
                toggleLayer(pm10Heat, 'pm10', Object.values(allMarkers)); // Pass the relevant markers
            });

            document.getElementById('pm25').addEventListener('click', function() {
                toggleLayer(pm25Heat, 'pm25', Object.values(allMarkers)); // Same here
            });

            document.getElementById('no2').addEventListener('click', function() {
                toggleLayer(no2Heat, 'no2', Object.values(allMarkers));
            });

            document.getElementById('o3').addEventListener('click', function() {
                toggleLayer(o3Heat, 'o3', Object.values(allMarkers));
            });

        })
        .catch(error => console.error('Error fetching data:', error));
});
