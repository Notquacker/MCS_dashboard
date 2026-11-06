-- =====================================================================
--  GACS / MCS — TTN sensordata in Supabase
--  Draai dit één keer in Supabase Studio → SQL Editor → New query.
--  Idempotent: je kunt 'm veilig opnieuw draaien.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELLEN
-- ---------------------------------------------------------------------

-- Eén rij per fysieke sensor. Wordt automatisch aangevuld bij ingest;
-- label/room/floor vul je zelf in zodat het dashboard nette namen toont.
create table if not exists public.devices (
  device_id       text primary key,
  application_id  text        not null,
  dev_eui         text,
  brand           text,
  model           text,
  label           text,                  -- bv. 'Kantoor zuid'
  room            text,                  -- bv. '2.14'
  floor           text,                  -- bv. '2'
  active          boolean     not null default true,
  first_seen      timestamptz,
  last_seen       timestamptz
);

comment on table public.devices is
  'LoRaWAN end-devices uit TTN. label/room/floor zijn handmatig; de rest vult ingest_uplink.';

-- Eén rij per ontvangen uplink. Bevat de volledige TTN payload voor audit
-- en her-verwerking. Deze tabel is NIET publiek leesbaar (zie RLS onderaan).
create table if not exists public.uplinks (
  id                bigint generated always as identity primary key,
  device_id         text        not null references public.devices(device_id) on update cascade,
  received_at       timestamptz not null,
  f_port            smallint,
  f_cnt             integer,
  frm_payload       text,
  decoded           jsonb,
  rssi              smallint,
  snr               real,
  spreading_factor  smallint,
  gateway_count     smallint,
  airtime_s         real,
  battery_pct       smallint,
  dedup_key         text        not null unique,
  raw               jsonb,
  inserted_at       timestamptz not null default now()
);

create index if not exists uplinks_device_time_idx
  on public.uplinks (device_id, received_at desc);
create index if not exists uplinks_time_idx
  on public.uplinks (received_at desc);

comment on column public.uplinks.dedup_key is
  'TTN correlation id (pba:uplink:...). Uniek, zodat retries en backfill niets dubbel schrijven.';

-- Long-format meetwaarden: één rij per metric per uplink.
-- Werkt voor elk device zonder schemawijziging — ook de Arduino MKR.
create table if not exists public.readings (
  uplink_id    bigint            not null references public.uplinks(id) on delete cascade,
  device_id    text              not null references public.devices(device_id) on update cascade,
  measured_at  timestamptz       not null,
  metric       text              not null,
  value        double precision  not null,
  primary key (uplink_id, metric)
);

create index if not exists readings_series_idx
  on public.readings (device_id, metric, measured_at desc);
create index if not exists readings_time_idx
  on public.readings (measured_at desc);
create index if not exists readings_metric_idx
  on public.readings (metric, measured_at desc);

comment on table public.readings is
  'Long format (device, tijd, metric, waarde). Netwerk-metrics staan onder het net.* prefix.';


-- ---------------------------------------------------------------------
-- 2. HULPFUNCTIE: jsonb platslaan naar numerieke metrics
--    {"air":{"temp":20.3},"ok":true}  ->  ('air.temp', 20.3), ('ok', 1)
--    Niet-numerieke waarden (strings, null) worden overgeslagen.
-- ---------------------------------------------------------------------
create or replace function public.jsonb_flatten_numeric(j jsonb, prefix text default '')
returns table (metric text, value double precision)
language plpgsql
immutable
as $$
declare
  k       text;
  v       jsonb;
  newkey  text;
  i       integer := 0;
