-- =====================================================================
--  Ruimtenamen uit TTN als labels op de devices.
--  Zonder label toont het dashboard het kale device_id; hiermee staat
--  er "Sales-afdeling" i.p.v. "elsys-ers-2".
--
--  Idempotent: UPDATE op device_id, veilig opnieuw te draaien. Een nieuwe
--  sensor of hernoeming = een nieuwe migratie, niet deze aanpassen.
-- =====================================================================
update public.devices set label = 'IT-afdeling (keuken)'  where device_id = 'elsys-ers-1';
update public.devices set label = 'Sales-afdeling'         where device_id = 'elsys-ers-2';
update public.devices set label = 'Kleine vergaderruimte'  where device_id = 'elsys-eye-3';
update public.devices set label = 'Magazijn'               where device_id = 'elsys-eye-2';
update public.devices set label = 'Testkamer'              where device_id = 'arduino-mkr-binnen';
update public.devices set label = 'Grote vergaderruimte'   where device_id = 'arduino-mkr-binnen-2';
update public.devices set label = 'Buiten'                 where device_id = 'arduino-mkr-buiten';
