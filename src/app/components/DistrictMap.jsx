"use client";

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, GeoJSON, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const DISTRICT_LABELS = { Gurgaon: "Gurugram" };
function districtLabel(props) {
  if (props._isWard) return `${props.Ward_Name} (Ward ${props._wardNo})`;
  return DISTRICT_LABELS[props.DISTRICT] ?? props.DISTRICT;
}
function stateLabel(props) { return props.ST_NM ?? ""; }

// ── Colour scheme ─────────────────────────────────────────────────────────
const COLOR_DEFAULT  = "#3b5bdb";
const COLOR_HOVER    = "#1971c2";
const COLOR_SELECTED = "#e03131";

// Wards use amber so they're visually distinct from district blue/red
const WARD_DEFAULT   = "#f59e0b";
const WARD_HOVER     = "#d97706";
const WARD_SELECTED  = "#ea580c";

function featureStyle(feature, selectedDistrict) {
  const props      = feature.properties;
  const isSelected =
    selectedDistrict &&
    selectedDistrict.DISTRICT === props.DISTRICT &&
    selectedDistrict.ST_NM    === props.ST_NM;

  if (props._isWard) {
    return {
      fillColor:   isSelected ? WARD_SELECTED  : WARD_DEFAULT,
      fillOpacity: isSelected ? 0.55 : 0.25,
      color:       isSelected ? WARD_SELECTED  : WARD_DEFAULT,
      weight:      isSelected ? 2.5 : 1.5,
      dashArray:   isSelected ? null : "5 4",
    };
  }
  return {
    fillColor:   isSelected ? COLOR_SELECTED : COLOR_DEFAULT,
    fillOpacity: isSelected ? 0.55 : 0.3,
    color:       isSelected ? COLOR_SELECTED : "#1e3a8a",
    weight:      isSelected ? 2.5 : 1.2,
  };
}

function FitBounds({ geoJsonRef }) {
  const map = useMap();
  useEffect(() => {
    if (!geoJsonRef.current) return;
    try {
      const bounds = geoJsonRef.current.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
    } catch { /* ignore */ }
  }, [geoJsonRef, map]);
  return null;
}

export default function DistrictMap({ features, selectedDistrict, onSelectDistrict }) {
  const geoJsonRef = useRef(null);

  const geoJsonKey = selectedDistrict
    ? `${selectedDistrict.DISTRICT}-${selectedDistrict.ST_NM}`
    : "none";

  function onEachFeature(feature, layer) {
    const props = feature.properties;
    const isWard = !!props._isWard;
    const hoverColor = isWard ? WARD_HOVER    : COLOR_HOVER;

    layer.on({
      mouseover(e) {
        const isSelected =
          selectedDistrict &&
          selectedDistrict.DISTRICT === props.DISTRICT &&
          selectedDistrict.ST_NM    === props.ST_NM;
        if (!isSelected) {
          e.target.setStyle({
            fillOpacity: isWard ? 0.45 : 0.5,
            color:       hoverColor,
            weight:      2,
            dashArray:   null,
          });
        }
        e.target.bringToFront();
      },
      mouseout(e) {
        e.target.setStyle(featureStyle(feature, selectedDistrict));
      },
      click() {
        onSelectDistrict(props);
      },
    });

    const nameLabel = isWard
      ? `${props.Ward_Name}<br/><span style="font-weight:400;font-size:11px;color:#f59e0b">Ward ${props._wardNo} · Delhi</span>`
      : `${districtLabel(props)}<br/><span style="font-weight:400;font-size:11px;color:#6b7280">${stateLabel(props)}</span>`;

    layer.bindTooltip(
      `<div style="font-family:Montserrat,sans-serif;font-size:12px;font-weight:600;line-height:1.4">${nameLabel}</div>`,
      { sticky: true, opacity: 0.97, className: "thermos-tooltip" }
    );
  }

  if (!features || features.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-500">
        Loading map data…
      </div>
    );
  }

  return (
    <MapContainer
      center={[28.65, 77.2]}
      zoom={10}
      scrollWheelZoom
      style={{ height: "100%", width: "100%" }}
      zoomControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        opacity={0.5}
      />
      <GeoJSON
        key={geoJsonKey}
        ref={geoJsonRef}
        data={{ type: "FeatureCollection", features }}
        style={(f) => featureStyle(f, selectedDistrict)}
        onEachFeature={onEachFeature}
      />
      <FitBounds geoJsonRef={geoJsonRef} />
    </MapContainer>
  );
}
