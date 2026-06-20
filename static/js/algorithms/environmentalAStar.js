/**
 * Environmental A* Pathfinding Algorithm
 * Adapted from the paper "Personalized and Safe Route Planning for Asthma Patients Using Real-Time Environmental Data"
 * 
 * This algorithm extends the traditional A* pathfinding algorithm by incorporating environmental factors
 * such as air quality, weather conditions, elevation changes, and noise levels into the cost function.
 */

import * as Environmental from '../services/environmental.js';
import * as AirQuality from '../services/airQuality.js';
import * as Weather from '../services/weather.js';
import * as Elevation from '../services/elevation.js';
import { lookupEnv } from '../data/envTileIndex.js';

/**
 * Main Environmental A* pathfinding function
 * @param {Object} start - Starting point {lat, lon}
 * @param {Object} goal - Goal point {lat, lon}
 * @param {Object} map - Leaflet map object
 * @param {Object} patientCondition - Patient condition profile
 * @param {Array} environmentalData - Pre-loaded environmental data, if available
 * @param {Number} gridResolution - Resolution of the search grid (in meters)
 * @returns {Object} Best route found
 */
export async function findOptimalRoute(start, goal, map, patientCondition, environmentalData = null, gridResolution = 100, preferences = null) {
    console.log("Starting Environmental A* pathfinding algorithm");
    console.log(`Start: (${start.lat}, ${start.lon}), Goal: (${goal.lat}, ${goal.lon})`);
    console.log(`Patient condition: ${patientCondition.name}`);
    
    // Create a search grid around the route
    const grid = createSearchGrid(start, goal, gridResolution);
    console.log(`Created search grid with ${grid.length} nodes`);
    
    // Initialize open and closed sets
    const openSet = new PriorityQueue();
    const closedSet = new Set();
    
    // Initialize distance and environmental scores
    const gScore = {}; // Cost from start to current node
    const fScore = {}; // Estimated total cost (g + heuristic)
    const cameFrom = {}; // Path reconstruction
    
    // Add start node to open set
    const startNodeId = nodeToId(start);
    gScore[startNodeId] = 0;
    fScore[startNodeId] = estimateHeuristic(start, goal, patientCondition);
    openSet.enqueue(start, fScore[startNodeId]);
    
    // Track the best environmental factors found
    let bestEnvironmentalScore = Infinity;
    let bestRoute = null;
    
    // Main A* loop
    while (!openSet.isEmpty()) {
        // Get node with lowest f-score
        const current = openSet.dequeue();
        const currentId = nodeToId(current);
        
        // Check if we've reached the goal
        if (isGoalReached(current, goal)) {
            const route = reconstructPath(cameFrom, current);
            console.log(`Goal reached! Path found with ${route.length} nodes`);
            return {
                route: route,
                environmentalScore: gScore[currentId]
            };
        }
        
        // Add to closed set
        closedSet.add(currentId);
        
        // Get neighbors
        const neighbors = getNeighbors(current, grid, gridResolution);
        
        // Process each neighbor
        for (const neighbor of neighbors) {
            const neighborId = nodeToId(neighbor);
            
            // Skip if already evaluated
            if (closedSet.has(neighborId)) continue;
            
            // Calculate tentative g-score (distance + environmental factors)
            const tentativeGScore = await calculateCost(current, neighbor, gScore[currentId], patientCondition, environmentalData, preferences);
            
            // Check if this path is better than any previous one
            const neighborInOpenSet = openSet.contains(neighborId);
            if (!neighborInOpenSet || tentativeGScore < gScore[neighborId]) {
                // This is a better path, record it
                cameFrom[neighborId] = current;
                gScore[neighborId] = tentativeGScore;
                fScore[neighborId] = tentativeGScore + estimateHeuristic(neighbor, goal, patientCondition);
                
                if (!neighborInOpenSet) {
                    openSet.enqueue(neighbor, fScore[neighborId]);
                } else {
                    openSet.updatePriority(neighborId, fScore[neighborId]);
                }
                
                // Check if this is the best environmental score so far
                if (tentativeGScore < bestEnvironmentalScore && 
                    calculateDistance(neighbor, goal) < calculateDistance(start, goal) * 0.2) {
                    bestEnvironmentalScore = tentativeGScore;
                    bestRoute = reconstructPath(cameFrom, neighbor);
                }
            }
        }
    }
    
    // If we get here, no path was found - return the best partial route
    console.log("No complete path found, returning best partial route");
    return {
        route: bestRoute || [start, goal],
        environmentalScore: bestEnvironmentalScore
    };
}

