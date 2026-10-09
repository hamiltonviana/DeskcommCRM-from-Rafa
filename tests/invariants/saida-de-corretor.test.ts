import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  seedGov,
  GOV_ORG as org,
  GOV_AGENT_A as leaver,
  GOV_AGENT_B as agentB,
  GOV_MANAGER as manager,
  GOV_ADMIN as admin,
  GOV_VIEWER as viewer,
  GOV_PIPELINE as pipeline,
} from "./gov-helpers";

/**
 * Saída de corretor com redistribuição (migration 90004).
 * Admin tira a corretora A: leads em Novo/Não atendeu são divididos entre as outras agents pelo menor número
 * de leads em aberto; os demais em aberto voltam para a gestora; fechados ficam; o acesso é revogado.
 */
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, args: unknown[] = []) => pool.query(text, args);

async function asUser(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
    const result = await c.query(text, args);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

const agentC = "cccccccc-1111-4000-8000-0000000000c1";
const TITLE = "lead-saida";

async function stageId(slug: string): Promise<string> {
  const r = await query("select id from crm_stages where pipeline_id=$1 and slug=$2", [pipeline, slug]);
  return r.rows[0].id as string;
}

async function lead(owner: string, slug: string, status = "open") {
  const r = await query(
    `insert into crm_leads(organization_id,pipeline_id,stage_id,title,source,owner_user_id,owner_kind,status)
     values($1,$2,$3,$4,'manual',$5,'user',$6) returning id`,
    [org, pipeline, await stageId(slug), TITLE, owner, status],
  );
  return r.rows[0].id as string;
}
const ownerOf = async (id: string) => (await query("select owner_user_id from crm_leads where id=$1", [id])).rows[0].owner_user_id as string;
const leave = (actor: string, user: string, gestor: string, dry = false) =>
  asUser(actor, "select public.fn_member_leave($1,$2,$3,$4) r", [org, user, gestor, dry]).then((r) => r.rows[0].r as Record<string, unknown>);

beforeAll(async () => {
  seedGov();
  await query("insert into auth.users(id,email) values($1,'gov-agent-c@invariant.test') on conflict do nothing", [agentC]);
  await query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now()) on conflict do nothing", [agentC, org]);
  for (const [slug, pos, won, lost] of [
    ["novo", 9100, false, false],
    ["nao_atendeu", 9200, false, false],
    ["atendeu", 9300, false, false],
    ["fechou", 9400, true, false],
  ] as const) {
    await query(
      `insert into crm_stages(organization_id,pipeline_id,name,slug,position,is_won,is_lost)
       select $1,$2,$3,$4,$5,$6,$7 where not exists (select 1 from crm_stages where pipeline_id=$2 and slug=$4)`,
      [org, pipeline, slug, slug, pos, won, lost],
    );
  }
});
afterAll(() => pool.end());
beforeEach(async () => {
  await query("delete from crm_leads where organization_id=$1 and title=$2", [org, TITLE]);
  await query("update user_organizations set revoked_at=null where organization_id=$1 and user_id=any($2)", [org, [leaver, agentB, agentC]]);
});

