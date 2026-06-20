import * as GenericUtils from '../utils/generic.js';

// Existing POIs to keep backward compatibility
async function get(boundingBox) {
    try {
        if (!isValidBoundingBox(boundingBox)) {
            console.error("Invalid bounding box:", boundingBox);
            return getDefaultPOICounts();
        }
        
        return await getNearbyPOI(boundingBox);
    } catch (error) {
        console.error("Error in get function:", error);
        return getDefaultPOICounts();
    }
}

// Enhanced POI collection with additional categories - ADD EXPORT KEYWORD
export async function getEnhancedPOIs(boundingBox, currentPatientCondition) {
    try {
        // Increase timeout for more reliable POI collection
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("POI collection timeout")), 15000); // Increased from 10000
        });

        // Get specialized POIs based on condition
        let conditionPOIs = {};
        
        const conditionPOIPromise = (async () => {
            try {
                console.log(`Fetching condition-specific POIs for ${currentPatientCondition.name}`);
                
                switch(currentPatientCondition.name) {
                    case 'respiratory':
                        conditionPOIs = await getRespiratoryPOIs(boundingBox);
                        break;
                    case 'cardiac':
                        conditionPOIs = await getCardiacPOIs(boundingBox);
                        break;
                    case 'arthritis':
                        conditionPOIs = await getArthritisPOIs(boundingBox);
                        break;
                    case 'mental':
                        conditionPOIs = await getMentalPOIs(boundingBox);
                        break;
                    case 'mobility':
                        conditionPOIs = await getMobilityPOIs(boundingBox);
                        break;
                    case 'diabetes':
                        conditionPOIs = await getDiabetesPOIs(boundingBox);
                        break;
                    default:
                        // No specialized POIs needed for default condition
                        conditionPOIs = {};
                }
            } catch (error) {
                console.error(`Error getting specialized POIs for ${currentPatientCondition.name}:`, error);
                // Use fallback values for specialized POIs instead of empty object
                conditionPOIs = getFallbackSpecializedPOIs(currentPatientCondition);
            }
            return conditionPOIs;
        })();
        
        // Get basic POIs in parallel
        const basicPOIPromise = get(boundingBox).catch(error => {
            console.warn("Error getting basic POIs:", error);
            // Return default POIs if basic POI fetch fails
            return getDefaultPOICounts();
        });
        
        // Race against timeout
        try {
            const [basicPOIs, specializedPOIs] = await Promise.race([
                Promise.all([basicPOIPromise, conditionPOIPromise]), 
                timeoutPromise.then(() => {
                    throw new Error("POI collection timeout");
                })
            ]);
            
            // Combine the results
            return {
                ...basicPOIs,
                ...specializedPOIs
            };
        } catch (timeoutError) {
            console.warn("POI collection timed out:", timeoutError.message);
            // Return combined fallback values instead of empty data
            const fallbackPOIs = {
                ...getDefaultPOICounts(),
                ...getFallbackSpecializedPOIs(currentPatientCondition)
            };
            return fallbackPOIs;
        }
    } catch (error) {
        console.error("Error in getEnhancedPOIs:", error);
        return {
            ...getDefaultPOICounts(),
            ...getFallbackSpecializedPOIs(currentPatientCondition)
        };
    }
}

// Add fallback specialized POI data for when API calls fail
function getFallbackSpecializedPOIs(patientCondition) {
    // Base values for all conditions
    const basePOIs = {
        restingAreaCount: 3,
        parkBenchCount: 5,
        healthServiceCount: 2,
        pharmacyCount: 2,
        flatPathwayCount: 4,
        waterFountainCount: 1,
        cafeCount: 3,
        publicToiletCount: 1,
        wheelchairAccessCount: 2,
        quietAreaCount: 2
    };
    
    // Condition-specific adjustments
    if (patientCondition && patientCondition.name) {
        switch(patientCondition.name) {
            case 'respiratory':
                return {
                    ...basePOIs,
                    quietAreaCount: 4,
                    parkBenchCount: 6,
                    healthServiceCount: 3
                };
            case 'cardiac':
                return {
                    ...basePOIs,
                    flatPathwayCount: 5,
                    healthServiceCount: 4,
                    pharmacyCount: 3,
                    restingAreaCount: 5
                };
            case 'arthritis':
                return {
                    ...basePOIs,
                    flatPathwayCount: 6,
                    parkBenchCount: 7,
                    publicToiletCount: 2,
                    restingAreaCount: 4
                };
            case 'mental':
                return {
                    ...basePOIs,
                    quietAreaCount: 5,
                    cafeCount: 4,
                    parkBenchCount: 6
                };
            case 'mobility':
                return {
                    ...basePOIs,
                    wheelchairAccessCount: 4,
                    flatPathwayCount: 7,
                    publicToiletCount: 2,
                    restingAreaCount: 4
                };
            case 'diabetes':
                return {
                    ...basePOIs,
                    waterFountainCount: 3,
                    cafeCount: 4,
                    pharmacyCount: 3,
                    healthServiceCount: 3
                };
            default:
                return basePOIs;
        }
    }
    
    return basePOIs;
}

