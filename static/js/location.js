document.addEventListener("DOMContentLoaded", function() {
    var currentLocationMarker;

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