describe("fn_member_leave", () => {
  it("dry-run só conta: nada muda e a corretora continua ativa", async () => {
    await lead(leaver, "novo");
    await lead(leaver, "novo");
    await lead(leaver, "nao_atendeu");
    await lead(leaver, "atendeu");
    const r = await leave(admin, leaver, manager, true);
    expect(r).toMatchObject({ dry_run: true, revogado: false, divididos: 3, com_a_gestora: 1, sem_mudanca: 0 });
    const donos = await query("select count(*)::int n from crm_leads where title=$1 and owner_user_id=$2", [TITLE, leaver]);
    expect(donos.rows[0].n).toBe(4);
    const m = await query("select revoked_at from user_organizations where organization_id=$1 and user_id=$2", [org, leaver]);
    expect(m.rows[0].revoked_at).toBeNull();
  });

  it("divide Novo/Não atendeu entre as outras agents, devolve o resto à gestora, não toca em fechado e revoga", async () => {
    const novo1 = await lead(leaver, "novo");
    const novo2 = await lead(leaver, "novo");
    const naoAt = await lead(leaver, "nao_atendeu");
    const atendeu = await lead(leaver, "atendeu");
    const fechado = await lead(leaver, "fechou", "won");

    const r = await leave(admin, leaver, manager);
    expect(r).toMatchObject({ revogado: true, divididos: 3, com_a_gestora: 1 });

    const donosDivididos = [await ownerOf(novo1), await ownerOf(novo2), await ownerOf(naoAt)];
    expect(donosDivididos.every((d) => d === agentB || d === agentC)).toBe(true);
    expect(new Set(donosDivididos).size).toBe(2); // as duas receberam
    expect(await ownerOf(atendeu)).toBe(manager);
    expect(await ownerOf(fechado)).toBe(leaver);

    const m = await query("select revoked_at from user_organizations where organization_id=$1 and user_id=$2", [org, leaver]);
    expect(m.rows[0].revoked_at).not.toBeNull();

    const ev = await query("select kind, count(*)::int n from lead_ownership_events where from_user_id=$1 group by 1 order by 1", [leaver]);
    expect(ev.rows).toEqual([
      { kind: "devolvido_a_gestora", n: 1 },
      { kind: "redistribuido_por_saida", n: 3 },
    ]);

    // o dono entra por UPDATE: cada lead movido emitiu lead.assigned (é o que dá o push)
    const assigned = await query(
      "select count(*)::int n from event_log where organization_id=$1 and event_type='lead.assigned' and (payload->>'lead_id')::uuid = any($2)",
      [org, [novo1, novo2, naoAt, atendeu]],
    );
    expect(assigned.rows[0].n).toBe(4);
  });

  it("quem tem menos leads em aberto recebe primeiro", async () => {
    for (let i = 0; i < 5; i++) await lead(agentB, "atendeu");
    const a = await lead(leaver, "novo");
    const b = await lead(leaver, "novo");
    const c = await lead(leaver, "novo");
    await leave(admin, leaver, manager);
    expect([await ownerOf(a), await ownerOf(b), await ownerOf(c)]).toEqual([agentC, agentC, agentC]);
  });

  it("sem nenhuma agent ativa, tudo volta para a gestora com o motivo registrado", async () => {
    await query("update user_organizations set revoked_at=now() where organization_id=$1 and user_id=any($2)", [org, [agentB, agentC]]);
    const a = await lead(leaver, "novo");
    const r = await leave(admin, leaver, manager);
    expect(r).toMatchObject({ divididos: 0, com_a_gestora: 1 });
    expect(await ownerOf(a)).toBe(manager);
    const ev = await query("select detail from lead_ownership_events where lead_id=$1", [a]);
    expect(ev.rows[0].detail).toMatchObject({ motivo: "sem_corretora_ativa" });
  });

  it("só admin executa; não dá para tirar a si mesmo; a gestora tem de ser gerente/admin ativo", async () => {
    await expect(leave(manager, leaver, manager)).rejects.toThrow(/forbidden/);
    await expect(leave(agentB, leaver, manager)).rejects.toThrow(/forbidden/);
    await expect(leave(viewer, leaver, manager)).rejects.toThrow(/forbidden/);
    await expect(leave(admin, admin, manager)).rejects.toThrow(/cannot_remove_self/);
    await expect(leave(admin, leaver, agentB)).rejects.toThrow(/invalid_gestor/);
    await expect(leave(admin, leaver, viewer)).rejects.toThrow(/invalid_gestor/);
    await expect(leave(admin, leaver, leaver)).rejects.toThrow(/invalid_gestor/);
    await expect(leave(admin, "cccccccc-1111-4000-8000-0000000000ff", manager)).rejects.toThrow(/member_not_found/);
    const m = await query("select revoked_at from user_organizations where organization_id=$1 and user_id=$2", [org, leaver]);
    expect(m.rows[0].revoked_at).toBeNull();
  });

  it("anon não executa", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role anon");
      await expect(c.query("select public.fn_member_leave($1,$2,$3,true)", [org, leaver, manager])).rejects.toThrow();
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("fn_lead_repass e o histórico", () => {
  it("registra 'nao_atendeu_no_prazo' no histórico de quem não deu retorno e troca o dono", async () => {
    const l = await lead(leaver, "novo");
    const ok = await query("select public.fn_lead_repass($1,$2,$3,$4,'nao_atendeu_no_prazo',null,'{\"prazo_min\":30}'::jsonb) r", [org, l, leaver, agentB]);
    expect(ok.rows[0].r).toBe(true);
    expect(await ownerOf(l)).toBe(agentB);
    const ev = await query("select kind, from_user_id, to_user_id, detail from lead_ownership_events where lead_id=$1", [l]);
    expect(ev.rows).toEqual([{ kind: "nao_atendeu_no_prazo", from_user_id: leaver, to_user_id: agentB, detail: { prazo_min: 30 } }]);
  });

  it("não pisa se o dono já mudou, e recusa destinatário que não é atendente ativo", async () => {
    const l = await lead(agentB, "novo");
    const r = await query("select public.fn_lead_repass($1,$2,$3,$4,'nao_atendeu_no_prazo') r", [org, l, leaver, agentC]);
    expect(r.rows[0].r).toBe(false);
    expect(await ownerOf(l)).toBe(agentB);
    await expect(query("select public.fn_lead_repass($1,$2,$3,$4,'nao_atendeu_no_prazo')", [org, l, agentB, viewer])).rejects.toThrow(/recipient_not_eligible/);
    await expect(query("select public.fn_lead_repass($1,$2,$3,$4,'qualquer')", [org, l, agentB, agentC])).rejects.toThrow(/invalid_kind/);
  });

  it("authenticated não executa o repasse direto", async () => {
    const l = await lead(leaver, "novo");
    await expect(asUser(admin, "select public.fn_lead_repass($1,$2,$3,$4,'nao_atendeu_no_prazo')", [org, l, leaver, agentB])).rejects.toThrow();
  });

  it("o corretor vê só o próprio histórico; gerente vê tudo; ninguém escreve por REST", async () => {
    const l1 = await lead(leaver, "novo");
    const l2 = await lead(agentC, "novo");
    await query("select public.fn_lead_repass($1,$2,$3,$4,'nao_atendeu_no_prazo')", [org, l1, leaver, agentB]);
    await query("select public.fn_lead_repass($1,$2,$3,$4,'nao_atendeu_no_prazo')", [org, l2, agentC, agentB]);

    const meu = await asUser(leaver, "select from_user_id from lead_ownership_events where lead_id = any($1)", [[l1, l2]]);
    expect(meu.rows.map((r) => r.from_user_id)).toEqual([leaver]);
    const tudo = await asUser(manager, "select count(*)::int n from lead_ownership_events where lead_id = any($1)", [[l1, l2]]);
    expect(tudo.rows[0].n).toBe(2);
    await expect(
      asUser(admin, "insert into lead_ownership_events(organization_id,lead_id,kind) values($1,$2,'nao_atendeu_no_prazo')", [org, l1]),
    ).rejects.toThrow();
  });
});
