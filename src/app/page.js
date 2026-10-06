import { readFile } from "fs/promises";
import path from "path";
import DashboardClient from "./components/DashboardClient";

// NCR districts to include — keyed as DISTRICT__ST_NM
const NCR_FILTER = new Set([
  "Central__NCT of Delhi",
  "East__NCT of Delhi",
  "New Delhi__NCT of Delhi",
  "North__NCT of Delhi",
  "North East__NCT of Delhi",
  "North West__NCT of Delhi",
  "South__NCT of Delhi",
  "South West__NCT of Delhi",
  "West__NCT of Delhi",
  "Ghaziabad__Uttar Pradesh",
  "Gautam Buddha Nagar__Uttar Pradesh",
  "Gurgaon__Haryana",
  "Faridabad__Haryana",
]);

async function loadGeoJson(filename) {
  const filePath = path.join(process.cwd(), "data", "gis", filename);
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

/** Compute the geographic centroid of a GeoJSON Polygon ring. */
function ringCentroid(ring) {
  const n = ring.length;
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of ring) { sumLng += lng; sumLat += lat; }
  return { lat: sumLat / n, lng: sumLng / n };
}

export default async function Home() {
  const [delhi, haryana, up, wardGeo] = await Promise.all([
    loadGeoJson("NCT_of_Delhi.geojson"),
    loadGeoJson("Haryana.geojson"),
    loadGeoJson("Uttar_Pradesh.geojson"),
    loadGeoJson("wards/delhi_4wards.geojson"),
  ]);

  // NCR district features
  const districtFeatures = [
    ...delhi.features,
    ...haryana.features,
    ...up.features,
  ].filter((f) => {
    const key = `${f.properties.DISTRICT}__${f.properties.ST_NM}`;
    return NCR_FILTER.has(key);
  });

  // Ward features — inject computed centroid + state so DistrictDetail
  // can treat them identically to districts (same weather/thermal pipeline).
  const wardFeatures = wardGeo.features.map((f) => {
    const ring = f.geometry.type === "Polygon"
      ? f.geometry.coordinates[0]
      : f.geometry.coordinates[0][0];
    const { lat, lng } = ringCentroid(ring);
    return {
      ...f,
      properties: {
        ...f.properties,
        // Mirror the district property names so existing map + detail logic
        // can handle wards with zero code changes.
        DISTRICT: f.properties.Ward_Name,
        ST_NM:    "NCT of Delhi",
        _isWard:  true,
        _wardNo:  f.properties.Ward_No,
        _centroidLat: parseFloat(lat.toFixed(6)),
        _centroidLng: parseFloat(lng.toFixed(6)),
      },
    };
  });

  // Merge: districts first, wards second (wards will render on top in Leaflet)
  const allFeatures = [...districtFeatures, ...wardFeatures];

  return <DashboardClient features={allFeatures} />;
}
