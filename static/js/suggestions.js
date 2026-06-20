document.addEventListener("DOMContentLoaded", function() {
    const mapboxAccessToken = window.MAPBOX_ACCESS_TOKEN || '';
    const startPointInput = document.getElementById('startPoint');
    const endPointInput = document.getElementById('endPoint');
    const startPointSuggestions = document.getElementById('startPoint-suggestions');
    const endPointSuggestions = document.getElementById('endPoint-suggestions');
    const useCurrentLocationStart = document.getElementById('useCurrentLocationStart');
    const useCurrentLocationEnd = document.getElementById('useCurrentLocationEnd');

    const SEARCHBOX_ENDPOINT = 'https://api.mapbox.com/search/searchbox/v1';
    const SEARCHBOX_TYPES = 'address,poi,place,city,locality,neighborhood,street,category';
    const SUGGESTION_LIMIT = '10';
    const MIN_QUERY_LENGTH = 3;

    const inputTimers = new WeakMap();
    const inputSessions = new WeakMap();

    function createSessionToken() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }

        const randomPart = Math.random().toString(36).slice(2);
        return `${Date.now().toString(36)}-${randomPart}`;
    }

    function getSearchSession(input) {
        let session = inputSessions.get(input);
        if (!session) {
            session = {
                token: createSessionToken(),
                requestId: 0
            };
            inputSessions.set(input, session);
        }
        return session;
    }

    function rotateSearchSession(input) {
        const session = getSearchSession(input);
        session.token = createSessionToken();
        session.requestId = 0;
    }

    function getMapProximity() {
        const activeMap = window.map;
        if (activeMap && typeof activeMap.getCenter === 'function') {
            const center = activeMap.getCenter();
            if (Number.isFinite(center?.lng) && Number.isFinite(center?.lat)) {
                return `${center.lng},${center.lat}`;
            }
        }
        return 'ip';
    }

    function showLookupConfigurationError() {
        console.error('Mapbox access token is not configured');
        toastr.error("Location lookup is not configured");
    }

    function setInputCoordinates(input, latitude, longitude) {
        input.dataset.lat = String(latitude);
        input.dataset.lon = String(longitude);
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clearInputCoordinates(input) {
        delete input.dataset.lat;
        delete input.dataset.lon;
    }

    function hideSuggestions(container) {
        container.innerHTML = '';
        container.style.display = 'none';
    }

    function buildSearchBoxUrl(path, params) {
        const url = new URL(`${SEARCHBOX_ENDPOINT}${path}`);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, value);
            }
        });
        return url;
    }

    async function fetchSuggestions(query, input) {
        if (!mapboxAccessToken) {
            showLookupConfigurationError();
            return [];
        }

        try {
            const session = getSearchSession(input);
            const url = buildSearchBoxUrl('/suggest', {
                q: query,
                access_token: mapboxAccessToken,
                session_token: session.token,
                limit: SUGGESTION_LIMIT,
                types: SEARCHBOX_TYPES,
                proximity: getMapProximity()
            });

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Mapbox suggestion request failed with status ${response.status}`);
            }

            const data = await response.json();
            return Array.isArray(data.suggestions) ? data.suggestions : [];
        } catch (error) {
            console.error('Error fetching Mapbox suggestions:', error);
            toastr.error("Unable to fetch location suggestions");
            return [];
        }
    }

    function getFeatureCoordinates(feature) {
        const geometryCoordinates = feature?.geometry?.coordinates;
        if (Array.isArray(geometryCoordinates) && geometryCoordinates.length >= 2) {
            const [longitude, latitude] = geometryCoordinates;
            if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
                return { latitude, longitude };
            }
        }

        const propertyCoordinates = feature?.properties?.coordinates;
        const latitude = propertyCoordinates?.latitude ?? propertyCoordinates?.lat;
        const longitude = propertyCoordinates?.longitude ?? propertyCoordinates?.lon ?? propertyCoordinates?.lng;

        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            return { latitude, longitude };
        }

        return null;
    }

    function getFeatureLabel(feature) {
        const properties = feature?.properties || {};
        return properties.full_address || properties.name || properties.place_formatted || '';
    }

    async function retrieveSuggestion(mapboxId, input) {
        if (!mapboxAccessToken) {
            showLookupConfigurationError();
            return false;
        }

        if (!mapboxId) {
            toastr.error("Unable to retrieve the selected location");
            return false;
        }

        try {
            const session = getSearchSession(input);
            const url = buildSearchBoxUrl(`/retrieve/${encodeURIComponent(mapboxId)}`, {
                access_token: mapboxAccessToken,
                session_token: session.token
            });

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Mapbox retrieve request failed with status ${response.status}`);
            }

            const data = await response.json();
            const feature = Array.isArray(data.features) ? data.features[0] : null;
            const coordinates = getFeatureCoordinates(feature);

            if (!feature || !coordinates) {
                throw new Error('Mapbox retrieve response did not include coordinates');
            }

            input.value = getFeatureLabel(feature) || input.value;
            setInputCoordinates(input, coordinates.latitude, coordinates.longitude);
            rotateSearchSession(input);
            return true;
        } catch (error) {
            console.error('Error retrieving Mapbox suggestion:', error);
            toastr.error("Unable to retrieve the selected location");
            return false;
        }
    }

    async function reverseGeocode(latitude, longitude) {
        const url = buildSearchBoxUrl('/reverse', {
            latitude,
            longitude,
            access_token: mapboxAccessToken,
            limit: '1'
        });

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Mapbox reverse request failed with status ${response.status}`);
        }

        const data = await response.json();
        return Array.isArray(data.features) ? data.features[0] : null;
    }

    async function getCurrentLocation(input, suggestionsContainer) {
        if (!mapboxAccessToken) {
            showLookupConfigurationError();
            return;
        }

        if (!navigator.geolocation) {
            toastr.error("Geolocation is not supported by your browser");
            return;
        }

        try {
            const position = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject);
            });

            const { latitude, longitude } = position.coords;
            const feature = await reverseGeocode(latitude, longitude);
            const label = getFeatureLabel(feature);

            input.value = label || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
            setInputCoordinates(input, latitude, longitude);
            hideSuggestions(suggestionsContainer);
        } catch (error) {
            console.error('Error getting location:', error);
            toastr.error("Unable to get your location");
        }
    }

    function handleInput(input, suggestionsContainer) {
        const existingTimer = inputTimers.get(input);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        clearInputCoordinates(input);
        const query = input.value.trim();

        if (query.length < MIN_QUERY_LENGTH) {
            hideSuggestions(suggestionsContainer);
            return;
        }

        const session = getSearchSession(input);
        const requestId = session.requestId + 1;
        session.requestId = requestId;

        const timer = setTimeout(async () => {
            const suggestions = await fetchSuggestions(query, input);
            const latestSession = getSearchSession(input);

            if (latestSession.requestId === requestId && input.value.trim() === query) {
                displaySuggestions(suggestions, input, suggestionsContainer);
            }
        }, 250);

        inputTimers.set(input, timer);
    }

    function getSuggestionDetail(suggestion) {
        return suggestion.full_address || suggestion.place_formatted || suggestion.address || '';
    }

    function getSuggestionTitle(suggestion) {
        return suggestion.name_preferred || suggestion.name || getSuggestionDetail(suggestion);
    }

    function displaySuggestions(suggestions, input, container) {
        container.innerHTML = '';

        const selectableSuggestions = suggestions.filter(suggestion => suggestion.mapbox_id && getSuggestionTitle(suggestion));
        if (!selectableSuggestions.length) {
            hideSuggestions(container);
            return;
        }

        selectableSuggestions.forEach(suggestion => {
            const title = getSuggestionTitle(suggestion);
            const detail = getSuggestionDetail(suggestion);
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'suggestion-item';
            item.dataset.mapboxId = suggestion.mapbox_id;
            item.setAttribute('aria-label', detail ? `${title}, ${detail}` : title);

            const textWrapper = document.createElement('span');
            textWrapper.className = 'suggestion-text';

            const mainText = document.createElement('span');
            mainText.className = 'main-text';
            mainText.textContent = title;
            textWrapper.appendChild(mainText);

            if (detail && detail !== title) {
                const secondaryText = document.createElement('span');
                secondaryText.className = 'secondary-text';
                secondaryText.textContent = detail;
                textWrapper.appendChild(secondaryText);
            }

            item.appendChild(textWrapper);
            item.addEventListener('click', async () => {
                item.disabled = true;
                const retrieved = await retrieveSuggestion(item.dataset.mapboxId, input);
                item.disabled = false;

                if (retrieved) {
                    hideSuggestions(container);
                }
            });

            container.appendChild(item);
        });

        container.style.display = 'block';
    }

    if (!startPointInput || !endPointInput || !startPointSuggestions || !endPointSuggestions) {
        return;
    }

    startPointInput.addEventListener('input', () => handleInput(startPointInput, startPointSuggestions));
    endPointInput.addEventListener('input', () => handleInput(endPointInput, endPointSuggestions));

    if (useCurrentLocationStart) {
        useCurrentLocationStart.addEventListener('click', () => getCurrentLocation(startPointInput, startPointSuggestions));
    }

    if (useCurrentLocationEnd) {
        useCurrentLocationEnd.addEventListener('click', () => getCurrentLocation(endPointInput, endPointSuggestions));
    }

    document.addEventListener('click', (event) => {
        if (!startPointInput.contains(event.target) && !startPointSuggestions.contains(event.target)) {
            hideSuggestions(startPointSuggestions);
        }
        if (!endPointInput.contains(event.target) && !endPointSuggestions.contains(event.target)) {
            hideSuggestions(endPointSuggestions);
        }
    });
});
