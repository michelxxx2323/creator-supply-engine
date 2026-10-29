// Gera os workflows do n8n em JSON, para importar em Workflows → Import from file
// (o trial do n8n Cloud não libera a API pública, então não dá para criar pela API).
// Uso: node scripts/n8n_workflows.mjs   → grava n8n/w1_brief_shortlist.json e n8n/w2_outreach_sync.json
// Credenciais (criadas no n8n, nunca no JSON), todas Header Auth: "Attio" (Authorization = Bearer <chave>),
// "Apollo" (X-Api-Key), "Anthropic" (x-api-key), "Jev" (Authorization = Bearer <chave da TypeSafe>),
// "YouTube" (X-goog-api-key).
// Tudo que aparece no n8n (nós, formulário, código, prompt) fica em inglês: é o que o recrutador vê.
// Etapa A = W1 (brief → shortlist). Etapa B = W3 (sourcing + duplo vetting → Attio) e W2 (Attio → outreach no Apollo).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import {
  CATEGORIAS, CATEGORIAS_EN, GATES, RED_FLAGS, CRITERIA, NEWSLETTER, OBJECTIVE, PESADOS, APROVACAO_MINIMA, FIT_MINIMO,
  perguntasJev, notaEngajamento, notaConsistencia, notaEngajamentoNewsletter, MERCADOS,
} from "./rubric.mjs";

const ATTIO_OWNER = "9fbc6ada-b757-46cc-923f-6e940271cdb6"; // membro do workspace do Attio (o Michel)
// Sequências-modelo de recrutamento, uma por plataforma (demonstração: o W2 não deve ser ativado)
const APOLLO_SEQUENCIAS = { YouTube: "6adb83c59b95b90010290549", Newsletter: "6adb83c69b95b90010290565", LinkedIn: "6adb83c8d6d1450021c6aba9" };
// Expressão do n8n que escolhe a sequência pela plataforma do creator no Attio
const SEQUENCIA_DO_CREATOR = `(${JSON.stringify(APOLLO_SEQUENCIAS)})[$('Attio · get creator').item.json.data.values.platform[0].option.title]`;
const PLATAFORMAS = ["YouTube", "LinkedIn", "Newsletter"];
// Descrição de cada categoria para o prompt (os nomes são as opções do Attio)
const CATEGORIAS_DESC = {
  "Marketing & Design": "marketing, sales, growth, branding, social media, content creation, design and UX",
  "Productivity & Personal Development": "productivity, organization, studying, habits, reading and personal development",
  "Tech & Business": "programming, software, data, product, entrepreneurship, management, leadership and business",
  "AI": "artificial intelligence: tools, agents and AI automations",
  "Finance & Investing": "personal finance, investing, economics, accounting and corporate finance",
  "Health": "health, medicine, nutrition, mental health and exercise",
  "Career": "careers, jobs, interviews, LinkedIn, HR and the job market",
  "Other": "none of the above, such as entertainment, games, lifestyle or consumer",
};
if (Object.keys(CATEGORIAS_DESC).join() !== Object.values(CATEGORIAS_EN).join()) throw new Error("CATEGORIAS_DESC fora de sincronia com CATEGORIAS_EN");

