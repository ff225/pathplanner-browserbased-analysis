const { test, expect } = require('@playwright/test');

const baseURL = process.env.PP_BASE_URL || 'http://localhost:8033';
const screenshotDir = process.env.PP_SCREENSHOT_DIR || 'artifacts/playwright';

async function waitForMapReady(page) {
    await page.waitForFunction(() => window.map && typeof window.map.invalidateSize === 'function');
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-tile-loaded').length >= 6);
}

async function getLayoutMetrics(page) {
    return page.evaluate(() => {
        const shell = document.getElementById('mapShell');
        const sidebar = document.getElementById('routeSidebar');
        const mapElement = document.getElementById('map');
        const toggle = document.getElementById('sidebarToggle');
        const sidebarRect = sidebar.getBoundingClientRect();
        const mapRect = mapElement.getBoundingClientRect();
        const loadedTiles = Array.from(document.querySelectorAll('.leaflet-tile-loaded'))
            .map(tile => tile.getBoundingClientRect());

        return {
            collapsed: shell.classList.contains('sidebar-collapsed'),
            mapLeft: mapRect.left,
            mapRight: mapRect.right,
            mapWidth: mapRect.width,
            pageScrollWidth: document.documentElement.scrollWidth,
            sidebarWidth: sidebarRect.width,
            tileBottom: Math.max(...loadedTiles.map(rect => rect.bottom)),
            tileCount: loadedTiles.length,
            tileRight: Math.max(...loadedTiles.map(rect => rect.right)),
            toggleExpanded: toggle.getAttribute('aria-expanded'),
            viewportWidth: window.innerWidth,
        };
    });
}

test('sidebar toggle hides and restores controls while resizing the Leaflet map', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);

    await page.evaluate(() => {
        const originalInvalidateSize = window.map.invalidateSize.bind(window.map);
        window.__sidebarToggleInvalidateCount = 0;
        window.map.invalidateSize = (...args) => {
            window.__sidebarToggleInvalidateCount += 1;
            return originalInvalidateSize(...args);
        };
    });

    await page.screenshot({ path: `${screenshotDir}/pp-toggle-visible.png`, fullPage: false });

    let metrics = await getLayoutMetrics(page);
    expect(metrics.collapsed).toBe(false);
    expect(metrics.sidebarWidth).toBeGreaterThanOrEqual(356);
    expect(metrics.sidebarWidth).toBeLessThanOrEqual(364);
    expect(metrics.mapLeft).toBeCloseTo(metrics.sidebarWidth, 1);
    expect(metrics.toggleExpanded).toBe('true');
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.locator('#sidebarToggle').click();
    await expect(page.locator('#mapShell')).toHaveClass(/sidebar-collapsed/);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.__sidebarToggleInvalidateCount >= 1);
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-tile-loaded').length >= 8);
    await page.screenshot({ path: `${screenshotDir}/pp-toggle-collapsed.png`, fullPage: false });

    metrics = await getLayoutMetrics(page);
    expect(metrics.collapsed).toBe(true);
    expect(metrics.sidebarWidth).toBeLessThanOrEqual(1);
    expect(metrics.mapLeft).toBeLessThanOrEqual(1);
    expect(metrics.mapWidth).toBeGreaterThanOrEqual(1918);
    expect(metrics.toggleExpanded).toBe('false');
    expect(metrics.tileCount).toBeGreaterThanOrEqual(8);
    expect(metrics.tileRight).toBeGreaterThan(metrics.mapRight - 280);
    expect(metrics.tileBottom).toBeGreaterThan(800);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.locator('#sidebarToggle').click();
    await expect(page.locator('#mapShell')).not.toHaveClass(/sidebar-collapsed/);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.__sidebarToggleInvalidateCount >= 2);
    await page.screenshot({ path: `${screenshotDir}/pp-toggle-reopened.png`, fullPage: false });

    metrics = await getLayoutMetrics(page);
    expect(metrics.collapsed).toBe(false);
    expect(metrics.sidebarWidth).toBeGreaterThanOrEqual(356);
    expect(metrics.sidebarWidth).toBeLessThanOrEqual(364);
    expect(metrics.mapLeft).toBeCloseTo(metrics.sidebarWidth, 1);
    expect(metrics.toggleExpanded).toBe('true');
});

test('sidebar toggle keeps the mobile layout within the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);

    let metrics = await getLayoutMetrics(page);
    expect(metrics.sidebarWidth).toBeLessThanOrEqual(375);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.locator('#sidebarToggle').click();
    await expect(page.locator('#mapShell')).toHaveClass(/sidebar-collapsed/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${screenshotDir}/pp-toggle-mobile.png`, fullPage: false });

    metrics = await getLayoutMetrics(page);
    expect(metrics.sidebarWidth).toBeLessThanOrEqual(1);
    expect(metrics.mapWidth).toBeLessThanOrEqual(375);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.toggleExpanded).toBe('false');
});
