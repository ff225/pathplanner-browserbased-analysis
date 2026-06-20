import * as MasterPreferences from '../master/preferences.js'

function checkIfAnyEmptyElementInArray(array) {
    for (let each of array) {
        if (each == 0) {
            return true;
        }
    }

    return false;
}

function checkIfAnyNotEmptyElementInArray(array) {
    for (let each of array) {
        if (each != 0) {
            return true;
        }
    }
    return false;
}

const checkIfAnyNaN = (...args) => {
    for (let each of args) {
        if (isNaN(each)) {
            return true;
        }
    }
    return false;
}

async function checkIfPreferencesDefault(currentPreferences) {
    return Object.keys(MasterPreferences.DEFAULT).every((eachKey) => {
        return currentPreferences[eachKey] == MasterPreferences.DEFAULT[eachKey];
    });
}

function createRoute(startPoint, endPoint) {
    var waypoints = [
        L.latLng(startPoint.lat, startPoint.lon),
        L.latLng(endPoint.lat, endPoint.lon)
    ];

    return {
        start: startPoint,
        end: endPoint,
        waypoints: waypoints
    };
}

function createBufferAroundRoute(route, bufferDistanceMeters) {
    var line = turf.lineString(route.coordinates.map(coord => [coord.lng, coord.lat]));
    var buffered = turf.buffer(line, bufferDistanceMeters, { units: 'meters' });

    return buffered;
}

async function createExcludePoints(waypoints) {
    var result = '';
    for (var i = 0; i < waypoints.length; i++) {
        var waypoint = waypoints[i];
        result += `point(${waypoint.lon} ${waypoint.lat})`;
        if (i < waypoints.length - 1) {
            result += ',';
        }
    }
    return result;
}

export {
    checkIfAnyEmptyElementInArray,
    checkIfAnyNotEmptyElementInArray,
    checkIfAnyNaN,
    checkIfPreferencesDefault,
    createRoute,
    createBufferAroundRoute,
    createExcludePoints
}