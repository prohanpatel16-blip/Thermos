"use client";

import { useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";

// ── Overpass query ─────────────────────────────────────────────────────────
// Searches for malls, cafés, libraries, and community/public centres
// within a given radius (metres) of lat/lng.

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const CATEGORY_META = {
  mall:      { label: "Mall",             emoji: "🏬", color: "#2563eb" },
  cafe:      { label: "Café",             emoji: "☕", color: "#92400e" },
  library:   { label: "Library",          emoji: "📚", color: "#15803d" },
  community: { label: "Community Centre", emoji: "🏢", color: "#7c3aed" },
};

function buildOverpassQuery(lat, lng, radiusM) {
  // Each category uses a union of relevant OSM tags
  return `
[out:json][timeout:25];
(
  node["shop"="mall"](around:${radiusM},${lat},${lng});
  way["shop"="mall"](around:${radiusM},${lat},${lng});
  node["amenity"="cafe"](around:${radiusM},${lat},${lng});
  way["amenity"="cafe"](around:${radiusM},${lat},${lng});
  node["amenity"="library"](around:${radiusM},${lat},${lng});
  way["amenity"="library"](around:${radiusM},${lat},${lng});
  node["amenity"="community_centre"](around:${radiusM},${lat},${lng});
  way["amenity"="community_centre"](around:${radiusM},${lat},${lng});
  node["leisure"="shopping_mall"](around:${radiusM},${lat},${lng});
  way["leisure"="shopping_mall"](around:${radiusM},${lat},${lng});
);
out center;
`.trim();
}

function classifyElement(el) {
  const t = el.tags ?? {};
  if (t.shop === "mall" || t.leisure === "shopping_mall") return "mall";
  if (t.amenity === "cafe") return "cafe";
  if (t.amenity === "library") return "library";
  if (t.amenity === "community_centre") return "community";
  return null;
}

async function fetchCoolingSpots(lat, lng, radiusM = 2000) {
  const query = buildOverpassQuery(lat, lng, 2000);
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const data = await res.json();

  return (data.elements ?? [])
    .map((el) => {
      const cat = classifyElement(el);
      if (!cat) return null;
      // ways return a `center` object; nodes have lat/lon directly
      const lat_ = el.lat ?? el.center?.lat;
      const lng_ = el.lon ?? el.center?.lon;
      if (!lat_ || !lng_) return null;
      return {
        id:       el.id,
        name:     el.tags?.name ?? CATEGORY_META[cat].label,
        category: cat,
        lat:      lat_,
        lng:      lng_,
      };
    })
    .filter(Boolean);
}

// ── Leaflet map — loaded client-side only ──────────────────────────────────

const CoolingMap = dynamic(() => import("./CoolingMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-sm text-gray-400 bg-gray-50">
      Loading map…
    </div>
  ),
});

// ── Main component ─────────────────────────────────────────────────────────

