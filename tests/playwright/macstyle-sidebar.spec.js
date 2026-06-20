const { test, expect } = require('@playwright/test');

const baseURL = process.env.PP_BASE_URL || 'http://localhost:8035';
const screenshotDir = process.env.PP_SCREENSHOT_DIR || 'logs/jobs';

async function mockSuggestions(page) {
    await page.route('https://api.mapbox.com/search/searchbox/v1/suggest**', async route => {
        await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                suggestions: Array.from({ length: 6 }, (_, index) => ({
                    mapbox_id: `macstyle-place-${index + 1}`,
                    name: index === 0 ? 'Via Emilia' : `Mac result ${index + 1}`,
                    place_formatted: index === 0
                        ? 'Modena, Emilia-Romagna, Italy'
                        : `Compact address ${index + 1}, Italy`,
                })),
            }),
        });
    });

    await page.route('https://api.mapbox.com/search/searchbox/v1/retrieve/**', async route => {
        await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                features: [{
                    geometry: { coordinates: [10.9252, 44.6471] },
                    properties: {
                        full_address: 'Via Emilia, Modena, Italy',
                        name: 'Via Emilia',
                    },
                }],
            }),
        });
    });
}

async function openMapWithSuggestions(page) {
    await mockSuggestions(page);
    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar', { timeout: 30000 });
    await page.fill('#startPoint', 'via emilia');
    await page.waitForSelector('#startPoint-suggestions .suggestion-item', { timeout: 30000 });
}

async function collectMacMetrics(page) {
    return page.evaluate(() => {
        const css = element => window.getComputedStyle(element);
        const sidebar = document.querySelector('.sidebar');
        const shell = document.querySelector('.map-shell');
        const control = document.querySelector('.control-block');
        const input = document.querySelector('#startPoint');
        const inputGroup = input.closest('.input-group');
        const searchButton = document.querySelector('#searchButton');
        const dropdown = document.querySelector('#startPoint-suggestions');
        const routeLabel = document.querySelector('.routing-mode-caption-label');
        const toggle = document.querySelector('#sidebarToggle');

        const dropdownRect = dropdown.getBoundingClientRect();
        const inputGroupRect = inputGroup.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();

        return {
            accent: css(document.body).getPropertyValue('--mac-accent').trim(),
            backdrop: css(sidebar).backdropFilter || css(sidebar).webkitBackdropFilter,
            bodyFont: css(document.body).fontFamily,
            buttonBackground: css(searchButton).backgroundColor,
            buttonRadius: css(searchButton).borderRadius,
            controlBackground: css(control).backgroundColor,
            controlRadius: css(control).borderRadius,
            dropdownBackdrop: css(dropdown).backdropFilter || css(dropdown).webkitBackdropFilter,
            dropdownHeight: dropdownRect.height,
            dropdownRight: dropdownRect.right,
            dropdownWidth: dropdownRect.width,
            inputGroupLeft: inputGroupRect.left,
            inputGroupWidth: inputGroupRect.width,
            inputRadius: css(input).borderRadius,
            pageScrollWidth: document.documentElement.scrollWidth,
            routeLabelFontSize: parseFloat(css(routeLabel).fontSize),
            shellWidth: shell.getBoundingClientRect().width,
            sidebarColor: css(sidebar).color,
            sidebarRight: sidebarRect.right,
            sidebarWidth: sidebarRect.width,
            toggleRadius: css(toggle).borderRadius,
            viewportWidth: window.innerWidth,
        };
    });
}

test('desktop sidebar and controls use macOS light styling without layout regression', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ colorScheme: 'light' });

    await openMapWithSuggestions(page);
    const metrics = await collectMacMetrics(page);

    expect(metrics.accent).toBe('#0a84ff');
    expect(metrics.bodyFont).toContain('-apple-system');
    expect(metrics.backdrop).toContain('blur');
    expect(metrics.dropdownBackdrop).toContain('blur');
    expect(metrics.sidebarColor).toBe('rgb(20, 34, 53)');
    expect(metrics.buttonBackground).toBe('rgb(10, 132, 255)');
    expect(metrics.sidebarWidth).toBeGreaterThanOrEqual(356);
    expect(metrics.sidebarWidth).toBeLessThanOrEqual(364);
    expect(parseFloat(metrics.controlRadius)).toBeGreaterThanOrEqual(11);
    expect(parseFloat(metrics.buttonRadius)).toBeGreaterThanOrEqual(9);
    expect(parseFloat(metrics.toggleRadius)).toBeGreaterThanOrEqual(11);
    expect(metrics.routeLabelFontSize).toBeLessThanOrEqual(12);
    expect(metrics.dropdownHeight).toBeGreaterThan(0);
    expect(metrics.dropdownWidth).toBeLessThanOrEqual(metrics.inputGroupWidth + 1);
    expect(metrics.dropdownRight).toBeLessThanOrEqual(metrics.sidebarRight + 1);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.screenshot({ path: `${screenshotDir}/pp-macstyle-after-light.png`, fullPage: false });
});

test('desktop sidebar keeps the macOS surface legible in dark mode', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ colorScheme: 'dark' });

    await openMapWithSuggestions(page);
    const metrics = await collectMacMetrics(page);

    expect(metrics.backdrop).toContain('blur');
    expect(metrics.dropdownBackdrop).toContain('blur');
    expect(metrics.sidebarColor).toBe('rgb(237, 246, 251)');
    expect(metrics.buttonBackground).toBe('rgb(10, 132, 255)');
    expect(metrics.dropdownRight).toBeLessThanOrEqual(metrics.sidebarRight + 1);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.screenshot({ path: `${screenshotDir}/pp-macstyle-after-dark.png`, fullPage: false });
});

test('mobile sidebar remains scroll-free horizontally with macOS controls', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: 'light' });

    await openMapWithSuggestions(page);
    const metrics = await collectMacMetrics(page);

    expect(metrics.backdrop).toContain('blur');
    expect(metrics.sidebarWidth).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.dropdownRight).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.click('#sidebarToggle');
    await expect(page.locator('#routeSidebar')).toHaveCSS('pointer-events', 'none');
    await page.screenshot({ path: `${screenshotDir}/pp-macstyle-mobile.png`, fullPage: false });
});
