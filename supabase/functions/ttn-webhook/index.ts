// =====================================================================
//  TTN -> Supabase webhook
//
//  Deploy:
//    supabase functions deploy ttn-webhook --no-verify-jwt
//
//  --no-verify-jwt is nodig: TTN kan geen Supabase JWT meesturen.
//  De beveiliging zit in de X-Webhook-Token header die je in TTN instelt.
//
//  Deploy loopt via de GitHub-integratie (config.toml zet verify_jwt uit).
//
//  Secrets (supabase secrets set ...):
//    TTN_WEBHOOK_SECRET   zelfgekozen lange random string
//  SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zet het platform zelf klaar.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("TTN_WEBHOOK_SECRET") ?? "";

/** Vergelijking zonder timing-lek. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  if (!WEBHOOK_SECRET || !SERVICE_KEY) {
    console.error("ontbrekende env: TTN_WEBHOOK_SECRET of SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: "server not configured" }, 500);
  }

  const token = req.headers.get("x-webhook-token") ?? "";
  if (!secretsMatch(token, WEBHOOK_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  // TTN stuurt ook joins, downlink-events en service-data naar hetzelfde
  // endpoint als je die aanvinkt. Alleen uplinks hebben uplink_message.
  if (!payload || typeof payload !== "object" || !("uplink_message" in payload)) {
    return json({ ok: true, ignored: "not an uplink" }, 202);
  }

  const { data, error } = await supabase.rpc("ingest_uplink", { payload });

  if (error) {
    console.error("ingest_uplink mislukt:", error.message, error.details ?? "");
    // 500 laat TTN het opnieuw proberen; dedup_key voorkomt dubbele rijen.
    return json({ error: "ingest failed", detail: error.message }, 500);
  }

  const deviceId =
    (payload as { end_device_ids?: { device_id?: string } }).end_device_ids?.device_id ??
    "unknown";

  if (data === null) {
    return json({ ok: true, device_id: deviceId, duplicate: true }, 200);
  }

  return json({ ok: true, device_id: deviceId, uplink_id: data }, 200);
});