const cred = (nome) => ({ httpHeaderAuth: { id: "", name: nome } });
// lote: chamadas por segundo; continuar: erro vira item com .error e o fluxo segue (mantém o pareamento por índice)
// completo: devolve { statusCode, headers, body } e não trata 4xx/5xx como erro (para diagnosticar bloqueios)
const http = (nome, pos, { method = "GET", url, credencial, body, query, headers, timeout, lote, continuar, repetir, sempre, desligado, completo }) => ({
  name: nome, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: pos,
  parameters: {
    method, url,
    ...(credencial ? { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" } : {}),
    ...(query ? { sendQuery: true, queryParameters: { parameters: query } } : {}),
    ...(headers ? { sendHeaders: true, headerParameters: { parameters: headers } } : {}),
    ...(body ? { sendBody: true, specifyBody: "json", jsonBody: body } : {}),
    options: {
      ...(timeout ? { timeout } : {}),
      ...(lote ? { batching: { batch: { batchSize: lote, batchInterval: 1000 } } } : {}),
      ...(completo ? { response: { response: { fullResponse: true, neverError: true } } } : {}),
    },
  },
  ...(credencial ? { credentials: cred(credencial) } : {}),
  ...(continuar ? { onError: "continueRegularOutput" } : {}),
  ...(repetir ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 } : {}),
  ...(sempre ? { alwaysOutputData: true } : {}),
  ...(desligado ? { disabled: true } : {}),
});
const code = (nome, pos, js) => ({ name: nome, type: "n8n-nodes-base.code", typeVersion: 2, position: pos, parameters: { jsCode: js } });
// Nó de código a partir de uma função de verdade (sem escapar regex em string); as constantes entram no topo
const corpo = (fn, consts = {}) => [
  ...Object.entries(consts).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`),
  fn.toString().replace(/^[^{]*\{\r?\n?/, "").replace(/\}\s*$/, "").replace(/^ {2}/gm, ""),
].join("\n");
// fns: funções puras do rubric.mjs que o nó usa (vão com o mesmo código)
const codeFn = (nome, pos, fn, consts, fns = []) => code(nome, pos, [...fns.map(String), corpo(fn, consts)].join("\n"));
const nota = (nome, pos, texto, [width, height] = [420, 260]) => ({
  name: nome, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position: pos, parameters: { content: texto, width, height },
});
const liga = (...nomes) => Object.fromEntries(nomes.slice(0, -1).map((n, i) => [n, { main: [[{ node: nomes[i + 1], type: "main", index: 0 }]] }]));
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const CLAUDE_HEADERS = [
  { name: "anthropic-version", value: "2026-10-21" },
  { name: "anthropic-beta", value: "server-side-fallback-2026-07-01" },
];

// ---------- W1 · Brief → shortlist ----------
// Duas chamadas ao Claude: (1) brief → critérios de busca; (2) nota de 0 a 10 de cada candidato contra o brief.
// O tamanho da shortlist sai do orçamento, não do Claude: enche até o orçamento menos a reserva, como na etapa 1.
const MIN_BRIEF_FIT = 6; // abaixo disso o creator não entra, mesmo sobrando orçamento
const RESERVA = 0.1; // 10% do orçamento fica de reserva
const MAX_CREATORS = 25;
// Quantos aprovados do Attio vão para o ranqueamento. Com 150, quem tinha nota de vetting menor nem era avaliado contra o brief
// (no teste da ElevenLabs, 297 batiam com os critérios). 400 cabe numa consulta do Attio (máx. 500) e no prompt do Claude.
const MAX_CANDIDATOS = 400;

const schemaCriterios = {
  type: "object", additionalProperties: false,
  required: ["categories", "platforms", "min_fit", "ideal_creator", "rationale", "content_angle"],
  properties: {
    categories: { type: "array", items: { type: "string", enum: Object.keys(CATEGORIAS_DESC) } },
    platforms: { type: "array", items: { type: "string", enum: PLATAFORMAS } },
    min_fit: { type: "number" },
    ideal_creator: { type: "string" },
    rationale: { type: "string" },
    content_angle: { type: "string" },
  },
};
const SYSTEM_CRITERIOS = [
  "You turn a B2B brand's campaign request into criteria for finding creators in the brief's target market (Brazil or the United States) in Passionfroot's vetted supply.",
  `Available categories: ${Object.entries(CATEGORIAS_DESC).map(([k, v]) => `${k} (${v})`).join("; ")}.`,
  "Pick 1 to 3 categories whose audience the brand wants to reach. Use the requested platforms; if none are given, use all three.",
  "min_fit: 3.5 when the target audience is professionals or buyers; 3 when it is students or early-career people.",
  "ideal_creator: one sentence describing the creator whose content best matches this product, specific enough to rank candidates against.",
  "Write ideal_creator, rationale and content_angle in English, one or two sentences each.",
].join("\n");

const schemaRanking = {
  type: "object", additionalProperties: false, required: ["ranking"],
  properties: { ranking: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["id", "brief_fit", "reason"],
    properties: { id: { type: "string" }, brief_fit: { type: "integer" }, reason: { type: "string" } },
  } } },
};
const SYSTEM_RANKING = [
  "You rank B2B creators from one market against one campaign brief. Each candidate has already passed Passionfroot's quality vetting; your only job is how well their content matches this brief.",
  "Score every candidate from 0 to 10 for brief_fit:",
  "9-10: they regularly cover the product's exact topic for the brief's target audience.",
  "6-8: their audience is the target and the product fits naturally into their content.",
  "3-5: right audience, but the product would be a stretch for their content.",
  "0-2: no real fit.",
  "Judge from the content summary (bio or channel description plus recent titles, in Portuguese or English), not from fame or audience size.",
  "reason: at most 15 words, in English. Return every candidate exactly once, using its id.",
].join("\n");

const BRIEF = "Brand brief";
const w1 = {
  name: "Creator Supply Engine · Brief → shortlist",
  nodes: [
    {
      name: BRIEF, type: "n8n-nodes-base.formTrigger", typeVersion: 2.2, position: [0, 0],
      parameters: {
        formTitle: "Campaign brief",
        formDescription: "In a real integration this brief would come from the Passionfroot platform. For the case study it is a form.",
        formFields: { values: [
          { fieldLabel: "Brand domain", placeholder: "elevenlabs.io", requiredField: true },
          { fieldLabel: "Target market", fieldType: "dropdown", requiredField: true,
            fieldOptions: { values: Object.values(MERCADOS).map((m) => ({ option: m.nome })) } },
          { fieldLabel: "Product", requiredField: true },
          { fieldLabel: "Brief", fieldType: "textarea", requiredField: true },
          { fieldLabel: "Budget (US$)", fieldType: "number", requiredField: true },
          { fieldLabel: "Platforms", fieldType: "dropdown", multiselect: true,
            fieldOptions: { values: PLATAFORMAS.map((option) => ({ option })) } },
        ] },
        responseMode: "lastNode",
        options: {},
      },
      webhookId: "creator-supply-brief",
    },
    http("Apollo · company data", [220, 0], {
      // Aceita "https://www.marca.com/algo": fica só "marca.com". Se o Apollo não reconhecer, o fluxo segue sem dados da empresa
      url: "https://api.apollo.io/api/v1/organizations/enrich", credencial: "Apollo", continuar: true,
      query: [{ name: "domain", value: "={{ $json['Brand domain'].trim().toLowerCase().split('//').pop().split('/')[0].replace('www.', '') }}" }],
    }),
    // O n8n lê "}}" como fim de expressão e o schema tem "}}": os corpos são montados em nós de código
    code("Build criteria request", [440, 0], `// Combine the form brief with the company data from Apollo
const brief = $('${BRIEF}').first().json;
const org = $json.organization || {};
const company = { name: org.name, industry: org.industry, employees: org.estimated_num_employees, description: org.short_description };
return [{ json: { company, request: {
  model: "claude-opus-5-5",
  max_tokens: 4000,
  fallbacks: "default",
  output_config: { effort: "low", format: { type: "json_schema", schema: ${JSON.stringify(schemaCriterios)} } },
  system: ${JSON.stringify(SYSTEM_CRITERIOS)},
  messages: [{ role: "user", content: [
    "Brand: " + brief["Brand domain"],
    "Target market: " + (brief["Target market"] || "Brazil"),
    "Company (Apollo): " + JSON.stringify(company),
    "Product: " + brief["Product"],
    "Brief: " + brief["Brief"],
    "Budget (US$): " + brief["Budget (US$)"],
    "Requested platforms: " + [].concat(brief["Platforms"] || []).join(", "),
  ].join("\\n") }],
} } }];`),
    http("Claude · brief → criteria", [660, 0], {
      method: "POST", url: "https://api.anthropic.com/v1/messages", credencial: "Anthropic",
      headers: [
        { name: "anthropic-version", value: "2026-10-21" },
        { name: "anthropic-beta", value: "server-side-fallback-2026-07-01" },
      ],
      body: "={{ JSON.stringify($json.request) }}",
    }),
    code("Criteria → Attio query", [880, 0], `// Read Claude's answer (JSON guaranteed by the schema) and build the supply query
const r = $json;
if (r.stop_reason === "refusal") throw new Error("Claude declined the brief: " + JSON.stringify(r.stop_details));
const criteria = JSON.parse(r.content.find((b) => b.type === "text").text);
// Only creators from the brief's market (the ElevenLabs case study is a Brazilian campaign)
const market = $('${BRIEF}').first().json["Target market"] || "Brazil";
const filter = { $and: [
  { verdict: "Approved" },
  { market },
  { passionfroot_fit: { $gte: criteria.min_fit } },
  { $or: criteria.categories.map((c) => ({ passionfroot_category: c })) },
  { $or: criteria.platforms.map((p) => ({ platform: p })) },
] };
return [{ json: { criteria, query: { limit: ${MAX_CANDIDATOS}, filter, sorts: [{ attribute: "final_score", direction: "desc" }] } } }];`),
    http("Attio · query vetted supply", [1100, 0], {
      method: "POST", url: "https://api.attio.com/v2/objects/people/records/query", credencial: "Attio",
      body: "={{ JSON.stringify($json.query) }}",
    }),
    code("Build ranking request", [1320, 0], `// Every matching creator goes to Claude with a short id and a content summary
const { criteria } = $('Criteria → Attio query').first().json;
const brief = $('${BRIEF}').first().json;
const v = (p, k) => p.values[k]?.[0];
const candidates = $json.data.map((p, i) => ({
  id: "c" + (i + 1),
  record_id: p.id.record_id,
  name: v(p, "name")?.full_name,
  platform: v(p, "platform")?.option?.title,
  category: v(p, "passionfroot_category")?.option?.title,
  audience: v(p, "audience")?.value,
  score: v(p, "final_score")?.value,
  price: v(p, "rate_card_usd")?.value ?? 500,
  summary: [...String(v(p, "content_summary")?.value ?? "")].slice(0, 400).join(""),
}));
if (!candidates.length) throw new Error("No vetted creators match these criteria: open a sourcing batch.");
const list = candidates.map((c) => c.id + " · " + c.name + " · " + c.platform + " · " + c.category + " · audience " + c.audience + "\\n" + c.summary).join("\\n\\n");
return [{ json: { candidates, request: {
  model: "claude-opus-5-5",
  max_tokens: 32000,
  fallbacks: "default",
  output_config: { effort: "medium", format: { type: "json_schema", schema: ${JSON.stringify(schemaRanking)} } },
  system: ${JSON.stringify(SYSTEM_RANKING)},
  messages: [{ role: "user", content: [
    "Product: " + brief["Product"] + " (" + brief["Brand domain"] + ")",
    "Brief: " + brief["Brief"],
    "Ideal creator: " + criteria.ideal_creator,
    "Content angle: " + criteria.content_angle,
    "",
    "Candidates (" + candidates.length + "):",
    list,
  ].join("\\n") }],
} } }];`),
    http("Claude · rank against brief", [1540, 0], {
      method: "POST", url: "https://api.anthropic.com/v1/messages", credencial: "Anthropic",
      headers: [
        { name: "anthropic-version", value: "2026-10-21" },
        { name: "anthropic-beta", value: "server-side-fallback-2026-07-01" },
      ],
      body: "={{ JSON.stringify($json.request) }}",
      timeout: 600000,
    }),
    codeFn("Build Jev requests", [1760, 0], w1PedidosJev, { BRIEF_NODE: BRIEF }),
    http("Jev · brief fit", [1980, 0], {
      method: "POST", url: JEV_URL, credencial: "Jev", body: "={{ JSON.stringify($json.request) }}", lote: 5, continuar: true, repetir: true,
    }),
    codeFn("Shortlist within budget", [2200, 0], w1Shortlist, { BRIEF_NODE: BRIEF, MIN_BRIEF_FIT, RESERVA, MAX_CREATORS, ATTIO_OWNER }),
    http("Attio · create brief deal", [2420, 0], {
      method: "POST", url: "https://api.attio.com/v2/objects/deals/records", credencial: "Attio",
      body: "={{ JSON.stringify($json.deal) }}",
    }),
    code("Build rationale note", [2640, 0], `// One note on the deal with the reason for every pick, for the campaign manager
return [{ json: { deal_id: $json.data.id.record_id, request: { data: {
  parent_object: "deals",
  parent_record_id: $json.data.id.record_id,
  title: "Shortlist rationale",
  format: "markdown",
  content: $('Shortlist within budget').first().json.note,
} } } }];`),
    http("Attio · attach rationale", [2860, 0], {
      method: "POST", url: "https://api.attio.com/v2/notes", credencial: "Attio",
      body: "={{ JSON.stringify($json.request) }}",
    }),
    code("Summary", [3080, 0], `// Shown at the end of the form. Approval happens in Attio: move the deal from Lead to In Progress.
const s = $('Shortlist within budget').first().json;
return [{ json: {
  brief_in_attio: "https://app.attio.com/deals/record/" + $('Build rationale note').first().json.deal_id,
  criteria: s.criteria,
  shortlist: s.shortlist.map((c) => c.name + " · " + c.platform + " · brief fit " + c.brief_fit + "/10 (Claude " + c.claude_fit + ", Jev " + (c.jev_fit ?? "n/a") + ") · US$" + c.price),
  spend_usd: s.total_usd,
  target_usd: s.target_usd,
  matching_creators_in_supply: s.candidates,
  with_brief_fit_${MIN_BRIEF_FIT}_or_more: s.qualified,
  jev_and_claude_disagree: s.splits,
  jev_scored: s.jev_scored + " of " + s.candidates + (s.jev_first_error ? " · first Jev error: " + s.jev_first_error : ""),
  next_step: s.needs_sourcing
    ? "Budget left and no more qualified creators: flag these categories for the next sourcing run."
    : "Review the shortlist and the rationale note, then approve the deal in Attio.",
} }];`),
  ],
  connections: liga(BRIEF, "Apollo · company data", "Build criteria request", "Claude · brief → criteria", "Criteria → Attio query",
    "Attio · query vetted supply", "Build ranking request", "Claude · rank against brief", "Build Jev requests", "Jev · brief fit",
    "Shortlist within budget", "Attio · create brief deal", "Build rationale note", "Attio · attach rationale", "Summary"),
  settings: { executionOrder: "v1" },
};

// Funções dos nós de código do W1 (viram texto com toString; só usam o que o n8n oferece e as constantes injetadas)
function w1PedidosJev() {
  // Jev scores the same candidates on its own, blind to Claude's ranking
  const { candidates } = $("Build ranking request").first().json;
  const { criteria } = $("Criteria → Attio query").first().json;
  const brief = $(BRIEF_NODE).first().json;
  const clean = (s) => (typeof s === "string" && typeof s.toWellFormed === "function" ? s.toWellFormed() : s);
  const questions = { brief_fit: {
    type: "score",
    instructions: clean("How well this creator's content matches the campaign brief for " + brief["Product"] + ": " + brief["Brief"]),
    criteria: [
      "No relation to the brief's topic or target audience",
      "Same broad field, but the audience or the topic does not match the brief",
      "Right audience, but the product would be a stretch for this content",
      "Right audience, and the product fits naturally into this content",
      clean("Regularly covers exactly what the ideal creator does: " + criteria.ideal_creator),
    ],
  } };
  return candidates.map((c) => ({ json: { id: c.id, request: {
    model: "jev-latest",
    questions,
    state: { creator: clean(c.name), platform: c.platform, category: c.category, content: clean(c.summary) },
  } } }));
}

function w1Shortlist() {
  // Claude and Jev score every candidate blind to each other (0-10); the ranking uses the average.
  // A gap of 4+ points is flagged for a human look. Fill the budget minus the reserve; nobody below MIN_BRIEF_FIT.
  // LinkedIn and newsletters have no price guardrail yet: they count as US$500, Passionfroot's lowest band.
  const r = $("Claude · rank against brief").first().json;
  if (r.stop_reason === "refusal") throw new Error("Claude declined the ranking: " + JSON.stringify(r.stop_details));
  if (r.stop_reason === "max_tokens") throw new Error("Ranking was cut off: lower the number of candidates.");
  const claude = Object.fromEntries(JSON.parse(r.content.find((b) => b.type === "text").text).ranking.map((x) => [x.id, x]));
  const jevIds = $("Build Jev requests").all();
  const jev = {};
  $input.all().forEach((it, i) => {
    const score = it.json.answers?.brief_fit?.score;
    if (typeof score === "number") jev[jevIds[i].json.id] = score * 2.5; // Jev answers levels 0-4
  });
  const { candidates } = $("Build ranking request").first().json;
  const { criteria } = $("Criteria → Attio query").first().json;
  const brief = $(BRIEF_NODE).first().json;
  const budget = Number(brief["Budget (US$)"]);
  const target = Math.floor(budget * (1 - RESERVA));
  const ranked = candidates.map((c) => {
    const cl = claude[c.id]?.brief_fit ?? 0;
    const jv = jev[c.id];
    return { ...c, claude_fit: cl, jev_fit: jv === undefined ? null : Math.round(10 * jv) / 10, brief_fit: Math.round(10 * (jv === undefined ? cl : (cl + jv) / 2)) / 10,
      split: jv !== undefined && Math.abs(cl - jv) >= 4, reason: claude[c.id]?.reason ?? "not scored" };
  }).sort((a, b) => b.brief_fit - a.brief_fit || b.score - a.score);
  const qualified = ranked.filter((c) => c.brief_fit >= MIN_BRIEF_FIT);
  const shortlist = [];
  let total = 0;
  for (const c of qualified) {
    if (shortlist.length >= MAX_CREATORS) break;
    if (total + c.price > target) continue;
    shortlist.push(c);
    total += c.price;
  }
  const left = qualified.filter((c) => !shortlist.includes(c)).map((c) => c.price);
  const needsSourcing = target - total >= 500 && Math.min(...left, Infinity) > target - total;
  const line = (c) => "- **" + c.name + "** · " + c.platform + " · brief fit " + c.brief_fit + "/10 (Claude " + c.claude_fit
    + ", Jev " + (c.jev_fit ?? "n/a") + ")" + (c.split ? " ⚠ Jev and Claude disagree" : "") + " · score " + c.score + " · US$" + c.price + " — " + c.reason;
  const note = [
    "**Ideal creator:** " + criteria.ideal_creator,
    "**Content angle:** " + criteria.content_angle,
    "**Spend:** US$" + total + " of US$" + budget + " (target US$" + target + ", " + RESERVA * 100 + "% reserve)",
    "**Ranking:** average of Claude and Jev brief fit, scored blind to each other; ⚠ marks a gap of 4+ points.",
    "",
    "## Shortlist (" + shortlist.length + ")",
    ...shortlist.map(line),
    "",
    "## Next best, not included",
    ...ranked.filter((c) => !shortlist.includes(c)).slice(0, 10).map(line),
  ].join("\n");
  const deal = { data: { values: {
    name: "Brief · " + brief["Product"] + " (" + brief["Brand domain"] + ")",
    stage: "Lead",
    owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: ATTIO_OWNER }],
    value: total,
    product: brief["Product"],
    budget_usd: budget,
    target_categories: criteria.categories,
    brief_source: "Hypothetical (case study)",
    associated_people: shortlist.map((s) => ({ target_object: "people", target_record_id: s.record_id })),
  } } };
  const jevErrors = $input.all().filter((it) => typeof it.json.answers?.brief_fit?.score !== "number");
  return [{ json: { criteria, candidates: candidates.length, qualified: qualified.length, splits: ranked.filter((c) => c.split).length,
    jev_scored: candidates.length - jevErrors.length, jev_first_error: jevErrors[0]?.json?.error?.message ?? null,
    shortlist, total_usd: total, target_usd: target, needs_sourcing: needsSourcing, note, deal } }];
}

// ---------- W2 · Etapa B, outreach: Attio "Ready for outreach" → Apollo → "Contacted" ----------
// Só demonstração: sem caixa de e-mail conectada, a inscrição na sequência falha de propósito. Nunca ativar.
const w2 = {
  name: "Creator Supply Engine · Stage B · Attio → Apollo outreach (demo only)",
  nodes: [
    {
      name: "Attio · stage changed", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0],
      parameters: { httpMethod: "POST", path: "attio-stage", responseMode: "onReceived", options: {} },
      webhookId: "attio-stage",
    },
    code("List entry events", [220, 0], `// Attio sends a batch of events; keep only Supply pipeline list entries
return $json.body.events
  .filter((e) => e.event_type === "list-entry.updated" || e.event_type === "list-entry.created")
  .map((e) => ({ json: { list_id: e.id.list_id, entry_id: e.id.entry_id } }));`),
    http("Attio · get entry", [440, 0], {
      url: "=https://api.attio.com/v2/lists/{{ $json.list_id }}/entries/{{ $json.entry_id }}", credencial: "Attio",
    }),
    {
      name: "Ready for outreach?", type: "n8n-nodes-base.if", typeVersion: 2, position: [660, 0],
      parameters: { conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ leftValue: "={{ $json.data.entry_values.stage?.[0]?.status?.title }}", rightValue: "Ready for outreach",
          operator: { type: "string", operation: "equals" } }],
        combinator: "and",
      }, options: {} },
    },
    http("Attio · get creator", [880, -100], {
      url: "=https://api.attio.com/v2/objects/people/records/{{ $json.data.parent_record_id }}", credencial: "Attio",
    }),
    http("Apollo · upsert contact", [1100, -100], {
      method: "POST", url: "https://api.apollo.io/api/v1/contacts", credencial: "Apollo",
      body: `={{ JSON.stringify({
  first_name: $json.data.values.name[0].first_name || $json.data.values.name[0].full_name.split(" ")[0],
  last_name: $json.data.values.name[0].last_name || $json.data.values.name[0].full_name.split(" ").slice(1).join(" "),
  linkedin_url: $json.data.values.linkedin?.[0]?.value,
  email: $json.data.values.email_addresses?.[0]?.email_address,
  label_names: ["Creator Supply"],
  run_dedupe: true,
}) }}`,
    }),
    http("Apollo · add to sequence", [1320, -100], {
      method: "POST", url: `=https://api.apollo.io/api/v1/emailer_campaigns/{{ ${SEQUENCIA_DO_CREATOR} }}/add_contact_ids`, credencial: "Apollo",
      body: `={{ JSON.stringify({
  emailer_campaign_id: ${SEQUENCIA_DO_CREATOR},
  contact_ids: [$json.contact.id],
  send_email_from_email_account_id: "DEMO_ONLY_NO_MAILBOX_CONNECTED",
}) }}`,
    }),
    http("Attio · mark Contacted", [1540, -100], {
      method: "PATCH", url: "=https://api.attio.com/v2/lists/supply_pipeline/entries/{{ $('List entry events').item.json.entry_id }}",
      credencial: "Attio", body: JSON.stringify({ data: { entry_values: { stage: "Contacted" } } }),
    }),
  ],
  connections: {
    ...liga("Attio · stage changed", "List entry events", "Attio · get entry", "Ready for outreach?"),
    "Ready for outreach?": { main: [[{ node: "Attio · get creator", type: "main", index: 0 }], []] },
    ...liga("Attio · get creator", "Apollo · upsert contact", "Apollo · add to sequence", "Attio · mark Contacted"),
  },
  settings: { executionOrder: "v1" },
};

