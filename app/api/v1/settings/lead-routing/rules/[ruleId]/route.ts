/**
 * PATCH  /api/v1/settings/lead-routing/rules/[ruleId] — liga/desliga a regra (manager+).
 * DELETE /api/v1/settings/lead-routing/rules/[ruleId] — remove a regra (manager+).
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { leadRoutingRulePatchSchema } from "@/lib/schemas/lead-routing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ ruleId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const { ruleId } = await ctx.params;
  if (!UUID.test(ruleId)) return fail("not_found", "Regra não encontrada.", 404, { requestId });
  const parsed = leadRoutingRulePatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Pedido inválido.", 422, { requestId });

  const db = await createClient();
  const { data, error } = await db
    .from("lead_routing_rules").update({ active: parsed.data.active })
    .eq("id", ruleId).eq("organization_id", auth.org.orgId).select("id, active").maybeSingle();
  if (error) return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  if (!data) return fail("not_found", "Regra não encontrada.", 404, { requestId });
  void audit({
    action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "lead_routing_rule", resourceId: ruleId, requestId, metadata: { op: "rule_toggled", active: data.active },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const { ruleId } = await ctx.params;
  if (!UUID.test(ruleId)) return fail("not_found", "Regra não encontrada.", 404, { requestId });

  const db = await createClient();
  const { data, error } = await db
    .from("lead_routing_rules").delete().eq("id", ruleId).eq("organization_id", auth.org.orgId).select("id").maybeSingle();
  if (error) return fail("internal_error", "Não foi possível remover. Tente novamente.", 500, { requestId });
  if (!data) return fail("not_found", "Regra não encontrada.", 404, { requestId });
  void audit({
    action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "lead_routing_rule", resourceId: ruleId, requestId, metadata: { op: "rule_deleted" },
  });
  return ok({ id: data.id }, { requestId });
}
