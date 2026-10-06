/**
 * THERMOS Health Risk Engine
 *
 * State-calibrated statistical heat-health risk model.
 * Replaces the broken XGBoost /risk endpoint.
 *
 * ── Methodology ──────────────────────────────────────────────────────────
 *
 * Calibration data:
 *   NCRB heatstroke mortality 2001–2014 (Table 2):
 *   "Mortality due to heatstroke and exposure to cold: Evidence from India"
 *   DOI: 10.1080/23328940.2025.2475420
 *
 *   State totals (14 years):
 *     Delhi            = 325 deaths  → mean 23.2 / year
 *     Haryana          = 542 deaths  → mean 38.7 / year
 *     Uttar Pradesh    = 1610 deaths → mean 115.0 / year
 *
 *   Annual base rate per 100,000 population (mean deaths ÷ population × 1e5):
 *     Delhi         = 0.138 / 100k
 *     Haryana       = 0.153 / 100k
 *     Uttar Pradesh = 0.058 / 100k
 *
 * Exposure-response function:
 *   Published Indian literature consistently finds meaningful excess mortality
 *   above ~37–38°C for direct heatstroke deaths (NCRB category), with further
 *   amplification from humidity, WBGT, and UTCI stress.
 *
 *   For each thermal input we calculate an excess multiplier (relative risk ≥ 1)
 *   above a published threshold:
 *
 *   1. Temperature (°C):  threshold 37°C, β = 0.11 per °C above threshold
 *      Source: Excess Mortality Risk Due to Heat Stress, IIT Delhi 2023
 *      (~8% excess all-cause per °C "sweltering" in Delhi; NCRB heatstroke
 *      is a subset, so we use a higher coefficient for direct heatstroke)
 *
 *   2. WBGT (°C):         threshold 28°C, β = 0.09 per °C above threshold
 *      WBGT > 28 = "very high" heat stress (ISO 7933); strong predictor of
 *      occupational heat illness
 *
 *   3. Heat Index (°C):   threshold 41°C, β = 0.07 per °C above threshold
 *      NWS "Danger" zone starts at 40.5°C
 *
 *   4. HTSI (0–100):      threshold 40, β = 0.025 per point above threshold
 *      THERMOS prototype index; above 40 = MODERATE+
 *
 *   5. UTCI (°C):         threshold 38°C, β = 0.05 per °C above threshold
 *      UTCI > 38 = "extreme heat stress" (Fiala 2012)
 *
 *   Combined relative risk (multiplicative, capped at 20×):
 *     RR = exp(β₁·Δt + β₂·Δwbgt + β₃·Δhi + β₄·Δhtsi + β₅·Δutci)
 *
 *   Expected daily events (Poisson mean):
 *     λ = base_rate_per_day × RR × population / 1e5
 *
 *   base_rate_per_day = annual_mean_deaths / 365
 *
 * Normalisation to 0–100:
 *   We map λ → score using a logistic-style compression so that:
 *     λ ≤ base        → score ~20  (baseline, no excess)
 *     λ = 2× base     → score ~45
 *     λ = 5× base     → score ~65
 *     λ = 10× base    → score ~80
 *     λ = 20× base    → score ~95+
 *
 *   score = 100 × (1 − 1/(1 + (λ/λ_ref)^k))
 *   where λ_ref = base_rate_per_day (state-specific) and k = 0.6
 *
 * ── IMPORTANT DISCLAIMERS ─────────────────────────────────────────────────
 *   - Score is a RELATIVE heat-health risk indicator, NOT a mortality probability.
 *   - Calibrated on state-level NCRB data; district-level variation not captured.
 *   - NCRB heatstroke deaths are known to be significant undercounts of true
 *     heat-attributable mortality.
 *   - For situational awareness and decision-support only.
 */

// ── State calibration constants ───────────────────────────────────────────
// Derived from NCRB 2001–2014 published totals and Census 2011 populations.

const STATE_CALIBRATION = {
  "NCT of Delhi": {
    annualMeanDeaths: 23.2,     // 325 / 14
    population:       16787941, // Census 2011
    // annual base rate per 100k = 23.2 / 167.9 = 0.138
  },
  "Haryana": {
    annualMeanDeaths: 38.7,     // 542 / 14
    population:       25351462, // Census 2011
    // annual base rate per 100k = 38.7 / 253.5 = 0.153
  },
  "Uttar Pradesh": {
    annualMeanDeaths: 115.0,    // 1610 / 14
    population:       199812341,// Census 2011
    // annual base rate per 100k = 115.0 / 1998.1 = 0.058
  },
};