// ---------- W3 · Etapa B, supply: sourcing → duplo vetting Jev + Claude → Attio ----------
// Toda semana: acha as categorias com menos aprovados no Attio, busca no YouTube e no Substack, avalia cada creator novo
// com Jev e Claude às cegas (a mesma rubrica dos scripts), aprovados entram como Vetted e disputas como Sourced.
// Aprovados com algum caminho de contato vão para "Ready for outreach", o que dispara o W2.
// A Clay entraria entre Vetted e Ready (enrich); no plano gratuito ela não aceita chamada do n8n, então o nó fica desligado.
// Mercados (24/10): toda rodada cobre Brasil e EUA, com as 3 categorias mais finas de cada um (~1.400 unidades do YouTube).
const BUSCAS_BR = {
  "Marketing & Design": ["marketing de produto", "branding para empresas", "copywriting", "UX writing", "design system", "design de interfaces", "marketing B2B", "social media para empresas", "marketing médico"],
  // Ângulo profissional (decisão do Michel, 23/10): "como estudar" e "notion organização" traziam 13 canais de estudante em 16 aprovados
  "Productivity & Personal Development": ["excel para financeiro", "produtividade para gestores", "gestão do tempo no trabalho", "power bi para empresas", "apresentações executivas", "notion para empresas", "excel avançado"],
  "Tech & Business": ["gestão de projetos", "SaaS", "system design", "engenharia de dados", "startup fundador", "customer success", "prospecção B2B", "inside sales", "negociação em vendas", "cloud AWS", "cibersegurança", "metodologias ágeis scrum", "logística e supply chain", "gestão de produto digital", "ERP gestão empresarial"],
  "AI": ["automação de processos empresas", "agentes de IA para empresas", "IA no trabalho", "n8n automação"],
  "Finance & Investing": ["FP&A", "controladoria", "fluxo de caixa empresa", "valuation", "planejamento tributário", "contador", "venture capital"],
  "Health": ["gestão de clínicas", "gestão em saúde", "healthtech", "saúde ocupacional", "enfermagem carreira", "marketing para clínicas", "administração hospitalar", "odontologia gestão"],
  "Career": ["recrutamento e seleção", "departamento pessoal", "gestão de pessoas", "liderança de equipes", "carreira em tecnologia", "transição de carreira", "people analytics"],
  "Other": ["advocacia", "agronegócio gestão", "gestão de obras", "direito digital"],
};
// EUA: os mesmos ângulos profissionais, em inglês (lote us1 de 24/10 como referência)
const BUSCAS_US = {
  "Marketing & Design": ["B2B marketing strategy", "product marketing manager", "demand generation", "LinkedIn content strategy for business", "copywriting for business", "UX design career", "product design process", "brand strategy"],
  "Productivity & Personal Development": ["Excel for finance professionals", "productivity for managers", "time management at work", "Power BI tutorial business", "Notion for teams", "executive presentation skills"],
  "Tech & Business": ["product management", "SaaS founder", "system design interview", "data engineering", "customer success manager", "B2B sales prospecting", "revenue operations", "engineering manager", "software architecture", "supply chain management", "cybersecurity career", "agile project management"],
  "AI": ["AI agents for business", "AI automation workflows", "n8n automation", "AI at work"],
  "Finance & Investing": ["FP&A", "CFO", "corporate finance", "accounting for small business owners", "venture capital", "tax planning for business"],
  "Health": ["healthcare operations management", "healthtech", "medical practice management", "nursing career", "hospital administration", "digital health startup"],
  "Career": ["HR people operations", "recruiting tips", "tech career advice", "leadership for new managers", "career change", "people analytics"],
  "Other": ["legal tech", "construction project management", "agtech", "real estate investing business"],
};
const BUSCAS_W3 = { BR: BUSCAS_BR, US: BUSCAS_US };
for (const [m, b] of Object.entries(BUSCAS_W3)) if (Object.keys(b).join() !== Object.values(CATEGORIAS_EN).join()) throw new Error(`BUSCAS_W3.${m} fora de sincronia com CATEGORIAS_EN`);
// O que muda por mercado no W3: nome no Attio, busca do YouTube, país aceito e idioma do Substack
const MARKETS = Object.fromEntries(Object.entries(MERCADOS).map(([k, m]) => [k, { name: m.nome, ...m.youtube, country: k }]));
const W3 = { CATEGORIES_PER_RUN: 3, YT_PER_CATEGORY: 2, NL_PER_CATEGORY: 2, MIN_SUBS: 2000, MAX_SUBS: 1_000_000, MAX_YT: 40, MAX_NL: 15, MIN_ASSINANTES: 1000 };