export default function CoolingSpotsClient() {
  const [userLocation, setUserLocation] = useState(null); // { lat, lng }
  const [spots,        setSpots]        = useState([]);
  const [status,       setStatus]       = useState("idle"); // idle | locating | fetching | done | error
  const [errorMsg,     setErrorMsg]     = useState(null);
  const [manualInput,  setManualInput]  = useState("");
  const lastFetchRef   = useRef(null); // cache key "lat,lng" to avoid re-fetch

  // ── Geocode a manual location string via Nominatim ──
  async function geocodeManual(query) {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=in`;
    const res = await fetch(url, {
      headers: { "Accept-Language": "en", "User-Agent": "THERMOS-heatwave-app" },
    });
    if (!res.ok) throw new Error("Geocoding failed");
    const data = await res.json();
    if (!data.length) throw new Error(`No results found for "${query}"`);
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }

  // ── Fetch spots for a given location ──
  const loadSpots = useCallback(async (loc) => {
    const key = `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
    if (lastFetchRef.current === key) return; // avoid duplicate fetch
    lastFetchRef.current = key;

    setUserLocation(loc);
    setStatus("fetching");
    setErrorMsg(null);
    try {
      const results = await fetchCoolingSpots(loc.lat, loc.lng, 3000);
      setSpots(results);
      setStatus("done");
    } catch (e) {
      setErrorMsg(e.message ?? "Failed to load cooling spots.");
      setStatus("error");
    }
  }, []);

  // ── GPS ──
  function handleGPS() {
    if (!navigator.geolocation) {
      setErrorMsg("Geolocation is not supported by your browser.");
      setStatus("error");
      return;
    }
    setStatus("locating");
    setErrorMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => loadSpots({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const msgs = {
          1: "Location access denied. Please allow location permission or enter manually.",
          2: "Location unavailable.",
          3: "Location request timed out.",
        };
        setErrorMsg(msgs[err.code] ?? "Geolocation error.");
        setStatus("error");
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  }

  // ── Manual search ──
  async function handleManualSearch(e) {
    e.preventDefault();
    const q = manualInput.trim();
    if (!q) return;
    setStatus("locating");
    setErrorMsg(null);
    try {
      const loc = await geocodeManual(q);
      await loadSpots(loc);
    } catch (err) {
      setErrorMsg(err.message ?? "Search failed.");
      setStatus("error");
    }
  }

  const isBusy = status === "locating" || status === "fetching";

  // Group spots by category for the list
  const grouped = Object.keys(CATEGORY_META).reduce((acc, cat) => {
    const items = spots.filter((s) => s.category === cat);
    if (items.length) acc[cat] = items;
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-screen bg-[#f4f5f7] overflow-hidden">

      {/* ── Header ── */}
      <header className="flex-none flex items-center justify-between px-5 h-12 bg-[#1a1d23] border-b border-[#2d3139]">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-7 h-7 bg-[#e03131] rounded-sm">
            <span className="text-white text-xs font-bold leading-none">T</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-white font-bold text-sm tracking-wide">THERMOS</span>
            <span className="text-[#6b7280] text-xs font-medium hidden sm:inline">
              Cooling Spots
            </span>
          </div>
        </div>
        <Link
          href="/"
          className="text-xs text-[#9ca3af] hover:text-white font-medium border border-[#374151] hover:border-[#4b5563] px-2.5 py-0.5 rounded-sm transition-colors"
        >
          ← Dashboard
        </Link>
      </header>

      {/* ── Sub-header: controls ── */}
      <div className="flex-none flex items-center gap-3 px-5 h-14 bg-[#212631] border-b border-[#2d3139]">
        {/* GPS button */}
        <button
          onClick={handleGPS}
          disabled={isBusy}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-[#2563eb] hover:bg-[#1d4ed8] disabled:opacity-50 px-3 py-1.5 rounded-sm transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
          </svg>
          Use my location
        </button>

        {/* Divider */}
        <span className="text-[#374151] text-xs">or</span>

        {/* Manual search */}
        <form onSubmit={handleManualSearch} className="flex items-center gap-2 flex-1 max-w-xs">
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            placeholder="Enter area or locality…"
            className="flex-1 bg-[#1a1d23] border border-[#374151] text-white placeholder-[#4b5563] text-xs px-3 py-1.5 rounded-sm outline-none focus:border-[#4b5563]"
          />
          <button
            type="submit"
            disabled={isBusy || !manualInput.trim()}
            className="text-xs font-semibold text-white bg-[#374151] hover:bg-[#4b5563] disabled:opacity-50 px-3 py-1.5 rounded-sm transition-colors"
          >
            Search
          </button>
        </form>

        {/* Status */}
        <div className="ml-auto text-[10px] text-[#6b7280]">
          {status === "locating" && "Locating…"}
          {status === "fetching" && "Finding spots…"}
          {status === "done"     && `${spots.length} spot${spots.length !== 1 ? "s" : ""} found · 2 km radius`}
        </div>
      </div>

      {/* ── Error banner ── */}
      {errorMsg && (
        <div className="flex-none px-5 py-2 bg-red-50 border-b border-red-100 text-xs text-red-600">
          {errorMsg}
        </div>
      )}

      {/* ── Main: map + list ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Map — takes most of the screen */}
        <div className="flex-1 relative">
          {!userLocation && status === "idle" && (
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <div className="bg-white border border-gray-200 rounded-sm px-4 py-3 text-center shadow-sm">
                <div className="text-xs font-semibold text-gray-700 mb-0.5">Find Cooling Spots Near You</div>
                <div className="text-[10px] text-gray-400">Use GPS or enter a location above</div>
              </div>
            </div>
          )}
          <CoolingMap
            userLocation={userLocation}
            spots={spots}
            categoryMeta={CATEGORY_META}
          />
        </div>

        {/* Spots list — right sidebar, only when results exist */}
        {(status === "done" || spots.length > 0) && (
          <div className="flex-none w-64 bg-white border-l border-gray-200 overflow-y-auto">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                Nearby Cooling Spots
              </div>
            </div>

            {spots.length === 0 ? (
              <div className="px-4 py-6 text-xs text-gray-400 text-center leading-snug">
                No cooling spots found within 2 km.<br />
                Try a different location.
              </div>
            ) : (
              Object.entries(grouped).map(([cat, items]) => (
                <div key={cat} className="border-b border-gray-100 last:border-b-0">
                  {/* Category header */}
                  <div className="px-4 py-2 bg-gray-50 flex items-center gap-2">
                    <span className="text-sm leading-none">{CATEGORY_META[cat].emoji}</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      {CATEGORY_META[cat].label}s
                    </span>
                    <span className="ml-auto text-[10px] text-gray-400">{items.length}</span>
                  </div>
                  {/* Items */}
                  <ul>
                    {items.map((s) => (
                      <li
                        key={s.id}
                        className="px-4 py-2 border-b border-gray-50 last:border-b-0 flex items-start gap-2"
                      >
                        <span
                          className="flex-none mt-0.5 w-2 h-2 rounded-full"
                          style={{ backgroundColor: CATEGORY_META[cat].color }}
                        />
                        <span className="text-xs text-gray-700 leading-snug">{s.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
