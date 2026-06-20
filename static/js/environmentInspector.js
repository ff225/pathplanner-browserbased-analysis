const REAL_BADGE_TEXT = '\uD83D\uDFE2 REALE';
const UNAVAILABLE_TEXT = 'N/D';

const PATHOLOGY_CONFIG = {
    default: {
        label: 'Baseline',
        metrics: ['pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide']
    },
    respiratory: {
        label: 'Respiratory',
        metrics: ['pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide']
    },
    allergy: {
        label: 'Allergy',
        metrics: ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen']
    },
    cardiac: {
        label: 'Cardiac',
        metrics: ['pm2_5', 'carbon_monoxide', 'nitrogen_dioxide']
    },
    copd: {
        label: 'COPD',
        metrics: ['pm10', 'ozone', 'sulphur_dioxide']
    },
    arthritis: {
        label: 'Arthritis',
        metrics: ['pm2_5', 'ozone']
    },
    mental: {
        label: 'Mental health',
        metrics: ['pm2_5', 'nitrogen_dioxide']
    },
    mobility: {
        label: 'Mobility',
        metrics: ['pm10', 'nitrogen_dioxide']
    },
    diabetes: {
        label: 'Diabetes',
        metrics: ['pm2_5', 'nitrogen_dioxide', 'ozone']
    }
};

const METRIC_LABELS = {
    european_aqi: 'European AQI',
    us_aqi: 'US AQI',
    pm10: 'PM10',
    pm2_5: 'PM2.5',
    carbon_monoxide: 'Carbon monoxide',
    nitrogen_dioxide: 'Nitrogen dioxide',
    sulphur_dioxide: 'Sulphur dioxide',
    ozone: 'Ozone',
    alder_pollen: 'Alder pollen',
    birch_pollen: 'Birch pollen',
    grass_pollen: 'Grass pollen',
    mugwort_pollen: 'Mugwort pollen',
    olive_pollen: 'Olive pollen',
    ragweed_pollen: 'Ragweed pollen'
};

