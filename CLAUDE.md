# GACS sensorplatform — context voor Claude Code

Werkplaatsproject bij MCS (Rotterdam). LoRaWAN-sensoren → The Things Network →
Supabase → statisch dashboard op GitHub Pages.

## Architectuur in het kort

```
ELSYS ERS-CO2 / ELSYS EYE / Arduino MKR
  → TTN (application: mcs-elsys)
  → webhook POST naar Supabase Edge Function `ttn-webhook`
  → rpc ingest_uplink(payload jsonb)
  → tabellen devices / uplinks / readings
  → dashboard/ leest read-only met de anon key
```

## Ontwerpbesluiten — niet omgooien zonder reden

**`readings` is long format**: `(uplink_id, device_id, measured_at, metric, value)`.
Bewust géén kolom per sensorwaarde. De drie sensortypes leveren verschillende
velden, en er komen er meer bij. `ingest_uplink` slaat `decoded_payload`
recursief plat (`{"sensors":{"temp_c":19.4}}` → metric `sensors.temp_c`), dus
een nieuwe sensor werkt zonder migratie.

**Netwerkmetrics zitten in dezelfde tabel** onder het `net.` prefix:
`net.rssi`, `net.snr`, `net.sf`, `net.gateways`, `net.battery_pct`. Daardoor
hoeft het dashboard geen tweede codepad voor signaalkwaliteit.

**`ingest_uplink` is de enige schrijfweg.** Niet rechtstreeks in `readings`
inserten — dedup, device-upsert en het platslaan zitten allemaal in die functie.
Dedup gaat op `uplinks.dedup_key` = de TTN correlation id (`pba:uplink:...`),
dus opnieuw importeren is altijd veilig.

**`uplinks` is privé.** Die tabel bevat de volledige TTN payload, inclusief
gateway-tokens en session key ids. Er staat bewust geen RLS select-policy op en
`anon` heeft er geen grants op. Niet "even" openzetten voor het dashboard —
gebruik `readings`, `latest_readings`, `device_status` of `device_metrics`.

**`schema.sql` is idempotent** en is de enige bron van waarheid voor het
databaseschema. Wijzigingen daarin aanbrengen en opnieuw draaien, niet
handmatig in Studio klikken.

## Sleutels

| Sleutel | Waar | In Git? |
|---|---|---|
| TTN API key | nergens nodig (webhook pusht) | nee |
| `TTN_WEBHOOK_SECRET` | Supabase secret + TTN header | nee |
| `service_role` key | Supabase secret + lokale shell | **nooit** |
| `anon` key | `dashboard/config.js` | ja, bedoeld |

De anon key hoort publiek in de browser te staan. De bescherming zijn de RLS
policies onderaan `schema.sql`: `anon` mag alleen `SELECT` op `devices` en
`readings`. Als iets niet werkt met de anon key, is het antwoord bijna nooit
"meer rechten geven" maar "via een view of RPC ontsluiten".

## Bestanden

```
supabase/schema.sql                 tabellen, RLS, views, ingest-functies
supabase/functions/ttn-webhook/     Deno edge function, verwacht x-webhook-token
scripts/backfill.mjs                TTN console-exports inladen, geen deps
dashboard/                          wat GitHub Pages serveert
  index.html app.js styles.css config.js
.github/workflows/deploy-pages.yml  deploy bij push op dashboard/**
data/                               TTN exports, in .gitignore
```

## Dashboard

Geen build step. Chart.js, Luxon en supabase-js komen van CDN; `app.js` is een
ES module die de browser direct draait. Niet omzetten naar een bundler tenzij
daar een concrete reden voor is — Pages serveert dit nu zoals het is.

Nieuwe metric een nette naam, eenheid of drempelwaarde geven: regel toevoegen
aan het `METRICS`-object bovenin `dashboard/app.js`. Onbekende metrics krijgen
automatisch een fallback-label, dus niets breekt als je het vergeet.

Lokaal: `cd dashboard && python3 -m http.server 8000`.

## Commando's

```bash
# edge function uitrollen (--no-verify-jwt is verplicht: TTN stuurt geen JWT)
supabase functions deploy ttn-webhook --no-verify-jwt

# oude exports inladen
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill.mjs data/*.json
```

## Valkuilen

- Vergeten `--no-verify-jwt` → TTN krijgt 401 van Supabase zelf, niet van de function.
- Pad-veld ingevuld in de TTN webhook → 404. Base URL moet het volledige
  function-pad zijn, pad leeg laten.
- `permission denied for table readings` → de grants staan onderaan
  `schema.sql`; die is niet helemaal gedraaid.
- Status blijft "polling" in plaats van "live" → Realtime staat uit voor
  `readings`.

## Taal

Code en commits in het Engels, uitleg en commentaar in het Nederlands (zoals
het nu is). Xay leest Nederlands.
