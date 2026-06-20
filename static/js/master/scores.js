/**
 * ACTIVE SCORER (browser benchmark + map): calculateAllScores → calculateRawEnvironmentalScore.
 * Constants: ../data/scoringConstants.js — see docs/SCORING_EVIDENCE.md.
 *
 * LEGACY below: calculateAll() uses ad-hoc multipliers; not used by Playwright benchmark.
 */
import { SCORING } from '../data/scoringConstants.js';

function temperatureFactorScore(avgC) {
    const cfg = SCORING.factors.temperature;
    const dev = Math.abs(avgC - cfg.comfortC);
    if (dev <= cfg.bands.comfort.maxDeviationC) return cfg.bands.comfort.score;
    if (dev <= cfg.bands.moderate.maxDeviationC) return cfg.bands.moderate.score;
    return cfg.bands.stress.score;
}

function humidityFactorScore(avgRh) {
    const cfg = SCORING.factors.humidity;
    const dev = Math.abs(avgRh - cfg.comfortPct);
    if (dev <= cfg.bands.comfort.maxDeviationPct) return cfg.bands.comfort.score;
    if (dev <= cfg.bands.moderate.maxDeviationPct) return cfg.bands.moderate.score;
    return cfg.bands.stress.score;
}

function airQualityFactorScore(avgPollution) {
    return Math.max(0, SCORING.factors.airQuality.scaleMax - avgPollution);
}

function noiseFactorScore(avgNoise) {
    return Math.max(0, SCORING.factors.noise.scaleMax - avgNoise);
}

function calculateConditionWeights(patientCondition) {
    const t = SCORING.weightTiers;
    const weights = {
        temperature: t.low,
        airQuality: t.low,
        slope: t.low,
        noise: t.low,
        humidity: 0,
        poiNature: t.low,
        poiEntertainment: t.low,
        poiNightlife: t.low,
        poiTourism: t.low,
        poiHospital: t.low,
    };
    const name = patientCondition && patientCondition.name;
    if (!name || name === 'default') {
        return weights;
    }
    const env = SCORING.conditionEnvWeights[name];
    if (env) {
        Object.assign(weights, env);
    }
    const poi = SCORING.conditionPoiEmphasis[name];
    if (poi) {
        Object.assign(weights, poi);
    }
    return weights;
}

function getTotalScoreBlend(patientCondition) {
    const name = patientCondition && patientCondition.isPatientMode && patientCondition.name;
    if (name && SCORING.totalScoreBlend[name]) {
        return SCORING.totalScoreBlend[name];
    }
    return SCORING.totalScoreBlend.default;
}