begin
  if j is null then
    return;
  end if;

  case jsonb_typeof(j)
    when 'object' then
      for k, v in select e.key, e.value from jsonb_each(j) as e loop
        newkey := case when prefix = '' then k else prefix || '.' || k end;
        return query select * from public.jsonb_flatten_numeric(v, newkey);
      end loop;

    when 'array' then
      for v in select a.value from jsonb_array_elements(j) as a loop
        return query select * from public.jsonb_flatten_numeric(
          v, prefix || '[' || i::text || ']'
        );
        i := i + 1;
      end loop;

    when 'number' then
      if prefix <> '' then
        return query select prefix, (j #>> '{}')::double precision;
      end if;

    when 'boolean' then
      if prefix <> '' then
        return query select prefix,
          case when (j #>> '{}')::boolean then 1::double precision
               else 0::double precision end;
      end if;

    else
      null; -- string / null: negeren
  end case;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. INGEST
--    Neemt één TTN ApplicationUp object (de body die de webhook POST).
--    Geeft het uplink-id terug, of NULL bij een duplicaat / niet-uplink.
-- ---------------------------------------------------------------------
create or replace function public.ingest_uplink(payload jsonb)
returns bigint
language plpgsql
as $$
declare
  v_um      jsonb;
  v_device  text;
  v_app     text;
  v_eui     text;
  v_recv    timestamptz;
  v_dedup   text;
  v_rx      jsonb;
  v_id      bigint;
begin
  -- TTN stuurt ook joins, downlinks en status-events: die slaan we over.
  v_um := payload -> 'uplink_message';
  if v_um is null then
    return null;
  end if;

  v_device := payload #>> '{end_device_ids,device_id}';
  v_app    := payload #>> '{end_device_ids,application_ids,application_id}';
  v_eui    := payload #>> '{end_device_ids,dev_eui}';

  if v_device is null then
    return null;
  end if;

  v_recv := coalesce(
    (v_um    ->> 'received_at')::timestamptz,
    (payload ->> 'received_at')::timestamptz,
    now()
  );

  -- Dedup op de TTN correlation id; valt terug op device+f_cnt+tijd.
  v_dedup := coalesce(
    (select c
       from jsonb_array_elements_text(coalesce(payload -> 'correlation_ids', '[]'::jsonb)) c
      where c like 'pba:uplink:%'
      limit 1),
    (select c
       from jsonb_array_elements_text(coalesce(payload -> 'correlation_ids', '[]'::jsonb)) c
      limit 1),
    v_device || ':' || coalesce(v_um ->> 'f_cnt', '?') || ':' || v_recv::text
  );

  -- Device aanmaken of bijwerken (handmatige labels blijven staan).
  insert into public.devices as d
    (device_id, application_id, dev_eui, brand, model, first_seen, last_seen)
  values (
    v_device,
    coalesce(v_app, 'unknown'),
    v_eui,
    v_um #>> '{version_ids,brand_id}',
    v_um #>> '{version_ids,model_id}',
    v_recv,
    v_recv
  )
  on conflict (device_id) do update set
    last_seen  = greatest(coalesce(d.last_seen, excluded.last_seen), excluded.last_seen),
    first_seen = least(coalesce(d.first_seen, excluded.first_seen), excluded.first_seen),
    dev_eui    = coalesce(d.dev_eui, excluded.dev_eui),
    brand      = coalesce(excluded.brand, d.brand),
    model      = coalesce(excluded.model, d.model);

  -- Sterkste gateway van deze uplink = representatieve signaalkwaliteit.
  select g into v_rx
    from jsonb_array_elements(coalesce(v_um -> 'rx_metadata', '[]'::jsonb)) g
   order by (g ->> 'rssi')::numeric desc nulls last
   limit 1;

  insert into public.uplinks (
    device_id, received_at, f_port, f_cnt, frm_payload, decoded,
    rssi, snr, spreading_factor, gateway_count, airtime_s, battery_pct,
    dedup_key, raw
  )
  values (
    v_device,
    v_recv,
    nullif(v_um ->> 'f_port', '')::smallint,
    nullif(v_um ->> 'f_cnt', '')::integer,
    v_um ->> 'frm_payload',
    v_um -> 'decoded_payload',
    nullif(v_rx ->> 'rssi', '')::smallint,
    nullif(v_rx ->> 'snr', '')::real,
    nullif(v_um #>> '{settings,data_rate,lora,spreading_factor}', '')::smallint,
    jsonb_array_length(coalesce(v_um -> 'rx_metadata', '[]'::jsonb))::smallint,
    nullif(rtrim(v_um ->> 'consumed_airtime', 's'), '')::real,
    nullif(v_um #>> '{last_battery_percentage,value}', '')::smallint,
    v_dedup,
    payload
  )
  on conflict (dedup_key) do nothing
  returning id into v_id;

  if v_id is null then
    return null;  -- al eerder ontvangen
  end if;

  -- Sensorwaarden uit decoded_payload.
  insert into public.readings (uplink_id, device_id, measured_at, metric, value)
  select v_id, v_device, v_recv, f.metric, f.value
    from public.jsonb_flatten_numeric(coalesce(v_um -> 'decoded_payload', '{}'::jsonb)) f
  on conflict do nothing;

  -- Netwerk-metrics als gewone series, zodat het dashboard ze net zo kan plotten.
  insert into public.readings (uplink_id, device_id, measured_at, metric, value)
  select v_id, v_device, v_recv, m.metric, m.value
    from (values
      ('net.rssi',        nullif(v_rx ->> 'rssi', '')::double precision),
      ('net.snr',         nullif(v_rx ->> 'snr', '')::double precision),
      ('net.gateways',    jsonb_array_length(coalesce(v_um -> 'rx_metadata', '[]'::jsonb))::double precision),
      ('net.sf',          nullif(v_um #>> '{settings,data_rate,lora,spreading_factor}', '')::double precision),
      ('net.battery_pct', nullif(v_um #>> '{last_battery_percentage,value}', '')::double precision)
    ) as m(metric, value)
   where m.value is not null
  on conflict do nothing;

  return v_id;
end;
$$;

-- Batch-variant voor de backfill van je TTN exports.
create or replace function public.ingest_uplink_batch(payloads jsonb)
returns integer
language plpgsql
as $$
declare
  p        jsonb;
  n_new    integer := 0;
begin
  for p in select a.value from jsonb_array_elements(payloads) as a loop
    if public.ingest_uplink(p) is not null then
      n_new := n_new + 1;
    end if;
  end loop;
  return n_new;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. VIEWS VOOR HET DASHBOARD
-- ---------------------------------------------------------------------

-- Laatste waarde per device per metric.
create or replace view public.latest_readings
with (security_invoker = on) as
select distinct on (r.device_id, r.metric)
  r.device_id,
  r.metric,
  r.value,
  r.measured_at
from public.readings r
order by r.device_id, r.metric, r.measured_at desc;

-- Statusoverzicht per sensor: leeft 'ie nog, hoeveel uplinks vandaag.
create or replace view public.device_status
with (security_invoker = on) as
select
  d.device_id,
  coalesce(d.label, d.device_id)                          as display_name,
  d.room,
  d.floor,
  d.brand,
  d.model,
  d.last_seen,
  extract(epoch from (now() - d.last_seen)) / 60          as minutes_since_last,
  (d.last_seen > now() - interval '2 hours')              as online,
  (select count(*) from public.readings r
    where r.device_id = d.device_id
      and r.measured_at > now() - interval '24 hours'
      and r.metric not like 'net.%')                      as readings_24h
from public.devices d
where d.active;

-- Welke metrics heeft welk device? Het dashboard bouwt hier zijn menu's mee.
create or replace view public.device_metrics
with (security_invoker = on) as
select
  r.device_id,
  r.metric,
  count(*)        as samples,
  min(r.value)    as min_value,
  max(r.value)    as max_value,
  max(r.measured_at) as last_at
from public.readings r
group by r.device_id, r.metric;


-- ---------------------------------------------------------------------
-- 5. TIJDREEKS-RPC
--    Aggregeert naar buckets zodat een grafiek over 30 dagen niet
--    honderdduizend punten naar de browser stuurt.
-- ---------------------------------------------------------------------
create or replace function public.readings_binned(
  p_devices        text[],
  p_metric         text,
  p_from           timestamptz,
  p_to             timestamptz default now(),
  p_bucket_minutes integer default 15
)
returns table (
  device_id   text,
  bucket      timestamptz,
  avg_value   double precision,
  min_value   double precision,
  max_value   double precision,
  samples     integer
)
language sql
stable
as $$
  select
    r.device_id,
    to_timestamp(
      floor(extract(epoch from r.measured_at) / (greatest(p_bucket_minutes, 1) * 60))
      * (greatest(p_bucket_minutes, 1) * 60)
    ) as bucket,
    avg(r.value)        as avg_value,
    min(r.value)        as min_value,
    max(r.value)        as max_value,
    count(*)::integer   as samples
  from public.readings r
  where r.metric = p_metric
    and r.measured_at >= p_from
    and r.measured_at <= p_to
    and (p_devices is null or r.device_id = any(p_devices))
  group by r.device_id, 2
  order by r.device_id, 2;
$$;


-- ---------------------------------------------------------------------
-- 6. RLS — dashboard leest anoniem, alleen de Edge Function schrijft
--    De anon key staat straks publiek in je GitHub repo. Dat mag,
--    MITS deze policies kloppen: anon mag lezen, niets meer.
--    De Edge Function gebruikt de service_role key (die blijft geheim,
--    als Supabase-secret) en omzeilt RLS.
-- ---------------------------------------------------------------------
alter table public.devices  enable row level security;
alter table public.uplinks  enable row level security;
alter table public.readings enable row level security;

drop policy if exists "anon reads devices"  on public.devices;
drop policy if exists "anon reads readings" on public.readings;

create policy "anon reads devices"
  on public.devices for select
  to anon, authenticated
  using (true);

create policy "anon reads readings"
  on public.readings for select
  to anon, authenticated
  using (true);

-- Let op: public.uplinks krijgt bewust GEEN select-policy.
-- Die tabel bevat de volledige TTN payload (gateway tokens, session keys)
-- en blijft daarom onbereikbaar voor de anon key.

revoke all on public.uplinks from anon, authenticated;

grant select on public.devices         to anon, authenticated;
grant select on public.readings        to anon, authenticated;
grant select on public.latest_readings to anon, authenticated;
grant select on public.device_status   to anon, authenticated;
grant select on public.device_metrics  to anon, authenticated;

grant execute on function public.readings_binned(text[], text, timestamptz, timestamptz, integer)
  to anon, authenticated;

-- Ingest alleen vanaf de server.
revoke execute on function public.ingest_uplink(jsonb)        from anon, authenticated, public;
revoke execute on function public.ingest_uplink_batch(jsonb)  from anon, authenticated, public;
grant  execute on function public.ingest_uplink(jsonb)        to service_role;
grant  execute on function public.ingest_uplink_batch(jsonb)  to service_role;


-- ---------------------------------------------------------------------
-- 7. REALTIME — laat het dashboard live bijwerken bij nieuwe metingen
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'readings'
  ) then
    alter publication supabase_realtime add table public.readings;
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. OPTIONEEL: labels invullen zodat het dashboard nette namen toont.
--    Pas aan naar de echte ruimtes bij MCS en draai opnieuw.
-- ---------------------------------------------------------------------
-- update public.devices set label = 'Kantoor begane grond', room = '0.01', floor = '0'
--   where device_id = 'elsys-ers-2';
-- update public.devices set label = 'Vergaderruimte',       room = '1.12', floor = '1'
--   where device_id = 'elsys-eye-3';
-- update public.devices set label = 'Binnensensor MKR',     room = '1.12', floor = '1'
--   where device_id = 'arduino-mkr-binnen-2';
