-- ---------------------------------------------------------------------
--  Fix: last_battery_percentage kan een kommagetal zijn (bv. 86.95652).
--
--  De oorspronkelijke ingest_uplink castte dat veld rechtstreeks naar
--  smallint: `... ->> '{last_battery_percentage,value}')::smallint`. TTN
--  levert de batterijschatting echter soms als fractie, en dan weigert
--  Postgres de hele insert ("invalid input syntax for type smallint:
--  86.95652"), waardoor een backfill-batch volledig omvalt.
--
--  Oplossing: eerst naar numeric casten (accepteert decimalen) en dan naar
--  smallint, zodat de waarde netjes wordt afgerond. De net.battery_pct
--  reading (double precision) blijft ongewijzigd — die had het probleem niet.
--
--  Dit is CREATE OR REPLACE van de hele functie; alleen de battery_pct-regel
--  in de uplinks-insert is aangepast t.o.v. de initiële migratie.
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
    -- FIX: eerst numeric (komma's toegestaan), dan afronden naar smallint.
    nullif(v_um #>> '{last_battery_percentage,value}', '')::numeric::smallint,
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
