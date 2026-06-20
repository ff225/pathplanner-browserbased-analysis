/**
 * Air Quality Service for Smart Path Planner
 * Uses multiple API backends to fetch air quality data with fallbacks
 */
import * as AirQualityGoogle from './airQualityGoogle.js';

export class AirQualityService {
    constructor() {
        // API endpoints - try multiple sources for better reliability
        this.API_ENDPOINTS = [
            '/api/air_quality/',                                     // Local backend (ARPAE) - primary
            'custom_google_air_quality',                             // Google Air Quality API - secondary
            'https://api.waqi.info/feed/geo:$LAT;$LON/?token=1a0c8d20be07583bd58fddc4af35b7af97f9ab7d', // WAQI API (backup)
        ];
        
        // Cache settings
        this.cacheExpiryTime = 15 * 60 * 1000; // 15 minutes in milliseconds (reduced from 30 minutes)
        this.cache = {};
        
        // Default AQI value if API call fails (moderate)
        this.defaultAQI = 5;
        
        // Flag to indicate we're using real data
        this.usingRealData = false;
        
        // Track API responsiveness
        this.lastSuccessfulEndpointIndex = 0;
    }
    
    /**
     * Get air quality data for a specific location
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {Promise<Object>} Air quality data
     */
    async getAirQualityData(lat, lon) {
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
                    // Special handling for Google Air Quality API
                    if (endpoint === 'custom_google_air_quality') {
                        console.log(`Fetching air quality data from Google Air Quality API`);
                        
                        const googleData = await AirQualityGoogle.get(parsedLat, parsedLon);
                        
                        if (googleData && googleData.airQuality) {
                            // Google API returns a value on a 1-10 scale already
                            const airQualityValue = googleData.airQuality;
                            
                            // Add a small location-based variation for distinct routes
                            const variation = ((Math.sin(parsedLat * 10) + Math.cos(parsedLon * 10)) * 0.15);
                            const finalValue = Math.max(1, Math.min(10, airQualityValue * (1 + variation)));
                            
                            const airQualityData = {
                                airQuality: finalValue,
                                isDefault: false,
                                rawValue: airQualityValue,
                                source: 'Google Air Quality API',
                                variation: variation
                            };
                            
                            // Record this endpoint as successful
                            this.lastSuccessfulEndpointIndex = this.API_ENDPOINTS.indexOf(endpoint);
                            this.usingRealData = true;
                            
                            // Cache the data
                            this.cache[cacheKey] = {
                                data: airQualityData,
                                timestamp: Date.now()
                            };
                            
                            return airQualityData;
                        }
                        throw new Error("Invalid Google Air Quality data");
                    }
                    
                    // For standard REST APIs
                    // Replace placeholders in the URL with actual coordinates
                    const url = endpoint
                        .replace('$LAT', parsedLat)
                        .replace('$LON', parsedLon);
                    
                    console.log(`Fetching air quality data from: ${url}`);
                    
                    // Setup timeout to avoid hanging requests
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
                    
                    const response = await fetch(url, { signal: controller.signal });
                    clearTimeout(timeoutId);
                    
                    if (!response.ok) {
                        throw new Error(`Air Quality API error: ${response.status}`);
                    }
                    
                    const responseData = await response.json();
                    
                    // Debug the actual API response
                    console.log(`Air Quality API response:`, JSON.stringify(responseData));
                    
                    // Parse the response based on which API was used
                    let airQualityData;
                    if (endpoint.includes('/api/air_quality/')) {
                        // Local backend format (ARPAE) - parse response content
                        if (responseData && typeof responseData === 'object') {
                            // Extract the value - could be in different fields
                            let airQualityValue = null;
                            
                            // The response is {"value": 42}
                            if (responseData.value !== undefined) {
                                airQualityValue = parseFloat(responseData.value);
                            } else if (responseData.aqi !== undefined) {
                                airQualityValue = parseFloat(responseData.aqi);
                            } else if (responseData.airQuality !== undefined) {
                                airQualityValue = parseFloat(responseData.airQuality);
                            }
                            
                            // If we have a valid number, use it
                            if (!isNaN(airQualityValue) && airQualityValue !== null) {
                                console.log(`Extracted air quality value: ${airQualityValue}`);
                                
                                // Convert to our 1-10 scale if needed
                                const scaledValue = this.normalizeAQIValue(airQualityValue);
                                
                                // Add a small location-based variation for distinct routes
                                const variation = ((Math.sin(parsedLat * 10) + Math.cos(parsedLon * 10)) * 0.15);
                                const finalValue = Math.max(1, Math.min(10, scaledValue * (1 + variation)));
                                
                        airQualityData = {
                                    airQuality: finalValue,
                                    isDefault: false,
                                    rawValue: airQualityValue,
                                    scaledValue: scaledValue,
                                    source: 'ARPAE API',
                                    variation: variation
                                };
                                
                                // Record this endpoint as successful
                                this.lastSuccessfulEndpointIndex = this.API_ENDPOINTS.indexOf(endpoint);
                                this.usingRealData = true;
                            } else {
                                console.warn(`Could not extract valid air quality value from:`, responseData);
                                throw new Error("Invalid air quality data format");
                            }
                        } else {
                            throw new Error("Invalid air quality data response");
                        }
                    } else if (endpoint.includes('waqi.info')) {
                        // WAQI API format - convert their scale to our 1-10 scale
                        const aqiValue = responseData.data?.aqi;
                        if (!aqiValue || aqiValue === 0) {
                            throw new Error("Invalid WAQI data received");
                        }
                        
                        const baseAirQuality = this.convertWAQItoScale(aqiValue);
                        // Create slight variation based on coordinates (±15%)
                        const variation = ((Math.sin(parsedLat * 10) + Math.cos(parsedLon * 10)) * 0.15);
                        const airQuality = Math.max(1, Math.min(10, baseAirQuality * (1 + variation)));
                        
                        airQualityData = {
                            airQuality: airQuality,
                            isDefault: false,
                            baseValue: baseAirQuality,
                            source: 'WAQI API',
                            variation: variation
                        };
                        
                        // Record this endpoint as successful
                        this.lastSuccessfulEndpointIndex = this.API_ENDPOINTS.indexOf(endpoint);
                        this.usingRealData = true;
                    }
                    
                    // If we got valid data, cache it and return
                    if (airQualityData && !isNaN(airQualityData.airQuality)) {
                        console.log(`Successfully fetched air quality data: ${airQualityData.airQuality} from ${airQualityData.source || endpoint}`);
                        
                        // Cache the data
                        this.cache[cacheKey] = {
                            data: airQualityData,
                            timestamp: Date.now()
                        };
                        
                        return airQualityData;
                    }
                } catch (endpointError) {
                    console.warn(`Error with air quality endpoint ${endpoint}:`, endpointError);
                    // Continue to next endpoint
                }
            }
            
            // If all endpoints failed, throw an error
            throw new Error("All air quality API endpoints failed");
            
        } catch (error) {
            console.warn('Error fetching air quality data:', error);
            this.usingRealData = false;
            
            // Return location-based values if API calls fail to ensure different routes have different scores
            const locationFactor = ((Math.sin(parseFloat(lat) * 10) + Math.cos(parseFloat(lon) * 10)) * 0.4 + 1);
            const airQuality = Math.max(1, Math.min(10, this.defaultAQI * locationFactor));
            
            return {
                airQuality: airQuality,
                error: error.message,
                isDefault: true,
                locationFactor: locationFactor
            };
        }
    }
    
    /**
     * Convert WAQI AQI value (0-500) to our 1-10 scale
     */
    convertWAQItoScale(waqi) {
        if (!waqi || isNaN(waqi)) return this.defaultAQI;
        
        // WAQI scale: 0-50 (Good), 51-100 (Moderate), 101-150 (Unhealthy for Sensitive), 
        // 151-200 (Unhealthy), 201-300 (Very Unhealthy), 301+ (Hazardous)
        
        if (waqi <= 25) return 1; // Excellent
        if (waqi <= 50) return 2; // Very Good
        if (waqi <= 75) return 3; // Good
        if (waqi <= 100) return 4; // Moderate
        if (waqi <= 125) return 5; // Moderate-Poor
        if (waqi <= 150) return 6; // Poor
        if (waqi <= 200) return 7; // Poor-Very Poor
        if (waqi <= 300) return 8; // Very Poor
        if (waqi <= 400) return 9; // Extremely Poor
        return 10; // Hazardous
    }
    
    /**
     * Check if we're using real data
     */
    isUsingRealData() {
        return this.usingRealData;
    }
    
    /**
     * Clear the cache
     */
    clearCache() {
        this.cache = {};
        console.log('Air quality cache cleared');
    }
    
    /**
     * Normalize AQI values from different scales to our 1-10 scale
     */
    normalizeAQIValue(value) {
        // If the value is very small (like 0-10), it might be on a 0-10 scale already
        if (value >= 0 && value <= 10) {
            return value;
        }
        
        // If it's in the typical AQI range (0-500), convert to our scale
        if (value >= 0 && value <= 500) {
            // Convert AQI 0-500 to our 1-10 scale
            // 0-50 (Good) => 1-2
            // 51-100 (Moderate) => 3-4
            // 101-150 (Unhealthy for Sensitive) => 5-6
            // 151-200 (Unhealthy) => 7-8
            // 201-300 (Very Unhealthy) => 9
            // 301+ (Hazardous) => 10
            
            if (value <= 50) return 1 + (value / 50);
            if (value <= 100) return 3 + ((value - 51) / 49);
            if (value <= 150) return 5 + ((value - 101) / 49);
            if (value <= 200) return 7 + ((value - 151) / 49);
            if (value <= 300) return 9;
            return 10;
        }
        
        // For other scales, just ensure it's in our 1-10 range
        return Math.max(1, Math.min(10, value / 5));
    }
}

// Create and export a singleton instance
export default new AirQualityService();