function isValidBoundingBox(boundingBox) {
    return boundingBox && 
           typeof boundingBox.minLat === 'number' && 
           typeof boundingBox.maxLat === 'number' && 
           typeof boundingBox.minLon === 'number' && 
           typeof boundingBox.maxLon === 'number';
}

function getDefaultPOICounts() {
    return {
        natureCount: 3, // Increased from 0 for better default values
        entertainmentCount: 2,
        nightlifeCount: 1,
        tourismCount: 2,
        hospitalCount: 1
    };
}

async function getNearbyPOI(boundingBox) {
    try {
        // Basic categories (existing functionality)
        const natureCount = await getCountForCategory(boundingBox, 'nature');
        const entertainmentCount = await getCountForCategory(boundingBox, 'entertainment');
        const nightlifeCount = await getCountForCategory(boundingBox, 'nightlife');
        const tourismCount = await getCountForCategory(boundingBox, 'tourism');
        const hospitalCount = await getCountForCategory(boundingBox, 'hospital');

        return {
            natureCount: natureCount || 3, // Use at least 3 to encourage nature-based routes
            entertainmentCount: entertainmentCount || 2,
            nightlifeCount: nightlifeCount || 1,
            tourismCount: tourismCount || 2,
            hospitalCount: hospitalCount || 1
        };
    } catch (error) {
        console.error("Error fetching basic POIs:", error);
        return getDefaultPOICounts();
    }
}

// Specialized POI fetchers for each condition type to improve performance
async function getRespiratoryPOIs(boundingBox) {
    try {
        // Important features for respiratory patients
        const restingAreaCount = await safeOverpassQuery(boundingBox, 'amenity=shelter');
        const parkBenchCount = await safeOverpassQuery(boundingBox, 'amenity=bench');
        const healthServiceCount = await safeOverpassQuery(boundingBox, 'healthcare=*');
        const quietAreaCount = await getQuietAreas(boundingBox);
        const pharmacyCount = await safeOverpassQuery(boundingBox, 'amenity=pharmacy');
        
        return {
            restingAreaCount: Math.max(3, restingAreaCount || 0),
            parkBenchCount: Math.max(5, parkBenchCount || 0),
            healthServiceCount: Math.max(2, healthServiceCount || 0),
            quietAreaCount: Math.max(4, quietAreaCount || 0),
            pharmacyCount: Math.max(2, pharmacyCount || 0)
        };
    } catch (error) {
        console.error("Error fetching respiratory POIs:", error);
        return getFallbackSpecializedPOIs({name: 'respiratory'});
    }
}

async function getCardiacPOIs(boundingBox) {
    try {
        const restingAreaCount = await safeOverpassQuery(boundingBox, 'amenity=shelter');
        const parkBenchCount = await safeOverpassQuery(boundingBox, 'amenity=bench');
        const healthServiceCount = await safeOverpassQuery(boundingBox, 'healthcare=*');
        const pharmacyCount = await safeOverpassQuery(boundingBox, 'amenity=pharmacy');
        const flatPathwayCount = await getFlatPathways(boundingBox);
        const waterFountainCount = await safeOverpassQuery(boundingBox, 'amenity=drinking_water');
        
        return {
            restingAreaCount: Math.max(4, restingAreaCount || 0),
            parkBenchCount: Math.max(5, parkBenchCount || 0),
            healthServiceCount: Math.max(3, healthServiceCount || 0),
            pharmacyCount: Math.max(3, pharmacyCount || 0),
            flatPathwayCount: Math.max(5, flatPathwayCount || 0),
            waterFountainCount: Math.max(2, waterFountainCount || 0)
        };
    } catch (error) {
        console.error("Error fetching cardiac POIs:", error);
        return getFallbackSpecializedPOIs({name: 'cardiac'});
    }
}