/**
 * Creates a search grid around the start and goal points
 * @param {Object} start - Starting point
 * @param {Object} goal - Goal point
 * @param {Number} resolution - Grid resolution in meters
 * @returns {Array} Grid of nodes
 */
function createSearchGrid(start, goal, resolution) {
    const grid = [];
    
    // Calculate bounding box with some padding
    const minLat = Math.min(start.lat, goal.lat) - 0.01;
    const maxLat = Math.max(start.lat, goal.lat) + 0.01;
    const minLon = Math.min(start.lon, goal.lon) - 0.01;
    const maxLon = Math.max(start.lon, goal.lon) + 0.01;
    
    // Calculate grid size
    const latMetersPerDegree = 111320; // at equator
    const lonMetersPerDegree = 111320 * Math.cos(((start.lat + goal.lat) / 2) * Math.PI / 180);
    
    const latStep = resolution / latMetersPerDegree;
    const lonStep = resolution / lonMetersPerDegree;
    
    // Generate grid points
    for (let lat = minLat; lat <= maxLat; lat += latStep) {
        for (let lon = minLon; lon <= maxLon; lon += lonStep) {
            grid.push({ lat, lon });
        }
    }
    
    return grid;
}

/**
 * Get neighboring nodes from the grid
 * @param {Object} node - Current node
 * @param {Array} grid - Search grid
 * @param {Number} resolution - Grid resolution
 * @returns {Array} Neighboring nodes
 */
function getNeighbors(node, grid, resolution) {
    const latMetersPerDegree = 111320;
    const lonMetersPerDegree = 111320 * Math.cos(node.lat * Math.PI / 180);
    
    const latRadius = resolution / latMetersPerDegree;
    const lonRadius = resolution / lonMetersPerDegree;
    
    return grid.filter(gridNode => {
        const latDiff = Math.abs(gridNode.lat - node.lat);
        const lonDiff = Math.abs(gridNode.lon - node.lon);
        
        // Include nodes within resolution distance but not the node itself
        return latDiff <= latRadius && lonDiff <= lonRadius && 
               (latDiff > 0 || lonDiff > 0);
    });
}

/**
 * Calculate cost between two nodes
 * @param {Object} current - Current node
 * @param {Object} neighbor - Neighbor node
 * @param {Number} currentGScore - G-score of current node
 * @param {Object} patientCondition - Patient condition profile
 * @param {Array} environmentalData - Pre-loaded environmental data
 * @returns {Number} Cost value (g-score)
 */
