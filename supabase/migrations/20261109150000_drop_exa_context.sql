-- ---------------------------------------------------------------------
--  Verwijdert de Exa-achtergrondbronnen weer.
--
--  De feature (paneel "Achtergrond" in het dashboard + de Edge Function
--  `exa-context`) is eruit gehaald, dus de cache-tabel is niet meer nodig.
--  De function, de dashboard-code en de config zijn in dezelfde wijziging
--  verwijderd; deze migratie ruimt de database-kant op.
--
--  Forward-only: de oorspronkelijke create-migratie (20261109130000) blijft
--  als historie staan; deze nieuwe migratie draait de wijziging terug.
-- ---------------------------------------------------------------------

drop table if exists public.exa_context;
