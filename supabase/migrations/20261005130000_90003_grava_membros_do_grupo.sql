-- manifest: **Rodízio de leads: `fn_set_lead_routing_members` grava a lista de membros de um grupo de uma vez só (ordem + pausa).** É o que a tela de configuração chama. `security invoker`: a RLS de `lead_routing_group_members` (escrita manager+) continua sendo o portão. Valida que todo membro é atendente ativo da organização (agent/manager/admin), recusa lista com repetido e roda numa transação só — a tela nunca deixa o grupo pela metade. Aditiva e idempotente.
-- 90003: gravação atômica da lista de membros do grupo de rodízio.
--
-- A posição de cada membro é a ordem em que vem na lista (0, 1, 2...). O ponteiro do
-- rodízio mora no histórico (`lead_routing_assignments.member_position`), então
-- reordenar ou tirar gente não perde "de quem é a vez".
--
-- Erros (SQLSTATE): 42501 sem papel manager+; P0002 grupo não encontrado; 22023 lista
-- inválida (repetido ou membro que não é atendente ativo da organização).

create or replace function public.fn_set_lead_routing_members(p_org uuid, p_group uuid, p_members jsonb)
returns integer
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_total integer;
  v_distintos integer;
  v_invalidos integer;
begin
  -- Mesma régua da RLS de escrita (manager+): recusa com 42501 em vez de deixar o
  -- agent chegar a um DELETE que a RLS esvaziaria em silêncio.
  if not public.fn_role_at_least(p_org, 'manager') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.lead_routing_groups g
     where g.id = p_group and g.organization_id = p_org
  ) then
    raise exception 'group_not_found' using errcode = 'P0002';
  end if;

  if jsonb_typeof(p_members) is distinct from 'array' then
    raise exception 'members_must_be_array' using errcode = '22023';
  end if;

  select count(*), count(distinct (e.value ->> 'user_id'))
    into v_total, v_distintos
    from jsonb_array_elements(p_members) as e(value);
  if v_total <> v_distintos then
    raise exception 'duplicate_member' using errcode = '22023';
  end if;

  select count(*)
    into v_invalidos
    from jsonb_array_elements(p_members) as e(value)
   where not exists (
     select 1 from public.user_organizations uo
      where uo.organization_id = p_org
        and uo.user_id = (e.value ->> 'user_id')::uuid
        and uo.revoked_at is null
        and uo.role in ('agent', 'manager', 'admin')
   );
  if v_invalidos > 0 then
    raise exception 'member_not_eligible' using errcode = '22023';
  end if;

  delete from public.lead_routing_group_members m
   where m.group_id = p_group
     and m.organization_id = p_org
     and m.user_id not in (
       select (e.value ->> 'user_id')::uuid from jsonb_array_elements(p_members) as e(value)
     );

  insert into public.lead_routing_group_members (organization_id, group_id, user_id, position, active)
  select p_org, p_group, (e.value ->> 'user_id')::uuid, (e.ord - 1)::integer,
         coalesce((e.value ->> 'active')::boolean, true)
    from jsonb_array_elements(p_members) with ordinality as e(value, ord)
  on conflict (group_id, user_id)
  do update set position = excluded.position, active = excluded.active;

  return v_total;
end;
$function$;

revoke all on function public.fn_set_lead_routing_members(uuid, uuid, jsonb) from public, anon;
grant execute on function public.fn_set_lead_routing_members(uuid, uuid, jsonb) to authenticated, service_role;
