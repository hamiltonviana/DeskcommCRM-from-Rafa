/**
 * Zod do rodízio de leads por grupo (90001..90003). A escrita real é guardada
 * pela RLS (manager+); estes schemas só fecham o formato na borda da API.
 */
import { z } from "zod";

const uuid = z.string().uuid();

export const leadRoutingGroupCreateSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome ao grupo.").max(120),
});

export const leadRoutingGroupPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.active !== undefined, { message: "Nada para alterar." });

export const leadRoutingMembersSchema = z
  .object({
    members: z
      .array(z.object({ user_id: uuid, active: z.boolean().default(true) }))
      .max(100)
      .refine((m) => new Set(m.map((x) => x.user_id)).size === m.length, { message: "Pessoa repetida na lista." }),
  });

/** Só os dois tipos que a tela oferece; `pipeline` existe no banco, sem tela. */
export const leadRoutingRuleCreateSchema = z.discriminatedUnion("match_type", [
  z.object({ match_type: z.literal("webhook_source"), match_value: uuid, priority: z.number().int().min(0).max(1000).optional() }),
  z.object({
    match_type: z.literal("utm_campaign"),
    match_value: z.string().trim().min(1).max(200),
    priority: z.number().int().min(0).max(1000).optional(),
  }),
]);

export const leadRoutingRulePatchSchema = z.object({ active: z.boolean() });

export type LeadRoutingRuleCreate = z.infer<typeof leadRoutingRuleCreateSchema>;
