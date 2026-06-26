(function() {
    const STORAGE_KEY = 'pathplanner.mapState.v1';

    function read() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
        } catch (error) {
            return {};
        }
    }

    function write(nextState) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
        } catch (error) {
            // Persistence is best-effort; the app still works without storage.
        }
    }

    function update(patch) {
        write({ ...read(), ...patch, updatedAt: Date.now() });
    }

    function isFiniteCoordinate(value) {
        const numeric = Number(value);
        return Number.isFinite(numeric);
    }

    function savePoint(kind, input) {
        if (!input) return;
        const point = { value: input.value || '' };

        if (isFiniteCoordinate(input.dataset.lat) && isFiniteCoordinate(input.dataset.lon)) {
            point.lat = Number(input.dataset.lat);
            point.lon = Number(input.dataset.lon);
        }

        update({ [kind]: point });
    }

    function restorePoint(kind, input) {
        const point = read()[kind];
        if (!point || !input) return false;

        input.value = point.value || '';
        if (isFiniteCoordinate(point.lat) && isFiniteCoordinate(point.lon)) {
            input.dataset.lat = String(point.lat);
            input.dataset.lon = String(point.lon);
            return true;
        }

        delete input.dataset.lat;
        delete input.dataset.lon;
        return false;
    }

    function saveValue(id, value) {
        const controls = { ...(read().controls || {}) };
        controls[id] = value;
        update({ controls });
    }

    function restoreValue(id, element) {
        const controls = read().controls || {};
        if (!element || controls[id] === undefined) return false;

        if (element.type === 'checkbox') {
            element.checked = controls[id] === true || controls[id] === 'true';
            return true;
        }

        const savedValue = String(controls[id]);
        if (element.tagName === 'SELECT') {
            const hasOption = Array.from(element.options || []).some(option => option.value === savedValue);
            if (!hasOption) return false;
        }

        element.value = savedValue;
        return true;
    }

    function bindValue(id, element, eventName) {
        if (!element) return;
        element.addEventListener(eventName || 'change', function() {
            saveValue(id, element.type === 'checkbox' ? element.checked : element.value);
        });
    }

    function clear() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (error) {
            // best-effort
        }
    }

    window.PathPlannerMapState = {
        read,
        update,
        savePoint,
        restorePoint,
        saveValue,
        restoreValue,
        bindValue,
        clear
    };
})();
