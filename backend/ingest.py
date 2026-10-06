"""
THERMOS Historical Weather Ingestion
=====================================
Fetches daily historical weather from the Open-Meteo Archive API for all
supported NCR districts and stores it in Supabase historical_weather.

Usage:
    python ingest.py                          # last 30 days
    python ingest.py --start 2024-03-01       # from date to yesterday
    python ingest.py --start 2024-03-01 --end 2024-05-31
    python ingest.py --district "Central"     # single district
    python ingest.py --dry-run                # fetch only, skip DB write

Prerequisites:
    - Copy backend/.env.example to backend/.env and fill in Supabase keys
    - Schema applied in Supabase SQL editor (see schema.sql)
    - pip install supabase python-dotenv httpx

Open-Meteo Archive API: https://archive-api.open-meteo.com/v1/archive
  Free, no API key required, data available from 1940-01-01.
  Uses ERA5 / ERA5-Land reanalysis — not station data.
"""

import argparse
import sys
from datetime import date, timedelta
import httpx
from dotenv import load_dotenv
import os

load_dotenv()

# ── District centroid table ────────────────────────────────────────────────
# Matches GeoJSON DISTRICT property values exactly.
# lat/lng used as coordinate input for Open-Meteo Archive API.

DISTRICTS: dict[str, dict] = {
    # NCT of Delhi
    "Central":       {"lat": 28.6448, "lng": 77.2167, "state": "NCT of Delhi"},
    "East":          {"lat": 28.6692, "lng": 77.2948, "state": "NCT of Delhi"},
    "New Delhi":     {"lat": 28.6139, "lng": 77.2090, "state": "NCT of Delhi"},
    "North":         {"lat": 28.7191, "lng": 77.2080, "state": "NCT of Delhi"},
    "North East":    {"lat": 28.6921, "lng": 77.2856, "state": "NCT of Delhi"},
    "North West":    {"lat": 28.7278, "lng": 77.1261, "state": "NCT of Delhi"},
    "South":         {"lat": 28.5355, "lng": 77.2500, "state": "NCT of Delhi"},
    "South West":    {"lat": 28.5928, "lng": 77.0616, "state": "NCT of Delhi"},
    "West":          {"lat": 28.6510, "lng": 77.1000, "state": "NCT of Delhi"},
    # Uttar Pradesh
    "Ghaziabad":            {"lat": 28.6692, "lng": 77.4538, "state": "Uttar Pradesh"},
    "Gautam Buddha Nagar":  {"lat": 28.5355, "lng": 77.3910, "state": "Uttar Pradesh"},
    # Haryana  (GeoJSON key = "Gurgaon", display = "Gurugram")
    "Gurgaon":   {"lat": 28.4595, "lng": 77.0266, "state": "Haryana"},
    "Faridabad": {"lat": 28.4089, "lng": 77.3178, "state": "Haryana"},
}

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
SOURCE_TAG  = "open-meteo-archive"


# ── Open-Meteo Archive fetch ───────────────────────────────────────────────

def fetch_historical(
    lat: float,
    lng: float,
    start: date,
    end: date,
) -> list[dict]:
    """
    Fetch daily historical weather from Open-Meteo Archive API.
    Returns a list of row dicts ready for Supabase insert.
    No API key required.
    """
    params = {
        "latitude":  lat,
        "longitude": lng,
        "start_date": start.isoformat(),
        "end_date":   end.isoformat(),
        "daily": ",".join([
            "temperature_2m_mean",
            "temperature_2m_max",
            "temperature_2m_min",
            "relative_humidity_2m_mean",
            "wind_speed_10m_mean",
            "wind_direction_10m_dominant",
            "shortwave_radiation_sum",   # MJ/m² daily sum
            "precipitation_sum",
        ]),
        "timezone": "Asia/Kolkata",
        "wind_speed_unit": "kmh",
    }

    with httpx.Client(timeout=30.0) as client:
        r = client.get(ARCHIVE_URL, params=params)
        r.raise_for_status()

    data  = r.json()
    daily = data.get("daily", {})
    times = daily.get("time", [])

    if not times:
        return []

    rows = []
    for i, t in enumerate(times):
        rows.append({
            "timestamp":          t,
            "temperature":        _safe(daily, "temperature_2m_mean",            i),
            "temp_max":           _safe(daily, "temperature_2m_max",             i),
            "temp_min":           _safe(daily, "temperature_2m_min",             i),
            "relative_humidity":  _safe(daily, "relative_humidity_2m_mean",      i),
            "wind_speed":         _safe(daily, "wind_speed_10m_mean",            i),
            "wind_direction":     _safe(daily, "wind_direction_10m_dominant",    i),
            "solar_radiation":    _safe(daily, "shortwave_radiation_sum",        i),
            "precipitation":      _safe(daily, "precipitation_sum",              i),
            "source":             SOURCE_TAG,
        })

    return rows


def _safe(daily: dict, key: str, i: int):
    """Return value or None if missing/null."""
    val = daily.get(key, [None])
    if i < len(val):
        v = val[i]
        return None if v is None else round(float(v), 2)
    return None


# ── Supabase helpers ──────────────────────────────────────────────────────

import base64, json as _json

def _decode_jwt_role(key: str) -> str:
    """Return the 'role' claim from a Supabase JWT key without verifying it."""
    try:
        payload = key.split(".")[1]
        payload += "=" * (4 - len(payload) % 4)
        return _json.loads(base64.b64decode(payload)).get("role", "unknown")
    except Exception:
        return "unknown"


