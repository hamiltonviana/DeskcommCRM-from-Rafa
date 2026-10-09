-- Desfaz a 90004 (saída de corretor + histórico). ATENÇÃO: apaga o histórico lead_ownership_events.
-- Exporte antes:  \copy (select * from lead_ownership_events) to 'eventos.csv' csv header
begin;
drop function if exists public.fn_member_leave(uuid, uuid, uuid, boolean);
drop function if exists public.fn_lead_repass(uuid, uuid, uuid, uuid, text, uuid, jsonb);
drop table if exists public.lead_ownership_events;
commit;
