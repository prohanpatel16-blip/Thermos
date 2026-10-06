"use client";

import { useState, useEffect, useCallback } from "react";
import {
  fetchDistrictWeather,
  windBearing,
} from "@/lib/weather";
import { getCentroid } from "@/lib/centroids";
import { fetchThermalMetrics } from "@/lib/thermal";
import { fetchRiskPrediction } from "@/lib/risk";
import { getStateDemographics, vulnerabilityBand } from "@/lib/demographics";

const DISPLAY_NAMES = { Gurgaon: "Gurugram" };
const displayName = (d) => {
  if (d?._isWard) return d.Ward_Name ?? d.DISTRICT;
  return DISPLAY_NAMES[d?.DISTRICT] ?? d?.DISTRICT;
};

// ── Design tokens ──────────────────────────────────────────────────────────
const BG       = "#0f1117";
const SURFACE  = "#1a1d27";
const BORDER   = "#2a2d3a";
const MUTED    = "#6b7280";
const TEXT     = "#e5e7eb";
const TEXT_DIM = "#9ca3af";

// ── Shared atoms ───────────────────────────────────────────────────────────

function Label({ children }) {
  return (
    <div style={{ color: MUTED }} className="text-[10px] font-semibold uppercase tracking-widest mb-1.5">
      {children}
    </div>
  );
}

function Card({ children, className = "" }) {
  return (
    <div
      className={`rounded-lg p-4 ${className}`}
      style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
    >
      {children}
    </div>
  );
}

function Spinner({ label }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <svg className="animate-spin h-3.5 w-3.5 flex-none" style={{ color: MUTED }} fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </svg>
      <span className="text-xs" style={{ color: MUTED }}>{label}</span>
    </div>
  );
}

function ErrorNote({ message }) {
  return (
    <div className="rounded px-3 py-2 text-xs text-red-400 border border-red-900 bg-red-950/40">
      {message}
    </div>
  );
}

function PendingNote({ label }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded border border-dashed" style={{ borderColor: BORDER }}>
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-none" />
      <span className="text-xs" style={{ color: MUTED }}>{label}</span>
    </div>
  );
}

function Badge({ children, color = "#374151", textColor = "#9ca3af" }) {
  return (
    <span
      className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
      style={{ background: color + "33", color: textColor, border: `1px solid ${color}66` }}
    >
      {children}
    </span>
  );
}

// ── HTSI level → colour ────────────────────────────────────────────────────
function htsiColor(level) {
  return { SAFE: "#16a34a", CAUTION: "#ca8a04", MODERATE: "#d97706", HIGH: "#ea580c", EXTREME: "#dc2626" }[level] ?? "#6b7280";
}
function htsiDesc(level) {
  return {
    SAFE:     "Thermal conditions within comfortable range.",
    CAUTION:  "Mild thermal stress. Vulnerable individuals may be affected.",
    MODERATE: "Moderate heat stress. Outdoor activity caution advised.",
    HIGH:     "High heat stress. Hydration and shade essential.",
    EXTREME:  "Extreme heat stress. Risk of heat illness. Activate resources.",
  }[level] ?? "";
}

// ── HTSI gradient bar ──────────────────────────────────────────────────────
const HTSI_GRADIENT = "linear-gradient(to right, #16a34a 0%, #ca8a04 25%, #d97706 45%, #ea580c 70%, #dc2626 100%)";

// ── Forecast day tabs ──────────────────────────────────────────────────────
const LEVEL_ORDER = { SAFE: 0, CAUTION: 1, MODERATE: 2, HIGH: 3, EXTREME: 4 };

