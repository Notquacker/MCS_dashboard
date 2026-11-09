#!/usr/bin/env node
/**
 * Haalt uplinks rechtstreeks uit de TTN Storage Integration op en schrijft ze
 * naar data/ttn-storage.json. Bedoeld om een gat te vullen wanneer de webhook
 * (tijdelijk) niet aflevert: je trekt alles wat nog in de TTN-retentie zit in
 * één keer binnen en voert het daarna met scripts/backfill.mjs in Supabase.
 *
 *   TTN_API_KEY=NNSXS.xxxx node scripts/ttn-pull.mjs
 *   node scripts/backfill.mjs data/ttn-storage.json
 *
 * Optioneel (met defaults):
 *   TTN_APP    mcs-elsys
 *   TTN_HOST   eu1.cloud.thethings.network   (pas aan als je console nam1/au1 is)
 *   TTN_LAST   48h                            (hoe ver terug uit de retentie)
 *   TTN_OUT    data/ttn-storage.json
 *
 * De TTN-key heeft "Read application traffic (uplink and downlink)" nodig.
 * Zet 'm NOOIT in git of in een gedeelde map — alleen als env var in je shell.
 * Geen dependencies — draait op Node 18+ met de ingebouwde fetch.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

const KEY = process.env.TTN_API_KEY ?? "";
const APP = process.env.TTN_APP ?? "mcs-elsys";
const HOST = (process.env.TTN_HOST ?? "eu1.cloud.thethings.network").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const LAST = process.env.TTN_LAST ?? "48h";
const OUT = process.env.TTN_OUT ?? "data/ttn-storage.json";

if (!KEY) {
  console.error("Zet TTN_API_KEY als environment variable (de NNSXS... key uit TTN).");
  process.exit(1);
}

const url =
  `https://${HOST}/api/v3/as/applications/${APP}/packages/storage/uplink_message` +
  `?last=${encodeURIComponent(LAST)}&order=received_at`;

console.log(`TTN  ${APP} @ ${HOST}  (laatste ${LAST})`);

const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${KEY}`,
    Accept: "text/event-stream",
  },
});

if (!res.ok) {
  console.error(`\n! TTN gaf HTTP ${res.status}: ${await res.text()}`);
  if (res.status === 401) console.error("  401 = key ongeldig of mist traffic-read rechten.");
  if (res.status === 404) console.error("  404 = Storage Integration niet aan, of verkeerde app/host.");
  process.exit(1);
}

const body = await res.text();

// De Storage API levert text/event-stream: regels als `data: {"result": {...}}`,
// soms kale NDJSON. Beide vormen pakken we af en we houden de ApplicationUp over.
const events = [];
const perDevice = new Map();

for (let line of body.split("\n")) {
  line = line.trim();
  if (!line || line.startsWith(":") || line.startsWith("event:")) continue;
  if (line.startsWith("data:")) line = line.slice(5).trim();
  if (!line) continue;

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue; // onvolledige/onzinnige regel overslaan
  }

  const up = obj?.result ?? obj;
  if (!up?.uplink_message || !up?.end_device_ids) continue;

  // backfill.mjs herkent { result: ApplicationUp }, dus zo bewaren we het.
  events.push({ result: up });
  const id = up.end_device_ids.device_id ?? "?";
  perDevice.set(id, (perDevice.get(id) ?? 0) + 1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(events, null, 2), "utf8");

console.log("\n── Opgehaald ──");
for (const [device, n] of [...perDevice].sort()) {
  console.log(`  ${device.padEnd(26)} ${n}`);
}
console.log(`  ${"totaal uplinks".padEnd(26)} ${events.length}`);
console.log(`\nGeschreven naar ${OUT}`);
console.log(`Nu invoeren:  node scripts/backfill.mjs ${OUT}`);
