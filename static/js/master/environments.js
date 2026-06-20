export async function evaluateEnvironmentalScore(envData, currentPatientCondition) {
    if (!envData) return 0;
    
    var score = 0;
    const temp = envData.temperature || 22;
    const humidity = envData.humidity || 50;
    const airQuality = envData.airQuality || 3;
    const weather = envData.weather || "Clear";

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
            break;
            
        case "mobility":
            if (weather.includes("Rain") || weather.includes("Snow") || weather.includes("Ice")) {
                score -= 10; 
            }
            
            if (temp < 10) {
                score -= currentPatientCondition.temperatureSensitivity * 0.7;
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
            break;
            
        default:
            if (weather.includes("Rain") || weather.includes("Snow")) {
                score -= 2;
            }

            if (temp < 5 || temp > 35) {
                score -= 2;
            }
    }
    
    return score;
}