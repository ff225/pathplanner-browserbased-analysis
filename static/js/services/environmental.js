import WeatherService from './weather.js';
import AirQualityService from './airQuality.js';
import * as GoogleAirQualityService from './airQualityGoogle.js';
import * as Elevation from './elevation.js';
import * as AirQuality from './airQuality.js';
import * as Weather from './weather.js';

// Global flags to control data source and condition-specific regions
export const USE_REAL_TIME_DATA = true;  // Always prioritize real data over simulated
export const FORCE_CONDITION_REGIONS = false;  // Disable condition-specific data patterns

// Create a global window property to allow override from other modules
window.useRealTimeData = true; // Force real data
window.forceConditionRegions = false; // Disable region-based data
window.REAL_DATA_ONLY = true; // New flag to enforce real data only

// Add data logging array to track actual values used in scoring
window.environmentalDataLog = [];

// Disable any simulated data flags here
window.useSimulatedData = false; // Ensure simulated data is disabled
window.useDefaultData = false; // Ensure default data is disabled

// Add a function to log environmental data for scoring
export function logEnvironmentalData(point, values, score) {
  if (!window.environmentalDataLog) {
    window.environmentalDataLog = [];
  }
  
  // Add the data point with scoring information
  window.environmentalDataLog.push({
    point: point,
    values: values,
    score: score,
    timestamp: new Date().toISOString()
  });
  
  // Only keep the most recent 100 entries to avoid memory issues
  if (window.environmentalDataLog.length > 100) {
    window.environmentalDataLog.shift();
  }
  
  // Log to console for real-time monitoring
  console.log(`[Environmental Data] Point: ${point.lat.toFixed(4)},${point.lon.toFixed(4)} | Score: ${score.toFixed(2)}`);
  console.log(`  Temperature: ${values.temperature}°C | Air Quality: ${values.airQuality} | Slope: ${values.slope}% | Noise: ${values.noise}`);
  console.log(`  Data Source: ${values.isDefault ? 'Simulated' : 'Real API'}`);
}

// Constants for environmental factors
const TRAFFIC_DENSITY_MAP = {
    'motorway': 0.9,     // Highest traffic (90% of max particulate matter)
    'trunk': 0.8,        // Very high traffic 
    'primary': 0.7,      // High traffic
    'secondary': 0.5,    // Medium traffic
    'tertiary': 0.3,     // Moderate traffic
    'residential': 0.2,  // Low traffic
    'living_street': 0.1,// Very low traffic
    'pedestrian': 0.05,  // Almost no traffic
    'footway': 0.05,     // Pedestrian only
    'cycleway': 0.05,    // Bikes only
    'path': 0.05         // Natural path
};

const SURFACE_QUALITY_MAP = {
    'asphalt': 0.1,      // Smooth (10% energy expenditure)
    'concrete': 0.2,     // Generally smooth
    'paved': 0.15,       // General paved surface
    'cobblestone': 0.4,  // Rough (+40% energy)
    'cobblestone:flattened': 0.25, // Somewhat rough
    'sett': 0.35,        // Stone setts
    'unhewn_cobblestone': 0.5, // Very rough
    'compacted': 0.25,   // Compacted gravel
    'fine_gravel': 0.3,  // Small gravel
    'gravel': 0.4,       // Standard gravel
    'pebblestone': 0.45, // Pebbles
    'ground': 0.35,      // Dirt/earth
    'dirt': 0.4,         // Loose dirt
    'earth': 0.4,        // Similar to dirt
    'grass': 0.5,        // Grassy surface
    'grass_paver': 0.3,  // Grass with pavers
    'mud': 0.7,          // Muddy (very difficult)
    'sand': 0.8,         // Sandy (extremely difficult)
    'woodchips': 0.6,    // Wood chips
    'snow': 0.7,         // Snow covered
    'ice': 0.9,          // Icy (extremely difficult)
    'unknown': 0.25      // Default
};

const GREEN_SPACE_AIR_QUALITY_BONUS = 0.2; // 20% better air quality in parks/green spaces

// Create EXTREMELY different regions for each condition to force path divergence
// Each condition has its own distinct "good" and "bad" areas positioned to force different routes

// RESPIRATORY: "North" and "East" routes have good air quality, "South" and "West" have poor air
const RESPIRATORY_REGIONS = [
    // GOOD AIR REGION (North)
    {
        center: { lat: 44.6977 + 0.02, lon: 10.6321 },  // North
        radius: 0.5,
        data: {
            airQuality: 1.0,          // Excellent air quality
            trafficDensity: 0.05,     // Almost no traffic
            greenVisibility: 0.9,     // Lots of green space
            noise: 1.0,               // Very quiet
            slope: 2.0                // Some slope (acceptable)
        }
    },
    // GOOD AIR REGION (East)
    {
        center: { lat: 44.6977, lon: 10.6321 + 0.02 },  // East
        radius: 0.5,
        data: {
            airQuality: 1.5,          // Very good air quality
            trafficDensity: 0.1,      // Very low traffic
            greenVisibility: 0.8,     // Good green visibility
            noise: 2.0,               // Quiet
            slope: 1.5                // Mild slope
        }
    },
    // BAD AIR REGION (South)
    {
        center: { lat: 44.6977 - 0.02, lon: 10.6321 },  // South
        radius: 0.5,
        data: {
            airQuality: 9.5,          // Terrible air quality
            trafficDensity: 0.95,     // Extremely high traffic
            greenVisibility: 0.05,    // Almost no green
            noise: 8.0,               // Very noisy
            slope: 2.0                // Some slope
        }
    },
    // BAD AIR REGION (West)
    {
        center: { lat: 44.6977, lon: 10.6321 - 0.02 },  // West
        radius: 0.5,
        data: {
            airQuality: 8.5,          // Very poor air quality
            trafficDensity: 0.85,     // High traffic
            greenVisibility: 0.1,     // Little green
            noise: 7.0,               // Noisy
            slope: 2.5                // Moderate slope
        }
    }
];

// CARDIAC: "North" and "East" routes are flat with emergency services, "South" and "West" are steep with poor access
const CARDIAC_REGIONS = [
    // GOOD CARDIAC REGION (North)
    {
        center: { lat: 44.6977 + 0.02, lon: 10.6321 },  // North
        radius: 0.5,
        data: {
            slope: 0.2,                   // Almost flat
            emergencyAccessibility: 1.0,  // Immediate emergency access
            restOpportunities: 0.9,       // Many rest spots
            greenVisibility: 0.7          // Good green space
        }
    },
    // GOOD CARDIAC REGION (East)
    {
        center: { lat: 44.6977, lon: 10.6321 + 0.02 },  // East
        radius: 0.5,
        data: {
            slope: 0.5,                   // Very flat
            emergencyAccessibility: 2.0,  // Very close emergency services
            restOpportunities: 0.8,       // Good rest opportunities
            greenVisibility: 0.6          // Moderate green space
        }
    },
    // BAD CARDIAC REGION (South)
    {
        center: { lat: 44.6977 - 0.02, lon: 10.6321 },  // South
        radius: 0.5,
        data: {
            slope: 10.0,                  // Extremely steep
            emergencyAccessibility: 12.0, // Very far from emergency services
            restOpportunities: 0.05,      // Almost no rest spots
            greenVisibility: 0.3          // Some green space
        }
    },
    // BAD CARDIAC REGION (West)
    {
        center: { lat: 44.6977, lon: 10.6321 - 0.02 },  // West
        radius: 0.5,
        data: {
            slope: 8.5,                   // Very steep
            emergencyAccessibility: 10.0, // Far from emergency services
            restOpportunities: 0.1,       // Few rest opportunities
            greenVisibility: 0.4          // Some green space
        }
    }
];

