// =====================================================================
//  Exa-achtergrond bij een meting
//
//  Het dashboard is een statische pagina op GitHub Pages; de Exa API-key
//  mag daar niet staan. Deze function doet de zoekopdracht server-side en
//  cachet het antwoord in public.exa_context, zodat dit publieke endpoint
//  niet bij elke klik een betaalde Exa-call doet.
//
//  Deploy:
//    supabase functions deploy exa-context --no-verify-jwt
//
//  Secrets (supabase secrets set ...):
//    EXA_API_KEY   https://dashboard.exa.ai -> API Keys
//  SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zet het platform zelf klaar.
//
//  POST { "topic": "co2" }
//    -> { topic, query, fetched_at, cached,
//         results: [{ title, url, publishedDate, highlights }] }
//
//  De client stuurt alleen een onderwerp, nooit een query: dit endpoint is
//  publiek en mag geen willekeurige zoekopdracht kunnen uitvoeren.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const EXA_API_KEY = Deno.env.get("EXA_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/** Hoe lang een antwoord hergebruikt mag worden. */
const CACHE_HOURS = 24;
/** Bewuste keuze: het paneel is compact, vijf bronnen is genoeg. */
const NUM_RESULTS = 5;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, apikey, authorization",
};

/**
 * Vaste onderwerpen. `objective` vertelt Exa waar de zoekactie voor dient:
 * dit is één stap in een groter geheel, geen losse zoekbox.
 */
const TOPICS: Record<string, { query: string; objective: string }> = {
  co2: {
    query: "CO2-concentratie binnenklimaat richtlijnen kantoren en klaslokalen",
    objective:
      "Geef grenswaarden en gezondheidsrichtlijnen voor CO₂ in binnenruimtes: " +
      "wanneer is de lucht goed, matig of slecht, en wat zegt onderzoek over " +
      "ventilatie, concentratie en klachten. Laat Nederlandse bronnen (RIVM, " +
      "GGD, Arboportaal) voorgaan en noem concrete ppm-waarden.",
  },
  temperature: {
    query: "temperatuur thermisch comfort richtlijnen kantoren en klaslokalen",
    objective:
      "Geef de bandbreedte die als comfortabel wordt gezien en wat te warme of " +
      "te koude ruimtes doen met concentratie en productiviteit.",
  },
  humidity: {
    query: "relatieve luchtvochtigheid binnen gezondheid comfort richtlijn",
    objective:
      "Geef de comfortband voor relatieve luchtvochtigheid, de gezondheids-" +
      "effecten van te droge of te vochtige lucht, en het verband met ventilatie.",
  },
  network: {
    query: "LoRaWAN RSSI SNR signaalkwaliteit richtwaarden spreading factor bereik",
    objective:
      "Geef praktijkwaarden voor LoRaWAN-signaalkwaliteit (RSSI en SNR) en " +
      "spreading factor: wanneer is een link gezond, wanneer wordt het kritisch, " +
      "en hoe beïnvloeden SF en afstand het bereik.",
  },
};

type ExaResult = {
  title: string | null;
  url: string;
  publishedDate: string | null;
  highlights: string[];
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** De aanbevolen Exa-request: query + objective + highlights, niets meer. */
async function zoekBijExa(query: string, objective: string): Promise<ExaResult[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      objective,
      type: "auto",
      numResults: NUM_RESULTS,
      contents: { highlights: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`Exa HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = (await res.json()) as { results?: ExaResult[] };
  return (body.results ?? []).map((r) => ({
    title: r.title ?? null,
    url: r.url,
    publishedDate: r.publishedDate ?? null,
    highlights: r.highlights ?? [],
  }));
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!EXA_API_KEY || !SERVICE_KEY) {
    console.error("ontbrekende env: EXA_API_KEY of SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "server not configured" }, 500);
  }

  let body: { topic?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const topic = String(body.topic ?? "");
  const onderwerp = TOPICS[topic];
  if (!onderwerp) {
    return json({ error: "unknown topic", topics: Object.keys(TOPICS) }, 400);
  }

  const grens = new Date(Date.now() - CACHE_HOURS * 3600_000).toISOString();
  const { data: bewaard, error: leesFout } = await supabase
    .from("exa_context")
    .select("payload, fetched_at")
    .eq("topic", topic)
    .gte("fetched_at", grens)
    .maybeSingle();

  if (leesFout) console.error("cache lezen mislukt:", leesFout.message);

  if (bewaard) {
    return json({
      topic,
      query: onderwerp.query,
      fetched_at: bewaard.fetched_at,
      cached: true,
      results: bewaard.payload?.results ?? [],
    });
  }

  let results: ExaResult[];
  try {
    results = await zoekBijExa(onderwerp.query, onderwerp.objective);
  } catch (e) {
    const melding = e instanceof Error ? e.message : String(e);
    console.error("Exa-zoekopdracht mislukt:", melding);
    return json({ error: "exa search failed", detail: melding }, 502);
  }

  const fetched_at = new Date().toISOString();
  const { error: schrijfFout } = await supabase
    .from("exa_context")
    .upsert({ topic, query: onderwerp.query, payload: { results }, fetched_at });

  // Een mislukte cache-write is geen reden om de bronnen niet te tonen.
  if (schrijfFout) console.error("cache schrijven mislukt:", schrijfFout.message);

  return json({ topic, query: onderwerp.query, fetched_at, cached: false, results });
});
