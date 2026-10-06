"""
THERMOS XGBoost Training Script
=================================
Trains a heatwave risk model on historical weather data.

Data source priority:
  1. Supabase historical_weather (if configured and populated)
  2. Open-Meteo Archive API fallback (fetches on the fly)

Target variable: synthetic "heat_stress_risk" (0/1) derived from thermal
thresholds — clearly labelled DEMO/DEVELOPMENT throughout.

No real mortality or hospitalization data is used.
Synthetic labels are derived from established thermal thresholds only.

Output: backend/model/thermos_xgb.json  (XGBoost JSON format)
        backend/model/feature_names.json

Usage:
    python train.py                     # Supabase → fallback auto
    python train.py --source archive    # force Open-Meteo Archive
    python train.py --start 2023-01-01  # custom date range
"""

import argparse
import json
import math
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import httpx
import numpy as np
import pandas as pd
import xgboost as xgb
from dotenv import load_dotenv
from sklearn.metrics import classification_report, roc_auc_score

load_dotenv()

MODEL_DIR = Path(__file__).parent / "model"
MODEL_PATH = MODEL_DIR / "thermos_xgb.json"
FEATURE_NAMES_PATH = MODEL_DIR / "feature_names.json"

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# All NCR districts with centroids
DISTRICTS = {
    "Central":              {"lat": 28.6448, "lng": 77.2167},
    "East":                 {"lat": 28.6692, "lng": 77.2948},
    "New Delhi":            {"lat": 28.6139, "lng": 77.2090},
    "North":                {"lat": 28.7191, "lng": 77.2080},
    "North East":           {"lat": 28.6921, "lng": 77.2856},
    "North West":           {"lat": 28.7278, "lng": 77.1261},
    "South":                {"lat": 28.5355, "lng": 77.2500},
    "South West":           {"lat": 28.5928, "lng": 77.0616},
    "West":                 {"lat": 28.6510, "lng": 77.1000},
    "Ghaziabad":            {"lat": 28.6692, "lng": 77.4538},
    "Gautam Buddha Nagar":  {"lat": 28.5355, "lng": 77.3910},
    "Gurgaon":              {"lat": 28.4595, "lng": 77.0266},
    "Faridabad":            {"lat": 28.4089, "lng": 77.3178},
}


# ── Data loading ───────────────────────────────────────────────────────────

def load_from_supabase(start: date, end: date) -> pd.DataFrame | None:
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        return None
    try:
        from supabase import create_client
        sb = create_client(url, key)
        result = (
            sb.table("historical_weather")
            .select("*")
            .gte("timestamp", start.isoformat())
            .lte("timestamp", end.isoformat())
            .execute()
        )
        if not result.data:
            return None
        df = pd.DataFrame(result.data)
        print(f"  Supabase: {len(df)} rows loaded")
        return df
    except Exception as e:
        print(f"  Supabase unavailable ({e}), falling back to archive API")
        return None


def load_from_archive(start: date, end: date) -> pd.DataFrame:
    rows = []
    for district_id, meta in DISTRICTS.items():
        params = {
            "latitude": meta["lat"],
            "longitude": meta["lng"],
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "daily": ",".join([
                "temperature_2m_mean", "temperature_2m_max", "temperature_2m_min",
                "relative_humidity_2m_mean", "wind_speed_10m_mean",
                "shortwave_radiation_sum", "precipitation_sum",
            ]),
            "timezone": "Asia/Kolkata",
            "wind_speed_unit": "kmh",
        }
        try:
            with httpx.Client(timeout=30.0) as client:
                r = client.get(ARCHIVE_URL, params=params)
                r.raise_for_status()
            d = r.json().get("daily", {})
            for i, t in enumerate(d.get("time", [])):
                rows.append({
                    "district_id":        district_id,
                    "timestamp":          t,
                    "temperature":        _s(d, "temperature_2m_mean", i),
                    "temp_max":           _s(d, "temperature_2m_max", i),
                    "temp_min":           _s(d, "temperature_2m_min", i),
                    "relative_humidity":  _s(d, "relative_humidity_2m_mean", i),
                    "wind_speed":         _s(d, "wind_speed_10m_mean", i),
                    "solar_radiation":    _s(d, "shortwave_radiation_sum", i),
                    "precipitation":      _s(d, "precipitation_sum", i),
                })
            print(f"  Archive: {district_id} — {len(d.get('time',[]))} days")
        except Exception as e:
            print(f"  Archive: {district_id} FAILED — {e}")
    return pd.DataFrame(rows)


