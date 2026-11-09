// ---------------------------------------------------------------------
//  Vul hier je Supabase project in.
//
//  Beide waarden staan in Supabase Studio onder Project Settings → API.
//  De publishable key (sb_publishable_...) is de opvolger van de oude anon
//  key en MAG publiek in GitHub staan: die is bedoeld om in browsers te
//  eindigen. Wat je beschermt zijn de RLS policies uit de migratie in
//  supabase/migrations/ — anon mag alleen lezen.
//
//  Zet hier NOOIT de secret key (sb_secret_... of de oude service_role)
//  neer. Die hoort alleen als secret in Supabase (voor de Edge Function)
//  en in je lokale shell (backfill).
// ---------------------------------------------------------------------

window.GACS_CONFIG = {
  supabaseUrl: "https://zfrgujufjvgovjzuyltz.supabase.co",
  supabaseAnonKey: "sb_publishable_orjrrSjgGlL01oKlrKeEQQ_VNfTihRv",

  // Supabase Edge Function die achtergrondbronnen via Exa ophaalt.
  // De Exa API-key staat als Supabase-secret (EXA_API_KEY), nooit hier.
  exaContextUrl: "https://zfrgujufjvgovjzuyltz.supabase.co/functions/v1/exa-context",

  // Welke metrics je in de tegels wilt zien, in deze volgorde.
  tileMetrics: ["co2", "temperature", "humidity", "light", "motion", "occupancy"],

  // Standaard geselecteerde grafiek-metric bij het openen.
  defaultMetric: "co2",
};
