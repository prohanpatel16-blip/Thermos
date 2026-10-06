/**
 * THERMOS Risk Service
 *
 * Computes health risk using the state-calibrated statistical model
 * (src/lib/healthRisk.js), calibrated on NCRB heatstroke mortality 2001–2014.
 *
 * No longer calls the FastAPI /risk endpoint — the broken XGBoost model
 * produced 0/100 for all inputs due to feature distribution mismatch.
 */

import { computeHealthRisk } from "@/lib/healthRisk";

/**
 * @param {Object} params
 * @param {string}      params.stateName       - centroid.state value
 * @param {string}      params.forecastDate    - ISO date YYYY-MM-DD
 * @param {number}      params.temperature     - °C
 * @param {number|null} params.wbgt
 * @param {number|null} params.heatIndex
 * @param {number|null} params.htsi
 * @param {number|null} params.utci
 * @returns {Object} RiskResult  (see computeHealthRisk return shape)
 */
export function fetchRiskPrediction({
  stateName,
  forecastDate = null,
  temperature,
  wbgt        = null,
  heatIndex   = null,
  htsi        = null,
  utci        = null,
  // Legacy XGBoost params accepted but not used
  windSpeed,
  solarRadiation,
}) {
  return Promise.resolve(
    computeHealthRisk({
      stateName,
      forecastDate,
      temperature,
      wbgt,
      heatIndex,
      htsi,
      utci,
    })
  );
}
