# Versão OAMG do DeskcommCRM

Fork independente do [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM). A linha própria é a branch **`oamg`**; a `main` deste fork está parada e não é usada.

## De onde parte
- Base: tag **v1.20.0** do upstream (revisão `53428145`), que é a versão que roda na produção (`crm.hamiltonviana.com.br`).
- Por quê não a última: subir 50+ versões de uma vez traz centenas de migrations sem necessidade. Atualizar a base é um projeto à parte (ver "Trazer novidades do Rafa").

## O que a OAMG acrescenta
**Rodízio de leads de formulário por grupo** (issue upstream #2041; PR aberto lá como #2269, sem expectativa de merge).
- Banco: migrations `90001`–`90003` (bloco numérico próprio, longe da numeração do upstream, para nunca colidir).
  - `lead_routing_groups`, `_group_members`, `_rules`, `_assignments`; gatilho `AFTER INSERT` em `crm_leads` **só para `source = 'webhook'`** (lead de formulário; lead que nasce de conversa de WhatsApp segue o rodízio de conversas); o dono entra por UPDATE para o evento `lead.assigned` disparar o push.
  - `fn_set_lead_routing_members`: grava ordem e pausa de um grupo numa transação (exige manager+).
- API: `/api/v1/settings/lead-routing/**` (RLS + zod + audit log).
- Tela: **Configurações → Rodízio de leads** (`/app/settings/rodizio-de-leads`).
- Testes: `tests/invariants/lead-routing-groups.test.ts` (23 casos).

## Construir e publicar
Não há registry: a imagem é construída na máquina de desenvolvimento e enviada por SSH (o VPS tem 2 CPUs/8 GB e não deve compilar o Next.js).

```bash
docker build -t deskcomm-oamg:<versao> --build-arg APP_VERSION=<versao> .
docker save deskcomm-oamg:<versao> | gzip -1 | ssh hamiltonserver 'gunzip | docker load'
# no servidor:
#   1. cp -p /root/crm/.env /root/crm/.env.bak-<data>
#   2. trocar APP_IMAGE=deskcomm-oamg:<versao> em /root/crm/.env
#   3. docker service update --image deskcomm-oamg:<versao> --no-resolve-image --update-order start-first crm_app
```
Versão atual: `deskcomm-oamg:1.20.0-oamg.1`. Só o `app` muda; `worker` e `scheduler` seguem as imagens do upstream.

**Voltar atrás:** `/root/crm/ROLLBACK-oamg.txt` no servidor tem o comando exato (imagem v1.20.0 do upstream + `.env` de backup).

## Migrations em produção
A produção não registra migrations uma a uma (rastreia por blocos do baseline). As `9000x` foram aplicadas à mão, em transação, com `psql`, depois de provadas numa transação revertida contra o schema real. Para uma instalação nova elas já estão no apêndice do `supabase/baseline.sql` (acima do bloco da varredura de `anon`).

## Trazer novidades do Rafa
```bash
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git
git fetch upstream --tags
git merge v1.XX.0        # na branch oamg
```
- Conflito esperado só em `lib/navigation/catalogo.ts`, `lib/schemas/index.ts`, `supabase/baseline.sql` e `supabase/migrations/MANIFEST.md` (todos são acréscimos em fim de bloco).
- Depois de subir a base, aplicar as migrations novas do upstream **antes** de trocar a imagem, e rodar `pnpm test:db tests/invariants/lead-routing-groups.test.ts`.
- Se o upstream entregar rodízio de lead próprio, comparar antes de manter o nosso.

## Ponte da Meta (n8n)
Workflow **"Meta Lead Ads → CRM OAMG (rodízio de leads)"** (`0Th99EnhZXpQKbPb`): a cada 2 min lê os leads de cada formulário da Página e envia para a fonte de webhook do CRM (`/api/v1/webhooks/in/<token>`), com `external_id = meta_<id>` (o CRM deduplica). Nasce inativo; edite o nó **Config** (formulário → token da fonte) e ative. Na 1ª execução marca o instante da ativação e **não importa histórico**.

## Organização da Flávia Brugnara (08/10/2026)
Criada em produção com `scripts/oamg/criar-org-flavia.sql` (replica `fn_create_tenant_with_owner`, que exige platform_admin — a instalação não tem nenhum). Slug `flavia-brugnara`; `settings.visibility_mode = 'own'` (cada corretora vê só os próprios leads; a gestora/admin vê todos); funil **Leads dos corretores** com as mesmas etapas do retorno da Roleta (Novo, Não atendeu, Atendeu, Visita marcada, Proposta, Fechou, Sem interesse). Hamilton é admin; Flávia é admin; corretoras são `agent` com interface simplificada (kanban, contatos, tarefas, agenda).

**Convites sem e-mail:** o SQL cria as linhas em `team_invites` (`email_dispatched=false`, validade 7 dias). Os links saem de `scripts/oamg/gerar-links-convite.mjs`, que roda **dentro do container do app** (o segredo de assinatura nunca sai do servidor) com a mesma assinatura de `linkDeAceite`. Os links ficam num arquivo local do Hamilton, nunca no Git.

```bash
# no servidor: monta o JSON dos convites em aberto e assina os links dentro do container
docker cp gerar-links-convite.mjs $(docker ps -q -f name=crm_app):/tmp/gerar.mjs
docker exec $(docker ps -q -f name=crm_app) node /tmp/gerar.mjs /tmp/convites.json
```

## Papel do CRM em relação à Roleta (decisão de 08/10/2026)
**A Roleta (planilha + n8n) continua sendo o motor** que decide quem recebe cada lead (menor ciclo, repasse após 30 min úteis, Sarutaiá por conjunto, lead repetido). O CRM é a **cara**: a corretora vê "meus leads" no celular, recebe o push "lead atribuído a você" e marca status/temperatura/observação. A Roleta **não é alterada** até o Hamilton autorizar a troca.

## Saída de corretor e histórico (90004, 09/10/2026) — regras combinadas com o Hamilton
- **"Não atendeu no prazo"** é um fato do **histórico do corretor** (`lead_ownership_events`): o corretor não registrou retorno no prazo e o lead passou para outra pessoa. **Não** é a etapa do funil "Não atendeu" (essa significa: o corretor tentou e o *lead* não respondeu). Hoje quem decide o prazo é a Roleta (n8n, 30 min úteis, só leads com status Novo); quando a Roleta alimentar o CRM, ela chama `fn_lead_repass(..., 'nao_atendeu_no_prazo')` para gravar o histórico. Dado de partida (planilha em 08/10): 8 de 13 leads foram repassados por falta de registro.
- **Tirar da equipe** (`fn_member_leave`, só admin; tela Rodízio de leads → Equipe): revoga o acesso e redistribui na mesma transação. Etapas com slug `novo` e `nao_atendeu` → divididas entre as `agent` ativas pelo **menor número de leads em aberto**; qualquer outra etapa em aberto (Atendeu, Visita marcada, Proposta…) → **volta para a gestora** escolhida; fechados não mudam. Organização sem essas etapas → tudo volta para a gestora (padrão seguro). Cada lead movido é gravado por UPDATE, então o novo dono recebe o push.
- A tela mostra a **prévia** (`dry_run`) antes de confirmar. API: `POST /api/v1/settings/lead-routing/members/:userId/leave`.
- **Pausar** (folga/férias) é outra ação: não revoga nem mexe nos leads.
- Conversas de WhatsApp atribuídas à pessoa que sai **não** são redistribuídas por esta função (só leads).
