#!/usr/bin/env node
/**
 * Backfill van TTN "Live data" exports naar Supabase.
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/backfill.mjs data/*.json
 *
 * Slikt drie vormen:
 *   - een JSON array met TTN events (de console-export)
 *   - NDJSON: één event per regel
 *   - een afgekapte/kapotte export (parsed zo veel objecten als mogelijk)
 *
 * Alleen 'as.up.data.forward' events bevatten decoded_payload; die gebruiken
 * we. Dedup gebeurt in de database, dus twee keer draaien is onschadelijk.
 *
 * Geen dependencies — draait op Node 18+ met de ingebouwde fetch.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 200);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Zet SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY als environment variables.");
  process.exit(1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Gebruik: node scripts/backfill.mjs <export.json> [meer.json ...]");
  process.exit(1);
}

/**
 * Leest achter elkaar JSON-waarden uit een string, ook als het bestand
 * halverwege is afgekapt. Geeft terug wat compleet is.
 */
function salvageJsonValues(text) {
  const out = [];
  let i = 0;

  // NDJSON? Dan is regel-voor-regel sneller en robuuster.
  if (!text.trimStart().startsWith("[")) {
    for (const line of text.split("\n")) {
      const t = line.trim().replace(/,$/, "");
      if (!t || t === "[" || t === "]") continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* onvolledige laatste regel: negeren */
      }
    }
    return out;
  }

  i = text.indexOf("[") + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length || text[i] === "]") break;

    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;

    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }

    if (end === -1) break; // afgekapt bestand
    try {
      out.push(JSON.parse(text.slice(start, end)));
    } catch {
      /* corrupt object: overslaan */
    }
    i = end;
  }
  return out;
}

/** Haalt uit een TTN-event het ApplicationUp-object dat ingest_uplink wil. */
function toApplicationUp(event) {
  // Console-export: { name: 'as.up.data.forward', data: { ...ApplicationUp } }
  if (event?.name && event?.data) {
    if (event.name !== "as.up.data.forward") return null;
    return event.data?.uplink_message ? event.data : null;
  }
  // Storage Integration API (event-stream): { result: { ...ApplicationUp } }
  if (event?.result?.uplink_message && event?.result?.end_device_ids) {
    return event.result;
  }
  // Rechtstreekse webhook-body of MQTT-bericht.
  if (event?.uplink_message && event?.end_device_ids) return event;
  return null;
}

async function sendBatch(batch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_uplink_batch`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ payloads: batch }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return Number(await res.text());
}

let totalFound = 0;
let totalInserted = 0;
const perDevice = new Map();

for (const file of files) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    console.error(`  ! kan ${file} niet lezen: ${err.message}`);
    continue;
  }

  const events = salvageJsonValues(text);
  const uplinks = events.map(toApplicationUp).filter(Boolean);

  for (const u of uplinks) {
    const id = u.end_device_ids?.device_id ?? "?";
    perDevice.set(id, (perDevice.get(id) ?? 0) + 1);
  }

  console.log(`${file}: ${events.length} events, ${uplinks.length} uplinks`);
  totalFound += uplinks.length;

  for (let i = 0; i < uplinks.length; i += BATCH_SIZE) {
    const batch = uplinks.slice(i, i + BATCH_SIZE);
    try {
      const n = await sendBatch(batch);
      totalInserted += n;
      process.stdout.write(
        `  batch ${i / BATCH_SIZE + 1}: ${n}/${batch.length} nieuw\r`,
      );
    } catch (err) {
      console.error(`\n  ! batch vanaf ${i} mislukt: ${err.message}`);
    }
  }
  process.stdout.write("\n");
}

console.log("\n── Samenvatting ──");
for (const [device, n] of [...perDevice].sort()) {
  console.log(`  ${device.padEnd(26)} ${n}`);
}
console.log(`  ${"uplinks gevonden".padEnd(26)} ${totalFound}`);
console.log(`  ${"nieuw weggeschreven".padEnd(26)} ${totalInserted}`);
console.log(`  ${"al aanwezig (dedup)".padEnd(26)} ${totalFound - totalInserted}`);
