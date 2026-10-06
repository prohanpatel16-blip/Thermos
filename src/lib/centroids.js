/**
 * THERMOS District Centroids
 * Approximate geographic centroids for NCR districts.
 * Used as the coordinate input for weather API calls.
 * Keys match GeoJSON DISTRICT property values exactly.
 *
 * Note: centroid weather represents the district centre only —
 * it does not claim to represent every point in the district.
 */

const CENTROIDS = {
  // NCT of Delhi districts
  Central:      { lat: 28.6448, lng: 77.2167, state: "NCT of Delhi" },
  East:         { lat: 28.6692, lng: 77.2948, state: "NCT of Delhi" },
  "New Delhi":  { lat: 28.6139, lng: 77.2090, state: "NCT of Delhi" },
  North:        { lat: 28.7191, lng: 77.2080, state: "NCT of Delhi" },
  "North East": { lat: 28.6921, lng: 77.2856, state: "NCT of Delhi" },
  "North West": { lat: 28.7278, lng: 77.1261, state: "NCT of Delhi" },
  South:        { lat: 28.5355, lng: 77.2500, state: "NCT of Delhi" },
  "South West": { lat: 28.5928, lng: 77.0616, state: "NCT of Delhi" },
  West:         { lat: 28.6510, lng: 77.1000, state: "NCT of Delhi" },

  // Uttar Pradesh
  Ghaziabad:            { lat: 28.6692, lng: 77.4538, state: "Uttar Pradesh" },
  "Gautam Buddha Nagar":{ lat: 28.5355, lng: 77.3910, state: "Uttar Pradesh" },

  // Haryana (GeoJSON key = "Gurgaon", display = "Gurugram")
  Gurgaon:   { lat: 28.4595, lng: 77.0266, state: "Haryana" },
  Faridabad: { lat: 28.4089, lng: 77.3178, state: "Haryana" },
};

/**
 * Get centroid for a district by its GeoJSON DISTRICT property value.
 * Returns null if not found.
 *
 * @param {string} districtKey — value of GeoJSON DISTRICT property
 * @returns {{ lat: number, lng: number, state: string } | null}
 */
export function getCentroid(districtKey) {
  return CENTROIDS[districtKey] ?? null;
}