// Quem já foi avaliado nos lotes locais não volta; os novos ficam na memória do workflow (static data)
const dataDir = new URL("../data/", import.meta.url);
const vistos = (re) => [...new Set(readdirSync(dataDir).filter((f) => re.test(f)).flatMap((f) => Object.keys(JSON.parse(readFileSync(new URL(f, dataDir), "utf8")))))];
const SEEN_CHANNELS = vistos(/^youtube_.+_states\.json$/);
const SEEN_PUBS = vistos(/^newsletters_.+_states\.json$/);

// A mesma rubrica do rubric.mjs: perguntas do Jev e prompt do Claude por plataforma
const KEYS = Object.keys(CRITERIA);
const RED_KEYS = Object.keys(RED_FLAGS);
if (Object.keys(NEWSLETTER.criteria).join() !== KEYS.join() || Object.keys(NEWSLETTER.red_flags).join() !== RED_KEYS.join()) throw new Error("rubricas de YouTube e newsletter com chaves diferentes");
const PESOS = Object.fromEntries([...Object.entries(CRITERIA), ...Object.entries(OBJECTIVE)].map(([k, c]) => [k, c.peso]));
// Por mercado, muda o portão de idioma (language_gate no n8n) e a escala do fit regional; o resto é igual
const portoes = (m, plat) => ({
  language_gate: MERCADOS[m].idioma[plat === "YouTube" ? "youtube" : "newsletter"],
  e_creator: (plat === "YouTube" ? GATES : NEWSLETTER.gates).e_creator,
});
const criteriosDe = (crit, m) => ({ ...crit, fit_regional: { ...crit.fit_regional, levels: MERCADOS[m].regional } });
const porMercado = (f) => Object.fromEntries(Object.keys(MERCADOS).map((m) => [m, {
  YouTube: f(m, "YouTube", portoes(m, "YouTube"), RED_FLAGS, criteriosDe(CRITERIA, m)),
  Newsletter: f(m, "Newsletter", portoes(m, "Newsletter"), NEWSLETTER.red_flags, criteriosDe(NEWSLETTER.criteria, m)),
}]));
const JEV_Q = porMercado((m, plat, gates, flags, crit) => perguntasJev({ ...gates, ...flags }, crit));
const sistemaClaude = (m, plataforma, gates, flags, criteria) => [
  `You are the second evaluator in a blind double vetting of ${m === "US" ? "US" : "Brazilian"} ${plataforma === "YouTube" ? "YouTube" : "newsletter"} creators for Passionfroot, a marketplace where B2B brands sponsor creators. Another evaluator scores the same data separately; you never see its answers.`,
  `Use only the evidence in the creator data. The rubric is in Portuguese; the content is in ${m === "US" ? "English" : "Portuguese"}.`,
  "Gates (true or false):",
  ...Object.entries(gates).map(([k, t]) => `- ${k}: ${t}`),
  "Red flags (list every one that applies; an empty list means none):",
  ...Object.entries(flags).map(([k, t]) => `- ${k}: ${t}`),
  "Criteria (integer from 1 to 5, the level number):",
  ...Object.entries(criteria).map(([k, c]) => `- ${k}: ${c.instructions}. ${c.levels.map((l, i) => `${i + 1}) ${l}`).join(" ")}`),
  `categoria: the main topic, one of: ${Object.entries(CATEGORIAS).map(([k, v]) => `${k} (${v})`).join("; ")}.`,
  "rationale: one or two sentences in English naming the evidence behind the fit and quality scores.",
].join("\n");
const CLAUDE_SYS = porMercado(sistemaClaude);
const CLAUDE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["language_gate", "e_creator", "red_flags", ...KEYS, "categoria", "rationale"],
  properties: {
    language_gate: { type: "boolean" },
    e_creator: { type: "boolean" },
    red_flags: { type: "array", items: { type: "string", enum: RED_KEYS } },
    ...Object.fromEntries(KEYS.map((k) => [k, { type: "integer" }])),
    categoria: { type: "string", enum: Object.keys(CATEGORIAS) },
    rationale: { type: "string" },
  },
};