const LEVEL_THRESHOLDS = {
    european_aqi: [20, 40, 60, 80, 100],
    pm2_5: [10, 20, 25, 50, 75],
    pm10: [20, 40, 50, 100, 150],
    nitrogen_dioxide: [40, 90, 120, 230, 340],
    ozone: [100, 120, 180, 240, 300],
    sulphur_dioxide: [100, 200, 350, 500, 750],
    carbon_monoxide: [4000, 7000, 10000, 20000, 30000],
    alder_pollen: [10, 30, 50, 90, 140],
    birch_pollen: [10, 30, 50, 90, 140],
    grass_pollen: [10, 30, 50, 90, 140],
    mugwort_pollen: [10, 30, 50, 90, 140],
    olive_pollen: [10, 30, 50, 90, 140],
    ragweed_pollen: [10, 30, 50, 90, 140]
};

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        toggle: document.getElementById('envInspectorToggle'),
        close: document.getElementById('envInspectorClose'),
        refresh: document.getElementById('envInspectorRefresh'),
        panel: document.getElementById('envInspectorPanel'),
        scrim: document.getElementById('envInspectorScrim'),
        aqi: document.getElementById('envInspectorAqi'),
        pathologies: document.getElementById('envInspectorPathologies'),
        location: document.getElementById('envInspectorLocation'),
        status: document.getElementById('envInspectorStatus'),
        groups: document.getElementById('envMetricGroups'),
        patientCondition: document.getElementById('patientCondition')
    };

    if (!elements.toggle || !elements.panel || !elements.groups) {
        return;
    }

    let abortController = null;
    let latestSuccessfulRequestKey = '';
    const debouncedReload = debounce(() => {
        if (isOpen()) {
            loadEnvironmentData();
        }
    }, 350);

    elements.toggle.addEventListener('click', () => setOpen(!isOpen()));
    elements.close?.addEventListener('click', () => setOpen(false));
    elements.refresh?.addEventListener('click', () => loadEnvironmentData({ force: true }));
    elements.scrim?.addEventListener('click', () => setOpen(false));
    elements.patientCondition?.addEventListener('change', () => {
        window.setTimeout(() => {
            if (isOpen()) {
                loadEnvironmentData({ force: true });
            }
        }, 0);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) {
            setOpen(false);
        }
    });

    waitForMap().then((map) => {
        map.on('moveend', debouncedReload);
    }).catch(() => {
        // The drawer can still use the default app center if Leaflet is not ready.
    });

    function isOpen() {
        return document.body.classList.contains('env-inspector-open');
    }

    function setOpen(open) {
        document.body.classList.toggle('env-inspector-open', open);
        elements.panel.setAttribute('aria-hidden', String(!open));
        elements.toggle.setAttribute('aria-expanded', String(open));
        elements.toggle.setAttribute('aria-label', open ? 'Close environmental data panel' : 'Open environmental data panel');
        elements.toggle.setAttribute('title', open ? 'Close environmental data' : 'Environmental data');
        if (elements.scrim) {
            elements.scrim.hidden = !open;
        }

        if (open) {
            loadEnvironmentData();
            window.setTimeout(() => elements.close?.focus({ preventScroll: true }), 120);
            return;
        }

        elements.toggle.focus({ preventScroll: true });
    }

    async function loadEnvironmentData(options = {}) {
        const point = getCurrentPoint();
        const pathologies = getSelectedPathologies();
        const requestKey = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}:${pathologies.join(',')}`;

        updateContext(point, pathologies);
        if (!options.force && requestKey === latestSuccessfulRequestKey && elements.groups.childElementCount > 0) {
            return;
        }

        abortController?.abort();
        abortController = new AbortController();

        renderLoading(pathologies);

        try {
            const params = new URLSearchParams({
                lat: point.lat.toFixed(6),
                lon: point.lon.toFixed(6),
                pathologies: pathologies.join(',')
            });
            const response = await fetch(`/api/environment?${params.toString()}`, {
                headers: { Accept: 'application/json' },
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            renderPayload(payload, point, pathologies);
            latestSuccessfulRequestKey = requestKey;
        } catch (error) {
            if (error.name === 'AbortError') {
                return;
            }
            latestSuccessfulRequestKey = '';
            renderError(error, point, pathologies);
        }
    }

    function renderLoading(pathologies) {
        elements.status.className = 'env-inspector-status';
        elements.status.textContent = 'Loading real environmental samples from /api/environment...';
        elements.aqi.className = 'env-aqi-card env-aqi-card--loading';
        elements.aqi.innerHTML = `
            <div class="env-aqi-ring" aria-hidden="true"><span class="env-aqi-value">${UNAVAILABLE_TEXT}</span></div>
            <div class="env-aqi-copy">
                <span class="env-aqi-label">Loading real AQI</span>
                <span class="env-aqi-source">${escapeHtml(pathologies.map(getPathologyLabel).join(' + '))}</span>
            </div>
        `;
        elements.groups.innerHTML = `
            <article class="env-metric-card env-metric-card--loading" aria-label="Loading metric"></article>
            <article class="env-metric-card env-metric-card--loading" aria-label="Loading metric"></article>
            <article class="env-metric-card env-metric-card--loading" aria-label="Loading metric"></article>
        `;
    }

    function renderPayload(payload, point, requestedPathologies) {
        const pathologies = Array.isArray(payload.pathologies) && payload.pathologies.length
            ? payload.pathologies
            : requestedPathologies;
        const pollutants = payload.pollutants || payload.points?.[0]?.pollutants || {};
        const overallAqi = payload.overall_aqi || pollutants.european_aqi || null;
        const availableCount = Object.values(pollutants).filter(isAvailableSample).length;
        const unavailableCount = Object.values(pollutants).filter((sample) => !isAvailableSample(sample)).length;

        updateContext(point, pathologies);
        renderAqi(overallAqi);
        renderMetricGroups(pathologies, pollutants);

        elements.status.className = 'env-inspector-status';
        if (availableCount > 0) {
            elements.status.textContent = `Loaded ${availableCount} real metric${availableCount === 1 ? '' : 's'} from /api/environment. ${unavailableCount} ${UNAVAILABLE_TEXT}.`;
            return;
        }

        elements.status.textContent = `Endpoint reached, but every requested metric is ${UNAVAILABLE_TEXT} for this location/pathology.`;
    }

    function renderError(error, point, pathologies) {
        updateContext(point, pathologies);
        elements.aqi.className = 'env-aqi-card env-aqi-card--unavailable';
        elements.aqi.innerHTML = `
            <div class="env-aqi-ring" aria-hidden="true"><span class="env-aqi-value">${UNAVAILABLE_TEXT}</span></div>
            <div class="env-aqi-copy">
                <span class="env-aqi-label">AQI non disponibile <span class="env-real-badge env-real-badge--nd">${UNAVAILABLE_TEXT}</span></span>
                <span class="env-aqi-source">No synthetic fallback. ${escapeHtml(error.message || 'API offline')}</span>
            </div>
        `;
        elements.status.className = 'env-inspector-status env-inspector-status--error';
        elements.status.textContent = 'Environmental API unavailable. No fake values are shown.';
        elements.groups.innerHTML = `
            <div class="env-empty-state">
                /api/environment did not return usable data for this request. Values stay ${UNAVAILABLE_TEXT} until the real endpoint responds.
            </div>
        `;
    }

    function renderAqi(sample) {
        const available = isAvailableSample(sample);
        const level = available ? getMetricLevel('european_aqi', sample.value) : { key: 'unavailable', label: 'AQI non disponibile', progress: 0 };
        const value = available ? formatMetricValue(sample.value) : UNAVAILABLE_TEXT;
        const badge = available ? REAL_BADGE_TEXT : UNAVAILABLE_TEXT;
        const source = sample?.source || sample?.provider || UNAVAILABLE_TEXT;
        const timestamp = formatTimestamp(sample?.timestamp);

        elements.aqi.className = `env-aqi-card env-aqi-card--${level.key}`;
        elements.aqi.style.setProperty('--env-aqi-progress', `${level.progress}%`);
        elements.aqi.innerHTML = `
            <div class="env-aqi-ring" aria-hidden="true">
                <span class="env-aqi-value">${escapeHtml(value)}</span>
            </div>
            <div class="env-aqi-copy">
                <span class="env-aqi-label">${escapeHtml(level.label)} <span class="env-real-badge ${available ? 'env-real-badge--ok' : 'env-real-badge--nd'}">${escapeHtml(badge)}</span></span>
                <span class="env-aqi-source">Source: ${escapeHtml(source)}<br>Timestamp: ${escapeHtml(timestamp)}</span>
            </div>
        `;
    }

    function renderMetricGroups(pathologies, pollutants) {
        const groups = buildGroups(pathologies, pollutants);
        if (!groups.length) {
            elements.groups.innerHTML = `
                <div class="env-empty-state">
                    No pollutant cards returned for this pathology. The panel will stay ${UNAVAILABLE_TEXT} instead of inventing values.
                </div>
            `;
            return;
        }

        elements.groups.innerHTML = groups.map((group) => `
            <section class="env-metric-group" aria-label="${escapeHtml(group.label)} metrics">
                <h3 class="env-metric-group-title">
                    <span>${escapeHtml(group.label)}</span>
                    <span class="env-metric-group-count">${group.metrics.length} metric${group.metrics.length === 1 ? '' : 's'}</span>
                </h3>
                ${group.metrics.map(([key, sample]) => renderMetricCard(key, sample)).join('')}
            </section>
        `).join('');
    }

    function renderMetricCard(key, sample) {
        const available = isAvailableSample(sample);
        const level = available ? getMetricLevel(key, sample.value) : { key: 'unavailable', progress: 0 };
        const value = available ? formatMetricValue(sample.value) : UNAVAILABLE_TEXT;
        const unit = available && sample.unit ? sample.unit : '';
        const badge = available ? REAL_BADGE_TEXT : UNAVAILABLE_TEXT;
        const source = sample?.source || sample?.provider || UNAVAILABLE_TEXT;
        const timestamp = formatTimestamp(sample?.timestamp);
        const stationLine = renderStationLine(sample?.nearest_observation);
        const reasonLine = !available && sample?.reason
            ? `<span class="env-metric-reason">Reason: ${escapeHtml(sample.reason)}</span>`
            : '';

        return `
            <article class="env-metric-card env-metric-card--${level.key}" style="--env-level: ${level.progress}%">
                <div class="env-metric-topline">
                    <span class="env-metric-name">${escapeHtml(METRIC_LABELS[key] || titleize(key))}</span>
                    <span class="env-real-badge ${available ? 'env-real-badge--ok' : 'env-real-badge--nd'}">${escapeHtml(badge)}</span>
                </div>
                <div class="env-metric-value-row">
                    <span class="env-metric-value">${escapeHtml(value)}</span>
                    <span class="env-metric-unit">${escapeHtml(unit)}</span>
                </div>
                <div class="env-level-track" aria-hidden="true"><span class="env-level-fill"></span></div>
                <div class="env-metric-meta">
                    <span class="env-metric-source">Source: ${escapeHtml(source)}</span>
                    <span class="env-metric-timestamp">Timestamp: ${escapeHtml(timestamp)}</span>
                    ${stationLine}
                    ${reasonLine}
                </div>
            </article>
        `;
    }

    function renderStationLine(stationSample) {
        if (!stationSample) {
            return '';
        }

        if (!isAvailableSample(stationSample)) {
            const reason = stationSample.reason ? ` (${stationSample.reason})` : '';
            return `<span class="env-metric-station">OpenAQ station: ${UNAVAILABLE_TEXT}${escapeHtml(reason)}</span>`;
        }

        const stationName = stationSample.station?.name || 'nearest station';
        const value = formatMetricValue(stationSample.value);
        const unit = stationSample.unit || '';
        const timestamp = formatTimestamp(stationSample.timestamp);
        return `<span class="env-metric-station">OpenAQ ${escapeHtml(stationName)}: ${escapeHtml(value)} ${escapeHtml(unit)} - ${escapeHtml(timestamp)}</span>`;
    }

    function buildGroups(pathologies, pollutants) {
        const entries = Object.entries(pollutants).filter(([key]) => key !== 'european_aqi');
        const used = new Set();
        const groups = [];

        pathologies.forEach((pathology) => {
            const config = PATHOLOGY_CONFIG[pathology] || PATHOLOGY_CONFIG.default;
            const metrics = config.metrics
                .filter((key) => pollutants[key])
                .map((key) => {
                    used.add(key);
                    return [key, pollutants[key]];
                });

            if (metrics.length) {
                groups.push({ label: config.label, metrics });
            }
        });

        const ungrouped = entries.filter(([key]) => !used.has(key));
        if (ungrouped.length) {
            groups.push({ label: 'Other returned metrics', metrics: ungrouped });
        }

        return groups;
    }

    function updateContext(point, pathologies) {
        elements.pathologies.textContent = `Pathology: ${pathologies.map(getPathologyLabel).join(' + ')}`;
        elements.location.textContent = `Map center: ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
    }

    function getSelectedPathologies() {
        const selectedValue = elements.patientCondition?.value;
        const globalCondition = window.currentPatientCondition?.name;
        const raw = selectedValue && selectedValue !== 'none'
            ? selectedValue
            : (globalCondition && globalCondition !== 'default' ? globalCondition : 'default');

        const pathologies = String(raw)
            .split(',')
            .map((value) => value.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_'))
            .filter(Boolean)
            .map(normalizePathology);

        return Array.from(new Set(pathologies.length ? pathologies : ['default']));
    }

    function getCurrentPoint() {
        if (window.map && typeof window.map.getCenter === 'function') {
            const center = window.map.getCenter();
            return { lat: Number(center.lat), lon: Number(center.lng) };
        }
        return { lat: 44.645819, lon: 10.925719 };
    }
});

