"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import Link from "next/link";
import DistrictDetail from "./DistrictDetail";
import {
  loadAlertConfig,
  saveAlertConfig,
  clearAlertConfig,
  shouldFireAlert,
  resetFiredForDistrict,
  STATES,
  districtsByState,
  displayNameFor,
} from "@/lib/alerts";
import { getCentroid } from "@/lib/centroids";
import { fetchDistrictWeather } from "@/lib/weather";
import { fetchThermalMetrics } from "@/lib/thermal";
import { fetchRiskPrediction } from "@/lib/risk";

// Leaflet requires browser APIs — load with ssr: false
const DistrictMap = dynamic(() => import("./DistrictMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-sm text-gray-400">
      Loading map…
    </div>
  ),
});

// Hardcoded district list — matches GeoJSON DISTRICT + ST_NM properties exactly.
const DISTRICTS = [
  { DISTRICT: "Central",              ST_NM: "NCT of Delhi",   display: "Central Delhi" },
  { DISTRICT: "East",                 ST_NM: "NCT of Delhi",   display: "East Delhi" },
  { DISTRICT: "New Delhi",            ST_NM: "NCT of Delhi",   display: "New Delhi" },
  { DISTRICT: "North",                ST_NM: "NCT of Delhi",   display: "North Delhi" },
  { DISTRICT: "North East",           ST_NM: "NCT of Delhi",   display: "North East Delhi" },
  { DISTRICT: "North West",           ST_NM: "NCT of Delhi",   display: "North West Delhi" },
  { DISTRICT: "South",                ST_NM: "NCT of Delhi",   display: "South Delhi" },
  { DISTRICT: "South West",           ST_NM: "NCT of Delhi",   display: "South West Delhi" },
  { DISTRICT: "West",                 ST_NM: "NCT of Delhi",   display: "West Delhi" },
  { DISTRICT: "Ghaziabad",            ST_NM: "Uttar Pradesh",  display: "Ghaziabad" },
  { DISTRICT: "Gautam Buddha Nagar",  ST_NM: "Uttar Pradesh",  display: "Gautam Buddha Nagar" },
  { DISTRICT: "Gurgaon",              ST_NM: "Haryana",        display: "Gurugram" },
  { DISTRICT: "Faridabad",            ST_NM: "Haryana",        display: "Faridabad" },
];

// ── District search ────────────────────────────────────────────────────────

