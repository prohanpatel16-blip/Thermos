-- THERMOS Supabase schema
-- Run once in the Supabase SQL editor.
-- Only the tables explicitly required by the ML pipeline are created here.

-- historical_weather
-- Stores daily weather observations for NCR districts.
-- district_id matches the GeoJSON DISTRICT property value (e.g. "Central",
-- "Ghaziabad"). No separate districts table is required.

create table if not exists historical_weather (
    id              bigserial primary key,
    district_id     text        not null,   -- GeoJSON DISTRICT key
    timestamp       date        not null,   -- observation date (local IST)
    temperature     numeric(5,2),           -- °C  daily mean
    temp_max        numeric(5,2),           -- °C  daily max
    temp_min        numeric(5,2),           -- °C  daily min
    relative_humidity numeric(5,1),         -- %   daily mean
    wind_speed      numeric(6,2),           -- km/h daily mean
    wind_direction  numeric(6,1),           -- degrees daily dominant
    solar_radiation numeric(8,2),           -- MJ/m²  daily sum (Open-Meteo)
    precipitation   numeric(7,2),           -- mm  daily sum
    source          text        not null default 'open-meteo-archive',
    created_at      timestamptz not null default now()
);

-- Unique constraint: one row per district per day per source
create unique index if not exists historical_weather_district_date_uidx
    on historical_weather (district_id, timestamp, source);

-- Index for ML queries that filter by district + time range
create index if not exists historical_weather_district_ts_idx
    on historical_weather (district_id, timestamp desc);
