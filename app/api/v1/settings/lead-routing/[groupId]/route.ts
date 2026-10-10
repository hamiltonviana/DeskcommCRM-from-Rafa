/**
 * PATCH  /api/v1/settings/lead-routing/[groupId] — renomeia ou pausa/reativa o grupo (manager+).
 * DELETE /api/v1/settings/lead-routing/[groupId] — apaga o grupo, com membros e regras (manager+).
 *
 * Apagar o grupo mantém os leads e o dono que cada um já recebeu; só o histórico de
 * quem foi a vez daquele grupo se vai junto (cascata no banco).
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { leadRoutingGroupPatchSchema } from "@/lib/schemas/lead-routing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ groupId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const { groupId } = await ctx.params;
  if (!UUID.test(groupId)) return fail("not_found", "Grupo não encontrado.", 404, { requestId });

  const parsed = leadRoutingGroupPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Confira o nome do grupo.", 422, { requestId });

  const db = await createClient();
  const { data, error } = await db
    .from("lead_routing_groups")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", groupId)
    .eq("organization_id", auth.org.orgId)
    .select("id, name, active, saida_para_gestora")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") return fail("conflict", "Já existe um grupo com esse nome.", 409, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  // A RLS que nega escrita devolve zero linhas, não erro: zero linhas = não achou ou não pode.
  if (!data) return fail("not_found", "Grupo não encontrado.", 404, { requestId });
  void audit({
    action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "lead_routing_group", resourceId: groupId, requestId, metadata: { op: "group_updated", ...parsed.data },
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
  const { groupId } = await ctx.params;
  if (!UUID.test(groupId)) return fail("not_found", "Grupo não encontrado.", 404, { requestId });

  const db = await createClient();
  const { data, error } = await db
    .from("lead_routing_groups")
    .delete()
    .eq("id", groupId)
    .eq("organization_id", auth.org.orgId)
    .select("id, name")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível apagar. Tente novamente.", 500, { requestId });
  if (!data) return fail("not_found", "Grupo não encontrado.", 404, { requestId });
  void audit({
    action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "lead_routing_group", resourceId: groupId, requestId, metadata: { op: "group_deleted", name: data.name },
  });
  return ok({ id: data.id }, { requestId });
}