async function calculateCost(current, neighbor, currentGScore, patientCondition, environmentalData, preferences = null) {
    // Base cost is the physical distance
    const distance = calculateDistance(current, neighbor);
    let cost = currentGScore + distance;
    
    // Get environmental data hierarchy: 1) tile cache 2) supplied list 3) live API
    let envData = lookupEnv(neighbor.lat, neighbor.lon);
    if (!envData && environmentalData) {
        envData = findClosestEnvironmentalData(neighbor, environmentalData);
    }
    if (!envData) {
        // Fallback to live API (slower but ensures correctness during development)
        envData = await Environmental.getPointEnvironmentalData(neighbor.lat, neighbor.lon, patientCondition);
    }
    
    // Apply environmental weights based on patient condition
    if (patientCondition && patientCondition.name !== "default") {
        // Base multipliers
        const airQualityMultiplier = patientCondition.airQualitySensitivity || 1;
        const slopeMultiplier = patientCondition.slopeSensitivity || 1;
        const noiseMultiplier = patientCondition.noiseSensitivity || 1;
        const temperatureMultiplier = patientCondition.temperatureSensitivity || 1;
        const humidityMultiplier = patientCondition.humiditySensitivity || 1;
        
        // Add penalties based on environmental factors
        if (envData.airQuality !== null && envData.airQuality !== undefined) {
            // Air quality penalty (exponential for poor air quality)
            const airQualityPenalty = Math.pow(Math.max(0, envData.airQuality - 4), 2) * airQualityMultiplier;
            cost += airQualityPenalty;
        }
        
        if (envData.slope !== null && envData.slope !== undefined) {
            // Slope penalty (quadratic)
            const slopePenalty = Math.pow(Math.abs(envData.slope), 2) * slopeMultiplier / 5;
            cost += slopePenalty;
        }
        
        if (envData.noise !== null && envData.noise !== undefined) {
            // Noise penalty (linear with threshold)
            const noisePenalty = Math.max(0, envData.noise - 3) * noiseMultiplier;
            cost += noisePenalty;
        }
        
        if (envData.temperature !== null && envData.temperature !== undefined) {
            // Temperature penalty (based on deviation from ideal)
            const tempDiff = Math.abs(envData.temperature - 22); // Deviation from comfortable 22°C
            const tempPenalty = tempDiff * temperatureMultiplier / 3;
            cost += tempPenalty;
        }
        
        if (envData.humidity !== null && envData.humidity !== undefined) {
            // Humidity penalty (based on deviation from ideal)
            const humidityDiff = Math.abs(envData.humidity - 50); // Deviation from 50%
            const humidityPenalty = humidityDiff * humidityMultiplier / 10;
            cost += humidityPenalty;
        }
        
        // Apply condition-specific penalties
        switch (patientCondition.name) {
            case "respiratory":
                // Higher penalties for areas with high traffic density
                if (envData.trafficDensity) {
                    cost += envData.trafficDensity * airQualityMultiplier * 10;
                }
                // Lower cost for green areas
                if (envData.greenVisibility) {
                    cost -= envData.greenVisibility * 5;
                }
                break;
                
            case "cardiac":
                // Higher penalties for steep slopes
                if (envData.slope) {
                    cost += Math.pow(Math.abs(envData.slope), 2) * slopeMultiplier / 2;
                }
                // Higher penalties for areas far from emergency services
                if (envData.emergencyAccessibility) {
                    cost += envData.emergencyAccessibility * 2;
                }
                break;
                
            case "mobility":
                // Extremely high penalties for steep slopes
                if (envData.slope) {
                    cost += Math.pow(Math.abs(envData.slope), 2.5) * slopeMultiplier;
                }
                // Penalties for poor surface quality
                if (envData.surfaceQuality) {
                    cost += envData.surfaceQuality * 15;
                }
                break;
                
            case "mental":
                // Higher penalties for noisy areas
                if (envData.noise) {
                    cost += Math.pow(envData.noise, 1.5) * noiseMultiplier;
                }
                // Higher penalties for areas with high sensory load
                if (envData.sensoryLoad) {
                    cost += envData.sensoryLoad * 2;
                }
                // Lower cost for green areas
                if (envData.greenVisibility) {
                    cost -= envData.greenVisibility * 8;
                }
                break;
        }
    }
    
    // Apply user-preference weights alongside the pathology profile
    if (patientCondition) {
        const combinedNature = (patientCondition.patientNature || 0) + (preferences?.nature || 0);
        const combinedEntertainment = (patientCondition.patientEntertainment || 0) + (preferences?.entertainment || 0);
        const combinedNightlife = (patientCondition.patientNightlife || 0) + (preferences?.nightlife || 0);
        const combinedTourism = (patientCondition.patientTourism || 0) + (preferences?.tourism || 0);
        const combinedHospital = (patientCondition.patientHospital || 0) + (preferences?.hospital || 0);

        if (combinedNature !== 0 && envData.greenVisibility != null) {
            cost -= envData.greenVisibility * combinedNature * 0.8;
        }
        if (combinedHospital !== 0 && envData.emergencyAccessibility != null) {
            cost -= envData.emergencyAccessibility * combinedHospital * 0.8;
        }
        if (combinedEntertainment !== 0 && envData.noise != null) {
            cost -= (envData.noise / 10) * combinedEntertainment * 0.8;
        }
        if (combinedNightlife !== 0 && envData.noise != null) {
            cost -= (envData.noise / 10) * combinedNightlife * 0.8;
        }
        if (combinedTourism !== 0 && envData.greenVisibility != null) {
            cost -= envData.greenVisibility * combinedTourism * 0.8;
        }
    }
    
    return cost;
}

/**
 * Find the closest environmental data point to a node
 * @param {Object} node - Node to find data for
 * @param {Array} environmentalData - Array of environmental data points
 * @returns {Object} Closest environmental data
 */
function findClosestEnvironmentalData(node, environmentalData) {
    if (!environmentalData || environmentalData.length === 0) {
        return null;
    }
    
    let closestDistance = Infinity;
    let closestData = null;
    
    for (const dataPoint of environmentalData) {
        if (dataPoint.coordinate) {
            const distance = calculateDistance(
                node, 
                { lat: dataPoint.coordinate.lat, lon: dataPoint.coordinate.lng }
            );
            
            if (distance < closestDistance) {
                closestDistance = distance;
                closestData = dataPoint;
            }
        }
    }
    
    return closestData;
}

/**
 * Calculate straight-line distance between two nodes
 * @param {Object} a - First node
 * @param {Object} b - Second node
 * @returns {Number} Distance in meters
 */
