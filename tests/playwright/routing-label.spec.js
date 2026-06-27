const { test, expect } = require('@playwright/test');

test.skip(true, 'Legacy routing caption spec targets a removed smart-routing caption; current routing control coverage lives in pathplanner-full.spec.js.');

const baseURL = process.env.PP_BASE_URL || 'http://localhost:8034';
const screenshotDir = process.env.PP_SCREENSHOT_DIR || 'artifacts/playwright';

async function getRoutingLabelMetrics(page) {
    return page.evaluate(() => {
        const caption = document.querySelector('.routing-mode-caption');
        const label = document.querySelector('.routing-mode-caption-label');
        const input = document.getElementById('startPoint');
        const sidebar = document.querySelector('.sidebar');

        const captionRect = caption.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const labelStyles = window.getComputedStyle(label);

        return {
            captionCenterOffset: Number(((captionRect.left + captionRect.width / 2) - (sidebarRect.left + sidebarRect.width / 2)).toFixed(2)),
            captionTopGap: Number((captionRect.top - inputRect.bottom).toFixed(2)),
            labelCenterOffset: Number(((labelRect.left + labelRect.width / 2) - (sidebarRect.left + sidebarRect.width / 2)).toFixed(2)),
            labelFontSize: parseFloat(labelStyles.fontSize),
            labelText: label.textContent.trim(),
            pageScrollWidth: document.documentElement.scrollWidth,
            textAlign: labelStyles.textAlign,
            viewportWidth: window.innerWidth,
        };
    });
}

test('routing mode caption is lower, centered, and compact on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.routing-mode-caption-label', { timeout: 30000 });

    const metrics = await getRoutingLabelMetrics(page);

    expect(metrics.labelText).toBe('Environmental A* smart routing (recommended)');
    expect(metrics.captionTopGap).toBeGreaterThanOrEqual(10);
    expect(Math.abs(metrics.captionCenterOffset)).toBeLessThanOrEqual(2);
    expect(Math.abs(metrics.labelCenterOffset)).toBeLessThanOrEqual(2);
    expect(metrics.labelFontSize).toBeLessThanOrEqual(12);
    expect(metrics.labelFontSize).toBeGreaterThanOrEqual(10);
    expect(metrics.textAlign).toBe('center');
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.screenshot({ path: `${screenshotDir}/pp-label-after.png`, fullPage: false });
});

test('routing mode caption keeps mobile layout within the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.routing-mode-caption-label', { timeout: 30000 });

    const metrics = await getRoutingLabelMetrics(page);

    expect(metrics.captionTopGap).toBeGreaterThanOrEqual(10);
    expect(Math.abs(metrics.captionCenterOffset)).toBeLessThanOrEqual(2);
    expect(metrics.labelFontSize).toBeLessThanOrEqual(12);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.screenshot({ path: `${screenshotDir}/pp-label-mobile.png`, fullPage: false });
});