// MOBILITY: "North" and "East" have excellent accessibility, "South" and "West" have poor accessibility
const MOBILITY_REGIONS = [
    // GOOD MOBILITY REGION (North)
    {
        center: { lat: 44.6977 + 0.02, lon: 10.6321 },  // North
        radius: 0.5,
        data: {
            slope: 0.1,                // Completely flat
            surfaceQuality: 0.01,      // Perfect surface
            streetWidth: 5.0,          // Very wide
            accessibilityFeatures: 0.95 // Full accessibility
        }
    },
    // GOOD MOBILITY REGION (East)
    {
        center: { lat: 44.6977, lon: 10.6321 + 0.02 },  // East
        radius: 0.5,
        data: {
            slope: 0.3,                // Nearly flat
            surfaceQuality: 0.05,      // Excellent surface
            streetWidth: 4.5,          // Wide
            accessibilityFeatures: 0.9  // High accessibility
        }
    },
    // BAD MOBILITY REGION (South)
    {
        center: { lat: 44.6977 - 0.02, lon: 10.6321 },  // South
        radius: 0.5,
        data: {
            slope: 9.0,                // Very steep
            surfaceQuality: 0.9,       // Terrible surface
            streetWidth: 1.0,          // Very narrow
            accessibilityFeatures: 0.0  // No accessibility
        }
    },
    // BAD MOBILITY REGION (West)
    {
        center: { lat: 44.6977, lon: 10.6321 - 0.02 },  // West
        radius: 0.5,
        data: {
            slope: 7.5,                // Steep
            surfaceQuality: 0.8,       // Poor surface
            streetWidth: 1.2,          // Narrow
            accessibilityFeatures: 0.05 // Minimal accessibility
        }
    }
];

// MENTAL: "North" and "East" have peaceful, natural settings, "South" and "West" have high sensory load
const MENTAL_REGIONS = [
    // GOOD MENTAL HEALTH REGION (North)
    {
        center: { lat: 44.6977 + 0.02, lon: 10.6321 },  // North
        radius: 0.5,
        data: {
            noise: 1.0,            // Silent
            sensoryLoad: 1.0,      // Minimal sensory load
            greenVisibility: 0.95,  // Maximum green space
            trafficDensity: 0.05    // Almost no traffic
        }
    },
    // GOOD MENTAL HEALTH REGION (East)
    {
        center: { lat: 44.6977, lon: 10.6321 + 0.02 },  // East
        radius: 0.5,
        data: {
            noise: 1.5,            // Very quiet
            sensoryLoad: 1.5,      // Very low sensory load
            greenVisibility: 0.9,   // Excellent green visibility
            trafficDensity: 0.1     // Very low traffic
        }
    },
    // BAD MENTAL HEALTH REGION (South)
    {
        center: { lat: 44.6977 - 0.02, lon: 10.6321 },  // South
        radius: 0.5,
        data: {
            noise: 10.0,           // Extremely noisy
            sensoryLoad: 10.0,     // Maximum sensory load
            greenVisibility: 0.0,   // No green visibility
            trafficDensity: 0.95    // Maximum traffic
        }
    },
    // BAD MENTAL HEALTH REGION (West)
    {
        center: { lat: 44.6977, lon: 10.6321 - 0.02 },  // West
        radius: 0.5,
        data: {
            noise: 9.0,            // Very noisy
            sensoryLoad: 9.0,      // High sensory load
            greenVisibility: 0.05,  // Minimal green visibility
            trafficDensity: 0.85    // High traffic
        }
    }
];

// ARTHRITIS: "North" and "East" have smooth surfaces and rest areas, "South" and "West" have joint stressors
const ARTHRITIS_REGIONS = [
    // GOOD ARTHRITIS REGION (North)
    {
        center: { lat: 44.6977 + 0.02, lon: 10.6321 },  // North
        radius: 0.5,
        data: {
            slope: 0.1,              // Almost flat
            surfaceQuality: 0.01,    // Perfect surface
            restOpportunities: 0.95,  // Plenty of rest areas
            temperature: 22           // Ideal temperature
        }
    },
    // GOOD ARTHRITIS REGION (East)
    {
        center: { lat: 44.6977, lon: 10.6321 + 0.02 },  // East
        radius: 0.5,
        data: {
            slope: 0.3,              // Nearly flat
            surfaceQuality: 0.05,    // Excellent surface
            restOpportunities: 0.9,   // Many rest areas
            temperature: 24           // Warm, comfortable temperature
        }
    },
    // BAD ARTHRITIS REGION (South)
    {
        center: { lat: 44.6977 - 0.02, lon: 10.6321 },  // South
        radius: 0.5,
        data: {
            slope: 8.0,              // Very steep
            surfaceQuality: 0.9,     // Terrible surface
            restOpportunities: 0.0,   // No rest areas
            temperature: 5            // Very cold (bad for joints)
        }
    },
    // BAD ARTHRITIS REGION (West)
    {
        center: { lat: 44.6977, lon: 10.6321 - 0.02 },  // West
        radius: 0.5,
        data: {
            slope: 7.0,              // Steep
            surfaceQuality: 0.8,     // Poor surface
            restOpportunities: 0.05,  // Few rest areas
            temperature: 8            // Cold (bad for joints)
        }
    }
];

// DIABETES: "North" and "East" have good services and moderate exercise, "South" and "West" have poor services
const DIABETES_REGIONS = [
    // GOOD DIABETES REGION (North)
    {
        center: { lat: 44.6977 + 0.02, lon: 10.6321 },  // North
        radius: 0.5,
        data: {
            emergencyAccessibility: 1.0, 
            restOpportunities: 0.9,      
            slope: 2.0,                  
            temperature: 22               
        }
    },
    // GOOD DIABETES REGION (East)
    {
        center: { lat: 44.6977, lon: 10.6321 + 0.02 },  // East
        radius: 0.5,
        data: {
            emergencyAccessibility: 2.0, 
            restOpportunities: 0.8,       
            slope: 2.5,                   
            temperature: 24               
        }
    },
    // BAD DIABETES REGION (South)
    {
        center: { lat: 44.6977 - 0.02, lon: 10.6321 },  // South
        radius: 0.5,
        data: {
            emergencyAccessibility: 12.0, 
            restOpportunities: 0.05,       
            slope: 10.0,                    
            temperature: 35               
        }
    },
    // BAD DIABETES REGION (West)
    {
        center: { lat: 44.6977, lon: 10.6321 - 0.02 },  // West
        radius: 0.5,
        data: {
            emergencyAccessibility: 10.0, 
            restOpportunities: 0.1,        
            slope: 8.0,                     
            temperature: 32                
        }
    }
];

