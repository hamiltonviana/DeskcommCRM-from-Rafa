"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { EquipeData, EquipeMembro, TrocaRecente } from "@/lib/lead-routing/equipe";

const BASE = "/api/v1/settings/lead-routing";

interface Previa {
  divididos: number;
  com_a_gestora: number;
  sem_mudanca: number;
}

const PAPEL: Record<EquipeMembro["role"], string> = { agent: "Corretor(a)", manager: "Gerente", admin: "Administrador(a)" };
const TROCA: Record<TrocaRecente["kind"], string> = {
  nao_atendeu_no_prazo: "Não atendeu no prazo",
  redistribuido_por_saida: "Redistribuído (saída)",
  devolvido_a_gestora: "Voltou para a gestora",
};

export function EquipeClient({ initial, souAdmin, meuId }: { initial: EquipeData; souAdmin: boolean; meuId: string }) {
  const t = useT();
  const [data, setData] = useState(initial);
  const [saindo, setSaindo] = useState<EquipeMembro | null>(null);
  const [gestorId, setGestorId] = useState("");
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function recarregar() {
    const r = await fetch(`${BASE}/equipe`, { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.data) setData(j.data as EquipeData);
  }

  function cancelar() {
    setSaindo(null);
    setPrevia(null);
    setGestorId("");
  }

  async function chamar(membro: EquipeMembro, gestor: string, dryRun: boolean) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch(`${BASE}/members/${membro.id}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gestor_id: gestor, dry_run: dryRun }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(t(j.error?.message ?? "Não foi possível concluir. Nada foi alterado. Tente novamente."));
        return null;
      }
      return j.data as Previa;
    } catch {
      setMsg(t("Não foi possível concluir. Nada foi alterado. Tente novamente."));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const gestorasPara = (m: EquipeMembro) => data.gestoras.filter((g) => g.id !== m.id);

  return (
    <section className="rounded-lg border p-4 space-y-4" aria-labelledby="equipe-titulo" data-testid="lead-routing-equipe">
      <header>
        <h2 id="equipe-titulo" className="text-lg font-semibold">{t("Equipe e histórico do corretor")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("“Não atendeu no prazo” conta os leads que passaram para outra pessoa porque o retorno não foi registrado a tempo. Não é o mesmo que o lead não ter atendido o telefone.")}
        </p>
      </header>

      {!data.historico_disponivel && (
        <p className="text-sm text-muted-foreground">{t("O histórico de trocas ainda não está ativo nesta instalação.")}</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-3 font-medium">{t("Pessoa")}</th>
              <th className="py-2 pr-3 font-medium">{t("Papel")}</th>
              <th className="py-2 pr-3 font-medium">{t("Leads em aberto")}</th>
              <th className="py-2 pr-3 font-medium">{t("Não atendeu no prazo")}</th>
              <th className="py-2 pr-3 font-medium">{t("Leads redistribuídos")}</th>
              {souAdmin && <th className="py-2 font-medium" />}
            </tr>
          </thead>
          <tbody>
            {data.membros.map((m) => (
              <tr key={m.id} className="border-b last:border-0" data-testid="equipe-membro">
                <td className="py-2 pr-3">{m.name}</td>
                <td className="py-2 pr-3">{t(PAPEL[m.role])}</td>
                <td className="py-2 pr-3">{m.leads_abertos}</td>
                <td className="py-2 pr-3">{m.nao_atendeu_no_prazo}</td>
                <td className="py-2 pr-3">{m.redistribuidos_de}</td>
                {souAdmin && (
                  <td className="py-2 text-right">
                    {m.id !== meuId && m.role !== "admin" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={async () => {
                          const gs = gestorasPara(m);
                          const padrao = gs.find((g) => g.role === "admin")?.id ?? gs[0]?.id ?? "";
                          setSaindo(m);
                          setGestorId(padrao);
                          setPrevia(null);
                          setMsg("");
                          if (padrao) setPrevia(await chamar(m, padrao, true));
                        }}
                      >
                        {t("Tirar da equipe…")}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {saindo && (
        <div className="rounded-md border border-destructive/40 p-4 space-y-3" role="group" aria-label={t("Tirar da equipe")} data-testid="equipe-saida">
          <h3 className="font-medium">{t("Tirar da equipe:")} {saindo.name}</h3>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            {t("Quem fica com os leads em andamento (Atendeu, Visita marcada, Proposta)?")}
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={gestorId}
              onChange={async (e) => {
                setGestorId(e.target.value);
                setPrevia(null);
                if (e.target.value) setPrevia(await chamar(saindo, e.target.value, true));
              }}
              aria-label={t("Gestora")}
            >
              {gestorasPara(saindo).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          {previa ? (
            <ul className="list-disc pl-5 text-sm space-y-1" data-testid="equipe-previa">
              <li>{previa.divididos} {t("leads em Novo ou Não atendeu serão divididos entre as corretoras ativas, começando por quem tem menos leads em aberto.")}</li>
              <li>{previa.com_a_gestora} {t("leads em andamento voltam para a gestora escolhida.")}</li>
              <li>{previa.sem_mudanca} {t("leads fechados não mudam de dono.")}</li>
              <li>{t("A pessoa perde o acesso ao CRM agora. Quem recebe um lead é avisado.")}</li>
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("Calculando o que vai acontecer…")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !previa || !gestorId}
              onClick={async () => {
                const r = await chamar(saindo, gestorId, false);
                if (r) {
                  setMsg(`${saindo.name}: ${r.divididos} ${t("leads divididos")}, ${r.com_a_gestora} ${t("com a gestora")}.`);
                  cancelar();
                  await recarregar();
                }
              }}
            >
              {t("Confirmar saída")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={cancelar}>{t("Cancelar")}</Button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <h3 className="font-medium">{t("Últimas trocas de dono")}</h3>
        {data.trocas_recentes.length === 0 && <p className="text-sm text-muted-foreground">{t("Nenhuma troca registrada ainda.")}</p>}
        <ul className="space-y-1 text-sm" data-testid="equipe-trocas">
          {data.trocas_recentes.map((x) => (
            <li key={x.id}>
              <span className="text-muted-foreground">{new Date(x.created_at).toLocaleString("pt-BR")}</span>{" — "}
              <strong>{t(TROCA[x.kind])}</strong>: {x.lead_title ?? t("Lead sem nome")} ({x.from_name ?? "?"} → {x.to_name ?? "?"})
            </li>
          ))}
        </ul>
      </div>

      <p role="status" aria-live="polite" className="text-sm">{msg}</p>
    </section>
  );
}