/** @deprecated Legacy route loop; benchmark uses calculateAllScores. */
export async function calculateAll(poiCounts, routeData, currentPreferences, currentPatientCondition) {
    var score = 0;
    var envScore = 0;
    var poiScore = 0;
    var specializedPoiScore = 0;
    var lowestEnvironmentScore = null;
    var avoidWaypoint = {
        lat: null,
        lon: null
    }

    // Define condition-specific weights with DRAMATICALLY INCREASED MULTIPLIERS
    let envWeightMultiplier = 1.0;
    let poiWeightMultiplier = 1.0;
    let slopeWeightMultiplier = 2.0; // Further increased from 1.5
    let noiseWeightMultiplier = 2.0; // Further increased from 1.5
    
    // Implement the paper's concept of condition-specific "health impact functions"
    // DRAMATICALLY INCREASED WEIGHTS to force more distinct route selection
    const healthImpactWeights = {
        respiratory: {
            airQuality: 8.0,      // Increased from 5.0
            slope: 4.0,           // Increased from 3.0
            noise: 2.0,           // Increased from 1.2
            temperature: 3.0,      // Increased from 2.0
            humidity: 3.5,         // Increased from 2.5
            greenSpace: -5.0,      // Increased benefit from -3.0
            trafficExposure: 7.0   // New factor with high weight
        },
        cardiac: {
            airQuality: 3.5,       // Increased from 2.5
            slope: 7.0,           // Dramatically increased from 4.0
            noise: 3.0,           // Increased from 2.0
            temperature: 4.0,      // Increased from 3.0
            restAccess: -6.0,      // Increased benefit from -4.0
            medicalAccess: -7.0,   // Increased benefit from -5.0
            emergencyDistance: 6.0 // New factor with high weight
        },
        mobility: {
            slope: 8.0,           // Dramatically increased from 5.0
            surfaceQuality: 6.0,   // Increased from 4.0
            obstacles: 6.0,        // Increased from 4.0
            restAccess: -4.0,      // Increased from -3.0
            accessibleFeatures: -7.0, // Increased from -5.0
            streetWidth: 5.0       // New factor with high weight
        },
        mental: {
            noise: 7.0,           // Dramatically increased from 4.5
            greenSpace: -6.0,      // Increased from -4.0
            crowding: 5.0,         // Increased from 3.0
            sensoryLoad: 6.0,      // Increased from 4.0
            socialSpaces: -3.5,    // Increased from -2.5
            naturalElements: -5.0  // New factor with high weight
        },
        arthritis: {
            slope: 6.0,           // Increased from 4.0
            surfaceQuality: 5.5,   // Increased from 3.5
            temperature: 3.0,      // Increased from 2.0
            humidity: 3.0,         // Increased from 2.0
            restAccess: -5.0,      // Increased from -3.5
            jointStressFactors: 5.0 // New factor with high weight
        },
        diabetes: {
            medicalAccess: -5.0,   // Increased from -3.0
            foodAccess: -4.5,      // Increased from -3.0
            moderate_exertion: -3.0, // Increased from -2.0
            extreme_conditions: 5.0, // Increased from 3.0
            restAccess: -3.5,      // Increased from -2.5
            serviceProximity: -4.0  // New factor with high weight
        }
    };
    
    // Add per-point penalty thresholds for each condition - FURTHER LOWERED for even more sensitivity
    const thresholds = {
        respiratory: {
            slopeThreshold: 3.5,         // Lowered from 4.0
            airQualityThreshold: 4.5,     // Lowered from 5.0
            trafficDensityThreshold: 0.5  // Lowered from 0.6
        },
        cardiac: {
            slopeThreshold: 2.5,          // Lowered from 3.0
            restOpportunitiesThreshold: 0.25, // Increased from 0.2
            emergencyAccessibilityThreshold: 7 // Lowered from 8
        },
        mobility: {
            slopeThreshold: 1.5,          // Lowered from 2.0
            surfaceQualityThreshold: 0.25, // Lowered from 0.3
            streetWidthThreshold: 2.5,    // Increased from 2.0
            accessibilityThreshold: 0.3   // Increased from 0.2
        },
        mental: {
            noiseThreshold: 5.5,          // Lowered from 6.0
            greenVisibilityThreshold: 0.25, // Increased from 0.2
            sensoryLoadThreshold: 6.5      // Lowered from 7.0
        },
        arthritis: {
            slopeThreshold: 1.5,          // Lowered from 2.0
            surfaceQualityThreshold: 0.2,  // Lowered from 0.25
            restOpportunitiesThreshold: 0.25 // Increased from 0.2
        },
        diabetes: {
            emergencyAccessibilityThreshold: 6.5, // Lowered from 7.0
            restOpportunitiesThreshold: 0.15     // Increased from 0.1
        }
    };
    
    // Adjust multipliers based on condition - DRAMATICALLY INCREASED MULTIPLIERS
    if (currentPatientCondition.isPatientMode && currentPatientCondition.name !== "default") {
        switch(currentPatientCondition.name) {
            case "respiratory":
                envWeightMultiplier = 5.0;    // Increased from 3.5
                poiWeightMultiplier = 2.0;    // Increased from 1.5
                slopeWeightMultiplier = 3.0;  // Increased from 2.5
                noiseWeightMultiplier = 2.0;  // Increased from 1.2
                break;
            case "cardiac":
                envWeightMultiplier = 4.0;    // Increased from 2.5
                poiWeightMultiplier = 1.5;    // Increased from 1.2
                slopeWeightMultiplier = 5.0;  // Increased from 3.0
                noiseWeightMultiplier = 2.0;  // Increased from 1.5
                break;
            case "arthritis":
                envWeightMultiplier = 3.0;    // Increased from 2.0
                poiWeightMultiplier = 1.5;    // Increased from 1.0
                slopeWeightMultiplier = 5.0;  // Increased from 3.5
                noiseWeightMultiplier = 1.5;  // Increased from 1.0
                break;
            case "mental":
                envWeightMultiplier = 3.0;    // Increased from 2.0
                poiWeightMultiplier = 2.5;    // Increased from 2.0
                slopeWeightMultiplier = 1.5;  // Increased from 1.0
                noiseWeightMultiplier = 5.0;  // Increased from 3.5
                break;
            case "mobility":
                envWeightMultiplier = 2.5;    // Increased from 1.8
                poiWeightMultiplier = 1.5;    // Increased from 1.2
                slopeWeightMultiplier = 6.0;  // Increased from 4.0
                noiseWeightMultiplier = 1.2;  // Increased from 0.8
                break;
            case "diabetes":
                envWeightMultiplier = 3.0;    // Increased from 2.2
                poiWeightMultiplier = 2.0;    // Increased from 1.5
                slopeWeightMultiplier = 2.5;  // Increased from 1.8
                noiseWeightMultiplier = 1.5;  // Increased from 1.2
                break;
            default:
                // Default multipliers
                slopeWeightMultiplier = 2.0;  // Increased from 1.5
                noiseWeightMultiplier = 2.0;  // Increased from 1.5
        }
    }

    // Calculate basic POI scores - INCREASED POI IMPACT
    if (currentPatientCondition.isPatientMode && currentPatientCondition.name !== "default") {
        // Apply a higher multiplier to give more influence to specialized POIs
        const specializedPOIMultiplier = 1.5; // Increased from implicit 1.0
        
        poiScore += (poiCounts.natureCount || 0) * currentPatientCondition.patientNature * poiWeightMultiplier;
        poiScore += (poiCounts.entertainmentCount || 0) * currentPatientCondition.patientEntertainment * poiWeightMultiplier;
        poiScore += (poiCounts.nightlifeCount || 0) * currentPatientCondition.patientNightlife * poiWeightMultiplier;
        poiScore += (poiCounts.tourismCount || 0) * currentPatientCondition.patientTourism * poiWeightMultiplier;
        poiScore += (poiCounts.hospitalCount || 0) * currentPatientCondition.patientHospital * poiWeightMultiplier;
        
        // Calculate specialized POI scores based on patient condition
        if (poiCounts.parkBenchCount !== undefined) {
            specializedPoiScore = calculateSpecializedPoiScore(poiCounts, currentPatientCondition);
            poiScore += specializedPoiScore * specializedPOIMultiplier; // Apply the multiplier
        }
    } else {
        console.log(`Scoring route using standard preferences`);
        
        poiScore += (poiCounts.natureCount || 0) * currentPreferences.nature;
        poiScore += (poiCounts.entertainmentCount || 0) * currentPreferences.entertainment;
        poiScore += (poiCounts.nightlifeCount || 0) * currentPreferences.nightlife;
        poiScore += (poiCounts.tourismCount || 0) * currentPreferences.tourism;
        poiScore += (poiCounts.hospitalCount || 0) * currentPreferences.hospital;
    }
    
    // Add POI score to total
    score += poiScore;

    // Calculate environmental scores for each point on the route
    let criticalPenalty = 0;
    let worstPoint = null;
    
    // Add route diversity enforcement
    // This creates a preference divergence factor to ensure routes are meaningfully different
    let diversityBonus = 0;
    let pathTypeSignature = "";
    
    // Apply the paper's approach: Calculate Health Impact Functions for each route segment
    // This treats the route as a series of segments with different health impacts

    for (const eachRouteData of routeData) {
        if (currentPatientCondition.isPatientMode && currentPatientCondition.name !== "default" && 
            eachRouteData && eachRouteData.environmentData) {
            
            // Implementation of paper's concept: Health Impact Functions
            // Apply condition-specific health impact scoring
            let pointPenalty = 0;
            let pointSignature = ""; // Used to create a "signature" of this route type
            const condName = currentPatientCondition.name;
            const weights = healthImpactWeights[condName] || {};
            
            // Get environmental data
            const envData = eachRouteData.environmentData;
            
            // Common factors with health impacts
            if (weights.airQuality && envData.airQuality) {
                // Air quality has non-linear impact - exponential penalty for poor air
                const airQualityImpact = Math.pow(Math.max(0, envData.airQuality - 4), 1.8) * weights.airQuality; // Increased exponent
                pointPenalty += airQualityImpact;
                
                // Add signature component - what kind of air quality segment is this?
                if (envData.airQuality < 4) pointSignature += "A"; // Good air
                else if (envData.airQuality < 6) pointSignature += "a"; // Moderate air
                else pointSignature += "x"; // Poor air
            }
            
            if (weights.slope && envData.slope) {
                // Slope has major impact on many conditions - higher penalty for steeper slopes
                const slopeImpact = Math.pow(Math.abs(envData.slope), 2) * weights.slope / 8; // Increased exponent
                pointPenalty += slopeImpact;
                
                // Add signature component - what kind of slope segment is this?
                if (Math.abs(envData.slope) < 2) pointSignature += "F"; // Flat
                else if (Math.abs(envData.slope) < 5) pointSignature += "S"; // Some slope
                else pointSignature += "H"; // Hilly
            }
            
            if (weights.noise && envData.noise) {
                // Noise impact varies by condition
                const noiseImpact = Math.pow(Math.max(0, envData.noise - 3), 1.3) * weights.noise; // Increased exponent, lowered threshold
                pointPenalty += noiseImpact;
                
                // Add signature component - what kind of noise environment is this?
                if (envData.noise < 4) pointSignature += "Q"; // Quiet
                else if (envData.noise < 7) pointSignature += "N"; // Normal noise
                else pointSignature += "L"; // Loud
            }
            
            if (weights.temperature && envData.temperature) {
                // Temperature extremes have health impacts
                const tempDiff = Math.abs(envData.temperature - 22); // Deviation from comfortable 22°C
                const temperatureImpact = Math.pow(tempDiff, 1.4) * weights.temperature / 8; // Increased exponent
                pointPenalty += temperatureImpact;
            }
            
            if (weights.humidity && envData.humidity) {
                // Humidity extremes impact some conditions
                const humidityDiff = Math.abs(envData.humidity - 50); // Deviation from moderate 50%
                const humidityImpact = Math.pow(humidityDiff, 1.2) * weights.humidity / 40; // Increased exponent
                pointPenalty += humidityImpact;
            }
            
            // Apply condition-specific factors
            if (condName === "respiratory") {
                // Apply the paper's approach for respiratory patients
                // Calculate the "pollutant exposure risk" for the segment
                if (weights.trafficExposure && envData.trafficDensity) {
                    const trafficExposure = Math.pow(envData.trafficDensity, 1.5) * weights.trafficExposure * 3; // Increased exponent
                    pointPenalty += trafficExposure;
                    
                    // Add signature component
                    if (envData.trafficDensity < 0.3) pointSignature += "t"; // Low traffic
                    else if (envData.trafficDensity < 0.6) pointSignature += "T"; // Moderate traffic
                    else pointSignature += "X"; // High traffic
                }
                
                // Green spaces provide benefits - negative penalty (i.e., bonus)
                if (envData.greenVisibility && weights.greenSpace) {
                    pointPenalty += envData.greenVisibility * weights.greenSpace;
                    
                    // Add signature component
                    if (envData.greenVisibility > 0.5) pointSignature += "G"; // Green area
                    else pointSignature += "-";
                }
                
                // The paper notes that specific weather conditions increase asthma risk
                if (envData.weather && (envData.weather.includes("Fog") || envData.weather.includes("Mist"))) {
                    pointPenalty += 20; // Increased from 15 - Special case for fog/mist which traps pollutants
                }
            } 
            else if (condName === "cardiac") {
                // Emergency access is critical for cardiac patients - penalty for poor access
                if (weights.emergencyDistance && envData.emergencyAccessibility) {
                    pointPenalty += Math.pow(Math.max(0, envData.emergencyAccessibility - 5), 1.5) * weights.emergencyDistance / 3; // New exponential penalty
                    
                    // Add signature component
                    if (envData.emergencyAccessibility < 5) pointSignature += "E"; // Good emergency access
                    else if (envData.emergencyAccessibility < 9) pointSignature += "e"; // Some emergency access
                    else pointSignature += "x"; // Poor emergency access
                }
                
                // Rest opportunities reduce cardiac stress
                if (weights.restAccess && envData.restOpportunities) {
                    // This is a negative weight (benefit)
                    pointPenalty += (1 - envData.restOpportunities) * Math.abs(weights.restAccess) * 1.3; // Increased factor
                    
                    // Add signature component
                    if (envData.restOpportunities > 0.4) pointSignature += "R"; // Many rest opportunities
                    else pointSignature += "-";
                }
                
                // Medical access is critical
                if (weights.medicalAccess && envData.emergencyAccessibility) {
                    // This is a negative weight (benefit)
                    const accessScore = 10 - Math.min(10, envData.emergencyAccessibility);
                    pointPenalty += (accessScore / 10) * weights.medicalAccess * 1.2; // Increased factor
                }
            }
            else if (condName === "mobility") {
                // Implement paper's concept of "physical barrier impact"
                // Surface quality is critical
                if (weights.surfaceQuality && envData.surfaceQuality) {
                    pointPenalty += Math.pow(envData.surfaceQuality, 1.4) * weights.surfaceQuality * 12; // Increased exponent and factor
                    
                    // Add signature component
                    if (envData.surfaceQuality < 0.3) pointSignature += "P"; // Paved/good surface
                    else pointSignature += "U"; // Unpaved/poor surface
                }
                
                // Street width impacts mobility
                if (weights.streetWidth && envData.streetWidth) {
                    const narrowPathPenalty = Math.pow(Math.max(0, 3 - envData.streetWidth), 1.5) * weights.streetWidth; // New exponential penalty
                    pointPenalty += narrowPathPenalty;
                    
                    // Add signature component
                    if (envData.streetWidth > 2.5) pointSignature += "W"; // Wide path
                    else pointSignature += "n"; // Narrow path
                }
                
                // Accessibility features provide benefits
                if (weights.accessibleFeatures && envData.accessibilityFeatures) {
                    // This is a negative weight (benefit)
                    pointPenalty += (1 - envData.accessibilityFeatures) * Math.abs(weights.accessibleFeatures) * 2.5; // Increased factor
                    
                    // Add signature component
                    if (envData.accessibilityFeatures > 0.4) pointSignature += "A"; // Accessible
                    else pointSignature += "-";
                }
            }
            else if (condName === "mental") {
                // Implement paper's concept of "sensory load impact"
                // Sensory load has major impact
                if (weights.sensoryLoad && envData.sensoryLoad) {
                    pointPenalty += Math.pow(Math.max(0, envData.sensoryLoad - 4), 1.4) * weights.sensoryLoad; // Increased exponent, lowered threshold
                    
                    // Add signature component
                    if (envData.sensoryLoad < 5) pointSignature += "C"; // Calm
                    else pointSignature += "B"; // Busy/stimulating
                }
                
                // Green spaces provide significant benefits
                if (weights.greenSpace && envData.greenVisibility) {
                    // This is a negative weight (benefit)
                    pointPenalty += (1 - envData.greenVisibility) * Math.abs(weights.greenSpace) * 2.5; // Increased factor
                    
                    // Add signature component
                    if (envData.greenVisibility > 0.4) pointSignature += "G"; // Green
                    else pointSignature += "-";
                }
                
                // Natural elements are beneficial (separate from just green space)
                if (weights.naturalElements) {
                    const naturalScore = (envData.greenVisibility || 0.3) * (1 - (envData.trafficDensity || 0.5));
                    pointPenalty += (1 - naturalScore) * Math.abs(weights.naturalElements) * 2;
                    
                    // Add signature component
                    if (naturalScore > 0.4) pointSignature += "N"; // Natural
                    else pointSignature += "-";
                }
                
                // Crowding impacts mental health
                if (weights.crowding && envData.trafficDensity) {
                    // Using traffic density as a proxy for crowding
                    pointPenalty += Math.pow(envData.trafficDensity, 1.3) * weights.crowding * 12; // Increased exponent and factor
                }
            }
            else if (condName === "arthritis") {
                // Implement paper's concept of "joint stress impact"
                // Surface quality is important
                if (weights.surfaceQuality && envData.surfaceQuality) {
                    pointPenalty += Math.pow(envData.surfaceQuality, 1.5) * weights.surfaceQuality * 10; // Increased exponent and factor
                    
                    // Add signature component
                    if (envData.surfaceQuality < 0.3) pointSignature += "S"; // Smooth
                    else pointSignature += "R"; // Rough
                }
                
                // Joint stress factors (combination of surface and slope)
                if (weights.jointStressFactors) {
                    const surfaceStress = envData.surfaceQuality || 0.5;
                    const slopeStress = Math.min(1, Math.abs(envData.slope || 0) / 10);
                    const jointStress = (surfaceStress + slopeStress) / 2;
                    
                    pointPenalty += Math.pow(jointStress, 1.5) * weights.jointStressFactors * 8;
                    
                    // Add signature component
                    if (jointStress < 0.3) pointSignature += "E"; // Easy on joints
                    else pointSignature += "H"; // Hard on joints
                }
                
                // Temperature affects joints, especially cold
                if (weights.temperature && envData.temperature) {
                    const coldPenalty = Math.pow(Math.max(0, 18 - envData.temperature), 1.3) * weights.temperature / 4; // Increased exponent
                    pointPenalty += coldPenalty;
                }
                
                // Rest opportunities are important
                if (weights.restAccess && envData.restOpportunities) {
                    // This is a negative weight (benefit)
                    pointPenalty += (1 - envData.restOpportunities) * Math.abs(weights.restAccess) * 2.5; // Increased factor
                    
                    // Add signature component
                    if (envData.restOpportunities > 0.3) pointSignature += "R"; // Rest available
                    else pointSignature += "-";
                }
            }
            else if (condName === "diabetes") {
                // Implement paper's concept of "health management needs"
                // Access to services is important
                if (weights.medicalAccess && envData.emergencyAccessibility) {
                    // This is a negative weight (benefit)
                    const accessScore = 10 - Math.min(10, envData.emergencyAccessibility);
                    pointPenalty += (accessScore / 10) * weights.medicalAccess * 1.5; // Increased factor
                    
                    // Add signature component
                    if (accessScore > 5) pointSignature += "M"; // Medical access
                    else pointSignature += "-";
                }
                
                // Service proximity (general services, not just medical)
                if (weights.serviceProximity) {
                    const serviceScore = 10 - Math.min(10, envData.emergencyAccessibility || 5);
                    pointPenalty += (serviceScore / 10) * weights.serviceProximity * 1.5;
                    
                    // Add signature component
                    if (serviceScore > 6) pointSignature += "S"; // Services nearby
                    else pointSignature += "-";
                }
                
                // Food access is important for blood sugar management
                if (weights.foodAccess) {
                    // Use POI data or estimate from environment
                    const foodAccessScore = envData.foodAccess || (1 - (envData.trafficDensity || 0.5));
                    pointPenalty += (1 - foodAccessScore) * Math.abs(weights.foodAccess) * 2.5; // Increased factor
                }
                
                // Moderate exertion is beneficial
                if (weights.moderate_exertion && envData.slope) {
                    // This is a negative weight (benefit)
                    // Small slopes are beneficial, steep slopes are not
                    const moderateSlopeScore = Math.min(1, Math.abs(envData.slope) / 3) * 
                                             Math.max(0, 1 - Math.abs(envData.slope - 2) / 2);
                    pointPenalty += (1 - moderateSlopeScore) * Math.abs(weights.moderate_exertion) * 2.5; // Increased factor
                    
                    // Add signature component
                    if (moderateSlopeScore > 0.5) pointSignature += "E"; // Good exercise
                    else pointSignature += "-";
                }
                
                // Extreme conditions are problematic
                if (weights.extreme_conditions && envData.temperature) {
                    const tempExtreme = Math.pow(Math.max(0, Math.abs(envData.temperature - 22) - 5), 1.3) * weights.extreme_conditions / 4; // Increased exponent
                    pointPenalty += tempExtreme;
                }
            }
            
            // Add to the route type signature
            pathTypeSignature += pointSignature;
            
            // Track the worst point to use as an avoid waypoint
            if (pointPenalty > criticalPenalty) {
                criticalPenalty = pointPenalty;
                worstPoint = {
                    lat: eachRouteData.lat,
                    lon: eachRouteData.lon,
                    penalty: pointPenalty
                };
            }
                
            // Calculate standard environmental score
            const routeEnvScore = await calculateEnvironmental(
                eachRouteData.environmentData, 
                currentPatientCondition,
                slopeWeightMultiplier,
                noiseWeightMultiplier
            );
            
            // Apply penalties to the environmental score
            envScore += routeEnvScore - pointPenalty;
        }
    }
    
    // Calculate diversity bonus based on path signature
    // This rewards routes that have distinct characteristics
    if (pathTypeSignature.length > 0) {
        // Calculate route uniqueness metrics
        const uniqueChars = new Set(pathTypeSignature.split('')).size;
        const pathLength = pathTypeSignature.length;
        
        // Routes with greater variety of segment types get bonus
        diversityBonus = (uniqueChars / pathLength) * 50;
        
        // Add condition-specific pattern bonuses
        switch(currentPatientCondition.name) {
            case "respiratory":
                // Count good air segments
                const goodAirSegments = (pathTypeSignature.match(/A/g) || []).length;
                const greenSegments = (pathTypeSignature.match(/G/g) || []).length;
                diversityBonus += (goodAirSegments + greenSegments) * 5;
                break;
                
            case "cardiac":
                // Count flat segments and emergency access
                const flatSegments = (pathTypeSignature.match(/F/g) || []).length;
                const emergencySegments = (pathTypeSignature.match(/E/g) || []).length;
                diversityBonus += (flatSegments + emergencySegments) * 5;
                break;
                
            case "mobility":
                // Count wide and accessible segments
                const wideSegments = (pathTypeSignature.match(/W/g) || []).length;
                const accessibleSegments = (pathTypeSignature.match(/A/g) || []).length;
                const pavedSegments = (pathTypeSignature.match(/P/g) || []).length;
                diversityBonus += (wideSegments + accessibleSegments + pavedSegments) * 5;
                break;
                
            case "mental":
                // Count quiet, calm, and natural segments
                const quietSegments = (pathTypeSignature.match(/Q/g) || []).length;
                const calmSegments = (pathTypeSignature.match(/C/g) || []).length;
                const naturalSegments = (pathTypeSignature.match(/[GN]/g) || []).length;
                diversityBonus += (quietSegments + calmSegments + naturalSegments) * 5;
                break;
                
            case "arthritis":
                // Count smooth, easy, and rest segments
                const smoothSegments = (pathTypeSignature.match(/S/g) || []).length;
                const easySegments = (pathTypeSignature.match(/E/g) || []).length;
                const restSegments = (pathTypeSignature.match(/R/g) || []).length;
                diversityBonus += (smoothSegments + easySegments + restSegments) * 5;
                break;
                
            case "diabetes":
                // Count service, medical, and exercise segments
                const serviceSegments = (pathTypeSignature.match(/S/g) || []).length;
                const medicalSegments = (pathTypeSignature.match(/M/g) || []).length;
                const exerciseSegments = (pathTypeSignature.match(/E/g) || []).length;
                diversityBonus += (serviceSegments + medicalSegments + exerciseSegments) * 5;
                break;
        }
    }
    
    // Add the diversity bonus to the score
    score += diversityBonus;
    
    // Apply critical penalty to total score to force route differentiation
    score += envScore * envWeightMultiplier;
    
    // Provide the worst point as an avoid waypoint for future routes
    // LOWERED THRESHOLD from 25 to 20 for even easier detection of bad points
    if (worstPoint && worstPoint.penalty > 20) {
        avoidWaypoint = {
            lat: worstPoint.lat,
            lon: worstPoint.lon
        };
    }

    return {
        score: score,
        environmentScore: envScore,
        poiScore: poiScore,
        specializedPoiScore: specializedPoiScore,
        avoidWaypoint: avoidWaypoint,
        pathSignature: pathTypeSignature, // Add the signature for debugging
        diversityBonus: diversityBonus    // Add the bonus for debugging
    };
}

