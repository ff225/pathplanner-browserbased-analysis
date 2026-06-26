const DEFAULT = {
    nature: 3,
    entertainment: 3,
    nightlife: 3,
    tourism: 3,
    hospital: 3
};

const PREFERENCE_FIELDS = ['nature', 'entertainment', 'nightlife', 'tourism', 'hospital'];
const DEFAULT_SELECTIONS = ['Choose preferences...', 'No saved preferences'];

const LEGACY_PRESETS = {
    nature_lover: {
        nature: 10,
        entertainment: 2,
        nightlife: 0,
        tourism: 5,
        hospital: 1
    },
    entertainment: {
        nature: 2,
        entertainment: 10,
        nightlife: 5,
        tourism: 2,
        hospital: 0
    },
    nightlife: {
        nature: 0,
        entertainment: 5,
        nightlife: 10,
        tourism: 2,
        hospital: 0
    },
    tourist: {
        nature: 4,
        entertainment: 3,
        nightlife: 2,
        tourism: 10,
        hospital: 0
    },
    medical: {
        nature: 2,
        entertainment: 1,
        nightlife: 0,
        tourism: 1,
        hospital: 10
    }
};

function isDefaultSelection(selectedValue) {
    return !selectedValue || DEFAULT_SELECTIONS.includes(selectedValue);
}

function normalizePreferenceWeights(data) {
    const preferences = { ...DEFAULT };
    for (const field of PREFERENCE_FIELDS) {
        const value = Number(data[field]);
        preferences[field] = Number.isFinite(value) ? value : DEFAULT[field];
    }
    if (data.id !== undefined) {
        preferences.id = data.id;
    }
    if (data.name) {
        preferences.label = data.name;
    }
    return preferences;
}

function getPreferenceWeightsUrl(preferenceId) {
    const preferenceSet = document.getElementById('preferenceSet');
    const template = preferenceSet ? preferenceSet.dataset.weightsUrlTemplate : null;
    if (template) {
        return template.replace('/0/', `/${encodeURIComponent(preferenceId)}/`);
    }
    return `/users/profile/preferences/${encodeURIComponent(preferenceId)}/weights/`;
}

async function getPreferences(selectedValue) {
    if (isDefaultSelection(selectedValue)) {
        return DEFAULT;
    }

    if (Object.prototype.hasOwnProperty.call(LEGACY_PRESETS, selectedValue)) {
        return LEGACY_PRESETS[selectedValue];
    }

    try {
        const response = await fetch(getPreferenceWeightsUrl(selectedValue), {
            headers: {
                'Accept': 'application/json'
            },
            credentials: 'same-origin'
        });

        if (!response.ok) {
            console.warn(`[preferences.js] Preference ${selectedValue} could not be loaded (${response.status}); using defaults.`);
            return DEFAULT;
        }

        return normalizePreferenceWeights(await response.json());
    } catch (error) {
        console.warn(`[preferences.js] Preference ${selectedValue} could not be loaded; using defaults.`, error);
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

function selectedPreferenceOption(preferenceSet) {
    if (!preferenceSet || isDefaultSelection(preferenceSet.value)) {
        return null;
    }
    return preferenceSet.options[preferenceSet.selectedIndex] || null;
}

function setDisabledLink(link, disabled) {
    if (!link) {
        return;
    }
    if (disabled) {
        link.removeAttribute('href');
        link.classList.add('disabled');
        link.setAttribute('aria-disabled', 'true');
    } else {
        link.classList.remove('disabled');
        link.setAttribute('aria-disabled', 'false');
    }
}

function setupPreferenceControls() {
    const preferenceSet = document.getElementById('preferenceSet');
    const editLink = document.getElementById('preferenceEditLink');
    const deleteButton = document.getElementById('preferenceDeleteButton');
    const deleteForm = document.getElementById('preferenceDeleteForm');

    if (!preferenceSet || !editLink || !deleteButton || !deleteForm) {
        return;
    }

    const syncActions = () => {
        const option = selectedPreferenceOption(preferenceSet);
        const hasPreference = Boolean(option);
        const editUrl = option ? option.dataset.editUrl : '';
        const deleteUrl = option ? option.dataset.deleteUrl : '';

        if (editUrl) {
            editLink.href = editUrl;
        }
        setDisabledLink(editLink, !editUrl);

        deleteForm.action = deleteUrl || '';
        deleteButton.disabled = !hasPreference || !deleteUrl;
    };

    preferenceSet.addEventListener('change', syncActions);
    deleteForm.addEventListener('submit', (event) => {
        const option = selectedPreferenceOption(preferenceSet);
        if (!deleteForm.action || !option) {
            event.preventDefault();
            return;
        }
        const preferenceName = option.textContent.trim();
        if (!window.confirm(`Delete preference "${preferenceName}"?`)) {
            event.preventDefault();
        }
    });
    syncActions();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupPreferenceControls);
} else {
    setupPreferenceControls();
}

export {
    DEFAULT,
    getPreferences,
    setCurrentPreferences,
    checkIfPreferencesDefault,
    setupPreferenceControls
};