function calculateDistance(a, b) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = a.lat * Math.PI / 180;
    const φ2 = b.lat * Math.PI / 180;
    const Δφ = (b.lat - a.lat) * Math.PI / 180;
    const Δλ = (b.lon - a.lon) * Math.PI / 180;

    const x = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
    
    return R * c;
}

/**
 * Estimate heuristic cost from node to goal
 * @param {Object} node - Current node
 * @param {Object} goal - Goal node
 * @param {Object} patientCondition - Patient condition
 * @returns {Number} Heuristic estimate
 */
function estimateHeuristic(node, goal, patientCondition) {
    // Base heuristic is straight-line distance
    const distance = calculateDistance(node, goal);
    
    // We could adjust this heuristic based on expected environmental conditions
    // but a simple distance heuristic ensures admissibility
    return distance;
}

/**
 * Check if we've reached the goal
 * @param {Object} node - Current node
 * @param {Object} goal - Goal node
 * @returns {Boolean} True if goal reached
 */
function isGoalReached(node, goal) {
    // Goal is reached if within 50 meters
    return calculateDistance(node, goal) < 50;
}

/**
 * Convert node to string ID for tracking
 * @param {Object} node - Node to convert
 * @returns {String} Node ID
 */
function nodeToId(node) {
    return `${node.lat.toFixed(6)},${node.lon.toFixed(6)}`;
}

/**
 * Reconstruct path from start to current node
 * @param {Object} cameFrom - Map of node parents
 * @param {Object} current - Current node
 * @returns {Array} Path from start to current
 */
function reconstructPath(cameFrom, current) {
    const path = [current];
    let currentId = nodeToId(current);
    
    while (cameFrom[currentId]) {
        current = cameFrom[currentId];
        path.unshift(current);
        currentId = nodeToId(current);
    }
    
    return path;
}

/**
 * Priority queue implementation for A*
 */
class PriorityQueue {
    constructor() {
        this.elements = [];
        this.idMap = {}; // Maps node IDs to indices
    }
    
    isEmpty() {
        return this.elements.length === 0;
    }
    
    enqueue(element, priority) {
        const id = nodeToId(element);
        const entry = { element, priority, id };
        this.elements.push(entry);
        this.idMap[id] = this.elements.length - 1;
        this.bubbleUp(this.elements.length - 1);
    }
    
    dequeue() {
        if (this.isEmpty()) {
            return null;
        }
        
        const top = this.elements[0].element;
        const end = this.elements.pop();
        delete this.idMap[nodeToId(top)];
        
        if (!this.isEmpty()) {
            this.elements[0] = end;
            this.idMap[end.id] = 0;
            this.sinkDown(0);
        }
        
        return top;
    }
    
    updatePriority(id, priority) {
        if (this.idMap[id] === undefined) {
            return false;
        }
        
        const index = this.idMap[id];
        const oldPriority = this.elements[index].priority;
        this.elements[index].priority = priority;
        
        if (priority < oldPriority) {
            this.bubbleUp(index);
        } else {
            this.sinkDown(index);
        }
        
        return true;
    }
    
    contains(id) {
        return this.idMap[id] !== undefined;
    }
    
    bubbleUp(index) {
        const element = this.elements[index];
        
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            const parent = this.elements[parentIndex];
            
            if (element.priority >= parent.priority) {
                break;
            }
            
            // Swap with parent
            this.elements[parentIndex] = element;
            this.elements[index] = parent;
            
            // Update ID map
            this.idMap[element.id] = parentIndex;
            this.idMap[parent.id] = index;
            
            index = parentIndex;
        }
    }
    
    sinkDown(index) {
        const length = this.elements.length;
        const element = this.elements[index];
        
        while (true) {
            const leftChildIndex = 2 * index + 1;
            const rightChildIndex = 2 * index + 2;
            let swapIndex = null;
            
            if (leftChildIndex < length) {
                const leftChild = this.elements[leftChildIndex];
                if (leftChild.priority < element.priority) {
                    swapIndex = leftChildIndex;
                }
            }
            
            if (rightChildIndex < length) {
                const rightChild = this.elements[rightChildIndex];
                if (
                    (swapIndex === null && rightChild.priority < element.priority) ||
                    (swapIndex !== null && rightChild.priority < this.elements[swapIndex].priority)
                ) {
                    swapIndex = rightChildIndex;
                }
            }
            
            if (swapIndex === null) {
                break;
            }
            
            // Swap with child
            this.elements[index] = this.elements[swapIndex];
            this.elements[swapIndex] = element;
            
            // Update ID map
            this.idMap[this.elements[index].id] = index;
            this.idMap[element.id] = swapIndex;
            
            index = swapIndex;
        }
    }
}

