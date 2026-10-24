// Monta o schema do supply no Attio. Idempotente: só cria o que ainda não existe.
// Uso: node scripts/attio_setup.mjs
// People = creators (atributos do vetting); lista "Supply pipeline" = estágios do funil;
// Deals = briefs de campanha (numa integração real, viriam da plataforma da Passionfroot).

import { attio } from "./attio_api.mjs";
import { CATEGORIAS_EN } from "./rubric.mjs";

// O schema fica em inglês (é o que o recrutador vê); a rubrica e os CSVs seguem em PT

const PEOPLE = [
  // O Attio não aceita atributo único em People neste plano; o attio_sync.mjs deduplica pelo creator_id
  { api_slug: "creator_id", title: "Creator ID", type: "text", description: "yt:<channel>, li:<profile> or nl:<publication>" },
  { api_slug: "platform", title: "Platform", type: "select", options: ["YouTube", "LinkedIn", "Newsletter"] },
  { api_slug: "market", title: "Market", type: "select", options: ["Brazil", "United States"] },
  { api_slug: "main_link", title: "Main link", type: "text" },
  { api_slug: "passionfroot_category", title: "Passionfroot category", type: "select", options: Object.values(CATEGORIAS_EN) },
  { api_slug: "audience", title: "Audience", type: "number", description: "Subscribers, followers or newsletter subscribers" },
  { api_slug: "final_score", title: "Final score", type: "number", description: "0 to 100; cut-off 60" },
  { api_slug: "passionfroot_fit", title: "Passionfroot fit", type: "number", description: "1 to 5" },
  { api_slug: "verdict", title: "Verdict", type: "select", options: ["Approved", "Dispute", "Rejected"] },
  { api_slug: "decided_by", title: "Decided by", type: "select", options: ["Jev + Claude agree", "Jev + Claude average", "Jev only", "Michel"] },
  { api_slug: "rate_card_usd", title: "Rate card (US$)", type: "number", description: "Passionfroot price band by audience size (YouTube)" },
  { api_slug: "vetting_rationale", title: "Vetting rationale", type: "text" },
  { api_slug: "dispute_reason", title: "Dispute reason", type: "text" },
  { api_slug: "batch", title: "Sourcing batch", type: "text" },
  { api_slug: "content_summary", title: "Content summary", type: "text", description: "Bio or channel description plus recent titles, in the creator's own language. Used to rank creators against a brief" },
];
const DEALS = [
  { api_slug: "product", title: "Product", type: "text" },
  { api_slug: "budget_usd", title: "Budget (US$)", type: "number" },
  { api_slug: "target_categories", title: "Target categories", type: "select", is_multiselect: true, options: Object.values(CATEGORIAS_EN) },
  { api_slug: "brief_source", title: "Brief source", type: "select", options: ["Passionfroot platform", "Hypothetical (case study)"] },
];
const LISTA = { api_slug: "supply_pipeline", name: "Supply pipeline" };
const ESTAGIOS = ["Sourced", "Vetted", "Ready for outreach", "Contacted", "Replied", "Call", "Signed up", "Campaign-ready", "Rejected"];

async function garantirAtributos(alvo, defs) {
  const existentes = new Set((await attio("GET", `${alvo}/attributes`)).data.map((a) => a.api_slug));
  for (const d of defs) {
    if (!existentes.has(d.api_slug)) {
      const { options, ...resto } = d;
      await attio("POST", `${alvo}/attributes`, { data: {
        description: null, is_required: false, is_unique: false, is_multiselect: false, config: {}, ...resto,
      } });
      console.log(`criado ${alvo} → ${d.api_slug}`);
    }
    if (!d.options) continue;
    const opcoes = new Set((await attio("GET", `${alvo}/attributes/${d.api_slug}/options`)).data.map((o) => o.title));
    for (const titulo of d.options.filter((o) => !opcoes.has(o))) {
      await attio("POST", `${alvo}/attributes/${d.api_slug}/options`, { data: { title: titulo } });
    }
  }
}

await garantirAtributos("objects/people", PEOPLE);
await garantirAtributos("objects/deals", DEALS);

const listas = (await attio("GET", "lists")).data;
if (!listas.some((l) => l.api_slug === LISTA.api_slug)) {
  await attio("POST", "lists", { data: { ...LISTA, parent_object: "people", workspace_access: "full-access", workspace_member_access: [] } });
  console.log("criada a lista Supply pipeline");
}
await garantirAtributos(`lists/${LISTA.api_slug}`, [
  { api_slug: "stage", title: "Stage", type: "status" },
  { api_slug: "rejection_reason", title: "Rejection reason", type: "text" },
]);
const estagios = new Set((await attio("GET", `lists/${LISTA.api_slug}/attributes/stage/statuses`)).data.map((s) => s.title));
for (const e of ESTAGIOS.filter((e) => !estagios.has(e))) {
  await attio("POST", `lists/${LISTA.api_slug}/attributes/stage/statuses`, { data: { title: e } });
}
console.log("schema do Attio pronto");