const LINHA_YT = 0, LINHA_NL = 320, LINHA_VET = 640;
const UA = [{ name: "User-Agent", value: "Mozilla/5.0" }];
// O Substack responde 403 com o desafio do Cloudflare ("Just a moment...") para os servidores do n8n Cloud (23/10).
// Decisão do Michel: o ramo fica no W3 para mostrar o desenho completo, com uma nota explicando por que chega vazio;
// o resumo mostra os códigos de resposta. As newsletters de verdade vêm dos scripts locais (substack_sourcing.mjs etc.).
const SUBSTACK_NO_N8N = true;
const w3 = {
  name: "Creator Supply Engine · Stage B · Weekly sourcing + double vetting",
  nodes: [
    nota("About this workflow", [-520, -340], [
      "## Stage B · weekly supply",
      `Runs every Monday. Finds the Passionfroot categories with the fewest approved creators in Attio, searches ${SUBSTACK_NO_N8N ? "YouTube and Substack" : "YouTube"} for new creators there, and vets each one twice, blind: **Jev** and **Claude** with the same rubric. Every run covers both markets, **Brazil** and the **United States**, the three thinnest categories in each (same rubric; the language gate and regional fit follow the market).`,
      "",
      "- Both approve → **Vetted** in Attio",
      "- They disagree on a gate or by 2+ points on fit or quality → **Sourced**, verdict *Dispute*, for a human call",
      "- Approved with a contact route → **Ready for outreach**, which starts the outreach workflow",
      "",
      "Creators vetted before are skipped (the batches already run, plus the workflow's memory).",
    ].join("\n"), [460, 330]),
    nota("Clay on a paid plan", [3100, LINHA_VET - 300], [
      "## Clay, on a paid plan",
      "**Enrich:** Clay's webhook source receives each approved creator, finds their LinkedIn, role, company and a business email (waterfall), and writes back to Attio through its HTTP action. The node below is disabled because Clay's free plan has no webhook source.",
      "",
      "**LinkedIn sourcing, Brazil and US:** Clay's people search (10k+ followers, creator signals) runs through the Clay CLI. Brazil has one batch; the US is the same search with the country set to United States, left out because the free plan gives 100 search results a month and reading posts costs about 3.5 credits a profile, and the Brazilian batch used half the quota. On a paid plan, a Clay table would post each profile to a webhook here and join the same double vetting.",
    ].join("\n"), [460, 320]),
    nota("Why the Substack branch comes back empty", [0, LINHA_NL - 260], [
      "## Why the Substack branch comes back empty",
      "Substack answers n8n Cloud with a Cloudflare challenge (HTTP 403, \"Just a moment...\"): it blocks requests from cloud servers. The same searches work from a home connection.",
      "",
      "The branch stays here because newsletters are part of the supply: same thin-category searches, same subscriber floor, same double vetting as YouTube. The run summary shows the status code of every Substack search, so the block is visible instead of silent.",
      "",
      "Until n8n runs from a network Substack accepts, newsletters come from local scripts with the same rubric and land in the same Attio pipeline.",
    ].join("\n"), [520, 250]),
    {
      name: "Every Monday", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, LINHA_YT],
      parameters: { rule: { interval: [{ field: "weeks", weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 9 }] } },
    },
    codeFn("Categories", [220, LINHA_YT], w3Categorias, { CATEGORIES: Object.values(CATEGORIAS_EN), MARKETS, RUN_MARKETS: Object.keys(MARKETS) }),
    http("Attio · approved per category", [440, LINHA_YT], {
      method: "POST", url: "https://api.attio.com/v2/objects/people/records/query", credencial: "Attio",
      body: "={{ JSON.stringify($json.query) }}",
    }),
    codeFn("Plan searches", [660, LINHA_YT], w3Plano, { BUSCAS: BUSCAS_W3, MARKETS, RUN_MARKETS: Object.keys(MARKETS), ...W3 }),
    codeFn("YouTube searches", [880, LINHA_YT], w3BuscasYt),
    http("YouTube · search", [1100, LINHA_YT], {
      url: "https://www.googleapis.com/youtube/v3/search", credencial: "YouTube", continuar: true,
      query: [
        { name: "part", value: "snippet" }, { name: "type", value: "video" }, { name: "maxResults", value: "50" },
        { name: "regionCode", value: "={{ $json.regionCode }}" }, { name: "relevanceLanguage", value: "={{ $json.relevanceLanguage }}" },
        { name: "q", value: "={{ $json.q }}" }, { name: "publishedAfter", value: "={{ $json.publishedAfter }}" },
      ],
    }),
    codeFn("New channels", [1320, LINHA_YT], w3NovosCanais, { SEEN_CHANNELS }),
    http("YouTube · channels", [1540, LINHA_YT], {
      url: "https://www.googleapis.com/youtube/v3/channels", credencial: "YouTube", continuar: true,
      query: [{ name: "part", value: "snippet,statistics,contentDetails" }, { name: "id", value: "={{ $json.ids }}" }],
    }),
    codeFn("Cheap filter", [1760, LINHA_YT], w3FiltroBarato, { MIN_SUBS: W3.MIN_SUBS, MAX_SUBS: W3.MAX_SUBS, MAX_YT: W3.MAX_YT, MARKETS }),
    http("YouTube · last uploads", [1980, LINHA_YT], {
      url: "https://www.googleapis.com/youtube/v3/playlistItems", credencial: "YouTube", continuar: true,
      query: [{ name: "part", value: "snippet,contentDetails" }, { name: "maxResults", value: "10" }, { name: "playlistId", value: "={{ $json.uploads }}" }],
    }),
    codeFn("Video ids", [2200, LINHA_YT], w3IdsVideos),
    http("YouTube · video stats", [2420, LINHA_YT], {
      url: "https://www.googleapis.com/youtube/v3/videos", credencial: "YouTube", continuar: true,
      query: [{ name: "part", value: "statistics" }, { name: "id", value: "={{ $json.ids }}" }],
    }),
    codeFn("YouTube candidates", [2640, LINHA_YT], w3CandidatosYt, {}, [notaEngajamento, notaConsistencia]),
    ...(!SUBSTACK_NO_N8N ? [] : [
    codeFn("Substack searches", [0, LINHA_NL], w3BuscasNl),
    http("Substack · search", [220, LINHA_NL], {
      url: "https://substack.com/api/v1/top/search", headers: UA, continuar: true, completo: true, sempre: true,
      query: [{ name: "query", value: "={{ $json.q }}" }, { name: "limit", value: "50" }],
    }),
    codeFn("New publications", [440, LINHA_NL], w3NovasPubs, { SEEN_PUBS, MAX_NL: W3.MAX_NL }),
    http("Substack · author profile", [660, LINHA_NL], {
      url: "=https://substack.com/api/v1/user/{{ $json.handle }}/public_profile", headers: UA, continuar: true,
    }),
    codeFn("Subscriber filter", [880, LINHA_NL], w3FiltroAssinantes, { MIN_ASSINANTES: W3.MIN_ASSINANTES, MAX_NL: W3.MAX_NL }),
    http("Substack · recent posts", [1100, LINHA_NL], {
      url: "={{ $json.base }}/api/v1/archive", headers: UA, continuar: true, sempre: true,
      query: [{ name: "sort", value: "new" }, { name: "limit", value: "10" }],
    }),
    ]),
    codeFn("All new creators", [0, LINHA_VET], w3TodosNovos, { JEV_Q, CLAUDE_SYS, CLAUDE_SCHEMA, MARKET_NAMES: Object.fromEntries(Object.entries(MARKETS).map(([k, m]) => [k, m.name])) }, [notaEngajamentoNewsletter, notaConsistencia]),
    http("Jev · rubric", [220, LINHA_VET], {
      method: "POST", url: JEV_URL, credencial: "Jev", body: "={{ JSON.stringify($json.jev_request) }}", lote: 5, continuar: true, repetir: true,
    }),
    http("Claude · rubric", [440, LINHA_VET], {
      method: "POST", url: "https://api.anthropic.com/v1/messages", credencial: "Anthropic", headers: CLAUDE_HEADERS,
      body: "={{ JSON.stringify($('All new creators').item.json.claude_request) }}", lote: 3, continuar: true, repetir: true, timeout: 300000,
    }),
    codeFn("Compare Jev × Claude", [660, LINHA_VET], w3Comparar, { KEYS, RED_KEYS, PESOS, PESADOS, APROVACAO_MINIMA, FIT_MINIMO, CATEGORIAS_EN }),
    {
      name: "Anything to store?", type: "n8n-nodes-base.if", typeVersion: 2, position: [770, LINHA_VET + 200],
      parameters: { conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ leftValue: "={{ $json.nothing_to_store === true }}", rightValue: "", operator: { type: "boolean", operation: "false", singleValue: true } }],
        combinator: "and",
      }, options: {} },
    },
    http("Attio · create creator", [880, LINHA_VET], {
      method: "POST", url: "https://api.attio.com/v2/objects/people/records", credencial: "Attio",
      body: "={{ JSON.stringify($json.person) }}", lote: 5, continuar: true,
    }),
    codeFn("Pipeline entry", [1100, LINHA_VET], w3Entrada),
    http("Attio · add to pipeline", [1320, LINHA_VET], {
      method: "POST", url: "https://api.attio.com/v2/lists/supply_pipeline/entries", credencial: "Attio",
      body: "={{ JSON.stringify($json.request) }}", lote: 5, continuar: true,
    }),
    http("Clay · enrich (paid plan)", [3100, LINHA_VET], {
      method: "POST", url: "https://api.clay.com/v3/sources/webhook/REPLACE_WITH_CLAY_WEBHOOK_URL", desligado: true,
      body: "={{ JSON.stringify({ attio_record_id: $('Pipeline entry').item.json.record_id, name: $('Pipeline entry').item.json.name }) }}",
    }),
    codeFn("Contact route", [3320, LINHA_VET], w3Prontos),
    http("Attio · ready for outreach", [3540, LINHA_VET], {
      method: "PATCH", url: "=https://api.attio.com/v2/lists/supply_pipeline/entries/{{ $json.entry_id }}", credencial: "Attio",
      body: JSON.stringify({ data: { entry_values: { stage: "Ready for outreach" } } }), continuar: true,
    }),
    codeFn("Review tasks", [1540, LINHA_VET - 200], w3Tarefas, { REVIEWER: ATTIO_OWNER }),
    http("Attio · review task", [1760, LINHA_VET - 200], {
      method: "POST", url: "https://api.attio.com/v2/tasks", credencial: "Attio",
      body: "={{ JSON.stringify($json.request) }}", lote: 5, continuar: true,
    }),
    codeFn("Run summary", [1540, LINHA_VET + 200], w3Resumo, { SUBSTACK: SUBSTACK_NO_N8N }),
  ],
  connections: (() => {
    const c = liga("Every Monday", "Categories", "Attio · approved per category", "Plan searches", "YouTube searches", "YouTube · search",
      "New channels", "YouTube · channels", "Cheap filter", "YouTube · last uploads", "Video ids", "YouTube · video stats", "YouTube candidates",
      ...(SUBSTACK_NO_N8N ? ["Substack searches", "Substack · search", "New publications", "Substack · author profile", "Subscriber filter", "Substack · recent posts"] : []),
      "All new creators", "Jev · rubric", "Claude · rubric", "Compare Jev × Claude", "Attio · create creator", "Pipeline entry",
      "Attio · add to pipeline", "Clay · enrich (paid plan)", "Contact route", "Attio · ready for outreach");
    c["Attio · add to pipeline"].main[0].push({ node: "Run summary", type: "main", index: 0 }, { node: "Review tasks", type: "main", index: 0 });
    c["Review tasks"] = { main: [[{ node: "Attio · review task", type: "main", index: 0 }]] };
    // Nada aprovado nem em disputa: vai direto ao resumo (saída "false" do IF)
    c["Compare Jev × Claude"] = { main: [[{ node: "Anything to store?", type: "main", index: 0 }]] };
    c["Anything to store?"] = { main: [[{ node: "Attio · create creator", type: "main", index: 0 }], [{ node: "Run summary", type: "main", index: 0 }]] };
    return c;
  })(),
  settings: { executionOrder: "v1", timezone: "America/Sao_Paulo" },
};

