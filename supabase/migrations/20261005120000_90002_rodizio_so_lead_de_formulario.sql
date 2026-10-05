-- manifest: **Rodízio de leads: o gatilho passa a valer só para lead de formulário (`source = 'webhook'`).** A regra por funil ou por campanha também casava o lead que nasce de uma CONVERSA de WhatsApp (`source = 'whatsapp'`): com o rodízio de conversas ligado, o lead iria para um atendente do grupo e a conversa da mesma pessoa para outro. Agora o `WHEN` do gatilho exige `new.source = 'webhook'`, que é o lead criado por `POST /api/v1/webhooks/in/[token]` (Meta Lead Ads, Elementor, RD Station, Respondi...) — o único que não tem conversa. Aditiva e idempotente: recria só o gatilho `trg_lead_routing_on_insert`.
-- 90002: restringe o rodízio de leads de grupo ao lead de formulário.
--
-- POR QUÊ. Objeção levantada na revisão do PR upstream (melgarafael/DeskcommCRM#2269,
-- ponto 3): `fn_nascer_lead_da_conversa` cria o lead SEM dono a partir da conversa, e
-- a regra por funil (`pipeline`) ou por campanha (`utm_campaign`, copiada do contato)
-- o pegaria. Se a organização usa o rodízio de CONVERSA (`round_robin`), o lead iria
-- para um atendente do grupo e a conversa da mesma pessoa para outro.
--
-- MEDIDO na produção (v1.20.0): `crm_leads.source` é `webhook` para o lead que entra
-- por formulário e `whatsapp` para o que nasce da conversa. Restringir o gatilho a
-- `source = 'webhook'` separa os dois mundos pela própria origem, sem depender do que
-- a regra casa. O rodízio de conversa continua sendo o dono do lead de conversa.
--
-- O `WHEN` fica no gatilho (e não dentro da função) para que lead de outra origem
-- nem entre na função: custo zero para o caminho quente das conversas.

drop trigger if exists trg_lead_routing_on_insert on public.crm_leads;
create trigger trg_lead_routing_on_insert
  after insert on public.crm_leads
  for each row
  when (new.owner_user_id is null and new.owner_agent_id is null
        and new.status = 'open' and new.source = 'webhook')
  execute function public.fn_lead_routing_on_insert();