function calculateSpecializedPoiScore(poiCounts, currentPatientCondition) {
    let specializedScore = 0;
    
    switch(currentPatientCondition.name) {
        case "respiratory":
            // Respiratory patients benefit from resting areas, park benches, and health services
            specializedScore += (poiCounts.parkBenchCount || 0) * 1.5;
            specializedScore += (poiCounts.restingAreaCount || 0) * 2.0;
            specializedScore += (poiCounts.healthServiceCount || 0) * 2.0;
            specializedScore += (poiCounts.quietAreaCount || 0) * 1.2;
            break;
            
        case "cardiac":
            // Cardiac patients benefit from resting areas, health services, flat pathways
            specializedScore += (poiCounts.restingAreaCount || 0) * 2.5;
            specializedScore += (poiCounts.parkBenchCount || 0) * 2.0;
            specializedScore += (poiCounts.healthServiceCount || 0) * 3.0;
            specializedScore += (poiCounts.pharmacyCount || 0) * 2.0;
            specializedScore += (poiCounts.flatPathwayCount || 0) * 1.5;
            specializedScore += (poiCounts.waterFountainCount || 0) * 1.0;
            break;
            
        case "arthritis":
            // Arthritis patients benefit from flat pathways, resting areas, benches
            specializedScore += (poiCounts.flatPathwayCount || 0) * 3.0;
            specializedScore += (poiCounts.parkBenchCount || 0) * 2.5;
            specializedScore += (poiCounts.restingAreaCount || 0) * 2.0;
            specializedScore += (poiCounts.cafeCount || 0) * 1.0;
            specializedScore += (poiCounts.publicToiletCount || 0) * 1.5;
            break;
            
        case "mental":
            // Mental health patients benefit from quiet areas, natural surroundings
            specializedScore += (poiCounts.quietAreaCount || 0) * 3.0;
            specializedScore += (poiCounts.cafeCount || 0) * 1.5;
            specializedScore += (poiCounts.parkBenchCount || 0) * 1.0;
            break;
            
        case "mobility":
            // Mobility impaired patients greatly benefit from wheelchair accessible places, flat pathways
            specializedScore += (poiCounts.wheelchairAccessCount || 0) * 4.0;
            specializedScore += (poiCounts.flatPathwayCount || 0) * 3.5;
            specializedScore += (poiCounts.publicToiletCount || 0) * 2.5;
            specializedScore += (poiCounts.restingAreaCount || 0) * 2.0;
            specializedScore += (poiCounts.parkBenchCount || 0) * 1.5;
            break;
            
        case "diabetes":
            // Diabetes patients benefit from access to water, food, and health services
            specializedScore += (poiCounts.waterFountainCount || 0) * 2.0;
            specializedScore += (poiCounts.cafeCount || 0) * 1.5;
            specializedScore += (poiCounts.pharmacyCount || 0) * 2.5;
            specializedScore += (poiCounts.healthServiceCount || 0) * 2.0;
            specializedScore += (poiCounts.parkBenchCount || 0) * 1.0;
            break;
            
        default:
            // Default - no specialized scoring
            break;
    }
    
    return specializedScore;
}

