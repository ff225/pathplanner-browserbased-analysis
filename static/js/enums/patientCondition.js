const Values = {
    respiratory: {
        name: 'respiratory',
        patientNature: 10,  
        patientEntertainment: 3,
        patientNightlife: 0,  
        patientTourism: 2,
        patientHospital: 8,  
        temperatureSensitivity: 8,  
        humiditySensitivity: 9,  
        airQualitySensitivity: 10,
        slopeSensitivity: 7,
        noiseSensitivity: 3,
        isPatientMode: true
    },
    cardiac: {
        name: 'cardiac',
        patientNature: 7,  
        patientEntertainment: 2,
        patientNightlife: 0,  
        patientTourism: 2,
        patientHospital: 10, 
        temperatureSensitivity: 8,  
        humiditySensitivity: 5,
        airQualitySensitivity: 7,
        slopeSensitivity: 9,
        noiseSensitivity: 4,
        isPatientMode: true
    },
    arthritis: {
        name: 'arthritis',
        patientNature: 3,
        patientEntertainment: 4,
        patientNightlife: 1,
        patientTourism: 2,
        patientHospital: 6,
        temperatureSensitivity: 9,  
        humiditySensitivity: 10,  
        airQualitySensitivity: 3,
        slopeSensitivity: 10,
        noiseSensitivity: 2,
        isPatientMode: true
    },
    mental: {
        name: 'mental',
        patientNature: 10,  
        patientEntertainment: 7,  
        patientNightlife: 2,
        patientTourism: 5,
        patientHospital: 4,
        temperatureSensitivity: 4,
        humiditySensitivity: 2,
        airQualitySensitivity: 5,
        slopeSensitivity: 2,
        noiseSensitivity: 9,
        isPatientMode: true
    },
    mobility: {
        name: 'mobility',
        patientNature: 4,
        patientEntertainment: 3,
        patientNightlife: 1,
        patientTourism: 2,
        patientHospital: 7,
        temperatureSensitivity: 3,
        humiditySensitivity: 3,
        airQualitySensitivity: 2,
        slopeSensitivity: 10,
        noiseSensitivity: 2,
        isPatientMode: true
    }, 
    diabetes: {
        name: 'diabetes',
        patientNature: 6,
        patientEntertainment: 4,
        patientNightlife: 0, 
        patientTourism: 3,
        patientHospital: 9,
        temperatureSensitivity: 5,
        humiditySensitivity: 4,
        airQualitySensitivity: 4,
        slopeSensitivity: 6,
        noiseSensitivity: 3,
        isPatientMode: true
    },
    default: {
        name: 'default',
        patientNature: 0,
        patientEntertainment: 0,
        patientNightlife: 0,
        patientTourism: 0,
        patientHospital: 0,
        temperatureSensitivity: 0,
        humiditySensitivity: 0,
        airQualitySensitivity: 0,
        slopeSensitivity: 0,
        noiseSensitivity: 0,
        isPatientMode: false
    }
}

export {
    Values
}