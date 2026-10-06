/**
 * THERMOS Heat Alerts — state manager
 *
 * Persists alert configuration in localStorage.
 * Handles threshold checks and deduplication so the same risk
 * level doesn't re-trigger an alert within the same calendar day.
 *
 * Future hook-up point:
 *   Replace / supplement the in-app banner by calling a backend
 *   endpoint here (e.g. POST /api/push-notify) when a threshold
 *   is crossed.
 */

const STORAGE_KEY = "thermos_alert_config";
const FIRED_KEY   = "thermos_alert_fired";

// Risk levels that should trigger an alert (ordered ascending)
export const ALERT_LEVELS = ["HIGH", "EXTREME"];

// Human-readable display names for the 13 NCR districts
export const ALERT_DISTRICTS = [
  { DISTRICT: "Central",             ST_NM: "NCT of Delhi",  display: "Central Delhi" },
  { DISTRICT: "East",                ST_NM: "NCT of Delhi",  display: "East Delhi" },
  { DISTRICT: "New Delhi",           ST_NM: "NCT of Delhi",  display: "New Delhi" },
  { DISTRICT: "North",               ST_NM: "NCT of Delhi",  display: "North Delhi" },
  { DISTRICT: "North East",          ST_NM: "NCT of Delhi",  display: "North East Delhi" },
  { DISTRICT: "North West",          ST_NM: "NCT of Delhi",  display: "North West Delhi" },
  { DISTRICT: "South",               ST_NM: "NCT of Delhi",  display: "South Delhi" },
  { DISTRICT: "South West",          ST_NM: "NCT of Delhi",  display: "South West Delhi" },
  { DISTRICT: "West",                ST_NM: "NCT of Delhi",  display: "West Delhi" },
  { DISTRICT: "Ghaziabad",           ST_NM: "Uttar Pradesh", display: "Ghaziabad" },
  { DISTRICT: "Gautam Buddha Nagar", ST_NM: "Uttar Pradesh", display: "Gautam Buddha Nagar" },
  { DISTRICT: "Gurgaon",             ST_NM: "Haryana",       display: "Gurugram" },
  { DISTRICT: "Faridabad",           ST_NM: "Haryana",       display: "Faridabad" },
];

export const STATES = ["NCT of Delhi", "Uttar Pradesh", "Haryana"];

export function districtsByState(stateName) {
  return ALERT_DISTRICTS.filter((d) => d.ST_NM === stateName);
}

export function displayNameFor(district, stNm) {
  return ALERT_DISTRICTS.find(
    (d) => d.DISTRICT === district && d.ST_NM === stNm
  )?.display ?? district;
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * Load saved alert config from localStorage.
 * @returns {{ enabled: boolean, DISTRICT: string, ST_NM: string, display: string } | null}
 */
export function loadAlertConfig() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Save alert config to localStorage.
 * @param {{ enabled: boolean, DISTRICT: string, ST_NM: string, display: string }} config
 */
export function saveAlertConfig(config) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** Remove alert config entirely. */
export function clearAlertConfig() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(FIRED_KEY);
}

// ── Deduplication ─────────────────────────────────────────────────────────
// An alert fires once per {district, riskLevel, date}.
// If the risk level increases beyond what already fired today, fire again.

const RISK_RANK = { LOW: 0, MODERATE: 1, HIGH: 2, EXTREME: 3 };

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function firedRecord() {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(FIRED_KEY) ?? "{}"); }
  catch { return {}; }
}

function saveFiredRecord(rec) {
  if (typeof window === "undefined") return;
  localStorage.setItem(FIRED_KEY, JSON.stringify(rec));
}

/**
 * Check whether a new alert should fire.
 * Returns true (and records the firing) when:
 *   – riskLevel is HIGH or EXTREME, AND
 *   – the risk is higher than the last alert fired for this district today.
 *
 * @param {string} districtKey  - DISTRICT property value
 * @param {string} riskLevel    - "LOW" | "MODERATE" | "HIGH" | "EXTREME"
 * @returns {boolean}
 */
export function shouldFireAlert(districtKey, riskLevel) {
  if (!ALERT_LEVELS.includes(riskLevel)) return false;

  const rec     = firedRecord();
  const dateKey = todayKey();
  const key     = `${districtKey}__${dateKey}`;
  const prevRank = RISK_RANK[rec[key]] ?? -1;
  const currRank = RISK_RANK[riskLevel] ?? 0;

  if (currRank <= prevRank) return false; // already alerted at this level or higher

  rec[key] = riskLevel;
  saveFiredRecord(rec);
  return true;
}

/**
 * Reset today's fired record for a district (e.g. after user changes their district).
 */
export function resetFiredForDistrict(districtKey) {
  const rec     = firedRecord();
  const dateKey = todayKey();
  delete rec[`${districtKey}__${dateKey}`];
  saveFiredRecord(rec);
}
