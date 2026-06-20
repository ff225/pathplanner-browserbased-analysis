const { test, expect } = require('@playwright/test');

const baseURL = process.env.PP_BASE_URL || 'http://localhost:8032';
const screenshotDir = process.env.PP_SCREENSHOT_DIR || 'artifacts/playwright';

test('address suggestions stay constrained to the sidebar and select coordinates', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });

    await page.route('https://api.mapbox.com/search/searchbox/v1/suggest**', async route => {
        await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                suggestions: Array.from({ length: 10 }, (_, index) => ({
                    mapbox_id: `mock-place-${index + 1}`,
                    name: index === 0 ? 'Via di Novoli' : `Novoli result ${index + 1}`,
                    place_formatted: index === 0
                        ? 'Firenze, Toscana, Italy'
                        : `Compact address line ${index + 1}, Italy`,
                })),
            }),
        });
    });

    await page.route('https://api.mapbox.com/search/searchbox/v1/retrieve/**', async route => {
        await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                features: [{
                    geometry: { coordinates: [11.2197, 43.7959] },
                    properties: {
                        full_address: 'Via di Novoli, Firenze, Toscana, Italy',
                        name: 'Via di Novoli',
                    },
                }],
            }),
        });
    });

    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await page.fill('#endPoint', 'via novoli');

    const suggestions = page.locator('#endPoint-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#endPoint-suggestions .suggestion-item')).toHaveCount(10);

    const metrics = await page.evaluate(() => {
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
        const inputGroup = document.querySelector('#endPoint').closest('.input-group').getBoundingClientRect();
        const panel = document.querySelector('#endPoint-suggestions').getBoundingClientRect();
        const firstItem = document.querySelector('#endPoint-suggestions .suggestion-item').getBoundingClientRect();
        const map = document.querySelector('#map').getBoundingClientRect();
        const styles = window.getComputedStyle(document.querySelector('#endPoint-suggestions'));

        return {
            firstItemHeight: firstItem.height,
            inputGroupLeft: inputGroup.left,
            inputGroupWidth: inputGroup.width,
            mapLeft: map.left,
            maxHeight: parseFloat(styles.maxHeight),
            pageScrollWidth: document.documentElement.scrollWidth,
            panelHeight: panel.height,
            panelLeft: panel.left,
            panelRight: panel.right,
            panelWidth: panel.width,
            sidebarRight: sidebar.right,
            viewportWidth: window.innerWidth,
        };
    });

    expect(metrics.panelLeft).toBeGreaterThanOrEqual(metrics.inputGroupLeft - 1);
    expect(metrics.panelLeft).toBeLessThanOrEqual(metrics.inputGroupLeft + 1);
    expect(metrics.panelWidth).toBeLessThanOrEqual(metrics.inputGroupWidth + 1);
    expect(metrics.panelRight).toBeLessThanOrEqual(metrics.sidebarRight + 1);
    expect(metrics.panelRight).toBeLessThanOrEqual(metrics.mapLeft + 1);
    expect(metrics.panelHeight).toBeLessThanOrEqual(metrics.maxHeight + 1);
    expect(metrics.firstItemHeight).toBeGreaterThanOrEqual(40);
    expect(metrics.firstItemHeight).toBeLessThanOrEqual(56);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.screenshot({ path: `${screenshotDir}/pp-search-layout-after.png`, fullPage: false });
    await page.locator('#endPoint-suggestions .suggestion-item').first().click();

    await expect(suggestions).toBeHidden();
    const selected = await page.locator('#endPoint').evaluate(input => ({
        latitude: input.dataset.lat,
        longitude: input.dataset.lon,
        value: input.value,
    }));

    expect(selected).toEqual({
        latitude: '43.7959',
        longitude: '11.2197',
        value: 'Via di Novoli, Firenze, Toscana, Italy',
    });
});
