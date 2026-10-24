// Prepara o Apollo para o outreach com creators, sempre no nome do Michel.
// Uso: node scripts/apollo_setup.mjs
// 1. Campos personalizados no contato (plataforma, categoria, nota, link, preço, id no Attio)
// 2. Preenche esses campos nos contatos já criados (data/apollo_contatos_*.json)
// 3. Cria as sequências-modelo de recrutamento em inglês (YouTube, Newsletter, LinkedIn), INATIVAS (demonstração, nunca
//    enviadas), e arquiva as versões antigas.
// Idempotente: não recria campo nem sequência que já existem.

import { readFileSync, readdirSync } from "node:fs";
import { attio } from "./attio_api.mjs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^APOLLO_API_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error("APOLLO_API_KEY não encontrada no .env");
async function apollo(method, path, body) {
  const res = await fetch(`https://api.apollo.io/api/v1/${path}`, {
    method, headers: { "Content-Type": "application/json", "X-Api-Key": KEY }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");
const semBarra = (u) => u.replace(/\/+$/, "");

// 1. Campos personalizados (em inglês; os que nasceram em PT são renomeados)
const CAMPOS = [
  { label: "Platform", type: "string", antes: "Plataforma" },
  { label: "Passionfroot category", type: "string", antes: "Categoria Passionfroot" },
  { label: "Vetting score", type: "number", antes: "Nota do vetting" },
  { label: "Creator link", type: "string", antes: "Link do creator" },
  { label: "Estimated rate (US$)", type: "number", antes: "Preço estimado (US$)" },
  { label: "Attio record ID", type: "string" },
];
const existentes = Object.fromEntries((await apollo("GET", "typed_custom_fields")).typed_custom_fields
  .filter((f) => f.modality === "contact").map((f) => [f.name, f.id]));
for (const c of CAMPOS.filter((c) => !existentes[c.label] && existentes[c.antes])) {
  await apollo("PUT", `typed_custom_fields/${existentes[c.antes]}`, { name: c.label });
  existentes[c.label] = existentes[c.antes];
  console.log("campo renomeado:", c.antes, "→", c.label);
}
for (const c of CAMPOS.filter((c) => !existentes[c.label])) {
  const r = await apollo("POST", "fields", { label: c.label, modality: "contact", type: c.type });
  existentes[c.label] = r.typed_custom_fields?.[0]?.id ?? r.field?.id;
  console.log("campo criado:", c.label);
}

// 2. Preenche os contatos com o que está no Attio (fonte da verdade do supply)
const attioPorLink = new Map();
for (let offset = 0; ; offset += 500) {
  const { data } = await attio("POST", "objects/people/records/query", { limit: 500, offset, filter: { platform: "LinkedIn" } });
  for (const p of data) attioPorLink.set(semBarra(p.values.main_link?.[0]?.value ?? ""), p);
  if (data.length < 500) break;
}
let atualizados = 0;
for (const f of readdirSync(dataDir).filter((f) => /^apollo_contatos_.+\.json$/.test(f))) {
  for (const [link, c] of Object.entries(JSON.parse(read(f)))) {
    const p = attioPorLink.get(semBarra(link));
    if (!p) { console.log("sem registro no Attio:", c.nome); continue; }
    const v = (k) => p.values[k]?.[0];
    await apollo("PUT", `contacts/${c.apollo_contact_id}`, {
      linkedin_url: link,
      typed_custom_fields: {
        [existentes["Platform"]]: v("platform")?.option?.title,
        [existentes["Passionfroot category"]]: v("passionfroot_category")?.option?.title,
        [existentes["Vetting score"]]: v("final_score")?.value,
        [existentes["Creator link"]]: link,
        [existentes["Estimated rate (US$)"]]: v("rate_card_usd")?.value,
        [existentes["Attio record ID"]]: p.id.record_id,
      },
    });
    atualizados++;
  }
}
console.log("contatos atualizados:", atualizados);

// 3. Sequências-modelo de recrutamento, uma por plataforma, escritas como se o Michel fosse da Passionfroot, em inglês
// (é o que o recrutador lê). O Apollo não ramifica dentro de uma sequência, então o W2 escolhe pela plataforma do creator.
// É só demonstração para o case: ficam INATIVAS, sem contatos e sem caixa de e-mail conectada. Nunca ativar.
// Cada passo traz algo novo: preço estimado, rascunho do media kit, história de creator da galeria, campanha aberta.
// Sem ligação fria (LGPD e costume no Brasil); a call de onboarding é só para os maiores creators, depois do cadastro.
// Versões antigas são arquivadas depois que as novas existem.
const ANTIGAS = [
  "Creator · conversa de pesquisa (Michel)",
  "[MODELO — não enviar] Passionfroot · recrutamento de creators B2B",
  "[TEMPLATE — do not send] Passionfroot · B2B creator recruiting",
];
const seqs = (await apollo("POST", "emailer_campaigns/search", { per_page: 50 })).emailer_campaigns.filter((s) => !s.archived);
const email = (subject, body_html, type = "new_thread") => [{
  type, status: "to_be_reviewed", include_signature: true, emailer_template: { subject, body_html },
}];
const resposta = (body_html) => email("", body_html, "reply_to_thread");
// Passos do LinkedIn levam o texto da mensagem como template
const linkedin = (texto) => [{ type: "new_thread", status: "to_be_reviewed", include_signature: false,
  emailer_template: { subject: "", body_html: `<p>${texto}</p>` } }];
// [entre colchetes] = personalização que vem da Clay (post recente) ou do Attio (público, categoria, preço estimado pelo guardrail).
// Numa operação real, os textos iriam em PT-BR para creators brasileiros; [market] = Brazil ou the US, pelo campo market do Attio.
const OPCOES = "<p>Two ways to start, whichever is easier: set up your page here [sign-up link] and I'll review it within a day, or reply \"call\" and I'll walk you through it in 15 minutes.</p>";
// LGPD: o primeiro contato diz de onde veio o contato e oferece saída em uma linha
const SAIDA = (onde) => `<p>I found your business email ${onde}. Not interested? Reply "no" and I will delete your contact.</p>`;
const COMO = "<p>How it works: you get a free page with your formats and prices, brands book and pay you through it, and there is no fee on deals you bring yourself.</p>";
const DM_INSTAGRAM = { type: "action_item", wait_time: 3, wait_mode: "day", priority: "medium",
  note: "Instagram DM, only if the creator lists a business Instagram on the channel. Text: \"Hi [first name]! Michel from Passionfroot. I emailed you about B2B brands for [channel]. Easier to talk here?\" One message, no follow-up DM." };
const SEQUENCIAS = [
  {
    name: "[TEMPLATE — do not send] Passionfroot · YouTube creators",
    emailer_steps: [
      { type: "auto_email", wait_time: 0, wait_mode: "day", emailer_touches: email(
        "[channel name] × B2B brands",
        "<p>Hi {{first_name}},</p><p>I'm Michel, I recruit creators for Passionfroot, where B2B brands book creators directly. I watched [recent video] and [one specific point from it].</p><p>Your viewers are who B2B brands pay to reach: [audience from vetting, e.g. plant managers and engineers]. Channels your size usually price an integration around US$ [estimated rate], and brands are actively looking for creators in [market].</p>" + COMO + OPCOES + SAIDA("in your channel description")) },
      { type: "auto_email", wait_time: 3, wait_mode: "day", emailer_touches: resposta(
        "<p>Hi {{first_name}}, to make it concrete, I mocked up what your media kit could look like with your public numbers (attached): [formats, e.g. integration and dedicated video], starting at US$ [estimated rate]. You would only need to check the prices and publish. Want the link to set it up?</p>") },
      DM_INSTAGRAM,
      { type: "auto_email", wait_time: 3, wait_mode: "day", emailer_touches: resposta(
        "<p>Hi {{first_name}}, one example that may help: [creator from the Passionfroot gallery in the same category] and how they [result from their creator story]: [story link]. Brands keep asking us for [category] creators in Brazil, and there are still few of them on the platform.</p>") },
      { type: "auto_email", wait_time: 4, wait_mode: "day", emailer_touches: resposta(
        "<p>Hi {{first_name}}, last note from me. [Brand in your category] has an open campaign for creators like you until [date]; with a page set up, you can apply in one click: [sign-up link]. If now is not the time, no problem, I'll check back in a few months.</p>") },
    ],
  },
  {
    name: "[TEMPLATE — do not send] Passionfroot · Newsletter creators",
    emailer_steps: [
      { type: "auto_email", wait_time: 0, wait_mode: "day", emailer_touches: email(
        "Sponsors for [newsletter name]",
        "<p>Hi {{first_name}},</p><p>I'm Michel, I recruit creators for Passionfroot, where B2B brands book newsletter slots directly. I read [recent issue] and [one specific point from it].</p><p>Your readers are who B2B brands pay to reach: [audience from vetting]. Newsletters your size usually price a sponsored slot around US$ [estimated rate], and brands like that a newsletter gets read in full.</p>" + COMO + OPCOES + SAIDA("on your newsletter's about page")) },
      { type: "auto_email", wait_time: 3, wait_mode: "day", emailer_touches: resposta(
        "<p>Hi {{first_name}}, I mocked up your media kit with your public numbers (attached): a sponsored slot and a dedicated issue, starting at US$ [estimated rate]. You would only need to check the prices and publish. Want the link to set it up?</p>") },
      { type: "linkedin_step_connect", wait_time: 3, wait_mode: "day", priority: "medium", note: "Only if the newsletter links to the author's LinkedIn. No pitch in the note.",
        emailer_touches: linkedin("Hi {{first_name}}! I read [newsletter name] and wrote to you by email about B2B sponsors. Happy to connect.") },
      { type: "auto_email", wait_time: 3, wait_mode: "day", emailer_touches: resposta(
        "<p>Hi {{first_name}}, one example that may help: [newsletter writer from the Passionfroot gallery] and how they [result from their creator story]: [story link]. Brands keep asking us for [category] newsletters in Brazil.</p>") },
      { type: "auto_email", wait_time: 4, wait_mode: "day", emailer_touches: resposta(
        "<p>Hi {{first_name}}, last note from me. [Brand in your category] has an open campaign for newsletters like yours until [date]; with a page set up, you can apply in one click: [sign-up link]. If now is not the time, I'll check back in a few months.</p>") },
    ],
  },
  {
    name: "[TEMPLATE — do not send] Passionfroot · LinkedIn creators",
    emailer_steps: [
      { type: "linkedin_step_view_profile", wait_time: 0, wait_mode: "day", priority: "medium",
        note: "View the profile and react to a recent post, so the creator sees who is reaching out.", emailer_touches: linkedin("View profile") },
      { type: "linkedin_step_connect", wait_time: 1, wait_mode: "day", priority: "high", note: "Short note, no pitch.",
        emailer_touches: linkedin("Hi {{first_name}}! Your post on [recent post topic] was spot on. I work with B2B creators at Passionfroot, happy to connect.") },
      { type: "linkedin_step_message", wait_time: 2, wait_mode: "day", priority: "high", note: "Only if the connection was accepted.",
        emailer_touches: linkedin("Thanks for connecting, {{first_name}}! Quick one: B2B brands book LinkedIn creators through Passionfroot, and your audience of [audience from vetting] is who they ask for. Creators with your reach usually price a post around US$ [estimated rate]. Free page, no fee on deals you bring yourself. Want me to send the link, or show you in 15 minutes? If it is not for you, just say so.") },
      { type: "linkedin_step_message", wait_time: 4, wait_mode: "day", priority: "medium", note: "Only if there was no reply.",
        emailer_touches: linkedin("{{first_name}}, I mocked up what your media kit could look like with your numbers: [image]. Sponsored post and newsletter mention, starting at US$ [estimated rate]. Takes 10 minutes to publish if you like it.") },
      { type: "linkedin_step_message", wait_time: 5, wait_mode: "day", priority: "low", note: "Last touch. No reply: Rejected with reason \"no reply\", back in the queue in 90 days.",
        emailer_touches: linkedin("Last one from me, {{first_name}}: [brand in your category] has an open campaign for creators like you until [date]. If now is not the time, no problem, I'll check back in a few months.") },
    ],
  },
  // Call de onboarding: só os maiores creators, depois do cadastro (Signed up → Call → Campaign-ready), como a vaga descreve.
  // Não é passo de prospecção; o telefone ou link é o que o creator deu ao marcar.
  {
    name: "[TEMPLATE — do not send] Passionfroot · Onboarding call",
    emailer_steps: [
      { type: "auto_email", wait_time: 0, wait_mode: "day", emailer_touches: email(
        "Your Passionfroot page: 15 minutes to make it campaign-ready",
        "<p>Hi {{first_name}},</p><p>Great to see your page on Passionfroot. For creators with an audience like yours, I do a 15-minute call to get the page ready for brands:</p><ul><li>your formats and a price for each, based on your real reach</li><li>slots per month, lead time and the categories you won't take</li><li>what happens next: fees, how bookings come in, what brands expect</li></ul><p>Pick a time here: [calendar link]. You leave the call with the page ready for the next brief in [category].</p>") },
      { type: "auto_email", wait_time: 2, wait_mode: "day", emailer_touches: resposta(
        "<p>Hi {{first_name}}, a quick nudge: [brand in your category] has a brief open until [date], and a ready page is what gets you in. If the calendar doesn't fit, reply with two times that work for you.</p>") },
      { type: "call", wait_time: 1, wait_mode: "day", priority: "high",
        note: "The onboarding call, on the booked date (move this step to the booking). 15 minutes, script in the playbook: open, three questions, sell, set up the page live, clear expectations, close with a referral ask. Use only the phone or meeting link the creator gave when booking (LGPD). After: Attio Campaign-ready, or Signed up with a task in 3 days." },
      { type: "action_item", wait_time: 14, wait_mode: "day", priority: "medium",
        note: "Day-14 check-in: any booking yet? Are prices and availability current? Update the rate card in Attio with the real price." },
    ],
  },
];
const schedule = (await apollo("GET", "emailer_schedules")).emailer_schedules.find((s) => s.default);
for (const s of SEQUENCIAS) {
  const existe = seqs.find((x) => x.name === s.name);
  if (existe) { console.log("sequência já existe:", s.name, existe.id); continue; }
  const r = await apollo("POST", "sequences", {
    name: s.name,
    active: false,
    emailer_schedule_id: schedule.id,
    label_names: ["Creator Supply", "Template"],
    mark_finished_if_reply: true,
    mark_finished_if_interested: true,
    mark_paused_if_ooo: true,
    max_emails_per_day: 20,
    emailer_steps: s.emailer_steps,
  });
  console.log("sequência-modelo criada (inativa):", s.name, r.emailer_campaign?.id, "| passos:", r.emailer_steps?.length);
}
// Arquiva as antigas só depois de criar as novas
for (const s of seqs.filter((s) => ANTIGAS.includes(s.name))) {
  await apollo("POST", `emailer_campaigns/${s.id}/archive`);
  console.log("sequência arquivada:", s.name);
}
