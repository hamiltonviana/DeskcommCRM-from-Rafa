"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { LeadRoutingSettings } from "@/lib/lead-routing/settings";

type Group = LeadRoutingSettings["groups"][number];
type Draft = Array<{ user_id: string; name: string; active: boolean }>;

const BASE = "/api/v1/settings/lead-routing";

function draftDe(group: Group): Draft {
  return group.members.map((m) => ({ user_id: m.user_id, name: m.name, active: m.active }));
}

export function LeadRoutingClient({ initial }: { initial: LeadRoutingSettings }) {
  const t = useT();
  const [data, setData] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(initial.groups.map((g) => [g.id, draftDe(g)])),
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [campaign, setCampaign] = useState<Record<string, string>>({});
  const [source, setSource] = useState<Record<string, string>>({});
  const [toAdd, setToAdd] = useState<Record<string, string>>({});

  async function recarregar() {
    const r = await fetch(BASE, { cache: "no-store" });
    const j = await r.json();
    if (r.ok) {
      const next = j.data as LeadRoutingSettings;
      setData(next);
      setDrafts(Object.fromEntries(next.groups.map((g) => [g.id, draftDe(g)])));
    }
  }

  /** Uma chamada de escrita; mostra a mensagem do servidor se falhar e recarrega se der certo. */
  async function chamar(url: string, method: string, body: unknown, okMsg: string) {
    setBusy(true);
    setFeedback("");
    try {
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFeedback(t(j.error?.message ?? "Não foi possível salvar. Tente novamente."));
        return false;
      }
      await recarregar();
      setFeedback(t(okMsg));
      return true;
    } catch {
      setFeedback(t("Não foi possível salvar. Tente novamente."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function mover(groupId: string, index: number, delta: -1 | 1) {
    setDrafts((cur) => {
      const lista = [...(cur[groupId] ?? [])];
      const alvo = index + delta;
      if (alvo < 0 || alvo >= lista.length) return cur;
      [lista[index], lista[alvo]] = [lista[alvo]!, lista[index]!];
      return { ...cur, [groupId]: lista };
    });
  }

  const sujo = (g: Group) => JSON.stringify(drafts[g.id] ?? []) !== JSON.stringify(draftDe(g));

  return (
    <div className="space-y-6">
      <section className="rounded-lg border p-4 space-y-3" aria-labelledby="novo-grupo-titulo">
        <h2 id="novo-grupo-titulo" className="text-lg font-semibold">{t("Novo grupo")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Um grupo é a equipe de um empreendimento. Use o MESMO nome do empreendimento (ex.: Alves Guimarães): é por ele que a saída de uma corretora sabe quem pode receber os leads dela.")}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            className="min-w-64 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            placeholder={t("Nome do grupo")}
            value={newGroup}
            maxLength={120}
            onChange={(e) => setNewGroup(e.target.value)}
            aria-label={t("Nome do grupo")}
          />
          <Button
            disabled={busy || !newGroup.trim()}
            onClick={async () => {
              if (await chamar(BASE, "POST", { name: newGroup }, "Grupo criado.")) setNewGroup("");
            }}
          >
            {t("Criar grupo")}
          </Button>
        </div>
      </section>

      {data.groups.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="lead-routing-empty">
          {t("Nenhum grupo ainda. Crie um grupo, escolha quem faz parte e ligue o formulário.")}
        </p>
      )}

      {data.groups.map((group) => {
        const draft = drafts[group.id] ?? [];
        const naLista = new Set(draft.map((m) => m.user_id));
        const livres = data.candidates.filter((c) => !naLista.has(c.id));
        const fontesLivres = data.sources.filter(
          (s) => !data.groups.some((g) => g.rules.some((r) => r.match_type === "webhook_source" && r.match_value === s.id)),
        );
        const semGente = !group.members.some((m) => m.active && m.eligible);
        return (
          <section key={group.id} className="rounded-lg border p-4 space-y-4" data-testid="lead-routing-group" aria-label={group.name}>
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">{group.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {group.active ? t("Grupo ativo: recebe os leads das origens ligadas abaixo.") : t("Grupo pausado: não recebe leads novos.")}
                </p>
                <label className="mt-1 flex items-center gap-2 text-xs" data-testid="lead-routing-verba-propria">
                  <input
                    type="checkbox"
                    checked={group.saida_para_gestora}
                    disabled={busy}
                    onChange={(e) =>
                      void chamar(`${BASE}/${group.id}`, "PATCH", { saida_para_gestora: e.target.checked }, "Regra de saída salva.")
                    }
                  />
                  {t("Equipe com verba própria: quando alguém sair, os leads novos dela voltam para a gestora em vez de serem divididos.")}
                </label>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void chamar(`${BASE}/${group.id}`, "PATCH", { active: !group.active }, group.active ? "Grupo pausado." : "Grupo ativado.")}
                >
                  {t(group.active ? "Pausar grupo" : "Ativar grupo")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("Apagar este grupo? Os leads e seus donos continuam; só o histórico do rodízio deste grupo se perde."))) {
                      void chamar(`${BASE}/${group.id}`, "DELETE", undefined, "Grupo apagado.");
                    }
                  }}
                >
                  {t("Apagar")}
                </Button>
              </div>
            </header>

            <div className="space-y-2">
              <h3 className="font-medium">{t("Quem recebe, na ordem do rodízio")}</h3>
              {draft.length === 0 && <p className="text-sm text-muted-foreground">{t("Ninguém no grupo ainda.")}</p>}
              <ol className="space-y-1">
                {draft.map((m, i) => {
                  const atual = group.members.find((x) => x.user_id === m.user_id);
                  const inelegivel = atual ? !atual.eligible : false;
                  return (
                    <li key={m.user_id} className="flex flex-wrap items-center gap-2 rounded-md p-2 hover:bg-muted" data-testid="lead-routing-member">
                      <span className="w-6 text-right text-sm text-muted-foreground">{i + 1}.</span>
                      <span className="min-w-40 flex-1">{m.name}</span>
                      {inelegivel && (
                        <span className="text-xs text-destructive">{t("Não está mais ativo na equipe — será ignorado.")}</span>
                      )}
                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={m.active}
                          onChange={(e) =>
                            setDrafts((cur) => ({
                              ...cur,
                              [group.id]: (cur[group.id] ?? []).map((x) => (x.user_id === m.user_id ? { ...x, active: e.target.checked } : x)),
                            }))
                          }
                        />
                        {t("Recebe leads")}
                      </label>
                      <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => mover(group.id, i, -1)} aria-label={t("Subir")}>↑</Button>
                      <Button variant="ghost" size="sm" disabled={i === draft.length - 1} onClick={() => mover(group.id, i, 1)} aria-label={t("Descer")}>↓</Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDrafts((cur) => ({ ...cur, [group.id]: (cur[group.id] ?? []).filter((x) => x.user_id !== m.user_id) }))}
                      >
                        {t("Remover")}
                      </Button>
                    </li>
                  );
                })}
              </ol>
              <div className="flex flex-wrap gap-2">
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  value={toAdd[group.id] ?? ""}
                  onChange={(e) => setToAdd((c) => ({ ...c, [group.id]: e.target.value }))}
                  aria-label={t("Adicionar pessoa")}
                >
                  <option value="">{t("Adicionar pessoa…")}</option>
                  {livres.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  disabled={!toAdd[group.id]}
                  onClick={() => {
                    const c = data.candidates.find((x) => x.id === toAdd[group.id]);
                    if (!c) return;
                    setDrafts((cur) => ({ ...cur, [group.id]: [...(cur[group.id] ?? []), { user_id: c.id, name: c.name, active: true }] }));
                    setToAdd((cur) => ({ ...cur, [group.id]: "" }));
                  }}
                >
                  {t("Adicionar")}
                </Button>
                <Button
                  disabled={busy || !sujo(group)}
                  onClick={() =>
                    void chamar(`${BASE}/${group.id}/members`, "PUT", { members: draft.map((m) => ({ user_id: m.user_id, active: m.active })) }, "Equipe do grupo salva.")
                  }
                >
                  {t("Salvar equipe do grupo")}
                </Button>
              </div>
              {semGente && group.active && (
                <p className="text-sm text-destructive" role="alert">
                  {t("Ninguém ativo neste grupo: os leads das origens ligadas chegam sem dono.")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="font-medium">{t("De onde vêm os leads deste grupo")}</h3>
              {group.rules.length === 0 && (
                <p className="text-sm text-destructive">{t("Nenhuma origem ligada: este grupo não recebe lead nenhum.")}</p>
              )}
              <ul className="space-y-1">
                {group.rules.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md p-2 hover:bg-muted" data-testid="lead-routing-rule">
                    <span className="min-w-40 flex-1">{r.label}</span>
                    <label className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={r.active}
                        disabled={busy}
                        onChange={(e) => void chamar(`${BASE}/rules/${r.id}`, "PATCH", { active: e.target.checked }, "Regra salva.")}
                      />
                      {t("Ligada")}
                    </label>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void chamar(`${BASE}/rules/${r.id}`, "DELETE", undefined, "Origem removida.")}>
                      {t("Remover")}
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  value={source[group.id] ?? ""}
                  onChange={(e) => setSource((c) => ({ ...c, [group.id]: e.target.value }))}
                  aria-label={t("Ligar um formulário")}
                >
                  <option value="">{t("Ligar um formulário…")}</option>
                  {fontesLivres.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.is_active ? "" : ` (${t("desativado")})`}</option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  disabled={busy || !source[group.id]}
                  onClick={async () => {
                    if (await chamar(`${BASE}/${group.id}/rules`, "POST", { match_type: "webhook_source", match_value: source[group.id] }, "Formulário ligado ao grupo."))
                      setSource((c) => ({ ...c, [group.id]: "" }));
                  }}
                >
                  {t("Ligar")}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  className="min-w-64 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder={t("Ou o nome da campanha (utm_campaign)")}
                  value={campaign[group.id] ?? ""}
                  maxLength={200}
                  onChange={(e) => setCampaign((c) => ({ ...c, [group.id]: e.target.value }))}
                  aria-label={t("Nome da campanha")}
                />
                <Button
                  variant="outline"
                  disabled={busy || !(campaign[group.id] ?? "").trim()}
                  onClick={async () => {
                    if (await chamar(`${BASE}/${group.id}/rules`, "POST", { match_type: "utm_campaign", match_value: (campaign[group.id] ?? "").trim() }, "Campanha ligada ao grupo."))
                      setCampaign((c) => ({ ...c, [group.id]: "" }));
                  }}
                >
                  {t("Ligar campanha")}
                </Button>
              </div>
            </div>
          </section>
        );
      })}

      <section className="rounded-lg border p-4 space-y-2" aria-labelledby="recentes-titulo">
        <h2 id="recentes-titulo" className="text-lg font-semibold">{t("Últimos leads repartidos")}</h2>
        {data.recent.length === 0 && <p className="text-sm text-muted-foreground">{t("Ainda nenhum lead passou pelo rodízio.")}</p>}
        <ul className="space-y-1 text-sm" data-testid="lead-routing-recent">
          {data.recent.map((r) => (
            <li key={r.id}>
              <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString("pt-BR")}</span>{" — "}
              {r.lead_title ?? t("Lead sem nome")} → <strong>{r.user_name}</strong>
            </li>
          ))}
        </ul>
      </section>

      <p role="status" aria-live="polite" className="text-sm">{feedback}</p>
    </div>
  );
}
