/**
 * Benchmark bootstrap — exposes window.PathPlannerBenchmark for Playwright / CDP.
 * Load with /map/?benchmark=1 (see templates/map.html).
 */

import { runOdPair } from './benchmarkRunner.js';

window.PATHPLANNER_BENCHMARK = true;

const _benchParams = new URLSearchParams(window.location.search);
const _fullFidelity = _benchParams.get('full') === '1';
const _pedestrian = _benchParams.get('pedestrian') !== '0';

window.BENCHMARK_PEDESTRIAN_MODE = _pedestrian;
window.BENCHMARK_DIRECT_MIN_M = _pedestrian ? 1000 : 0;
window.BENCHMARK_DIRECT_MAX_M = _pedestrian ? 3000 : Infinity;

// Fast + robust defaults for grid automation (still uses real scores.js)
window.BENCHMARK_FAST = !_fullFidelity;
window.BENCHMARK_SKIP_POI = !_fullFidelity;
window.BENCHMARK_MAX_ENV_SAMPLES = _fullFidelity ? 24 : 8;
window.BENCHMARK_MIN_ENV_SAMPLES = _fullFidelity ? 12 : 6;
window.BENCHMARK_MAX_PATTERNS_TO_ROUTE = _fullFidelity ? 4 : 2;
window.BENCHMARK_WAYPOINT_PATTERN_COUNT = _fullFidelity ? 3 : 2;
window.BENCHMARK_MAPBOX_TIMEOUT_MS = _fullFidelity ? 120000 : 90000;
window.BENCHMARK_ASTAR_TIMEOUT_MS = _fullFidelity ? 90000 : 45000;
window.BENCHMARK_ASTAR_NUM_ROUTES = _fullFidelity ? 2 : 1;
window.BENCHMARK_ASTAR_GRID_M = _fullFidelity ? 100 : 150;
window.BENCHMARK_ENV_CONCURRENCY = _fullFidelity ? 3 : 4;
window.BENCHMARK_MAPBOX_CONCURRENCY = 2;

function waitForMap(maxMs = 60000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (window.map && typeof L !== 'undefined') {
                resolve(window.map);
                return;
            }
            if (Date.now() - start > maxMs) {
                reject(new Error('Timed out waiting for window.map'));
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

async function initBenchmark() {
    if (window.toastr) {
        const noop = () => {};
        window.toastr.success = noop;
        window.toastr.info = noop;
        window.toastr.warning = noop;
        window.toastr.error = noop;
    }

    await waitForMap();

    window.PathPlannerBenchmark = {
        ready: true,
        version: '1.2-fast-reliable',
        config: {
            maxEnvSamples: window.BENCHMARK_MAX_ENV_SAMPLES,
            minEnvSamples: window.BENCHMARK_MIN_ENV_SAMPLES,
            maxPatternsToRoute: window.BENCHMARK_MAX_PATTERNS_TO_ROUTE,
            skipPoi: window.BENCHMARK_SKIP_POI,
            mapboxTimeoutMs: window.BENCHMARK_MAPBOX_TIMEOUT_MS,
            astarTimeoutMs: window.BENCHMARK_ASTAR_TIMEOUT_MS,
            astarNumRoutes: window.BENCHMARK_ASTAR_NUM_ROUTES,
            astarGridM: window.BENCHMARK_ASTAR_GRID_M,
            envConcurrency: window.BENCHMARK_ENV_CONCURRENCY,
        },
        runPair: async (opts) => runOdPair(opts),
    };

    console.log('[PathPlannerBenchmark] ready (fast mode)', window.PathPlannerBenchmark.config);
    window.dispatchEvent(new CustomEvent('pathplanner-benchmark-ready'));
}

initBenchmark().catch((err) => {
    console.error('[PathPlannerBenchmark] init failed', err);
    window.PathPlannerBenchmark = { ready: false, error: String(err) };
});