async function calculateEnvironmental(
    envData, 
    currentPatientCondition, 
    slopeWeightMultiplier = 1.0,
    noiseWeightMultiplier = 1.0
) {
    if (!envData) return 0;
    
    var score = 0;
    const temp = envData.temperature || 22;
    const humidity = envData.humidity || 50;
    const airQuality = envData.airQuality || 3;
    const weather = envData.weather || "Clear";
    const slope = envData.slope || 0;
    const noise = envData.noise || 3;

    switch(currentPatientCondition.name) {
        case "respiratory":
            score -= (airQuality - 1) * currentPatientCondition.airQualitySensitivity; 
            
            if (temp < 10 || temp > 30) {
                score -= currentPatientCondition.temperatureSensitivity * 0.5;
            }
            
            if (humidity > 70) {
                score -= currentPatientCondition.humiditySensitivity * 0.5;
            }
            
            if (weather.includes("Rain") || weather.includes("Snow") || weather.includes("Fog")) {
                score -= 5;
            }
            
            // Steep slopes are challenging for respiratory patients
            if (Math.abs(slope) > 5) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.25 * slopeWeightMultiplier;
            } else if (Math.abs(slope) > 2) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.15 * slopeWeightMultiplier;
            }
            
            // High noise areas can cause stress
            if (noise > 5) {
                score -= currentPatientCondition.noiseSensitivity * (noise - 5) * 0.5 * noiseWeightMultiplier;
            } else if (noise > 3) {
                score -= currentPatientCondition.noiseSensitivity * (noise - 3) * 0.3 * noiseWeightMultiplier;
            }
            break;
            
        case "cardiac":
            if (temp < 5) {
                score -= currentPatientCondition.temperatureSensitivity * 0.8; 
            } else if (temp > 30) {
                score -= currentPatientCondition.temperatureSensitivity * 0.6; 
            }
            
            score -= (airQuality - 1) * currentPatientCondition.airQualitySensitivity * 0.7;
            
            if (humidity > 80) {
                score -= currentPatientCondition.humiditySensitivity * 0.6;
            }
            
            // Slopes are very important for cardiac patients
            if (Math.abs(slope) > 3) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.3 * slopeWeightMultiplier;
            } else if (Math.abs(slope) > 1.5) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.15 * slopeWeightMultiplier;
            }
            
            // High noise areas can increase heart rate and stress
            if (noise > 4) {
                score -= currentPatientCondition.noiseSensitivity * (noise - 4) * 0.6 * noiseWeightMultiplier;
            }
            break;
            
        case "arthritis":
            if (temp < 15) {
                score -= currentPatientCondition.temperatureSensitivity * 0.9;
            }
            
            if (humidity > 60) {
                score -= currentPatientCondition.humiditySensitivity * 0.9; 
            }
            
            if (weather.includes("Rain")) {
                score -= 8;
            }
            
            // Slopes are very problematic for arthritis patients
            if (Math.abs(slope) > 2) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.35 * slopeWeightMultiplier;
            } else if (Math.abs(slope) > 1) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.2 * slopeWeightMultiplier;
            }
            
            // Noise is less important for arthritis
            if (noise > 7) {
                score -= currentPatientCondition.noiseSensitivity * (noise - 7) * 0.35 * noiseWeightMultiplier;
            }
            break;
            
        case "mental":
            if (weather.includes("Clear") || weather.includes("Sun")) {
                score += 5;
            }
            
            if (weather.includes("Rain") || weather.includes("Fog") || weather.includes("Cloud")) {
                score -= 4;
            }
            
            if (temp < 10 || temp > 30) {
                score -= currentPatientCondition.temperatureSensitivity * 0.3;
            }
            
            // Slopes aren't as significant for mental health
            if (Math.abs(slope) > 7) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.2 * slopeWeightMultiplier;
            }
            
            // Noise is very important for mental health patients
            if (noise > 3) {
                score -= currentPatientCondition.noiseSensitivity * (noise - 3) * 0.7 * noiseWeightMultiplier;
            } else {
                // Calm environments are beneficial
                score += (3 - noise) * 2.0 * noiseWeightMultiplier;
            }
            break;
            
        case "mobility":
            if (weather.includes("Rain") || weather.includes("Snow") || weather.includes("Ice")) {
                score -= 10; 
            }
            
            if (temp < 10) {
                score -= currentPatientCondition.temperatureSensitivity * 0.7;
            }
            
            // Slopes are critical for mobility-impaired patients
            if (Math.abs(slope) > 1.5) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.5 * slopeWeightMultiplier;
            } else if (Math.abs(slope) > 0.8) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.25 * slopeWeightMultiplier;
            }
            
            // Noise is less important for mobility
            if (noise > 8) {
                score -= currentPatientCondition.noiseSensitivity * (noise - 8) * 0.3 * noiseWeightMultiplier;
            }
            break;
            
        case "diabetes":
            if (temp > 30) {
                score -= currentPatientCondition.temperatureSensitivity * 0.8;
            }
            
            if (humidity > 70) {
                score -= currentPatientCondition.humiditySensitivity * 0.5;
            }
            
            score -= (airQuality - 1) * currentPatientCondition.airQualitySensitivity * 0.4;
            
            // Moderate slopes are challenging for some diabetic patients
            if (Math.abs(slope) > 4) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.25 * slopeWeightMultiplier;
            } else if (Math.abs(slope) > 2) {
                score -= currentPatientCondition.slopeSensitivity * Math.abs(slope) * 0.15 * slopeWeightMultiplier;
            }
            
            // Noise is moderately important
            if (noise > 6) {
                score -= currentPatientCondition.noiseSensitivity * (noise - 6) * 0.45 * noiseWeightMultiplier;
            }
            break;
            
        default:
            if (weather.includes("Rain") || weather.includes("Snow")) {
                score -= 2;
            }

            if (temp < 5 || temp > 35) {
                score -= 2;
            }
            
            // Default slope penalty
            if (Math.abs(slope) > 5) {
                score -= Math.abs(slope) * 0.2 * slopeWeightMultiplier;
            } else if (Math.abs(slope) > 2) {
                score -= Math.abs(slope) * 0.1 * slopeWeightMultiplier;
            }
            
            // Default noise penalty
            if (noise > 7) {
                score -= (noise - 7) * 0.8 * noiseWeightMultiplier;
            } else if (noise > 5) {
                score -= (noise - 5) * 0.4 * noiseWeightMultiplier;
            }
    }
    
    return score;
}