function DistrictSearch({ onSelect }) {
  const [query,   setQuery]   = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef              = useRef(null);

  const filtered = query.trim().length === 0
    ? DISTRICTS
    : DISTRICTS.filter((d) =>
        d.display.toLowerCase().includes(query.toLowerCase()) ||
        d.ST_NM.toLowerCase().includes(query.toLowerCase())
      );

  function handleSelect(d) {
    setQuery(""); setFocused(false); inputRef.current?.blur();
    onSelect({ DISTRICT: d.DISTRICT, ST_NM: d.ST_NM });
  }

  return (
    <div className="relative w-full max-w-sm">
      <div className={`flex items-center gap-2 bg-white border rounded-sm px-3 py-2 transition-colors ${focused ? "border-gray-400" : "border-gray-300"}`}>
        <svg className="w-3.5 h-3.5 text-gray-400 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="Search district…"
          className="flex-1 text-xs text-gray-700 placeholder-gray-400 outline-none bg-transparent font-medium"
        />
        {query && (
          <button onClick={() => setQuery("")} className="text-gray-300 hover:text-gray-500 flex-none leading-none">×</button>
        )}
      </div>
      {focused && filtered.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-0.5 bg-white border border-gray-200 rounded-sm shadow-sm z-50 max-h-64 overflow-y-auto">
          {filtered.map((d) => (
            <button
              key={`${d.DISTRICT}__${d.ST_NM}`}
              onMouseDown={() => handleSelect(d)}
              className="w-full text-left px-3 py-2 flex items-baseline gap-2 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
            >
              <span className="text-xs font-semibold text-gray-800">{d.display}</span>
              <span className="text-[10px] text-gray-400">{d.ST_NM}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Alert setup modal ──────────────────────────────────────────────────────

function AlertSetupModal({ current, onSave, onDisable, onClose }) {
  const [selectedState,    setSelectedState]    = useState(current?.ST_NM ?? STATES[0]);
  const [selectedDistrict, setSelectedDistrict] = useState(current?.DISTRICT ?? "");

  const stateDistricts = districtsByState(selectedState);

  // Reset district when state changes
  useEffect(() => {
    if (!stateDistricts.find((d) => d.DISTRICT === selectedDistrict)) {
      setSelectedDistrict(stateDistricts[0]?.DISTRICT ?? "");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedState]);

  function handleSave() {
    if (!selectedDistrict) return;
    const meta = stateDistricts.find((d) => d.DISTRICT === selectedDistrict);
    onSave({
      enabled:  true,
      DISTRICT: selectedDistrict,
      ST_NM:    selectedState,
      display:  meta?.display ?? selectedDistrict,
    });
  }

  const selectCls = "w-full bg-[#1a1d27] border border-[#2a2d3a] text-white text-xs rounded px-3 py-2 outline-none focus:border-[#4b5563] appearance-none";
  const labelCls  = "block text-[10px] font-semibold uppercase tracking-widest text-[#6b7280] mb-1.5";

  return (
    /* Backdrop — rendered into document.body via portal to escape Leaflet's stacking context */
    createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60"
      style={{ zIndex: 99999 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-80 rounded-lg border border-[#2a2d3a] bg-[#0f1117] shadow-xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#2a2d3a] bg-[#1a1d27]">
          <div>
            <div className="text-sm font-bold text-white leading-tight">🔔 Heat Alerts</div>
            <div className="text-[10px] text-[#6b7280] mt-0.5">
              Get notified when thermal risk is High or Extreme
            </div>
          </div>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white text-lg leading-none">×</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">

          {/* State */}
          <div>
            <label className={labelCls}>State / UT</label>
            <div className="relative">
              <select
                value={selectedState}
                onChange={(e) => setSelectedState(e.target.value)}
                className={selectCls}
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#6b7280] text-[10px]">▼</span>
            </div>
          </div>

          {/* District */}
          <div>
            <label className={labelCls}>District</label>
            <div className="relative">
              <select
                value={selectedDistrict}
                onChange={(e) => setSelectedDistrict(e.target.value)}
                className={selectCls}
              >
                {stateDistricts.map((d) => (
                  <option key={d.DISTRICT} value={d.DISTRICT}>{d.display}</option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#6b7280] text-[10px]">▼</span>
            </div>
          </div>

          {/* Info note */}
          <div className="rounded px-3 py-2.5 text-[10px] text-[#9ca3af] leading-snug border border-[#2a2d3a] bg-[#1a1d27]">
            THERMOS will check the selected district's forecast thermal risk each time you load the dashboard and show an in-app alert when risk reaches <span className="font-bold text-[#ea580c]">High</span> or <span className="font-bold text-[#dc2626]">Extreme</span>.
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-4 flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={!selectedDistrict}
            className="flex-1 bg-[#e03131] hover:bg-[#c92a2a] disabled:opacity-40 text-white text-xs font-bold py-2 rounded transition-colors"
          >
            {current?.enabled ? "Update Alert Location" : "Enable Alerts"}
          </button>
          {current?.enabled && (
            <button
              onClick={onDisable}
              className="px-3 py-2 text-xs font-semibold text-[#9ca3af] hover:text-white border border-[#2a2d3a] hover:border-[#4b5563] rounded transition-colors"
            >
              Disable
            </button>
          )}
        </div>
      </div>
    </div>
    , document.body)
  );
}

// ── Alert banner (in-app notification) ────────────────────────────────────

const RISK_COLOR = { HIGH: "#ea580c", EXTREME: "#dc2626" };
const HTSI_COLOR = { HIGH: "#ea580c", EXTREME: "#dc2626" };

function AlertBanner({ alert, onDismiss }) {
  if (!alert) return null;

  const color   = RISK_COLOR[alert.riskLevel] ?? "#ea580c";
  const isExt   = alert.riskLevel === "EXTREME";

  return (
    <div
      className="flex-none flex items-center gap-3 px-5 py-2.5 border-b text-sm"
      style={{ background: color + "18", borderColor: color + "44" }}
    >
      {/* Icon */}
      <span className="text-base flex-none">{isExt ? "🚨" : "⚠️"}</span>

      {/* Message */}
      <div className="flex-1 min-w-0">
        <span className="font-bold" style={{ color }}>
          {isExt ? "EXTREME" : "HIGH"} HEAT ALERT
        </span>
        <span className="text-[#d1d5db] ml-2 text-xs">
          {alert.display} — {alert.riskLabel} health risk detected
          {alert.htsiLabel ? ` · HTSI ${alert.htsiLabel}` : ""}
        </span>
      </div>

      {/* CTA */}
      <button
        onClick={onDismiss}
        className="flex-none text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border transition-colors"
        style={{ color, borderColor: color + "66", background: color + "22" }}
      >
        Dismiss
      </button>
    </div>
  );
}

// ── Alert status chip (header) ─────────────────────────────────────────────

function AlertChip({ config, onOpen }) {
  if (!config?.enabled) {
    return (
      <button
        onClick={onOpen}
        className="flex items-center gap-1.5 text-xs text-[#9ca3af] hover:text-white font-medium border border-[#374151] hover:border-[#4b5563] px-2.5 py-1 rounded-sm transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[#374151] inline-block" />
        Enable Alerts
      </button>
    );
  }
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-1.5 text-xs font-medium border px-2.5 py-1 rounded-sm transition-colors text-[#e03131] border-[#e0313133] hover:border-[#e03131] bg-[#e0313111]"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-[#e03131] inline-block animate-pulse" />
      Alerts: {config.display}
    </button>
  );
}

// ── Alert risk check — runs once on mount per session ─────────────────────
// Fetches today's conditions for the alert district, computes thermal+risk,
// checks threshold, and returns an alert object if triggered.
// Future: replace this client-side check with a server push notification.

async function checkAlertRisk(config) {
  const centroid = getCentroid(config.DISTRICT);
  if (!centroid) return null;

  const weather = await fetchDistrictWeather(centroid.lat, centroid.lng);
  const today   = weather.forecast[0];
  if (!today) return null;

  const temperature = weather.current.temperature;
  const humidity    = weather.current.humidity;
  const windSpeed   = weather.current.windSpeed ?? 10;

  const thermal = await fetchThermalMetrics({
    temperature, humidity, windSpeed, lat: centroid.lat, lng: centroid.lng,
  });

  const risk = await fetchRiskPrediction({
    stateName:   centroid.state,
    forecastDate: today.date,
    temperature,
    wbgt:        thermal.wbgt,
    heatIndex:   thermal.heat_index,
    htsi:        thermal.htsi,
    utci:        thermal.utci,
    windSpeed,
    solarRadiation: thermal.solar_radiation,
  });

  // Use the higher of HTSI or health-risk level as the alert trigger
  const RANK = { SAFE: 0, CAUTION: 1, MODERATE: 2, LOW: 0, HIGH: 2, EXTREME: 3 };
  const htsiRank = RANK[thermal.htsi_level] ?? 0;
  const riskRank = RANK[risk.riskLevel]     ?? 0;
  const triggerLevel = riskRank >= htsiRank ? risk.riskLevel : thermal.htsi_level;

  if (!shouldFireAlert(config.DISTRICT, triggerLevel)) return null;

  return {
    riskLevel:  triggerLevel,
    riskLabel:  risk.riskLabel,
    htsiLabel:  thermal.htsi_label,
    display:    config.display,
    DISTRICT:   config.DISTRICT,
  };
}

// ── Main dashboard ─────────────────────────────────────────────────────────

export default function DashboardClient({ features }) {
  const [selectedDistrict, setSelectedDistrict] = useState(null);

  // Alert state
  const [alertConfig,    setAlertConfig]    = useState(null);  // loaded from localStorage
  const [modalOpen,      setModalOpen]      = useState(false);
  const [activeAlert,    setActiveAlert]    = useState(null);  // triggered alert object
  const alertCheckedRef = useRef(false);                       // run check only once

  // Load persisted config on mount
  useEffect(() => {
    const cfg = loadAlertConfig();
    if (cfg?.enabled) setAlertConfig(cfg);
  }, []);

  // Run risk check once after config is loaded (not on every render)
  useEffect(() => {
    if (!alertConfig?.enabled || alertCheckedRef.current) return;
    alertCheckedRef.current = true;

    checkAlertRisk(alertConfig)
      .then((alert) => { if (alert) setActiveAlert(alert); })
      .catch(() => { /* silent — backend may be offline */ });
  }, [alertConfig]);

  function handleSaveAlert(config) {
    // If district changed, reset dedup so the new location can fire immediately
    if (alertConfig && alertConfig.DISTRICT !== config.DISTRICT) {
      resetFiredForDistrict(alertConfig.DISTRICT);
    }
    saveAlertConfig(config);
    setAlertConfig(config);
    setModalOpen(false);
    // Re-run check for the new district
    alertCheckedRef.current = false;
    setActiveAlert(null);
  }

  function handleDisableAlert() {
    clearAlertConfig();
    setAlertConfig(null);
    setActiveAlert(null);
    setModalOpen(false);
  }

  const hasSelection = selectedDistrict !== null;

  return (
    <div className="flex flex-col h-screen bg-[#f4f5f7] overflow-hidden">

      {/* ── Application header ── */}
      <header className="flex-none flex items-center justify-between px-5 h-12 bg-[#1a1d23] border-b border-[#2d3139]">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-7 h-7 bg-[#e03131] rounded-sm">
            <span className="text-white text-xs font-bold leading-none">T</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-white font-bold text-sm tracking-wide">THERMOS</span>
            <span className="text-[#6b7280] text-xs font-medium hidden sm:inline">
              Heatwave Early Warning System
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <AlertChip config={alertConfig} onOpen={() => setModalOpen(true)} />
          <span className="text-[#2d3139] text-xs select-none">|</span>
          <Link
            href="/cooling-spots"
            className="text-xs text-[#9ca3af] hover:text-white font-medium border border-[#374151] hover:border-[#4b5563] px-2.5 py-1 rounded-sm transition-colors"
          >
            🧊 Cooling Spots
          </Link>
        </div>
      </header>

      {/* ── In-app alert banner ── */}
      <AlertBanner alert={activeAlert} onDismiss={() => setActiveAlert(null)} />

      {/* ── Main content ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left panel */}
        {!hasSelection ? (
          <div className="flex-none w-[40%] flex flex-col items-center justify-center px-8 gap-6 border-r border-gray-200 bg-white">
            <div className="w-full max-w-sm">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">
                NCR Districts
              </div>
              <h2 className="text-lg font-bold text-gray-900 leading-tight mb-4">
                Select a district to view<br />thermal stress analysis
              </h2>
              <DistrictSearch onSelect={setSelectedDistrict} />
              <p className="text-[10px] text-gray-400 mt-3">Or click a district on the map →</p>
            </div>

            <div className="w-full max-w-sm">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">
                All districts
              </div>
              <div className="grid grid-cols-2 gap-1">
                {DISTRICTS.map((d) => (
                  <button
                    key={`${d.DISTRICT}__${d.ST_NM}`}
                    onClick={() => setSelectedDistrict({ DISTRICT: d.DISTRICT, ST_NM: d.ST_NM })}
                    className="text-left px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-50 border border-gray-200 rounded-sm transition-colors truncate"
                    title={`${d.display} — ${d.ST_NM}`}
                  >
                    {d.display}
                  </button>
                ))}
              </div>
            </div>

            {/* Alert status card on home screen */}
            {alertConfig?.enabled && (
              <div className="w-full max-w-sm rounded border border-[#e0313133] bg-[#e0313108] px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#e03131] animate-pulse" />
                    <span className="text-xs font-bold text-[#e03131]">Alerts Active</span>
                  </div>
                  <button
                    onClick={() => setModalOpen(true)}
                    className="text-[10px] text-gray-400 hover:text-gray-700 font-medium underline"
                  >
                    Change
                  </button>
                </div>
                <div className="text-[11px] text-gray-500 mt-1">
                  Monitoring <span className="font-semibold text-gray-700">{alertConfig.display}</span>
                  <span className="text-gray-400"> · {alertConfig.ST_NM}</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-none w-[40%] relative border-r border-gray-200">
            <DistrictMap
              features={features}
              selectedDistrict={selectedDistrict}
              onSelectDistrict={setSelectedDistrict}
            />
          </div>
        )}

        {/* Right panel */}
        {!hasSelection ? (
          <div className="flex-1 relative">
            <DistrictMap
              features={features}
              selectedDistrict={selectedDistrict}
              onSelectDistrict={setSelectedDistrict}
            />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            <DistrictDetail district={selectedDistrict} />
          </div>
        )}
      </div>

      {/* ── Alert setup modal ── */}
      {modalOpen && (
        <AlertSetupModal
          current={alertConfig}
          onSave={handleSaveAlert}
          onDisable={handleDisableAlert}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
