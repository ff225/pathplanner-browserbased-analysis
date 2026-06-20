/**
 * Canonical scoring constants (mirror of static/data/scoring_constants.json).
 * Browser benchmark path: calculateAllScores → calculateRawEnvironmentalScore.
 */
export const SCORING = {
    version: '2026-05-21',
    weightTiers: { high: 3, medium: 2, low: 1 },
    factors: {
        temperature: {
            comfortC: 22,
            bands: {
                comfort: { maxDeviationC: 4, score: 10 },
                moderate: { maxDeviationC: 8, score: 7 },
                stress: { score: 4 },
            },
        },
        humidity: {
            comfortPct: 50,
            bands: {
                comfort: { maxDeviationPct: 15, score: 10 },
                moderate: { maxDeviationPct: 30, score: 7 },
                stress: { score: 4 },
            },
        },
        airQuality: { scaleMax: 10 },
        noise: { scaleMax: 10 },
        slope: {
            sweetSpotBase: 14,
            sensitivitySpan: 10,
            gradeSpanPct: 10,
            minScore: 1,
            maxScore: 10,
        },
    },
    conditionEnvWeights: {
        respiratory: { airQuality: 3, humidity: 2, temperature: 2, slope: 2, noise: 1 },
        cardiac: { slope: 3, temperature: 2, airQuality: 2, noise: 2 },
        mobility: { slope: 3, noise: 1 },
        mental: { noise: 3, temperature: 1, slope: 1 },
        arthritis: { slope: 3, temperature: 2, humidity: 2 },
        diabetes: { slope: 2, temperature: 2, airQuality: 2 },
    },
    conditionPoiEmphasis: {
        respiratory: { poiNature: 2 },
        cardiac: { poiHospital: 2 },
        mobility: { poiHospital: 2 },
        mental: { poiNature: 2, poiEntertainment: 1, poiNightlife: 1 },
        diabetes: { poiHospital: 2 },
    },
    poiScaleFactor: 2,
    totalScoreBlend: {
        default: { environment: 0.55, poi: 0.30, specialized: 0.15 },
        respiratory: { environment: 0.60, poi: 0.20, specialized: 0.20 },
        cardiac: { environment: 0.50, poi: 0.20, specialized: 0.30 },
        mobility: { environment: 0.50, poi: 0.25, specialized: 0.25 },
        mental: { environment: 0.45, poi: 0.30, specialized: 0.25 },
        arthritis: { environment: 0.55, poi: 0.20, specialized: 0.25 },
        diabetes: { environment: 0.50, poi: 0.20, specialized: 0.30 },
    },
    specializedPoi: {
        pointsPerHit: 2,
        maxCountPerType: 5,
        mentalQuietMultiplier: 1.5,
    },
};