/**
 * Generate multiple alternative routes using A*
 * @param {Object} start - Starting point
 * @param {Object} goal - Goal point
 * @param {Object} map - Leaflet map
 * @param {Object} patientCondition - Patient condition
 * @param {Number} numRoutes - Number of alternative routes to generate
 * @returns {Array} Array of routes
 */
export async function generateAlternativeRoutes(start, goal, map, patientCondition, numRoutes = 3, preferences = null) {
    const benchmarkMode = window.PATHPLANNER_BENCHMARK === true;
    const effectiveNumRoutes = benchmarkMode
        ? Math.min(numRoutes, window.BENCHMARK_ASTAR_NUM_ROUTES ?? 1)
        : numRoutes;
    const gridResolution = benchmarkMode
        ? (window.BENCHMARK_ASTAR_GRID_M || 150)
        : 100;

    if (!benchmarkMode) {
        console.log(
            `Generating ${effectiveNumRoutes} alternative routes for ${patientCondition.name} condition`,
        );
    }

    const directPath = [start, goal];
    const environmentalData = await collectEnvironmentalData(directPath, patientCondition);

    const firstRoute = await findOptimalRoute(
        start,
        goal,
        map,
        patientCondition,
        environmentalData,
        gridResolution,
        preferences,
    );
    
    // Add environmental data to route
    firstRoute.environmentalData = environmentalData;
    
    const routes = [firstRoute];
    
    // For each additional route, add penalties to areas of previous routes
    const penalties = new Map(); // Maps nodeId -> penalty
    
    for (let i = 1; i < effectiveNumRoutes; i++) {
        if (!benchmarkMode) {
            console.log(`Generating alternative route ${i + 1}`);
        }
        
        // Add penalties to previously found routes
        for (const route of routes) {
            for (const node of route.route) {
                const nodeId = nodeToId(node);
                const currentPenalty = penalties.get(nodeId) || 0;
                penalties.set(nodeId, currentPenalty + 100); // Add significant penalty
                
                // Also penalize nearby nodes
                const nearbyPenalty = 50;
                const penaltyRadius = 0.001; // Roughly 100m
                
                for (let lat = node.lat - penaltyRadius; lat <= node.lat + penaltyRadius; lat += penaltyRadius / 2) {
                    for (let lon = node.lon - penaltyRadius; lon <= node.lon + penaltyRadius; lon += penaltyRadius / 2) {
                        const nearbyId = nodeToId({ lat, lon });
                        const currentNearbyPenalty = penalties.get(nearbyId) || 0;
                        penalties.set(nearbyId, currentNearbyPenalty + nearbyPenalty);
                    }
                }
            }
        }
        
        // Create a modified cost calculation function with penalties
        const originalCalculateCost = calculateCost;
        const calculateCostWithPenalties = async (current, neighbor, currentGScore, patientCondition, environmentalData, prefs) => {
            let cost = await originalCalculateCost(current, neighbor, currentGScore, patientCondition, environmentalData, prefs);
            
            // Add penalties for previously visited nodes
            const neighborId = nodeToId(neighbor);
            const penalty = penalties.get(neighborId) || 0;
            cost += penalty;
            
            return cost;
        };
        
        // Temporarily replace the cost function
        calculateCost = calculateCostWithPenalties;
        
        // Generate alternative route
        const alternativeRoute = await findOptimalRoute(
            start,
            goal,
            map,
            patientCondition,
            environmentalData,
            gridResolution,
            preferences,
        );
        
        // Collect specific environmental data for this alternative route
        // to ensure each route has its own environmental profile
        if (alternativeRoute && alternativeRoute.route && alternativeRoute.route.length > 0) {
            // Add some variation to make each route's environmental data unique
            const routeSpecificData = await collectEnvironmentalData(
                alternativeRoute.route, 
                patientCondition,
                i // Pass route index for variation
            );
            
            alternativeRoute.environmentalData = routeSpecificData;
        } else {
            // Fallback if no route was found
            alternativeRoute.environmentalData = environmentalData;
        }
        
        routes.push(alternativeRoute);
        
        // Restore original cost function
        calculateCost = originalCalculateCost;
    }
    
    // Sort routes by environmental score
    routes.sort((a, b) => a.environmentalScore - b.environmentalScore);
    
    return routes;
}

/**
 * Collect environmental data along a path
 * @param {Array} path - Array of nodes
 * @param {Object} patientCondition - Patient condition
 * @param {Number} routeIndex - Index for variation between routes (optional)
 * @returns {Array} Environmental data for the path
 */
