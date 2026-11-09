-- =====================================================================
--  Cache voor de Exa-achtergrondbronnen (Edge Function `exa-context`)
--
--  De function is publiek aanroepbaar vanaf het statische dashboard, en
--  elke Exa-zoekopdracht kost geld. Daarom doet de function per onderwerp
--  maximaal één call per 24 uur en bewaart het antwoord hier.
--
--  Geen RLS-policy en geen grants: alleen service_role (de Edge Function)
--  komt hierbij. Het dashboard leest dit nooit rechtstreeks.
-- =====================================================================

create table if not exists public.exa_context (
  topic       text        primary key,          -- bv. 'co2', 'temperature', 'network'
  query       text        not null,             -- de query die Exa kreeg
  payload     jsonb       not null,             -- { "results": [...] }
  fetched_at  timestamptz not null default now()
);

comment on table public.exa_context is
  'Laatste Exa-antwoord per onderwerp. Voorkomt dat een publiek endpoint per klik betaalt.';

alter table public.exa_context enable row level security;

revoke all on public.exa_context from anon, authenticated;
