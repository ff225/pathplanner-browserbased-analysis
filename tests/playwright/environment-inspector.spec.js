const { test, expect } = require('@playwright/test');

const baseURL = process.env.PP_BASE_URL || 'http://localhost:8039';
const screenshotDir = process.env.PP_SCREENSHOT_DIR || 'artifacts/playwright';

test.setTimeout(90000);

async function waitForMapReady(page) {
    await page.waitForFunction(() => window.map && typeof window.map.setView === 'function');
}

async function openInspectorAtRome(page, condition = 'respiratory') {
    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await page.evaluate(() => window.map.setView([41.9028, 12.4964], 13));
    await page.selectOption('#patientCondition', condition);
    await page.locator('#envInspectorToggle').click();
    await expect(page.locator('body')).toHaveClass(/env-inspector-open/);
    await waitForInspectorOpenLayout(page);
}

async function waitForInspectorOpenLayout(page) {
    await page.waitForFunction(() => {
        const panel = document.getElementById('envInspectorPanel')?.getBoundingClientRect();
        return Boolean(
            panel &&
            document.body.classList.contains('env-inspector-open') &&
            panel.right <= window.innerWidth &&
            panel.left >= 0
        );
    });
}

async function dismissToasts(page) {
    await page.evaluate(() => {
        document.querySelectorAll('#toast-container, .toast').forEach((element) => element.remove());
    });
}

test('right environmental drawer renders real values with source and timestamp', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });

    const environmentResponse = page.waitForResponse(
        (response) => response.url().includes('/api/environment') && response.status() === 200,
        { timeout: 70000 }
    );

    await openInspectorAtRome(page, 'respiratory');
    await environmentResponse;

    await expect(page.locator('#envInspectorAqi .env-real-badge--ok')).toContainText('REALE', { timeout: 70000 });
    await expect(page.locator('.env-metric-card .env-real-badge--ok').first()).toContainText('REALE');
    await expect(page.locator('.env-metric-source').first()).toContainText('Source:');
    await expect(page.locator('.env-metric-timestamp').first()).toContainText('Timestamp:');
    await expect(page.locator('#envInspectorStatus')).toContainText('Loaded');

    const metrics = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.env-metric-card'));
        const availableCards = cards.filter((card) => card.querySelector('.env-real-badge--ok'));
        const values = availableCards.map((card) => card.querySelector('.env-metric-value')?.textContent?.trim());
        const timestamps = availableCards.map((card) => card.querySelector('.env-metric-timestamp')?.textContent?.trim());

        return {
            bodyOpen: document.body.classList.contains('env-inspector-open'),
            cards: cards.length,
            availableCards: availableCards.length,
            hasNumericValue: values.some((value) => value && value !== 'N/D'),
            hasTimestamp: timestamps.some((value) => value && !value.endsWith('N/D')),
            panelRight: Math.round(document.getElementById('envInspectorPanel').getBoundingClientRect().right),
            pageScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth
        };
    });

    expect(metrics.bodyOpen).toBe(true);
    expect(metrics.cards).toBeGreaterThanOrEqual(3);
    expect(metrics.availableCards).toBeGreaterThanOrEqual(1);
    expect(metrics.hasNumericValue).toBe(true);
    expect(metrics.hasTimestamp).toBe(true);
    expect(metrics.panelRight).toBeLessThanOrEqual(1920);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await dismissToasts(page);
    await page.screenshot({ path: `${screenshotDir}/pp-env-inspector-real.png`, fullPage: false });

    await page.locator('#envInspectorClose').click();
    await expect(page.locator('body')).not.toHaveClass(/env-inspector-open/);
});

test('right environmental drawer keeps unavailable metrics as N/D', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.route('**/api/environment?**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                generated_at: '2026-06-20T16:00:00Z',
                pathologies: ['respiratory'],
                relevant_pollutants: ['european_aqi', 'pm2_5'],
                lat: 41.9028,
                lon: 12.4964,
                overall_aqi: {
                    key: 'european_aqi',
                    value: 42,
                    unit: 'EAQI',
                    source: 'Open-Meteo Air Quality API',
                    timestamp: '2026-06-20T16:00:00Z',
                    lat: 41.9,
                    lon: 12.5,
                    status: 'ok'
                },
                pollutants: {
                    european_aqi: {
                        key: 'european_aqi',
                        value: 42,
                        unit: 'EAQI',
                        source: 'Open-Meteo Air Quality API',
                        timestamp: '2026-06-20T16:00:00Z',
                        lat: 41.9,
                        lon: 12.5,
                        status: 'ok'
                    },
                    pm2_5: {
                        key: 'pm2_5',
                        value: null,
                        unit: 'ug/m3',
                        source: 'Open-Meteo Air Quality API',
                        provider: 'Open-Meteo',
                        timestamp: null,
                        lat: 41.9,
                        lon: 12.5,
                        status: 'unavailable',
                        reason: 'test unavailable from upstream API',
                        model: {
                            key: 'pm2_5',
                            value: null,
                            unit: 'ug/m3',
                            source: 'Open-Meteo Air Quality API',
                            timestamp: null,
                            lat: 41.9,
                            lon: 12.5,
                            status: 'unavailable',
                            reason: 'test unavailable from upstream API'
                        },
                        nearest_observation: {
                            key: 'pm2_5',
                            value: null,
                            unit: 'ug/m3',
                            source: 'OpenAQ',
                            timestamp: null,
                            lat: 41.9,
                            lon: 12.5,
                            status: 'unavailable',
                            reason: 'no nearby station measurement for this variable'
                        }
                    }
                }
            })
        });
    });

    await openInspectorAtRome(page, 'respiratory');

    const pm25Card = page.locator('.env-metric-card').filter({ hasText: 'PM2.5' }).first();
    await expect(pm25Card.locator('.env-real-badge--nd')).toContainText('N/D');
    await expect(pm25Card.locator('.env-metric-value')).toHaveText('N/D');
    await expect(pm25Card.locator('.env-metric-reason')).toContainText('test unavailable');
    await expect(pm25Card.locator('.env-metric-station')).toContainText('OpenAQ station: N/D');

    await dismissToasts(page);
    await page.screenshot({ path: `${screenshotDir}/pp-env-inspector-nd.png`, fullPage: false });
});