async function collectEnvironmentalData(path, patientCondition, routeIndex = 0) {
    const environmentalData = [];
    
    const benchmarkMode = window.PATHPLANNER_BENCHMARK === true;
    const sampleCount = benchmarkMode
        ? Math.min(4, path.length)
        : Math.min(20, path.length);
    const step = Math.max(1, Math.floor(path.length / sampleCount));
    
    // Add small variation based on route index to ensure different routes
    // have different environmental profiles
    const routeVariation = routeIndex * 0.05; // 5% variation per route
    
    for (let i = 0; i < path.length; i += step) {
        if (environmentalData.length >= sampleCount) break;
        
        const node = path[i];
        if (!node || typeof node.lat !== 'number' || typeof node.lon !== 'number') continue;
        
        try {
            let envData = null;
            
            // Try to get real environmental data
            try {
                envData = await Environmental.getPointEnvironmentalData(node.lat, node.lon, patientCondition);
            } catch (error) {
                console.warn(`Error getting environmental data for (${node.lat}, ${node.lon}): ${error.message}`);
                envData = null;
            }
            
            // If we couldn't get real data, generate synthetic data
            if (!envData) {
                // Create deterministic synthetic data
                const locationHash = Math.abs(Math.sin(node.lat * 100) * 10000 + Math.cos(node.lon * 100) * 10000);
                const hashFactor = (locationHash % 100) / 100; // 0-1 range
                
                // Apply route variation
                const variationFactor = 1.0 + (routeVariation * Math.sin(node.lat * node.lon));
                
                envData = {
                    temperature: 20 + (Math.sin(node.lat * 8) * 5 * hashFactor * variationFactor),
                    humidity: 50 + (Math.cos(node.lon * 5) * 15 * hashFactor * variationFactor),
                    airQuality: Math.max(1, Math.min(10, 5 * hashFactor * variationFactor)),
                    weather: ["Clear", "Partly Cloudy", "Cloudy", "Light Rain"][Math.floor(node.lat * 10 + routeIndex) % 4],
                    slope: Math.abs(2 * Math.sin(node.lat * 20) * hashFactor * variationFactor),
                    noise: Math.max(1, Math.min(10, 3 * hashFactor * variationFactor)),
                    timestamp: Date.now(),
                    isDefault: true,
                    isSynthetic: true,
                    routeIndex: routeIndex // Mark which route this is for
                };
            }
            
            // Add coordinate data
            envData.coordinate = { lat: node.lat, lng: node.lon };
            environmentalData.push(envData);
            
        } catch (error) {
            console.warn(`General error processing point (${node.lat}, ${node.lon}): ${error.message}`);
        }
    }
    
    return environmentalData;
}

/**
 * Convert A* route to Leaflet format
 * @param {Array} route - A* route
 * @returns {Array} Leaflet-compatible route
 */
export function convertToLeafletRoute(route) {
    return route.map(node => L.latLng(node.lat, node.lon));
}

/**
 * Calculate the environmental cost of a path node based on patient condition
 * @param {Object} node - Path node with lat/lon coordinates
 * @param {Object} patientCondition - Patient condition with sensitivities
 * @returns {Promise<number>} - Cost value (higher is worse)
 */
