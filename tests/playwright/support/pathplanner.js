const { expect } = require('@playwright/test');

const START_MODENA = {
  label: 'Via Emilia Est 387, Modena',
  lat: 44.6398102,
  lon: 10.9424172,
};

const END_MODENA = {
  label: 'Centro Commerciale I Portali, Modena',
  lat: 44.6444776,
  lon: 10.9569078,
};

function baseURL() {
  return process.env.PP_BASE_URL || 'http://127.0.0.1:8765';
}

function screenshotDir() {
  return process.env.PP_SCREENSHOT_DIR || 'artifacts/playwright';
}

async function gotoMap(page) {
  await page.goto(`${baseURL().replace(/\/$/, '')}/map/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => Boolean(window.map && document.getElementById('searchButton') && document.getElementById('pm25')),
    { timeout: 45_000 },
  );
}

async function clearMapState(page) {
  await page.goto(`${baseURL().replace(/\/$/, '')}/map/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.PathPlannerMapState), { timeout: 30_000 });
  await page.evaluate(() => window.PathPlannerMapState.clear());
}

async function setRoutePoints(page, start = START_MODENA, end = END_MODENA) {
  await page.evaluate(({ startPoint, endPoint }) => {
    const applyPoint = (id, point) => {
      const input = document.getElementById(id);
      input.value = point.label;
      input.dataset.lat = String(point.lat);
      input.dataset.lon = String(point.lon);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    applyPoint('startPoint', startPoint);
    applyPoint('endPoint', endPoint);
  }, { startPoint: start, endPoint: end });
}

async function setClinicalControls(page, options = {}) {
  const {
    transportMode = 'walking',
    patientCondition = 'respiratory',
    preferenceSet = 'balanced',
    distanceTolerance = '1',
  } = options;

  await page.evaluate((values) => {
    const selectValue = (id, value) => {
      const element = document.getElementById(id);
      if (!element) return;
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    selectValue('preferenceSet', values.preferenceSet);
    selectValue('transportMode', values.transportMode);
    selectValue('patientCondition', values.patientCondition);

    const slider = document.getElementById('percentageSlider');
    if (slider) {
      slider.value = values.distanceTolerance;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, { transportMode, patientCondition, preferenceSet, distanceTolerance });

  await page.waitForFunction(
    (patientCondition) => document.getElementById('patientCondition')?.value === patientCondition,
    patientCondition,
    { timeout: 10_000 },
  );
}

async function runRealRoute(page, options = {}) {
  const requests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/backend_astar/')) {
      requests.push(request.url());
    }
  });

  await setRoutePoints(page, options.start || START_MODENA, options.end || END_MODENA);
  await setClinicalControls(page, options);
  await page.click('#searchButton');
  await page.waitForFunction(
    () => {
      const panel = document.getElementById('directionsPanel');
      const cards = document.querySelectorAll('.directions-route-card, .route-item');
      const steps = document.querySelectorAll('.directions-step, .turn-directions-step');
      return panel?.getAttribute('aria-hidden') === 'false' && cards.length >= 1 && steps.length >= 1;
    },
    { timeout: 120_000 },
  );
  await page.waitForTimeout(500);
  return requests;
}

async function mockMapboxSearch(page) {
  await page.route('https://api.mapbox.com/search/searchbox/v1/suggest**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        suggestions: [
          {
            mapbox_id: 'modena-via-emilia-est-387',
            name: 'Via Emilia Est 387',
            place_formatted: 'Modena, Emilia-Romagna, Italy',
          },
          ...Array.from({ length: 9 }, (_, index) => ({
            mapbox_id: `modena-extra-${index}`,
            name: `Modena result ${index + 2}`,
            place_formatted: 'Modena, Italy',
          })),
        ],
      }),
    });
  });

  await page.route('https://api.mapbox.com/search/searchbox/v1/retrieve/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        features: [{
          geometry: { coordinates: [START_MODENA.lon, START_MODENA.lat] },
          properties: {
            full_address: START_MODENA.label,
            name: 'Via Emilia Est 387',
          },
        }],
      }),
    });
  });
}

async function mockLayerData(page) {
  await page.route('**/api/stazioni_dati/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          nome: 'Modena urban station',
          prov: 'MO',
          com: 'Modena',
          ind: 'Test station',
          cod: 'MO-1',
          lat: 44.644,
          lng: 10.946,
          pm25: 9.8,
          pm10: 18.5,
          no2: 24.2,
          o3: 68.0,
        },
      ]),
    });
  });

  await page.route('**/api/pollen/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'available',
        lat: 44.644,
        lon: 10.946,
        total: 32,
        timestamp: '2026-06-27T12:00:00Z',
        pollen: {
          alder: { value: 1 },
          birch: { value: 2 },
          grass: { value: 24 },
          mugwort: { value: 3 },
          olive: { value: 2 },
          ragweed: { value: 0 },
        },
      }),
    });
  });
}

