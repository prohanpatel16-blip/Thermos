/**
 * THERMOS Demographic Vulnerability
 *
 * Provides state-level demographic context for a selected district.
 * Data source: data/demographics/state_demographics.json
 *
 * IMPORTANT: All values are STATE-LEVEL aggregates.
 * They are presented as contextual data — not district-specific measurements.
 *
 * ── Two distinct concepts ──────────────────────────────────────────────────
 *
 * 1. AGE VULNERABILITY (physiological susceptibility)
 *    Fixed weights per age group reflecting physiological heat susceptibility.
 *    These are INDEPENDENT of population percentage.
 *    A group with 1% of the population can still have maximum vulnerability.
 *
 *    Age group weights (relative physiological vulnerability):
 *      0–14  → 0.75  (thermoregulation still developing)
 *      15–59 → 0.40  (healthy working-age baseline)
 *      60–79 → 0.85  (reduced heat adaptation, comorbidities)
 *      80+   → 1.00  (highest physiological vulnerability)
 *
 * 2. POPULATION SHARE (exposure context)
 *    What percentage of the state's population belongs to each group.
 *    Used for context — NOT to determine physiological vulnerability.
 *
 * ── Composite Vulnerability Score (0–100) ─────────────────────────────────
 *
 *    Age sub-score:
 *      Weighted sum of (age_weight × population_share_normalised)
 *      for each age group.
 *      Normalised against reference maxima so the score is comparable
 *      across states.
 *      Age sub-score accounts for 70% of the composite.
 *
 *    Outdoor-worker sub-score:
 *      Unchanged from previous implementation.
 *      Normalised against reference maximum of 80%.
 *      Outdoor-worker component accounts for 30% of the composite.
 *
 *    Final = (0.70 × age_sub + 0.30 × ow_sub) × 100, clamped [0,100].
 *
 *    The formula is intentionally transparent and adjustable.
 *    Do NOT interpret this as mortality probability.
 */

import RAW from "../../data/demographics/state_demographics.json";

// ── State key map ──────────────────────────────────────────────────────────
// Maps centroid.state values → JSON top-level keys
const STATE_KEY_MAP = {
  "NCT of Delhi":  "NCT OF DELHI",
  "Haryana":       "HARYANA",
  "Uttar Pradesh": "UTTAR PRADESH",
};

// ── Physiological age-vulnerability weights ────────────────────────────────
// Fixed relative weights — independent of population percentage.
// 80+ must always be the highest (1.00).
export const AGE_WEIGHTS = {
  "0-14":  0.75,
  "15-59": 0.40,
  "60-79": 0.85,
  "80+":   0.95,
};

// ── Population-share normalisation references ──────────────────────────────
// Realistic upper bounds for Indian states (used only for composite scoring).
const POP_REF = {
  "0-14":  45,   // % max reference
  "15-59": 75,   // % max reference
  "60-79": 18,   // % max reference  (60+ minus 80+, approx)
  "80+":    5,   // % max reference
};

// ── Outdoor worker reference (unchanged) ──────────────────────────────────
const OW_REF = 80; // % max reference

// ── Composite score split ──────────────────────────────────────────────────
const AGE_COMPOSITE_WEIGHT = 0.70;
const OW_COMPOSITE_WEIGHT  = 0.30;

/**
 * Clamp value to [min, max].
 */
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Compute the composite vulnerability score (0–100).
 *
 * Age sub-score = Σ (AGE_WEIGHTS[g] × clamp(pop_pct[g] / POP_REF[g], 0, 1))
 *                 divided by Σ AGE_WEIGHTS[g] to normalise to [0,1].
 *
 * OW sub-score  = clamp(outdoorWorkersPct / OW_REF, 0, 1)  [unchanged]
 *
 * @param {number} children0_14Pct    - 0–14 as % of state population
 * @param {number} working15_59Pct    - 15–59 as % of state population
 * @param {number} older60_79Pct      - 60–79 as % (derived: 60+ minus 80+)
 * @param {number} veryElderly80Pct   - 80+ as % of state population
 * @param {number} outdoorWorkersPct  - outdoor/heat-exposed workers as %
 * @returns {number} score 0–100 (integer)
 */