/**
 * Extract and display the environmental values used in scoring
 * @param {Object} route - Route object with environmental data
 * @param {Array} environmentData - Environmental data points
 * @param {Object} preferences - User preferences
 * @param {Object} patientCondition - Patient condition
 * @returns {Object} Extracted score data
 */
export function extractScoreData(route, environmentData, preferences, patientCondition) {
    console.log(`[extractScoreData] Called for route: ${route.name || 'Unnamed route'}. Patient condition received: ${patientCondition ? patientCondition.name : 'undefined'}`);
    
    // Use envStats from the route object if available and seems valid, otherwise calculate it.
    // envStats on the route object is populated by calculateAllScores.
    const dataForStats = environmentData || route.environmentDataList || [];
    const envStats = (route.envStats && Object.keys(route.envStats).length > 0 && route.envStats.totalPoints === dataForStats.length) ? 
                   route.envStats : 
                   calculateEnvironmentalStats(dataForStats.map(p => p.environmentData || p)); // Ensure we pass the core data objects
    
    // Quick visibility log for AQI and Slope averages so analysts can
    // confirm non-zero values immediately in the browser console.
    const aqAvgLog    = (typeof envStats.airQuality?.avg === 'number') ? envStats.airQuality.avg.toFixed(3) : envStats.airQuality.avg;
    const slopeAvgLog = (typeof envStats.slope?.avg === 'number') ? envStats.slope.avg.toFixed(3) : envStats.slope.avg;
    console.log(`[extractScoreData] Avgs — airQuality.avg: ${aqAvgLog}, slope.avg: ${slopeAvgLog}`);
    
    // Resolve the definitive preferences and patientCondition to be used for display
    const currentPrefs = preferences || window.currentPreferences || PatientConditions.DEFAULT_PREFERENCES; // Fallback for preferences
    const currentPatientCond = patientCondition || window.currentPatientCondition || PatientConditions.DEFAULT;
    console.log("[extractScoreData] Using patientCondition for display:", JSON.stringify(currentPatientCond, null, 2));
    console.log("[extractScoreData] Using preferences for display:", JSON.stringify(currentPrefs, null, 2));

    const weights = calculateConditionWeights(currentPatientCond); 
    const weightedEnvScores = calculateWeightedScores(envStats, weights, currentPatientCond); 

    let argRealDataPoints = 0;
    let argTotalPoints = 0;
    const dataListForPercentage = environmentData || route.environmentDataList || [];

    if (dataListForPercentage.length > 0) {
        argTotalPoints = dataListForPercentage.length;
        argRealDataPoints = dataListForPercentage.filter(point => point.environmentData && point.environmentData.hasRealData === true).length;
    }
    const argRealDataPercentage = argTotalPoints > 0 ? (argRealDataPoints / argTotalPoints) * 100 : 0;

    // --- Final Scores - Directly from the enriched route object ---
    // These should have been set by calculateAllScores
    const finalEnvScore = route.environmentScore;
    const finalPoiScore = route.poiScore;
    const finalSpecializedPoiScore = route.specializedPoiScore === undefined ? 0.0 : route.specializedPoiScore; // Default to 0.0 if undefined
    const finalTotalScore = route.score;

    // ... within extractScoreData, before the final const scoreData = { ... }
    /*
     * ────────────────────────────────────────────────────────────────
     *  Diagnostic component scores
     *  --------------------------------------
     *  We recompute the *raw* (0-10) suitability for each factor and
     *  also expose the weight applied.  This helps compare two routes
     *  side-by-side and understand why, for example, the Direct route
     *  topped out at 10.0 while the optimised one settled at 9.8.
     *  Nothing here is used in the main algorithm; it is purely for
     *  transparency in extractScoreData.
     * ────────────────────────────────────────────────────────────────*/

    const diagnostic = { temperature:{}, airQuality:{}, slope:{}, noise:{} };

    // Helper to keep NaN/undefined out of JSON.stringify output
    function _numOrNA(v) { return (typeof v === 'number' && !Number.isNaN(v)) ? v.toFixed(2) : 'N/A'; }

    // Temperature
    if (typeof envStats.temperature.avg === 'number') {
        diagnostic.temperature.rawScore = _numOrNA(temperatureFactorScore(envStats.temperature.avg));
        diagnostic.temperature.weight   = _numOrNA(weights.temperature);
        diagnostic.temperature.weighted = _numOrNA(parseFloat(diagnostic.temperature.rawScore) * weights.temperature);
    }
    // Air-quality
    if (typeof envStats.airQuality.avg === 'number') {
        diagnostic.airQuality.rawScore = _numOrNA(airQualityFactorScore(envStats.airQuality.avg));
        diagnostic.airQuality.weight   = _numOrNA(weights.airQuality);
        diagnostic.airQuality.weighted = _numOrNA(parseFloat(diagnostic.airQuality.rawScore) * weights.airQuality);
    }
    // Slope (use the new slopeSuitability so it matches scoring code)
    if (typeof envStats.slope.avg === 'number') {
        const sens = currentPatientCond.slopeSensitivity || 5;
        diagnostic.slope.rawScore = _numOrNA(slopeSuitability(Math.abs(envStats.slope.avg), sens));
        diagnostic.slope.weight   = _numOrNA(weights.slope);
        diagnostic.slope.weighted = _numOrNA(parseFloat(diagnostic.slope.rawScore) * weights.slope);
    }
    // Noise
    if (typeof envStats.noise.avg === 'number') {
        diagnostic.noise.rawScore = _numOrNA(noiseFactorScore(envStats.noise.avg));
        diagnostic.noise.weight   = _numOrNA(weights.noise);
        diagnostic.noise.weighted = _numOrNA(parseFloat(diagnostic.noise.rawScore) * weights.noise);
    }

    const scoreData = {
        routeName: route.name || 'Unnamed route',
        routeLength: route.length && typeof route.length === 'number' ? (route.length / 1000).toFixed(2) + ' km' : 'N/A',
        
        temperature: {
            avg: typeof envStats.temperature.avg === 'number' ? envStats.temperature.avg.toFixed(1) + '°C' : envStats.temperature.avg, 
            min: typeof envStats.temperature.min === 'number' ? envStats.temperature.min.toFixed(1) + '°C' : envStats.temperature.min,
            max: typeof envStats.temperature.max === 'number' ? envStats.temperature.max.toFixed(1) + '°C' : envStats.temperature.max,
            weight: typeof weights.temperature === 'number' ? weights.temperature.toFixed(2) : 'N/A',
            weightedScore: typeof weightedEnvScores.temperature === 'number' ? weightedEnvScores.temperature.toFixed(2) : weightedEnvScores.temperature
        },
        airQuality: {
            avg: typeof envStats.airQuality.avg === 'number' ? envStats.airQuality.avg.toFixed(1) : envStats.airQuality.avg,
            min: typeof envStats.airQuality.min === 'number' ? envStats.airQuality.min.toFixed(1) : envStats.airQuality.min,
            max: typeof envStats.airQuality.max === 'number' ? envStats.airQuality.max.toFixed(1) : envStats.airQuality.max,
            weight: typeof weights.airQuality === 'number' ? weights.airQuality.toFixed(2) : 'N/A',
            weightedScore: typeof weightedEnvScores.airQuality === 'number' ? weightedEnvScores.airQuality.toFixed(2) : weightedEnvScores.airQuality
        },
        slope: {
            avg: typeof envStats.slope.avg === 'number' ? envStats.slope.avg.toFixed(2) + '%' : envStats.slope.avg,
            max: typeof envStats.slope.max === 'number' ? envStats.slope.max.toFixed(2) + '%' : envStats.slope.max, 
            weight: typeof weights.slope === 'number' ? weights.slope.toFixed(2) : 'N/A',
            weightedScore: typeof weightedEnvScores.slope === 'number' ? weightedEnvScores.slope.toFixed(2) : weightedEnvScores.slope
        },
        noise: {
            avg: typeof envStats.noise.avg === 'number' ? envStats.noise.avg.toFixed(1) : envStats.noise.avg,
            max: typeof envStats.noise.max === 'number' ? envStats.noise.max.toFixed(1) : envStats.noise.max, 
            weight: typeof weights.noise === 'number' ? weights.noise.toFixed(2) : 'N/A',
            weightedScore: typeof weightedEnvScores.noise === 'number' ? weightedEnvScores.noise.toFixed(2) : weightedEnvScores.noise
        },
        weather: envStats.weather.mostFrequent, 
        humidity: typeof envStats.humidity.avg === 'number' ? envStats.humidity.avg.toFixed(1) + '%' : envStats.humidity.avg,
        
        dataQuality: {
            realDataPercentageFromRouteObj: typeof route.realDataPercentage === 'number' ? route.realDataPercentage.toFixed(1) + '%' : 'N/A',
            realDataPercentageFromArgs: argRealDataPercentage.toFixed(1) + '%',
            statsRealDataPercentage: typeof envStats.realDataPercentage === 'number' ? envStats.realDataPercentage.toFixed(1) + '%' : "N/A",
            statsRealDataPointsCount: envStats.realDataPointsCount,
            statsTotalPoints: envStats.totalPoints
        },
        env_data_quality: typeof envStats.realDataPercentage === 'number' ? (envStats.realDataPointsCount / (envStats.totalPoints || 1)).toFixed(2) : "N/A",

        num_poi_nature: route.poiCounts?.natureCount || 0,
        num_poi_entertainment: route.poiCounts?.entertainmentCount || 0,
        num_poi_nightlife: route.poiCounts?.nightlifeCount || 0,
        num_poi_tourism: route.poiCounts?.tourismCount || 0,
        num_poi_hospital: route.poiCounts?.hospitalCount || 0,
        rest_areas: route.poiCounts?.restingAreaCount || 0,
        park_benches: route.poiCounts?.parkBenchCount || 0,
        pharmacies: route.poiCounts?.pharmacyCount || 0,
        wheelchair_access: route.poiCounts?.wheelchairAccessCount || 0,
        flat_pathways: route.poiCounts?.flatPathwayCount || 0,
        public_toilets: route.poiCounts?.publicToiletCount || 0,
        quiet_areas: route.poiCounts?.quietAreaCount || 0,
        water_fountains: route.poiCounts?.waterFountainCount || 0,
        cafes: route.poiCounts?.cafeCount || 0,

        patientConditionInfo: { 
            name: currentPatientCond.name || 'default',
            temperatureSensitivity: currentPatientCond.temperatureSensitivity || 0,
            humiditySensitivity: currentPatientCond.humiditySensitivity || 0,
            airQualitySensitivity: currentPatientCond.airQualitySensitivity || 0,
            slopeSensitivity: currentPatientCond.slopeSensitivity || 0,
            noiseSensitivity: currentPatientCond.noiseSensitivity || 0
        },
        temperature_sensitivity: currentPatientCond.temperatureSensitivity || 0,
        humidity_sensitivity: currentPatientCond.humiditySensitivity || 0,
        air_quality_sensitivity: currentPatientCond.airQualitySensitivity || 0,
        slope_sensitivity: currentPatientCond.slopeSensitivity || 0,
        noise_sensitivity: currentPatientCond.noiseSensitivity || 0,
        
        poi_nature_weight: currentPrefs.nature || 0,
        poi_entertainment_weight: currentPrefs.entertainment || 0,
        poi_nightlife_weight: currentPrefs.nightlife || 0,
        poi_tourism_weight: currentPrefs.tourism || 0,
        poi_hospital_weight: currentPrefs.hospital || 0,

        finalScores: {
            environmental: typeof finalEnvScore === 'number' ? finalEnvScore.toFixed(1) : finalEnvScore, // Use validated finalEnvScore
            poi: typeof finalPoiScore === 'number' ? finalPoiScore.toFixed(1) : finalPoiScore,
            total: typeof finalTotalScore === 'number' ? finalTotalScore.toFixed(1) : finalTotalScore,
            specializedPoiScore: typeof finalSpecializedPoiScore === 'number' ? finalSpecializedPoiScore.toFixed(1) : finalSpecializedPoiScore
        },
        total_score: typeof finalTotalScore === 'number' ? finalTotalScore.toFixed(1) : finalTotalScore,
        env_score: typeof finalEnvScore === 'number' ? finalEnvScore.toFixed(1) : finalEnvScore,
        poi_score: typeof finalPoiScore === 'number' ? finalPoiScore.toFixed(1) : finalPoiScore,
        specialized_poi_score: typeof finalSpecializedPoiScore === 'number' ? finalSpecializedPoiScore.toFixed(1) : finalSpecializedPoiScore,

        diagnostic_component_scores: diagnostic
    };
    
    console.log('[extractScoreData] Score data summary (Full Object):', JSON.stringify(scoreData, null, 2));
    
    if (!window.scoreDataLog) window.scoreDataLog = [];
    window.scoreDataLog.push(scoreData);
    
    return scoreData;
}