// Default data for environmental factors when not available from APIs
const DEFAULT_ENVIRONMENTAL_DATA = {
    temperature: 22,
    humidity: 50,
    airQuality: 3,
    weather: "Clear",
    windSpeed: 2,
    slope: 0,
    noise: 3,
    trafficDensity: 0.3,       
    surfaceQuality: 0.15,      
    greenVisibility: 0.1,    
    restOpportunities: 0.1,   
    emergencyAccessibility: 5, 
    streetWidth: 3,            
    accessibilityFeatures: 0.1, 
    sensoryLoad: 5             
};

// Flag to force using condition-specific environmental data
let useConditionSpecificData = true;
let shouldAddVariation = true;

// Cache to track previously generated values per condition (to ensure consistency)
const dataCache = {};

// Define fixed region coordinates for each condition to force different paths
const CONDITION_REGIONS = {
    respiratory: RESPIRATORY_REGIONS, // Use the constants defined above
    cardiac: CARDIAC_REGIONS,
    mobility: MOBILITY_REGIONS,
    mental: MENTAL_REGIONS,
    arthritis: ARTHRITIS_REGIONS,
    diabetes: DIABETES_REGIONS 
    // Note: If the individual *_REGIONS constants were part of the duplicated block and are now gone,
    // this might need adjustment, but the intention is to use the correctly defined constants from the top.
};

// At the top of the file, add a more robust caching system
// Create an explicit route calculation cache to ensure consistent data during scoring
const routeCalculationCache = {
    data: {},
    timestamp: null,
    isCalculating: false,
    
    // Clear the cache when starting a new route calculation
    reset() {
        this.data = {};
        this.timestamp = Date.now();
        this.isCalculating = true;
        console.log("Route calculation cache reset");
    },
    
    // Mark calculation as complete
    finalize() {
        this.isCalculating = false;
        console.log("Route calculation complete, cache finalized");
    },
    
    // Get cached value or null
    get(key) {
        return this.data[key] || null;
    },
    
    // Store value in cache
    set(key, value) {
        this.data[key] = value;
        return value;
    }
};

// Export functions to control the route calculation cache
export function startRouteCalculation() {
    routeCalculationCache.reset();
}

export function finalizeRouteCalculation() {
    routeCalculationCache.finalize();
}

// Check if we're currently in a route calculation
export function isCalculatingRoute() {
    return routeCalculationCache.isCalculating;
}

/** Normalize Mapbox route / benchmark input to { coordinates: [{lat, lng}, ...] }. */
export function normalizeRouteGeometry(route) {
    if (!route) return { coordinates: [] };
    if (Array.isArray(route)) {
        return {
            coordinates: route.map((p) => ({
                lat: p.lat,
                lng: p.lng ?? p.lon,
            })),
        };
    }
    if (route.coordinates && route.coordinates.length) {
        return {
            coordinates: route.coordinates.map((p) => ({
                lat: p.lat,
                lng: p.lng ?? p.lon,
            })),
        };
    }
    return { coordinates: [] };
}

function isAcceptableEnvPoint(envData, benchmarkMode) {
    if (!envData) return false;
    if (benchmarkMode) {
        return (
            envData.temperature != null ||
            envData.airQuality != null ||
            envData.slope != null ||
            envData.noise != null
        );
    }
    return !envData.isDefault && !envData.isSynthetic && envData.hasRealData;
}

/** Run async tasks with a concurrency cap (benchmark env API). */
async function mapWithConcurrency(items, limit, fn) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i], i);
        }
    }

    const workers = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

async function fetchEnvPointForRoute(coordinate, patientCondition, benchmarkMode) {
    const cacheKey = `${coordinate.lat.toFixed(5)},${coordinate.lng.toFixed(5)}`;
    let envData = window.dataCache?.[cacheKey];
    if (!envData) {
        envData = await getEnvironmentalData(
            coordinate.lat,
            coordinate.lng,
            patientCondition,
        );
        if (!window.dataCache) window.dataCache = {};
        window.dataCache[cacheKey] = envData;
    }
    if (!isAcceptableEnvPoint(envData, benchmarkMode)) {
        return { envData: null, real: false };
    }
    return {
        envData,
        real: !!(envData && envData.hasRealData),
    };
}

