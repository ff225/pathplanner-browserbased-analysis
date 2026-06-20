const { test, expect } = require('@playwright/test');

const baseURL = process.env.PP_BASE_URL || 'http://localhost:8036';
const screenshotDir = process.env.PP_SCREENSHOT_DIR || 'artifacts/playwright';
const screenshotPrefix = process.env.PP_SCREENSHOT_PREFIX || 'pp-directions';
const expectFinalUi = process.env.PP_EXPECT_FINAL_UI !== '0';

const FLORENCE_ROUTE = {
    start: {
        label: 'Viale Alessandro Guidoni, Firenze',
        lat: '43.800837',
        lon: '11.199053',
    },
    end: {
        label: 'Piazza Santa Maria Novella, Firenze',
        lat: '43.776674',
        lon: '11.249118',
    },
};

const ASTAR_TECHNICAL_PATTERN = /A\* Cost|Grid environmental A\*|search nodes|nodes explored|heuristic|raw A\*|real data/i;

async function selectClinicalRoute(page) {
    await page.goto(`${baseURL}/map/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#searchButton', { timeout: 30000 });

    await page.evaluate(() => {
        const transportMode = document.getElementById('transportMode');
        const patientCondition = document.getElementById('patientCondition');
        const useAStarAlgorithm = document.getElementById('useAStarAlgorithm');

        if (transportMode) {
            transportMode.value = 'driving';
            transportMode.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (patientCondition) {
            patientCondition.value = 'respiratory';
            patientCondition.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (useAStarAlgorithm) {
            useAStarAlgorithm.checked = true;
            useAStarAlgorithm.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    await page.waitForFunction(() => (
        window.currentPatientCondition?.isPatientMode &&
        window.currentPatientCondition?.name === 'respiratory'
    ), { timeout: 30000 });

    await page.evaluate((route) => {
        const startPoint = document.getElementById('startPoint');
        const endPoint = document.getElementById('endPoint');

        startPoint.value = route.start.label;
        startPoint.dataset.lat = route.start.lat;
        startPoint.dataset.lon = route.start.lon;
        endPoint.value = route.end.label;
        endPoint.dataset.lat = route.end.lat;
        endPoint.dataset.lon = route.end.lon;

        for (const input of [startPoint, endPoint]) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        for (const suggestions of document.querySelectorAll('.suggestions-container')) {
            suggestions.innerHTML = '';
            suggestions.style.display = 'none';
        }
    }, FLORENCE_ROUTE);

    await page.click('#searchButton');
    await page.waitForSelector('.route-selector .turn-directions-step', { timeout: 120000 });
    await page.waitForTimeout(1000);
}

async function removeToasts(page) {
    await page.evaluate(() => {
        document.querySelectorAll('#toast-container, .toast').forEach(element => element.remove());
    });
}

async function captureMetrics(page) {
    return page.evaluate((technicalPatternSource) => {
        const technicalPattern = new RegExp(technicalPatternSource, 'i');
        const isVisible = (element) => {
            if (!element) return false;
            for (let current = element; current; current = current.parentElement) {
                const ancestorStyle = window.getComputedStyle(current);
                if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden') {
                    return false;
                }
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };

        const routeSelector = document.querySelector('.route-selector');
        const routeItems = Array.from(document.querySelectorAll('.route-selector .route-item'));
        const cardSteps = Array.from(document.querySelectorAll('.turn-directions-list .turn-directions-step')).filter(isVisible);
        const plainRows = Array.from(document.querySelectorAll('.leaflet-routing-container .leaflet-routing-alt tr')).filter(isVisible);

        const invalidCardSteps = cardSteps
            .map((step, index) => {
                const icon = step.querySelector('.turn-directions-icon');
                const body = step.querySelector('.turn-directions-body');
                const type = step.querySelector('.turn-directions-type');
                const text = step.querySelector('.turn-directions-text');
                const distance = step.querySelector('.turn-directions-distance');
                return {
                    index,
                    display: window.getComputedStyle(step).display,
                    hasBody: Boolean(body),
                    hasDistance: Boolean(distance && distance.textContent.trim()),
                    hasIcon: Boolean(icon && icon.querySelector('svg')),
                    hasText: Boolean(text && text.textContent.trim()),
                    hasType: Boolean(type && type.textContent.trim()),
                };
            })
            .filter(step => (
                step.display !== 'grid' ||
                !step.hasIcon ||
                !step.hasBody ||
                !step.hasType ||
                !step.hasText ||
                !step.hasDistance
            ));

        const routeSelectorText = routeSelector ? routeSelector.textContent : '';
        const technicalSnippets = routeItems
            .map(item => item.textContent.replace(/\s+/g, ' ').trim())
            .filter(text => technicalPattern.test(text));

        return {
            cardStepCount: cardSteps.length,
            hasRouteSelector: Boolean(routeSelector),
            invalidCardSteps,
            pageScrollWidth: document.documentElement.scrollWidth,
            plainInstructionRows: plainRows.length,
            routeSelectorText,
            technicalSnippets,
            viewportWidth: window.innerWidth,
        };
    }, ASTAR_TECHNICAL_PATTERN.source);
}

test('turn-by-turn directions hide A* cost metrics and render every visible instruction as a card', async ({ page }) => {
    test.setTimeout(150000);
    await page.setViewportSize({ width: 1920, height: 1080 });

    await selectClinicalRoute(page);
    await removeToasts(page);
    await page.screenshot({ path: `${screenshotDir}/${screenshotPrefix}-desktop.png`, fullPage: false });
    await page.locator('.turn-directions-list').evaluate(list => {
        list.scrollTop = list.scrollHeight;
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${screenshotDir}/${screenshotPrefix}-desktop-scrolled.png`, fullPage: false });

    const metrics = await captureMetrics(page);

    expect(metrics.hasRouteSelector).toBe(true);
    expect(metrics.cardStepCount).toBeGreaterThanOrEqual(3);

    if (expectFinalUi) {
        expect(metrics.technicalSnippets).toEqual([]);
        expect(metrics.invalidCardSteps).toEqual([]);
        expect(metrics.plainInstructionRows).toBe(0);
        expect(metrics.routeSelectorText).not.toMatch(ASTAR_TECHNICAL_PATTERN);
    }

    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
});

test('turn-by-turn directions keep the mobile viewport constrained', async ({ page }) => {
    test.setTimeout(150000);
    await page.setViewportSize({ width: 375, height: 812 });

    await selectClinicalRoute(page);
    await removeToasts(page);
    await page.screenshot({ path: `${screenshotDir}/${screenshotPrefix}-mobile.png`, fullPage: false });

    const metrics = await captureMetrics(page);

    expect(metrics.hasRouteSelector).toBe(true);
    expect(metrics.cardStepCount).toBeGreaterThanOrEqual(1);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    if (expectFinalUi) {
        expect(metrics.technicalSnippets).toEqual([]);
        expect(metrics.invalidCardSteps).toEqual([]);
        expect(metrics.plainInstructionRows).toBe(0);
    }
});
