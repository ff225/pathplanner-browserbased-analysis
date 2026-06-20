const { test, expect } = require('@playwright/test');
const fs = require('fs');

const baseURL = process.env.PP_BASE_URL || 'http://localhost:8024';
const screenshotDir = process.env.PP_SCREENSHOT_DIR || 'artifacts/playwright';
fs.mkdirSync(screenshotDir, { recursive: true });

async function getPreviewMetrics(page) {
    return page.evaluate(() => {
        const map = window.map;

        function flattenLatLngs(latlngs) {
            if (!Array.isArray(latlngs)) return [];
            return latlngs.reduce((acc, latlng) => {
                if (Array.isArray(latlng)) {
                    acc.push(...flattenLatLngs(latlng));
                } else if (latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng)) {
                    acc.push(latlng);
                }
                return acc;
            }, []);
        }

        function distancePointToSegment(point, start, end) {
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const lengthSquared = dx * dx + dy * dy;

            if (lengthSquared === 0) {
                return point.distanceTo(start);
            }

            const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
            return point.distanceTo({ x: start.x + dx * t, y: start.y + dy * t });
        }

        if (!map) {
            return null;
        }

        const layers = Object.values(map._layers || {});
        const previewMarker = layers.find(layer =>
            typeof layer.getLatLng === 'function' &&
            layer.options?.icon?.options?.className === 'route-preview-cursor'
        );
        const markerLatLng = previewMarker?.getLatLng?.();
        const markerPoint = markerLatLng ? map.latLngToLayerPoint(markerLatLng) : null;
        const routeCandidates = layers
            .filter(layer => typeof layer.getLatLngs === 'function')
            .map(layer => flattenLatLngs(layer.getLatLngs()))
            .filter(points => points.length > 2)
            .sort((a, b) => b.length - a.length);
        const route = routeCandidates[0] || [];
        const routePoints = route.map(latlng => map.latLngToLayerPoint(latlng));

        let markerToRoutePx = null;
        if (markerPoint && routePoints.length > 1) {
            markerToRoutePx = routePoints.slice(1).reduce((minDistance, point, index) => {
                return Math.min(minDistance, distancePointToSegment(markerPoint, routePoints[index], point));
            }, Number.POSITIVE_INFINITY);
        }

        const center = map.getCenter();
        const centerPoint = map.latLngToLayerPoint(center);
        const first = route[0] || null;
        const last = route[route.length - 1] || null;

        return {
            zoom: map.getZoom(),
            routePointCount: route.length,
            markerToRoutePx,
            centerToMarkerPx: markerPoint ? centerPoint.distanceTo(markerPoint) : null,
            markerLat: markerLatLng?.lat ?? null,
            markerLng: markerLatLng?.lng ?? null,
            firstLat: first?.lat ?? null,
            firstLng: first?.lng ?? null,
            lastLat: last?.lat ?? null,
            lastLng: last?.lng ?? null
        };
    });
}

test('selected route preview cursor follows route geometry and camera follows marker', async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1920, height: 1080 });

    await page.addInitScript(() => {
        window.PATHPLANNER_BENCHMARK = true;
        window.BENCHMARK_ASTAR_TIMEOUT_MS = 45000;
        window.BENCHMARK_ASTAR_NUM_ROUTES = 1;
        window.BENCHMARK_ASTAR_GRID_M = 500;
    });
    await page.route('https://overpass-api.de/api/interpreter', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ elements: [] })
    }));

    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#map', { timeout: 30000 });
    await page.waitForSelector('#searchButton', { timeout: 30000 });

    await page.evaluate(() => {
        const startPoint = document.getElementById('startPoint');
        const endPoint = document.getElementById('endPoint');
        const transportMode = document.getElementById('transportMode');
        const patientCondition = document.getElementById('patientCondition');

        startPoint.value = 'Unimore campus, Reggio Emilia';
        startPoint.dataset.lat = '44.70251104660425';
        startPoint.dataset.lon = '10.628399396874087';
        endPoint.value = 'Reggio Emilia center';
        endPoint.dataset.lat = '44.6974948';
        endPoint.dataset.lon = '10.6426597';

        if (transportMode) {
            transportMode.value = 'walking';
            transportMode.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (patientCondition) {
            patientCondition.value = 'respiratory';
            patientCondition.dispatchEvent(new Event('change', { bubbles: true }));
        }

        document.querySelectorAll('.suggestions-dropdown, .suggestions-container')
            .forEach(element => {
                element.hidden = true;
                element.style.display = 'none';
            });
    });
    await page.waitForFunction(() => window.currentPatientCondition?.name === 'respiratory', { timeout: 10000 });

    await page.click('#searchButton');
    await page.waitForSelector('.route-selector .route-preview-button:not([disabled])', { timeout: 90000 });

    const previewButton = page.locator('.route-preview-button');
    await expect(previewButton).toBeEnabled();
    await page.waitForFunction(() => {
        const map = window.map;
        if (!map) return false;
        return Object.values(map._layers || {}).some(layer => {
            if (typeof layer.getLatLngs !== 'function') return false;
            const latlngs = layer.getLatLngs();
            const flat = Array.isArray(latlngs) ? latlngs.flat(Infinity) : [];
            return flat.some(item => item && typeof item === 'object' && Number.isFinite(item.lat));
        });
    }, { timeout: 30000 });
    await page.screenshot({ path: `${screenshotDir}/cursor-preview-before.png` });

    const beforeMetrics = await getPreviewMetrics(page);
    expect(beforeMetrics.routePointCount).toBeGreaterThan(2);

    await previewButton.click();
    await page.waitForSelector('.route-preview-cursor', { timeout: 10000 });
    await page.waitForTimeout(550);
    const startMetrics = await getPreviewMetrics(page);
    expect(startMetrics.markerToRoutePx).not.toBeNull();
    expect(startMetrics.markerToRoutePx).toBeLessThan(18);
    expect(startMetrics.zoom).toBeGreaterThan(beforeMetrics.zoom + 0.5);
    expect(startMetrics.centerToMarkerPx).toBeLessThan(120);
    await page.screenshot({ path: `${screenshotDir}/cursor-preview-start.png` });

    await page.waitForTimeout(3250);
    const midMetrics = await getPreviewMetrics(page);
    expect(midMetrics.markerToRoutePx).not.toBeNull();
    expect(midMetrics.markerToRoutePx).toBeLessThan(18);
    expect(midMetrics.centerToMarkerPx).toBeLessThan(180);
    expect(midMetrics.routePointCount).toBeGreaterThan(2);
    await page.screenshot({ path: `${screenshotDir}/cursor-preview-mid.png` });

    await page.waitForTimeout(4200);
    await expect(previewButton).toHaveAttribute('data-preview-state', 'complete', { timeout: 10000 });
    const endMetrics = await getPreviewMetrics(page);
    expect(endMetrics.markerToRoutePx).not.toBeNull();
    expect(endMetrics.markerToRoutePx).toBeLessThan(18);
    await expect.poll(async () => (await getPreviewMetrics(page)).zoom, { timeout: 3000 }).toBeLessThan(startMetrics.zoom);
    await page.screenshot({ path: `${screenshotDir}/cursor-preview-end.png` });

    await previewButton.click();
    await expect(previewButton).toHaveAttribute('data-preview-state', 'running', { timeout: 5000 });

    const routeRadios = page.locator('.route-selector input[name="route-selection"]');
    if (await routeRadios.count() > 1) {
        await routeRadios.nth(1).check({ force: true });
        await expect(page.locator('.route-preview-cursor')).toHaveCount(0, { timeout: 5000 });
    }
});
