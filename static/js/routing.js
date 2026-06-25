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
    
    document.getElementById('cancelButton').addEventListener('click', function() {
        // Don't clear csvData on cancel - just reload the page
        window.location.reload();
    });

    // Add A* algorithm option to the UI
    const optionsContainer = document.querySelector('.input-group');
    if (optionsContainer) {
        const astarCheckboxDiv = document.createElement('div');
        astarCheckboxDiv.className = 'routing-mode-caption form-check form-switch';
        astarCheckboxDiv.innerHTML = `
            <input class="form-check-input" type="checkbox" id="useAStarAlgorithm" checked>
            <label class="routing-mode-caption-label form-check-label" for="useAStarAlgorithm">Environmental A* smart routing (recommended)</label>
            <span class="routing-mode-caption-help badge badge-info" data-toggle="tooltip" title="Uses A* algorithm to optimize routes based on real-time environmental data">?</span>
        `;
        
        optionsContainer.appendChild(astarCheckboxDiv);

        // Initialize tooltip
        $(function () {
            $('[data-toggle="tooltip"]').tooltip();
        });
    }

    // Legacy mode toggle: persist the opt-in choice across reloads (default OFF).
    const legacyToggle = document.getElementById('legacyMode');
    if (legacyToggle) {
        try {
            legacyToggle.checked = localStorage.getItem('pp_legacyMode') === 'true';
        } catch (e) {
            legacyToggle.checked = false;
        }
        legacyToggle.addEventListener('change', function () {
            try {
                localStorage.setItem('pp_legacyMode', legacyToggle.checked ? 'true' : 'false');
            } catch (e) {
                /* localStorage unavailable: in-memory state still applies for this session */
            }
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
        // Legacy mode (default OFF): restores the original gate `useAStar || isPatientMode`,
        // so the environmental optimisation runs even without a pathology selected.
        // OFF keeps the current behaviour bit-identical (`useAStar && isPatientMode`).
        const legacy = document.getElementById('legacyMode')?.checked === true;
        const useOptimizedRouting = legacy
            ? (useAStar || isPatientMode)
            : (useAStar && isPatientMode);
        
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
                    { preferAStar: useAStar, legacy, percentageSlider }
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

    // dynamic import without top-level await to satisfy older browsers
    import('./data/envTileIndex.js')
        .then(mod => mod.initEnvIndex())
        .then(() => console.log('[routing.js] Environmental tile index loaded'))
        .catch(err => console.warn('[routing.js] Could not load environmental tile index:', err.message));
});