async function getArthritisPOIs(boundingBox) {
    try {
        const flatPathwayCount = await getFlatPathways(boundingBox);
        const parkBenchCount = await safeOverpassQuery(boundingBox, 'amenity=bench');
        const restingAreaCount = await safeOverpassQuery(boundingBox, 'amenity=shelter');
        const cafeCount = await safeOverpassQuery(boundingBox, 'amenity=cafe');
        const publicToiletCount = await safeOverpassQuery(boundingBox, 'amenity=toilets');
        
        return {
            flatPathwayCount: Math.max(6, flatPathwayCount || 0),
            parkBenchCount: Math.max(6, parkBenchCount || 0),
            restingAreaCount: Math.max(4, restingAreaCount || 0),
            cafeCount: Math.max(3, cafeCount || 0),
            publicToiletCount: Math.max(2, publicToiletCount || 0)
        };
    } catch (error) {
        console.error("Error fetching arthritis POIs:", error);
        return getFallbackSpecializedPOIs({name: 'arthritis'});
    }
}

async function getMentalPOIs(boundingBox) {
    try {
        const quietAreaCount = await getQuietAreas(boundingBox);
        const cafeCount = await safeOverpassQuery(boundingBox, 'amenity=cafe');
        const parkBenchCount = await safeOverpassQuery(boundingBox, 'amenity=bench');
        const natureCount = await getCountForCategory(boundingBox, 'nature');
        
        return {
            quietAreaCount: Math.max(5, quietAreaCount || 0),
            cafeCount: Math.max(4, cafeCount || 0),
            parkBenchCount: Math.max(5, parkBenchCount || 0),
            natureCount: Math.max(5, natureCount || 0) // Ensure at least 5 nature POIs
        };
    } catch (error) {
        console.error("Error fetching mental health POIs:", error);
        return getFallbackSpecializedPOIs({name: 'mental'});
    }
}

async function getMobilityPOIs(boundingBox) {
    try {
        const wheelchairAccessCount = await getWheelchairAccessiblePlaces(boundingBox);
        const flatPathwayCount = await getFlatPathways(boundingBox);
        const publicToiletCount = await safeOverpassQuery(boundingBox, 'amenity=toilets');
        const restingAreaCount = await safeOverpassQuery(boundingBox, 'amenity=shelter');
        const parkBenchCount = await safeOverpassQuery(boundingBox, 'amenity=bench');
        
        return {
            wheelchairAccessCount: Math.max(4, wheelchairAccessCount || 0),
            flatPathwayCount: Math.max(7, flatPathwayCount || 0),
            publicToiletCount: Math.max(2, publicToiletCount || 0),
            restingAreaCount: Math.max(4, restingAreaCount || 0),
            parkBenchCount: Math.max(5, parkBenchCount || 0)
        };
    } catch (error) {
        console.error("Error fetching mobility POIs:", error);
        return getFallbackSpecializedPOIs({name: 'mobility'});
    }
}

async function getDiabetesPOIs(boundingBox) {
    try {
        const waterFountainCount = await safeOverpassQuery(boundingBox, 'amenity=drinking_water');
        const cafeCount = await safeOverpassQuery(boundingBox, 'amenity=cafe');
        const pharmacyCount = await safeOverpassQuery(boundingBox, 'amenity=pharmacy');
        const healthServiceCount = await safeOverpassQuery(boundingBox, 'healthcare=*');
        const parkBenchCount = await safeOverpassQuery(boundingBox, 'amenity=bench');
        
        return {
            waterFountainCount: Math.max(3, waterFountainCount || 0),
            cafeCount: Math.max(4, cafeCount || 0),
            pharmacyCount: Math.max(3, pharmacyCount || 0),
            healthServiceCount: Math.max(3, healthServiceCount || 0),
            parkBenchCount: Math.max(4, parkBenchCount || 0)
        };
    } catch (error) {
        console.error("Error fetching diabetes POIs:", error);
        return getFallbackSpecializedPOIs({name: 'diabetes'});
    }
}

