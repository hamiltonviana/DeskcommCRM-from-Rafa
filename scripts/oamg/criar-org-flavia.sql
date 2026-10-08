-- Cria a organização "Flávia Brugnara" no CRM OAMG (04/10/2026 → 08/10/2026).
-- Replica fn_create_tenant_with_owner (que exige platform_admin; esta instalação não tem nenhum),
-- troca o funil padrão de e-commerce ("Pedidos") por um funil de corretores e cria os CONVITES
-- (linhas em team_invites, sem enviar e-mail). Os links saem de scripts/oamg/gerar-links-convite.mjs.
--
-- Uso:  psql -v ON_ERROR_STOP=1 -v modo=prova -f criar-org-flavia.sql   (termina em rollback com o resumo)
--       psql -v ON_ERROR_STOP=1 -v modo=real  -f criar-org-flavia.sql   (commit)
\set ON_ERROR_STOP on
begin;
select set_config('oamg.modo', :'modo', true);

do $oamg$
declare
  v_hamilton uuid := '0e80949f-ff11-4e0e-a28b-b0f254992de2';  -- admin da instalação (Hamilton)
  v_org uuid;
  v_pipe uuid;
  v_pos numeric := 1000;
  r record;
  v_resumo jsonb;
begin
  if exists (select 1 from public.organizations where slug = 'flavia-brugnara') then
    raise exception 'organizacao_ja_existe';
  end if;

  insert into public.organizations (display_name, slug, legal_name, status, timezone, locale, currency,
                                    rate_limit_rps, media_retention_days, onboarded_at, settings, created_by)
  values ('Flávia Brugnara', 'flavia-brugnara', 'Flávia Brugnara', 'active', 'America/Sao_Paulo', 'pt-BR', 'BRL',
          100, 365, now(), '{}'::jsonb, v_hamilton)
  returning id into v_org;

  -- Cada corretora vê só os PRÓPRIOS leads; a gestora (admin) vê todos.
  update public.organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('visibility_mode', 'own')
   where id = v_org;

  insert into public.user_organizations (organization_id, user_id, role, accepted_at, interface_settings)
  values (v_org, v_hamilton, 'admin', now(), '{"preset":"completa"}'::jsonb);

  -- O gatilho trg_seed_default_pipeline_for_org criou o funil "Pedidos" (e-commerce). Troca por corretores.
  select id into v_pipe from public.crm_pipelines where organization_id = v_org and is_default;
  delete from public.crm_stages where pipeline_id = v_pipe;
  update public.crm_pipelines set name = 'Leads dos corretores', slug = 'leads-corretores' where id = v_pipe;
  for r in select * from (values
      ('Novo',            'novo',            false, false),
      ('Não atendeu',     'nao_atendeu',     false, false),
      ('Atendeu',         'atendeu',         false, false),
      ('Visita marcada',  'visita_marcada',  false, false),
      ('Proposta',        'proposta',        false, false),
      ('Fechou',          'fechou',          true,  false),
      ('Sem interesse',   'sem_interesse',   false, true)
    ) as t(nome, slug, won, lost)
  loop
    insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
    values (v_org, v_pipe, r.nome, r.slug, v_pos, r.won, r.lost);
    v_pos := v_pos + 1000;
  end loop;

  -- CONVITES (sem e-mail: email_dispatched = false; validade 7 dias; os links saem de um script).
  insert into public.team_invites (id, organization_id, email, role, interface_settings, invited_by, inviter_name,
                                   email_dispatched, created_at, last_sent_at, resend_count, expires_at)
  select gen_random_uuid(), v_org, lower(e.email), e.role,
         case when e.role = 'admin' then '{"preset":"completa"}'::jsonb
              else '{"preset":"simplificada","destinos":["/app/kanban","/app/contacts","/app/tasks","/app/agenda"]}'::jsonb end,
         v_hamilton, 'Hamilton Viana', false, now(), now(), 0, now() + interval '7 days'
    from (values
      ('brugnaracorretores@gmail.com',    'admin'),  -- Flávia Brugnara (gestora) — e-mail a confirmar
      ('canal@abyaraimoveis.com.br',      'agent'),
      ('diva@abyaraonline.com.br',        'agent'),
      ('claudia@abyaraimoveis.com.br',    'agent'),
      ('vanessa@abyaraimoveis.com.br',    'agent'),
      ('minos@abyaraimoveis.com.br',      'agent'),
      ('maffei@abyaraonline.com.br',      'agent'),
      ('peterson@abyaraimoveis.com.br',   'agent'),
      ('debora@abyaraimoveis.com.br',     'agent'),
      ('linka@abyaraimoveis.com.br',      'agent')
    ) as e(email, role);

  select jsonb_build_object(
    'org', (select to_jsonb(o) - 'onboarding_state' - 'dpo_email' from (select id, slug, display_name, status, timezone, currency, settings from public.organizations where id = v_org) o),
    'pipeline', (select jsonb_agg(s.name order by s.position) from public.crm_stages s where s.pipeline_id = v_pipe),
    'default_pipelines', (select count(*) from public.crm_pipelines where organization_id = v_org),
    'membros', (select count(*) from public.user_organizations where organization_id = v_org),
    'convites', (select jsonb_agg(jsonb_build_object('email', email, 'role', role)) from public.team_invites where organization_id = v_org)
  ) into v_resumo;

  if current_setting('oamg.modo') = 'prova' then
    raise exception 'PROVA_ORG_FLAVIA %', jsonb_pretty(v_resumo);
  end if;
  raise notice 'ORG_CRIADA %', v_resumo;
end
$oamg$;

commit;