// Funções dos nós de código do W3
function w3Categorias() {
  // Every run covers both markets, Brazil and the United States (edit RUN_MARKETS to run only one)
  // One Attio query per market and Passionfroot category, with every verdict: approved creators set the counts,
  // and everyone already in Attio (disputes and rejections too) counts as seen
  return RUN_MARKETS.flatMap((market) => CATEGORIES.map((category) => ({ json: { category, market, query: { limit: 500,
    filter: { passionfroot_category: category, market: MARKETS[market].name } } } })));
}

function w3Plano() {
  // In each market, thinnest categories first; searches rotate every week so each run looks somewhere new
  const cats = $("Categories").all();
  const counts = $input.all().map((it, i) => ({ market: cats[i].json.market, category: cats[i].json.category, approved: (it.json.data ?? []).filter((p) => p.values?.verdict?.[0]?.option?.title === "Approved").length }));
  const week = Math.floor(Date.now() / (7 * 864e5));
  const pick = (list, n, offset) => Array.from({ length: Math.min(n, list.length) }, (_, k) => list[(week * n + k + offset) % list.length]);
  const publishedAfter = new Date(Date.now() - 90 * 864e5).toISOString();
  const thin = RUN_MARKETS.flatMap((market) => counts.filter((c) => c.market === market)
    .sort((a, b) => a.approved - b.approved).slice(0, CATEGORIES_PER_RUN));
  return [{ json: {
    thin,
    youtube: thin.flatMap((t) => pick(BUSCAS[t.market][t.category], YT_PER_CATEGORY, 0).map((q) => ({ q, category: t.category, market: t.market, publishedAfter,
      regionCode: MARKETS[t.market].regionCode, relevanceLanguage: MARKETS[t.market].relevanceLanguage }))),
    substack: thin.flatMap((t) => pick(BUSCAS[t.market][t.category], NL_PER_CATEGORY, YT_PER_CATEGORY).map((q) => ({ q, category: t.category, market: t.market }))),
  } }];
}

function w3BuscasYt() {
  return $("Plan searches").first().json.youtube.map((s) => ({ json: s }));
}

function w3NovosCanais() {
  // Channels from recent videos, minus everyone vetted before; YouTube takes 50 ids per lookup
  const memory = $getWorkflowStaticData("global");
  const seen = new Set([...SEEN_CHANNELS, ...(memory.seenChannels ?? [])]);
  // Manual runs do not save the memory, so creators already in Attio count as seen too, disputes included (no duplicates)
  for (const it of $("Attio · approved per category").all()) {
    for (const p of it.json.data ?? []) {
      const id = p.values?.creator_id?.[0]?.value ?? "";
      if (id.startsWith("yt:")) seen.add(id.slice(3));
    }
  }
  const searches = $("YouTube searches").all();
  const hits = {};
  $input.all().forEach((it, i) => {
    for (const v of it.json.items ?? []) {
      const id = v.snippet?.channelId;
      if (!id || seen.has(id)) continue;
      const s = searches[i].json;
      const h = (hits[id] = hits[id] ?? { queries: [], categories: [], market: s.market });
      if (!h.queries.includes(s.q)) { h.queries.push(s.q); h.categories.push(s.category); }
    }
  });
  const ids = Object.keys(hits);
  const chunks = [];
  for (let k = 0; k < ids.length; k += 50) chunks.push({ json: { ids: ids.slice(k, k + 50).join(","), hits } });
  return chunks.length ? chunks : [{ json: { skip: true, hits: {} } }];
}

function w3FiltroBarato() {
  // Cheap filter before spending more quota: country, size and "cortes" (clip) channels
  const memory = $getWorkflowStaticData("global");
  const seen = new Set(memory.seenChannels ?? []);
  const hits = $("New channels").first().json.hits ?? {};
  const kept = [];
  for (const it of $input.all()) {
    for (const c of it.json.items ?? []) {
      const subs = Number(c.statistics?.subscriberCount ?? 0);
      const market = hits[c.id]?.market ?? "BR";
      const ok = (!c.snippet?.country || c.snippet.country === MARKETS[market].country) && !c.statistics?.hiddenSubscriberCount
        && subs >= MIN_SUBS && subs <= MAX_SUBS && !/\bcortes?\b/i.test(c.snippet?.title ?? "");
      if (!ok) { seen.add(c.id); continue; }
      kept.push({
        id: c.id, title: c.snippet.title, description: c.snippet.description ?? "", subscribers: subs,
        link: c.snippet.customUrl ? "https://www.youtube.com/" + c.snippet.customUrl : "https://www.youtube.com/channel/" + c.id,
        uploads: c.contentDetails?.relatedPlaylists?.uploads,
        queries: hits[c.id]?.queries ?? [], categories: hits[c.id]?.categories ?? [], market,
      });
    }
  }
  // Channels past the cap are not marked as seen: they come back next week
  const batch = kept.slice(0, MAX_YT);
  for (const c of batch) seen.add(c.id);
  memory.seenChannels = [...seen];
  return batch.length ? batch.map((c) => ({ json: c })) : [{ json: { skip: true } }];
}

function w3IdsVideos() {
  return $input.all().map((it) => ({ json: { ids: (it.json.items ?? []).map((x) => x.contentDetails?.videoId).filter(Boolean).join(",") } }));
}

function w3CandidatosYt() {
  // Same signals as youtube_sourcing.mjs: last 10 videos, views per subscriber, cadence, links in the description
  const DAY = 864e5;
  const cut = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");
  const chans = $("Cheap filter").all();
  const uploads = $("YouTube · last uploads").all();
  const stats = $input.all();
  const out = [];
  chans.forEach((it, i) => {
    const c = it.json;
    if (c.skip) return;
    const pl = uploads[i]?.json?.items ?? [];
    if (!pl.length) return;
    const views = (stats[i]?.json?.items ?? []).map((v) => Number(v.statistics?.viewCount ?? 0));
    const avg = views.length ? views.reduce((a, b) => a + b, 0) / views.length : 0;
    const dates = pl.map((x) => x.contentDetails?.videoPublishedAt).filter(Boolean).sort();
    const last = dates.at(-1);
    const videos30 = dates.filter((d) => Date.now() - new Date(d).getTime() <= 30 * DAY).length;
    const desc = c.description;
    const instagram = desc.match(/instagram\.com\/[A-Za-z0-9_.]+/i)?.[0];
    const linkedin = desc.match(/linkedin\.com\/in\/[A-Za-z0-9_\-%]+/i)?.[0];
    const business = /[\w.+-]+@[\w-]+\.[\w.]+|parceria|publi|contato comercial|business|sponsor|partnership|m[ií]dia ?kit|media ?kit/i.test(desc);
    out.push({ json: {
      platform: "YouTube",
      market: c.market,
      creator_id: "yt:" + c.id,
      name: c.title,
      link: c.link,
      audience: c.subscribers,
      rate_card: c.subscribers < 100000 ? 500 : c.subscribers < 500000 ? 1500 : 3000,
      gate30d: !!last && Date.now() - new Date(last).getTime() <= 30 * DAY,
      objective: { engajamento: notaEngajamento(avg / c.subscribers), consistencia: notaConsistencia(videos30) },
      state: {
        canal: c.title,
        descricao_do_canal: cut(desc, 600),
        ultimos_videos: pl.map((x) => ({ titulo: x.snippet?.title, descricao: cut(x.snippet?.description, 150), data: (x.contentDetails?.videoPublishedAt ?? "").slice(0, 10) })),
      },
      content_summary: cut(desc.replace(/\s+/g, " ").trim(), 300) + " | Recent videos: " + pl.slice(0, 6).map((x) => cut(x.snippet?.title, 90)).join(" / "),
      instagram: instagram ? "https://www." + instagram : "",
      linkedin: linkedin ? "https://www." + linkedin : "",
      contact_route: !!(instagram || linkedin || business),
      queries: c.queries,
    } });
  });
  return out.length ? out : [{ json: { skip: true } }];
}

