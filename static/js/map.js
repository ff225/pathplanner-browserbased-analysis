document.addEventListener("DOMContentLoaded", function() {
    var map = L.map('map').setView([44.645819, 10.925719], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    
    window.map = map; // Exports the map variable globally

    var mapShell = document.getElementById('mapShell');
    var sidebar = document.getElementById('routeSidebar');
    var mapPanel = document.querySelector('.map-panel');
    var toggleButton = document.getElementById('sidebarToggle');

    function invalidateMapSize() {
        if (window.map && typeof window.map.invalidateSize === 'function') {
            window.map.invalidateSize({ animate: true });
        }
    }

    function scheduleMapInvalidation() {
        window.requestAnimationFrame(invalidateMapSize);
        window.setTimeout(invalidateMapSize, 80);
        window.setTimeout(invalidateMapSize, 340);
    }

    function setSidebarFocusState(isCollapsed) {
        sidebar.setAttribute('aria-hidden', isCollapsed ? 'true' : 'false');

        if ('inert' in sidebar) {
            sidebar.inert = isCollapsed;
            return;
        }

        sidebar.querySelectorAll('a, button, input, select, textarea, [tabindex]').forEach(function(element) {
            if (isCollapsed) {
                if (element.dataset.sidebarToggleTabindex === undefined) {
                    element.dataset.sidebarToggleTabindex = element.getAttribute('tabindex') || '';
                }
                element.setAttribute('tabindex', '-1');
                return;
            }

            if (element.dataset.sidebarToggleTabindex === undefined) {
                return;
            }

            if (element.dataset.sidebarToggleTabindex) {
                element.setAttribute('tabindex', element.dataset.sidebarToggleTabindex);
            } else {
                element.removeAttribute('tabindex');
            }
            delete element.dataset.sidebarToggleTabindex;
        });
    }

    function setSidebarCollapsed(isCollapsed) {
        mapShell.classList.toggle('sidebar-collapsed', isCollapsed);
        toggleButton.setAttribute('aria-expanded', String(!isCollapsed));
        toggleButton.setAttribute('aria-label', isCollapsed ? 'Show route controls' : 'Hide route controls');
        toggleButton.setAttribute('title', isCollapsed ? 'Show route controls' : 'Hide route controls');
        setSidebarFocusState(isCollapsed);
        scheduleMapInvalidation();
    }

    if (mapShell && sidebar && mapPanel && toggleButton) {
        setSidebarFocusState(false);

        toggleButton.addEventListener('click', function() {
            setSidebarCollapsed(!mapShell.classList.contains('sidebar-collapsed'));
        });

        [sidebar, mapPanel].forEach(function(element) {
            element.addEventListener('transitionend', function(event) {
                if (event.target === element) {
                    invalidateMapSize();
                }
            });
        });
    }

    // Unified right sidebar (environmental data + turn-by-turn directions)
    var rightSidebar = document.getElementById('rightSidebar');
    var rightSidebarToggle = document.getElementById('rightSidebarToggle');
    var envInspectorClose = document.getElementById('envInspectorClose');
    var directionsClose = document.getElementById('directionsClose');

    function setRightSidebarOpen(open) {
        if (!rightSidebar) return;
        document.body.classList.toggle('right-sidebar-open', open);
        rightSidebar.setAttribute('aria-hidden', String(!open));
        if (rightSidebarToggle) {
            rightSidebarToggle.setAttribute('aria-expanded', String(open));
            rightSidebarToggle.setAttribute('aria-label', open ? 'Close environmental data and directions' : 'Open environmental data and directions');
            rightSidebarToggle.setAttribute('title', open ? 'Close environmental data and directions' : 'Environmental data & directions');
        }
        if (!open && rightSidebarToggle) {
            rightSidebarToggle.focus({ preventScroll: true });
        }
        scheduleMapInvalidation();
    }

    if (rightSidebarToggle) {
        rightSidebarToggle.addEventListener('click', function() {
            setRightSidebarOpen(!document.body.classList.contains('right-sidebar-open'));
        });
    }

    if (envInspectorClose) {
        envInspectorClose.addEventListener('click', function() {
            setRightSidebarOpen(false);
        });
    }

    if (directionsClose) {
        directionsClose.addEventListener('click', function() {
            setRightSidebarOpen(false);
        });
    }

    if (rightSidebar && mapPanel) {
        [rightSidebar, mapPanel].forEach(function(element) {
            element.addEventListener('transitionend', function(event) {
                if (event.target === element) {
                    invalidateMapSize();
                }
            });
        });
    }

    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && document.body.classList.contains('right-sidebar-open')) {
            setRightSidebarOpen(false);
        }
    });
});
