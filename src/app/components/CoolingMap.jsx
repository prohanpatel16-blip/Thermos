"use client";

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Fix Leaflet's broken default icon paths in Next.js/webpack
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// ── Custom SVG markers ─────────────────────────────────────────────────────

function makePinIcon(color, emoji) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
      <path d="M16 0C9.37 0 4 5.37 4 12c0 9 12 28 12 28s12-19 12-28C28 5.37 22.63 0 16 0z"
            fill="${color}" stroke="white" stroke-width="1.5"/>
      <text x="16" y="17" text-anchor="middle" dominant-baseline="middle"
            font-size="13" font-family="sans-serif">${emoji}</text>
    </svg>
  `.trim();
  return L.divIcon({
    html: svg,
    className: "",
    iconSize:   [32, 40],
    iconAnchor: [16, 40],
    popupAnchor:[0, -38],
  });
}

// User location marker: blue pulsing dot
const USER_ICON = L.divIcon({
  html: `
    <div style="
      width:16px;height:16px;background:#2563eb;border:3px solid white;
      border-radius:50%;box-shadow:0 0 0 4px rgba(37,99,235,0.25);
    "></div>
  `,
  className: "",
  iconSize:   [16, 16],
  iconAnchor: [ 8,  8],
  popupAnchor:[ 0, -10],
});

// ── Map re-centring when location changes ──────────────────────────────────

function Recenter({ lat, lng }) {
  const map = useMap();
  useEffect(() => {
    if (lat != null && lng != null) {
      map.setView([lat, lng], 14, { animate: true });
    }
  }, [lat, lng, map]);
  return null;
}

// ── Main map component ─────────────────────────────────────────────────────

export default function CoolingMap({ userLocation, spots, categoryMeta }) {
  // Default centre: Delhi
  const center = userLocation
    ? [userLocation.lat, userLocation.lng]
    : [28.6139, 77.2090];

  return (
    <MapContainer
      center={center}
      zoom={userLocation ? 14 : 11}
      scrollWheelZoom
      style={{ height: "100%", width: "100%" }}
      zoomControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {userLocation && (
        <>
          {/* Re-centre when location updates */}
          <Recenter lat={userLocation.lat} lng={userLocation.lng} />

          {/* User location marker */}
          <Marker
            position={[userLocation.lat, userLocation.lng]}
            icon={USER_ICON}
          >
            <Popup>
              <span style={{ fontFamily: "Montserrat, sans-serif", fontSize: 12, fontWeight: 600 }}>
                Your location
              </span>
            </Popup>
          </Marker>

          {/* 3 km radius circle */}
          <Circle
            center={[userLocation.lat, userLocation.lng]}
            radius={2000}
            pathOptions={{ color: "#2563eb", fillColor: "#2563eb", fillOpacity: 0.04, weight: 1.5, dashArray: "4 4" }}
          />
        </>
      )}

      {/* Cooling spot markers */}
      {spots.map((spot) => {
        const meta  = categoryMeta[spot.category];
        const icon  = makePinIcon(meta.color, meta.emoji);
        return (
          <Marker
            key={spot.id}
            position={[spot.lat, spot.lng]}
            icon={icon}
          >
            <Popup>
              <div style={{ fontFamily: "Montserrat, sans-serif", minWidth: 140 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 2 }}>
                  {spot.name}
                </div>
                <div style={{ fontSize: 11, color: meta.color, fontWeight: 600 }}>
                  {meta.emoji} {meta.label}
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
