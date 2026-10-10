-- manifest: **Saída de corretor respeita o empreendimento.** `fn_member_leave` deixa de dividir entre TODAS as corretoras e passa a dividir só entre os membros ativos do **grupo do empreendimento do lead** (o grupo tem o mesmo nome do empreendimento, que o lead leva em `custom_fields.empreendimento`). Sem empreendimento, sem grupo com esse nome ou sem ninguém elegível no grupo, o lead volta para a gestora. Nova coluna `lead_routing_groups.saida_para_gestora`: equipe com verba própria (Sarutaiá) nunca divide na saída — os leads em Novo/Não atendeu também voltam para a gestora, que redireciona. O resultado informa o motivo de cada retorno à gestora. Aditiva e idempotente (substitui a função da 90004).
-- 90005: saída de corretor por empreendimento.
--
-- POR QUÊ. A 90004 dividia os leads de quem saiu entre todas as `agent` ativas da organização. Na equipe da
-- Flávia cada corretora atende a um conjunto de empreendimentos (Alves Guimarães, Sarutaiá), e na Sarutaiá o
-- lead pertence ao conjunto de anúncios pago pela própria corretora. Dividir sem olhar o empreendimento
-- entregaria lead da Sarutaiá a quem não atende a Sarutaiá.
--
-- REGRA (decidida com o Hamilton em 10/10/2026):
--   * O empreendimento do lead vem de `custom_fields.empreendimento` (a ponte Roleta/Meta grava o MESMO nome da
--     aba Empreendimentos da planilha) e casa com o `name` do grupo ignorando maiúsculas e espaços nas pontas.
--   * Divide só entre membros ATIVOS do grupo que sejam `agent` ativos da organização, pelo menor número de
--     leads em aberto (a carga é recontada a cada lead, dentro da transação).
--   * Grupo com `saida_para_gestora` (verba própria): os leads em Novo/Não atendeu voltam para a gestora, que
--     redireciona. Foi a escolha do Hamilton para a Sarutaiá.
--   * Qualquer outra situação (sem empreendimento, sem grupo, grupo vazio) volta para a gestora. Padrão seguro.
--   * Etapas fora de Novo/Não atendeu (Atendeu, Visita marcada, Proposta...) continuam voltando para a gestora.

alter table public.lead_routing_groups
  add column if not exists saida_para_gestora boolean not null default false;

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
  v_grupo_id uuid;
  v_verba_propria boolean;
  v_to uuid;
  v_motivo text;
  v_dividir integer := 0;
  v_gestora integer := 0;
  v_fixos integer := 0;
  v_andamento integer := 0;
  v_verba integer := 0;
  v_sem_destino integer := 0;
  v_por jsonb := '{}'::jsonb;
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

  for v_lead in
    select l.id, s.slug, coalesce(s.is_won, false) as won, coalesce(s.is_lost, false) as lost,
           nullif(lower(btrim(l.custom_fields ->> 'empreendimento')), '') as emp
      from public.crm_leads l
      left join public.crm_stages s on s.id = l.stage_id
     where l.organization_id = p_org and l.owner_user_id = p_user and l.status = 'open'
     order by l.created_at, l.id
  loop
    if v_lead.won or v_lead.lost then
      v_fixos := v_fixos + 1;
      continue;
    end if;

    v_to := null;
    v_motivo := null;
    v_grupo_id := null;
    v_verba_propria := null;

    if v_lead.slug is null or v_lead.slug not in ('novo', 'nao_atendeu') then
      v_motivo := 'em_andamento';
    else
      select g.id, g.saida_para_gestora into v_grupo_id, v_verba_propria
        from public.lead_routing_groups g
       where g.organization_id = p_org and g.active
         and v_lead.emp is not null and lower(btrim(g.name)) = v_lead.emp
       limit 1;
      if not found then
        v_motivo := 'sem_destino_no_empreendimento';
      elsif v_verba_propria then
        v_motivo := 'equipe_com_verba_propria';
      else
        select m.user_id into v_to
          from public.lead_routing_group_members m
          join public.user_organizations uo
            on uo.user_id = m.user_id and uo.organization_id = p_org
           and uo.revoked_at is null and uo.role = 'agent'
         where m.group_id = v_grupo_id and m.organization_id = p_org and m.active and m.user_id <> p_user
         order by (select count(*) from public.crm_leads l2
                    where l2.organization_id = p_org and l2.owner_user_id = m.user_id and l2.status = 'open'),
                  m.position, m.user_id
         limit 1;
        if v_to is null then
          v_motivo := 'sem_destino_no_empreendimento';
        end if;
      end if;
    end if;

    if v_to is not null then
      v_dividir := v_dividir + 1;
      if not p_dry_run then
        if public.fn_lead_repass(p_org, v_lead.id, p_user, v_to, 'redistribuido_por_saida', v_actor,
                                 jsonb_build_object('stage', v_lead.slug, 'grupo', v_grupo_id)) then
          v_por := jsonb_set(v_por, array[v_to::text], to_jsonb(coalesce((v_por ->> v_to::text)::integer, 0) + 1));
        end if;
      end if;
    else
      v_gestora := v_gestora + 1;
      if v_motivo = 'em_andamento' then v_andamento := v_andamento + 1;
      elsif v_motivo = 'equipe_com_verba_propria' then v_verba := v_verba + 1;
      else v_sem_destino := v_sem_destino + 1;
      end if;
      if not p_dry_run then
        perform public.fn_lead_repass(p_org, v_lead.id, p_user, p_gestor, 'devolvido_a_gestora', v_actor,
                                      jsonb_build_object('stage', v_lead.slug, 'motivo', v_motivo));
      end if;
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
    'por_corretora', v_por,
    'motivos', jsonb_build_object(
      'em_andamento', v_andamento,
      'equipe_com_verba_propria', v_verba,
      'sem_destino_no_empreendimento', v_sem_destino
    )
  );
end;
$function$;

revoke all on function public.fn_member_leave(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.fn_member_leave(uuid, uuid, uuid, boolean) to authenticated, service_role;
