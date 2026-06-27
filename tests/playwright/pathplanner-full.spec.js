const fs = require('fs');
const { test, expect } = require('@playwright/test');

const {
  END_MODENA,
  START_MODENA,
  baseURL,
  clearMapState,
  collectLayoutMetrics,
  collectPageProblems,
  expectNoHorizontalOverflow,
  gotoMap,
  mockLayerData,
  mockMapboxSearch,
  runRealRoute,
  screenshotDir,
  setClinicalControls,
  setRoutePoints,
} = require('./support/pathplanner');

fs.mkdirSync(screenshotDir(), { recursive: true });

test.describe('PathPlanner full GUI regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions([], { origin: baseURL() });
  });

  test('keeps route inputs and preferences when leaving and returning to the map', async ({ page }) => {
    const problems = collectPageProblems(page);

    await mockLayerData(page);
    await clearMapState(page);
    await gotoMap(page);
    await setRoutePoints(page);

    await page.selectOption('#preferenceSet', 'nature_lover');
    await page.selectOption('#transportMode', 'cycling');
    await page.fill('#percentageSlider', '4.5');
    await page.dispatchEvent('#percentageSlider', 'input');

    await expect(page.locator('#preferenceSet')).toHaveValue('nature_lover');
    await expect(page.locator('#transportMode')).toHaveValue('cycling');
    await expect(page.locator('#percentageSlider')).toHaveValue('4.5');

    await page.goto(`${baseURL().replace(/\/$/, '')}/`, { waitUntil: 'domcontentloaded' });
    await gotoMap(page);

    await expect(page.locator('#startPoint')).toHaveValue(START_MODENA.label);
    await expect(page.locator('#endPoint')).toHaveValue(END_MODENA.label);
    await expect(page.locator('#preferenceSet')).toHaveValue('nature_lover');
    await expect(page.locator('#transportMode')).toHaveValue('cycling');
    await expect(page.locator('#percentageSlider')).toHaveValue('4.5');
    await expect(page.locator('#percentageValue')).toContainText('x4.5');

    const restored = await page.evaluate(() => ({
      startLat: document.getElementById('startPoint').dataset.lat,
      startLon: document.getElementById('startPoint').dataset.lon,
      endLat: document.getElementById('endPoint').dataset.lat,
      endLon: document.getElementById('endPoint').dataset.lon,
      preferences: window.currentPreferences,
    }));

    expect(Number(restored.startLat)).toBeCloseTo(START_MODENA.lat, 6);
    expect(Number(restored.startLon)).toBeCloseTo(START_MODENA.lon, 6);
    expect(Number(restored.endLat)).toBeCloseTo(END_MODENA.lat, 6);
    expect(Number(restored.endLon)).toBeCloseTo(END_MODENA.lon, 6);
    expect(restored.preferences.nature).toBe(10);
    await expectNoHorizontalOverflow(page);
    problems.assertClean();
  });

  test('keeps built-in preference presets usable for anonymous users', async ({ page }) => {
    await gotoMap(page);

    const preferenceMetrics = await page.evaluate(() => {
      const preferenceSet = document.getElementById('preferenceSet');
      return {
        options: [...preferenceSet.options].map((option) => ({ value: option.value, text: option.textContent.trim() })),
        disabled: preferenceSet.disabled,
        hasAddEditDelete: Boolean(document.querySelector('.preference-actions')),
      };
    });

    expect(preferenceMetrics.disabled).toBe(false);
    expect(preferenceMetrics.hasAddEditDelete).toBe(false);
    expect(preferenceMetrics.options.map((option) => option.value)).toEqual(expect.arrayContaining([
      'balanced',
      'nature_lover',
      'medical',
      'tourist',
      'entertainment',
      'nightlife',
    ]));

    await page.selectOption('#preferenceSet', 'medical');
    await page.waitForFunction(() => window.currentPreferences?.hospital === 10);
    await expect(page.locator('#preferenceSet')).toHaveValue('medical');

    await page.selectOption('#patientCondition', 'respiratory');
    await page.waitForFunction(() => window.currentPatientCondition?.name === 'respiratory');

    const afterPatientMode = await page.evaluate(() => ({
      preferenceSet: document.getElementById('preferenceSet').value,
      patientName: window.currentPatientCondition.name,
      isPatientMode: window.currentPatientCondition.isPatientMode,
    }));

    expect(afterPatientMode.preferenceSet).toBe('balanced');
    expect(afterPatientMode.patientName).toBe('respiratory');
    expect(afterPatientMode.isPatientMode).toBe(true);
  });

  test('address autocomplete stays inside the sidebar and selects coordinates', async ({ page }) => {
    await mockMapboxSearch(page);
    await gotoMap(page);

    await page.fill('#startPoint', 'Via Emilia Est');
    const suggestions = page.locator('#startPoint-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#startPoint-suggestions .suggestion-item')).toHaveCount(10);

    const metrics = await page.evaluate(() => {
      const sidebar = document.getElementById('routeSidebar').getBoundingClientRect();
      const inputGroup = document.getElementById('startPoint').closest('.input-group').getBoundingClientRect();
      const panel = document.getElementById('startPoint-suggestions').getBoundingClientRect();
      return {
        panelLeft: panel.left,
        panelRight: panel.right,
        panelWidth: panel.width,
        inputLeft: inputGroup.left,
        inputWidth: inputGroup.width,
        sidebarRight: sidebar.right,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });

    expect(metrics.panelLeft).toBeGreaterThanOrEqual(metrics.inputLeft - 1);
    expect(metrics.panelWidth).toBeLessThanOrEqual(metrics.inputWidth + 1);
    expect(metrics.panelRight).toBeLessThanOrEqual(metrics.sidebarRight + 1);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2);

    await page.locator('#startPoint-suggestions .suggestion-item').first().click();
    await expect(suggestions).toBeHidden();
    await expect(page.locator('#startPoint')).toHaveValue('Via Emilia Est 387');

    const selected = await page.evaluate(() => ({
      lat: document.getElementById('startPoint').dataset.lat,
      lon: document.getElementById('startPoint').dataset.lon,
    }));

    expect(Number(selected.lat)).toBeCloseTo(START_MODENA.lat, 6);
    expect(Number(selected.lon)).toBeCloseTo(START_MODENA.lon, 6);
  });

  test('air quality and pollen layers draw real map overlays before any route is calculated', async ({ page }) => {
    await mockLayerData(page);
    await gotoMap(page);

    for (const layerId of ['pm25', 'pm10', 'no2', 'o3', 'pollen']) {
      await page.click(`#${layerId}`);
      await page.waitForFunction((id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'true', layerId);
      await page.waitForFunction(
        () => document.querySelectorAll('.leaflet-overlay-pane canvas').length > 0,
        { timeout: 20_000 },
      );

      const metrics = await page.evaluate((id) => {
        const legend = document.getElementById('layerLegend');
        const status = document.getElementById('layerStatus');
        return {
          pressed: document.getElementById(id).getAttribute('aria-pressed'),
          activeClass: document.getElementById(id).classList.contains('active-layer'),
          heatCanvasCount: document.querySelectorAll('.leaflet-overlay-pane canvas').length,
          markerCount: document.querySelectorAll('.leaflet-marker-pane .leaflet-marker-icon, .leaflet-marker-pane .marker-cluster').length,
          legendText: legend ? legend.textContent.replace(/\s+/g, ' ').trim() : '',
          statusText: status ? status.textContent.replace(/\s+/g, ' ').trim() : '',
        };
      }, layerId);

      expect(metrics.pressed).toBe('true');
      expect(metrics.activeClass).toBe(true);
      expect(metrics.heatCanvasCount).toBeGreaterThanOrEqual(1);
      expect(`${metrics.legendText} ${metrics.statusText}`).toMatch(/PM2\.5|PM10|NO|O|Pollen|Showing/i);

      await page.click(`#${layerId}`);
      await page.waitForFunction((id) => document.getElementById(id)?.getAttribute('aria-pressed') === 'false', layerId);
    }
  });

  test('real backend route renders deduplicated alternatives, source text, directions, and correct request params', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoMap(page);

    const backendRequests = await runRealRoute(page, {
      transportMode: 'walking',
      patientCondition: 'respiratory',
      preferenceSet: 'balanced',
      distanceTolerance: '5',
    });

    const metrics = await collectLayoutMetrics(page);
    expect(metrics.directionsOpen).toBe(true);
    expect(metrics.routeCardCount).toBeGreaterThanOrEqual(1);
    expect(metrics.uniqueRouteTextCount).toBe(metrics.routeCardCount);
    expect(metrics.stepCount).toBeGreaterThanOrEqual(3);
    expect(metrics.hasSummary).toBe(true);
    expect(metrics.summaryMarginBottom).toBeGreaterThanOrEqual(18);
    expect(metrics.hasExplanationText).toBe(true);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2);

    expect(backendRequests.length).toBeGreaterThanOrEqual(1);
    const requestUrl = new URL(backendRequests[0]);
    expect(requestUrl.searchParams.get('transport_mode')).toBe('walking');
    expect(requestUrl.searchParams.get('condition')).toBe('respiratory');
    expect(requestUrl.searchParams.get('distance_tolerance')).toBe('5');

    if (metrics.routeCardCount > 1) {
      await page.locator('.directions-route-card, .route-item').nth(1).click();
      await page.waitForTimeout(400);
      const afterSwitch = await collectLayoutMetrics(page);
      expect(afterSwitch.routeCardCount).toBe(metrics.routeCardCount);
      expect(afterSwitch.uniqueRouteTextCount).toBe(afterSwitch.routeCardCount);
    }

    const previewButton = page.locator('.directions-route-preview:not(.directions-route-preview--stop)').first();
    const stopPreviewButton = page.locator('.directions-route-preview--stop').first();
    await expect(previewButton).toBeEnabled();
    await previewButton.click();
    await expect(previewButton).toHaveAttribute('data-preview-state', 'running');
    await page.waitForFunction(() => {
      const map = window.map;
      return Boolean(map && Object.values(map._layers || {}).some((layer) => (
        typeof layer.getLatLng === 'function' &&
        layer.options?.icon?.options?.className === 'route-preview-cursor'
      )));
    }, { timeout: 10_000 });
    await expect(stopPreviewButton).toBeEnabled();
    await stopPreviewButton.click();
    await expect(previewButton).not.toHaveAttribute('data-preview-state', 'running');

    await page.screenshot({ path: `${screenshotDir()}/full-route-desktop.png`, fullPage: false });
    problems.assertClean();
  });

  test('route directions fit mobile and closing them restores layer access', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockLayerData(page);
    await gotoMap(page);

    await runRealRoute(page, {
      transportMode: 'walking',
      patientCondition: 'respiratory',
      distanceTolerance: '1',
    });

    let metrics = await collectLayoutMetrics(page);
    expect(metrics.directionsOpen).toBe(true);
    expect(metrics.panelLeft).toBeGreaterThanOrEqual(-1);
    expect(metrics.panelRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2);
    expect(metrics.stepCount).toBeGreaterThanOrEqual(1);

    await page.screenshot({ path: `${screenshotDir()}/full-route-mobile.png`, fullPage: false });
    await page.click('#directionsClose');
    await page.waitForFunction(() => document.getElementById('directionsPanel')?.getAttribute('aria-hidden') === 'true');

    await page.click('#pm25');
    await page.waitForFunction(() => document.getElementById('pm25')?.getAttribute('aria-pressed') === 'true');
    await page.waitForFunction(() => document.querySelectorAll('.leaflet-overlay-pane canvas').length > 0);

    metrics = await collectLayoutMetrics(page);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2);
  });

  test('right environmental drawer opens, refreshes, and never invents missing values', async ({ page }) => {
    await page.route('**/api/environment?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          generated_at: '2026-06-27T12:00:00Z',
          pathologies: ['respiratory'],
          relevant_pollutants: ['european_aqi', 'pm2_5'],
          lat: 44.644,
          lon: 10.946,
          overall_aqi: {
            key: 'european_aqi',
            value: 31,
            unit: 'EAQI',
            source: 'Open-Meteo Air Quality API',
            timestamp: '2026-06-27T12:00:00Z',
            status: 'ok',
          },
          pollutants: {
            european_aqi: {
              key: 'european_aqi',
              value: 31,
              unit: 'EAQI',
              source: 'Open-Meteo Air Quality API',
              timestamp: '2026-06-27T12:00:00Z',
              status: 'ok',
            },
            pm2_5: {
              key: 'pm2_5',
              value: null,
              unit: 'ug/m3',
              source: 'Open-Meteo Air Quality API',
              timestamp: null,
              status: 'unavailable',
              reason: 'test upstream missing value',
              nearest_observation: {
                status: 'unavailable',
                source: 'OpenAQ',
                timestamp: null,
                value: null,
              },
            },
          },
        }),
      });
    });

    await gotoMap(page);
    await page.selectOption('#patientCondition', 'respiratory');
    await page.click('#rightSidebarToggle');
    await expect(page.locator('body')).toHaveClass(/right-sidebar-open/);
    await expect(page.locator('#envInspectorStatus')).toContainText(/Loaded|Updated/i);
    await expect(page.locator('#envInspectorAqi')).toContainText('REALE');

    const pm25Card = page.locator('.env-metric-card').filter({ hasText: 'PM2.5' }).first();
    await expect(pm25Card).toContainText('N/D');
    await expect(pm25Card).toContainText('test upstream missing value');
    await expect(pm25Card).toContainText('OpenAQ station: N/D');

    await page.click('#envInspectorRefresh');
    await expect(page.locator('#envInspectorStatus')).toContainText(/Loaded|Updated/i);
    await expectNoHorizontalOverflow(page);
    await page.click('#envInspectorClose');
    await expect(page.locator('body')).not.toHaveClass(/right-sidebar-open/);
  });
});