// Helper function to calculate environmental statistics
function calculateEnvironmentalStats(environmentData) {
    const stats = {
        temperature: { sum: 0, count: 0, realCount: 0, min: null, max: null, avg: "N/A" }, 
        airQuality: { sum: 0, count: 0, realCount: 0, min: null, max: null, avg: "N/A" },
        slope: { sum: 0, count: 0, realCount: 0, min: null, max: null, avg: "N/A" }, 
        noise: { sum: 0, count: 0, realCount: 0, min: null, max: null, avg: "N/A" },
        humidity: { sum: 0, count: 0, realCount: 0, min: null, max: null, avg: "N/A" }, 
        weather: { counts: {}, mostFrequent: "N/A", count: 0, realCount: 0 }, 
        realDataPointsCount: 0, 
        totalPoints: environmentData ? environmentData.length : 0,
        realDataPercentage: 0 
    };

    if (!environmentData || environmentData.length === 0) {
        console.warn("[calculateEnvironmentalStats] No environmentData provided or empty. Returning all N/A stats.");
        return stats; 
    }

    environmentData.forEach(point => {
        // Expecting point itself to be the object returned by getEnvironmentalData
        if (!point || typeof point.temperature === 'undefined') { // Check for a sentinel property like temperature
            console.warn("[calculateEnvironmentalStats] Skipping invalid or incomplete point object:", point);
            return; 
        }

        let pointContributedToRealDataCount = false;

        // Temperature
        if (point.temperature !== null && typeof point.temperature === 'number') {
            stats.temperature.sum += point.temperature;
            stats.temperature.count++;
            stats.temperature.min = stats.temperature.min === null ? point.temperature : Math.min(stats.temperature.min, point.temperature);
            stats.temperature.max = stats.temperature.max === null ? point.temperature : Math.max(stats.temperature.max, point.temperature);
            if (point.realDataFlags && point.realDataFlags.temperature) {
                stats.temperature.realCount++; 
                if(!pointContributedToRealDataCount) { stats.realDataPointsCount++; pointContributedToRealDataCount = true;}
            }
        } 

        // Air Quality
        if (point.airQuality !== null && typeof point.airQuality === 'number') {
            stats.airQuality.sum += point.airQuality;
            stats.airQuality.count++;
            stats.airQuality.min = stats.airQuality.min === null ? point.airQuality : Math.min(stats.airQuality.min, point.airQuality);
            stats.airQuality.max = stats.airQuality.max === null ? point.airQuality : Math.max(stats.airQuality.max, point.airQuality);
            if (point.realDataFlags && point.realDataFlags.airQuality) {
                stats.airQuality.realCount++; 
                if(!pointContributedToRealDataCount) { stats.realDataPointsCount++; pointContributedToRealDataCount = true;}
            }
        }

        // Slope
        if (point.slope !== null && typeof point.slope === 'number') {
            stats.slope.sum += point.slope;
            stats.slope.count++;
            stats.slope.min = stats.slope.min === null ? point.slope : Math.min(stats.slope.min, point.slope); 
            stats.slope.max = stats.slope.max === null ? point.slope : Math.max(stats.slope.max, point.slope);
            if (point.realDataFlags && point.realDataFlags.slope) {
                stats.slope.realCount++; 
                if(!pointContributedToRealDataCount) { stats.realDataPointsCount++; pointContributedToRealDataCount = true;}
            }
        }

        // Noise
        if (point.noise !== null && typeof point.noise === 'number') {
            stats.noise.sum += point.noise;
            stats.noise.count++;
            stats.noise.min = stats.noise.min === null ? point.noise : Math.min(stats.noise.min, point.noise);
            stats.noise.max = stats.noise.max === null ? point.noise : Math.max(stats.noise.max, point.noise);
            if (point.realDataFlags && point.realDataFlags.noise) {
                stats.noise.realCount++; 
                if(!pointContributedToRealDataCount) { stats.realDataPointsCount++; pointContributedToRealDataCount = true;}
            }
        }
        
        // Humidity
        if (point.humidity !== null && typeof point.humidity === 'number') {
            stats.humidity.sum += point.humidity;
            stats.humidity.count++;
            stats.humidity.min = stats.humidity.min === null ? point.humidity : Math.min(stats.humidity.min, point.humidity);
            stats.humidity.max = stats.humidity.max === null ? point.humidity : Math.max(stats.humidity.max, point.humidity);
            if (point.realDataFlags && point.realDataFlags.humidity) {
                stats.humidity.realCount++; 
                if(!pointContributedToRealDataCount) { stats.realDataPointsCount++; pointContributedToRealDataCount = true;}
            }
        }

        // Weather
        if (point.weather && typeof point.weather === 'string' && point.weather.length > 0) {
            stats.weather.counts[point.weather] = (stats.weather.counts[point.weather] || 0) + 1;
            stats.weather.count++;
            if (point.realDataFlags && point.realDataFlags.weather) {
                stats.weather.realCount++; 
                if(!pointContributedToRealDataCount) { stats.realDataPointsCount++; pointContributedToRealDataCount = true;}
            }
        }
    });

    // Calculate averages, defaulting to "N/A" if no valid data points
    if (stats.temperature.count > 0) stats.temperature.avg = stats.temperature.sum / stats.temperature.count; else stats.temperature.avg = "N/A";
    if (stats.airQuality.count > 0) stats.airQuality.avg = stats.airQuality.sum / stats.airQuality.count; else stats.airQuality.avg = "N/A";
    if (stats.slope.count > 0) stats.slope.avg = stats.slope.sum / stats.slope.count; else stats.slope.avg = "N/A";
    if (stats.noise.count > 0) stats.noise.avg = stats.noise.sum / stats.noise.count; else stats.noise.avg = "N/A";
    if (stats.humidity.count > 0) stats.humidity.avg = stats.humidity.sum / stats.humidity.count; else stats.humidity.avg = "N/A";

    if (stats.weather.count > 0) {
        let maxCount = 0;
        let mostFreqWeather = "N/A";
        for (const weatherCondition in stats.weather.counts) {
            if (stats.weather.counts[weatherCondition] > maxCount) {
                maxCount = stats.weather.counts[weatherCondition];
                mostFreqWeather = weatherCondition;
            }
        }
        stats.weather.mostFrequent = mostFreqWeather;
    } else {
        stats.weather.mostFrequent = "N/A";
    }
    
    // Ensure min/max remain null (or become N/A) if no data points were counted for that factor
    if (stats.temperature.count === 0) { stats.temperature.min = "N/A"; stats.temperature.max = "N/A"; }
    if (stats.airQuality.count === 0) { stats.airQuality.min = "N/A"; stats.airQuality.max = "N/A"; }
    if (stats.slope.count === 0) { stats.slope.min = "N/A"; stats.slope.max = "N/A"; }
    if (stats.noise.count === 0) { stats.noise.min = "N/A"; stats.noise.max = "N/A"; }
    if (stats.humidity.count === 0) { stats.humidity.min = "N/A"; stats.humidity.max = "N/A"; }

    stats.realDataPercentage = stats.totalPoints > 0 ? (stats.realDataPointsCount / stats.totalPoints) * 100 : 0;

    console.log("[calculateEnvironmentalStats] Calculated Stats:", JSON.stringify(stats, (k, v) => (v === Infinity || v === -Infinity || Number.isNaN(v)) ? "InvalidNumber" : v, 2));
    return stats;
}

