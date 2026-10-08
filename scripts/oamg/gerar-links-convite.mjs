// Gera os links de aceite de convite (sem enviar e-mail) a partir de linhas de team_invites.
// Roda DENTRO do container do app, para o segredo (INVITE_TOKEN_SECRET ou INTERNAL_SECRET) nunca sair do servidor.
// Mesma assinatura de lib/auth/invite-token.ts + lib/team/convites.ts (linkDeAceite).
//
// Entrada (stdin ou arquivo no argv[2]): JSON [{id,email,organization_id,role,interface_settings,invited_by,last_sent_at,expires_at}]
// Saída (stdout): JSON [{email, link}]
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const secret = process.env.INVITE_TOKEN_SECRET ?? process.env.INTERNAL_SECRET;
if (!secret) {
  console.error("sem INVITE_TOKEN_SECRET/INTERNAL_SECRET no ambiente");
  process.exit(2);
}
const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://crm.hamiltonviana.com.br").replace(/\/$/, "");
const b64url = (buf) => buf.toString("base64url");

const rows = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8"));
const out = rows.map((r) => {
  const payload = {
    invite_id: r.id,
    email: r.email,
    organization_id: r.organization_id,
    role: r.role,
    iat: Math.floor(Date.parse(r.last_sent_at) / 1000),
    exp: Math.floor(Date.parse(r.expires_at) / 1000),
    invited_by: r.invited_by ?? undefined,
    interface_settings: r.interface_settings,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return { email: r.email, link: `${base}/team/accept-invite/${body}.${sig}` };
});
process.stdout.write(JSON.stringify(out));