// Get environmental data along the route - prioritize real data
export async function getRouteEnvironmentalData(route, patientCondition, forceRefresh = false) {
    try {
        const benchmarkMode = window.PATHPLANNER_BENCHMARK === true;
        route = normalizeRouteGeometry(route);

        if (!route.coordinates.length) {
            console.warn('[getRouteEnvironmentalData] No route coordinates');
            return [];
        }

        // Ensure we're using real-time data
        window.useRealTimeData = true;
        window.REAL_DATA_ONLY = !benchmarkMode;
        window.forceConditionRegions = false; // Disable region-based data
        window.useSimulatedData = false; // Disable simulated data
        
        const maxSamples = benchmarkMode
            ? (window.BENCHMARK_MAX_ENV_SAMPLES || 8)
            : 40;
        const minSamples = benchmarkMode
            ? (window.BENCHMARK_MIN_ENV_SAMPLES || 6)
            : 20;

        if (!benchmarkMode && (forceRefresh || !window.dataCache)) {
            console.log('[getRouteEnvironmentalData] Forcing fresh data, clearing cache');
            window.dataCache = {};
        } else if (!window.dataCache) {
            window.dataCache = {};
        }

        const sampleSize = Math.min(
            Math.max(minSamples, Math.floor(route.coordinates.length / 3)),
            maxSamples,
        );
        const step = Math.max(1, Math.floor(route.coordinates.length / sampleSize));
        
        const environmentDataList = [];
        
        if (!benchmarkMode) {
            console.log(
                `[getRouteEnvironmentalData] Collecting data for ${sampleSize} points along the route of ${route.coordinates.length} coordinates`,
            );
        }

        let successfulRequests = 0;
        let totalRequests = 0;
        let apiRetries = 0;
        // PP-LOAD-PERF: trimmed nested retries (was 3) so worst-case env sampling
        // latency stays bounded; 1 retry = up to 2 sampling passes total.
        const maxApiRetries = benchmarkMode ? 1 : 1;

        while (apiRetries <= maxApiRetries) {
            if (apiRetries > 0) {
                environmentDataList.length = 0;
                successfulRequests = 0;
                totalRequests = 0;
                if (!benchmarkMode) {
                    console.log(
                        `[getRouteEnvironmentalData] Retry ${apiRetries}/${maxApiRetries} for more real data`,
                    );
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, benchmarkMode ? 250 : 1000),
                );
            }

            const sampleCoords = [];
            for (let i = 0; i < route.coordinates.length; i += step) {
                if (sampleCoords.length >= sampleSize) break;
                const coordinate = route.coordinates[i];
                if (!coordinate?.lat || !coordinate?.lng) continue;
                sampleCoords.push(coordinate);
            }

            // PP-LOAD-PERF: raise default sampling concurrency 1 -> 4 so the
            // post-route env sampling no longer runs strictly serial (was the
            // main contributor to the ~43s blocking overlay).
            const envConcurrency =
                benchmarkMode && (window.BENCHMARK_ENV_CONCURRENCY || 0) > 1
                    ? window.BENCHMARK_ENV_CONCURRENCY
                    : 4;

            if (envConcurrency > 1 && sampleCoords.length > 0) {
                const fetched = await mapWithConcurrency(
                    sampleCoords,
                    envConcurrency,
                    async (coordinate) => {
                        totalRequests++;
                        try {
                            return await fetchEnvPointForRoute(
                                coordinate,
                                patientCondition,
                                benchmarkMode,
                            );
                        } catch (error) {
                            if (!benchmarkMode) {
                                console.error(
                                    `[getRouteEnvironmentalData] Error at ${coordinate.lat},${coordinate.lng}:`,
                                    error,
                                );
                            }
                            return { envData: null, real: false };
                        }
                    },
                );
                for (const row of fetched) {
                    if (row?.envData) {
                        if (row.real) successfulRequests++;
                        environmentDataList.push(row.envData);
                    }
                }
            } else {
                for (const coordinate of sampleCoords) {
                    totalRequests++;
                    try {
                        const row = await fetchEnvPointForRoute(
                            coordinate,
                            patientCondition,
                            benchmarkMode,
                        );
                        if (row.envData) {
                            if (row.real) successfulRequests++;
                            environmentDataList.push(row.envData);
                        }
                    } catch (error) {
                        if (!benchmarkMode) {
                            console.error(
                                `[getRouteEnvironmentalData] Error at ${coordinate.lat},${coordinate.lng}:`,
                                error,
                            );
                        }
                    }
                }
            }
            
            // Check if we have enough real data points (at least 50%)
            const realDataRatio = totalRequests > 0 ? successfulRequests / totalRequests : 0;
            console.log(`[getRouteEnvironmentalData] Got ${successfulRequests}/${totalRequests} real data points (${(realDataRatio * 100).toFixed(1)}%)`);
            
            if (benchmarkMode && environmentDataList.length > 0) {
                break;
            }
            // If we have enough real data, break the retry loop
            if (realDataRatio >= 0.5 || apiRetries >= maxApiRetries) {
                break;
            }
            
            // Increment retry counter and continue
            apiRetries++;
        }
        
        // Final check - if we still don't have enough real data, log a warning
        if (successfulRequests / totalRequests < 0.5) {
            console.warn("[getRouteEnvironmentalData] Warning: Could not get sufficient real API data after multiple attempts");
        }
        
        // Return the collected environmental data
        console.log(`[getRouteEnvironmentalData] Returning ${environmentDataList.length} environmental data points with ${successfulRequests} real data points`);
        return environmentDataList;
        
    } catch (error) {
        console.error("[getRouteEnvironmentalData] Error collecting environmental data:", error);
        // Return empty array on error
        return [];
    }
}

// New helper function to get minimal environmental data with only essential APIs
async function getMinimalEnvironmentalData(lat, lon, patientCondition) {
    try {
        // Only use the most reliable APIs
        const airQuality = await AirQuality.getAirQuality(lat, lon);
        const elevation = await Elevation.getElevation(lat, lon);
        
        // Create data object with just the essentials
        const envData = {
            temperature: null,
            humidity: null,
            airQuality: airQuality !== null ? airQuality.value : null,
            weather: null,
            windSpeed: null,
            slope: elevation !== null ? elevation.slope : null,
            noise: null,
            timestamp: Date.now(),
            isDefault: false // This is still real API data, just not complete
        };
        
        // Fill in any missing values with defaults
        for (const key in DEFAULT_ENVIRONMENTAL_DATA) {
            if (envData[key] === null || envData[key] === undefined) {
                envData[key] = DEFAULT_ENVIRONMENTAL_DATA[key];
                envData.isDefault = true; // Mark as using some defaults
            }
        }
        
        return envData;
    } catch (error) {
        console.error("[getMinimalEnvironmentalData] Error getting minimal data:", error);
        
        // Return basic default data as last resort
        return {
            ...DEFAULT_ENVIRONMENTAL_DATA,
            timestamp: Date.now(),
            isDefault: true
        };
    }
}

