/**
 * GET  /api/v1/settings/lead-routing — grupos de rodízio de leads, membros, regras
 *      e os últimos leads repartidos (manager+).
 * POST /api/v1/settings/lead-routing — cria um grupo (manager+).
 *
 * Rodízio de LEAD de formulário (90001..90003): o gatilho no banco dá o dono ao
 * lead novo (`source = 'webhook'`) pelo próximo membro ativo do grupo. Esta rota é a
 * porta de configuração. A escrita vai pelo client de SESSÃO: a RLS das tabelas
 * `lead_routing_*` (manager+, com `fn_support_write_allowed`) é o portão de verdade,
 * e o gate de papel de cima é só o conforto da resposta.
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { loadLeadRoutingSettings } from "@/lib/lead-routing/settings";
import { leadRoutingGroupCreateSchema } from "@/lib/schemas/lead-routing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  try {
    return ok(await loadLeadRoutingSettings(await createClient(), auth.org.orgId), { requestId });
  } catch {
    return fail("internal_error", "Não foi possível carregar o rodízio de leads. Tente novamente.", 500, { requestId });
  }
}

export async function POST(req: Request): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const parsed = leadRoutingGroupCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Dê um nome ao grupo.", 422, { requestId });

  const db = await createClient();
  const { data, error } = await db
    .from("lead_routing_groups")
    .insert({ organization_id: auth.org.orgId, name: parsed.data.name })
    .select("id, name, active")
    .single();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Já existe um grupo com esse nome.", 409, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode criar grupos.", 403, { requestId });
    return fail("internal_error", "Não foi possível criar o grupo. Tente novamente.", 500, { requestId });
  }
  void audit({
    action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "lead_routing_group", resourceId: data.id, requestId,
    metadata: { op: "group_created", name: data.name },
  });
  return ok({ id: data.id, name: data.name, active: data.active }, { requestId, status: 201 });
}
