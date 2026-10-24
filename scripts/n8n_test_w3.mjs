// Uso: node scripts/n8n_test_w3.mjs  (MERCADO=US para o turno americano)  (YouTube e Claude simulados; Substack, Jev e Attio de verdade; apaga o que criar no Attio)
// Executor local do W3: roda os nós na ordem das conexões, com o YouTube e o Claude simulados (sem gastar quota nem chave)
// e Substack, Jev e Attio de verdade. No fim apaga tudo que criou no Attio.
import { readFileSync } from "node:fs";
import { attio } from "file:///C:/Users/miche/projetos/Clay/scripts/attio_api.mjs";

const env = readFileSync("C:/Users/miche/projetos/Clay/.env", "utf8");
const JEV_KEY = env.match(/^TYPESAFE_API_KEY=(.+)$/m)[1].trim();
const w = JSON.parse(readFileSync("C:/Users/miche/projetos/Clay/n8n/w3_weekly_supply.json", "utf8"));
const node = (n) => w.nodes.find((x) => x.name === n);
const out = {};
const memoria = {};
const criados = [];

// Ordem: segue a cadeia principal a partir do gatilho
const ordem = [];
for (let n = "Every Monday"; n; n = w.connections[n]?.main[0]?.[0]?.node) ordem.push(n);
ordem.push("Run summary");

// Fixtures do YouTube a partir de um canal real do lote 5, com ids falsos (não colidem com quem já foi visto)
const estados = JSON.parse(readFileSync("C:/Users/miche/projetos/Clay/data/youtube_lote5_states.json", "utf8"));
const [, exemplo] = Object.entries(estados)[3];
const hoje = new Date().toISOString();
const ytFake = {
  search: () => ({ items: [{ snippet: { channelId: "UCteste_w3_1" } }, { snippet: { channelId: "UCteste_w3_2" } }] }),
  channels: () => ({ items: [
    { id: "UCteste_w3_1", snippet: { title: exemplo.canal + " (TESTE W3)", description: exemplo.descricao_do_canal + " linkedin.com/in/teste-w3", country: process.env.MERCADO ?? "BR", customUrl: "@testew3" },
      statistics: { subscriberCount: "42000" }, contentDetails: { relatedPlaylists: { uploads: "UUteste1" } } },
    { id: "UCteste_w3_2", snippet: { title: "Canal pequeno demais", description: "", country: process.env.MERCADO ?? "BR" }, statistics: { subscriberCount: "300" }, contentDetails: { relatedPlaylists: { uploads: "UUteste2" } } },
  ] }),
  playlistItems: () => ({ items: exemplo.ultimos_videos.map((v, i) => ({ snippet: { title: v.titulo, description: v.descricao },
    contentDetails: { videoId: "vid" + i, videoPublishedAt: new Date(Date.now() - i * 3 * 864e5).toISOString() } })) }),
  videos: () => ({ items: exemplo.ultimos_videos.map(() => ({ statistics: { viewCount: "4000" } })) }),
};

// Claude simulado: aprova a primeira, discorda da segunda (vira disputa), reprova a terceira em diante
let nClaude = 0;
const claudeFake = () => {
  const k = nClaude++;
  const r = { language_gate: true, e_creator: k !== 1, red_flags: [], fit_passionfroot: k >= 2 ? 1 : 4, qualidade: 4, prontidao_publi: 3, fit_regional: 4,
    categoria: "Tech & Negócios", rationale: "Simulated Claude answer for the local test." };
  return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(r) }] };
};

const getJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers });
  if (!res.ok) return { error: { status: res.status } };
  return res.json();
};
async function httpNode(nome, itens) {
  const res = [];
  for (const [i, it] of itens.entries()) {
    const j = it.json;
    const push = (json) => res.push({ json, pairedItem: { item: i } });
    switch (nome) {
      case "Attio · approved per category": push(await attio("POST", "objects/people/records/query", j.query)); break;
      case "YouTube · search": push(ytFake.search()); break;
      case "YouTube · channels": push(j.skip ? { error: "skip" } : ytFake.channels()); break;
      case "YouTube · last uploads": push(j.skip ? { error: "skip" } : ytFake.playlistItems()); break;
      case "YouTube · video stats": push(ytFake.videos()); break;
      case "Substack · search": push(await getJson(`https://substack.com/api/v1/top/search?query=${encodeURIComponent(j.q)}&limit=50`, { "User-Agent": "Mozilla/5.0" })); break;
      case "Substack · author profile": push(j.skip ? { error: "skip" } : await getJson(`https://substack.com/api/v1/user/${j.handle}/public_profile`, { "User-Agent": "Mozilla/5.0" })); break;
      case "Substack · recent posts": {
        if (j.skip) break;
        const posts = await getJson(`${j.base}/api/v1/archive?sort=new&limit=10`, { "User-Agent": "Mozilla/5.0" });
        for (const p of Array.isArray(posts) ? posts : []) push(p); // o n8n divide a lista em itens
        break;
      }
      case "Jev · rubric": {
        const r = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST",
          headers: { Authorization: `Bearer ${JEV_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(j.jev_request) });
        push(r.ok ? await r.json() : { error: { status: r.status, body: (await r.text()).slice(0, 200) } });
        break;
      }
      case "Claude · rubric": push(claudeFake()); break;
      case "Attio · create creator": {
        const r = await attio("POST", "objects/people/records", j.person);
        criados.push(r.data.id.record_id);
        push(r);
        break;
      }
      case "Attio · add to pipeline": push(await attio("POST", "lists/supply_pipeline/entries", j.request)); break;
      case "Attio · ready for outreach": push(await attio("PATCH", `lists/supply_pipeline/entries/${j.entry_id}`, { data: { entry_values: { stage: "Ready for outreach" } } })); break;
      default: throw new Error("HTTP sem simulação: " + nome);
    }
  }
  if (!res.length && node(nome).alwaysOutputData) res.push({ json: {}, pairedItem: { item: 0 } });
  return res;
}

function codeNode(nome, itens) {
  let js = node(nome).parameters.jsCode;
  // MERCADO=US força o turno americano (o W3 alterna os mercados por semana)
  if (process.env.MERCADO) js = js.split("const FORCE_MARKET = null;").join(`const FORCE_MARKET = "${process.env.MERCADO}";`);
  if (nome === "New publications") js = js.replace("const MAX_NL = 15;", "const MAX_NL = 2;"); // teste barato: 2 newsletters
  if (nome === "Subscriber filter") js = js.replace("const MAX_NL = 15;", "const MAX_NL = 2;");
  const $ = (n) => ({ all: () => out[n] ?? [], first: () => (out[n] ?? [])[0] });
  const $input = { all: () => itens, first: () => itens[0] };
  const fn = new Function("$", "$input", "$json", "$getWorkflowStaticData", js);
  return (fn($, $input, itens[0]?.json, () => memoria) ?? []).map((x, i) => ({ pairedItem: { item: i }, ...x }));
}

try {
  let entrada = [{ json: {} }];
  for (const nome of ordem) {
    const n = node(nome);
    if (nome === "Run summary") entrada = out["Attio · add to pipeline"];
    if (!entrada?.length) { console.log(`${nome}: sem itens, a cadeia para aqui`); break; }
    const t0 = Date.now();
    const saida = n.disabled ? entrada
      : n.type === "n8n-nodes-base.scheduleTrigger" ? [{ json: {} }]
      : n.type === "n8n-nodes-base.if" ? entrada.filter((x) => !x.json.nothing_to_store)
      : n.type === "n8n-nodes-base.code" ? codeNode(nome, entrada)
      : await httpNode(nome, entrada);
    out[nome] = saida;
    console.log(`${nome}: ${entrada.length} → ${saida.length} itens (${Date.now() - t0} ms)${n.disabled ? " [desligado, só passa]" : ""}`);
    entrada = saida;
  }
  const plano = out["Plan searches"][0].json;
  console.log("\ncategorias mais finas:", JSON.stringify(plano.thin), "\nbuscas YouTube:", plano.youtube.map((x) => x.q), "\nbuscas Substack:", plano.substack.map((x) => x.q));
  for (const c of out["All new creators"] ?? []) console.log("candidato:", c.json.platform, "|", c.json.name, "| portão 30d:", c.json.gate30d, "| objetivas:", JSON.stringify(c.json.objective), "| rota de contato:", c.json.contact_route);
  for (const [i, j] of (out["Jev · rubric"] ?? []).entries()) console.log("Jev", i, j.json.error ? "ERRO " + JSON.stringify(j.json.error) : "ok: fit " + j.json.answers?.fit_passionfroot?.score + ", categoria " + j.json.answers?.categoria?.choice);
  for (const c of out["Compare Jev × Claude"] ?? []) console.log("veredito:", c.json.person.data.values.name[0].full_name, "→", c.json.person.data.values.verdict, "| estágio:", c.json.stage, "| ready:", c.json.ready, "| motivo:", c.json.person.data.values.dispute_reason ?? "-");
  console.log("\nresumo:", JSON.stringify(out["Run summary"]?.[0]?.json, null, 1));
  console.log("memória do workflow:", { canais: memoria.seenChannels?.length, newsletters: memoria.seenPubs?.length });
} finally {
  for (const id of criados) await attio("DELETE", `objects/people/records/${id}`);
  console.log(`limpeza: ${criados.length} registros de teste apagados do Attio`);
}
