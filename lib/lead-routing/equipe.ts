import type { SupabaseClient } from "@supabase/supabase-js";

import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

/**
 * Equipe da organização para a tela Rodízio de leads: quem está ativo, quantos leads em aberto cada um tem
 * e o HISTÓRICO do corretor (migration 90004): "não atendeu no prazo" = o lead passou para outra pessoa
 * porque o corretor não registrou retorno a tempo.
 *
 * Tolerante à ausência da 90004 (tabela inexistente = 42P01): a tela abre sem histórico em vez de quebrar.
 */
export type PapelDaEquipe = "agent" | "manager" | "admin";

export interface EquipeMembro {
  id: string;
  name: string;
  role: PapelDaEquipe;
  leads_abertos: number;
  nao_atendeu_no_prazo: number;
  redistribuidos_de: number;
}

export interface TrocaRecente {
  id: string;
  kind: "nao_atendeu_no_prazo" | "redistribuido_por_saida" | "devolvido_a_gestora";
  lead_id: string;
  lead_title: string | null;
  from_name: string | null;
  to_name: string | null;
  created_at: string;
}

export interface EquipeData {
  membros: EquipeMembro[];
  /** Quem pode ficar com os leads em andamento de quem sai: gerente ou admin ativo. */
  gestoras: Array<{ id: string; name: string; role: PapelDaEquipe }>;
  trocas_recentes: TrocaRecente[];
  historico_disponivel: boolean;
}

const TABELA_INEXISTENTE = "42P01";

export async function loadEquipe(db: SupabaseClient, org: string): Promise<EquipeData> {
  const [membrosR, abertosR, contagemR, recentesR] = await Promise.all([
    db.from("user_organizations").select("user_id, role").eq("organization_id", org).is("revoked_at", null).in("role", ["agent", "manager", "admin"]),
    db.from("crm_leads").select("owner_user_id").eq("organization_id", org).eq("status", "open").not("owner_user_id", "is", null).limit(20000),
    db.from("lead_ownership_events").select("kind, from_user_id").eq("organization_id", org).limit(20000),
    db.from("lead_ownership_events").select("id, kind, lead_id, from_user_id, to_user_id, created_at").eq("organization_id", org).order("created_at", { ascending: false }).limit(15),
  ]);
  if (membrosR.error) throw new Error(membrosR.error.message);
  if (abertosR.error) throw new Error(abertosR.error.message);
  const historicoDisponivel = !(contagemR.error?.code === TABELA_INEXISTENTE || recentesR.error?.code === TABELA_INEXISTENTE);
  if (historicoDisponivel && (contagemR.error || recentesR.error)) throw new Error((contagemR.error ?? recentesR.error)!.message);

  const membros = membrosR.data ?? [];
  const abertos = new Map<string, number>();
  for (const l of abertosR.data ?? []) {
    const id = String(l.owner_user_id);
    abertos.set(id, (abertos.get(id) ?? 0) + 1);
  }
  const noPrazo = new Map<string, number>();
  const porSaida = new Map<string, number>();
  for (const e of historicoDisponivel ? contagemR.data ?? [] : []) {
    if (!e.from_user_id) continue;
    const id = String(e.from_user_id);
    if (e.kind === "nao_atendeu_no_prazo") noPrazo.set(id, (noPrazo.get(id) ?? 0) + 1);
    else porSaida.set(id, (porSaida.get(id) ?? 0) + 1);
  }

  const recentes = historicoDisponivel ? recentesR.data ?? [] : [];
  const leadIds = recentes.map((r) => String(r.lead_id));
  const titulos = new Map<string, string | null>();
  if (leadIds.length) {
    const { data, error } = await db.from("crm_leads").select("id, title").eq("organization_id", org).in("id", leadIds);
    if (error) throw new Error(error.message);
    for (const l of data ?? []) titulos.set(String(l.id), (l.title as string | null) ?? null);
  }

  const nomes = await nomesDosAtendentes([
    ...membros.map((m) => String(m.user_id)),
    ...recentes.flatMap((r) => [r.from_user_id, r.to_user_id]),
  ]);
  const nome = (id: string | null | undefined) => (id ? nomes.get(String(id)) ?? "Atendente sem nome" : null);

  const lista: EquipeMembro[] = membros
    .map((m) => ({
      id: String(m.user_id),
      name: nome(String(m.user_id)) ?? "Atendente sem nome",
      role: m.role as PapelDaEquipe,
      leads_abertos: abertos.get(String(m.user_id)) ?? 0,
      nao_atendeu_no_prazo: noPrazo.get(String(m.user_id)) ?? 0,
      redistribuidos_de: porSaida.get(String(m.user_id)) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return {
    membros: lista,
    gestoras: lista.filter((m) => m.role !== "agent").map((m) => ({ id: m.id, name: m.name, role: m.role })),
    trocas_recentes: recentes.map((r) => ({
      id: String(r.id),
      kind: r.kind as TrocaRecente["kind"],
      lead_id: String(r.lead_id),
      lead_title: titulos.get(String(r.lead_id)) ?? null,
      from_name: nome(r.from_user_id as string | null),
      to_name: nome(r.to_user_id as string | null),
      created_at: String(r.created_at),
    })),
    historico_disponivel: historicoDisponivel,
  };
}