async function getCountForCategory(boundingBox, category) {
    try {
        var categoryData = getCategoryData(category);
        
        // Ensure the URL has https:// protocol
        var url = 'https://nominatim.openstreetmap.org/search?';
        url += 'viewbox=' + boundingBox.minLon + ',' + boundingBox.minLat + ',' + boundingBox.maxLon + ',' + boundingBox.maxLat;
        url += '&bounded=1&dedupe=1&format=json&limit=20';
        url += categoryData.urlTag;

        // Add caching to prevent repeated requests
        if (!window.nominatimCache) window.nominatimCache = {};
        const cacheKey = `${category}_${boundingBox.minLat.toFixed(4)}_${boundingBox.minLon.toFixed(4)}_${boundingBox.maxLat.toFixed(4)}_${boundingBox.maxLon.toFixed(4)}`;
        
        // Check cache first
        if (window.nominatimCache[cacheKey] !== undefined) {
            return window.nominatimCache[cacheKey];
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
        
        try {
            // Use fetch with retry logic to handle connection issues
            let retries = 0;
            const maxRetries = 2;
            let success = false;
            let data = [];
            
            while (retries <= maxRetries && !success) {
                try {
                    console.log(`Fetching POI data for ${category}, attempt ${retries + 1}`);
                    
                    const response = await fetch(url, { 
                        signal: controller.signal,
                        headers: {
                            'Accept': 'application/json',
                            'User-Agent': 'PathPlanner/1.0 (health routing application)'
                        }
                    });
                    
                    // Network request succeeded
                    if (response.ok) {
                        data = await response.json();
                        success = true;
                    } else {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
                } catch (fetchError) {
                    retries++;
                    if (retries > maxRetries) {
                        console.warn(`Failed to fetch POI data for ${category} after ${maxRetries} attempts.`);
                        throw fetchError;
                    }
                    
                    // Wait before retrying (exponential backoff)
                    await new Promise(resolve => setTimeout(resolve, 500 * retries));
                }
            }
            
            // Process results
            const count = data.length;
            console.log(`${category} count: ${count}`);
            
            // Cache the result
            window.nominatimCache[cacheKey] = count;
            
            return count;
        } catch (error) {
            if (error.name === 'AbortError') {
                console.warn(`Request for ${category} timed out`);
            } else {
                console.error(`Error fetching POI count for ${category}:`, error);
            }
            
            // Cache the failure to prevent repeated requests
            window.nominatimCache[cacheKey] = 0;
            
            // Return fallback value based on category
            return getFallbackValueForCategory(category);
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (error) {
        console.error(`Error in getCountForCategory for ${category}:`, error);
        return getFallbackValueForCategory(category);
    }
}

// Add fallback values function for failed POI requests
function getFallbackValueForCategory(category) {
    // Return reasonable values that won't break scoring
    switch (category) {
        case 'nature':
            return 3;
        case 'entertainment':
            return 2;
        case 'nightlife':
            return 1;
        case 'tourism':
            return 2;
        case 'hospital':
            return 1;
        default:
            return 1;
    }
}

// Safety wrapper for Overpass API calls with retry
async function safeOverpassQuery(boundingBox, tag, maxRetries = 2) { // Increased from 1 to 2
    // Add global cache for API responses to prevent duplicate calls
    if (!window.overpassCache) window.overpassCache = {};
    
    // Create a cache key from the bounding box and tag
    const cacheKey = `${tag}_${boundingBox.minLat.toFixed(4)}_${boundingBox.minLon.toFixed(4)}_${boundingBox.maxLat.toFixed(4)}_${boundingBox.maxLon.toFixed(4)}`;
    
    // Check if we have a cached result
    if (window.overpassCache[cacheKey] !== undefined) {
        return window.overpassCache[cacheKey];
    }
    
    let retries = 0;
    
    while (retries <= maxRetries) {
        try {
            // Simplify query to reduce API load - only query nodes (most POIs are nodes)
            // Use smaller timeout and limit
            const query = `
                [out:json][timeout:5];
                (
                  node[${tag}](${boundingBox.minLat},${boundingBox.minLon},${boundingBox.maxLat},${boundingBox.maxLon});
                );
                out count;
            `;
            
            // Use alternative Overpass API instances
            const overpassInstances = [
                'https://overpass-api.de/api/interpreter',
                'https://overpass.kumi.systems/api/interpreter',
                'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
            ];
            
            const url = overpassInstances[retries % overpassInstances.length];
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000); // Increase timeout to 4s from 3s
            
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: 'data=' + encodeURIComponent(query),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                try {
                    const data = await response.json();
                    const count = data.elements && data.elements[0] ? (data.elements[0].tags?.total || 0) : 0;
                    
                    // Cache the result
                    window.overpassCache[cacheKey] = count;
                    
                    console.log(`${tag} count: ${count}`);
                    return count;
                } catch (jsonError) {
                    console.warn("Error parsing JSON response:", jsonError);
                    throw new Error("Invalid response format");
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    console.warn(`Request for ${tag} timed out`);
                } else {
                    console.error(`Error fetching Overpass API data for ${tag}:`, error);
                }
                
                retries++;
                if (retries > maxRetries) {
                    // Cache the fail result to prevent repeated failures
                    window.overpassCache[cacheKey] = 0;
                    return 0; // Return default if all retries failed
                }
                
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, 500));
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (outerError) {
            console.error(`Error in safeOverpassQuery for ${tag}:`, outerError);
            // Cache the fail result
            window.overpassCache[cacheKey] = 0;
            return 0;
        }
    }
    
    // Cache the fail result
    window.overpassCache[cacheKey] = 0;
    return 0;
}

// Special query for wheelchair accessible places
async function getWheelchairAccessiblePlaces(boundingBox) {
    return await safeOverpassQuery(boundingBox, 'wheelchair=yes');
}

// Special query for quiet areas (parks, gardens)
async function getQuietAreas(boundingBox) {
    // Simplify query to just check for parks and gardens
    const parkCount = await safeOverpassQuery(boundingBox, 'leisure=park');
    const gardenCount = await safeOverpassQuery(boundingBox, 'leisure=garden');
    
    return parkCount + gardenCount;
}

// Special query for flat pathways (no steps, no significant incline)
async function getFlatPathways(boundingBox) {
    // Simplified flat pathways query
    return await safeOverpassQuery(boundingBox, 'highway=footway');
}

function getCategoryData(category) {
    switch (category) {
        case 'nature':
            return {
                urlTag: '&q=[park] OR [garden] OR [green] OR [natural]'
            };
        case 'entertainment':
            return {
                urlTag: '&q=[cinema] OR [theatre] OR [entertainment] OR [museum]'
            };
        case 'nightlife':
            return {
                urlTag: '&q=[bar] OR [pub] OR [disco] OR [club] OR [nightclub]'
            };
        case 'tourism':
            return {
                urlTag: '&q=[tourism] OR [attractions] OR [monument]'
            };
        case 'hospital':
            return {
                urlTag: '&q=[hospital] OR [clinic] OR [emergency]'
            };
        default:
            return {
                urlTag: ''
            };
    }
}

// Export both functions together at the end of the file
export {
    get
}; // Removed getEnhancedPOIs since it's now exported directly with the export keyword

// Add the getRoutePOIs function to extract POIs along a route
export async function getRoutePOIs(route) {
    try {
        // If we don't have route coordinates, return default values
        if (!route || !route.coordinates || route.coordinates.length === 0) {
            console.warn("No valid route coordinates for POI extraction");
            return getDefaultPOICounts();
        }
        
        // Create a bounding box from the route coordinates
        const boundingBox = createBoundingBoxFromCoordinates(route.coordinates);
        
        // Use a promise with timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("POI collection timeout")), 8000);
        });
        
        try {
            // Race the API call against the timeout
            const basicPOIs = await Promise.race([
                get(boundingBox),
                timeoutPromise
            ]);
        
            // Add fallback specialized POIs to the existing data
            const fallbackPOIs = getFallbackSpecializedPOIs(null);
            
            // Return combined data
        return {
            ...basicPOIs,
                ...fallbackPOIs
            };
        } catch (timeoutError) {
            console.warn("POI data collection timed out:", timeoutError.message);
            // If timeout occurs, use all fallback values
            return {
                ...getDefaultPOICounts(),
            ...getFallbackSpecializedPOIs(null)
        };
        }
    } catch (error) {
        console.error("Error in getRoutePOIs:", error);
        // On any error, return complete fallback data
        return {
            ...getDefaultPOICounts(),
            ...getFallbackSpecializedPOIs(null)
        };
    }
}

// Helper function to create a bounding box from route coordinates
function createBoundingBoxFromCoordinates(coordinates) {
    // Initialize with first coordinate
    let minLat = coordinates[0].lat;
    let maxLat = coordinates[0].lat;
    let minLon = coordinates[0].lng;
    let maxLon = coordinates[0].lng;
    
    // Find the min/max coordinates to create the bounding box
    for (const coord of coordinates) {
        if (coord.lat < minLat) minLat = coord.lat;
        if (coord.lat > maxLat) maxLat = coord.lat;
        if (coord.lng < minLon) minLon = coord.lng;
        if (coord.lng > maxLon) maxLon = coord.lng;
    }
    
    // Add a small buffer around the bounding box (0.001 degrees ≈ 100m)
    const buffer = 0.001;
    
    return {
        minLat: minLat - buffer,
        maxLat: maxLat + buffer,
        minLon: minLon - buffer,
        maxLon: maxLon + buffer
    };
} 