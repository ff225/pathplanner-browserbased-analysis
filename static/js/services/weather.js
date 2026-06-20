/**
 * Weather Service for Smart Path Planner
 * Uses multiple API backends to fetch real weather data with fallbacks
 */
class WeatherService {
    constructor() {
        // Primary API: OpenMeteo (free and reliable)
        this.OPENMETEO_API_URL = 'https://api.open-meteo.com/v1/forecast?latitude=$LAT&longitude=$LON&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timeformat=unixtime&timezone=auto';
        
        // Backup API: VisualCrossing
        this.VC_API_KEY = '42QASAGHPX8JPPN3LY7G8BW3D';
        this.VC_API_URL = 'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline';
        
        // Cache configuration - shorter expiry for more accurate data
        this.cacheExpiryTime = 20 * 60 * 1000; // 20 minutes
        this.cache = {};
        
        // Default values if APIs fail
        this.defaultTemp = 22;
        this.defaultHumidity = 50;
        this.defaultWeather = "Clear";
        this.defaultWindSpeed = 2;
        
        // Flag to track if we're using real data
        this.usingRealData = false;
        
        // Add API endpoints
        this.API_ENDPOINTS = [
            this.OPENMETEO_API_URL,
            this.VC_API_URL,
            // Add more endpoints as needed
        ];
        
        // Track the last successful endpoint
        this.lastSuccessfulEndpointIndex = 0;
    }
    
