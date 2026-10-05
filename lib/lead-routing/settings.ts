import type { SupabaseClient } from "@supabase/supabase-js";

import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export type LeadRoutingMatchType = "webhook_source" | "utm_campaign" | "pipeline";

export interface LeadRoutingSettings {
  groups: Array<{
    id: string;
    name: string;
    active: boolean;
    members: Array<{ user_id: string; name: string; position: number; active: boolean; eligible: boolean }>;
    rules: Array<{
      id: string;
      match_type: LeadRoutingMatchType;
      match_value: string;
      label: string;
      priority: number;
      active: boolean;
    }>;
  }>;
  /** Quem pode entrar num grupo: atendente ativo da organização. */
  candidates: Array<{ id: string; name: string }>;
  /** Fontes de webhook (formulários) da organização. */
  sources: Array<{ id: string; name: string; is_active: boolean }>;
  /** Últimos leads repartidos, para a gestora conferir quem recebeu. */
  recent: Array<{ id: string; group_id: string; lead_id: string; lead_title: string | null; user_id: string; user_name: string; created_at: string }>;
}

/** Quem pode receber lead por rodízio — a mesma régua do gatilho no banco. */
const PAPEIS_ELEGIVEIS = ["agent", "manager", "admin"];

export async function loadLeadRoutingSettings(db: SupabaseClient, org: string): Promise<LeadRoutingSettings> {
  const results = await Promise.all([
    db.from("lead_routing_groups").select("id, name, active").eq("organization_id", org).order("created_at"),
    db.from("lead_routing_group_members").select("group_id, user_id, position, active").eq("organization_id", org).order("position"),
    db.from("lead_routing_rules").select("id, group_id, match_type, match_value, priority, active").eq("organization_id", org).order("priority").order("created_at"),
    db.from("user_organizations").select("user_id").eq("organization_id", org).is("revoked_at", null).in("role", PAPEIS_ELEGIVEIS),
    db.from("webhook_sources").select("id, name, is_active").eq("organization_id", org).order("name"),
    db.from("lead_routing_assignments").select("id, group_id, lead_id, user_id, created_at").eq("organization_id", org).order("created_at", { ascending: false }).limit(15),
  ]);
  for (const r of results) if (r.error) throw new Error(r.error.message);

  const groups = results[0].data ?? [];
  const members = results[1].data ?? [];
  const rules = results[2].data ?? [];
  const eligibleIds = new Set((results[3].data ?? []).map((m) => String(m.user_id)));
  const sources = results[4].data ?? [];
  const recent = results[5].data ?? [];

  const leadIds = recent.map((r) => String(r.lead_id));
  const leadTitles = new Map<string, string | null>();
  if (leadIds.length) {
    const { data, error } = await db.from("crm_leads").select("id, title").eq("organization_id", org).in("id", leadIds);
    if (error) throw new Error(error.message);
    for (const l of data ?? []) leadTitles.set(String(l.id), (l.title as string | null) ?? null);
  }

  const names = await nomesDosAtendentes([
    ...eligibleIds,
    ...members.map((m) => String(m.user_id)),
    ...recent.map((r) => String(r.user_id)),
  ]);
  const nome = (id: string) => names.get(id) ?? "Atendente sem nome";
  const sourceName = new Map(sources.map((s) => [String(s.id), String(s.name)]));

  return {
    groups: groups.map((g) => ({
      id: String(g.id),
      name: String(g.name),
      active: Boolean(g.active),
      members: members
        .filter((m) => m.group_id === g.id)
        .map((m) => ({
          user_id: String(m.user_id),
          name: nome(String(m.user_id)),
          position: Number(m.position),
          active: Boolean(m.active),
          eligible: eligibleIds.has(String(m.user_id)),
        })),
      rules: rules
        .filter((r) => r.group_id === g.id)
        .map((r) => ({
          id: String(r.id),
          match_type: r.match_type as LeadRoutingMatchType,
          match_value: String(r.match_value),
          label:
            r.match_type === "webhook_source"
              ? `Formulário: ${sourceName.get(String(r.match_value)) ?? "fonte removida"}`
              : r.match_type === "utm_campaign"
                ? `Campanha: ${String(r.match_value)}`
                : `Funil: ${String(r.match_value)}`,
          priority: Number(r.priority),
          active: Boolean(r.active),
        })),
    })),
    candidates: [...eligibleIds].map((id) => ({ id, name: nome(id) })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    sources: sources.map((s) => ({ id: String(s.id), name: String(s.name), is_active: Boolean(s.is_active) })),
    recent: recent.map((r) => ({
      id: String(r.id),
      group_id: String(r.group_id),
      lead_id: String(r.lead_id),
      lead_title: leadTitles.get(String(r.lead_id)) ?? null,
      user_id: String(r.user_id),
      user_name: nome(String(r.user_id)),
      created_at: String(r.created_at),
    })),
  };
}
