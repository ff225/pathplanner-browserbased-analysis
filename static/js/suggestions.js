document.addEventListener("DOMContentLoaded", function() {
    const locationIqAccessToken = window.LOCATIONIQ_ACCESS_TOKEN || '';
    const startPointInput = document.getElementById('startPoint');
    const endPointInput = document.getElementById('endPoint');
    const startPointSuggestions = document.getElementById('startPoint-suggestions');
    const endPointSuggestions = document.getElementById('endPoint-suggestions');
    const useCurrentLocationStart = document.getElementById('useCurrentLocationStart');
    const useCurrentLocationEnd = document.getElementById('useCurrentLocationEnd');

    let debounceTimer;

    async function fetchSuggestions(query) {
        if (!locationIqAccessToken) {
            console.error('LocationIQ access token is not configured');
            return [];
        }
        try {
            const response = await fetch(`https://api.locationiq.com/v1/autocomplete?key=${encodeURIComponent(locationIqAccessToken)}&q=${encodeURIComponent(query)}&limit=5&format=json`);
            if (!response.ok) throw new Error('Network response was not ok');
            return await response.json();
        } catch (error) {
            console.error('Error fetching suggestions:', error);
            return [];
        }
    }

    async function getCurrentLocation(input) {
        if (!locationIqAccessToken) {
            console.error('LocationIQ access token is not configured');
            toastr.error("Location lookup is not configured");
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
            
            const response = await fetch(`https://api.locationiq.com/v1/reverse?key=${encodeURIComponent(locationIqAccessToken)}&lat=${latitude}&lon=${longitude}&format=json`);
            const data = await response.json();
            
            input.value = data.display_name;
            input.dataset.lat = latitude;
            input.dataset.lon = longitude;
        } catch (error) {
            console.error('Error getting location:', error);
            toastr.error("Unable to get your location");
        }
    }

    function handleInput(input, suggestionsContainer) {
        clearTimeout(debounceTimer);
        const query = input.value.trim();

        if (query.length < 3) {
            suggestionsContainer.style.display = 'none';
            return;
        }

        debounceTimer = setTimeout(async () => {
            const suggestions = await fetchSuggestions(query);
            displaySuggestions(suggestions, input, suggestionsContainer);
        }, 300);
    }

    function displaySuggestions(suggestions, input, container) {
        container.innerHTML = '';
        
        if (!suggestions.length) {
            container.style.display = 'none';
            return;
        }

        suggestions.forEach(suggestion => {
            const div = document.createElement('div');
            div.className = 'suggestion-item';
            div.textContent = suggestion.display_name;
            div.addEventListener('click', () => {
                input.value = suggestion.display_name;
                input.dataset.lat = suggestion.lat;
                input.dataset.lon = suggestion.lon;
                container.style.display = 'none';
            });
            container.appendChild(div);
        });

        container.style.display = 'block';
    }

    // Event Listeners
    startPointInput.addEventListener('input', () => handleInput(startPointInput, startPointSuggestions));
    endPointInput.addEventListener('input', () => handleInput(endPointInput, endPointSuggestions));
    useCurrentLocationStart.addEventListener('click', () => getCurrentLocation(startPointInput));
    useCurrentLocationEnd.addEventListener('click', () => getCurrentLocation(endPointInput));

    // Close suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!startPointInput.contains(e.target) && !startPointSuggestions.contains(e.target)) {
            startPointSuggestions.style.display = 'none';
        }
        if (!endPointInput.contains(e.target) && !endPointSuggestions.contains(e.target)) {
            endPointSuggestions.style.display = 'none';
        }
    });
});