def _s(d, k, i):
    v = d.get(k, [None])
    return None if i >= len(v) or v[i] is None else float(v[i])


# ── Thermal approximations (pure Python, no FastAPI dependency) ────────────

def _wet_bulb(tdb, rh):
    return (
        tdb * math.atan(0.151977 * math.sqrt(rh + 8.313659))
        + math.atan(tdb + rh)
        - math.atan(rh - 1.676331)
        + 0.00391838 * rh ** 1.5 * math.atan(0.023101 * rh)
        - 4.686035
    )


def _heat_index(t, rh):
    """Rothfuss simplified HI (°C)."""
    if t < 27:
        return t
    hi = (-8.78469475556
          + 1.61139411 * t
          + 2.33854883889 * rh
          - 0.14611605 * t * rh
          - 0.012308094 * t ** 2
          - 0.0164248277778 * rh ** 2
          + 0.002211732 * t ** 2 * rh
          + 0.00072546 * t * rh ** 2
          - 0.000003582 * t ** 2 * rh ** 2)
    return hi


def _wbgt_simple(tdb, rh, solar_mj):
    """Simplified WBGT (°C) from daily mean values."""
    twb = _wet_bulb(tdb, rh)
    # Convert MJ/m² daily sum → approximate W/m² instantaneous (÷ 3600)
    solar_w = (solar_mj * 1e6 / 86400) if solar_mj and solar_mj > 0 else 0
    solar_gain = 0.0212 * math.sqrt(solar_w) if solar_w > 0 else 0
    tg = max(tdb + solar_gain, tdb)
    return 0.7 * twb + 0.2 * tg + 0.1 * tdb


# ── Feature engineering ────────────────────────────────────────────────────

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values(["district_id", "timestamp"]).reset_index(drop=True)

    # Fill missing numerics with district median
    num_cols = ["temperature", "temp_max", "temp_min", "relative_humidity",
                "wind_speed", "solar_radiation", "precipitation"]
    for col in num_cols:
        if col not in df.columns:
            df[col] = np.nan
        df[col] = pd.to_numeric(df[col], errors="coerce")
        df[col] = df.groupby("district_id")[col].transform(
            lambda x: x.fillna(x.median())
        )

    # Thermal metrics
    df["heat_index"] = df.apply(
        lambda r: _heat_index(r.temperature, r.relative_humidity)
        if pd.notna(r.temperature) and pd.notna(r.relative_humidity) else np.nan,
        axis=1,
    )
    df["wbgt"] = df.apply(
        lambda r: _wbgt_simple(r.temperature, r.relative_humidity, r.solar_radiation)
        if pd.notna(r.temperature) and pd.notna(r.relative_humidity) else np.nan,
        axis=1,
    )

    # Temporal features per district
    grp = df.groupby("district_id")

    # 30-day rolling mean temperature (historical baseline)
    df["temp_30d_mean"] = grp["temperature"].transform(
        lambda x: x.rolling(30, min_periods=5).mean()
    )
    df["temp_anomaly"] = df["temperature"] - df["temp_30d_mean"]

    # Consecutive hot days (temp_max > 40°C)
    def _consec_hot(s):
        result = np.zeros(len(s))
        count = 0
        for i, v in enumerate(s):
            count = (count + 1) if (pd.notna(v) and v > 40.0) else 0
            result[i] = count
        return pd.Series(result, index=s.index)

    df["consec_hot_days"] = grp["temp_max"].transform(_consec_hot)

    # ── Synthetic risk label ───────────────────────────────────────────────
    # DEMO/DEVELOPMENT — derived from thermal thresholds only.
    # No real health outcome data used.
    # Risk = 1 if ANY of:
    #   temp_max > 42°C  OR  heat_index > 52°C  OR  wbgt > 32°C
    #   OR (temp_max > 40 AND humidity > 60)
    df["risk"] = (
        (df["temp_max"] > 42)
        | (df["heat_index"] > 52)
        | (df["wbgt"] > 32)
        | ((df["temp_max"] > 40) & (df["relative_humidity"] > 60))
    ).astype(int)

    return df


