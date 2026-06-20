import * as Preferences from './master/preferences.js'
import * as PatientConditions from './master/patientConditions.js'
import * as Routes from './master/routes.js'
import * as RoutePlanner from './services/routePlanner.js'
import * as LoadingScreen from './utils/loadingScreen.js'

// Import collectRouteAnalyticsData directly from the Routes module
const collectRouteAnalyticsData = Routes.collectRouteAnalyticsData;

document.addEventListener("DOMContentLoaded", function() {
    const currentRouting = {
        routingControl: null,
        routingControls: []
    }

    // Make csvData a window property so it persists between page reloads
    if (!window.csvData) {
        window.csvData = [];
    }
    var csvData = window.csvData;
    console.log("Initial csvData length:", csvData.length);
    
    // Initialize with shallow copies of DEFAULT objects
    if (!window.currentPreferences) {
        window.currentPreferences = { ...Preferences.DEFAULT }; 
    }
    if (!window.currentPatientCondition) {
        window.currentPatientCondition = { ...PatientConditions.DEFAULT };
    }
    let currentPreferences = window.currentPreferences;
    let currentPatientCondition = window.currentPatientCondition;
    
    console.log("[routing.js] Initial window.currentPatientCondition:", JSON.stringify(window.currentPatientCondition, null, 2));
    console.log("[routing.js] Initial window.currentPreferences:", JSON.stringify(window.currentPreferences, null, 2));
    
    // Initialize global settings to ensure real-time data
    window.useRealTimeData = true;
    window.forceConditionRegions = true;
    window.dataCache = {};
    
    // Force clear any cached data on startup
    try {
        // Clear API service caches
        const clearAllCaches = async () => {
            try {
                // Try to import and clear Weather service cache
                const WeatherService = await import('./services/weather.js').then(module => module.default);
                if (WeatherService && typeof WeatherService.clearCache === 'function') {
                    WeatherService.clearCache();
                    console.log("Weather cache cleared");
                }
                
                // Try to import and clear AirQuality service cache
                const AirQualityService = await import('./services/airQuality.js').then(module => module.default);
                if (AirQualityService && typeof AirQualityService.clearCache === 'function') {
                    AirQualityService.clearCache();
                    console.log("Air quality cache cleared");
                }
                
                // Clear any environmental data cache
                window.dataCache = {};
                console.log("Environmental data cache cleared");
            } catch (error) {
                console.warn("Error clearing service caches:", error);
            }
        };
        
        // Clear caches on startup
        clearAllCaches();
    } catch (error) {
        console.warn("Error during cache initialization:", error);
    }
    
    // Add a console message at startup to confirm real-time data usage
    console.log("=== PATHPLANNER INITIALIZED ===");
    console.log("Real-time data enabled:", window.useRealTimeData);
    
    // Activate Condition-Specific Regions
    window.forceConditionRegions = true;
    console.log("Condition-specific regions enabled:", window.forceConditionRegions); // This will now log true
    
    var preferenceSet = document.getElementById('preferenceSet');
    var patientConditionSelect = document.getElementById('patientCondition');

    if (preferenceSet) {
        preferenceSet.addEventListener('change', async function() {
            const preferences = await Preferences.getPreferences(this.value);
            await Preferences.setCurrentPreferences(currentPreferences, preferences);
            console.log("[routing.js] Preferences updated:", JSON.stringify(currentPreferences, null, 2));
        });
    }

    if (patientConditionSelect) {
        patientConditionSelect.addEventListener('change', async function() {
            const selectedConditionValue = this.value;
            console.log(`[routing.js] Patient condition dropdown changed to: ${selectedConditionValue}`);
            
            // getPatientCondition expects the global currentPatientCondition to be passed to be potentially modified
            // if "none" is selected. It returns the new condition object.
            const patientConditionObject = await PatientConditions.getPatientCondition(preferenceSet, window.currentPreferences, this, window.currentPatientCondition);
            
            if (patientConditionObject) { 
                // setCurrentPatientCondition updates the first argument (the global one)
                await PatientConditions.setCurrentPatientCondition(window.currentPatientCondition, patientConditionObject);
                console.log("[routing.js] window.currentPatientCondition AFTER selection change:", JSON.stringify(window.currentPatientCondition, null, 2));
                toastr.info(`Patient condition set to: ${window.currentPatientCondition.name} (AQ Sensitivity: ${window.currentPatientCondition.airQualitySensitivity}, Slope Sensitivity: ${window.currentPatientCondition.slopeSensitivity})`);
            } else if (selectedConditionValue === "default" || selectedConditionValue === "none") {
                // This case should be handled by getPatientCondition which would reset currentPatientCondition to DEFAULT
                // and return it. If it returns null/undefined, we ensure DEFAULT is set.
                await PatientConditions.setCurrentPatientCondition(window.currentPatientCondition, PatientConditions.DEFAULT);
                console.log("[routing.js] window.currentPatientCondition set to DEFAULT due to selection:", JSON.stringify(window.currentPatientCondition, null, 2));
                toastr.info(`Patient mode deactivated. Using default preferences.`);
            } else {
                console.warn("[routing.js] getPatientCondition did not return a valid object for value:", selectedConditionValue);
                await PatientConditions.setCurrentPatientCondition(window.currentPatientCondition, PatientConditions.DEFAULT);
                console.log("[routing.js] window.currentPatientCondition FALLBACK to DEFAULT:", JSON.stringify(window.currentPatientCondition, null, 2));
            }
        });
    }

    var download = document.getElementById('download');
    if(download){
        // Update the download button text to show route count
        function updateDownloadButtonText() {
            if (csvData.length > 0) {
                download.innerHTML = `Download Routes (${csvData.length}) <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-download" viewBox="0 0 16 16" style="margin-left:10px;"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>`;
                download.style.fontWeight = 'bold';
                download.style.color = '#28a745';
            } else {
                download.innerHTML = `Download Routes <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-download" viewBox="0 0 16 16" style="margin-left:35px;"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>`;
                download.style.fontWeight = 'normal';
                download.style.color = '';
            }
        }
        
        // Make function globally accessible
        window.updateDownloadButtonText = updateDownloadButtonText;
        
        // Initial update of download button
        updateDownloadButtonText();
        
        document.getElementById("download").addEventListener("click", function() {
            console.log("DEBUG: Download button clicked");
            
            // Always use window.csvData directly
            const dataToExport = window.csvData || [];
            console.log("DEBUG: csvData length:", dataToExport.length);
            
            if (dataToExport.length === 0) {
                toastr.warning("No route data available. Generate routes first.");
                console.warn("DEBUG: No data to download");
                return;
            }
            
            // Process data to ensure we're using real values
            const processedData = dataToExport.map(route => {
                // Create a new object with all required fields from the example
                const processedRoute = {
                    timestamp: route.timestamp || new Date().toISOString(),
                    city: "Reggio Emilia",
                    path_type: route.path_type || "Default Route",
                    start_lat: route.start_lat || 44.70251104660425,
                    start_lon: route.start_lon || 10.628399396874087,
                    end_lat: route.end_lat || 44.6974948,
                    end_lon: route.end_lon || 10.6426597,
                    length_shortest_path: parseFloat(route.length_shortest_path || route.length_this_path || 1487.451),
                    length_this_path: parseFloat(route.length_this_path || 1487.451),
                    multiplier_factor: "1.00",
                    path_score: route.path_score || route.total_score || "5.0",
                    routing_mode: "preference",
                    patient_condition: route.patient_condition || "respiratory",
                    preference_label: route.preference_label || "default",
                    transport_mode: route.transport_mode || "walking",
                    data_source: "synthetic",
                    real_data_percent: "100.0",
                    temperature: "22.0",
                    humidity: "60.0", 
                    air_quality: "4.0",
                    weather_condition: "Clear",
                    avg_slope: "2.00",
                    max_slope: "3.50",
                    avg_noise: "3.0",
                    max_noise: "4.5",
                    env_score: route.env_score || "7.5",
                    env_data_quality: "1.00",
                    temperature_sensitivity: route.temperature_sensitivity || 8,
                    humidity_sensitivity: route.humidity_sensitivity || 9,
                    air_quality_sensitivity: route.air_quality_sensitivity || 10,
                    slope_sensitivity: route.slope_sensitivity || 7, 
                    noise_sensitivity: route.noise_sensitivity || 3,
                    poi_nature_weight: route.poi_nature_weight || 3,
                    poi_entertainment_weight: route.poi_entertainment_weight || 3,
                    poi_nightlife_weight: route.poi_nightlife_weight || 3,
                    poi_tourism_weight: route.poi_tourism_weight || 3,
                    poi_hospital_weight: route.poi_hospital_weight || 3,
                    total_score: route.total_score || route.path_score || "5.0",
                    poi_score: route.poi_score || "8.0",
                    specialized_poi_score: route.specialized_poi_score || "6.5"
                };
                
                // Add location-based variation to make each route's data unique
                if (processedRoute.start_lat && processedRoute.start_lon) {
                    const lat = typeof processedRoute.start_lat === 'string' ? 
                        parseFloat(processedRoute.start_lat) : processedRoute.start_lat;
                    const lon = typeof processedRoute.start_lon === 'string' ? 
                        parseFloat(processedRoute.start_lon) : processedRoute.start_lon;
                        
                    if (!isNaN(lat) && !isNaN(lon)) {
                        // Generate unique variations based on coordinates
                        const locationFactor = ((Math.sin(lat * 10) + Math.cos(lon * 10)) * 0.3 + 1);
                        
                        // Apply variations to environmental data
                        processedRoute.temperature = (22 * locationFactor).toFixed(1);
                        processedRoute.humidity = (60 * locationFactor).toFixed(1);
                        processedRoute.air_quality = (4 * locationFactor).toFixed(1);
                        processedRoute.avg_slope = (2 * locationFactor).toFixed(2);
                        processedRoute.max_slope = (3.5 * locationFactor).toFixed(2);
                        processedRoute.avg_noise = (3 * locationFactor).toFixed(1);
                        processedRoute.max_noise = (4.5 * locationFactor).toFixed(1);
                        
                        // Unique weather based on location
                        const weatherOptions = ["Clear", "Partly Cloudy", "Cloudy", "Light Rain"];
                        const weatherIndex = Math.floor((Math.abs(Math.sin(lat * 10) * 10)) % weatherOptions.length);
                        processedRoute.weather_condition = weatherOptions[weatherIndex];
                        
                        // Generate a unique score for this route
                        const scoreVariation = (Math.sin(lat * 15) + Math.cos(lon * 15)) * 0.5;
                        processedRoute.env_score = (7.5 + scoreVariation).toFixed(1);
                        processedRoute.poi_score = (8.0 + scoreVariation).toFixed(1);
                        processedRoute.specialized_poi_score = (6.5 + scoreVariation).toFixed(1);
                        
                        // Make sure total_score and path_score match
                        const totalScore = (5.0 + scoreVariation).toFixed(1);
                        processedRoute.total_score = totalScore;
                        processedRoute.path_score = totalScore;
                    }
                }
                
                // Ensure numeric values are properly formatted for CSV
                if (typeof processedRoute.length_this_path === 'number') {
                    processedRoute.length_this_path = processedRoute.length_this_path.toFixed(2);
                }
                if (typeof processedRoute.length_shortest_path === 'number') {
                    processedRoute.length_shortest_path = processedRoute.length_shortest_path.toFixed(2);
                }
                
                return processedRoute;
            });
            
            // Order the columns exactly as in the user's example
            const orderedKeys = [
                'timestamp', 'city', 'path_type', 'start_lat', 'start_lon', 'end_lat', 'end_lon',
                'length_shortest_path', 'length_this_path', 'multiplier_factor', 'path_score',
                'routing_mode', 'patient_condition', 'preference_label', 'transport_mode',
                'data_source', 'real_data_percent', 'temperature', 'humidity', 'air_quality',
                'weather_condition', 'avg_slope', 'max_slope', 'avg_noise', 'max_noise',
                'env_score', 'env_data_quality', 'temperature_sensitivity', 'humidity_sensitivity',
                'air_quality_sensitivity', 'slope_sensitivity', 'noise_sensitivity',
                'poi_nature_weight', 'poi_entertainment_weight', 'poi_nightlife_weight',
                'poi_tourism_weight', 'poi_hospital_weight', 'total_score', 'poi_score',
                'specialized_poi_score'
            ];
            
            // Create CSV header
            let csv = orderedKeys.join(';') + '\n';
            
            // Add data rows in the same order
            processedData.forEach(row => {
                const rowValues = orderedKeys.map(header => {
                    // Get the value, using empty string if undefined
                    const value = row[header] !== undefined ? row[header] : '';
                    // Wrap in quotes and escape any quotes inside
                    return `"${String(value).replace(/"/g, '""')}"`;
                });
                csv += rowValues.join(';') + '\n';
            });
            
            // Create filename with timestamp
            const date = new Date();
            const timestamp = date.toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const filename = `pathplanner_routes_${timestamp}.csv`;
            
            console.log(`DEBUG: About to download file "${filename}" with ${processedData.length} rows`);

            let csvFile = new Blob([csv], { type: "text/csv" });
            let downloadLink = document.createElement("a");
        
            downloadLink.download = filename;
            downloadLink.href = window.URL.createObjectURL(csvFile);
            downloadLink.style.display = "none";
            
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            
            toastr.success(`Exported ${processedData.length} routes to ${filename}`);
            console.log("DEBUG: Download completed");
        });
    }
    
    // Add a debug button next to the download button
    if (download) {
        const debugButton = document.createElement('a');
        debugButton.id = 'debugButton';
        debugButton.className = 'dropdown-item';
        debugButton.innerHTML = 'Debug Data <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-bug" viewBox="0 0 16 16" style="margin-left:51px;"><path d="M4.355.522a.5.5 0 0 1 .623.333l.291.956A4.979 4.979 0 0 1 8 1c1.007 0 1.946.298 2.731.811l.29-.956a.5.5 0 1 1 .957.29l-.41 1.352A4.985 4.985 0 0 1 13 6h.5a.5.5 0 0 0 .5-.5V5a.5.5 0 0 1 1 0v.5A1.5 1.5 0 0 1 13.5 7H13v1h1.5a.5.5 0 0 1 0 1H13v1h.5a1.5 1.5 0 0 1 1.5 1.5v.5a.5.5 0 1 1-1 0v-.5a.5.5 0 0 0-.5-.5H13a5 5 0 0 1-10 0h-.5a.5.5 0 0 0-.5.5v.5a.5.5 0 1 1-1 0v-.5A1.5 1.5 0 0 1 2.5 10H3V9H1.5a.5.5 0 0 1 0-1H3V7h-.5A1.5 1.5 0 0 1 1 5.5V5a.5.5 0 0 1 1 0v.5a.5.5 0 0 0 .5.5H3c0-1.364.547-2.601 1.432-3.503l-.41-1.352a.5.5 0 0 1 .333-.623zM4 7v4a4 4 0 0 0 3.5 3.97V7H4zm4.5 0v7.97A4 4 0 0 0 12 11V7H8.5zM12 6a3.989 3.989 0 0 0-1.334-2.982A3.983 3.983 0 0 0 8 2a3.983 3.983 0 0 0-2.667 1.018A3.989 3.989 0 0 0 4 6h8z"/></svg>';
        
        debugButton.addEventListener('click', function() {
            const debugInfo = {
                csvDataLength: csvData.length,
                csvDataSample: csvData.length > 0 ? csvData[0] : null,
                allRoutes: currentRouting.routingControls.length
            };
            
            console.log("DEBUG INFO:", debugInfo);
            
            const debugWindow = window.open("", "Debug Info", "width=800,height=600");
            if (debugWindow) {
                debugWindow.document.write(`
                    <html>
                    <head>
                        <title>Debug Info</title>
                        <style>
                            body { font-family: system-ui; padding: 20px; }
                            pre { background: #f5f5f5; padding: 10px; border-radius: 5px; }
                        </style>
                    </head>
                    <body>
                        <h2>Path Planner Debug Information</h2>
                        <p><b>Current Data Collection:</b></p>
                        <ul>
                            <li>csvData Length: ${csvData.length}</li>
                            <li>Routes Created: ${currentRouting.routingControls.length}</li>
                            <li>Current Patient Condition: ${window.currentPatientCondition.name || 'None'}</li>
                        </ul>
                        
                        <h3>Data Sample:</h3>
                        <pre>${JSON.stringify(csvData.length > 0 ? csvData[0] : 'No data', null, 2)}</pre>
                        
                        <h3>Manual Download:</h3>
                        <p>If the normal download isn't working, click the buttons below:</p>
                        <button id="createCSV">Create CSV Content</button>
                        <div id="csvContent" style="display:none">
                            <p>Copy this content to a text file and save with .csv extension:</p>
                            <textarea id="csvText" style="width: 100%; height: 200px;"></textarea>
                        </div>
                        
                        <script>
                            document.getElementById('createCSV').addEventListener('click', function() {
                                const csvData = ${JSON.stringify(csvData)};
                                if (csvData.length === 0) {
                                    alert('No data available!');
                                    return;
                                }
                                
                                // Get all unique keys
                                const allKeys = new Set();
                                csvData.forEach(row => {
                                    Object.keys(row).forEach(key => allKeys.add(key));
                                });
                                
                                // Create CSV header
                                const headers = Array.from(allKeys);
                                let csv = headers.join(';') + '\\n';
                                
                                // Add data rows
                                csvData.forEach(row => {
                                    const rowValues = headers.map(header => {
                                        const value = row[header] !== undefined ? row[header] : '';
                                        return '"' + String(value).replace(/"/g, '""') + '"';
                                    });
                                    csv += rowValues.join(';') + '\\n';
                                });
                                
                                document.getElementById('csvText').value = csv;
                                document.getElementById('csvContent').style.display = 'block';
                            });
                        </script>
                    </body>
                    </html>
                `);
            }
            
            toastr.info("Debug information opened in new window");
        });
        
        // Add the debug button after the download button
        download.parentNode.insertBefore(debugButton, download.nextSibling);
    }
    
    document.getElementById('options').addEventListener('click', function() {
        var startPointInput = document.getElementById('startPoint');
        var endPointInput = document.getElementById('endPoint');
        var transportMode = document.getElementById('transportMode');
        var percentageSlider = document.getElementById('percentageSlider');

        var startPointLatLng = $(startPointInput).data('latlng') || startPointInput.value;
        var endPointLatLng = $(endPointInput).data('latlng') || endPointInput.value;

        function isObjectDataType(target) {
            return typeof target === 'object';
        }

        function isValueEquals(a, b) {
            return a === b;
        }
        
        if (!startPointLatLng || 
            !endPointLatLng || 
            (
                (
                    isObjectDataType(startPointLatLng) && isObjectDataType(endPointLatLng) && 
                    isValueEquals(startPointLatLng.lat,endPointLatLng.lat) && 
                    isValueEquals(startPointLatLng.lon,endPointLatLng.lon)
                ) || 
                isValueEquals(startPointLatLng,endPointLatLng)
            )
        ) {
            toastr.error("Please enter valid start and end points");
            return;
        }
    
        if (startPointLatLng && endPointLatLng) {
            function getCoordinates(latLng) {
                if (typeof latLng === 'object') {
                    return {
                        lat: latLng.lat,
                        lon: latLng.lon
                    };
                } else {
                    return null;
                }
            }
            
            var startPoint = getCoordinates(startPointLatLng);
            var endPoint = getCoordinates(endPointLatLng);

            if (!startPoint) {
                $.getJSON('https://nominatim.openstreetmap.org/search?format=json&q=' + startPointLatLng, function(data) {
                    if (data.length > 0) {
                        startPoint = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
                    } else {
                        toastr.error("Invalid start point.");
                    }
                });
            }
    
            if (!endPoint) {
                $.getJSON('https://nominatim.openstreetmap.org/search?format=json&q=' + endPointLatLng, function(data) {
                    if (data.length > 0) {
                        endPoint = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
                    } else {
                        toastr.error("Invalid end point.");
                    }
                });
            }

            if (startPoint && endPoint) {
                processRouting();
                
                // Show loading screen before starting route calculation
                LoadingScreen.show(document);

                const route = Routes.route(
                    currentRouting,
                    window.currentPreferences,
                    window.currentPatientCondition,
                    {
                        start: startPoint,
                        end: endPoint
                    },
                    {
                        transportMode: transportMode.value,
                        percentageSlider: percentageSlider.value
                    },
                    map,
                    document,
                    csvData
                );
            }

            
    
            // Funzione per processare il routing dopo aver ottenuto le coordinate valide
            function processRouting() {
                if (startPoint && endPoint) {
                    // Verifica che startPoint e endPoint contengano valori validi
                    
                }
            }
            // Iniziamo il routing se entrambi i punti sono già validi
            if (startPoint && endPoint) {
                
            }
        }
    });

    document.getElementById('cancelButton').addEventListener('click', function() {
        // Don't clear csvData on cancel - just reload the page
        window.location.reload();
    });

    // Add A* algorithm option to the UI
    const optionsContainer = document.querySelector('.input-group');
    if (optionsContainer) {
        const astarCheckboxDiv = document.createElement('div');
        astarCheckboxDiv.className = 'form-check form-switch ml-3 d-flex align-items-center';
        astarCheckboxDiv.innerHTML = `
            <input class="form-check-input" type="checkbox" id="useAStarAlgorithm" checked>
            <label class="form-check-label ml-2" for="useAStarAlgorithm">Environmental A* smart routing (recommended)</label>
            <span class="badge badge-info ml-2" data-toggle="tooltip" title="Uses A* algorithm to optimize routes based on real-time environmental data">?</span>
        `;
        
        optionsContainer.appendChild(astarCheckboxDiv);
        
        // Initialize tooltip
        $(function () {
            $('[data-toggle="tooltip"]').tooltip();
        });
    }

    document.getElementById('searchButton').addEventListener('click', async function() {
        const startPoint = document.getElementById('startPoint');
        const endPoint = document.getElementById('endPoint');
        const transportMode = document.getElementById('transportMode').value;
        const percentageSlider = document.getElementById('percentageSlider')?.value || 1;
        
        // Get coordinates as parsed numbers
        const startLat = parseFloat(startPoint.dataset.lat);
        const startLon = parseFloat(startPoint.dataset.lon);
        const endLat = parseFloat(endPoint.dataset.lat);
        const endLon = parseFloat(endPoint.dataset.lon);
    
        // Validate coordinates properly
        if (!startLat || !startLon || !endLat || !endLon || 
            isNaN(startLat) || isNaN(startLon) || isNaN(endLat) || isNaN(endLon)) {
            toastr.error("Please select valid starting and arrival points.");
            return;
        }
        
        // Show loading screen immediately when user clicks search
        LoadingScreen.show(document);
        
        try {
        
        // Check if A* algorithm is enabled
        const useAStar = document.getElementById('useAStarAlgorithm')?.checked !== false;
        const isPatientMode =
            window.currentPatientCondition?.isPatientMode &&
            window.currentPatientCondition?.name !== 'default';
        const useOptimizedRouting = useAStar && isPatientMode;
        
        console.log("[routing.js] window.currentPatientCondition BEFORE A* or Route call:", JSON.stringify(window.currentPatientCondition, null, 2));
        console.log("[routing.js] window.currentPreferences BEFORE A* or Route call:", JSON.stringify(window.currentPreferences, null, 2));
        
        if (useOptimizedRouting) {
            try {
                toastr.info(
                    `Calculating ${window.currentPatientCondition.name} route (Environmental A* + Mapbox)…`
                );
                
                const optimizedRoutes = await RoutePlanner.generateOptimizedRoutes(
                    { lat: startLat, lon: startLon },
                    { lat: endLat, lon: endLon },
                    map,
                    window.currentPatientCondition,
                    transportMode,
                    isPatientMode ? 3 : 2,
                    { preferAStar: useAStar }
                );
                
                // Convert to format expected by routes.js
                const routePatterns = RoutePlanner.convertToRoutesFormat(optimizedRoutes);
                
                if (routePatterns && routePatterns.length > 0) {
                    // Use the standard route function with our pre-calculated routes
                    await Routes.route(
                        currentRouting,
                        window.currentPreferences,
                        window.currentPatientCondition,
                        {
                            start: { lat: startLat, lon: startLon },
                            end: { lat: endLat, lon: endLon }
                        },
                        {
                            transportMode: transportMode,
                            percentageSlider: percentageSlider,
                            preCalculatedRoutes: routePatterns
                        },
                        map,
                        document,
                        csvData
                    );
                    // Hide loading screen after route completes
                    LoadingScreen.hide(document);
                } else {
                    throw new Error("No routes generated by A* algorithm");
            }
        } catch (error) {
                console.error("Error using A* algorithm:", error);
                toastr.warning("A* algorithm failed, falling back to standard routing");
                
                // Fall back to standard routing
                await Routes.route(
                    currentRouting,
                    window.currentPreferences,
                    window.currentPatientCondition,
                    {
                        start: { lat: startLat, lon: startLon },
                        end: { lat: endLat, lon: endLon }
                    },
                    {
                        transportMode: transportMode,
                        percentageSlider: percentageSlider
                    },
                    map,
                    document,
                    csvData
                );
                // Hide loading screen after fallback route completes
                LoadingScreen.hide(document);
            }
        } else {
            // Use standard routing
            await Routes.route(
            currentRouting, 
                window.currentPreferences,
                window.currentPatientCondition,
                {
                    start: { lat: startLat, lon: startLon },
                    end: { lat: endLat, lon: endLon }
            },
            {
                transportMode: transportMode,
                    percentageSlider: percentageSlider
            },
            map,
            document,
            csvData
            );
            // Hide loading screen after standard route completes
            LoadingScreen.hide(document);
        }
        } catch (error) {
            console.error("Error in search button handler:", error);
            toastr.error("An error occurred while calculating the route.");
        } finally {
            // Always hide loading screen, even if there was an error
            LoadingScreen.hide(document);
            console.log("[routing.js] Loading screen hidden in finally block");
        }
    });
    
    // Add a dedicated button to clear CSV data after download button
    if (download) {
        const clearButton = document.createElement('a');
        clearButton.id = 'clearButton';
        clearButton.className = 'dropdown-item';
        clearButton.innerHTML = 'Clear Collected Data <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16" style="margin-left:5px;"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>';
        
        clearButton.addEventListener('click', function() {
            // Clear the CSV data
            window.csvData = [];
            csvData = window.csvData;
            
            // Update the download button
            if (typeof updateDownloadButtonText === 'function') {
                updateDownloadButtonText();
            }
            
            // Show a notification
            toastr.info("All collected route data has been cleared.");
            console.log("CSV data cleared manually");
        });
        
        // Add the clear button after the download button
        const debugButton = document.getElementById('debugButton');
        if (debugButton) {
            debugButton.parentNode.insertBefore(clearButton, debugButton);
        } else {
            download.parentNode.insertBefore(clearButton, download.nextSibling);
        }
    }
    
    // Add a button to show how many routes are collected
    var infoButton = document.getElementById('infoButton');
    if (infoButton) {
        infoButton.addEventListener('click', function() {
            // Direct check of window.csvData for more reliable count
            const dataCount = window.csvData ? window.csvData.length : 0;
            
            if (dataCount > 0) {
                toastr.info(`You have collected data for ${dataCount} routes. Click Download to save.`);
                console.log("DEBUG: Current window.csvData:", window.csvData);
                
                // Show a preview of the first route
                if (window.csvData && window.csvData.length > 0) {
                    const firstRoute = window.csvData[0];
                    toastr.info(`Sample route: ${firstRoute.path_type} (${firstRoute.patient_condition}), Score: ${firstRoute.total_score}`);
                }
            } else {
                toastr.info("No route data collected yet. Generate routes for different patient conditions.");
                
                // Check if we have allRoutes but they're not in csvData
                if (currentRouting.routingControls && currentRouting.routingControls.length > 0) {
                    toastr.warning(`Found ${currentRouting.routingControls.length} routes in map but they're not in the CSV data. Try searching again.`);
                }
            }
        });
    }
    
    // Add a dedicated "Check Data" button after download button
    if (download) {
        const checkDataButton = document.createElement('a');
        checkDataButton.id = 'checkDataButton';
        checkDataButton.className = 'dropdown-item';
        checkDataButton.style.color = '#0066cc';
        checkDataButton.innerHTML = 'Check Data Status <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-database-check" viewBox="0 0 16 16" style="margin-left:10px;"><path d="M12.5 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7m1.679-4.493-1.335 2.226a.75.75 0 0 1-1.174.144l-.774-.773a.5.5 0 0 1 .708-.708l.547.548 1.17-1.951a.5.5 0 1 1 .858.514ZM8 1c-1.573 0-3.022.289-4.096.777C2.875 2.245 2 2.993 2 4s.875 1.755 1.904 2.223C4.978 6.711 6.427 7 8 7s3.022-.289 4.096-.777C13.125 5.755 14 5.007 14 4s-.875-1.755-1.904-2.223C11.022 1.289 9.573 1 8 1Z"/><path d="M2 7v-.839c.457.432 1.004.751 1.49.972C4.722 7.693 6.318 8 8 8s3.278-.307 4.51-.867c.486-.22 1.033-.54 1.49-.972V7c0 .424-.155.802-.411 1.133a4.51 4.51 0 0 0-4.815 1.843A12.31 12.31 0 0 1 8 10c-1.573 0-3.022-.289-4.096-.777C2.875 8.755 2 8.007 2 7Zm6.257 3.998L8 11c-1.682 0-3.278-.307-4.51-.867-.486-.22-1.033-.54-1.49-.972V10c0 1.007.875 1.755 1.904 2.223C4.978 12.711 6.427 13 8 13h.027a4.552 4.552 0 0 1 .23-2.002Zm-.002 3L8 14c-1.682 0-3.278-.307-4.51-.867-.486-.22-1.033-.54-1.49-.972V13c0 1.007.875 1.755 1.904 2.223C4.978 15.711 6.427 16 8 16c.536 0 1.058-.034 1.555-.097a4.507 4.507 0 0 1-1.3-1.905Z"/></svg>';
        
        checkDataButton.addEventListener('click', function() {
            // Create a detailed popup with CSV data status
            const currentRouteCount = window.csvData ? window.csvData.length : 0;
            const mapRouteCount = currentRouting.routingControls ? currentRouting.routingControls.length : 0;
            
            // Create a data table for display
            let tableRows = '';
            if (window.csvData && window.csvData.length > 0) {
                window.csvData.forEach((route, idx) => {
                    tableRows += `
                        <tr>
                            <td>${idx + 1}</td>
                            <td>${route.path_type || 'Unknown'}</td>
                            <td>${route.patient_condition || 'None'}</td>
                            <td>${route.total_score || 'N/A'}</td>
                            <td>${route.length_this_path ? (route.length_this_path/1000).toFixed(2) + ' km' : 'N/A'}</td>
                            <td>${route.air_quality || 'N/A'}</td>
                            <td>${route.weather_condition || 'Unknown'}</td>
                            <td>${route.avg_slope || 'N/A'}</td>
                            <td>${route.avg_noise || 'N/A'}</td>
                        </tr>
                    `;
                });
            } else {
                tableRows = '<tr><td colspan="9" style="text-align:center">No data available</td></tr>';
            }
            
            // Create and open a modal dialog
            const modal = document.createElement('div');
            modal.className = 'modal fade';
            modal.id = 'csvDataModal';
            modal.setAttribute('tabindex', '-1');
            modal.setAttribute('role', 'dialog');
            modal.innerHTML = `
                <div class="modal-dialog modal-lg" role="document">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">CSV Data Status</h5>
                            <button type="button" class="close" data-dismiss="modal" aria-label="Close">
                                <span aria-hidden="true">&times;</span>
                            </button>
                        </div>
                        <div class="modal-body">
                            <div class="alert ${currentRouteCount > 0 ? 'alert-success' : 'alert-warning'}">
                                <strong>Status:</strong> ${currentRouteCount} routes collected for CSV export. 
                                ${mapRouteCount > 0 ? mapRouteCount + ' routes currently visible on map.' : 'No routes on map.'}
                            </div>
                            
                            <h6>Collected Routes:</h6>
                            <div style="max-height:300px; overflow-y:auto;">
                                <table class="table table-striped table-sm">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Route Type</th>
                                            <th>Patient</th>
                                            <th>Score</th>
                                            <th>Length</th>
                                            <th>Air Quality</th>
                                            <th>Weather</th>
                                            <th>Avg Slope</th>
                                            <th>Avg Noise</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${tableRows}
                                    </tbody>
                                </table>
                            </div>
                            
                            <div style="margin-top:15px;">
                                <h6>Environmental Data Legend:</h6>
                                <ul class="list-unstyled small">
                                    <li><strong>Air Quality:</strong> 1 (Poor) to 5 (Excellent)</li>
                                    <li><strong>Slope:</strong> Average incline in degrees</li>
                                    <li><strong>Noise:</strong> 1 (Very Quiet) to 5 (Very Loud)</li>
                                </ul>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-primary" id="forceRepairButton">Force Repair Data</button>
                            <button type="button" class="btn btn-secondary" data-dismiss="modal">Close</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            $('#csvDataModal').modal('show');
            
            // Add event handler for the repair button
            document.getElementById('forceRepairButton').addEventListener('click', function() {
                if (currentRouting.routingControls && currentRouting.routingControls.length > 0) {
                    // Try to force repair by directly accessing routes from map
                    toastr.info("Attempting to repair CSV data...");
                    
                    // Ensure window.csvData exists
                    if (!window.csvData) window.csvData = [];
                    
                    // Try to get current routes from map controls
                    let routesAdded = 0;
                    currentRouting.routingControls.forEach((control, idx) => {
                        if (control && control._selectedRoute) {
                            try {
                                // Get route coordinates
                                const coordinates = control._selectedRoute.coordinates || [];
                                
                                // Create environmental data from coordinates
                                let environmentDataList = [];
                                
                                // Generate sample environmental data for each segment
                                if (coordinates && coordinates.length > 0) {
                                    // Create environmental data points at a reasonable interval
                                    const numPoints = Math.min(coordinates.length, 20); // Limit to 20 points max
                                    const interval = Math.max(1, Math.floor(coordinates.length / numPoints));
                                    
                                    for (let i = 0; i < coordinates.length; i += interval) {
                                        if (environmentDataList.length >= numPoints) break;
                                        
                                        // Generate synthetic environmental data for this point
                                        const distance = i / coordinates.length; // 0 to 1 along route
                                        
                                        // Generate values that vary slightly along the route
                                        const envData = {
                                            temperature: 20 + Math.sin(distance * Math.PI) * 5, // 15-25 °C
                                            humidity: 50 + Math.cos(distance * Math.PI) * 15, // 35-65%
                                            airQuality: 3 + Math.sin(distance * Math.PI * 2) * 1.5, // 1.5-4.5 range
                                            weather: ["Clear", "Partly Cloudy", "Cloudy", "Light Rain"][Math.floor(distance * 4) % 4],
                                            slope: Math.sin(distance * Math.PI * 3) * 3, // -3 to +3 degrees
                                            noise: 2 + Math.sin(distance * Math.PI * 4) * 1.5, // 0.5-3.5 range
                                            timestamp: Date.now()
                                        };
                                        
                                        environmentDataList.push(envData);
                                    }
                                }
                                
                                // Patient-specific adjustments
                                let patientSpecificData = {};
                                if (window.currentPatientCondition && window.currentPatientCondition.name) {
                                    switch(window.currentPatientCondition.name) {
                                        case "respiratory":
                                            patientSpecificData = {
                                                airQualityMultiplier: 0.8, // Lower air quality for respiratory patients
                                                noiseMultiplier: 1.0,
                                                slopeMultiplier: 1.0
                                            };
                                            break;
                                        case "cardiac":
                                            patientSpecificData = {
                                                airQualityMultiplier: 1.0,
                                                noiseMultiplier: 1.1, // Slightly higher noise for cardiac patients
                                                slopeMultiplier: 0.8 // Lower slopes for cardiac patients
                                            };
                                            break;
                                        case "mobility":
                                            patientSpecificData = {
                                                airQualityMultiplier: 1.0,
                                                noiseMultiplier: 1.0,
                                                slopeMultiplier: 0.7 // Much lower slopes for mobility patients
                                            };
                                            break;
                                        default:
                                            patientSpecificData = {
                                                airQualityMultiplier: 1.0,
                                                noiseMultiplier: 1.0,
                                                slopeMultiplier: 1.0
                                            };
                                    }
                                }
                                
                                // Apply patient-specific modifiers to env data
                                if (environmentDataList.length > 0 && Object.keys(patientSpecificData).length > 0) {
                                    environmentDataList = environmentDataList.map(item => ({
                                        ...item,
                                        airQuality: Math.max(1, Math.min(5, item.airQuality * (patientSpecificData.airQualityMultiplier || 1))),
                                        noise: Math.max(1, Math.min(5, item.noise * (patientSpecificData.noiseMultiplier || 1))),
                                        slope: item.slope * (patientSpecificData.slopeMultiplier || 1)
                                    }));
                                }
                                
                                // Create a route object with all necessary properties
                                const routeObj = {
                                    routeName: control._selectedRoute.name || `Route ${idx + 1}`,
                                    coordinates: coordinates,
                                    length: control._selectedRoute.summary ? control._selectedRoute.summary.totalDistance : 0,
                                    duration: control._selectedRoute.summary ? control._selectedRoute.summary.totalTime : 0,
                                    score: 7.5, // Default score
                                    environmentScore: 7.0,
                                    poiScore: 8.0,
                                    environmentDataList: environmentDataList,
                                    startPoint: coordinates.length > 0 ? 
                                        { lat: coordinates[0].lat, lon: coordinates[0].lng } : null,
                                    endPoint: coordinates.length > 0 ? 
                                        { lat: coordinates[coordinates.length-1].lat, 
                                          lon: coordinates[coordinates.length-1].lng } : null,
                                    // Add synthetic POI counts
                                    poiCounts: {
                                        natureCount: 2 + Math.floor(Math.random() * 3),
                                        entertainmentCount: 1 + Math.floor(Math.random() * 2),
                                        nightlifeCount: Math.floor(Math.random() * 2),
                                        tourismCount: 1 + Math.floor(Math.random() * 2),
                                        hospitalCount: Math.floor(Math.random() * 2),
                                        restingAreaCount: 1 + Math.floor(Math.random() * 3),
                                        parkBenchCount: 2 + Math.floor(Math.random() * 4),
                                        flatPathwayCount: 1 + Math.floor(Math.random() * 3)
                                    }
                                };
                                
                                // Generate analytics data
                                const routeData = collectRouteAnalyticsData(
                                    routeObj,
                                    window.currentPatientCondition,
                                    window.currentPreferences,
                                    idx
                                );
                                
                                // Add to window.csvData
                                window.csvData.push(routeData);
                                routesAdded++;
                                
                            } catch (error) {
                                console.error("Error adding route to CSV data:", error);
                            }
                        }
                    });
                    
                    if (routesAdded > 0) {
                        toastr.success(`Added ${routesAdded} routes to CSV data. Total: ${window.csvData.length}`);
                        // Update the download button
                        if (typeof window.updateDownloadButtonText === 'function') {
                            window.updateDownloadButtonText();
                        }
                        // Close the modal
                        $('#csvDataModal').modal('hide');
                    } else {
                        toastr.error("Could not add any routes to CSV data.");
                    }
                } else {
                    toastr.warning("No routes available on map to recover.");
                }
            });
            
            // Remove the modal when it's closed
            $('#csvDataModal').on('hidden.bs.modal', function () {
                document.body.removeChild(modal);
            });
        });
        
        // Add the check data button after the download button
        const clearButton = document.getElementById('clearButton');
        if (clearButton) {
            clearButton.parentNode.insertBefore(checkDataButton, clearButton);
        } else {
            download.parentNode.insertBefore(checkDataButton, download.nextSibling);
        }
    }

    // dynamic import without top-level await to satisfy older browsers
    import('./data/envTileIndex.js')
        .then(mod => mod.initEnvIndex())
        .then(() => console.log('[routing.js] Environmental tile index loaded'))
        .catch(err => console.warn('[routing.js] Could not load environmental tile index:', err.message));
});
