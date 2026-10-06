/**
 * THERMOS Thermal Service — frontend client
 * Calls the FastAPI thermal engine for HTSI + thermal metrics.
 * All calculations are done in Python; this file only handles the HTTP call.
 */

const THERMAL_API = process.env.NEXT_PUBLIC_THERMAL_API_URL ?? "http://localhost:8000";

/**
 * @param {{ temperature: number, humidity: number, windSpeed: number, lat: number, lng: number }} params
 * @returns {Promise<ThermalResult>}
 *
 * @typedef {Object} ThermalResult
 * @property {number|null} heat_index
 * @property {number|null} wbgt
 * @property {number|null} utci
 * @property {number|null} solar_radiation
 * @property {number}      htsi
 * @property {string}      htsi_level    — "SAFE" | "CAUTION" | "MODERATE" | "HIGH" | "EXTREME"
 * @property {string}      htsi_label    — human label
 * @property {string}      htsi_color    — hex color for UI
 */
export async function fetchThermalMetrics({ temperature, humidity, windSpeed, lat, lng }) {
  const res = await fetch(`${THERMAL_API}/thermal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      temperature,
      humidity,
      wind_speed: windSpeed,
      lat,
      lng,
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Thermal API error ${res.status}: ${text}`);
  }

  return res.json();
}
