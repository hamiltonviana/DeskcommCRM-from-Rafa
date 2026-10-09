/**
 * GET /api/v1/settings/lead-routing/equipe — equipe ativa, carga de leads em aberto e histórico do
 * corretor ("não atendeu no prazo", redistribuições) (manager+).
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { loadEquipe } from "@/lib/lead-routing/equipe";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    return ok(await loadEquipe(await createClient(), auth.org.orgId), { requestId });
  } catch {
    return fail("internal_error", "Não foi possível carregar a equipe. Tente novamente.", 500, { requestId });
  }
}
