-- manifest: **Saída de corretor com redistribuição de leads + histórico do corretor.** `lead_ownership_events` é o histórico append-only de trocas de dono (`nao_atendeu_no_prazo`, `redistribuido_por_saida`, `devolvido_a_gestora`); o corretor vê só os próprios eventos, gerente/admin veem todos, ninguém escreve por REST. `fn_member_leave` (admin) revoga o acesso do corretor E redistribui os leads dele numa transação: leads em **Novo/Não atendeu** são divididos entre as corretoras ativas pelo menor número de leads em aberto; os demais em aberto (Atendeu, Visita marcada, Proposta...) voltam para a gestora; fechados não mudam; `p_dry_run` só conta. `fn_lead_repass` (só service_role) é o repasse de UM lead — usado pela saída e, no futuro, pelo repasse por prazo da Roleta, que grava `nao_atendeu_no_prazo` no histórico de quem não deu retorno. O dono entra por UPDATE, então cada novo dono recebe o push `lead.assigned`. Aditiva e idempotente.
-- 90004: saída de corretor + histórico de trocas de dono.
--
-- REGRAS (decididas com o Hamilton em 08-09/10/2026):
--   * "Não atendeu no prazo" = o corretor NÃO REGISTROU retorno no prazo e o lead passou para outro. É um
--     fato do HISTÓRICO DO CORRETOR, não uma etapa do funil (etapa "Não atendeu" = o corretor tentou e o
--     LEAD não respondeu — são coisas diferentes).
--   * Na saída, divide-se só o que ninguém trabalhou de verdade (etapas com slug `novo` e `nao_atendeu`).
--     Atendeu / Visita marcada / Proposta voltam para a gestora decidir. Fechou / Sem interesse ficam.
--   * Quem não tem etapa com esses slugs (outra organização) tem TUDO devolvido à gestora: o padrão seguro.

create table if not exists public.lead_ownership_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid not null references public.crm_leads (id) on delete cascade,
  kind text not null check (kind in ('nao_atendeu_no_prazo', 'redistribuido_por_saida', 'devolvido_a_gestora')),
  from_user_id uuid references auth.users (id) on delete set null,
  to_user_id uuid references auth.users (id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  -- clock_timestamp(): vários eventos na mesma transação precisam de ordem própria
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists lead_ownership_events_org_from_idx
  on public.lead_ownership_events (organization_id, from_user_id, created_at desc);
create index if not exists lead_ownership_events_lead_idx
  on public.lead_ownership_events (lead_id, created_at);

alter table public.lead_ownership_events enable row level security;

drop policy if exists lead_ownership_events_select on public.lead_ownership_events;
create policy lead_ownership_events_select on public.lead_ownership_events
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_role_at_least(organization_id, 'manager')
        or from_user_id = auth.uid()
        or to_user_id = auth.uid()
      )
    )
  );

revoke all on public.lead_ownership_events from anon, authenticated;
grant select on public.lead_ownership_events to authenticated;
grant all on public.lead_ownership_events to service_role;

-- ---- repasse de UM lead (saída, e futuramente o prazo da Roleta) ----
create or replace function public.fn_lead_repass(
  p_org uuid, p_lead uuid, p_from uuid, p_to uuid, p_kind text,
  p_actor uuid default null, p_detail jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  if p_kind not in ('nao_atendeu_no_prazo', 'redistribuido_por_saida', 'devolvido_a_gestora') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.user_organizations uo
     where uo.organization_id = p_org and uo.user_id = p_to
       and uo.revoked_at is null and uo.role in ('agent', 'manager', 'admin')
  ) then
    raise exception 'recipient_not_eligible' using errcode = '22023';
  end if;

  -- UPDATE (e não INSERT): é ele que passa por fn_emit_event_on_lead_change e emite lead.assigned (o push).
  update public.crm_leads
     set owner_user_id = p_to, owner_kind = 'user', owner_agent_id = null, assigned_at = now()
   where id = p_lead and organization_id = p_org
     and owner_user_id = p_from and status = 'open';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    return false;  -- o dono mudou no meio do caminho (ou fechou): não pisa
  end if;

  insert into public.lead_ownership_events (organization_id, lead_id, kind, from_user_id, to_user_id, actor_user_id, detail)
  values (p_org, p_lead, p_kind, p_from, p_to, p_actor, coalesce(p_detail, '{}'::jsonb));
  return true;
end;
$function$;