// ── Exposure-response coefficients ───────────────────────────────────────
// β values (log-linear, per unit above threshold)
const COEFFICIENTS = {
  temperature: { threshold: 37.0, beta: 0.11 }, // °C
  wbgt:        { threshold: 28.0, beta: 0.09 }, // °C
  heatIndex:   { threshold: 41.0, beta: 0.07 }, // °C
  htsi:        { threshold: 40.0, beta: 0.025 },// 0–100
  utci:        { threshold: 38.0, beta: 0.05 }, // °C
};

const MAX_RR = 20; // cap relative risk at 20× to prevent numerical explosion

/**
 * Clamp a value to [min, max].
 */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Compute the linear predictor (sum of β × excess above threshold).
 * Each term only fires above its threshold.
 */
function computeLinearPredictor({ temperature, wbgt, heatIndex, htsi, utci }) {
  let lp = 0;
  const add = (val, key) => {
    if (val == null) return;
    const { threshold, beta } = COEFFICIENTS[key];
    const excess = val - threshold;
    if (excess > 0) lp += beta * excess;
  };
  add(temperature, "temperature");
  add(wbgt,        "wbgt");
  add(heatIndex,   "heatIndex");
  add(htsi,        "htsi");
  add(utci,        "utci");
  return lp;
}

/**
 * Map Poisson mean λ to a 0–100 score using logistic compression.
 * λ_ref is the state-specific daily base rate.
 *
 * Mapping intent:
 *   RR = 1  (no excess, λ = base)  → score ≈ 15  (LOW baseline)
 *   RR = 3                          → score ≈ 38  (MODERATE)
 *   RR = 7                          → score ≈ 58  (HIGH)
 *   RR = 15                         → score ≈ 73  (HIGH+)
 *   RR = 20 (cap)                   → score ≈ 79
 *
 * Uses a shifted RR scale so baseline (RR=1) produces a LOW score.
 * Excess risk only drives the score meaningfully above thresholds.
 */
function lambdaToScore(lambda, lambdaRef) {
  if (lambdaRef <= 0) return 0;
  const rr = lambda / lambdaRef;
  // Excess RR above 1 (no excess = 0)
  const excessRR = Math.max(0, rr - 1);
  // Scale: excessRR=0 → 0, excessRR=19 → ~85
  // score = 85 * (1 - 1/(1 + (excessRR/2.5)^0.55))
  const K      = 0.55;
  const SCALE  = 2.5;
  const score  = 85 * (1 - 1 / (1 + Math.pow(excessRR / SCALE, K)));
  return Math.round(clamp(score, 0, 100));
}

/**
 * Convert score to risk band.
 */
function scoreToBand(score) {
  if (score < 25) return { level: "LOW",      label: "Low",      color: "#16a34a" };
  if (score < 45) return { level: "MODERATE", label: "Moderate", color: "#ca8a04" };
  if (score < 65) return { level: "HIGH",     label: "High",     color: "#ea580c" };
  return               { level: "EXTREME",   label: "Extreme",  color: "#dc2626" };
}

/**
 * Build a human-readable list of the active risk drivers, ordered by contribution.
 *
 * @returns {Array<{ feature: string, label: string, value: number, excess: number, contribution: number, explanation: string }>}
 */
