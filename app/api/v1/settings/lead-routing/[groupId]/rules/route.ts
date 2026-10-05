/**
 * POST /api/v1/settings/lead-routing/[groupId]/rules — liga uma origem de lead ao
 * grupo: um formulário (fonte de webhook) ou uma campanha (`utm_campaign`) (manager+).
 *
 * Uma origem só pode apontar para UM grupo por organização (unicidade no banco).
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { leadRoutingRuleCreateSchema } from "@/lib/schemas/lead-routing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, ctx: { params: Promise<{ groupId: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const { groupId } = await ctx.params;
  if (!UUID.test(groupId)) return fail("not_found", "Grupo não encontrado.", 404, { requestId });

  const parsed = leadRoutingRuleCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Escolha o formulário ou informe a campanha.", 422, { requestId });

  const db = await createClient();
  const { data: group } = await db
    .from("lead_routing_groups").select("id").eq("id", groupId).eq("organization_id", auth.org.orgId).maybeSingle();
  if (!group) return fail("not_found", "Grupo não encontrado.", 404, { requestId });

  if (parsed.data.match_type === "webhook_source") {
    const { data: source } = await db
      .from("webhook_sources").select("id").eq("id", parsed.data.match_value).eq("organization_id", auth.org.orgId).maybeSingle();
    if (!source) return fail("validation_failed", "Esse formulário não existe nesta organização.", 422, { requestId });
  }

  const { data, error } = await db
    .from("lead_routing_rules")
    .insert({
      organization_id: auth.org.orgId, group_id: groupId,
      match_type: parsed.data.match_type, match_value: parsed.data.match_value,
      ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
    })
    .select("id, match_type, match_value, priority, active")
    .single();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Essa origem já está ligada a um grupo.", 409, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode criar regras.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  void audit({
    action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "lead_routing_rule", resourceId: data.id, requestId,
    metadata: { op: "rule_created", group_id: groupId, match_type: data.match_type, match_value: data.match_value },
  });
  return ok(data, { requestId, status: 201 });
}
