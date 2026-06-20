export let envTiles = null;

/**
 * Load a pre-generated environmental grid JSON.
 * Expected format: [{lat: <centreLat>, lon:<centreLon>, aq:3.1, noise:45, temp:26.5, naturPoi:0.3}]
 * The loader builds a Map keyed by "latIdx|lonIdx" where idx = Math.round(coord*precision).
 */
export async function initEnvIndex(url = '/static/data/env_tiles.json', precision = 1000) {
  // Try absolute path first so it works even when the app is served from /map/ or other sub-paths
  let res = await fetch(url);
  if (!res.ok) {
    // fallback to relative path (old behaviour) – handles dev setups where files are next to html
    res = await fetch('static/data/env_tiles.json');
  }
  if (!res.ok) {
    console.warn('[envTileIndex] No pre-baked env_tiles.json found – continuing without tile cache');
    envTiles = null;
    return false; // signal not loaded
  }
  const data = await res.json();
  envTiles = new Map();
  data.forEach(t => {
    const key = `${Math.round(t.lat*precision)}|${Math.round(t.lon*precision)}`;
    envTiles.set(key, t);
  });
  envTiles.precision = precision;
  console.log(`[envTileIndex] loaded ${data.length} tiles`);
}

export function lookupEnv(lat, lon) {
  if (!envTiles) return null;
  const p = envTiles.precision;
  const key = `${Math.round(lat*p)}|${Math.round(lon*p)}`;
  const t = envTiles.get(key);
  if (!t) return null;
  // Normalize keys to match calculateCost expectations
  return {
    airQuality: t.aq ?? t.airQuality,
    noise: t.noise,
    temperature: t.temp ?? t.temperature,
    humidity: t.hum ?? t.humidity,
    slope: t.slope,            // optional pre-baked slope if available
    greenVisibility: t.greenVis,
    trafficDensity: t.traffic,
    // keep originals as fallback
    ...t
  };
} 