function w3BuscasNl() {
  return $("Plan searches").first().json.substack.map((s) => ({ json: s }));
}

function w3NovasPubs() {
  // Publications in the language of the search's market, minus everyone vetted before.
  // Substack only fills in the language when it is not English, so an empty one counts as English.
  const inMarket = (lang, market) => (market === "BR" ? /^pt/.test(lang ?? "") : !lang || /^en/.test(lang));
  const memory = $getWorkflowStaticData("global");
  const seen = new Set([...SEEN_PUBS, ...(memory.seenPubs ?? [])]);
  for (const it of $("Attio · approved per category").all()) {
    for (const p of it.json.data ?? []) {
      const id = p.values?.creator_id?.[0]?.value ?? "";
      if (id.startsWith("nl:")) seen.add(id.slice(3));
    }
  }
  const searches = $("Substack searches").all();
  const pubs = {};
  // Diagnosis for the summary: Substack sometimes refuses calls from cloud servers (works from a home connection)
  const diag = { searches: searches.length, responses: $input.all().length, status_codes: {}, publications_found: 0, in_market_language: 0, new: 0, first_error: null };
  $input.all().forEach((it, i) => {
    const status = it.json.statusCode ?? (it.json.error ? "error" : 200);
    diag.status_codes[status] = (diag.status_codes[status] ?? 0) + 1;
    const body = it.json.body ?? it.json;
    if (status !== 200 && !diag.first_error) diag.first_error = String(typeof body === "string" ? body : JSON.stringify(it.json.error ?? body)).slice(0, 200);
    for (const item of body?.items ?? []) {
      const found = item.type === "profileSearchResults"
        ? (item.results ?? []).map((r) => ({ pub: r.primaryPublication, handle: r.handle }))
        : (item.context?.users ?? []).map((u) => ({ pub: u.primary_publication, handle: u.handle }));
      for (const { pub, handle } of found) {
        if (!pub?.subdomain) continue;
        diag.publications_found++;
        const market = searches[i]?.json?.market ?? "BR";
        if (!inMarket(pub.language, market)) continue;
        diag.in_market_language++;
        if (seen.has(pub.subdomain)) continue;
        const p = (pubs[pub.subdomain] = pubs[pub.subdomain] ?? {
          sub: pub.subdomain, handle, name: pub.name, queries: [], market,
          base: pub.custom_domain ? "https://" + pub.custom_domain : "https://" + pub.subdomain + ".substack.com",
        });
        const q = searches[i]?.json?.q;
        if (q && !p.queries.includes(q)) p.queries.push(q);
      }
    }
  });
  const list = Object.values(pubs).slice(0, MAX_NL * 3);
  diag.new = Object.keys(pubs).length;
  memory.seenPubs = [...new Set([...(memory.seenPubs ?? []), ...list.map((p) => p.sub)])];
  return list.length ? list.map((p, k) => ({ json: k ? p : { ...p, diag } })) : [{ json: { skip: true, diag } }];
}

function w3FiltroAssinantes() {
  // "5.9K+ subscribers" → 5900; without an exact number, Substack's rough band
  const BANDS = { "Tens": 10, "Hundreds": 100, "Thousands": 1000, "Tens of thousands": 10000, "Hundreds of thousands": 100000 };
  const pubs = $("New publications").all();
  const out = [];
  $input.all().forEach((it, i) => {
    const p = pubs[i]?.json;
    if (!p || p.skip) return;
    const prof = it.json ?? {};
    const m = String(prof.subscriberCountString ?? "").match(/([\d.,]+)\s*([KM]?)\+?\s*subscriber/i);
    const subs = m ? Math.round(parseFloat(m[1].replace(",", "")) * ({ K: 1e3, M: 1e6 }[m[2].toUpperCase()] ?? 1)) : BANDS[prof.rough_num_free_subscribers] ?? null;
    if (subs !== null && subs < MIN_ASSINANTES) return;
    out.push({ json: { ...p, author: prof.name ?? "", bio: Array.from(String(prof.bio ?? "")).slice(0, 500).join(""), subscribers: subs,
      subscribers_text: prof.subscriberCountString ?? prof.rough_num_free_subscribers ?? "" } });
  });
  return out.length ? out.slice(0, MAX_NL) : [{ json: { skip: true } }];
}

function w3TodosNovos() {
  // YouTube and Substack candidates in one list, each with its Jev and Claude requests (same data for both)
  const DAY = 864e5;
  const cut = (s, n) => Array.from(String(s ?? "")).slice(0, n).join("");
  const clean = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "string" && typeof v.toWellFormed === "function" ? v.toWellFormed() : v)));
  const youtube = $("YouTube candidates").all().map((it) => it.json).filter((c) => !c.skip);
  // The archive endpoint returns a list, which n8n splits into one item per post: group them back by publication
  const posts = {};
  for (const it of $input.all()) {
    if (!it.json?.post_date) continue;
    const k = it.pairedItem?.item ?? 0;
    (posts[k] = posts[k] ?? []).push(it.json);
  }
  const newsletters = [];
  // Without the Substack branch (blocked on n8n Cloud) there is no "Subscriber filter" node to read
  let pubs = [];
  try { pubs = $("Subscriber filter").all(); } catch { pubs = []; }
  pubs.forEach((it, i) => {
    const p = it.json;
    const ps = (posts[i] ?? []).slice(0, 10);
    if (p.skip || !ps.length) return;
    const recent = ps.filter((x) => Date.now() - new Date(x.post_date).getTime() <= 30 * DAY).length;
    const reactions = ps.reduce((s, x) => s + (x.reaction_count ?? 0), 0) / ps.length;
    newsletters.push({
      platform: "Newsletter",
      market: p.market,
      creator_id: "nl:" + p.sub,
      name: p.name,
      person: p.author,
      link: p.base,
      audience: p.subscribers,
      rate_card: 500,
      gate30d: recent > 0,
      objective: { engajamento: notaEngajamentoNewsletter(p.subscribers ? (1000 * reactions) / p.subscribers : 0), consistencia: notaConsistencia(recent) },
      state: {
        nome: p.name, autor: p.author, bio_autor: p.bio, assinantes: p.subscribers_text,
        posts_recentes: ps.map((x) => ({ data: x.post_date?.slice(0, 10), titulo: x.title, subtitulo: cut(x.subtitle, 200), tipo: x.type,
          so_pagantes: x.audience === "only_paid", trecho: cut(x.truncated_body_text ?? x.description, 400) })),
      },
      content_summary: cut(p.bio.replace(/\s+/g, " ").trim(), 200) + " | Recent posts: " + ps.slice(0, 6).map((x) => cut(x.title, 90)).join(" / "),
      instagram: "", linkedin: "",
      contact_route: true, // a newsletter author can always be reached by replying to the publication
      queries: p.queries,
    });
  });
  // A week with no new creators still goes on (one placeholder item) so the run ends with a summary
  if (!youtube.length && !newsletters.length) return [{ json: { nothing_to_vet: true } }];
  return [...youtube, ...newsletters].map((c) => ({ json: { ...c, market_name: MARKET_NAMES[c.market],
    jev_request: clean({ state: c.state, model: "jev-latest", questions: JEV_Q[c.market][c.platform] }),
    claude_request: clean({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: CLAUDE_SCHEMA } },
      system: CLAUDE_SYS[c.market][c.platform],
      messages: [{ role: "user", content: "Creator data (JSON):\n" + JSON.stringify(c.state) }],
    }),
  } }));
}