function isAvailableSample(sample) {
    const status = String(sample?.status || '').toLowerCase();
    return Boolean(sample && ['available', 'ok'].includes(status) && sample.value !== null && sample.value !== undefined);
}

function getMetricLevel(key, rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
        return { key: 'unavailable', label: UNAVAILABLE_TEXT, progress: 0 };
    }

    const thresholds = LEVEL_THRESHOLDS[key] || [20, 40, 60, 80, 100];
    const labels = key === 'european_aqi'
        ? ['Buona', 'Discreta', 'Moderata', 'Scarsa', 'Molto scarsa', 'Estrema']
        : ['Low impact', 'Watch', 'Moderate', 'High', 'Very high', 'Extreme'];
    const classes = ['good', 'fair', 'moderate', 'poor', 'very-poor', 'extreme'];
    const index = thresholds.findIndex((threshold) => value <= threshold);
    const levelIndex = index === -1 ? thresholds.length : index;
    const max = thresholds[thresholds.length - 1] || 100;
    const progress = Math.max(6, Math.min(100, Math.round((value / max) * 100)));

    return {
        key: classes[levelIndex] || 'extreme',
        label: labels[levelIndex] || labels[labels.length - 1],
        progress
    };
}

function formatMetricValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return UNAVAILABLE_TEXT;
    }
    if (Math.abs(number) >= 100 || Number.isInteger(number)) {
        return String(Math.round(number));
    }
    return number.toFixed(1);
}