export async function calculateEnvironmentalCost(node, patientCondition) {
    if (!node || !node.lat || !node.lon) {
        console.error("Invalid node provided to calculateEnvironmentalCost:", node);
        return 1000; // Default high cost for invalid nodes
    }
    
    try {
        console.log(`[calculateEnvironmentalCost] Getting data for ${node.lat.toFixed(6)}, ${node.lon.toFixed(6)}`);
        const envData = await Environmental.getPointEnvironmentalData(node.lat, node.lon, patientCondition);
        
        // If data fetch failed, return moderate cost
        if (!envData) return 500;
        
        // Base cost starts at 50 (neutral)
        let baseCost = 50;
        
        // Track if this uses real or simulated data
        const isRealData = !envData.isDefault;
        
        // Calculate condition-specific cost based on environmental factors
        // IMPORTANT: Lower is better for A* algorithm
        
        if (patientCondition && patientCondition.name !== "default") {
            switch(patientCondition.name) {
                case "respiratory":
                    // For respiratory conditions, air quality is most important
                    if (envData.airQuality !== null) {
                        // Air quality has exponential impact (worse air = much higher cost)
                        baseCost += Math.pow(envData.airQuality, 2) * 5;
                    }
                    
                    // Steep slopes require more exertion (breathing difficulty)
                    if (envData.slope !== null) {
                        baseCost += Math.pow(envData.slope, 1.5) * 3;
                    }
                    
                    // Temperature extremes can affect breathing
                    if (envData.temperature !== null) {
                        const optimalTemp = 22; // 22°C is optimal
                        const tempDiff = Math.abs(envData.temperature - optimalTemp);
                        baseCost += tempDiff * 2;
                    }
                    
                    // Traffic exposure increases respiratory issues
                    if (envData.trafficDensity !== null) {
                        baseCost += envData.trafficDensity * 100;
                    }
                    
                    // Green areas improve air quality
                    if (envData.greenVisibility !== null) {
                        baseCost -= envData.greenVisibility * 50;
                    }
                    break;
                    
                case "cardiac":
                    // For cardiac conditions, slope is most important
                    if (envData.slope !== null) {
                        // Steeper slopes have exponential impact on cardiac strain
                        baseCost += Math.pow(envData.slope, 2) * 8;
                    }
                    
                    // Emergency access is critical
                    if (envData.emergencyAccessibility !== null) {
                        baseCost += envData.emergencyAccessibility * 10;
                    }
                    
                    // Rest opportunities reduce cardiac strain
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 60;
                    }
                    
                    // Temperature extremes affect cardiac function
                    if (envData.temperature !== null) {
                        const optimalTemp = 22; // 22°C is optimal
                        const tempDiff = Math.abs(envData.temperature - optimalTemp);
                        baseCost += tempDiff * 3;
                    }
                    
                    // Air quality affects heart
                    if (envData.airQuality !== null) {
                        baseCost += envData.airQuality * 3;
                    }
                    break;
                    
                case "mobility":
                    // For mobility conditions, slope and surface quality are most important
                    if (envData.slope !== null) {
                        // Any slope is problematic - use higher exponent for steeper penalty
                        baseCost += Math.pow(envData.slope, 2.5) * 10;
                    }
                    
                    // Surface quality is critical
                    if (envData.surfaceQuality !== null) {
                        baseCost += envData.surfaceQuality * 150;
                    }
                    
                    // Street width affects mobility device usage
                    if (envData.streetWidth !== null) {
                        // Narrower streets are more difficult
                        baseCost += Math.max(0, (4 - envData.streetWidth)) * 30;
                    }
                    
                    // Accessibility features are beneficial
                    if (envData.accessibilityFeatures !== null) {
                        baseCost -= envData.accessibilityFeatures * 80;
                    }
                    
                    // Rest opportunities
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 40;
                    }
                    break;
                    
                case "mental":
                    // For mental conditions, noise and green space are most important
                    if (envData.noise !== null) {
                        // Noise has exponential impact on mental wellbeing
                        baseCost += Math.pow(envData.noise, 1.8) * 5;
                    }
                    
                    // Green spaces are highly beneficial
                    if (envData.greenVisibility !== null) {
                        baseCost -= envData.greenVisibility * 100;
                    }
                    
                    // Sensory load affects mental wellbeing
                    if (envData.sensoryLoad !== null) {
                        baseCost += envData.sensoryLoad * 8;
                    }
                    
                    // Traffic density increases stress
                    if (envData.trafficDensity !== null) {
                        baseCost += envData.trafficDensity * 80;
                    }
                    
                    // Weather affects mood
                    if (envData.weather) {
                        if (envData.weather.includes("Clear") || envData.weather.includes("Sun")) {
                            baseCost -= 30;
                        } else if (envData.weather.includes("Rain") || envData.weather.includes("Cloud")) {
                            baseCost += 20;
                        }
                    }
                    break;
                    
                case "arthritis":
                    // For arthritis conditions, surface quality and temperature are most important
                    if (envData.surfaceQuality !== null) {
                        baseCost += envData.surfaceQuality * 120;
                    }
                    
                    // Slopes affect joints
                    if (envData.slope !== null) {
                        baseCost += Math.pow(envData.slope, 1.8) * 7;
                    }
                    
                    // Cold temperatures worsen joint pain
                    if (envData.temperature !== null) {
                        // Cold is worse than hot for arthritis
                        if (envData.temperature < 20) {
                            baseCost += Math.pow(20 - envData.temperature, 1.5) * 4;
                        } else if (envData.temperature > 30) {
                            baseCost += (envData.temperature - 30) * 2;
                        }
                    }
                    
                    // Rest opportunities are important
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 70;
                    }
                    
                    // Humidity affects joints
                    if (envData.humidity !== null) {
                        if (envData.humidity > 60) {
                            baseCost += (envData.humidity - 60) * 0.5;
                        }
                    }
                    break;
                    
                case "diabetes":
                    // For diabetes, moderate exercise with service access is important
                    
                    // Moderate slopes provide good exercise
                    if (envData.slope !== null) {
                        // Gentle slopes (1-4%) are beneficial, steeper slopes are problematic
                        const optimalSlope = 2.5;
                        const slopeDiff = Math.abs(envData.slope - optimalSlope);
                        
                        if (envData.slope <= 4) {
                            // Gentle slopes get a bonus
                            baseCost -= (4 - slopeDiff) * 10;
                        } else {
                            // Steeper slopes get a penalty
                            baseCost += (envData.slope - 4) * 15;
                        }
                    }
                    
                    // Access to services
                    if (envData.emergencyAccessibility !== null) {
                        baseCost += envData.emergencyAccessibility * 8;
                    }
                    
                    // Food access is important for blood sugar management
                    if (envData.foodAccess !== null) {
                        baseCost -= envData.foodAccess * 60;
                    }
                    
                    // Rest opportunities
                    if (envData.restOpportunities !== null) {
                        baseCost -= envData.restOpportunities * 50;
                    }
                    
                    // Temperature extremes
                    if (envData.temperature !== null) {
                        const optimalTemp = 22;
                        const tempDiff = Math.abs(envData.temperature - optimalTemp);
                        
                        if (tempDiff > 8) {
                            // Large temperature deviations are problematic
                            baseCost += (tempDiff - 8) * 10;
                        }
                    }
                    break;
                    
                default:
                    // For default/unknown conditions, use a general cost model
                    if (envData.airQuality !== null) baseCost += envData.airQuality * 3;
                    if (envData.slope !== null) baseCost += envData.slope * 5;
                    if (envData.noise !== null) baseCost += envData.noise * 2;
                    break;
            }
        } else {
            // Default cost calculation for non-patient mode
            if (envData.airQuality !== null) baseCost += envData.airQuality * 3;
            if (envData.slope !== null) baseCost += envData.slope * 5;
            if (envData.noise !== null) baseCost += envData.noise * 2;
        }
        
        // Ensure cost is never negative or extremely high
        const finalCost = Math.max(10, Math.min(1000, baseCost));
        
        // Slight bonus for real data
        const realDataCost = isRealData ? finalCost * 0.9 : finalCost;
        
        // Debug info
        console.log(`[calculateEnvironmentalCost] Node (${node.lat.toFixed(6)}, ${node.lon.toFixed(6)}) - Cost: ${realDataCost.toFixed(2)} - Using ${isRealData ? 'REAL' : 'SIMULATED'} data`);
        
        return realDataCost;
    } catch (error) {
        console.error("Error calculating environmental cost:", error);
        return 500; // Default moderate cost on error
    }
}

