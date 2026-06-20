const DEFAULT = {
    nature: 3,
    entertainment: 3,
    nightlife: 3,
    tourism: 3,
    hospital: 3
};

async function getPreferences(selectedValue) {
    if (selectedValue === 'Choose preferences...') {
        return DEFAULT;
    }
    
    switch(selectedValue) {
        case 'nature_lover':
            return {
                nature: 10,
                entertainment: 2,
                nightlife: 0,
                tourism: 5,
                hospital: 1
            };
        case 'entertainment':
            return {
                nature: 2,
                entertainment: 10,
                nightlife: 5,
                tourism: 2,
                hospital: 0
            };
        case 'nightlife':
            return {
                nature: 0,
                entertainment: 5,
                nightlife: 10,
                tourism: 2,
                hospital: 0
            };
        case 'tourist':
            return {
                nature: 4,
                entertainment: 3,
                nightlife: 2,
                tourism: 10,
                hospital: 0
            };
        case 'medical':
        return {
                nature: 2,
                entertainment: 1,
                nightlife: 0,
                tourism: 1,
                hospital: 10
            };
        default:
        return DEFAULT;
    }
}

async function setCurrentPreferences(currentPreferences, preferences) {
    currentPreferences.nature = preferences.nature;
    currentPreferences.entertainment = preferences.entertainment;
    currentPreferences.nightlife = preferences.nightlife;
    currentPreferences.tourism = preferences.tourism;
    currentPreferences.hospital = preferences.hospital;
}

async function checkIfPreferencesDefault(preferences) {
    return preferences.nature === DEFAULT.nature &&
        preferences.entertainment === DEFAULT.entertainment &&
        preferences.nightlife === DEFAULT.nightlife &&
        preferences.tourism === DEFAULT.tourism &&
        preferences.hospital === DEFAULT.hospital;
}

export {
    DEFAULT,
    getPreferences,
    setCurrentPreferences,
    checkIfPreferencesDefault
};