function ForecastTabs({ forecast, selectedIdx, onSelect, dayThermals, showChart, onToggleChart }) {
  if (!forecast?.length) return null;

  // Peak warning
  let peakIdx = -1, peakOrder = -1;
  dayThermals.forEach((dt, i) => {
    if (!dt) return;
    const ord = LEVEL_ORDER[dt.htsi_level] ?? 0;
    if (ord > peakOrder) { peakOrder = ord; peakIdx = i; }
  });
  const showWarning = peakIdx >= 0 && peakOrder >= 2;
  const peakDt = dayThermals[peakIdx];

  return (
    <div className="flex-none border-b" style={{ borderColor: BORDER, background: SURFACE }}>
      {/* Early warning banner */}
      {showWarning && (
        <div
          className="flex items-center gap-3 px-5 py-2 border-b text-xs font-medium"
          style={{ borderColor: BORDER, backgroundColor: peakDt.htsi_color + "18", color: peakDt.htsi_color }}
        >
          <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded"
            style={{ background: peakDt.htsi_color + "22", border: `1px solid ${peakDt.htsi_color}44` }}>
            EARLY WARNING
          </span>
          {peakIdx === 0
            ? `Peak thermal stress today — ${peakDt.htsi_label} conditions`
            : `${peakDt.htsi_label} conditions expected on ${
                new Date(forecast[peakIdx].date + "T00:00:00")
                  .toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })
              }`
          }
        </div>
      )}

      {/* Tabs row + chart toggle */}
      <div className="flex items-stretch overflow-x-auto">
        {forecast.map((day, i) => {
          const sel = i === selectedIdx;
          const dt  = dayThermals[i];
          const col = dt?.htsi_color ?? MUTED;
          const lbl = i === 0
            ? "Today"
            : new Date(day.date + "T00:00:00").toLocaleDateString("en-IN", {
                weekday: "short", day: "numeric", month: "short",
              }).replace(",", "");
          return (
            <button
              key={day.date}
              onClick={() => onSelect(i)}
              className="flex-none flex flex-col items-center px-4 py-2.5 min-w-[80px] border-r transition-colors"
              style={{
                borderColor:  BORDER,
                background:   sel ? BG : "transparent",
                borderBottom: sel ? `2px solid ${col}` : `2px solid transparent`,
              }}
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider mb-0.5"
                style={{ color: sel ? TEXT_DIM : MUTED }}>
                {lbl}
              </span>
              <span className="text-base font-bold leading-none" style={{ color: sel ? "#fff" : TEXT }}>
                {day.tempMax != null ? `${day.tempMax.toFixed(0)}°` : "—"}
              </span>
              {dt?.htsi_level ? (
                <span className="text-[9px] font-bold uppercase mt-1 rounded px-1.5 py-0.5"
                  style={{ background: col + "22", color: col }}>
                  {dt.htsi_level === "MODERATE" ? "MOD" : dt.htsi_level === "EXTREME" ? "EXT" : dt.htsi_level.slice(0, 4)}
                </span>
              ) : (
                <span className="text-[9px] mt-1" style={{ color: BORDER }}>…</span>
              )}
            </button>
          );
        })}

        {/* Spacer */}
        <div className="flex-1" />

        {/* 5-day HTSI chart toggle */}
        <button
          onClick={onToggleChart}
          className="flex-none flex items-center gap-1.5 px-3 py-2 border-l text-[10px] font-semibold uppercase tracking-wider transition-colors"
          style={{
            borderColor: BORDER,
            background:  showChart ? "#2563eb22" : "transparent",
            color:       showChart ? "#60a5fa"   : MUTED,
          }}
          title="Show 5-day HTSI trend chart"
        >
          <svg className="w-3.5 h-3.5 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l5-5 4 4 5-6 4 3" />
          </svg>
          5-Day HTSI
        </button>
      </div>
    </div>
  );
}

// ── 5-Day HTSI Line Chart ──────────────────────────────────────────────────
// Pure SVG — no chart library. Shows HTSI score per forecast day as a
// connected line with colour-coded dots and level labels.