function calculateWeightedScores(stats, weights, patientCondition) { 
    const scores = {
        temperature: "N/A", airQuality: "N/A", slope: "N/A", noise: "N/A",
        environmentalScore: "N/A", poiScore: "N/A", totalScore: "N/A"
    };
    let envComponentSum = 0, envWeightSum = 0, validNumericComponents = 0;

    if (typeof stats.temperature.avg === 'number') {
        const tempScoreRaw = temperatureFactorScore(stats.temperature.avg);
        scores.temperature = tempScoreRaw * (weights.temperature || 1.0); 
        envComponentSum += scores.temperature;
        envWeightSum += (weights.temperature || 1.0);
        validNumericComponents++;
    } 
    if (typeof stats.airQuality.avg === 'number') {
        const aqScoreRaw = airQualityFactorScore(stats.airQuality.avg);
        scores.airQuality = aqScoreRaw * (weights.airQuality || 1.0); 
        envComponentSum += scores.airQuality;
        envWeightSum += (weights.airQuality || 1.0);
        validNumericComponents++;
    } 
    if (typeof stats.slope.avg === 'number') {
        const sens = (patientCondition && typeof patientCondition.slopeSensitivity === 'number') ? patientCondition.slopeSensitivity : 5;
        const slopeScoreRaw = slopeSuitability(Math.abs(stats.slope.avg), sens);
        scores.slope = slopeScoreRaw * (weights.slope || 1.0); 
        envComponentSum += scores.slope;
        envWeightSum += (weights.slope || 1.0);
        validNumericComponents++;
    } 
    if (typeof stats.noise.avg === 'number') {
        const noiseScoreRaw = noiseFactorScore(stats.noise.avg);
        scores.noise = noiseScoreRaw * (weights.noise || 1.0); 
        envComponentSum += scores.noise;
        envWeightSum += (weights.noise || 1.0);
        validNumericComponents++;
    } 
    
    if (envWeightSum > 0 && validNumericComponents > 0) {
        scores.environmentalScore = envComponentSum / envWeightSum;
    } else {
        scores.environmentalScore = "N/A"; // Remains N/A if no valid components
    }
    
    scores.poiScore = "N/A"; // This will be set by calculateAllScores using calculateRawPOIScore
    scores.totalScore = "N/A"; // This will be set by calculateAllScores using calculateRawTotalScore
    
    console.log("[calculateWeightedScores] Weighted component scores (for display purposes):", JSON.stringify(scores, null, 2));
    return scores;
}

export async function calculateAllScores(poiCounts, environmentData, preferences, patientCondition) {
    try {
        console.log("[calculateAllScores] Input environmentData length: " + (environmentData ? environmentData.length : 0));
        const dataToUse = environmentData || [];
        console.log(`[calculateAllScores] Using ${dataToUse.length} data points for stats calculation.`);

        // unwrap objects of form {lat, lon, environmentData:{…}} so stats see the raw records
        const coreEnvList = dataToUse.map(pt => pt && pt.environmentData ? pt.environmentData : pt);

        const envStats = calculateEnvironmentalStats(coreEnvList);
        // Pass envStats to calculateRawEnvironmentalScore to avoid recalculating stats
        const rawEnvScore = await calculateRawEnvironmentalScore(coreEnvList, patientCondition, envStats);
        
        const rawPoiScore = calculateRawPOIScore(poiCounts, preferences, patientCondition);
        const specializedPoiScore = calculateSpecializedPOIScore(poiCounts, patientCondition);
        
        let totalScore;
        if (typeof rawEnvScore === 'number' && typeof rawPoiScore === 'number' && typeof specializedPoiScore ==='number') {
            totalScore = calculateRawTotalScore(rawEnvScore, rawPoiScore, specializedPoiScore, patientCondition);
        } else {
            console.warn("[calculateAllScores] One or more raw score components are N/A, total score will be N/A.");
            totalScore = "N/A"; 
        }
        
        const realDataPoints = dataToUse.filter(point => point.environmentData && point.environmentData.hasRealData === true).length;
        const realDataPercentage = dataToUse.length > 0 ? (realDataPoints / dataToUse.length) * 100 : 0;

        const scoreData = {
            environmentScore: rawEnvScore, 
            poiScore: rawPoiScore, 
            specializedPoiScore: specializedPoiScore, 
            score: totalScore, 
            realDataPercentage: realDataPercentage,
            realDataPointCount: realDataPoints,
            totalDataPointCount: dataToUse.length,
            envStats: envStats 
        };
        
        console.log(`[calculateAllScores] Final Calculated Scores: Total=${typeof scoreData.score === 'number' ? scoreData.score.toFixed(1) : scoreData.score}, Env=${typeof scoreData.environmentScore === 'number' ? scoreData.environmentScore.toFixed(1) : scoreData.environmentScore}, POI=${typeof scoreData.poiScore === 'number' ? scoreData.poiScore.toFixed(1) : scoreData.poiScore}, Specialized=${typeof scoreData.specializedPoiScore === 'number' ? scoreData.specializedPoiScore.toFixed(1) : scoreData.specializedPoiScore}, RealData=${scoreData.realDataPercentage.toFixed(1)}%`);
        
        return scoreData;
    } catch (error) {
        console.error("[calculateAllScores] Error calculating scores:", error);
        return {
            environmentScore: "N/A", poiScore: "N/A", specializedPoiScore: "N/A", score: "N/A",
            realDataPercentage: 0, realDataPointCount: 0, totalDataPointCount: (environmentData ? environmentData.length : 0),
            error: error.message, envStats: {}
        };
    }
}