export function computeVulnerabilityScore(
  children0_14Pct,
  working15_59Pct,
  older60_79Pct,
  veryElderly80Pct,
  outdoorWorkersPct
) {
  // Age sub-score: weight × normalised population share
  const totalAgeWeight = Object.values(AGE_WEIGHTS).reduce((a, b) => a + b, 0);

  const ageRaw =
    AGE_WEIGHTS["0-14"]  * clamp(children0_14Pct  / POP_REF["0-14"],  0, 1) +
    AGE_WEIGHTS["15-59"] * clamp(working15_59Pct  / POP_REF["15-59"], 0, 1) +
    AGE_WEIGHTS["60-79"] * clamp(older60_79Pct    / POP_REF["60-79"], 0, 1) +
    AGE_WEIGHTS["80+"]   * clamp(veryElderly80Pct / POP_REF["80+"],   0, 1);

  const ageSub = clamp(ageRaw / totalAgeWeight, 0, 1);

  // Outdoor-worker sub-score (unchanged algorithm)
  const owSub = clamp(outdoorWorkersPct / OW_REF, 0, 1);

  const composite = AGE_COMPOSITE_WEIGHT * ageSub + OW_COMPOSITE_WEIGHT * owSub;
  return Math.round(clamp(composite * 100, 0, 100));
}

/**
 * Look up demographic data for a district's state.
 *
 * @param {string} stateName - value of centroid.state (e.g. "NCT of Delhi")
 * @returns {Object|null}
 *
 * Returned shape:
 * {
 *   stateName:          string,
 *   // Population shares (context only — NOT the vulnerability indicator)
 *   childrenPct:        number,   // 0–14 %
 *   workingAgePct:      number,   // 15–59 %
 *   olderAdultsPct:     number,   // 60–79 % (derived)
 *   veryElderlyPct:     number,   // 80+ %
 *   outdoorWorkersPct:  number,
 *   totalPopulation:    number|null,
 *   // Per-group physiological vulnerability weights (fixed, not population-driven)
 *   ageWeights:         { "0-14": 0.75, "15-59": 0.40, "60-79": 0.85, "80+": 1.00 },
 *   // Composite score
 *   score:              number,   // 0–100
 * }
 */
export function getStateDemographics(stateName) {
  if (!stateName) return null;

  const key = STATE_KEY_MAP[stateName];
  if (!key) return null;

  const d = RAW[key];
  if (!d) return null;

  const childrenPct       = d.children_0_14?.percentage         ?? 0;
  const workingAgePct     = d.working_age_15_59?.percentage      ?? 0;
  const olderAdults60Pct  = d.older_adults_60_plus?.percentage   ?? 0;  // 60+ total
  const veryElderlyPct    = d.very_elderly_80_plus?.percentage   ?? 0;  // 80+
  const outdoorWorkersPct = d.outdoorExposureWorkersPercent       ?? 0;

  // Derive 60–79: (60+ total) minus (80+), floor at 0
  const olderAdultsPct = Math.max(0, olderAdults60Pct - veryElderlyPct);

  const score = computeVulnerabilityScore(
    childrenPct,
    workingAgePct,
    olderAdultsPct,
    veryElderlyPct,
    outdoorWorkersPct
  );

  return {
    stateName,
    // Population shares
    childrenPct,
    workingAgePct,
    olderAdultsPct,      // 60–79 derived
    olderAdults60Pct,    // 60+ total (for reference)
    veryElderlyPct,
    outdoorWorkersPct,
    totalPopulation: d.total_population ?? null,
    // Fixed physiological weights (independent of population share)
    ageWeights: { ...AGE_WEIGHTS },
    // Composite score
    score,
  };
}

/**
 * Return a text band label for the vulnerability score.
 * @param {number} score
 * @returns {string}
 */
export function vulnerabilityBand(score) {
  if (score <= 25) return "Low";
  if (score <= 50) return "Moderate";
  if (score <= 75) return "High";
  return "Very High";
}