function HtsiLineChart({ forecast, dayThermals, chartLoading }) {
  const W = 480, H = 130, PAD_L = 36, PAD_R = 16, PAD_T = 16, PAD_B = 36;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const N = forecast.length;

  // Build points — use cached thermals or null (still loading)
  const points = forecast.map((day, i) => {
    const dt = dayThermals[i];
    return {
      score: dt?.htsi ?? null,
      color: dt?.htsi_color ?? MUTED,
      level: dt?.htsi_label ?? null,
      label: i === 0
        ? "Today"
        : new Date(day.date + "T00:00:00").toLocaleDateString("en-IN", {
            weekday: "short", month: "short", day: "numeric",
          }).replace(",", ""),
      x: PAD_L + (i / (N - 1)) * plotW,
    };
  });

  // Y scale: 0–100, inverted (0 = bottom)
  const yScale = (score) => PAD_T + plotH - (score / 100) * plotH;

  // Build polyline path from available points
  const available = points.filter((p) => p.score != null);
  const polyline  = available.map((p) => `${p.x},${yScale(p.score)}`).join(" ");

  // Horizontal guide lines at 20/40/60/80
  const guides = [
    { y: 20, label: "Safe",     color: htsiColor("SAFE") },
    { y: 40, label: "Caution",  color: htsiColor("CAUTION") },
    { y: 60, label: "Moderate", color: htsiColor("MODERATE") },
    { y: 80, label: "High",     color: htsiColor("HIGH") },
  ];

  return (
    <div className="flex-none border-b px-4 py-3" style={{ background: BG, borderColor: BORDER }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
          5-Day HTSI Trend
        </span>
        {chartLoading && (
          <span className="text-[10px]" style={{ color: MUTED }}>Computing missing days…</span>
        )}
      </div>

      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        {/* Guide lines */}
        {guides.map(({ y, label, color }) => {
          const cy = yScale(y);
          return (
            <g key={y}>
              <line x1={PAD_L} y1={cy} x2={W - PAD_R} y2={cy}
                stroke={color} strokeWidth={0.5} strokeDasharray="3 4" opacity={0.35} />
              <text x={PAD_L - 4} y={cy + 3.5} textAnchor="end" fontSize={8}
                fill={color} fontFamily="Montserrat,sans-serif" opacity={0.7}>{y}</text>
            </g>
          );
        })}

        {/* Y-axis top label */}
        <text x={PAD_L - 4} y={PAD_T + 4} textAnchor="end" fontSize={8}
          fill={MUTED} fontFamily="Montserrat,sans-serif" opacity={0.5}>100</text>

        {/* Polyline */}
        {available.length > 1 && (
          <polyline
            points={polyline}
            fill="none"
            stroke="#60a5fa"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* Fill area under line */}
        {available.length > 1 && (
          <polygon
            points={`${available[0].x},${PAD_T + plotH} ${polyline} ${available[available.length - 1].x},${PAD_T + plotH}`}
            fill="#60a5fa"
            opacity={0.06}
          />
        )}

        {/* Data points + labels */}
        {points.map((p, i) => (
          <g key={i}>
            {/* X-axis label */}
            <text x={p.x} y={H - 2} textAnchor="middle" fontSize={9}
              fill={MUTED} fontFamily="Montserrat,sans-serif">
              {p.label}
            </text>

            {p.score != null ? (
              <>
                {/* Dot */}
                <circle cx={p.x} cy={yScale(p.score)} r={5}
                  fill={p.color} stroke={BG} strokeWidth={1.5} />
                {/* Score label above dot */}
                <text x={p.x} y={yScale(p.score) - 9} textAnchor="middle" fontSize={10}
                  fontWeight={700} fill={p.color} fontFamily="Montserrat,sans-serif">
                  {p.score.toFixed(0)}
                </text>
                {/* Level badge below score */}
                {p.level && (
                  <text x={p.x} y={yScale(p.score) - 20} textAnchor="middle" fontSize={8}
                    fill={p.color} fontFamily="Montserrat,sans-serif" opacity={0.75}>
                    {p.level.toUpperCase()}
                  </text>
                )}
              </>
            ) : (
              /* Pending dot */
              <circle cx={p.x} cy={PAD_T + plotH / 2} r={3}
                fill="none" stroke={BORDER} strokeWidth={1.5} strokeDasharray="2 2" />
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Metric card (for weather conditions grid) ──────────────────────────────
function MetricCard({ emoji, label, value, unit, sub }) {
  return (
    <Card>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-base leading-none">{emoji}</span>
        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: MUTED }}>{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold" style={{ color: "#fff" }}>{value ?? "—"}</span>
        {unit && <span className="text-sm font-medium" style={{ color: MUTED }}>{unit}</span>}
      </div>
      {sub && <div className="text-[10px] mt-1" style={{ color: MUTED }}>{sub}</div>}
    </Card>
  );
}

// ── HTSI + Risk side-by-side ───────────────────────────────────────────────
function HtsiAndRisk({ thermal, thermalLoading, thermalError, risk, riskLoading, riskError }) {
  return (
    <div className="grid grid-cols-2 gap-3 mb-3">

      {/* HTSI card */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-0.5" style={{ color: MUTED }}>
              Thermal Stress Index
            </div>
            <div className="text-[9px]" style={{ color: BORDER.replace("2a2d3a","555") }}>THERMOS HTSI · Prototype</div>
          </div>
          <Badge color="#16a34a" textColor="#16a34a">LIVE</Badge>
        </div>
        {thermalLoading && <Spinner label="Computing…" />}
        {thermalError && !thermalLoading && (
          <>
            <ErrorNote message="Thermal engine unavailable" />
            <p className="text-[9px] mt-1" style={{ color: MUTED }}>
              Run: <code className="font-mono">uvicorn main:app --reload</code>
            </p>
          </>
        )}
        {!thermal && !thermalLoading && !thermalError && <PendingNote label="Awaiting weather…" />}
        {thermal && !thermalLoading && (() => {
          const score = thermal.htsi;
          const color = thermal.htsi_color;
          const pct   = Math.min(100, Math.max(0, score));
          return (
            <>
              <div className="flex items-center gap-4 mb-4">
                <div className="flex-none flex flex-col items-center justify-center w-16 h-16 rounded-lg border-2"
                  style={{ borderColor: color, background: color + "18" }}>
                  <span className="text-2xl font-bold leading-none" style={{ color }}>{score.toFixed(0)}</span>
                  <span className="text-[9px] mt-0.5 font-medium" style={{ color: MUTED }}>/100</span>
                </div>
                <div>
                  <div className="text-lg font-bold leading-tight" style={{ color }}>{thermal.htsi_label}</div>
                  <div className="text-[10px] mt-0.5 leading-snug" style={{ color: TEXT_DIM }}>
                    {htsiDesc(thermal.htsi_level)}
                  </div>
                </div>
              </div>
              {/* Gradient bar with needle */}
              <div className="relative h-2 rounded-full overflow-hidden mb-1" style={{ background: HTSI_GRADIENT }}>
                <div className="absolute top-0 h-full w-0.5 rounded-full bg-white/80"
                  style={{ left: `calc(${pct}% - 1px)` }} />
              </div>
              <div className="flex justify-between">
                {["Safe","Caution","Moderate","High","Extreme"].map((l, i) => (
                  <span key={l} className="text-[9px]"
                    style={{ color: [htsiColor("SAFE"),htsiColor("CAUTION"),htsiColor("MODERATE"),htsiColor("HIGH"),htsiColor("EXTREME")][i] }}>
                    {l}
                  </span>
                ))}
              </div>
              <p className="text-[9px] mt-2" style={{ color: "#374151" }}>
                THERMOS prototype. Not clinically validated.
              </p>
            </>
          );
        })()}
      </Card>

      {/* Health Risk card */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-0.5" style={{ color: MUTED }}>
              Health Risk Assessment
            </div>
            <div className="text-[9px]" style={{ color: BORDER.replace("2a2d3a","555") }}>Research-based estimate</div>
          </div>
        </div>
        {riskLoading && <Spinner label="Computing…" />}
        {riskError && !riskLoading && <ErrorNote message="Risk engine unavailable" />}
        {!risk && !riskLoading && !riskError && <PendingNote label="Awaiting thermal data…" />}
        {risk && !riskLoading && (() => {
          const color = risk.riskColor;
          return (
            <>
              <div className="flex items-center gap-4 mb-3">
                <div className="flex-none flex flex-col items-center justify-center w-16 h-16 rounded-lg border-2"
                  style={{ borderColor: color, background: color + "18" }}>
                  <span className="text-2xl font-bold leading-none" style={{ color }}>{risk.healthRiskScore}</span>
                  <span className="text-[9px] mt-0.5 font-medium" style={{ color: MUTED }}>/100</span>
                </div>
                <div>
                  <div className="text-lg font-bold leading-tight" style={{ color }}>{risk.riskLabel} Risk</div>
                  <div className="text-[10px] mt-0.5" style={{ color: TEXT_DIM }}>
                    {risk.state} · {risk.forecastDate ?? "Today"}
                  </div>
                  {risk.relativeRisk > 1 && (
                    <div className="text-[10px] mt-0.5" style={{ color: TEXT_DIM }}>
                      ~<span style={{ color: TEXT, fontWeight: 600 }}>{risk.relativeRisk}×</span> baseline rate
                    </div>
                  )}
                </div>
              </div>

              {/* Risk drivers */}
              {risk.drivers?.length > 0 && (
                <div className="space-y-1.5 mb-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wider mb-1" style={{ color: MUTED }}>
                    Risk Drivers
                  </div>
                  {risk.drivers.slice(0, 3).map((d) => (
                    <div key={d.rank} className="flex items-center gap-2">
                      <span className="text-[9px] font-bold w-3.5 text-center flex-none" style={{ color: MUTED }}>{d.rank}</span>
                      <span className="text-[10px] font-semibold flex-1" style={{ color: TEXT }}>{d.label}</span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: "#dc262622", color: "#dc2626", border: "1px solid #dc262633" }}>
                        ↑ Risk
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {risk.drivers?.length === 0 && (
                <p className="text-[10px] leading-snug" style={{ color: TEXT_DIM }}>
                  No thresholds exceeded. Baseline conditions.
                </p>
              )}
              <p className="text-[9px] mt-1" style={{ color: "#374151" }}>
                Calibrated on NCRB heatstroke mortality 2001–2014. Not a clinical prediction.
              </p>
            </>
          );
        })()}
      </Card>
    </div>
  );
}

// ── Weather conditions grid ────────────────────────────────────────────────
function ConditionsGrid({ day, isToday, currentWeather, thermal, loading }) {
  if (loading) return <Spinner label="Fetching weather…" />;
  if (!day) return null;

  const w = isToday && currentWeather ? currentWeather : null;

  // Resolve thermalKey cells using thermal prop
  const tv = (key) => {
    const v = thermal?.[key];
    return v != null ? v.toFixed(1) : "—";
  };

  const cells = w
    ? [
        { emoji: "🌡️", label: "Temperature",   value: w.temperature?.toFixed(1),         unit: "°C" },
        { emoji: "🥵", label: "Feels Like",    value: w.apparentTemperature?.toFixed(1),  unit: "°C",  sub: w.apparentTemperature > 40 ? "High perceived heat" : undefined },
        { emoji: "💧", label: "Humidity",      value: String(w.humidity ?? "—"),          unit: "%" },
        { emoji: "🔥", label: "Heat Index",    value: tv("heat_index"),                   unit: thermal?.heat_index != null ? "°C" : undefined },
        { emoji: "🌞", label: "WBGT",          value: tv("wbgt"),                         unit: thermal?.wbgt != null ? "°C" : undefined, sub: "Wet Bulb Globe Temp" },
        { emoji: "🧍", label: "UTCI",          value: tv("utci"),                         unit: thermal?.utci != null ? "°C" : undefined, sub: "Universal Thermal Climate" },
        { emoji: "💨", label: "Wind Speed",    value: w.windSpeed?.toFixed(0),             unit: "km/h" },
        { emoji: "🧭", label: "Wind Dir",      value: `${windBearing(w.windDirection)} ${w.windDirection?.toFixed(0) ?? "—"}`, unit: "°" },
        { emoji: "🌧️", label: "Precipitation", value: w.precipitation?.toFixed(1),        unit: "mm" },
      ]
    : [
        { emoji: "🌡️", label: "Temp (mean)",   value: day.tempMean?.toFixed(1),      unit: "°C" },
        { emoji: "🌡️", label: "Temp max",      value: day.tempMax?.toFixed(1),       unit: "°C" },
        { emoji: "🌡️", label: "Temp min",      value: day.tempMin?.toFixed(1),       unit: "°C" },
        { emoji: "💧", label: "Humidity",      value: day.humidityMean?.toFixed(0),  unit: "%" },
        { emoji: "🔥", label: "Heat Index",    value: tv("heat_index"),              unit: thermal?.heat_index != null ? "°C" : undefined },
        { emoji: "🌞", label: "WBGT",          value: tv("wbgt"),                    unit: thermal?.wbgt != null ? "°C" : undefined, sub: "Wet Bulb Globe Temp" },
        { emoji: "🧍", label: "UTCI",          value: tv("utci"),                    unit: thermal?.utci != null ? "°C" : undefined, sub: "Universal Thermal Climate" },
        { emoji: "💨", label: "Wind Speed",    value: day.windMean?.toFixed(0),      unit: "km/h" },
        { emoji: "🌧️", label: "Precipitation", value: day.precipSum?.toFixed(1),     unit: "mm" },
      ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {cells.map((c) => (
        <MetricCard
          key={c.label}
          emoji={c.emoji}
          label={c.label}
          value={c.value ?? "—"}
          unit={c.unit}
          sub={c.sub}
        />
      ))}
    </div>
  );
}

// ── Thermal metrics row (Heat Index / WBGT / UTCI) ─────────────────────────
function ThermalRow({ thermal, loading, error }) {
  if (!thermal && !loading && !error) return null;
  const metrics = [
    { key: "heat_index", emoji: "🔥", label: "Heat Index",  sub: "NWS equation" },
    { key: "wbgt",       emoji: "🌞", label: "WBGT",        sub: "Wet Bulb Globe Temp" },
    { key: "utci",       emoji: "🧍", label: "UTCI",        sub: "Thermal Climate Index" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 mb-3">
      {metrics.map(({ key, emoji, label, sub }) => {
        const val = thermal?.[key];
        return (
          <MetricCard
            key={key}
            emoji={emoji}
            label={label}
            value={loading ? "…" : val != null ? val.toFixed(1) : "—"}
            unit={val != null && !loading ? "°C" : undefined}
            sub={sub}
          />
        );
      })}
    </div>
  );
}

// ── Population Vulnerability — spider chart ───────────────────────────────

/** Pure-SVG radar/spider chart for 4 age-group vulnerability weights. */
function SpiderChart({ bars, scoreColor }) {
  // 4 axes evenly spaced at 90° each, starting from top
  const CX = 100, CY = 100, R = 62;
  const N = bars.length;
  const axes = bars.map((_, i) => {
    const angle = (Math.PI * 2 * i) / N - Math.PI / 2; // start from top
    return { x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) };
  });

  // Grid rings at 25%, 50%, 75%, 100%
  const rings = [0.25, 0.5, 0.75, 1.0];

  // Polygon for vulnerability weights (0–1 scale)
  const polygon = bars.map((b, i) => {
    const angle = (Math.PI * 2 * i) / N - Math.PI / 2;
    const r = b.weight * R;
    return `${CX + r * Math.cos(angle)},${CY + r * Math.sin(angle)}`;
  }).join(" ");

  // Label positions (pushed a bit further out than the axis tip)
  const labels = bars.map((b, i) => {
    const angle = (Math.PI * 2 * i) / N - Math.PI / 2;
    const r = R + 14;
    const cos = Math.cos(angle);
    let anchor = "middle";
    if (cos > 0.15) anchor = "start";
    else if (cos < -0.15) anchor = "end";
    return { x: CX + r * Math.cos(angle), y: CY + r * Math.sin(angle), label: b.label, weight: b.weight, color: b.weightColor, anchor };
  });

  return (
    <svg width="210" height="200" viewBox="0 0 210 200">
      {/* Grid rings */}
      {rings.map((f, ri) => (
        <polygon
          key={ri}
          points={axes.map((ax, i) => {
            const angle = (Math.PI * 2 * i) / N - Math.PI / 2;
            const r = f * R;
            return `${CX + r * Math.cos(angle)},${CY + r * Math.sin(angle)}`;
          }).join(" ")}
          fill="none"
          stroke={BORDER}
          strokeWidth={1}
        />
      ))}

      {/* Axis lines */}
      {axes.map((pt, i) => (
        <line key={i} x1={CX} y1={CY} x2={pt.x} y2={pt.y} stroke={BORDER} strokeWidth={1} />
      ))}

      {/* Data polygon */}
      <polygon
        points={polygon}
        fill={scoreColor + "33"}
        stroke={scoreColor}
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* Data dots */}
      {bars.map((b, i) => {
        const angle = (Math.PI * 2 * i) / N - Math.PI / 2;
        const r = b.weight * R;
        return (
          <circle
            key={i}
            cx={CX + r * Math.cos(angle)}
            cy={CY + r * Math.sin(angle)}
            r={3}
            fill={b.weightColor}
            stroke="#0f1117"
            strokeWidth={1}
          />
        );
      })}

      {/* Labels */}
      {labels.map((l) => (
        <g key={l.label}>
          <text
            x={l.x} y={l.y - 4}
            textAnchor={l.anchor}
            fontSize={11}
            fontWeight={700}
            fill={TEXT_DIM}
            fontFamily="Montserrat,sans-serif"
          >
            {l.label}
          </text>
          <text
            x={l.x} y={l.y + 9}
            textAnchor={l.anchor}
            fontSize={11}
            fontWeight={700}
            fill={l.color}
            fontFamily="Montserrat,sans-serif"
          >
            {l.weight.toFixed(2)}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ── Population Vulnerability Panel ────────────────────────────────────────
function VulnerabilityPanel({ demographics }) {
  if (!demographics) return null;

  const { stateName, childrenPct, workingAgePct, olderAdultsPct, veryElderlyPct,
          outdoorWorkersPct, ageWeights, score } = demographics;
  const band = vulnerabilityBand(score);

  const scoreColor =
    score <= 25 ? "#6b7280" :
    score <= 50 ? "#d97706" :
    score <= 75 ? "#ea580c" : "#dc2626";

  const chartBars = [
    { label: "0–14",  weight: ageWeights["0-14"],  weightColor: "#2563eb" },
    { label: "15–59", weight: ageWeights["15-59"], weightColor: "#ca8a04" },
    { label: "60–79", weight: ageWeights["60-79"], weightColor: "#ea580c" },
    { label: "80+",   weight: ageWeights["80+"],   weightColor: "#dc2626" },
  ];

  // Age rows for the table next to the chart
  const ageRows = [
    { label: "0–14",  pct: childrenPct,   weight: ageWeights["0-14"],  color: "#2563eb", note: "Thermoregulation developing" },
    { label: "15–59", pct: workingAgePct, weight: ageWeights["15-59"], color: "#ca8a04", note: "Working-age baseline" },
    { label: "60–79", pct: olderAdultsPct,weight: ageWeights["60-79"], color: "#ea580c", note: "Reduced heat adaptation" },
    { label: "80+",   pct: veryElderlyPct,weight: ageWeights["80+"],   color: "#dc2626", note: "Highest physiological risk" },
  ];

  return (
    <Card className="mb-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <Label>Population Vulnerability</Label>
          <div className="text-xs" style={{ color: MUTED }}>
            State-level context · {stateName}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-col items-center justify-center w-14 h-14 rounded-lg border-2"
            style={{ borderColor: scoreColor, background: scoreColor + "18" }}>
            <span className="text-lg font-bold leading-none" style={{ color: scoreColor }}>{score}</span>
            <span className="text-[10px]" style={{ color: MUTED }}>/100</span>
          </div>
          <span className="text-xs font-bold" style={{ color: scoreColor }}>{band}</span>
        </div>
      </div>

      {/* Chart + table side by side */}
      <div className="flex gap-4 items-start mb-3">
        {/* Spider chart */}
        <div className="flex-none">
          <SpiderChart bars={chartBars} scoreColor={scoreColor} />
        </div>

        {/* Age group table */}
        <div className="flex-1 space-y-2">
          {ageRows.map((r) => (
            <div key={r.label} className="rounded p-2.5" style={{ background: BG, border: `1px solid ${BORDER}` }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold" style={{ color: r.color }}>{r.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px]" style={{ color: MUTED }}>{r.pct.toFixed(1)}% pop.</span>
                  <span className="text-xs font-bold" style={{ color: r.color }}>
                    {r.weight.toFixed(2)}
                  </span>
                </div>
              </div>
              <div className="text-[11px]" style={{ color: MUTED }}>{r.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Outdoor workers */}
      <div className="pt-2.5 border-t" style={{ borderColor: BORDER }}>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold" style={{ color: TEXT }}>🏗️ Outdoor workers</span>
          <span className="text-sm font-bold" style={{ color: "#ea580c" }}>{outdoorWorkersPct.toFixed(1)}%</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: BORDER }}>
          <div className="h-full rounded-full"
            style={{ width: `${Math.min(100, outdoorWorkersPct)}%`, background: "#ea580c", opacity: 0.8 }} />
        </div>
        <div className="text-[11px] mt-1" style={{ color: MUTED }}>Direct prolonged heat exposure</div>
      </div>

      <p className="text-[11px] mt-2 leading-snug" style={{ color: "#4b5563" }}>
        Vulnerability weight = physiological susceptibility (fixed, independent of population %).
        State-level aggregate — not district-specific.
      </p>
    </Card>
  );
}

// ── Recommendations ────────────────────────────────────────────────────────
const REC_ICONS = ["💧","⏰","👴","🏛️","📢","🚫","🏥","🎯"];
function Recommendations({ risk, thermal }) {
  const level = risk?.riskLevel ?? thermal?.htsi_level ?? null;

  const high = [
    "Ensure adequate hydration — at least 1 litre/hour during outdoor activity.",
    "Shift outdoor work to early morning (before 9 AM) or evening (after 6 PM).",
    "Monitor elderly, children, and outdoor workers closely.",
    "Prepare and publicise cooling centre locations in your area.",
  ];
  const extreme = [
    "Activate all available cooling centres immediately.",
    "Issue public heat warning across all channels.",
    "Suspend non-essential outdoor work during 11 AM – 5 PM.",
    "Increase hospital and emergency service preparedness.",
  ];

  if (!level || level === "SAFE") return null;

  const items = level === "EXTREME" ? [...extreme, ...high] : high;
  const priorityLabel = level === "EXTREME" ? "HIGH PRIORITY" : level === "HIGH" ? "HIGH PRIORITY" : "LOW PRIORITY";
  const priorityColor = level === "EXTREME" || level === "HIGH" ? "#dc2626" : "#16a34a";

  return (
    <Card className="mb-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <Label>Recommended Actions</Label>
          <div className="text-[9px]" style={{ color: MUTED }}>Decision-support only. Not individual medical advice.</div>
        </div>
        <Badge color={priorityColor} textColor={priorityColor}>{priorityLabel}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-2 rounded-lg p-2.5" style={{ background: BG, border: `1px solid ${BORDER}` }}>
            <span className="text-base flex-none leading-none mt-0.5">{REC_ICONS[i] ?? "•"}</span>
            <span className="text-[11px] leading-snug" style={{ color: TEXT_DIM }}>{item}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function DistrictDetail({ district }) {
  const [weather,        setWeather]        = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError,   setWeatherError]   = useState(null);

  const [selectedDayIdx, setSelectedDayIdx] = useState(0);

  const [thermal,        setThermal]        = useState(null);
  const [thermalLoading, setThermalLoading] = useState(false);
  const [thermalError,   setThermalError]   = useState(null);

  const [risk,        setRisk]        = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [riskError,   setRiskError]   = useState(null);

  const [dayThermals,   setDayThermals]   = useState([]);
  const [showHtsiChart, setShowHtsiChart] = useState(false);
  const [chartLoading,  setChartLoading]  = useState(false);

  // For ward features the centroid is pre-computed in page.js and injected
  // as _centroidLat/_centroidLng. For districts use the centroids table.
  const isWard = !!district?._isWard;
  const centroid = isWard
    ? { lat: district._centroidLat, lng: district._centroidLng, state: "NCT of Delhi" }
    : getCentroid(district?.DISTRICT ?? "");
  const demographics = getStateDemographics(centroid?.state ?? "NCT of Delhi");

  // ── Phase 1: fetch weather once ──
  useEffect(() => {
    if (!district) return;
    if (!centroid) { setWeatherError("Centroid not found."); return; }

    let cancelled = false;
    setWeather(null); setWeatherError(null); setWeatherLoading(true);
    setSelectedDayIdx(0);
    setThermal(null);  setThermalError(null);  setThermalLoading(false);
    setRisk(null);     setRiskError(null);     setRiskLoading(false);
    setDayThermals([]);
    setShowHtsiChart(false);

    fetchDistrictWeather(centroid.lat, centroid.lng)
      .then((data) => {
        if (cancelled) return;
        setWeather(data);
        setWeatherLoading(false);
        setDayThermals(new Array(data.forecast.length).fill(null));
      })
      .catch((err) => {
        if (cancelled) return;
        setWeatherError(err.message ?? "Weather fetch failed.");
        setWeatherLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [district?.DISTRICT, district?.ST_NM]);

  // ── Phase 2: thermal + risk per day ──
  const computeDayAnalysis = useCallback(
    (dayIdx, weatherData, _cache, lat, lng, stateName) => {
      if (!weatherData) return;
      const isToday    = dayIdx === 0;
      const forecastDay = weatherData.forecast[dayIdx];
      if (!forecastDay) return;

      const temperature = isToday
        ? weatherData.current.temperature
        : (forecastDay.tempMean ?? ((forecastDay.tempMax + forecastDay.tempMin) / 2));
      const humidity  = isToday ? weatherData.current.humidity  : (forecastDay.humidityMean ?? 50);
      const windSpeed = isToday ? weatherData.current.windSpeed : (forecastDay.windMean ?? 10);

      if (temperature == null || humidity == null) return;

      let cancelled = false;
      setThermal(null); setThermalError(null); setThermalLoading(true);
      setRisk(null);    setRiskError(null);    setRiskLoading(false);

      fetchThermalMetrics({ temperature, humidity, windSpeed, lat, lng })
        .then((t) => {
          if (cancelled) return Promise.resolve(null);
          setThermal(t);
          setThermalLoading(false);
          setDayThermals((prev) => { const n = [...prev]; n[dayIdx] = t; return n; });
          setRiskLoading(true);
          return fetchRiskPrediction({
            stateName, forecastDate: forecastDay.date ?? null,
            temperature, wbgt: t.wbgt, heatIndex: t.heat_index,
            htsi: t.htsi, utci: t.utci, windSpeed, solarRadiation: t.solar_radiation,
          });
        })
        .then((r) => {
          if (cancelled || !r) return;
          setRisk(r); setRiskLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setThermalError(err.message ?? "Thermal/risk engine unavailable.");
          setThermalLoading(false); setRiskLoading(false);
        });

      return () => { cancelled = true; };
    },
    []
  );

  useEffect(() => {
    if (!weather || !centroid) return;
    computeDayAnalysis(selectedDayIdx, weather, dayThermals, centroid.lat, centroid.lng, centroid.state);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDayIdx, weather]);

  const handleDaySelect = useCallback((idx) => setSelectedDayIdx(idx), []);

  // ── 5-day HTSI chart: compute all days in parallel on first open ──────────
  const handleToggleChart = useCallback(() => {
    setShowHtsiChart((prev) => {
      const opening = !prev;
      if (opening && weather && centroid) {
        // Find days that don't have a cached thermal result yet
        const missing = weather.forecast
          .map((day, i) => ({ day, i }))
          .filter(({ i }) => !dayThermals[i]);

        if (missing.length > 0) {
          setChartLoading(true);
          Promise.all(
            missing.map(({ day, i }) => {
              const isToday = i === 0;
              const temperature = isToday
                ? weather.current.temperature
                : (day.tempMean ?? ((day.tempMax + day.tempMin) / 2));
              const humidity  = isToday ? weather.current.humidity  : (day.humidityMean ?? 50);
              const windSpeed = isToday ? weather.current.windSpeed : (day.windMean ?? 10);
              return fetchThermalMetrics({ temperature, humidity, windSpeed, lat: centroid.lat, lng: centroid.lng })
                .then((t) => ({ i, t }))
                .catch(() => null);
            })
          ).then((results) => {
            setDayThermals((prev) => {
              const next = [...prev];
              results.forEach((r) => { if (r) next[r.i] = r.t; });
              return next;
            });
            setChartLoading(false);
          });
        }
      }
      return opening;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weather, centroid, dayThermals]);

  if (!district) return null;

  const selectedForecastDay = weather?.forecast[selectedDayIdx] ?? null;
  const isToday = selectedDayIdx === 0;

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: BG }}>

      {/* ── District / Ward header ── */}
      <div className="flex-none px-5 py-3 border-b" style={{ background: SURFACE, borderColor: BORDER }}>
        <div className="text-[10px] font-semibold uppercase tracking-widest mb-0.5" style={{ color: MUTED }}>
          {isWard ? `Ward Analysis · NCT of Delhi` : "District Analysis · NCR Region"}
        </div>
        <div className="flex items-baseline gap-3">
          <h1 className="text-3xl font-bold leading-tight" style={{ color: "#fff" }}>
            {displayName(district)}
          </h1>
          {isWard && (
            <span className="text-sm font-semibold px-2 py-0.5 rounded"
              style={{ background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b44" }}>
              Ward {district._wardNo}
            </span>
          )}
        </div>
        {centroid && (
          <div className="text-[11px] mt-0.5 font-mono" style={{ color: TEXT_DIM }}>
            {centroid.lat.toFixed(4)}°N, {centroid.lng.toFixed(4)}°E · {district.ST_NM}
          </div>
        )}
      </div>

      {/* ── Forecast tabs ── */}
      {weatherLoading && (
        <div className="flex-none px-5 py-2 border-b" style={{ background: SURFACE, borderColor: BORDER }}>
          <Spinner label="Loading forecast…" />
        </div>
      )}
      {weatherError && !weatherLoading && (
        <div className="flex-none px-5 py-2 border-b" style={{ borderColor: BORDER }}>
          <ErrorNote message={`Weather unavailable — ${weatherError}`} />
        </div>
      )}
      {weather && !weatherLoading && (
        <ForecastTabs
          forecast={weather.forecast}
          selectedIdx={selectedDayIdx}
          onSelect={handleDaySelect}
          dayThermals={dayThermals}
          showChart={showHtsiChart}
          onToggleChart={handleToggleChart}
        />
      )}

      {/* ── 5-Day HTSI chart (shown below tabs when toggled) ── */}
      {showHtsiChart && weather && (
        <HtsiLineChart
          forecast={weather.forecast}
          dayThermals={dayThermals}
          chartLoading={chartLoading}
        />
      )}

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">

        {/* Day label */}
        {weather && (
          <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
            {isToday
              ? "Today — Live Current Conditions"
              : `Forecast — ${new Date(selectedForecastDay?.date + "T00:00:00")
                  .toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}`
            }
          </div>
        )}

        {/* HTSI + Risk side by side */}
        <HtsiAndRisk
          thermal={thermal} thermalLoading={thermalLoading} thermalError={thermalError}
          risk={risk}       riskLoading={riskLoading}       riskError={riskError}
        />

        {/* Conditions grid */}
        {(weather || weatherLoading) && (
          <Card className="mb-3">
            <Label>{isToday ? "Today — Live Current Conditions" : "Forecast Conditions"}</Label>
            <ConditionsGrid
              day={selectedForecastDay}
              isToday={isToday}
              currentWeather={weather?.current}
              thermal={thermal}
              loading={weatherLoading}
            />
          </Card>
        )}

        {/* Recommendations */}
        <Recommendations risk={risk} thermal={thermal} />

        {/* Population vulnerability */}
        <VulnerabilityPanel demographics={demographics} />

        {/* Bottom spacer */}
        <div className="h-4" />
      </div>
    </div>
  );
}
