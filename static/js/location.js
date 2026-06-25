document.addEventListener("DOMContentLoaded", function() {
    var currentLocationMarker;
    var GEOLOCATION_ENV_EVENT = 'pathplanner:geolocation-position';

    // Function to get the current location and add a marker on the map
    function addCurrentLocationMarker() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(function(position) {
                var lat = position.coords.latitude;
                var lng = position.coords.longitude;

                // Remove the previous marker if it exists
                if (currentLocationMarker) {
                    map.removeLayer(currentLocationMarker);
                }

                // Add a marker at the user's current location with a custom icon
                currentLocationMarker = L.marker([lat, lng], {
                    icon: L.icon({
                        iconUrl: '/static/img/position.png', // Custom icon for the user's position
                        iconSize: [25, 25] // Size of the icon
                    })
                }).addTo(map).bindPopup(`<strong>You are here!</strong>`); // Display popup at the marker

                // Center the map at the current location
                map.setView([lat, lng], 13);
                loadEnvironmentForCurrentLocation(lat, lng);
            }, function(error) {
                // Handle errors related to geolocation
                console.error("Error getting location: " + error.message);
                toastr.error("Unable to retrieve your location. Please check your settings and try again.");
            });
        } else {
            // Geolocation not supported by the browser
            console.error("Geolocation is not supported by this browser.");
            toastr.error("Geolocation is not supported by this browser.");
        }
    }

    // Fire-and-forget GET that warms the backend env cache for the user's
    // position. Best-effort only: never blocks the UI and swallows all errors.
    function prefetchRoutingEnvironment(point) {
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
            return;
        }
        if (typeof fetch !== 'function') {
            return;
        }
        try {
            var url = '/api/environment?lat=' + encodeURIComponent(point.lat) +
                '&lon=' + encodeURIComponent(point.lon) +
                '&pathologies=default';
            fetch(url, { method: 'GET' }).catch(function() { /* best-effort */ });
        } catch (err) {
            // best-effort: a prefetch failure must never affect geolocation UX
        }
    }

    function loadEnvironmentForCurrentLocation(lat, lng) {
        var point = {
            lat: Number(lat),
            lon: Number(lng),
            lng: Number(lng)
        };

        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
            return;
        }

        window.pathplannerLastGeolocationPoint = point;

        // Warm the backend routing-env cache around the user the moment we know
        // their location, so the first "Find route" doesn't pay the cold fetch.
        prefetchRoutingEnvironment(point);

        if (window.pathplannerEnvironmentInspector && typeof window.pathplannerEnvironmentInspector.loadForCoordinates === 'function') {
            window.pathplannerEnvironmentInspector.loadForCoordinates(point, {
                force: true,
                contextLabel: 'User location'
            });
            return;
        }

        window.dispatchEvent(new CustomEvent(GEOLOCATION_ENV_EVENT, { detail: point }));
    }

    // Add the current location marker when the map is loaded
    addCurrentLocationMarker();

    // Add a button to center the map at the current location
    var locateButton = L.control({position: 'topleft'});
    locateButton.onAdd = function(map) {
        // Create a custom button inside a leaflet control container
        var div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-custom');
        div.innerHTML = '<button id="locateButton" title="Locate Me"><img src="https://cdn-icons-png.flaticon.com/512/684/684908.png" width="15" height="15"></button>';
        div.style.backgroundColor = 'white'; // Button styling
        div.style.width = '34px';
        div.style.height = '34px';
        div.style.display = 'flex';
        div.style.justifyContent = 'center';
        div.style.alignItems = 'center';
        div.style.cursor = 'pointer'; // Change cursor to pointer when hovering over the button

        // Event handler to trigger geolocation and re-center the map when the button is clicked
        div.onclick = function() {
            addCurrentLocationMarker();
        };

        return div;
    };
    // Add the locate button to the map
    locateButton.addTo(map);
});
