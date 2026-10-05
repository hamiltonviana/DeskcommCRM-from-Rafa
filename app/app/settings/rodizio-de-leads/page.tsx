/**
 * Configurações → Rodízio de leads.
 *
 * A porta do rodízio de LEAD de formulário (90001..90003). O rodízio de CONVERSA
 * (Distribuição de atendimento) reparte quem atende cada conversa; este reparte o
 * lead que chega por formulário (Meta Lead Ads, Elementor, RD Station...) e nasce sem
 * conversa. Quem entra na regra por origem é só o lead de formulário — o lead que
 * nasce de uma conversa de WhatsApp segue o rodízio de conversa.
 *
 * Gate = manager+, a mesma régua de Distribuição de atendimento.
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { loadLeadRoutingSettings } from "@/lib/lead-routing/settings";
import { createClient } from "@/lib/supabase/server";

import { LeadRoutingClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function RodizioDeLeadsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const initial = await loadLeadRoutingSettings(await createClient(), activeOrg.orgId);
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Rodízio de leads", idioma)}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Cada lead novo que chega por um formulário vai, na ordem, para a próxima pessoa ativa do grupo — e ela recebe o aviso “lead atribuído a você”. Conversas de WhatsApp continuam seguindo a Distribuição de atendimento.",
            idioma,
          )}
        </p>
      </header>
      <LeadRoutingClient initial={initial} />
    </div>
  );
}