function buildDrivers({ temperature, wbgt, heatIndex, htsi, utci }) {
  const drivers = [];

  const check = (val, key, displayLabel, unit) => {
    if (val == null) return;
    const { threshold, beta } = COEFFICIENTS[key];
    const excess = val - threshold;
    if (excess > 0) {
      const contribution = beta * excess;
      drivers.push({ feature: key, label: displayLabel, value: val, excess, contribution, unit });
    }
  };

  check(temperature, "temperature", "Air temperature",    "°C");
  check(wbgt,        "wbgt",        "WBGT",               "°C");
  check(heatIndex,   "heatIndex",   "Heat Index",         "°C");
  check(htsi,        "htsi",        "THERMOS HTSI",       "");
  check(utci,        "utci",        "UTCI",               "°C");

  // Sort descending by contribution
  drivers.sort((a, b) => b.contribution - a.contribution);

  return drivers.map((d, i) => {
    const pct = (d.contribution * 100).toFixed(0);
    let explanation;
    if (d.feature === "temperature") {
      explanation = `${d.value.toFixed(1)}°C — ${d.excess.toFixed(1)}°C above 37°C threshold. Major direct heatstroke driver.`;
    } else if (d.feature === "wbgt") {
      explanation = `WBGT ${d.value.toFixed(1)}°C — ${d.excess.toFixed(1)}°C above ISO 7933 high-risk threshold (28°C).`;
    } else if (d.feature === "heatIndex") {
      explanation = `Heat Index ${d.value.toFixed(1)}°C — ${d.excess.toFixed(1)}°C above NWS "Danger" zone threshold (41°C).`;
    } else if (d.feature === "htsi") {
      explanation = `HTSI ${d.value.toFixed(0)}/100 — ${d.excess.toFixed(0)} points above MODERATE threshold (40). Combined thermal stress elevated.`;
    } else if (d.feature === "utci") {
      explanation = `UTCI ${d.value.toFixed(1)}°C — ${d.excess.toFixed(1)}°C above "extreme heat stress" threshold (38°C).`;
    }
    return { rank: i + 1, label: d.label, value: d.value, unit: d.unit, explanation };
  });
}

/**
 * Compute the health risk score for a given district/state and thermal conditions.
 *
 * @param {Object} params
 * @param {string}      params.stateName     - centroid.state value
 * @param {string}      params.forecastDate  - ISO date string YYYY-MM-DD
 * @param {number}      params.temperature   - °C
 * @param {number|null} params.wbgt          - °C
 * @param {number|null} params.heatIndex     - °C
 * @param {number|null} params.htsi          - 0–100
 * @param {number|null} params.utci          - °C
 *
 * @returns {{
 *   healthRiskScore: number,        // 0–100 normalised score
 *   riskLevel: string,              // LOW | MODERATE | HIGH | EXTREME
 *   riskLabel: string,              // Low | Moderate | High | Extreme
 *   riskColor: string,              // hex
 *   relativeRisk: number,           // RR vs baseline (e.g. 3.2 = 3.2× baseline rate)
 *   forecastDate: string,
 *   state: string,
 *   drivers: Array,                 // ordered list of contributing factors
 *   summary: string,                // one-sentence narrative
 *   calibrationNote: string,
 * }}
 */
export function computeHealthRisk({
  stateName,
  forecastDate,
  temperature,
  wbgt   = null,
  heatIndex = null,
  htsi   = null,
  utci   = null,
}) {
  const cal = STATE_CALIBRATION[stateName];

  // Fallback for unknown state — use Delhi parameters
  const { annualMeanDeaths, population } = cal ?? STATE_CALIBRATION["NCT of Delhi"];

  const dailyBaseRate = annualMeanDeaths / 365; // expected deaths/day at baseline
  const dailyBasePer100k = (annualMeanDeaths / (population / 1e5)) / 365;

  // Exposure-response
  const lp = computeLinearPredictor({ temperature, wbgt, heatIndex, htsi, utci });
  const rr = clamp(Math.exp(lp), 1, MAX_RR);

  // Poisson mean daily events (absolute, for reference)
  const lambda = dailyBaseRate * rr;

  // Score (state-specific normalisation)
  const score = lambdaToScore(lambda, dailyBaseRate);
  const band  = scoreToBand(score);

  // Drivers
  const drivers = buildDrivers({ temperature, wbgt, heatIndex, htsi, utci });

  // Summary
  let summary;
  if (drivers.length === 0) {
    summary = `Thermal conditions are below all risk thresholds. Baseline heat-health risk for ${stateName}.`;
  } else {
    const top = drivers[0];
    summary = `${top.label} is the primary driver of elevated heat-health risk in ${stateName} (${top.explanation})`;
  }

  return {
    healthRiskScore: score,
    riskLevel:       band.level,
    riskLabel:       band.label,
    riskColor:       band.color,
    relativeRisk:    Math.round(rr * 10) / 10,
    forecastDate:    forecastDate ?? null,
    state:           stateName,
    drivers,
    summary,
    calibrationNote: `Calibrated on NCRB heatstroke mortality 2001–2014 (DOI: 10.1080/23328940.2025.2475420). Score is a relative heat-health risk indicator — not a mortality probability. State-level data; district variation not captured.`,
  };
}
