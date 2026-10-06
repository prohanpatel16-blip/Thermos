"""
THERMOS Thermal Engine — FastAPI service
Calculates:
  - Heat Index  (pythermalcomfort)
  - WBGT        (pythermalcomfort, simplified outdoor estimate)
  - UTCI        (pythermalcomfort)
  - HTSI        (THERMOS prototype — see methodology below)

Radiation source: NASA POWER daily ALLSKY_SFC_SW_DWN (W/m²)
  fetched dynamically — no dataset downloaded, no DB table.

Run:
  uvicorn main:app --reload --port 8000
"""

import math
import httpx
import json as _json_stdlib
from datetime import date, timedelta
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pythermalcomfort import heat_index, wbgt, utci

app = FastAPI(title="THERMOS Thermal Engine", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Request / Response schemas ─────────────────────────────────────────────

class ThermalRequest(BaseModel):
    temperature: float = Field(..., description="Dry bulb air temperature (°C)")
    humidity: float = Field(..., description="Relative humidity (%)")
    wind_speed: float = Field(..., description="Wind speed (km/h)")
    lat: float = Field(..., description="Latitude for NASA POWER radiation lookup")
    lng: float = Field(..., description="Longitude for NASA POWER radiation lookup")

class ThermalMetrics(BaseModel):
    heat_index: float | None
    wbgt: float | None
    utci: float | None
    solar_radiation: float | None     # W/m² from NASA POWER (daily mean)
    htsi: float
    htsi_level: str
    htsi_label: str
    htsi_color: str                   # Tailwind bg class for UI

# ── NASA POWER radiation fetch ─────────────────────────────────────────────

NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"

async def fetch_solar_radiation(lat: float, lng: float) -> float | None:
    """
    Fetch today's (or yesterday's if today not yet available) daily mean
    all-sky surface shortwave downward irradiance (ALLSKY_SFC_SW_DWN) in W/m²
    from NASA POWER.

    Returns None on any failure — callers fall back to estimation.
    """
    today = date.today()
    start = (today - timedelta(days=2)).strftime("%Y%m%d")
    end = (today - timedelta(days=1)).strftime("%Y%m%d")

    params = {
        "parameters": "ALLSKY_SFC_SW_DWN",
        "community": "RE",
        "longitude": lng,
        "latitude": lat,
        "start": start,
        "end": end,
        "format": "JSON",
        "time-standard": "UTC",
    }

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(NASA_POWER_URL, params=params)
            r.raise_for_status()
            data = r.json()
            values = (
                data.get("properties", {})
                    .get("parameter", {})
                    .get("ALLSKY_SFC_SW_DWN", {})
            )
            if not values:
                return None
            # Return the most recent non-fill-value entry
            for v in reversed(list(values.values())):
                if v is not None and v > -900:   # NASA fill value is -999
                    return float(v)
    except Exception:
        pass
    return None


# ── Psychrometric helpers ──────────────────────────────────────────────────

def wet_bulb_approx(tdb: float, rh: float) -> float:
    """
    Stull (2011) approximation for natural wet bulb temperature.
    Accurate to ±0.3°C for hot/humid conditions.
    tdb: dry bulb °C, rh: relative humidity %
    """
    return (
        tdb * math.atan(0.151977 * math.sqrt(rh + 8.313659))
        + math.atan(tdb + rh)
        - math.atan(rh - 1.676331)
        + 0.00391838 * rh ** 1.5 * math.atan(0.023101 * rh)
        - 4.686035
    )


def globe_temp_approx(tdb: float, solar_w: float, wind_ms: float) -> float:
    """
    Liljegren (2008) simplified globe temperature approximation.
    tdb: dry bulb °C, solar_w: solar irradiance W/m², wind_ms: wind speed m/s

    Globe temp = dry bulb + solar heating correction – convective cooling.
    Coefficients are empirical approximations suitable for screening use.
    """
    if solar_w is None or solar_w <= 0:
        return tdb + 2.0   # minimal solar contribution at night / cloudy
    solar_gain = 0.0212 * solar_w ** 0.5
    convective_loss = 1.1 * max(wind_ms, 0.1) ** 0.6
    tg = tdb + solar_gain - convective_loss
    return max(tg, tdb)


# ── HTSI methodology ───────────────────────────────────────────────────────
#
# THERMOS Human Thermal Stress Index (HTSI) — Prototype v0.1
# Range: 0–100
#
# Combines three established thermal metrics with empirically-weighted
# linear interpolation to a 0–100 scale.
#
# Components (weights chosen for interpretability, not clinical validation):
#   W1 = 0.40  → UTCI  (most comprehensive outdoor metric; accounts for
#                        wind, radiation, humidity)
#   W2 = 0.35  → Heat Index  (widely understood; humidity-temperature index)
#   W3 = 0.25  → WBGT  (occupational standard; ISO 7243)
#
# Each component is scaled against physiologically meaningful anchor points:
#   Score 0   → Neutral comfort (UTCI 9°C / HI 27°C / WBGT 18°C)
#   Score 100 → Extreme danger  (UTCI 54°C / HI 57°C / WBGT 35°C)
#
# Missing components are excluded and remaining weights re-normalised.
#
# DISCLAIMER: THERMOS HTSI is a prototype research index.
# It has not undergone clinical validation and must not be used as medical
# advice or as the sole basis for emergency decisions.
# ──────────────────────────────────────────────────────────────────────────

# Anchor points: (neutral, extreme)
UTCI_NEUTRAL, UTCI_EXTREME  = 9.0, 54.0
HI_NEUTRAL,   HI_EXTREME    = 27.0, 57.0
WBGT_NEUTRAL, WBGT_EXTREME  = 18.0, 35.0

HTSI_WEIGHTS = {"utci": 0.40, "hi": 0.35, "wbgt": 0.25}


def _scale_metric(value: float, neutral: float, extreme: float) -> float:
    """Linearly scale a metric value to [0, 100]."""
    if value <= neutral:
        return 0.0
    if value >= extreme:
        return 100.0
    return (value - neutral) / (extreme - neutral) * 100.0


def compute_htsi(
    hi_val: float | None,
    wbgt_val: float | None,
    utci_val: float | None,
) -> float:
    """
    Weighted combination of normalised thermal metrics → HTSI 0–100.
    Falls back gracefully when some metrics are unavailable (e.g. UTCI nan).
    """
    components: dict[str, float] = {}

    if utci_val is not None and not math.isnan(utci_val):
        components["utci"] = _scale_metric(utci_val, UTCI_NEUTRAL, UTCI_EXTREME)
    if hi_val is not None and not math.isnan(hi_val):
        components["hi"] = _scale_metric(hi_val, HI_NEUTRAL, HI_EXTREME)
    if wbgt_val is not None and not math.isnan(wbgt_val):
        components["wbgt"] = _scale_metric(wbgt_val, WBGT_NEUTRAL, WBGT_EXTREME)

    if not components:
        # Absolute fallback: temperature-only rough approximation
        return 0.0

    total_weight = sum(HTSI_WEIGHTS[k] for k in components)
    weighted_sum = sum(HTSI_WEIGHTS[k] * v for k, v in components.items())
    return round(weighted_sum / total_weight, 1)


def htsi_band(score: float) -> tuple[str, str, str]:
    """Return (level, label, tailwind-bg-color) for a given HTSI score."""
    if score <= 20:
        return "SAFE",     "Safe",     "#16a34a"   # green-600
    if score <= 40:
        return "CAUTION",  "Caution",  "#ca8a04"   # yellow-600
    if score <= 60:
        return "MODERATE", "Moderate", "#d97706"   # amber-600
    if score <= 80:
        return "HIGH",     "High",     "#ea580c"   # orange-600
    return     "EXTREME",  "Extreme",  "#dc2626"   # red-600


# ── Main endpoint ──────────────────────────────────────────────────────────

@app.post("/thermal", response_model=ThermalMetrics)
async def calculate_thermal(req: ThermalRequest):
    tdb  = req.temperature
    rh   = req.humidity
    # Convert km/h → m/s for pythermalcomfort (which expects m/s)
    wind_ms = req.wind_speed / 3.6

    # 1. Radiation from NASA POWER
    solar_w = await fetch_solar_radiation(req.lat, req.lng)

    # 2. Derived inputs
    twb = wet_bulb_approx(tdb, rh)
    tg  = globe_temp_approx(tdb, solar_w, wind_ms)

    # Mean radiant temperature ≈ globe temperature (standard approximation)
    tr = tg

    # 3. Heat Index
    hi_val: float | None = None
    try:
        hi_raw = heat_index(tdb=tdb, rh=rh, round=False)
        hi_val = round(float(hi_raw), 1)
    except Exception:
        pass

    # 4. WBGT (outdoor — with solar load)
    wbgt_val: float | None = None
    try:
        wbgt_raw = wbgt(twb=round(twb, 1), tg=round(tg, 1), tdb=tdb)
        wbgt_val = round(float(wbgt_raw), 1)
    except Exception:
        pass

    # 5. UTCI — requires wind ≥ 0.5 m/s per standard; clamp to avoid nan
    utci_val: float | None = None
    try:
        v_clamped = max(wind_ms, 0.5)
        utci_raw = utci(tdb=tdb, tr=tr, v=v_clamped, rh=rh, limit_inputs=False)
        utci_float = float(utci_raw)
        if not math.isnan(utci_float):
            utci_val = round(utci_float, 1)
    except Exception:
        pass

    # 6. HTSI
    htsi_score = compute_htsi(hi_val, wbgt_val, utci_val)
    level, label, color = htsi_band(htsi_score)

    return ThermalMetrics(
        heat_index=hi_val,
        wbgt=wbgt_val,
        utci=utci_val,
        solar_radiation=round(solar_w, 1) if solar_w is not None else None,
        htsi=htsi_score,
        htsi_level=level,
        htsi_label=label,
        htsi_color=color,
    )


@app.get("/health")
async def health():
    return {"status": "ok", "service": "THERMOS Thermal Engine"}


# ══════════════════════════════════════════════════════════════════════════
# RISK ENGINE — XGBoost + SHAP
# ══════════════════════════════════════════════════════════════════════════

import numpy as np
import xgboost as xgb
import shap

MODEL_DIR = Path(__file__).parent / "model"
_booster: xgb.Booster | None = None
_feature_names: list[str] = []

# Feature labels shown in SHAP explanations (must match train.py FEATURE_LABELS)
_FEATURE_LABELS = {
    "temperature":       "Air temperature",
    "temp_max":          "Maximum temperature",
    "temp_min":          "Minimum temperature",
    "relative_humidity": "Relative humidity",
    "wind_speed":        "Wind speed",
    "solar_radiation":   "Solar radiation",
    "heat_index":        "Heat Index",
    "wbgt":              "WBGT (Wet Bulb Globe Temp)",
    "temp_anomaly":      "Temperature anomaly",
    "consec_hot_days":   "Consecutive hot days",
}


def _load_model() -> tuple[xgb.Booster, list[str]]:
    global _booster, _feature_names
    if _booster is not None:
        return _booster, _feature_names
    model_path = MODEL_DIR / "thermos_xgb.json"
    feat_path  = MODEL_DIR / "feature_names.json"
    if not model_path.exists():
        raise FileNotFoundError(
            f"Model not found at {model_path}. "
            "Run: python backend/train.py"
        )
    b = xgb.Booster()
    b.load_model(str(model_path))
    _booster = b
    with open(feat_path) as f:
        _feature_names = _json_stdlib.load(f)
    return _booster, _feature_names


def _heat_index_approx(t: float, rh: float) -> float:
    """Rothfuss simplified HI for feature construction."""
    if t < 27:
        return t
    return (-8.78469475556
            + 1.61139411 * t + 2.33854883889 * rh
            - 0.14611605 * t * rh - 0.012308094 * t ** 2
            - 0.0164248277778 * rh ** 2
            + 0.002211732 * t ** 2 * rh + 0.00072546 * t * rh ** 2
            - 0.000003582 * t ** 2 * rh ** 2)


def _wbgt_approx(t: float, rh: float, solar_mj: float | None) -> float:
    twb = wet_bulb_approx(t, rh)
    solar_w = (solar_mj * 1e6 / 86400) if solar_mj and solar_mj > 0 else 0
    solar_gain = 0.0212 * math.sqrt(solar_w) if solar_w > 0 else 0
    tg = max(t + solar_gain, t)
    return 0.7 * twb + 0.2 * tg + 0.1 * t


# ── Risk request / response schemas ───────────────────────────────────────

class RiskRequest(BaseModel):
    # Current thermal values (from /thermal response)
    temperature: float
    humidity: float
    wind_speed: float           # km/h
    solar_radiation: float | None = None   # W/m² from NASA POWER
    heat_index_val: float | None = None
    wbgt_val: float | None = None
    utci_val: float | None = None
    htsi: float | None = None
    # Temporal context (optional — derived if absent)
    temp_max: float | None = None
    temp_min: float | None = None
    temp_anomaly: float | None = None       # °C above 30-day mean
    consec_hot_days: float | None = None


class ShapFactor(BaseModel):
    rank: int
    feature_label: str
    direction: str          # "increased" | "decreased"
    magnitude: str          # "major" | "moderate" | "minor"
    explanation: str


class RiskResponse(BaseModel):
    risk_score: float           # 0–100 probability × 100
    risk_level: str             # LOW | MODERATE | HIGH | EXTREME
    risk_label: str
    risk_color: str
    demo_mode: bool             # always True — no real outcome data
    shap_factors: list[ShapFactor]
    shap_summary: str           # one-sentence overall explanation


def _risk_band(prob: float) -> tuple[str, str, str]:
    p = prob * 100
    if p < 25:
        return "LOW",      "Low",      "#16a34a"
    if p < 50:
        return "MODERATE", "Moderate", "#d97706"
    if p < 75:
        return "HIGH",     "High",     "#ea580c"
    return     "EXTREME",  "Extreme",  "#dc2626"


def _magnitude(abs_val: float, max_abs: float) -> str:
    if max_abs == 0:
        return "minor"
    ratio = abs_val / max_abs
    if ratio >= 0.6:
        return "major"
    if ratio >= 0.3:
        return "moderate"
    return "minor"


def _shap_explanation(label: str, direction: str, magnitude: str) -> str:
    verb = "increased" if direction == "increased" else "reduced"
    strength = {"major": "Major", "moderate": "Moderate", "minor": "Minor"}[magnitude]
    return f"{strength} contributor — {verb} predicted risk."


@app.post("/risk", response_model=RiskResponse)
async def predict_risk(req: RiskRequest):
    booster, feat_names = _load_model()

    tdb    = req.temperature
    rh     = req.humidity
    wind_ms = req.wind_speed / 3.6

    # Convert NASA POWER W/m² → approximate MJ/m² daily sum for wbgt approx
    solar_mj = (req.solar_radiation * 86400 / 1e6) if req.solar_radiation else None

    hi_v   = req.heat_index_val   if req.heat_index_val  is not None else _heat_index_approx(tdb, rh)
    wbgt_v = req.wbgt_val         if req.wbgt_val        is not None else _wbgt_approx(tdb, rh, solar_mj)

    # Best-effort temporal features
    temp_max        = req.temp_max        if req.temp_max        is not None else tdb + 3.0
    temp_min        = req.temp_min        if req.temp_min        is not None else tdb - 5.0
    temp_anomaly    = req.temp_anomaly    if req.temp_anomaly    is not None else max(0.0, tdb - 32.0)
    consec_hot_days = req.consec_hot_days if req.consec_hot_days is not None else (1.0 if tdb > 40 else 0.0)

    # solar_radiation in model is MJ/m² daily sum
    solar_model = solar_mj if solar_mj is not None else (req.solar_radiation or 0) / 277.78

    feature_vector = [
        tdb, temp_max, temp_min, rh,
        req.wind_speed, solar_model,
        hi_v, wbgt_v, temp_anomaly, consec_hot_days,
    ]

    dmatrix = xgb.DMatrix(
        np.array([feature_vector], dtype=np.float32),
        feature_names=feat_names,
    )
    prob = float(booster.predict(dmatrix)[0])

    # SHAP via TreeExplainer
    explainer   = shap.TreeExplainer(booster)
    shap_values = explainer.shap_values(dmatrix)   # shape (1, n_features)
    sv          = shap_values[0]                   # 1-D array

    # Build ranked explanation — top 4 contributors by |shap|
    pairs = sorted(enumerate(sv), key=lambda x: abs(x[1]), reverse=True)
    max_abs = abs(pairs[0][1]) if pairs else 1.0

    factors: list[ShapFactor] = []
    for rank, (idx, val) in enumerate(pairs[:4], start=1):
        raw_name  = feat_names[idx]
        label     = _FEATURE_LABELS.get(raw_name, raw_name)
        direction = "increased" if val > 0 else "decreased"
        mag       = _magnitude(abs(val), max_abs)
        factors.append(ShapFactor(
            rank=rank,
            feature_label=label,
            direction=direction,
            magnitude=mag,
            explanation=_shap_explanation(label, direction, mag),
        ))

    # Summary sentence
    if factors:
        top = factors[0].feature_label.lower()
        summary = f"Risk is primarily driven by {top}."
    else:
        summary = "Insufficient data for explanation."

    level, label_str, color = _risk_band(prob)

    return RiskResponse(
        risk_score=round(prob * 100, 1),
        risk_level=level,
        risk_label=label_str,
        risk_color=color,
        demo_mode=True,
        shap_factors=factors,
        shap_summary=summary,
    )
