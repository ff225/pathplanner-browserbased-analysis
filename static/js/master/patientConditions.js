import * as Preferences from '../master/preferences.js';
import * as PatientCondition from '../enums/patientCondition.js'

const DEFAULT = {
    name: 'default',
    isPatientMode: false,
    patientNature: 0,
    patientEntertainment: 0,
    patientNightlife: 0,
    patientTourism: 0,
    patientHospital: 0,
    temperatureSensitivity: 0,
    humiditySensitivity: 0,
    airQualitySensitivity: 0,
    slopeSensitivity: 0,
    noiseSensitivity: 0
};

async function getPatientCondition(
    preferenceSet, 
    currentPreferences, 
    patientConditionSelect, 
    currentPatientCondition) {

    const patientCondition = patientConditionSelect.value;
    console.log(`Patient condition changed to: ${patientCondition}`);

    if (patientConditionSelect.value !== "none") {
        if (preferenceSet) {
            preferenceSet.value = "Choose preferences...";
        }

        await Preferences.setCurrentPreferences(currentPreferences, Preferences.DEFAULT);
        return PatientCondition.Values[patientCondition];
    } else {
        setCurrentPatientCondition(currentPatientCondition, DEFAULT)
        console.log("Patient mode deactivated");
    }
}

async function setCurrentPatientCondition(currentPatientCondition, patientCondition) {
    currentPatientCondition.name = patientCondition.name;
    currentPatientCondition.patientNature = patientCondition.patientNature;
    currentPatientCondition.patientEntertainment = patientCondition.patientEntertainment;
    currentPatientCondition.patientNightlife = patientCondition.patientNightlife;
    currentPatientCondition.patientTourism = patientCondition.patientTourism;
    currentPatientCondition.patientHospital = patientCondition.patientHospital;
    currentPatientCondition.temperatureSensitivity = patientCondition.temperatureSensitivity;
    currentPatientCondition.humiditySensitivity = patientCondition.humiditySensitivity;
    currentPatientCondition.airQualitySensitivity = patientCondition.airQualitySensitivity;
    currentPatientCondition.slopeSensitivity = patientCondition.slopeSensitivity || 0;
    currentPatientCondition.noiseSensitivity = patientCondition.noiseSensitivity || 0;
    currentPatientCondition.isPatientMode = patientCondition.isPatientMode;
}

export {
    DEFAULT,
    getPatientCondition,
    setCurrentPatientCondition
}