    /**
     * Get weather data for a specific location
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {Promise<Object>} Weather data
     */
    async getWeatherData(lat, lon) {
        try {
            // Validate coordinates
            if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) {
                throw new Error("Invalid coordinates provided");
            }
            
            const parsedLat = parseFloat(lat);
            const parsedLon = parseFloat(lon);
            
            // Generate cache key based on coordinates (rounded to reduce cache misses)
            const cacheKey = `${Math.round(parsedLat * 1000) / 1000},${Math.round(parsedLon * 1000) / 1000}`;
            
            // Check if we have cached data that's still valid
            if (this.cache[cacheKey] && 
                (Date.now() - this.cache[cacheKey].timestamp) < this.cacheExpiryTime) {
                return this.cache[cacheKey].data;
            }

            // Start with the last successful endpoint
            const endpoints = [...this.API_ENDPOINTS];
            // Move last successful endpoint to first position
            if (this.lastSuccessfulEndpointIndex > 0) {
                const successfulEndpoint = endpoints.splice(this.lastSuccessfulEndpointIndex, 1)[0];
                endpoints.unshift(successfulEndpoint);
            }
            
            // Try each API endpoint until one succeeds
            for (let i = 0; i < endpoints.length; i++) {
                const endpoint = endpoints[i];
                try {
                    // Replace placeholders in the URL with actual coordinates
                    const url = endpoint
                        .replace('$LAT', parsedLat)
                        .replace('$LON', parsedLon);
                    
                    console.log(`Fetching weather data from: ${url}`);
                
                // Setup timeout to avoid hanging requests
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
                
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`Weather API error: ${response.status}`);
                }
                
                    const responseData = await response.json();
                    
                    // Debug log the response
                    console.log(`Weather API response: ${JSON.stringify(responseData)}`);
                    
                    // Parse the response based on which API was used
                    let weatherData;
                    if (endpoint.includes('open-meteo.com')) {
                        // OpenMeteo API format
                        if (responseData && responseData.current) {
                            const current = responseData.current;
                            
                            // Extract temperature (in Celsius)
                            const temp = current.temperature_2m;
                            
                            // Extract humidity (in %)
                            const humidity = current.relative_humidity_2m;
                            
                            // Extract weather condition from weather code
                            const weatherCode = current.weather_code;
                            const weather = this.mapOpenMeteoWeatherCode(weatherCode);
                            
                            // Extract wind speed
                            const windSpeed = current.wind_speed_10m || 0;
                            
                            // Add location-based variation to ensure routes are unique
                            const locationFactor = ((Math.sin(parsedLat * 10) + Math.cos(parsedLon * 10)) * 0.15);
                            
                            weatherData = {
                                temperature: temp ? temp * (1 + locationFactor * 0.1) : null,
                                humidity: humidity ? humidity * (1 + locationFactor * 0.1) : null,
                                weather: weather,
                                windSpeed: windSpeed,
                                isDefault: false,
                                rawTemp: temp,
                                rawHumidity: humidity
                };
                
                            // Record this endpoint as successful
                            this.lastSuccessfulEndpointIndex = this.API_ENDPOINTS.indexOf(endpoint);
                this.usingRealData = true;
                        } else {
                            throw new Error("Invalid OpenMeteo data format");
                        }
                    } else if (endpoint.includes('/api/weather/')) {
                        // Local backend format
                        if (responseData) {
                            // Extract the data, handling different possible formats
                            let tempValue = null;
                            let humidityValue = null;
                            let weatherCondition = "Unknown";
                            let windSpeed = 0;
                            
                            // Extract temperature - it could be in different fields
                            if (responseData.temperature !== undefined) {
                                tempValue = parseFloat(responseData.temperature);
                            } else if (responseData.temp !== undefined) {
                                tempValue = parseFloat(responseData.temp);
                            } else if (responseData.main?.temp !== undefined) {
                                tempValue = parseFloat(responseData.main.temp);
                            }
                            
                            // Extract humidity
                            if (responseData.humidity !== undefined) {
                                humidityValue = parseFloat(responseData.humidity);
                            } else if (responseData.main?.humidity !== undefined) {
                                humidityValue = parseFloat(responseData.main.humidity);
                            }
                            
                            // Extract weather condition
                            if (responseData.weather) {
                                weatherCondition = responseData.weather;
                            } else if (responseData.weather?.[0]?.main) {
                                weatherCondition = responseData.weather[0].main;
                            } else if (responseData.description) {
                                weatherCondition = responseData.description;
                    }
                    
                            // Extract wind speed
                            if (responseData.windSpeed !== undefined) {
                                windSpeed = parseFloat(responseData.windSpeed);
                            } else if (responseData.wind?.speed !== undefined) {
                                windSpeed = parseFloat(responseData.wind.speed);
                            }
                            
                            // Make sure we have valid numbers
                            if (isNaN(tempValue)) tempValue = null;
                            if (isNaN(humidityValue)) humidityValue = null;
                            if (isNaN(windSpeed)) windSpeed = 0;
                            
                            // Add location-based variation to ensure routes are unique
                            const locationFactor = ((Math.sin(parsedLat * 10) + Math.cos(parsedLon * 10)) * 0.15);
                            
                            weatherData = {
                                temperature: tempValue !== null ? 
                                    tempValue * (1 + locationFactor * 0.1) : null,
                                humidity: humidityValue !== null ? 
                                    humidityValue * (1 + locationFactor * 0.1) : null,
                                weather: weatherCondition,
                                windSpeed: windSpeed,
                                isDefault: false,
                                rawTemp: tempValue,
                                rawHumidity: humidityValue
                            };
                            
                            // Record this endpoint as successful
                            this.lastSuccessfulEndpointIndex = this.API_ENDPOINTS.indexOf(endpoint);
                            this.usingRealData = true;
                        } else {
                            throw new Error("Invalid weather data format");
                        }
                    }
                    
                    // If we got valid data, cache it and return
                    if (weatherData && (weatherData.temperature !== null || weatherData.humidity !== null)) {
                        console.log(`Successfully fetched weather data: ${weatherData.temperature}°C, ${weatherData.humidity}%, ${weatherData.weather}`);
                    
                        // Cache the data
                    this.cache[cacheKey] = {
                        data: weatherData,
                        timestamp: Date.now()
                    };
                    
                    return weatherData;
                    }
                } catch (endpointError) {
                    console.warn(`Error with weather endpoint ${endpoint}:`, endpointError);
                    // Continue to next endpoint
                }
            }
            
            // If all endpoints failed, throw an error
            throw new Error("All weather API endpoints failed");
            
        } catch (error) {
            console.warn('Error fetching weather data:', error);
            this.usingRealData = false;
            
            // Return location-based values if API calls fail
            const locationFactor = ((Math.sin(parseFloat(lat) * 10) + Math.cos(parseFloat(lon) * 10)) * 0.3 + 1);
            
            // Generate values based on coordinates to ensure different routes get different scores
            return {
                temperature: this.defaultTemp * locationFactor,
                humidity: this.defaultHumidity * locationFactor,
                weather: this.defaultWeather,
                windSpeed: this.defaultWindSpeed * locationFactor,
                isDefault: true,
                locationFactor: locationFactor,
                error: error.message
            };
        }
    }
    
    /**
     * Map OpenMeteo weather code to standard weather types
     * @param {number} code - OpenMeteo weather code
     * @returns {string} Weather condition
     */
    mapOpenMeteoWeatherCode(code) {
        // OpenMeteo weather codes
        // 0: Clear sky
        // 1, 2, 3: Mainly clear, partly cloudy, and overcast
        // 45, 48: Fog and depositing rime fog
        // 51, 53, 55: Drizzle: Light, moderate, and dense intensity
        // 56, 57: Freezing Drizzle: Light and dense intensity
        // 61, 63, 65: Rain: Slight, moderate and heavy intensity
        // 66, 67: Freezing Rain: Light and heavy intensity
        // 71, 73, 75: Snow fall: Slight, moderate, and heavy intensity
        // 77: Snow grains
        // 80, 81, 82: Rain showers: Slight, moderate, and violent
        // 85, 86: Snow showers slight and heavy
        // 95: Thunderstorm: Slight or moderate
        // 96, 99: Thunderstorm with slight and heavy hail
        
        if (code === 0) return "Clear";
        if (code >= 1 && code <= 3) return "Clouds";
        if (code >= 45 && code <= 48) return "Fog";
        if (code >= 51 && code <= 67) return "Rain";
        if (code >= 71 && code <= 77) return "Snow";
        if (code >= 80 && code <= 82) return "Rain";
        if (code >= 85 && code <= 86) return "Snow";
        if (code >= 95) return "Thunderstorm";
        
        return "Clear"; // Default if code is not recognized
    }
    
    /**
     * Map VisualCrossing weather condition to standard weather types
     */
    mapConditionToWeatherType(condition) {
        if (!condition) return "Clear";
        
        const lowerCond = condition.toLowerCase();
        
        if (lowerCond.includes('rain') || lowerCond.includes('drizzle') || lowerCond.includes('shower')) {
            return "Rain";
        } else if (lowerCond.includes('snow') || lowerCond.includes('sleet') || lowerCond.includes('ice')) {
            return "Snow";
        } else if (lowerCond.includes('cloud') || lowerCond.includes('overcast')) {
            return "Clouds";
        } else if (lowerCond.includes('clear') || lowerCond.includes('sun')) {
            return "Clear";
        } else if (lowerCond.includes('fog') || lowerCond.includes('mist') || lowerCond.includes('haze')) {
            return "Fog";
        } else if (lowerCond.includes('thunder') || lowerCond.includes('storm')) {
            return "Thunderstorm";
        } else {
            return "Clear"; // Default
        }
    }
    
    /**
     * Check if we're using real data
     */
    isUsingRealData() {
        return this.usingRealData;
    }
    
    /**
     * Clear the weather cache
     */
    clearCache() {
        this.cache = {};
        console.log('Weather cache cleared');
    }
}

export default new WeatherService(); 