FEATURE_COLS = [
    "temperature", "temp_max", "temp_min",
    "relative_humidity", "wind_speed", "solar_radiation",
    "heat_index", "wbgt",
    "temp_anomaly", "consec_hot_days",
]

# Human-readable feature labels for SHAP explanations
FEATURE_LABELS = {
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


# ── Training ───────────────────────────────────────────────────────────────

def train(df: pd.DataFrame) -> xgb.XGBClassifier:
    df = engineer_features(df)
    df = df.dropna(subset=FEATURE_COLS + ["risk"])

    if len(df) < 30:
        raise ValueError(
            f"Only {len(df)} usable rows after feature engineering. "
            "Need at least 30. Ingest more historical data first."
        )

    X = df[FEATURE_COLS].values
    y = df["risk"].values

    # Chronological split — last 20% as validation
    split = int(len(df) * 0.8)
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    pos_weight = max(1.0, (y_train == 0).sum() / max((y_train == 1).sum(), 1))

    model = xgb.XGBClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=pos_weight,
        use_label_encoder=False,
        eval_metric="logloss",
        random_state=42,
        verbosity=0,
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        verbose=False,
    )

    # Validation report
    y_pred = model.predict(X_val)
    y_prob = model.predict_proba(X_val)[:, 1]
    print("\nValidation results (DEMO/DEVELOPMENT — synthetic labels):")
    print(classification_report(y_val, y_pred, target_names=["Low", "High"]))
    if len(np.unique(y_val)) > 1:
        print(f"  ROC-AUC: {roc_auc_score(y_val, y_prob):.3f}")
    print(f"  Train rows: {len(X_train)}  |  Val rows: {len(X_val)}")
    print(f"  Risk prevalence (train): {y_train.mean():.1%}")

    return model


# ── Main ───────────────────────────────────────────────────────────────────

def parse_args():
    yesterday = date.today() - timedelta(days=1)
    p = argparse.ArgumentParser(description="THERMOS XGBoost training")
    p.add_argument("--start", default="2022-01-01")
    p.add_argument("--end",   default=yesterday.isoformat())
    p.add_argument(
        "--source",
        choices=["auto", "supabase", "archive"],
        default="auto",
        help="Data source: auto tries Supabase first then archive",
    )
    return p.parse_args()


def main():
    args = parse_args()
    start = date.fromisoformat(args.start)
    end   = date.fromisoformat(args.end)

    print(f"THERMOS XGBoost training  {start} → {end}")
    print("NOTE: Synthetic risk labels — DEMO/DEVELOPMENT mode")
    print()

    # Load data
    df = None
    if args.source in ("auto", "supabase"):
        df = load_from_supabase(start, end)

    if df is None or len(df) < 30:
        print("Loading from Open-Meteo Archive API...")
        df = load_from_archive(start, end)

    if df is None or len(df) == 0:
        print("ERROR: No data loaded.", file=sys.stderr)
        sys.exit(1)

    print(f"\nTotal rows: {len(df)}")

    # Train
    print("\nTraining XGBoost...")
    model = train(df)

    # Save — use the underlying Booster to avoid XGBoost 2.x sklearn wrapper issue
    MODEL_DIR.mkdir(exist_ok=True)
    model.get_booster().save_model(str(MODEL_PATH))
    with open(FEATURE_NAMES_PATH, "w") as f:
        json.dump(FEATURE_COLS, f)
    print(f"\nModel saved → {MODEL_PATH}")
    print(f"Features   → {FEATURE_NAMES_PATH}")


if __name__ == "__main__":
    main()