function formatTimestamp(timestamp) {
    if (!timestamp) {
        return UNAVAILABLE_TEXT;
    }

    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return String(timestamp);
    }

    return new Intl.DateTimeFormat('it-IT', {
        dateStyle: 'short',
        timeStyle: 'short'
    }).format(date);
}

function normalizePathology(value) {
    const aliases = {
        none: 'default',
        standard: 'default',
        respiratory_condition: 'respiratory',
        respiratoria: 'respiratory',
        respiratorio: 'respiratory',
        asthma: 'respiratory',
        asma: 'respiratory',
        allergies: 'allergy',
        allergia: 'allergy',
        allergie: 'allergy',
        cardiopathy: 'cardiac',
        cardiopatie: 'cardiac',
        cardiopatia: 'cardiac',
        cardiaca: 'cardiac',
        cardiaco: 'cardiac',
        bpco: 'copd',
        mental_health: 'mental',
        limited_mobility: 'mobility',
        diabete: 'diabetes'
    };
    return aliases[value] || value || 'default';
}

function getPathologyLabel(pathology) {
    return (PATHOLOGY_CONFIG[pathology] || PATHOLOGY_CONFIG.default).label;
}

function titleize(value) {
    return String(value)
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function waitForMap() {
    return new Promise((resolve, reject) => {
        if (window.map && typeof window.map.on === 'function') {
            resolve(window.map);
            return;
        }

        const startedAt = Date.now();
        const timer = window.setInterval(() => {
            if (window.map && typeof window.map.on === 'function') {
                window.clearInterval(timer);
                resolve(window.map);
                return;
            }

            if (Date.now() - startedAt > 8000) {
                window.clearInterval(timer);
                reject(new Error('Leaflet map not ready'));
            }
        }, 80);
    });
}

function debounce(callback, delayMs) {
    let timeoutId = null;
    return (...args) => {
        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => callback(...args), delayMs);
    };
}
