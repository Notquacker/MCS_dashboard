# GACS — sensordata van TTN naar Supabase, met dashboard op GitHub Pages

Pipeline voor het werkplaatsproject bij MCS: LoRaWAN-sensoren sturen via The
Things Network naar Supabase, en een statisch dashboard op GitHub Pages leest
die data read-only terug.

**🔗 Live dashboard:** <https://notquacker.github.io/MCS_dashboard/>
— hier kunnen medestudenten de sensordata bekijken, geen login nodig.

```
ELSYS ERS-CO2  ─┐
ELSYS EYE      ─┼─ LoRaWAN ─→ TTN ─(webhook)─→ Supabase Edge Function
Arduino MKR    ─┘                                      │
                                                 ingest_uplink()
                                                       │
                                        devices · uplinks · readings
                                                       │
                                            anon key, alleen SELECT
                                                       │
                                        Dashboard op GitHub Pages
```

## Waarom een webhook en geen API key

De TTN API key hoef je nergens op te slaan. TTN *pusht* naar Supabase; de
authenticatie is een zelfgekozen header-token. Dat scheelt een secret die
anders in je repo of CI zou eindigen.

| Sleutel | Waar hoort die | In Git? |
|---|---|---|
| TTN API key | nergens in dit project | nee |
| `TTN_WEBHOOK_SECRET` | Supabase secret + TTN webhook-header | nee |
| `service_role` key | Supabase secret + je lokale shell | **nooit** |
| `anon` key | `dashboard/config.js` | ja, dat is de bedoeling |

De anon key is ontworpen om publiek in een browser te staan. Wat je beschermt
zijn de RLS policies: `anon` mag alleen `SELECT` op `devices` en `readings`.
De tabel `uplinks` (met de volledige TTN payload, inclusief gateway-tokens)
heeft bewust géén policy en is dus onbereikbaar met die key.

---

## 1. Database opzetten

Deze repo is via de GitHub-integratie aan het Supabase-project gekoppeld, dus
bij een push op de gekoppelde branch draait Supabase de migraties in
`supabase/migrations/` zelf. De initiële migratie is idempotent, dus het maakt
niet uit of je het schema eerder al handmatig hebt gedraaid.

Liever handmatig? Plak `supabase/migrations/20261106120000_init.sql` in
Supabase Studio → SQL Editor → Run, of draai `supabase db push`.

Wat je krijgt:

| Object | Wat het is |
|---|---|
| `devices` | één rij per sensor; `label`, `room`, `floor` vul je zelf |
| `uplinks` | één rij per uplink, met de ruwe TTN payload (privé) |
| `readings` | long format: `(device_id, measured_at, metric, value)` |
| `ingest_uplink(jsonb)` | verwerkt één TTN bericht, dedupliceert |
| `latest_readings` | laatste waarde per sensor per metric |
| `device_status` | online-status en aantal metingen per 24u |
| `device_metrics` | welke metrics welke sensor levert |
| `readings_binned(...)` | tijdreeks in buckets, voor de grafieken |

Het **long format** is hier het belangrijkste ontwerpbesluit. De ERS-CO2 stuurt
CO₂, de EYE stuurt bezetting, de Arduino stuurt iets anders — en als je er
volgende sprint een sensor bij hangt hoef je het schema niet aan te raken.
`ingest_uplink` slaat `decoded_payload` plat naar `metric`/`value`, ook als die
genest is (`{"sensors":{"temp_c":19.4}}` wordt `sensors.temp_c`).

Netwerkmetrics (`net.rssi`, `net.snr`, `net.sf`, `net.gateways`,
`net.battery_pct`) gaan dezelfde tabel in, zodat je signaalkwaliteit net zo
kunt plotten als CO₂. Handig voor het dekkingsverhaal in je verslag.

### Labels invullen

```sql
update public.devices set label = 'Kantoor zuid', room = '0.04', floor = '0'
  where device_id = 'elsys-ers-2';
```

Zonder label toont het dashboard het kale `device_id`.

---

## 2. Edge Function uitrollen

De GitHub-integratie rolt de function bij elke push uit, en
`[functions.ttn-webhook] verify_jwt = false` in `supabase/config.toml` zorgt
dat Supabase geen JWT eist — TTN kan er namelijk geen meesturen. De beveiliging
is de `X-Webhook-Token` header uit de volgende stap.

Het secret moet je wél één keer zelf zetten, want dat hoort niet in de repo:

```bash
openssl rand -hex 32                      # verzin er een en bewaar hem

npm install -g supabase
supabase login
supabase link --project-ref JOUW-PROJECT-REF
supabase secrets set TTN_WEBHOOK_SECRET=<dat-secret>
```

Kan ook zonder CLI: Supabase dashboard → Edge Functions → Secrets.

Buiten de GitHub-integratie om uitrollen kan met
`supabase functions deploy ttn-webhook --no-verify-jwt`.

Je endpoint is nu:

```
https://JOUW-PROJECT-REF.supabase.co/functions/v1/ttn-webhook
```

Testen voordat je TTN aansluit:

```bash
curl -i -X POST https://JOUW-PROJECT-REF.supabase.co/functions/v1/ttn-webhook \
  -H "x-webhook-token: <dat-secret>" \
  -H "content-type: application/json" \
  -d '{"end_device_ids":{"device_id":"test-1","application_ids":{"application_id":"mcs-elsys"}},
       "correlation_ids":["pba:uplink:HANDTEST1"],
       "received_at":"2026-11-06T12:00:00Z",
       "uplink_message":{"f_port":5,"f_cnt":1,"received_at":"2026-11-06T12:00:00Z",
         "decoded_payload":{"temperature":21.5,"co2":700},
         "rx_metadata":[{"rssi":-95,"snr":7.5}]}}'
```

