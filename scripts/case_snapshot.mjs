// Retrato do Apollo e do Attio para a seção "In the tools" do case (só leitura, nada é alterado).
// Uso: node scripts/case_snapshot.mjs  → grava data/case_snapshot.json
// LGPD: só nomes públicos de canais e atributos do vetting; nada de e-mail ou telefone.

import { readFileSync, writeFileSync } from "node:fs";
import { attio } from "./attio_api.mjs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const APOLLO = env.match(/^APOLLO_API_KEY=(.+)$/m)?.[1].trim();
const apollo = async (method, path, body) => {
  const res = await fetch(`https://api.apollo.io/api/v1/${path}`, {
    method, headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO }, body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};
const SEQUENCIAS = ["6adb83c59b95b90010290549", "6adb83c69b95b90010290565", "6adb83c8d6d1450021c6aba9", "6adb8a836d529000107293c5"]; // YouTube, Newsletter, LinkedIn, call de onboarding
const DEAL_W1 = "46067b65-c2dd-47ff-b8db-6a31bc68e908";
const semHtml = (s) => String(s ?? "").replace(/<li>/g, " • ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Apollo: as sequências-modelo (uma por plataforma), passo a passo, e os campos personalizados
const sequencias = [];
for (const id of SEQUENCIAS) {
  const seq = await apollo("GET", `emailer_campaigns/${id}`);
  const camp = seq.emailer_campaign ?? {};
  const templates = Object.fromEntries((seq.emailer_templates ?? []).map((t) => [t.id, t]));
  const toques = seq.emailer_touches ?? [];
  let dia = 0;
  const passos = (seq.emailer_steps ?? []).sort((a, b) => a.position - b.position).map((s) => {
    dia += s.wait_time ?? 0;
    const t = templates[toques.find((x) => x.emailer_step_id === s.id)?.emailer_template_id] ?? {};
    return { position: s.position, day: dia, type: s.type, subject: t.subject || null, text: semHtml(t.body_html).slice(0, 220), note: s.note || null };
  });
  sequencias.push({ name: camp.name, active: camp.active, contacts: camp.unique_scheduled ?? 0, steps: passos });
}
const campos = (await apollo("GET", "typed_custom_fields")).typed_custom_fields
  .filter((f) => f.modality === "contact" && f.name !== "Qualify Contact").map((f) => f.name);

// Attio: pipeline, schema, um creator, o deal do W1 e uma task
const todos = async (path, body = {}) => {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const { data } = await attio("POST", path, { ...body, limit: 500, offset });
    out.push(...data);
    if (data.length < 500) return out;
  }
};
const pessoas = await todos("objects/people/records/query");
const porId = Object.fromEntries(pessoas.map((p) => [p.id.record_id, p]));
const v = (p, k) => { const x = p?.values?.[k]?.[0]; return x?.option?.title ?? x?.status?.title ?? x?.value ?? x?.full_name ?? null; };
const entradas = await todos("lists/supply_pipeline/entries/query");
const estagios = (await attio("GET", "lists/supply_pipeline/attributes/stage/statuses")).data.map((s) => s.title);
const pipeline = estagios.map((stage) => {
  const doEstagio = entradas.filter((e) => e.entry_values.stage?.[0]?.status?.title === stage).map((e) => porId[e.parent_record_id]).filter(Boolean);
  return {
    stage,
    count: doEstagio.length,
    sample: doEstagio.sort((a, b) => (v(b, "final_score") ?? 0) - (v(a, "final_score") ?? 0)).slice(0, 3)
      .map((p) => ({ name: v(p, "name"), platform: v(p, "platform"), category: v(p, "passionfroot_category"), score: v(p, "final_score") })),
  };
});
const schema = async (alvo) => (await attio("GET", `${alvo}/attributes`)).data
  .filter((a) => !a.is_system_attribute && !["entry_id", "created_at", "created_by"].includes(a.api_slug))
  .map((a) => ({ title: a.title, type: a.type }));
const exemplo = pessoas.find((p) => v(p, "name") === "Arena Ambiental");
const CAMPOS_EXEMPLO = ["platform", "main_link", "passionfroot_category", "audience", "final_score", "passionfroot_fit", "verdict", "decided_by", "rate_card_usd", "batch", "vetting_rationale", "content_summary"];
const deal = (await attio("GET", `objects/deals/records/${DEAL_W1}`)).data;
const notaDeal = (await attio("GET", `notes?parent_object=deals&parent_record_id=${DEAL_W1}`)).data[0];
const tarefa = (await attio("GET", "tasks?limit=50")).data.find((t) => !t.is_completed && t.content_plaintext.startsWith("Decide:"));

// Mapa de gaps: aprovados por categoria, separando público B2B (fit ≥ 3,5) de estudantes e início de carreira
const aprovados = pessoas.filter((p) => v(p, "verdict") === "Approved");
const gaps = [...new Set(aprovados.map((p) => v(p, "passionfroot_category")).filter(Boolean))].map((category) => {
  const da = aprovados.filter((p) => v(p, "passionfroot_category") === category);
  return { category, approved: da.length, b2b: da.filter((p) => (v(p, "passionfroot_fit") ?? 0) >= 3.5).length };
}).sort((a, b) => b.approved - a.approved);

const snapshot = {
  taken_at: new Date().toISOString(),
  gaps,
  apollo: { sequences: sequencias, custom_fields: campos },
  attio: {
    creators: pessoas.filter((p) => v(p, "creator_id")).length,
    pipeline,
    schema: { people: await schema("objects/people"), deals: await schema("objects/deals"), list: await schema("lists/supply_pipeline") },
    example_creator: { name: v(exemplo, "name"), values: Object.fromEntries(CAMPOS_EXEMPLO.map((k) => [k, v(exemplo, k)])) },
    deal: {
      name: v(deal, "name"), stage: deal.values.stage?.[0]?.status?.title, value: deal.values.value?.[0]?.currency_value,
      budget: v(deal, "budget_usd"), categories: deal.values.target_categories?.map((o) => o.option.title), brief_source: v(deal, "brief_source"),
      people: deal.values.associated_people?.length, note_title: notaDeal?.title, note_head: notaDeal?.content_plaintext?.split("\n").slice(0, 9),
    },
    task: tarefa ? { content: tarefa.content_plaintext, deadline: tarefa.deadline_at?.slice(0, 10) } : null,
  },
};
writeFileSync(new URL("../data/case_snapshot.json", import.meta.url), JSON.stringify(snapshot, null, 1));
console.log(`snapshot: ${snapshot.attio.creators} creators, ${pipeline.map((s) => s.stage + " " + s.count).join(", ")} | sequências: ${sequencias.map((s) => s.steps.length).join("/")} passos | campos Apollo: ${campos.length}`);
