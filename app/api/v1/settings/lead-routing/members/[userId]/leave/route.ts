/**
 * POST /api/v1/settings/lead-routing/members/[userId]/leave — tira a pessoa da equipe e redistribui os
 * leads dela, numa transação só (admin).
 *
 * Corpo: { gestor_id, dry_run? }. Com `dry_run: true` só devolve a contagem do que aconteceria.
 * Regras (migration 90004, `fn_member_leave`): leads em Novo/Não atendeu são divididos entre as corretoras
 * ativas pelo menor número de leads em aberto; os demais em aberto voltam para a gestora; fechados ficam.
 * O novo dono é gravado por UPDATE, então recebe o push "lead atribuído a você".
 */
import { randomUUID } from "node:crypto";

import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { leadRoutingLeaveSchema } from "@/lib/schemas/lead-routing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, ctx: { params: Promise<{ userId: string }> }): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "team", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const { userId } = await ctx.params;
  if (!UUID.test(userId)) return fail("not_found", "Pessoa não encontrada na equipe.", 404, { requestId });

  const parsed = leadRoutingLeaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Escolha quem fica com os leads em andamento.", 422, { requestId });

  const db = await createClient();
  const { data, error } = await db.rpc("fn_member_leave", {
    p_org: auth.org.orgId,
    p_user: userId,
    p_gestor: parsed.data.gestor_id,
    p_dry_run: parsed.data.dry_run,
  });
  if (error) {
    if (error.code === "42501") return fail("forbidden", "Só administradores podem tirar alguém da equipe.", 403, { requestId });
    if (error.code === "P0002") return fail("not_found", "Pessoa não encontrada na equipe.", 404, { requestId });
    if (error.code === "22023") {
      const m = error.message ?? "";
      if (m.includes("cannot_remove_self")) return fail("state_conflict", "Você não pode tirar a si mesmo da equipe.", 409, { requestId });
      if (m.includes("last_admin")) return fail("state_conflict", "Não dá para tirar o último administrador.", 409, { requestId });
      if (m.includes("invalid_gestor")) return fail("validation_failed", "Escolha uma gerente ou administradora que continue na equipe.", 422, { requestId });
    }
    return fail("internal_error", "Não foi possível concluir. Nada foi alterado. Tente novamente.", 500, { requestId });
  }

  if (!parsed.data.dry_run) {
    void audit({
      action: "member.revoked",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "membership",
      resourceId: userId,
      requestId,
      metadata: { target_user_id: userId, gestor_id: parsed.data.gestor_id, redistribuicao: data },
    });
  }
  return ok(data, { requestId });
}