Verwacht: `{"ok":true,"device_id":"test-1","uplink_id":1}`. Nog eens draaien
geeft `"duplicate":true` — dat is de dedup die werkt. Opruimen kan met
`delete from public.uplinks where dedup_key = 'pba:uplink:HANDTEST1';`
(readings gaan mee via cascade).

---

## 3. TTN webhook instellen

TTN Console → je applicatie `mcs-elsys` → **Integrations → Webhooks → Add
webhook → Custom webhook**.

| Veld | Waarde |
|---|---|
| Webhook ID | `supabase` |
| Webhook format | `JSON` |
| Base URL | `https://JOUW-PROJECT-REF.supabase.co/functions/v1/ttn-webhook` |
| Additional headers | `x-webhook-token` → `<dat-secret>` |
| Enabled event types | alleen **Uplink message** aanvinken, pad leeg laten |

Pad leeg laten is belangrijk: TTN plakt het achter de base URL en dan klopt de
function-route niet meer.

Zodra een sensor uplinkt zie je in TTN onder de webhook de response-codes. Een
`200` is goed; `401` betekent dat het token niet matcht.

---

## 4. Bestaande exports inladen

De JSON die je al uit de TTN console hebt geëxporteerd kun je alsnog
wegschrijven. Zet de bestanden in `data/` (staat in `.gitignore`):

```bash
export SUPABASE_URL=https://JOUW-PROJECT-REF.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...        # Project Settings → API

node scripts/backfill.mjs data/*.json
```

Het script pakt alleen `as.up.data.forward` events (die hebben
`decoded_payload`) en slikt ook afgekapte exports — het leest zo veel complete
objecten als er in het bestand staan. Dedup gebeurt in de database, dus twee
keer draaien levert geen dubbele rijen op.

> Zet de service_role key **niet** in een bestand dat je commit. Gebruik hem in
> je shell of via `direnv`, en haal hem daarna weer weg.

---

## 5. Dashboard publiceren

1. Vul `dashboard/config.js` in met je project-URL en **anon** key.
2. Push naar `main`.
3. GitHub → Settings → Pages → Source: **GitHub Actions** (eenmalig).

De workflow in `.github/workflows/deploy-pages.yml` publiceert de map
`dashboard/` bij elke push die daaraan raakt. Geen build step, geen
`node_modules` — Chart.js, Luxon en supabase-js komen van een CDN.

Na de eerste geslaagde deploy staat het dashboard op:

```
https://notquacker.github.io/MCS_dashboard/
```

Die link kun je delen met medestudenten; ze hebben geen account nodig. De anon
key in `config.js` mag publiek zijn — de RLS laat alleen lezen toe.

Lokaal bekijken kan met elke statische server:

```bash
cd dashboard && python3 -m http.server 8000
```

### Wat het dashboard doet

- **Sensoren** — laatste waarde per sensor, met CO₂ gekleurd op 800 / 1200 ppm
  en temperatuur/vochtigheid op comfortzone. Sensoren die >2 uur stil zijn
  vervagen en krijgen `offline`.
- **Verloop** — één metric, alle sensoren, over 6 u / 24 u / 7 d / 30 d. De
  bucketgrootte schaalt mee (5 → 240 min) zodat 30 dagen niet duizenden punten
  oplevert. Klik in de legenda om een lijn uit te zetten.
- **Netwerkstatus** — RSSI, SNR, spreading factor, accu en laatste contact.
  Dit is je dekkingsoverzicht voor het verslag.
- **Realtime** — nieuwe metingen komen binnen via Supabase Realtime. Valt dat
  weg, dan ververst het dashboard zelf elke 2 minuten en zegt de status
  "polling" in plaats van "live".

Metrics waar nog geen label voor is gedefinieerd krijgen automatisch een nette
naam. Wil je er een met eenheid en drempelwaarde bij? Voeg een regel toe aan
`METRICS` bovenin `dashboard/app.js`.

---

## Mappenstructuur

```
supabase/config.toml                   CLI/GitHub-integratie
supabase/migrations/                   schema, RLS, views, ingest-functies
supabase/functions/ttn-webhook/        de Edge Function
scripts/backfill.mjs                   oude exports inladen
dashboard/                             wat op GitHub Pages komt
  index.html  app.js  styles.css  config.js
.github/workflows/deploy-pages.yml     Pages-deploy
data/                                  jouw TTN exports (niet gecommit)
```

## Problemen oplossen

| Symptoom | Oorzaak |
|---|---|
| TTN toont `401` | `x-webhook-token` komt niet overeen met `TTN_WEBHOOK_SECRET` |
| TTN toont `404` | pad-veld ingevuld in TTN, of function niet uitgerold |
| TTN toont `401` van Supabase zelf | `verify_jwt` staat aan — check `[functions.ttn-webhook]` in `config.toml` |
| Dashboard zegt "niet geconfigureerd" | `config.js` staat nog op de placeholder |
| Dashboard leeg, geen fout | database is leeg — draai de backfill of wacht op een uplink |
| `permission denied for table readings` | migratie niet (helemaal) toegepast; de grants staan onderaan |
| Status blijft "polling" | Realtime staat uit; zet in Supabase Studio Realtime aan voor `readings` |

## Getest

Het schema is tegen PostgreSQL 16 gedraaid met je eigen TTN-export plus 36 uur
gesimuleerde data over drie sensoren. Daarbij gecontroleerd: dedup (tweede
import schrijft 0 rijen), geneste payloads, de views en `readings_binned`, en
de RLS — `anon` leest `readings` wel en `uplinks` niet, en kan `ingest_uplink`
niet aanroepen. Het dashboard is headless gerenderd tegen die database.
