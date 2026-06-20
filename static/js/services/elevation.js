// Constants for API configuration
const MAPBOX_ACCESS_TOKEN = globalThis.window?.MAPBOX_ACCESS_TOKEN || '';

class ElevationService {
    constructor() {
        // Using OpenTopoData API with SRTM dataset
        this.API_BASE_URL = 'https://api.opentopodata.org/v1/srtm';
        this.MAX_POINTS_PER_REQUEST = 100; // API limit
        
        // For local development, prefer local fallback
        this.FALLBACK_ENABLED = false; // Changed to false to force using real data
        this.USE_PROXY = true; // Set to true to use proxy if available
        this.PROXY_URL = '/api/proxy/elevation'; // Create this endpoint on your server
        
        // Set to false to use real data instead of simulated data
        this.USE_LOCAL_FALLBACK = false; // Changed to false to prioritize real data
        this.DEVELOPMENT_MODE = false; // Force using real data
    }

    async getElevation(lat, lng) {
        try {
            const url = `${this.API_BASE_URL}?locations=${lat},${lng}`;
            console.log('Fetching elevation data from:', url);
            
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.results && data.results.length > 0) {
                const elevation = data.results[0].elevation;
                console.log(`Elevation for ${lat},${lng}: ${elevation}m`);
                return elevation;
            }
            
            return null;
        } catch (error) {
            console.warn('Error fetching elevation:', error);
            return null;
        }
    }

    async getElevationForPath(waypoints) {
        if (!waypoints || waypoints.length === 0) {
            console.warn('No waypoints provided for elevation data');
            return [];
        }
        
        // In development mode, just return simulated data 
        if (this.DEVELOPMENT_MODE) {
            console.log('Development mode active: Using simulated elevation data');
            return this.simulateElevationData(waypoints);
        }
        
        try {
            // Format waypoints for API
            const locationString = waypoints.map(wp => {
                // Ensure we have valid coordinates
                if (!wp || isNaN(parseFloat(wp.lat)) || 
                   (isNaN(parseFloat(wp.lng)) && isNaN(parseFloat(wp.lon)))) {
                    console.warn('Invalid waypoint:', wp);
                    return null;
                }
                // Convert to string with proper format: lat,lng
                return `${parseFloat(wp.lat)},${parseFloat(wp.lng || wp.lon)}`;
            }).filter(Boolean).join('|');
            
            // Check if we have a valid location string
            if (!locationString) {
                throw new Error('No valid waypoints for elevation request');
            }
            
            // Split into chunks to respect API limits
            const chunks = this.chunkLocationString(locationString);
            let allElevations = [];
            
            // Process each chunk
            for (const chunk of chunks) {
                try {
                    // Try direct API first if CORS proxy not enabled
                    if (!this.USE_PROXY) {
                        const directElevations = await this.fetchDirectFromAPI(chunk);
                        if (directElevations && directElevations.length > 0) {
                            allElevations = [...allElevations, ...directElevations];
                            continue;
                        }
                    }
                    
                    // If CORS proxy is enabled or direct failed
                    if (this.USE_PROXY) {
                        const proxyElevations = await this.fetchThroughProxy(chunk);
                        if (proxyElevations && proxyElevations.length > 0) {
                            allElevations = [...allElevations, ...proxyElevations];
                            continue;
                        }
                    }
                    
                    // If all API methods fail, use local fallback
                    if (this.USE_LOCAL_FALLBACK && this.FALLBACK_ENABLED) {
                        const fallbackElevations = this.generateFallbackElevations(chunk);
                        allElevations = [...allElevations, ...fallbackElevations];
                    }
                } catch (chunkError) {
                    console.warn(`Error fetching chunk: ${chunkError.message}`);
                    // Use fallback for this chunk
                    if (this.USE_LOCAL_FALLBACK && this.FALLBACK_ENABLED) {
                        const fallbackElevations = this.generateFallbackElevations(chunk);
                        allElevations = [...allElevations, ...fallbackElevations];
                    }
                }
            }
            
            // If we have no data, throw error to trigger fallback
            if (allElevations.length === 0) {
                throw new Error('No elevation data retrieved from any source');
            }
            
            return allElevations;
        } catch (error) {
            console.warn('Error fetching path elevations:', error);
            
            // Always fall back to simulated data if needed
            if (this.USE_LOCAL_FALLBACK && this.FALLBACK_ENABLED) {
                console.log('Using simulated elevation data');
                return this.simulateElevationData(waypoints);
            }
            return [];
        }
    }
    
    // Helper to chunk location string to respect API limits
    chunkLocationString(locationString) {
        const locations = locationString.split('|');
        const chunks = [];
        
        for (let i = 0; i < locations.length; i += this.MAX_POINTS_PER_REQUEST) {
            chunks.push(locations.slice(i, i + this.MAX_POINTS_PER_REQUEST).join('|'));
        }
        
        return chunks;
    }
    
    // Direct API call (will fail with CORS in browser)
    async fetchDirectFromAPI(locationChunk) {
        try {
            const url = `${this.API_BASE_URL}?locations=${encodeURIComponent(locationChunk)}`;
            console.log('Fetching elevation data directly from:', url);
            
                const response = await fetch(url);
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();
            
            if (data.results && data.results.length > 0) {
                return data.results.map(r => r.elevation);
            }
            
            return [];
        } catch (error) {
            console.warn('Direct API fetch failed:', error);
            throw error;
        }
    }
    
    // Fetch through server-side proxy to avoid CORS
    async fetchThroughProxy(locationChunk) {
        try {
            // Use your server as a proxy
            const proxyUrl = `${this.PROXY_URL}?locations=${encodeURIComponent(locationChunk)}`;
            console.log('Fetching elevation data through proxy:', proxyUrl);
            
            const response = await fetch(proxyUrl);
            
            if (!response.ok) {
                throw new Error(`Proxy HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.results && data.results.length > 0) {
                return data.results.map(r => r.elevation);
            } else if (data.elevations && Array.isArray(data.elevations)) {
                // Support alternate format from proxy
                return data.elevations;
            }
            
            return [];
        } catch (error) {
            console.warn('Proxy fetch failed:', error);
            throw error;
        }
    }
    
    // Generate fallback elevation data for when APIs fail
    generateFallbackElevations(locationChunk) {
        const count = (locationChunk.match(/\|/g) || []).length + 1;
        console.log(`Generating ${count} fallback elevations`);
        
        // Parse the coordinates to create more realistic fallback data
        const points = locationChunk.split('|').map(point => {
            const [lat, lng] = point.split(',').map(parseFloat);
            return { lat, lng };
        });
        
        // Create slightly varying elevations based on location
        return points.map((point, index) => {
            // Use coordinates to generate pseudo-random but consistent elevations
            const base = (Math.sin(point.lat * 10) + Math.cos(point.lng * 10)) * 100 + 200;
            // Add some variation
            return base + (index * 2) + (Math.random() * 5);
        });
    }
    
    // Simulate elevation data with a realistic profile
    simulateElevationData(waypoints) {
        if (!waypoints || waypoints.length === 0) {
            return [];
        }
        
        console.log(`Simulating elevation data for ${waypoints.length} waypoints`);
        
        // Use a smoother, more realistic elevation profile
        const baseElevation = 200; // meters
        const elevations = [];
        
        // Create a smoothed random pattern
        let currentElevation = baseElevation;
        const changeFactors = [];
        
        // First generate random change factors
        for (let i = 0; i < waypoints.length; i++) {
            changeFactors.push(Math.sin(i * 0.5) * 10 + (Math.random() * 5 - 2.5));
        }
        
        // Then smooth them
        const smoothedFactors = this.smoothArray(changeFactors, 3);
        
        // Now generate elevations using smoothed factors
        for (let i = 0; i < waypoints.length; i++) {
            currentElevation += smoothedFactors[i];
            elevations.push(Math.max(0, currentElevation));
        }
        
        return elevations;
    }
    
    // Helper to smooth an array using moving average
    smoothArray(arr, windowSize) {
        const result = [];
        for (let i = 0; i < arr.length; i++) {
            let sum = 0;
            let count = 0;
            for (let j = Math.max(0, i - windowSize); j <= Math.min(arr.length - 1, i + windowSize); j++) {
                sum += arr[j];
                count++;
            }
            result.push(sum / count);
        }
        return result;
    }

    // Calculate slope between two points
    calculateSlope(elevation1, elevation2, distance) {
        if (distance <= 0) return 0;
        const elevationDiff = Math.abs(elevation2 - elevation1);
        return elevationDiff / distance;
    }
}

// Create a single instance and export it
const elevationService = new ElevationService();
export default elevationService; 