function w3Comparar() {
  // Same rules as compare_vetting.mjs: gates, 60 cut-off, minimum fit 2.5, disputes, tie-break by the average
  const cands = $("All new creators").all();
  const jevs = $("Jev · rubric").all();
  const final = (n) => Math.round(Object.entries(n).reduce((s, [k, v]) => s + PESOS[k] * v, 0) / 5);
  const noEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "" && !Number.isNaN(v)));
  const batch = "w3_" + new Date().toISOString().slice(0, 10);
  const stats = { evaluated: 0, approved: 0, disputes: 0, rejected: 0, failed: 0, jev_errors: 0, claude_errors: 0, first_error: null, results: [] };
  const falha = (cand, quem, detalhe) => {
    stats.failed++;
    stats[quem === "Jev" ? "jev_errors" : "claude_errors"]++;
    const msg = quem + " · " + cand.name + ": " + String(typeof detalhe === "string" ? detalhe : JSON.stringify(detalhe)).slice(0, 300);
    stats.first_error = stats.first_error ?? msg;
    stats.results.push({ name: cand.name, platform: cand.platform, verdict: "Failed", detail: msg });
  };
  const out = [];
  $input.all().forEach((it, i) => {
    const cand = cands[i].json;
    if (cand.nothing_to_vet) return;
    const a = jevs[i]?.json?.answers;
    const text = it.json?.content?.find?.((b) => b.type === "text")?.text;
    if (!a) return falha(cand, "Jev", jevs[i]?.json?.error ?? jevs[i]?.json);
    if (!text || it.json.stop_reason === "refusal") return falha(cand, "Claude", it.json?.error ?? it.json?.stop_reason ?? it.json);
    let c;
    try { c = JSON.parse(text); } catch { return falha(cand, "Claude", "answer is not JSON"); }
    if (!a.language_gate || !a.e_creator || KEYS.some((k) => !a[k])) return falha(cand, "Jev", "incomplete answers: " + Object.keys(a).join(", "));
    const jev = {
      language_gate: a.language_gate.noul >= 0.5, e_creator: a.e_creator.noul >= 0.5,
      flags: RED_KEYS.filter((k) => a[k].noul >= 0.5),
      notas: Object.fromEntries(KEYS.map((k) => [k, +(a[k].score + 1).toFixed(2)])),
      conf: Math.min(...PESADOS.map((k) => a[k].confidence)),
    };
    const claude = { language_gate: c.language_gate, e_creator: c.e_creator, flags: c.red_flags, notas: Object.fromEntries(KEYS.map((k) => [k, c[k]])) };
    for (const v of [jev, claude]) {
      v.notas = { ...v.notas, ...cand.objective };
      v.nota = final(v.notas);
      v.aprovado = v.language_gate && v.e_creator && !v.flags.length && cand.gate30d && v.nota >= APROVACAO_MINIMA && v.notas.fit_passionfroot >= FIT_MINIMO;
    }
    const reasons = [];
    if (jev.aprovado !== claude.aprovado) reasons.push("different verdicts");
    if (!jev.flags.length !== !claude.flags.length) reasons.push("red flag mismatch (Jev: " + (jev.flags.join(", ") || "none") + "; Claude: " + (claude.flags.join(", ") || "none") + ")");
    if (jev.e_creator !== claude.e_creator) reasons.push("disagree on whether it is a creator or a company");
    for (const k of PESADOS) if (Math.abs(jev.notas[k] - claude.notas[k]) >= 2) reasons.push(k + ": Jev " + jev.notas[k] + " vs Claude " + claude.notas[k]);
    const avg = Math.round((jev.nota + claude.nota) / 2);
    if (jev.conf < 0.3 && Math.abs(avg - APROVACAO_MINIMA) <= 5) reasons.push("low Jev confidence (" + jev.conf.toFixed(2) + ") near the cut-off");
    // Rule A: a split that is only about the score is settled by the average. Rule B: minimum fit is a gate.
    const byAverage = reasons.length > 0 && reasons.every((m) => m === "different verdicts" || m.startsWith("low Jev confidence"));
    const dispute = !byAverage && reasons.length > 0;
    const approved = byAverage
      ? avg >= APROVACAO_MINIMA && (jev.notas.fit_passionfroot + claude.notas.fit_passionfroot) / 2 >= FIT_MINIMO
      : jev.aprovado;
    const verdict = dispute ? "Dispute" : approved ? "Approved" : "Rejected";
    stats.evaluated++;
    stats[{ Dispute: "disputes", Approved: "approved", Rejected: "rejected" }[verdict]]++;
    stats.results.push({ name: cand.name, platform: cand.platform, market: cand.market_name, verdict, jev: jev.nota, claude: claude.nota,
      fit: "Jev " + jev.notas.fit_passionfroot + " / Claude " + claude.notas.fit_passionfroot, gate_30_days: cand.gate30d,
      why: dispute ? reasons.join("; ") : c.rationale });
    if (verdict === "Rejected") return;
    out.push({ json: {
      stage: verdict === "Dispute" ? "Sourced" : "Vetted",
      ready: verdict === "Approved" && cand.contact_route,
      person: { data: { values: noEmpty({
        name: [{ first_name: "", last_name: "", full_name: cand.person || cand.name }],
        description: cand.platform === "Newsletter" ? cand.name : null,
        creator_id: cand.creator_id,
        platform: cand.platform,
        market: cand.market_name,
        main_link: cand.link,
        passionfroot_category: CATEGORIAS_EN[c.categoria] ?? null,
        audience: cand.audience,
        final_score: avg,
        passionfroot_fit: claude.notas.fit_passionfroot,
        verdict,
        decided_by: dispute ? null : byAverage ? "Jev + Claude average" : "Jev + Claude agree",
        rate_card_usd: cand.rate_card,
        vetting_rationale: c.rationale,
        dispute_reason: dispute ? reasons.join("; ") : null,
        batch,
        content_summary: cand.content_summary,
        instagram: cand.instagram,
        linkedin: cand.linkedin,
      }) } },
    } });
  });
  out.forEach((o) => { o.json.stats = stats; });
  // Nothing to store still sends the stats on, so the run always ends with a summary
  return out.length ? out : [{ json: { nothing_to_store: true, stats } }];
}

function w3Entrada() {
  // Approved → Vetted, disputes → Sourced (a human decides in Attio)
  const comps = $("Compare Jev × Claude").all();
  return $input.all().map((it, i) => {
    const rid = it.json.data?.id?.record_id;
    const c = comps[i].json;
    const v = c.person.data.values;
    return { json: { record_id: rid, ready: c.ready, name: v.name[0].full_name, stage: c.stage,
      platform: v.platform, link: v.main_link, dispute_reason: v.dispute_reason,
      request: rid ? { data: { parent_record_id: rid, parent_object: "people", entry_values: { stage: c.stage } } } : null } };
  }).filter((x) => x.json.request);
}

function w3Tarefas() {
  // Every dispute becomes a task for the reviewer, linked to the creator, due in 3 days
  return $("Pipeline entry").all().filter((it) => it.json.stage === "Sourced").map((it) => ({ json: { request: { data: {
    content: "Decide: " + it.json.name + " (" + it.json.platform + ") · " + it.json.dispute_reason + ". Open the record, check " + it.json.link
      + " and set Verdict to Approved (stage Vetted) or Rejected (stage Rejected, with a reason).",
    format: "plaintext",
    deadline_at: new Date(Date.now() + 3 * 864e5).toISOString(),
    is_completed: false,
    linked_records: [{ target_object: "people", target_record_id: it.json.record_id }],
    assignees: [{ referenced_actor_type: "workspace-member", referenced_actor_id: REVIEWER }],
  } } } }));
}

function w3Prontos() {
  // Stand-in for the Clay enrich on the free plan: a creator with a LinkedIn, Instagram or business contact
  // in their own channel (or any newsletter author) is ready for outreach
  const entries = $("Pipeline entry").all();
  return $("Attio · add to pipeline").all()
    .map((it, i) => ({ ready: entries[i]?.json?.ready, entry_id: it.json.data?.id?.entry_id }))
    .filter((x) => x.ready && x.entry_id)
    .map((x) => ({ json: x }));
}

function w3Resumo() {
  const s = $("Compare Jev × Claude").first().json.stats;
  const plan = $("Plan searches").first().json;
  return [{ json: {
    thinnest_categories: plan.thin,
    youtube_searches: plan.youtube.map((x) => x.q),
    substack_searches: SUBSTACK ? plan.substack.map((x) => x.q) : "not run in n8n: Substack blocks cloud servers, newsletters run from the local scripts",
    new_creators_vetted: s.evaluated,
    approved: s.approved,
    disputes_for_review: s.disputes,
    rejected: s.rejected,
    failed_evaluations: s.failed,
    jev_errors: s.jev_errors,
    claude_errors: s.claude_errors,
    first_error: s.first_error,
    ready_for_outreach: $("Compare Jev × Claude").all().filter((x) => x.json.ready).length,
    review_tasks_created: tentar(() => $("Pipeline entry").all().filter((x) => x.json.stage === "Sourced").length, 0),
    ...(SUBSTACK ? { substack: tentar(() => $("New publications").first().json.diag, "no diagnosis") } : {}),
    creators: s.results,
  } }];
  // A node that did not run in this execution throws when referenced (e.g. nothing to store)
  function tentar(f, padrao) { try { return f() ?? padrao; } catch { return padrao; } }
}

// Posições: as dos próprios nós, iguais ao que está importado no n8n do Michel (e aos prints do case)
const dir = new URL("../n8n/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("w1_brief_shortlist.json", dir), JSON.stringify(w1, null, 2));
writeFileSync(new URL("w2_outreach_sync.json", dir), JSON.stringify(w2, null, 2));
writeFileSync(new URL("w3_weekly_supply.json", dir), JSON.stringify(w3, null, 2));
console.log("gravados n8n/w1_brief_shortlist.json, n8n/w2_outreach_sync.json e n8n/w3_weekly_supply.json");