test('right environmental drawer shows N/D when the API is unavailable', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.route('**/api/environment?**', async (route) => {
        await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'environment API offline in test' })
        });
    });

    await openInspectorAtRome(page, 'respiratory');

    await expect(page.locator('#envInspectorAqi .env-real-badge--nd')).toContainText('N/D');
    await expect(page.locator('#envInspectorAqi .env-aqi-value')).toHaveText('N/D');
    await expect(page.locator('#envInspectorStatus')).toContainText('No fake values');
    await expect(page.locator('.env-empty-state')).toContainText('Values stay N/D');
    await expect(page.locator('.env-real-badge--ok')).toHaveCount(0);

    await dismissToasts(page);
    await page.screenshot({ path: `${screenshotDir}/pp-env-inspector-api-missing.png`, fullPage: false });
});

test('right environmental drawer fits mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route('**/api/environment?**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                pathologies: ['cardiac'],
                lat: 41.9028,
                lon: 12.4964,
                overall_aqi: {
                    key: 'european_aqi',
                    value: 18,
                    unit: 'EAQI',
                    source: 'Open-Meteo Air Quality API',
                    timestamp: '2026-06-20T16:00:00Z',
                    lat: 41.9,
                    lon: 12.5,
                    status: 'ok'
                },
                pollutants: {
                    european_aqi: {
                        key: 'european_aqi',
                        value: 18,
                        unit: 'EAQI',
                        source: 'Open-Meteo Air Quality API',
                        timestamp: '2026-06-20T16:00:00Z',
                        lat: 41.9,
                        lon: 12.5,
                        status: 'ok'
                    },
                    carbon_monoxide: {
                        key: 'carbon_monoxide',
                        value: 138,
                        unit: 'ug/m3',
                        source: 'Open-Meteo Air Quality API',
                        timestamp: '2026-06-20T16:00:00Z',
                        lat: 41.9,
                        lon: 12.5,
                        status: 'ok'
                    }
                }
            })
        });
    });

    await openInspectorAtRome(page, 'cardiac');
    await expect(page.locator('#envInspectorAqi .env-real-badge--ok')).toContainText('REALE');
    await page.waitForFunction(() => {
        const panel = document.getElementById('envInspectorPanel')?.getBoundingClientRect();
        return panel && panel.right <= window.innerWidth && panel.left >= 0;
    });

    const metrics = await page.evaluate(() => {
        const panel = document.getElementById('envInspectorPanel').getBoundingClientRect();
        return {
            panelLeft: panel.left,
            panelRight: panel.right,
            panelWidth: panel.width,
            pageScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth
        };
    });

    expect(metrics.panelLeft).toBeGreaterThanOrEqual(0);
    expect(metrics.panelRight).toBeLessThanOrEqual(375);
    expect(metrics.panelWidth).toBeLessThanOrEqual(375);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await dismissToasts(page);
    await page.screenshot({ path: `${screenshotDir}/pp-env-inspector-mobile.png`, fullPage: false });
});

test('right environmental drawer respects dark theme variables', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.route('**/api/environment?**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'ok',
                pathologies: ['respiratory'],
                lat: 41.9028,
                lon: 12.4964,
                overall_aqi: {
                    key: 'european_aqi',
                    value: 22,
                    unit: 'EAQI',
                    source: 'Open-Meteo Air Quality API',
                    timestamp: '2026-06-20T16:00:00Z',
                    lat: 41.9,
                    lon: 12.5,
                    status: 'ok'
                },
                pollutants: {
                    european_aqi: {
                        key: 'european_aqi',
                        value: 22,
                        unit: 'EAQI',
                        source: 'Open-Meteo Air Quality API',
                        timestamp: '2026-06-20T16:00:00Z',
                        lat: 41.9,
                        lon: 12.5,
                        status: 'ok'
                    },
                    pm10: {
                        key: 'pm10',
                        value: 13.5,
                        unit: 'ug/m3',
                        source: 'Open-Meteo Air Quality API',
                        timestamp: '2026-06-20T16:00:00Z',
                        lat: 41.9,
                        lon: 12.5,
                        status: 'ok'
                    }
                }
            })
        });
    });

    await openInspectorAtRome(page, 'respiratory');
    await expect(page.locator('.env-metric-card .env-real-badge--ok').first()).toContainText('REALE');

    const metrics = await page.evaluate(() => {
        const panel = document.getElementById('envInspectorPanel');
        const card = document.querySelector('.env-metric-card');
        const panelStyle = window.getComputedStyle(panel);
        const cardStyle = window.getComputedStyle(card);
        return {
            panelBackground: panelStyle.backgroundColor,
            cardBackground: cardStyle.backgroundColor,
            cardTextColor: cardStyle.color,
            pageScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth
        };
    });

    expect(metrics.panelBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(metrics.cardBackground).not.toBe('rgba(255, 255, 255, 0.72)');
    expect(metrics.cardTextColor).not.toBe('');
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await dismissToasts(page);
    await page.screenshot({ path: `${screenshotDir}/pp-env-inspector-dark.png`, fullPage: false });
});
