/**
 * THERMOS Weather Service
 * Single source of truth for all Open-Meteo API calls.
 * Returns current conditions and a 5-day daily forecast.
 * Nothing is cached or stored — data is fetched dynamically per district.
 */

const BASE_URL = "https://api.open-meteo.com/v1/forecast";

/**
 * Fetch current weather + 5-day daily forecast for a lat/lng centroid.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{ current: CurrentWeather, forecast: DailyForecast[] }>}
 */
export async function fetchDistrictWeather(lat, lng) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    // Current conditions
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "precipitation",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
    // Daily forecast — 5 days
    daily: [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "relative_humidity_2m_max",
      "relative_humidity_2m_mean",
      "wind_speed_10m_max",
      "wind_speed_10m_mean",
      "precipitation_sum",
      "weathercode",
    ].join(","),
    forecast_days: "5",
    timezone: "Asia/Kolkata",
    wind_speed_unit: "kmh",
  });

  const url = `${BASE_URL}?${params.toString()}`;

  const res = await fetch(url, {
    // next.js: no caching — always fresh
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `Open-Meteo request failed: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();

  const current = parseCurrentWeather(data);
  const forecast = parseDailyForecast(data);

  return { current, forecast };
}

// ── Parsers ────────────────────────────────────────────────────────────────

function parseCurrentWeather(data) {
  const c = data.current;
  const u = data.current_units ?? {};
  return {
    temperature: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    apparentTemperature: c.apparent_temperature,
    precipitation: c.precipitation,
    windSpeed: c.wind_speed_10m,
    windDirection: c.wind_direction_10m,
    time: c.time,
    units: {
      temperature: u.temperature_2m ?? "°C",
      humidity: u.relative_humidity_2m ?? "%",
      windSpeed: u.wind_speed_10m ?? "km/h",
      precipitation: u.precipitation ?? "mm",
    },
  };
}

function parseDailyForecast(data) {
  const d = data.daily;
  if (!d || !d.time) return [];
  return d.time.map((date, i) => ({
    date,
    tempMax:      d.temperature_2m_max?.[i]          ?? null,
    tempMin:      d.temperature_2m_min?.[i]          ?? null,
    tempMean:     d.temperature_2m_mean?.[i]         ?? null,
    precipSum:    d.precipitation_sum?.[i]           ?? null,
    windMax:      d.wind_speed_10m_max?.[i]          ?? null,
    windMean:     d.wind_speed_10m_mean?.[i]         ?? null,
    humidityMax:  d.relative_humidity_2m_max?.[i]    ?? null,
    humidityMean: d.relative_humidity_2m_mean?.[i]   ?? null,
    weatherCode:  d.weathercode?.[i]                 ?? null,
  }));
}

/**
 * Derive a short weather description from WMO weather code.
 * Reference: https://open-meteo.com/en/docs (WMO Weather interpretation codes)
 */
export function wmoDescription(code) {
  if (code === null || code === undefined) return "—";
  if (code === 0) return "Clear sky";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 49) return "Fog";
  if (code <= 59) return "Drizzle";
  if (code <= 69) return "Rain";
  if (code <= 79) return "Snow";
  if (code <= 84) return "Rain showers";
  if (code <= 94) return "Thunderstorm";
  return "Severe storm";
}

/**
 * Convert wind direction degrees to compass label.
 */
export function windBearing(deg) {
  if (deg === null || deg === undefined) return "—";
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

/**
 * Format ISO date string (YYYY-MM-DD) to short label e.g. "Mon 25".
 */
export function formatForecastDate(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
}