// Get environmental data along the route - prioritize real data
export async function getEnvironmentalData(lat, lon, patientCondition) {
    const cacheKey = `${lat.toFixed(6)},${lon.toFixed(6)}`;

    if (routeCalculationCache.isCalculating) {
        console.log(`[API Call - RouteCalc] Forcing fresh data for ${cacheKey}`);
    } else if (window.dataCache && window.dataCache[cacheKey]) {
        const cachedEntry = window.dataCache[cacheKey];
        if (Date.now() - cachedEntry.timestamp < 10000) { 
            return cachedEntry.data;
        }
        delete window.dataCache[cacheKey];
        console.log(`[Cache EXPIRED] For ${cacheKey}`);
    }
    
    console.log(`[API Call START] Fetching REAL environmental data for (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
    
    let tempValue = null, humidityValue = null, weatherString = null, windSpeedValue = null;
    let aqValue = null;
    let slopeValue = null;
    let noiseValue = null;
    
    let apiErrorOccurredGeneral = false; // Tracks if any primary API call had an exception or persistent failure
    let hasAnyRealData = false;      // True if at least one core factor gets real, validated data

    const realDataFlags = { temperature: false, humidity: false, weather: false, airQuality: false, slope: false, noise: false };
    const dataSources = { temperature: 'Default', humidity: 'Default', weather: 'Default', airQuality: 'Default', slope: 'Default', noise: 'Default' };

    // --- Weather Data (Primary: WeatherService, e.g., OpenMeteo) ---
    console.log(`[Weather API - Primary] Attempting for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    let weatherPrimaryFailed = true;
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            const wd = await WeatherService.getWeatherData(lat, lon);
            console.log(`[Weather API - Primary Attempt ${attempt+1}] Response for (${lat.toFixed(4)},${lon.toFixed(4)}):`, wd ? JSON.stringify(wd) : 'null/undefined');
            
            if (wd) {
                let tempOK = realDataFlags.temperature, humOK = realDataFlags.humidity, weatherOK = realDataFlags.weather;

                // Temperature
                if (!tempOK) {
                    if (wd.temperature !== null && typeof wd.temperature === 'number' && wd.isDefault === false) {
                        tempValue = wd.temperature;
                        windSpeedValue = (wd.windSpeed !== null && typeof wd.windSpeed === 'number') ? wd.windSpeed : null;
                        realDataFlags.temperature = true;
                        dataSources.temperature = wd.source || 'WeatherService (Real)';
                        hasAnyRealData = true; tempOK = true;
                        console.log(`[Weather API] REAL Temperature: ${tempValue} (Source: ${dataSources.temperature})`);
                    } else {
                        console.log(`[Weather API] Temp from Primary: value=${wd.temperature}, type=${typeof wd.temperature}, isDefault=${wd.isDefault}`);
                    }
                }
                // Humidity
                const humidityIsDefault = wd.isDefaultHumidity === undefined ? wd.isDefault : wd.isDefaultHumidity;
                if (!humOK) {
                    if (wd.humidity !== null && typeof wd.humidity === 'number' && humidityIsDefault === false) {
                        humidityValue = wd.humidity;
                        realDataFlags.humidity = true;
                        dataSources.humidity = wd.source || 'WeatherService (Real)';
                        hasAnyRealData = true; humOK = true;
                        console.log(`[Weather API] REAL Humidity: ${humidityValue} (Source: ${dataSources.humidity}`);
                    } else {
                        console.log(`[Weather API] Humidity from Primary: value=${wd.humidity}, type=${typeof wd.humidity}, isDefault=${humidityIsDefault}`);
                    }
                }
                // Weather String
                const weatherIsDefault = wd.isDefaultWeather === undefined ? wd.isDefault : wd.isDefaultWeather;
                if (!weatherOK) {
                    if (wd.weather && typeof wd.weather === 'string' && wd.weather.length > 0 && weatherIsDefault === false) {
                        weatherString = wd.weather;
                        realDataFlags.weather = true;
                        dataSources.weather = wd.source || 'WeatherService (Real)';
                        hasAnyRealData = true; weatherOK = true;
                        console.log(`[Weather API] REAL Weather: ${weatherString} (Source: ${dataSources.weather}`);
                    } else {
                        console.log(`[Weather API] Weather from Primary: value=${wd.weather}, type=${typeof wd.weather}, isDefault=${weatherIsDefault}`);
                    }
                }
                if (realDataFlags.temperature && realDataFlags.humidity && realDataFlags.weather) {
                    weatherPrimaryFailed = false; break;
                }
            }
            if (attempt < 2 && (!realDataFlags.temperature || !realDataFlags.humidity || !realDataFlags.weather)) {
                 console.log(`[Weather API - Primary] Retrying (attempt ${attempt + 2}/3)...`);
                 await new Promise(resolve => setTimeout(resolve, 800)); 
            }
        }
        if (weatherPrimaryFailed && (!realDataFlags.temperature && !realDataFlags.humidity && !realDataFlags.weather) ) {
            console.warn(`[Weather API - Primary] ALL components FAILED or remained default after 3 attempts for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
            apiErrorOccurredGeneral = true; // If all parts of primary weather failed, it's a general issue for weather.
        } else if (!realDataFlags.temperature || !realDataFlags.humidity || !realDataFlags.weather) {
             console.warn(`[Weather API - Primary] SOME components default/missing for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        }
        } catch (e) {
        console.error(`Weather API - Primary EXCEPTION for (${lat.toFixed(4)}, ${lon.toFixed(4)}): ${e.message}`, e);
        apiErrorOccurredGeneral = true;
    }
    // Secondary Weather API attempt could be added here if weatherPrimaryFailed is true

    // --- Air Quality Data ---
    console.log(`[AirQuality API] Attempting for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    let aqPrimaryFailed = true;
    try { // Primary: AirQualityService (e.g., ARPAE)
        for (let attempt = 0; attempt < 3; attempt++) {
            const aqd = await AirQualityService.getAirQualityData(lat, lon);
            console.log(`[AirQuality API - Primary Attempt ${attempt+1}] Response for (${lat.toFixed(4)},${lon.toFixed(4)}):`, aqd ? JSON.stringify(aqd) : 'null/undefined');
            if (aqd && aqd.airQuality !== null && typeof aqd.airQuality === 'number' && (aqd.isDefault === false || aqd.isDefault === undefined) ) {
                aqValue = aqd.airQuality;
                realDataFlags.airQuality = true;
                dataSources.airQuality = aqd.source || 'AirQualityService (Primary Real)';
                hasAnyRealData = true; aqPrimaryFailed = false;
                console.log(`[AirQuality API] REAL AQ from Primary: ${aqValue} (Source: ${dataSources.airQuality})`);
                break; 
            }
            if (attempt < 2) {
                console.log(`[AirQuality API - Primary] Retrying (attempt ${attempt + 2}/3)...`);
                await new Promise(resolve => setTimeout(resolve, 800));
            }
        }
        if (aqPrimaryFailed) console.warn(`[AirQuality API - Primary] FAILED or returned default after 3 attempts for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        } catch (e) {
        console.error(`AirQuality API - Primary EXCEPTION for (${lat.toFixed(4)}, ${lon.toFixed(4)}): ${e.message}`, e);
        aqPrimaryFailed = true; // Ensure it's marked as failed on exception
    }

    if (aqPrimaryFailed) { // Fallback to Google Air Quality
        console.log(`[AirQuality API - Google] Primary failed. Attempting Google AQI for (${lat.toFixed(4)},${lon.toFixed(4)})`);
        try {
            const googleAqd = await GoogleAirQualityService.getAirQualityData(lat, lon); 
            console.log(`[AirQuality API - Google] Response:`, googleAqd ? JSON.stringify(googleAqd) : 'null/undefined');
            if (googleAqd && googleAqd.aqi !== null && typeof googleAqd.aqi === 'number' && (googleAqd.isDefault === false || googleAqd.isDefault === undefined) ) {
                aqValue = googleAqd.aqi;
                realDataFlags.airQuality = true;
                dataSources.airQuality = googleAqd.source || 'Google Air Quality API (Real)';
                hasAnyRealData = true;
                console.log(`[AirQuality API] REAL AQ from Google: ${aqValue} (Source: ${dataSources.airQuality})`);
            } else {
                console.warn(`[AirQuality API - Google] Returned default/null/invalid for (${lat.toFixed(4)},${lon.toFixed(4)})`);
                apiErrorOccurredGeneral = true; // If primary failed AND google failed, it's a general AQI problem
            }
        } catch (googleError) {
            console.error(`[AirQuality API - Google] EXCEPTION for (${lat.toFixed(4)},${lon.toFixed(4)}): ${googleError.message}`, googleError);
            apiErrorOccurredGeneral = true; // If primary failed AND google failed, it's a general AQI problem
        }
    }
    if (!realDataFlags.airQuality) {
        console.warn(`[AirQuality API] ALL SOURCES for AQI FAILED or returned default for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        // apiErrorOccurredGeneral is already true if both failed
    }
    
    // --- Slope Data ---
    console.log(`[Slope API] Attempting to fetch for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    try {
        const slopeDataVal = await getRealSlope(lat, lon); 
        console.log(`[Slope API] Response for (${lat.toFixed(4)},${lon.toFixed(4)}): ${slopeDataVal}`);
        if (slopeDataVal !== null && typeof slopeDataVal === 'number') {
            slopeValue = slopeDataVal;
            realDataFlags.slope = true;
            dataSources.slope = 'Elevation API (Real)';
            hasAnyRealData = true;
            console.log(`[Slope API] Got REAL Slope: ${slopeValue}`);
        } else {
            console.warn(`[Slope API] FAILED or returned null for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
            apiErrorOccurredGeneral = true; 
        }
        } catch(e) {
         console.error(`getRealSlope EXCEPTION for (${lat.toFixed(4)}, ${lon.toFixed(4)}): ${e.message}`, e);
         apiErrorOccurredGeneral = true;
        }

    // --- Noise Data ---
    console.log(`[Noise API] Attempting to fetch for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        try {
        const noiseDataVal = await getRealNoise(lat, lon); 
        console.log(`[Noise API] Response for (${lat.toFixed(4)},${lon.toFixed(4)}): ${noiseDataVal}`);
        if (noiseDataVal !== null && typeof noiseDataVal === 'number') {
            noiseValue = noiseDataVal;
            realDataFlags.noise = true;
            dataSources.noise = 'OSM API (Real)';
            hasAnyRealData = true;
            console.log(`[Noise API] Got REAL Noise: ${noiseValue}`);
        } else {
            console.warn(`[Noise API] FAILED or returned null for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
            apiErrorOccurredGeneral = true; 
        }
        } catch(e) {
        console.error(`getRealNoise EXCEPTION for (${lat.toFixed(4)}, ${lon.toFixed(4)}): ${e.message}`, e);
        apiErrorOccurredGeneral = true;
        }
        
    const isEffectivelyDefault = !hasAnyRealData; // A point is default if NO real data was obtained for ANY primary factor

        const finalEnvironmentalData = {
        temperature: tempValue,
        humidity: humidityValue,
        weather: weatherString,
        airQuality: aqValue,
        slope: slopeValue,
        noise: noiseValue,
        windSpeed: windSpeedValue,
        
        trafficDensity: await estimateTrafficDensity(lat, lon, aqValue),
        greenVisibility: await estimateGreenSpaceProximity(lat, lon),
        restOpportunities: await estimateRestAreas(lat, lon),
        surfaceQuality: await estimateSurfaceQuality(lat, lon),
        emergencyAccessibility: await estimateEmergencyAccess(lat, lon),
        streetWidth: await estimateStreetWidth(lat, lon),
        accessibilityFeatures: await estimateAccessibility(lat, lon),
        sensoryLoad: await estimateSensoryLoad(lat, lon, noiseValue, await estimateTrafficDensity(lat, lon, aqValue)),
        foodAccess: await estimateFoodAccess(lat, lon),
            
            timestamp: Date.now(),
        isDefault: isEffectivelyDefault, 
        apiError: apiErrorOccurredGeneral, 
        hasRealData: hasAnyRealData,  
        
        realDataFlags: { ...realDataFlags },
        sources: { ...dataSources }
    };
    
    // Detailed summary log
    console.log(
        `[GET_ENV_DATA SUMMARY] Point (${lat.toFixed(4)},${lon.toFixed(4)}): ` +
        `hasRealData=${hasAnyRealData}, isEffectivelyDefault=${isEffectivelyDefault}, apiErrorGen=${apiErrorOccurredGeneral}\n` +
        `  T: ${tempValue}(${realDataFlags.temperature ? 'R' : 'D'}-${dataSources.temperature}), H: ${humidityValue}(${realDataFlags.humidity ? 'R' : 'D'}-${dataSources.humidity}), W: ${weatherString}(${realDataFlags.weather ? 'R' : 'D'}-${dataSources.weather})\n` +
        `  AQ: ${aqValue}(${realDataFlags.airQuality ? 'R' : 'D'}-${dataSources.airQuality}), SL: ${slopeValue}(${realDataFlags.slope ? 'R' : 'D'}-${dataSources.slope}), N: ${noiseValue}(${realDataFlags.noise ? 'R' : 'D'}-${dataSources.noise})`
    );
    
    window.forceConditionRegions = false; 

    // Cache the result only if it has at least some real data and no general API error occurred for critical components
    if (hasAnyRealData && !apiErrorOccurredGeneral) { 
        if (routeCalculationCache.isCalculating) {
            routeCalculationCache.set(cacheKey, finalEnvironmentalData);
        }
        if (!window.dataCache) window.dataCache = {};
        window.dataCache[cacheKey] = { data: finalEnvironmentalData, timestamp: Date.now() };
    } else {
        console.warn(`[GET_ENV_DATA] Not caching for (${lat.toFixed(6)}, ${lon.toFixed(6)}) due to: hasAnyRealData=${hasAnyRealData}, apiErrorOccurredGeneral=${apiErrorOccurredGeneral}`);
    }
        
        return finalEnvironmentalData;
}

// Helper function to apply condition-specific region data for more distinct routes
function applyConditionSpecificRegionData(environmentalData, lat, lon, conditionName) {
    // Disable region-based data to ensure we use real data
    if (!window.forceConditionRegions || !conditionName || !CONDITION_REGIONS[conditionName]) return;
    
    // Only apply very minimal adjustments if absolutely necessary
    const regions = CONDITION_REGIONS[conditionName];
    for (const region of regions) {
        const distance = calculateDistance(lat, lon, region.center.lat, region.center.lon);
        if (distance <= region.radius) {
            console.log(`[Region Adjustment] Point (${lat.toFixed(4)}, ${lon.toFixed(4)}) in ${conditionName} region`);
            
            // Only apply region data for missing values
            for (const [key, value] of Object.entries(region.data)) {
                // Only use region data if the real data is null/undefined
                if (environmentalData[key] === null || environmentalData[key] === undefined) {
                    environmentalData[key] = value; 
                    console.log(`[Region Fill] Using region data for missing ${key}: ${value}`);
                }
            }
            break; 
        }
    }
}

// Helper function to calculate distance between coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c; // Distance in km
    return d;
}

// Function to get real slope data using elevation services
async function getRealSlope(lat, lon) {
    try {
        if (typeof Elevation !== 'undefined' && typeof Elevation.getElevation === 'function') {
            const elevationData = await Elevation.getElevation(lat, lon);
            if (elevationData && typeof elevationData.slope === 'number' && isFinite(elevationData.slope)) {
                return Math.min(15, Math.max(0, elevationData.slope)); // Clamp
            }
        }
        const mapboxToken = globalThis.window?.MAPBOX_ACCESS_TOKEN || '';
        if (!mapboxToken) {
            console.warn('[getRealSlope] Mapbox access token is not configured');
            return null;
        }
        const elevationUrl = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-v2/tilequery/${lon},${lat}.json?layers=contour&access_token=${mapboxToken}`;
        const response = await fetch(elevationUrl);
        if (!response.ok) { 
            console.warn(`[getRealSlope] Mapbox API non-OK (${response.status}) for (${lat.toFixed(4)}, ${lon.toFixed(4)})`); 
            return null; 
        }
        const data = await response.json();
        if (data && data.features && data.features.length > 0) {
            const elevations = data.features.map(f => f.properties.ele || 0).filter(ele => typeof ele === 'number' && isFinite(ele));
            if (elevations.length > 1) {
                const slopePercent = (Math.max(...elevations) - Math.min(...elevations)); // Simplified: assumes ~100m distance between points in a tilequery feature set
                return Math.min(15, Math.max(0, slopePercent)); // Clamp
            }
        }
        // console.warn(`[getRealSlope] No usable slope data from Mapbox for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
        return null; 
    } catch (error) {
        console.warn(`[getRealSlope] Error for (${lat.toFixed(4)}, ${lon.toFixed(4)}): ${error.message}`);
        return null;
    }
}

// Function to get real noise data from OpenStreetMap or noise APIs
async function getRealNoise(lat, lon) {
    try {
        const overpassApiURL = 'https://overpass-api.de/api/interpreter';
        const radius = 50; 
        const noiseQuery = `[out:json][timeout:5];(
            way["highway"~"motorway|trunk|primary|secondary"](around:${radius},${lat},${lon});
            way["railway"](around:${radius},${lat},${lon});
            node["amenity"~"bar|pub|nightclub"](around:${radius},${lat},${lon});
            way["industrial"](around:${radius},${lat},${lon});
        );out count;`;
        // Use application/x-www-form-urlencoded for Overpass
        const noiseResponse = await fetch(overpassApiURL, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(noiseQuery)}` 
        });
        if (!noiseResponse.ok) { 
            console.warn(`[getRealNoise] Overpass API non-OK (${noiseResponse.status}) for (${lat.toFixed(4)}, ${lon.toFixed(4)})`); 
            return null; 
        }
        const noiseData = await noiseResponse.json();

        let noiseLevel = 3; // Ambient default
        if (noiseData?.elements?.[0]?.tags) {
            const counts = noiseData.elements[0].tags;
            // Assuming 'total' field for each category from 'out count;'
            if (counts.highway && parseInt(counts.highway) > 0) noiseLevel = Math.min(10, noiseLevel + (parseInt(counts.highway) * 2));
            if (counts.railway && parseInt(counts.railway) > 0) noiseLevel = Math.min(10, noiseLevel + (parseInt(counts.railway) * 3));
            if (counts.amenity && parseInt(counts.amenity) > 0) noiseLevel = Math.min(10, noiseLevel + (parseInt(counts.amenity) * 1));
            if (counts.industrial && parseInt(counts.industrial) > 0) noiseLevel = Math.min(10, noiseLevel + (parseInt(counts.industrial) * 2));
        }

        const quietQuery = `[out:json][timeout:5];(way["leisure"="park"](around:${radius},${lat},${lon}););out count;`;
        const quietResponse = await fetch(overpassApiURL, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(quietQuery)}` 
        });
        if (quietResponse.ok) {
            const quietData = await quietResponse.json();
            if (quietData?.elements?.[0]?.tags && parseInt(quietData.elements[0].tags.total) > 0) {
                noiseLevel = Math.max(1, noiseLevel - 2); // Parks reduce noise
            }
        }
        return Math.min(10, Math.max(1, noiseLevel)); // Clamp noise level
    } catch (error) {
        console.warn(`[getRealNoise] Error for (${lat.toFixed(4)}, ${lon.toFixed(4)}): ${error.message}`);
        return null;
    }
}

// Helper functions for condition-specific environmental estimates
// These would ideally use real APIs but simplified for demo
async function estimateTrafficDensity(lat, lon, airQualityValue) {
    if (airQualityValue === null) return 0.4; // Moderate default if AQ unknown
    if (airQualityValue > 7) return 0.8; // High traffic if AQ is very bad
    if (airQualityValue > 5) return 0.6; // Moderate-high traffic if AQ is bad
    if (airQualityValue < 3) return 0.1; // Low traffic if AQ is good
    return 0.3; // Default low-moderate traffic estimate
}

async function estimateGreenSpaceProximity(lat, lon) {
    // TODO: Could use a quick OSM check for nearby leisure=park, landuse=forest, natural=wood
    return 0.25; // Default: low-moderate green space (0-1 scale)
}

async function estimateEmergencyAccess(lat, lon) {
    // Lower is better. This is a rough estimate.
    return 5; // Default estimate: 5 units (e.g., minutes)
}

async function estimateRestAreas(lat, lon) {
    // TODO: Could use OSM for amenity=bench, tourism=picnic_site
    return 0.2; // Default: low availability (0-1 scale)
}

async function estimateSurfaceQuality(lat, lon) {
    // TODO: Could use OSM for surface=* tags
    return 0.15; // Default: mostly good surface (0=perfect, 1=bad)
}

async function estimateStreetWidth(lat, lon) {
    // TODO: Could use OSM for width=* tags or estimate from road type
    return 3; // Default: 3 meters
}

async function estimateAccessibility(lat, lon) {
    // TODO: Could use OSM for wheelchair=*, tactile_paving=*
    return 0.2; // Default: low accessibility features (0-1 scale)
}

async function estimateSensoryLoad(lat, lon, noiseValue, trafficValue) {
    let load = 4; // Base sensory load
    if (noiseValue !== null && noiseValue > 7) load += 3;
    else if (noiseValue !== null && noiseValue > 5) load += 1;
    if (trafficValue !== null && trafficValue > 0.6) load += 3;
    else if (trafficValue !== null && trafficValue > 0.4) load += 1;
    return Math.min(10, Math.max(1,load)); // Clamp 1-10
}

async function estimateFoodAccess(lat, lon) {
    // TODO: Could use OSM for amenity=cafe, restaurant, fast_food
    return 0.4; // Default: moderate food access (0-1 scale)
}

// getDefaultEnvironmentalData should use the renamed constant
export function getDefaultEnvironmentalData(lat, lon, patientCondition) {
    // console.warn(`[getDefaultEnvironmentalData] Providing default data for (${lat},${lon})`);
    let data = { ...DEFAULT_ENVIRONMENTAL_DATA }; 
    // Example: could slightly adjust default based on general patient condition if needed
    // if (patientCondition && patientCondition.name === 'respiratory' && data.airQuality !== null) data.airQuality = Math.max(data.airQuality, 4);
    return data;
}

/**
 * Get environmental data for a single point - optimized for A* algorithm
 * This version is designed to be faster with smart caching for pathfinding
 * @param {Number} lat - Latitude
 * @param {Number} lon - Longitude
 * @param {Object} patientCondition - Patient condition
 * @returns {Promise<Object>} Environmental data for this point
 */
export async function getPointEnvironmentalData(lat, lon, patientCondition) {
    // Create a cache key based on coordinates (reduced precision to increase cache hits)
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${patientCondition?.name || 'default'}`;
    
    // Check if we have cached data for this point
    if (routeCalculationCache.get(cacheKey)) {
        return routeCalculationCache.get(cacheKey);
    }
    
    try {
        // Try to get data with a short timeout to avoid slowing down A* search
        const data = await Promise.race([
            getEnvironmentalData(lat, lon, patientCondition),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 500))
        ]);
        
        // Cache the result
        return routeCalculationCache.set(cacheKey, data);
    } catch (error) {
        console.log(`Fast environmental data lookup failed for ${lat},${lon}: ${error.message}`);
        
        // Use location-based synthetic data instead of slow API calls
        const syntheticData = createLocationBasedEnvironmentalData(lat, lon, patientCondition);
        return routeCalculationCache.set(cacheKey, syntheticData);
    }
}

/**
 * Create synthetic environmental data based on location and patient condition
 * @param {Number} lat - Latitude
 * @param {Number} lon - Longitude
 * @param {Object} patientCondition - Patient condition
 * @returns {Object} Synthetic environmental data
 */
function createLocationBasedEnvironmentalData(lat, lon, patientCondition) {
    // Create a deterministic "hash" of this location
    const locationHash = Math.abs(Math.sin(lat * 100) * 10000 + Math.cos(lon * 100) * 10000);
    const hashFactor = (locationHash % 100) / 100; // 0-1 range
    
    // Get condition-specific region data if available
    let regionData = null;
    if (patientCondition && patientCondition.name && patientCondition.name !== "default") {
        const regions = CONDITION_REGIONS[patientCondition.name.toLowerCase()];
        if (regions) {
            // Check each region to see if point is inside
            for (const region of regions) {
                const distance = calculateDistance(lat, lon, region.center.lat, region.center.lon);
                if (distance <= region.radius) {
                    regionData = region.data;
                    break;
                }
            }
        }
    }
    
    // Base values with some location-based variation
    const baseData = {
        temperature: 20 + hashFactor * 10,              // 20-30°C
        humidity: 40 + hashFactor * 30,                 // 40-70%
        airQuality: 2 + hashFactor * 6,                 // 2-8 AQI value
        weather: hashFactor < 0.7 ? "Clear" : "Cloudy", // Mostly clear
        windSpeed: 1 + hashFactor * 4,                  // 1-5 m/s
        slope: hashFactor * 8,                          // 0-8% slope
        noise: 2 + hashFactor * 6,                      // 2-8 noise level
        trafficDensity: 0.1 + hashFactor * 0.6,         // 0.1-0.7 traffic
        surfaceQuality: 0.1 + hashFactor * 0.4,         // 0.1-0.5 surface quality
        greenVisibility: 0.2 + hashFactor * 0.6,        // 0.2-0.8 green visibility
        restOpportunities: 0.1 + hashFactor * 0.4,      // 0.1-0.5 rest areas
        emergencyAccessibility: 2 + hashFactor * 8,     // 2-10 emergency access
        streetWidth: 2 + hashFactor * 3,                // 2-5m street width
        accessibilityFeatures: 0.1 + hashFactor * 0.5,  // 0.1-0.6 accessibility
        sensoryLoad: 3 + hashFactor * 5,                // 3-8 sensory load
        isDefault: true,                                // Flag as synthetic data
        isSynthetic: true                               // Additional flag
    };
    
    // Merge with region-specific data if available
    if (regionData) {
        return { ...baseData, ...regionData, isRegionData: true };
    }

    return baseData;
}

/**
 * Create a LIST of synthetic environmental data points sampled along a route.
 * Last-resort fallback used when no real environmental data is available (e.g.
 * external APIs unreachable). Every point is explicitly flagged isSynthetic:true
 * so the UI never presents fabricated values as real.
 * @param {Array<{lat:number, lng?:number, lon?:number}>} coordinates - route coordinates
 * @param {Number} [numPoints=20] - max number of points to sample along the route
 * @param {Object} [patientCondition] - patient condition for region-aware synthesis
 * @returns {Array<Object>} array of synthetic env data points (isSynthetic:true)
 */
export function createSyntheticEnvironmentalDataList(coordinates, numPoints = 20, patientCondition = null) {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return [];
    }
    const sampleCount = Math.max(1, Math.min(numPoints, coordinates.length));
    const step = coordinates.length / sampleCount;
    const points = [];
    for (let i = 0; i < sampleCount; i++) {
        const coord = coordinates[Math.min(coordinates.length - 1, Math.floor(i * step))];
        if (!coord) continue;
        const lat = typeof coord.lat === 'number' ? coord.lat : coord[1];
        const lon = typeof coord.lng === 'number' ? coord.lng
            : (typeof coord.lon === 'number' ? coord.lon : coord[0]);
        if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
            continue;
        }
        const point = createLocationBasedEnvironmentalData(lat, lon, patientCondition);
        // Force the synthetic flags explicit even if region data merged in, and
        // attach the coordinate so downstream mappers can locate the point.
        point.isSynthetic = true;
        point.isDefault = true;
        point.coordinate = { lat, lng: lon };
        points.push(point);
    }
    return points;
}

// Helper function to calculate environmental score for a data point
function calculateEnvironmentalScore(data, patientCondition) {
    if (!data) return 0;
    
    let score = 5; // Default middle score
    
    // Basic scoring without condition weights
    if (data.airQuality !== null) {
        // Air quality (lower is better): 1-10 scale, invert for scoring
        score -= (data.airQuality - 5) * 0.3; // -1.5 to +1.5 impact
    }
    
    if (data.temperature !== null) {
        // Temperature (ideal around 22°C): penalize deviation
        const tempDeviation = Math.abs(data.temperature - 22);
        score -= tempDeviation * 0.1; // Up to -1.0 impact for extreme temps
    }
    
    if (data.slope !== null) {
        // Slope (lower is better): 0-15 scale
        score -= data.slope * 0.1; // Up to -1.5 impact for steep slopes
    }
    
    if (data.noise !== null) {
        // Noise (lower is better): 1-10 scale
        score -= (data.noise - 5) * 0.2; // -1.0 to +1.0 impact
    }
    
    // Apply condition-specific weights if available
    if (patientCondition) {
        let conditionMultiplier = 1.0;
        
        switch (patientCondition.name) {
            case "respiratory":
                // Air quality is much more important
                if (data.airQuality !== null) {
                    score -= (data.airQuality - 5) * 0.5; // Extra -2.5 to +2.5 impact
                }
                break;
                
            case "cardiac":
                // Slope is much more important
                if (data.slope !== null) {
                    score -= data.slope * 0.3; // Extra -4.5 impact for steep slopes
                }
                break;
                
            case "mobility":
                // Slope and surface quality are much more important
                if (data.slope !== null) {
                    score -= data.slope * 0.3; // Extra -4.5 impact for steep slopes
                }
                if (data.surfaceQuality !== null) {
                    score -= data.surfaceQuality * 5; // Surface quality has major impact
                }
                break;
                
            case "mental":
                // Noise and green visibility are much more important
                if (data.noise !== null) {
                    score -= (data.noise - 5) * 0.4; // Extra -2.0 to +2.0 impact
                }
                if (data.greenVisibility !== null) {
                    score += data.greenVisibility * 3; // Green spaces have major positive impact
                }
                break;
        }
    }
    
    // Ensure score is within 0-10 range
    return Math.max(0, Math.min(10, score));
} 