revoke all on function public.fn_lead_repass(uuid, uuid, uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_lead_repass(uuid, uuid, uuid, uuid, text, uuid, jsonb) to service_role;

-- ---- saída do corretor: revoga o acesso e redistribui os leads, numa transação ----
create or replace function public.fn_member_leave(
  p_org uuid, p_user uuid, p_gestor uuid, p_dry_run boolean default false
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_lead record;
  v_cand uuid[] := '{}';
  v_carga integer[] := '{}';
  v_lote integer[] := '{}';
  v_i integer;
  v_best integer;
  v_to uuid;
  v_dividir integer := 0;
  v_gestora integer := 0;
  v_fixos integer := 0;
  v_por jsonb := '{}'::jsonb;
  v_sem_corretora boolean;
begin
  if v_actor is null or not public.fn_role_at_least(p_org, 'admin') or not public.fn_support_write_allowed(p_org) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user = v_actor then
    raise exception 'cannot_remove_self' using errcode = '22023';
  end if;

  select uo.role into v_role from public.user_organizations uo
   where uo.organization_id = p_org and uo.user_id = p_user and uo.revoked_at is null;
  if v_role is null then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if v_role = 'admin' and (
    select count(*) from public.user_organizations uo
     where uo.organization_id = p_org and uo.role = 'admin' and uo.revoked_at is null
  ) <= 1 then
    raise exception 'last_admin' using errcode = '22023';
  end if;

  if p_gestor is null or p_gestor = p_user or not exists (
    select 1 from public.user_organizations uo
     where uo.organization_id = p_org and uo.user_id = p_gestor
       and uo.revoked_at is null and uo.role in ('manager', 'admin')
  ) then
    raise exception 'invalid_gestor' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('member_leave:' || p_org::text, 2042));

  -- corretoras que podem receber: agents ativos (a gestora não entra na divisão), com a carga atual
  select coalesce(array_agg(uo.user_id order by uo.user_id), '{}')
    into v_cand
    from public.user_organizations uo
   where uo.organization_id = p_org and uo.revoked_at is null
     and uo.role = 'agent' and uo.user_id <> p_user;
  v_sem_corretora := coalesce(array_length(v_cand, 1), 0) = 0;
  for v_i in 1 .. coalesce(array_length(v_cand, 1), 0) loop
    v_carga := v_carga || (
      select count(*)::integer from public.crm_leads l
       where l.organization_id = p_org and l.owner_user_id = v_cand[v_i] and l.status = 'open'
    );
    v_lote := v_lote || 0;
  end loop;

  for v_lead in
    select l.id, s.slug, coalesce(s.is_won, false) as won, coalesce(s.is_lost, false) as lost
      from public.crm_leads l
      left join public.crm_stages s on s.id = l.stage_id
     where l.organization_id = p_org and l.owner_user_id = p_user and l.status = 'open'
     order by l.created_at, l.id
  loop
    if v_lead.won or v_lead.lost then
      v_fixos := v_fixos + 1;
      continue;
    end if;

    if v_lead.slug in ('novo', 'nao_atendeu') and not v_sem_corretora then
      v_dividir := v_dividir + 1;
      if p_dry_run then continue; end if;
      v_best := 1;
      for v_i in 2 .. array_length(v_cand, 1) loop
        if (v_carga[v_i] + v_lote[v_i], v_cand[v_i]) < (v_carga[v_best] + v_lote[v_best], v_cand[v_best]) then
          v_best := v_i;
        end if;
      end loop;
      v_to := v_cand[v_best];
      if public.fn_lead_repass(p_org, v_lead.id, p_user, v_to, 'redistribuido_por_saida', v_actor,
                               jsonb_build_object('stage', v_lead.slug)) then
        v_lote[v_best] := v_lote[v_best] + 1;
        v_por := jsonb_set(v_por, array[v_to::text], to_jsonb(coalesce((v_por ->> v_to::text)::integer, 0) + 1));
      end if;
    else
      v_gestora := v_gestora + 1;
      if p_dry_run then continue; end if;
      perform public.fn_lead_repass(p_org, v_lead.id, p_user, p_gestor, 'devolvido_a_gestora', v_actor,
                                    jsonb_build_object('stage', v_lead.slug,
                                                       'motivo', case when v_lead.slug in ('novo', 'nao_atendeu') then 'sem_corretora_ativa' else 'em_andamento' end));
    end if;
  end loop;

  if not p_dry_run then
    update public.user_organizations
       set revoked_at = now(), updated_at = now()
     where organization_id = p_org and user_id = p_user and revoked_at is null;
  end if;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'revogado', not p_dry_run,
    'divididos', v_dividir,
    'com_a_gestora', v_gestora,
    'sem_mudanca', v_fixos,
    'por_corretora', v_por
  );
end;
$function$;

revoke all on function public.fn_member_leave(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.fn_member_leave(uuid, uuid, uuid, boolean) to authenticated, service_role;