async function mockRouteExposureData(page) {
  await page.route('**/api/environment?**', async (route) => {
    const url = new URL(route.request().url());
    const waypoints = (url.searchParams.get('waypoints') || '')
      .split(';')
      .map((raw) => raw.split(',').map(Number))
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    const points = (waypoints.length ? waypoints : [[START_MODENA.lat, START_MODENA.lon]]).map(([lat, lon], index) => ({
      lat,
      lon,
      status: 'available',
      overall_aqi: {
        key: 'european_aqi',
        value: 28 + index,
        unit: 'EAQI',
        source: 'mock route exposure',
        timestamp: '2026-06-28T00:00:00Z',
        status: 'ok',
      },
      pollutants: {
        european_aqi: {
          key: 'european_aqi',
          value: 28 + index,
          unit: 'EAQI',
          source: 'mock route exposure',
          timestamp: '2026-06-28T00:00:00Z',
          status: 'ok',
        },
        pm2_5: {
          key: 'pm2_5',
          value: 7.5 + index / 10,
          unit: 'ug/m3',
          source: 'mock route exposure',
          timestamp: '2026-06-28T00:00:00Z',
          status: 'ok',
        },
        nitrogen_dioxide: {
          key: 'nitrogen_dioxide',
          value: 12 + index / 10,
          unit: 'ug/m3',
          source: 'mock route exposure',
          timestamp: '2026-06-28T00:00:00Z',
          status: 'ok',
        },
        ozone: {
          key: 'ozone',
          value: 80 + index / 5,
          unit: 'ug/m3',
          source: 'mock route exposure',
          timestamp: '2026-06-28T00:00:00Z',
          status: 'ok',
        },
      },
    }));

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'available',
        generated_at: '2026-06-28T00:00:00Z',
        pathologies: ['respiratory'],
        relevant_pollutants: ['european_aqi', 'pm2_5', 'nitrogen_dioxide', 'ozone'],
        points,
      }),
    });
  });
}

async function collectLayoutMetrics(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const panel = document.getElementById('directionsPanel');
    const summary = document.getElementById('directionsSummary');
    const exposureCard = document.querySelector('.route-exposure-card');
    const routeCards = [...document.querySelectorAll('.directions-route-card, .route-item')].filter(visible);
    const steps = [...document.querySelectorAll('.directions-step, .turn-directions-step')].filter(visible);
    const routeTexts = routeCards.map((card) => card.textContent.replace(/\s+/g, ' ').trim());
    const selector = document.getElementById('directionsRouteSelector');
    const selectorRect = selector?.getBoundingClientRect();
    const lastRouteRect = routeCards.length ? routeCards[routeCards.length - 1].getBoundingClientRect() : null;
    const rect = panel?.getBoundingClientRect();
    return {
      directionsOpen: panel?.getAttribute('aria-hidden') === 'false',
      routeCardCount: routeCards.length,
      stepCount: steps.length,
      uniqueRouteTextCount: new Set(routeTexts).size,
      routeTexts,
      routeSelectorBottom: selectorRect ? selectorRect.bottom : null,
      lastRouteCardBottom: lastRouteRect ? lastRouteRect.bottom : null,
      routesClippedBySelector: Boolean(selectorRect && lastRouteRect && lastRouteRect.bottom > selectorRect.bottom + 1),
      hasExplanationText: routeTexts.some((text) => /GraphHopper|OSM|OpenStreetMap|SQLite|Backend|dati reali|real data/i.test(text)),
      hasSummary: !!summary && visible(summary),
      hasRouteExposure: !!exposureCard && visible(exposureCard),
      routeExposureText: exposureCard ? exposureCard.textContent.replace(/\s+/g, ' ').trim() : '',
      summaryMarginBottom: summary ? parseFloat(getComputedStyle(summary).marginBottom) : 0,
      pageScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      panelLeft: rect ? rect.left : null,
      panelRight: rect ? rect.right : null,
      panelBottom: rect ? rect.bottom : null,
      viewportHeight: window.innerHeight,
    };
  });
}

async function expectNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2);
}

function collectPageProblems(page) {
  const consoleErrors = [];
  const requestFailures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) {
      requestFailures.push({ url: request.url(), failure: request.failure() });
    }
  });
  return {
    assertClean() {
      const badConsole = consoleErrors.filter((text) => !/favicon|user denied geolocation|geolocation|Failed to fetch/i.test(text));
      const badRequestFailures = requestFailures.filter((failure) => failure.failure?.errorText !== 'net::ERR_ABORTED');
      expect(badConsole).toEqual([]);
      expect(badRequestFailures).toEqual([]);
    },
  };
}

module.exports = {
  END_MODENA,
  START_MODENA,
  baseURL,
  collectLayoutMetrics,
  collectPageProblems,
  clearMapState,
  expectNoHorizontalOverflow,
  gotoMap,
  mockLayerData,
  mockMapboxSearch,
  mockRouteExposureData,
  runRealRoute,
  screenshotDir,
  setClinicalControls,
  setRoutePoints,
};
