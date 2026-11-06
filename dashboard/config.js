// ---------------------------------------------------------------------
//  Vul hier je Supabase project in.
//
//  Beide waarden staan in Supabase Studio onder Project Settings → API.
//  De anon key MAG publiek in GitHub staan: die is bedoeld om in browsers
//  te eindigen. Wat je beschermt zijn de RLS policies uit schema.sql —
//  anon mag alleen lezen.
//
//  Zet hier NOOIT de service_role key neer. Die hoort alleen als secret
//  in Supabase (voor de Edge Function) en in je lokale shell (backfill).
// ---------------------------------------------------------------------

window.GACS_CONFIG = {
  supabaseUrl: "https://JOUW-PROJECT-REF.supabase.co",
  supabaseAnonKey: "JOUW-ANON-KEY",

  // Welke metrics je in de tegels wilt zien, in deze volgorde.
  tileMetrics: ["co2", "temperature", "humidity", "light", "motion", "occupancy"],

  // Standaard geselecteerde grafiek-metric bij het openen.
  defaultMetric: "co2",
};