/**
 * Custom heuristic function for A* that includes environmental factors
 * @param {Object} node - Current node
 * @param {Object} goal - Goal node
 * @param {Object} patientCondition - Patient condition
 * @returns {number} - Heuristic value
 */
export function environmentalHeuristic(node, goal, patientCondition) {
    // Base heuristic: direct distance to goal (in meters)
    const distance = haversineDistance(
        node.lat, node.lon,
        goal.lat, goal.lon
    );
    
    // Calculate condition-specific heuristic factors
    let heuristicMultiplier = 1.0;
    
    if (patientCondition && patientCondition.name !== "default") {
        switch(patientCondition.name) {
            case "respiratory":
                // Respiratory patients prefer slightly longer but better air quality routes
                heuristicMultiplier = 0.85;
                break;
                
            case "cardiac":
                // Cardiac patients need flatter routes even if slightly longer
                heuristicMultiplier = 0.8;
                break;
                
            case "mobility":
                // Mobility patients need accessible routes even if longer
                heuristicMultiplier = 0.75;
                break;
                
            case "mental":
                // Mental health patients benefit from scenic/calm routes
                heuristicMultiplier = 0.85;
                break;
                
            case "arthritis":
                // Arthritis patients need smooth surfaces even if longer
                heuristicMultiplier = 0.8;
                break;
                
            case "diabetes":
                // Diabetes patients need moderate exercise and service access
                heuristicMultiplier = 0.9;
                break;
                
            default:
                heuristicMultiplier = 1.0;
        }
    }
    
    // Apply the multiplier to encourage exploration of potentially better routes
    // A lower heuristic allows the algorithm to explore more paths
    return distance * heuristicMultiplier;
}

/**
 * Calculate distance between two points using the Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} - Distance in meters
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
} 