def preflight_check(url: str, key: str) -> None:
    """
    Verify the Supabase project is reachable and the table exists.
    Raises RuntimeError with an actionable message on any problem.
    """
    role = _decode_jwt_role(key)
    if role == "anon":
        raise RuntimeError(
            "SUPABASE_SERVICE_KEY contains the ANON key (role=anon).\n"
            "Ingestion requires the SERVICE ROLE key.\n"
            "  → Supabase dashboard → Project Settings → API\n"
            "     → copy 'service_role' key (not 'anon') into backend/.env"
        )

    # Try to reach the PostgREST endpoint
    try:
        r = httpx.get(
            f"{url}/rest/v1/",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=10,
        )
    except httpx.ConnectError:
        raise RuntimeError(f"Cannot connect to Supabase at {url}. Check SUPABASE_URL.")

    if r.status_code == 404 and "PGRST125" in r.text:
        raise RuntimeError(
            "Supabase PostgREST returned 404 (PGRST125) — two likely causes:\n"
            "  1. Project is PAUSED (free tier pauses after 7 days idle).\n"
            "     → Go to app.supabase.com → your project → click 'Resume'\n"
            "  2. Schema not applied yet.\n"
            "     → Run backend/schema.sql in the Supabase SQL editor first."
        )

    if r.status_code not in (200, 301, 404):
        raise RuntimeError(f"Unexpected Supabase response: {r.status_code} {r.text[:200]}")

    # Confirm the table exists (a 200 or empty 200 is fine; 404 on the table = missing)
    r2 = httpx.get(
        f"{url}/rest/v1/historical_weather?limit=0",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=10,
    )
    if r2.status_code == 404:
        raise RuntimeError(
            "Table 'historical_weather' not found in Supabase.\n"
            "  → Apply backend/schema.sql in the Supabase SQL editor, then retry."
        )
    if r2.status_code not in (200,):
        raise RuntimeError(
            f"Unexpected response querying historical_weather: "
            f"{r2.status_code} {r2.text[:200]}"
        )


def get_supabase_client(url: str, key: str):
    from supabase import create_client
    return create_client(url, key)


def upsert_rows(client, district_id: str, rows: list[dict]) -> int:
    """
    Upsert rows into historical_weather.
    Uses (district_id, timestamp, source) unique index — safe to re-run.
    Returns number of rows affected.
    """
    if not rows:
        return 0

    payload = [{"district_id": district_id, **r} for r in rows]

    result = (
        client.table("historical_weather")
        .upsert(payload, on_conflict="district_id,timestamp,source")
        .execute()
    )
    return len(result.data) if result.data else len(payload)


# ── CLI ────────────────────────────────────────────────────────────────────

def parse_args():
    yesterday = date.today() - timedelta(days=1)
    default_start = yesterday - timedelta(days=29)   # last 30 days

    p = argparse.ArgumentParser(description="THERMOS historical weather ingestion")
    p.add_argument(
        "--start",
        default=default_start.isoformat(),
        help=f"Start date YYYY-MM-DD (default: {default_start})",
    )
    p.add_argument(
        "--end",
        default=yesterday.isoformat(),
        help=f"End date YYYY-MM-DD (default: {yesterday})",
    )
    p.add_argument(
        "--district",
        default=None,
        help="Single district name to ingest (default: all)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch data but skip Supabase write",
    )
    return p.parse_args()


def main():
    args = parse_args()

    start = date.fromisoformat(args.start)
    end   = date.fromisoformat(args.end)

    if start > end:
        print(f"ERROR: start {start} is after end {end}", file=sys.stderr)
        sys.exit(1)

    # Don't allow future end dates
    yesterday = date.today() - timedelta(days=1)
    if end > yesterday:
        print(f"Clamping end date to yesterday ({yesterday})")
        end = yesterday

    districts = DISTRICTS
    if args.district:
        if args.district not in DISTRICTS:
            print(
                f"ERROR: unknown district '{args.district}'. "
                f"Valid: {list(DISTRICTS.keys())}",
                file=sys.stderr,
            )
            sys.exit(1)
        districts = {args.district: DISTRICTS[args.district]}

    print(f"THERMOS ingestion  {start} → {end}  ({(end - start).days + 1} days)")
    print(f"Districts: {len(districts)}  |  dry-run: {args.dry_run}")
    print()

    # Only initialise Supabase client if we're actually writing
    client = None
    if not args.dry_run:
        url = os.environ.get("SUPABASE_URL", "").strip()
        key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
        if not url or not key:
            print(
                "ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in backend/.env\n"
                "  Copy backend/.env.example -> backend/.env and fill in your values.",
                file=sys.stderr,
            )
            sys.exit(1)
        try:
            print("Supabase: running preflight check...")
            preflight_check(url, key)
            client = get_supabase_client(url, key)
            print("Supabase: connected OK")
        except RuntimeError as e:
            print(f"\nERROR: {e}", file=sys.stderr)
            sys.exit(1)

    total_rows  = 0
    total_upserted = 0
    errors: list[str] = []

    for district_id, meta in districts.items():
        print(f"  Fetching {district_id} ({meta['state']}) ...", end=" ", flush=True)
        try:
            rows = fetch_historical(meta["lat"], meta["lng"], start, end)
            print(f"{len(rows)} days fetched", end="")

            if not args.dry_run and rows:
                upserted = upsert_rows(client, district_id, rows)
                print(f", {upserted} upserted", end="")

            print()
            total_rows += len(rows)
            total_upserted += len(rows) if not args.dry_run else 0

        except Exception as e:
            print(f"  FAILED: {e}")
            errors.append(f"{district_id}: {e}")

    print()
    print(f"Done. {total_rows} rows fetched, {total_upserted} upserted.")
    if errors:
        print(f"Errors ({len(errors)}):")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