async function calculateRawEnvironmentalScore(environmentData, patientCondition, envStats) {
    if (!envStats) { 
        console.warn("[calculateRawEnvironmentalScore] envStats not provided! Recalculating. This should be avoided.");
        envStats = calculateEnvironmentalStats(environmentData || []);
    }
    if (!environmentData || environmentData.length === 0 || 
        (envStats.temperature.count === 0 && envStats.airQuality.count === 0 && 
         envStats.slope.count === 0 && envStats.noise.count === 0 && envStats.humidity.count === 0)) {
        console.warn("[calculateRawEnvironmentalScore] No valid numeric data points in envStats to calculate a score. Returning N/A.");
        return "N/A";
    }

    let finalScore = 0;
    let weightSum = 0;
    const weights = calculateConditionWeights(patientCondition);

    if (typeof envStats.temperature.avg === 'number' && weights.temperature > 0) {
        const tempScoreRaw = temperatureFactorScore(envStats.temperature.avg);
        finalScore += tempScoreRaw * weights.temperature;
        weightSum += weights.temperature;
    }
    
    if (typeof envStats.airQuality.avg === 'number' && weights.airQuality > 0) {
        const aqScoreRaw = airQualityFactorScore(envStats.airQuality.avg);
        finalScore += aqScoreRaw * weights.airQuality;
        weightSum += weights.airQuality;
    }
    
    if (typeof envStats.slope.avg === 'number') {
        const sens = (patientCondition && typeof patientCondition.slopeSensitivity === 'number') ? patientCondition.slopeSensitivity : 5;
        const slopeScoreRaw = slopeSuitability(Math.abs(envStats.slope.avg), sens);
        finalScore += slopeScoreRaw * weights.slope;
        weightSum += weights.slope;
    }
    
    if (typeof envStats.noise.avg === 'number' && weights.noise > 0) {
        const noiseScoreRaw = noiseFactorScore(envStats.noise.avg);
        finalScore += noiseScoreRaw * weights.noise;
        weightSum += weights.noise;
    }
    if (typeof envStats.humidity.avg === 'number' && weights.humidity > 0) {
        const humidityScoreRaw = humidityFactorScore(envStats.humidity.avg);
        finalScore += humidityScoreRaw * weights.humidity;
        weightSum += weights.humidity;
    }
    
    if (weightSum === 0) { 
        console.warn("[calculateRawEnvironmentalScore] No valid numeric environmental factors had weights or data. Returning N/A.");
        return "N/A"; 
    }
    
    const environmentalScore = finalScore / weightSum;
    console.log(`[calculateRawEnvironmentalScore] Calculated raw environmental score: ${typeof environmentalScore === 'number' ? environmentalScore.toFixed(2) : environmentalScore}`);
    // Do NOT clamp to 0‒10 so we can see real deltas between Direct and Optimal
    return (typeof environmentalScore === 'number') ? environmentalScore : "N/A";
}

function calculateRawPOIScore(poiCounts, preferences, patientCondition) {
    if (!poiCounts) return "N/A";

    // Decide which weight set to use
    const useConditionWeights = patientCondition && patientCondition.isPatientMode && patientCondition.name !== "default";

    const weights = {
        nature: useConditionWeights ? (patientCondition.patientNature || 0) : (preferences ? preferences.nature : 0),
        entertainment: useConditionWeights ? (patientCondition.patientEntertainment || 0) : (preferences ? preferences.entertainment : 0),
        nightlife: useConditionWeights ? (patientCondition.patientNightlife || 0) : (preferences ? preferences.nightlife : 0),
        tourism: useConditionWeights ? (patientCondition.patientTourism || 0) : (preferences ? preferences.tourism : 0),
        hospital: useConditionWeights ? (patientCondition.patientHospital || 0) : (preferences ? preferences.hospital : 0)
    };

    let score = 0;
    let weightSum = 0;

    const categories = [
        { key: 'nature',   count: poiCounts.natureCount },
        { key: 'entertainment', count: poiCounts.entertainmentCount },
        { key: 'nightlife', count: poiCounts.nightlifeCount },
        { key: 'tourism',  count: poiCounts.tourismCount },
        { key: 'hospital', count: poiCounts.hospitalCount }
    ];

    let validPoiFactors = 0;

    categories.forEach(cat => {
        const w = weights[cat.key] || 0;
        const c = (typeof cat.count === 'number') ? cat.count : 0;
        if (w > 0 && c > 0) {
            score += c * w;
            weightSum += w;          // ONLY when count > 0 (fixes dilution)
            validPoiFactors++;
        }
    });

    if (weightSum === 0 || validPoiFactors === 0) {
        console.warn("[calculateRawPOIScore] No relevant POI data to compute score. Returning N/A.");
        return "N/A";
    }

    const poiScore = Math.min(10, (score / weightSum) * SCORING.poiScaleFactor);
    console.log(`[calculateRawPOIScore] Calculated raw POI score: ${typeof poiScore === 'number' ? poiScore.toFixed(2) : poiScore} (Condition mode: ${useConditionWeights})`);
    return poiScore;
}

function calculateSpecializedPOIScore(poiCounts, patientCondition) {
    if (!poiCounts || !patientCondition || !patientCondition.isPatientMode) return 0.0;

    const cfg = SCORING.specializedPoi;
    const cap = cfg.maxCountPerType;
    const pts = cfg.pointsPerHit;
    let specializedScore = 0;
    let activeFactors = 0;

    if (patientCondition.name === "cardiac" && typeof poiCounts.restingAreaCount === 'number' && poiCounts.restingAreaCount > 0) {
        specializedScore += Math.min(poiCounts.restingAreaCount, cap) * pts;
        activeFactors++;
    }
    if (patientCondition.name === "mobility" && typeof poiCounts.wheelchairAccessCount === 'number' && poiCounts.wheelchairAccessCount > 0) {
        specializedScore += Math.min(poiCounts.wheelchairAccessCount, cap) * pts;
        activeFactors++;
    }
    if (patientCondition.name === "mental" && typeof poiCounts.quietAreaCount === 'number' && poiCounts.quietAreaCount > 0) {
        specializedScore += Math.min(poiCounts.quietAreaCount, cap) * pts * cfg.mentalQuietMultiplier;
        activeFactors++;
    }
    if (patientCondition.name === "diabetes" && typeof poiCounts.pharmacyCount === 'number' && poiCounts.pharmacyCount > 0) {
        specializedScore += Math.min(poiCounts.pharmacyCount, cap) * pts;
        activeFactors++;
    }
    if (patientCondition.name === "diabetes" && typeof poiCounts.healthServiceCount === 'number' && poiCounts.healthServiceCount > 0) {
        specializedScore += Math.min(poiCounts.healthServiceCount, cap) * pts;
        activeFactors++;
    }

    if (activeFactors === 0) {
        console.log(`[calculateSpecializedPOIScore] No relevant specialized POIs for ${patientCondition.name}. Returning 0.0`);
        return 0.0; 
    }

    const finalSpecializedScore = Math.min(10, specializedScore / activeFactors) ; 
    console.log(`[calculateSpecializedPOIScore] Calculated specialized POI score for ${patientCondition.name}: ${finalSpecializedScore.toFixed(2)} from ${activeFactors} factor(s)`);
    return finalSpecializedScore;
}

function calculateRawTotalScore(envScore, poiScore, specializedPoiScore, patientCondition) {
    if (typeof envScore !== 'number' || typeof poiScore !== 'number' || typeof specializedPoiScore !== 'number') {
        console.warn(`[calculateRawTotalScore] Cannot calculate total score due to N/A components: Env=${envScore}, POI=${poiScore}, Specialized=${specializedPoiScore}`);
        return "N/A";
    }

    const blend = getTotalScoreBlend(patientCondition);
    const envWeight = blend.environment;
    const poiWeight = blend.poi;
    const specializedWeight = blend.specialized;

    const totalWeightedScore = (envScore * envWeight) +
                               (poiScore * poiWeight) +
                               (specializedPoiScore * specializedWeight);
    const totalWeight = envWeight + poiWeight + specializedWeight;
    
    const rawScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 5.0; // Fallback to 5.0 if totalWeight is 0, though unlikely with defaults
    
    console.log(`[calculateRawTotalScore] Weights: Env=${envWeight.toFixed(2)}, POI=${poiWeight.toFixed(2)}, Specialized=${specializedWeight.toFixed(2)}. Final raw score: ${rawScore.toFixed(2)}`);
    return Math.min(10, Math.max(0, rawScore)); 
}

/**
 * Map average slope percentage and patient sensitivity (0–10) to a 0–10
 * suitability score that never bottoms out at exactly 0.  
 *  – Slope ≤ sweet spot  ⇒ 10  
 *  – Slope ≥ maxBad     ⇒ 1  
 *  – Linear drop in-between.  
 * The sweet spot tightens as sensitivity rises: high sensitivity (10) → 4 %.
 */
function slopeSuitability(avgSlopePct, sensitivity = 5) {
    if (typeof avgSlopePct !== 'number') return 0;
    const cfg = SCORING.factors.slope;
    const sweet = Math.max(0, cfg.sweetSpotBase - sensitivity);
    const maxBad = sweet + cfg.gradeSpanPct;
    const span = cfg.maxScore - cfg.minScore;

    if (avgSlopePct <= sweet) return cfg.maxScore;
    if (avgSlopePct >= maxBad) return cfg.minScore;

    return cfg.maxScore - span * (avgSlopePct - sweet) / (maxBad - sweet);
}