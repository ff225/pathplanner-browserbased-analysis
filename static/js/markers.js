document.addEventListener("DOMContentLoaded", function() {
    const startPointInput = document.getElementById('startPoint');
    const endPointInput = document.getElementById('endPoint');
    const searchButton = document.getElementById('searchButton');
    
    let startMarker = null;
    let endMarker = null;
    
    // Custom icons for start and end points
    const startIcon = L.icon({
        iconUrl: '/static/img/position.png', // Reusing existing position icon for start
        iconSize: [25, 25]
    });
    
    const endIcon = L.icon({
        iconUrl: '/static/img/endposition.png', // New green icon for end point
        iconSize: [25, 25]
    });
    
    // Function to add or update markers
    function updateMarkers() {
        const startLat = startPointInput.dataset.lat;
        const startLon = startPointInput.dataset.lon;
        const endLat = endPointInput.dataset.lat;
        const endLon = endPointInput.dataset.lon;
        
        // Only proceed if we have valid coordinates
        if (!startLat || !startLon || !endLat || !endLon) {
            return;
        }
        
        // Remove existing markers
        if (startMarker) map.removeLayer(startMarker);
        if (endMarker) map.removeLayer(endMarker);
        
        // Add start marker
        startMarker = L.marker([startLat, startLon], {
            icon: startIcon
        }).addTo(map).bindPopup("<strong>Starting Point</strong>");
        
        // Add end marker with green icon
        endMarker = L.marker([endLat, endLon], {
            icon: endIcon
        }).addTo(map).bindPopup("<strong>Arrival Point</strong>");
        
        // Fit map to show both markers
        const bounds = L.latLngBounds([
            [startLat, startLon],
            [endLat, endLon]
        ]);
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    if (window.PathPlannerMapState) {
        const restoredStart = window.PathPlannerMapState.restorePoint('startPoint', startPointInput);
        const restoredEnd = window.PathPlannerMapState.restorePoint('endPoint', endPointInput);
        if (restoredStart && restoredEnd) {
            window.requestAnimationFrame(updateMarkers);
        }
    }
    
    // Update markers when search button is clicked
    if (searchButton) {
        searchButton.addEventListener('click', updateMarkers);
    }
    
    // Update markers when inputs change directly
    startPointInput.addEventListener('change', function() {
        window.PathPlannerMapState?.savePoint('startPoint', this);
        if (this.dataset.lat && this.dataset.lon && endPointInput.dataset.lat && endPointInput.dataset.lon) {
            updateMarkers();
        }
    });
    
    endPointInput.addEventListener('change', function() {
        window.PathPlannerMapState?.savePoint('endPoint', this);
        if (this.dataset.lat && this.dataset.lon && startPointInput.dataset.lat && startPointInput.dataset.lon) {
            updateMarkers();
        }
    });
}); 
