document.addEventListener("DOMContentLoaded", function() {
    var map = L.map('map').setView([44.645819, 10.925719], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    
    window.map = map; // Exports the map variable globally
});
