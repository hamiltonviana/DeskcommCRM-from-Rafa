/**
 * PUT /api/v1/settings/lead-routing/[groupId]/members — grava a lista INTEIRA de
 * membros do grupo, na ordem do rodízio, com a pausa de cada um (manager+).
 *
 * Uma chamada, uma transação (`fn_set_lead_routing_members`): a tela nunca deixa o
 * grupo pela metade. A posição é a ordem da lista.
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { leadRoutingMembersSchema } from "@/lib/schemas/lead-routing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(req: Request, ctx: { params: Promise<{ groupId: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_lead_routing", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const { groupId } = await ctx.params;
  if (!UUID.test(groupId)) return fail("not_found", "Grupo não encontrado.", 404, { requestId });

  const parsed = leadRoutingMembersSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Confira a lista de pessoas do grupo.", 422, { requestId });

  const db = await createClient();
  const { data, error } = await db.rpc("fn_set_lead_routing_members", {
    p_org: auth.org.orgId, p_group: groupId, p_members: parsed.data.members,
  });
  if (error) {
    if (error.code === "P0002") return fail("not_found", "Grupo não encontrado.", 404, { requestId });
    if (error.code === "22023") return fail("validation_failed", "A equipe mudou. Atualize a página e selecione novamente.", 422, { requestId });
    if (error.code === "42501") return fail("forbidden", "Esta sessão não pode alterar o grupo.", 403, { requestId });
    return fail("internal_error", "Não foi possível salvar. Tente novamente.", 500, { requestId });
  }
  void audit({
    action: "routing.config_changed", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "lead_routing_group", resourceId: groupId, requestId,
    metadata: { op: "members_set", members: parsed.data.members },
  });
  return ok({ saved: data }, { requestId });
}
