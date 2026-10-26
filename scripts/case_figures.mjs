// Monta a seção "In the tools" do creators.html a partir das fontes reais:
// os JSONs dos workflows do n8n (n8n/*.json), o workflow da Clay (CLI, grátis) e o retrato do Apollo e do Attio
// (data/case_snapshot.json, de scripts/case_snapshot.mjs). Escreve entre <!-- TOOLS:START --> e <!-- TOOLS:END -->
// e copia os JSONs dos workflows para o portfólio, para o recrutador baixar e importar.
// Uso: node scripts/case_figures.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// O portfólio fica ao lado deste projeto (../portfolio)
const PORTFOLIO = fileURLToPath(new URL("../../portfolio/", import.meta.url)).split("\\").join("/");
const PAGINA = PORTFOLIO + "creators.html";
const N8N = new URL("../n8n/", import.meta.url);
const snap = JSON.parse(readFileSync(new URL("../data/case_snapshot.json", import.meta.url), "utf8"));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Texto bilíngue no padrão da página: português no conteúdo, inglês no data-en
const bi = (tag, en, pt, attrs = "") => `<${tag}${attrs} data-en="${esc(en)}">${esc(pt)}</${tag}>`;

// ---------- Canvas de workflow em SVG (posições reais do n8n, escala menor) ----------
const W = 200, H = 64, ESCALA = 0.8, PAD = 24;
function quebra(texto, max = 24) {
  const linhas = [];
  let atual = "";
  for (const p of String(texto).split(" ")) {
    if ((atual + " " + p).trim().length > max && atual) { linhas.push(atual); atual = p; } else atual = (atual + " " + p).trim();
  }
  if (atual) linhas.push(atual);
  return linhas.slice(0, 2);
}
const SERVICOS = ["Attio", "Apollo", "Claude", "Jev", "YouTube", "Substack", "Clay"];
function rotulo(no) {
  const servico = SERVICOS.find((s) => no.name.startsWith(s + " ·"));
  const tipo = { formTrigger: "Form trigger", scheduleTrigger: "Schedule", webhook: "Webhook", code: "Code", if: "If", httpRequest: "HTTP" }[no.type.split(".").pop()] ?? no.kind ?? "Node";
  return (servico ? `${tipo} · ${servico}` : tipo) + (no.disabled ? " · disabled" : "");
}
function canvas(id, wf, aria) {
  const nos = wf.nodes.filter((n) => n.type !== "n8n-nodes-base.stickyNote");
  const xs = nos.map((n) => n.position[0]), ys = nos.map((n) => n.position[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const pos = Object.fromEntries(nos.map((n) => [n.name, [(n.position[0] - x0) * ESCALA + PAD, (n.position[1] - y0) * ESCALA + PAD]]));
  const largura = Math.max(...Object.values(pos).map((p) => p[0])) + W + PAD;
  const altura = Math.max(...Object.values(pos).map((p) => p[1])) + H + PAD;
  const linhas = [];
  for (const [origem, saida] of Object.entries(wf.connections)) {
    (saida.main ?? []).forEach((alvos, porta) => {
      for (const { node: destino } of alvos) {
        const [sx, sy] = pos[origem], [tx, ty] = pos[destino];
        let d, rot;
        if (Math.abs(ty - sy) < 1) { d = `M${sx + W} ${sy + H / 2} H${tx - 2}`; rot = [sx + W + 4, sy + H / 2 - 5]; } // mesma fileira
        else if (ty - sy > 200 * ESCALA * 1.5) { d = `M${sx + W} ${sy + H / 2} h18 V${ty + H / 2} H${tx + W + 2}`; rot = [sx + W + 4, sy + H / 2 - 5]; } // pula fileiras: pela lateral
        else { const meio = ty - (200 * ESCALA - H) / 2; d = `M${sx + W / 2} ${sy + H} V${meio} H${tx + W / 2} V${ty - 2}`; rot = [sx + W / 2 + 6, sy + H + 13]; } // próxima fileira
        linhas.push(`<path d="${d}" class="cv-edge" marker-end="url(#seta-${id})"/>`);
        const no = wf.nodes.find((n) => n.name === origem);
        // Saídas do IF: o rótulo fica onde a seta sai do nó
        if (no.type?.endsWith(".if")) linhas.push(`<text x="${rot[0]}" y="${rot[1]}" class="cv-port">${porta ? "false" : "true"}</text>`);
      }
    });
  }
  const caixas = nos.map((n) => {
    const [x, y] = pos[n.name];
    const gatilho = /Trigger|webhook|trigger/.test(n.type) || n.kind === "trigger";
    const nome = quebra(n.name).map((l, i) => `<text x="${x + 12}" y="${y + 38 + i * 15}" class="cv-name">${esc(l)}</text>`).join("");
    return `<g><rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10" class="cv-node${gatilho ? " is-trigger" : ""}${n.disabled ? " is-off" : ""}"/>`
      + `<text x="${x + 12}" y="${y + 19}" class="cv-kind">${esc(rotulo(n))}</text>${nome}</g>`;
  }).join("");
  return `<div class="cv-scroll"><svg class="cv" viewBox="0 0 ${Math.ceil(largura)} ${Math.ceil(altura)}" width="${Math.ceil(largura)}" role="img" aria-label="${esc(aria)}">`
    + `<defs><marker id="seta-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="cv-head"/></marker></defs>`
    + linhas.join("") + caixas + `</svg></div>`;
}
const notas = (wf) => wf.nodes.filter((n) => n.type === "n8n-nodes-base.stickyNote").map((n) => {
  const [titulo, ...resto] = n.parameters.content.split("\n");
  const corpo = resto.join(" ").replace(/\*\*|\*/g, "").replace(/\s+/g, " ").trim();
  return `<div class="card"><b>${esc(titulo.replace(/^#+\s*/, ""))}</b><p>${esc(corpo)}</p></div>`;
}).join("");

// ---------- n8n ----------
const ler = (f) => JSON.parse(readFileSync(new URL(f, N8N), "utf8"));
const w1 = ler("w1_brief_shortlist.json"), w2 = ler("w2_outreach_sync.json"), w3 = ler("w3_weekly_supply.json");
mkdirSync(PORTFOLIO + "creators-n8n", { recursive: true });
for (const f of ["w1_brief_shortlist.json", "w2_outreach_sync.json", "w3_weekly_supply.json"]) copyFileSync(new URL(f, N8N), PORTFOLIO + "creators-n8n/" + f);
const baixar = (f) => `<a class="jump" href="creators-n8n/${f}" download data-en="Download the workflow JSON (import it into n8n) ↓">Baixar o JSON do workflow (importa no n8n) ↓</a>`;
// Prints reais das ferramentas, tirados pelo Michel (portfolio/creators-img/); clicar abre no tamanho original
const print = (arquivo, alt, en, pt) => `<figure class="tl-shot"><a href="creators-img/${arquivo}" target="_blank" rel="noopener"><img src="creators-img/${arquivo}" alt="${esc(alt)}" loading="lazy"></a>${bi("figcaption", en, pt)}</figure>`;
const PRINTS = { w1: "n8n-w1.png", w2: "n8n-w2.png", w3: "n8n-w3.png" };
const painelN8n = (id, wf, arquivo, en, pt) => `
    <div class="panel" role="tabpanel" id="p-tl-${id}" aria-labelledby="t-tl-${id}"${id === "w1" ? "" : " hidden"}>
      <div class="panel-note">${bi("span", en, pt)}</div>
      ${print(PRINTS[id], `${wf.name} in the n8n editor: ${wf.nodes.filter((n) => n.type !== "n8n-nodes-base.stickyNote").map((n) => n.name).join(", ")}`, "Screenshot from the n8n editor. Click to enlarge.", "Print do editor do n8n. Clique para ampliar.")}
      ${notas(wf) ? `<div class="cards">${notas(wf)}</div>` : ""}
      ${baixar(arquivo)}
    </div>`;

// ---------- Clay (workflow real, lido pela CLI) ----------
const clay = JSON.parse(execFileSync("clay", ["workflows", "graph", "get", "wf_0tnc4d8apC5Jjh3wfss", "--mode", "full"], { encoding: "utf8", shell: true }));
const cnos = clay.summary.nodes;
const ordem = [];
for (let atual = cnos.find((n) => n.nodeType === "trigger"); atual; atual = cnos.find((n) => n.id === clay.summary.edges.find((e) => e.sourceNodeId === atual.id)?.targetNodeId)) ordem.push(atual);
const detalhe = Object.fromEntries(clay.nodes.map((n) => [n.name, n]));
const clayWf = {
  name: clay.summary.workflowName,
  nodes: ordem.map((n, i) => ({ name: n.name, type: "clay." + n.nodeType, kind: { trigger: "Trigger · CSV upload", tool: "Clay action", conditional: "Conditional · rules" }[n.nodeType], position: [i * 260, 0] })),
  connections: Object.fromEntries(ordem.slice(0, -1).map((n, i) => [n.name, { main: [[{ node: ordem[i + 1].name }]] }])),
};
const regra = detalhe[ordem.find((n) => n.nodeType === "conditional")?.name]?.rulesConditionalConfig;
const painelClay = `
    <div class="panel" role="tabpanel" id="p-tl-clay" aria-labelledby="t-tl-clay" hidden>
      <div class="panel-note">${bi("span", `“${clay.summary.workflowName}”, read from Clay through its CLI. A CSV of LinkedIn URLs starts one run per row. It ran for Brazil. The US is the same workflow with the country rule set to United States, left out on the free plan: 100 search results a month, about 3.5 credits per profile once posts are read, and the Brazilian batch used half the search quota.`, `“${clay.summary.workflowName}”, lido da Clay pela CLI. Um CSV de URLs do LinkedIn dispara uma rodada por linha. Rodou para o Brasil. Os EUA são o mesmo workflow com a regra de país em Estados Unidos, deixados de fora no plano gratuito: 100 resultados de busca por mês, uns 3,5 créditos por perfil quando os posts são lidos, e o lote brasileiro usou metade da quota de busca.`)}</div>
      ${existsSync(PORTFOLIO + "creators-img/clay-workflow.png")
        ? print("clay-workflow.png", `${clay.summary.workflowName} in the Clay editor: ${ordem.map((n) => n.name).join(", ")}`, "Screenshot from the Clay editor (click to enlarge). Each run goes CSV → enrich → the Brazil, 5k+ filter → posts; the canvas just draws the filter last.", "Print do editor da Clay (clique para ampliar). Cada rodada vai do CSV ao enrich, ao filtro Brasil, 5 mil+, e aos posts; o canvas só desenha o filtro por último.")
        : canvas("clay", clayWf, `${clay.summary.workflowName}: ${ordem.map((n) => n.name).join(", then ")}`)}
      <div class="cards">${ordem.filter((n) => detalhe[n.name]?.description).map((n) => `<div class="card"><b>${esc(n.name)}</b><p>${esc(detalhe[n.name].description)}</p></div>`).join("")}</div>
      ${regra ? `<p class="tl-code"><span data-en="Rule in the conditional node:">Regra do nó condicional:</span> followers ≥ ${regra.rules[0].condition.items.find((x) => x.dataPath?.[0] === "num_followers")?.value} AND (country = Brazil OR location contains Brazil OR location contains São Paulo) · ${regra.endRunOnNoMatch ? "no match ends the run" : ""}</p>` : ""}
    </div>`;

// ---------- Apollo (sequências-modelo e campos) ----------
// Uma sub-aba por sequência (YouTube, Newsletter, LinkedIn e a call de onboarding), cada uma passo a passo.
const TIPO = { linkedin_step_view_profile: ["LinkedIn", "View profile"], linkedin_step_connect: ["LinkedIn", "Connection request"], auto_email: ["Email", "Automatic email"], linkedin_step_message: ["LinkedIn", "Message"], call: ["Phone", "Call"], manual_email: ["Email", "Manual email"], action_item: ["Task", "Manual task"] };
// Tarefa manual de DM no Instagram aparece como Instagram
const tipo = (s) => s.type === "action_item" && /^Instagram/.test(s.note ?? "") ? ["Instagram", "DM (manual task)"] : TIPO[s.type] ?? ["Step", s.type];
const seqs = snap.apollo.sequences;
const plataforma = (nome) => nome.replace(/^\[TEMPLATE — do not send\] Passionfroot · /, "").replace(/ creators$/, "");
// Condição curta do passo ("Only if…") vai na seta; o texto da mensagem vai na caixa
const condicao = (s) => /^Only if/.test(s.note ?? "") ? s.note.replace(/\.$/, "").replace(/^Only if/, "only if").split(".")[0] : "";
const fluxo = (q) => q.steps.map((s, i) => {
  const [canal, acao] = tipo(s);
  const dias = i ? s.day - q.steps[i - 1].day : 0;
  const seta = i ? `<li class="fc-edge"><span>+${dias} day${dias === 1 ? "" : "s"}${condicao(s) ? ` · ${esc(condicao(s))}` : ""}</span></li>` : "";
  const texto = s.subject ? `Subject: ${s.subject}` : s.text && s.text !== "View profile" ? s.text.slice(0, 150) + (s.text.length > 150 ? "…" : "") : s.note ?? "";
  return `${seta}<li class="fc-node"><b>Day ${s.day} · ${esc(acao)}</b>${texto ? `<small>${esc(texto)}</small>` : ""}<span class="fc-tool">${esc(canal)}</span></li>`;
}).join("\n          ");
const id = (q) => "ap-" + plataforma(q.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const ativas = seqs.filter((q) => q.active).length, contatos = seqs.reduce((t, q) => t + q.contacts, 0);
const painelApollo = `
    <div class="panel" role="tabpanel" id="p-tl-apollo" aria-labelledby="t-tl-apollo" hidden>
      <div class="panel-note"><span class="tag">${seqs.length} sequences</span><span class="tag">${ativas ? `${ativas} active` : "Inactive"}</span><span class="tag">${contatos} contacts</span><span class="tag">No mailbox</span>${bi("span", "Template sequences in Apollo, shown as screenshots and read from its API: one outreach sequence per platform, which workflow 2 picks from the creator’s platform in Attio, and the onboarding call for the largest creators after they sign up. Written as if I worked at Passionfroot; never sent.", "Sequências-modelo no Apollo, em prints e lidas pela API: uma de outreach por plataforma, que o workflow 2 escolhe pela plataforma do creator no Attio, e a da call de onboarding para os maiores creators depois do cadastro. Escrito como se eu trabalhasse na Passionfroot; nunca enviado.")}</div>
      <div class="tabs tabs-sub" role="tablist" aria-label="Apollo sequences">
        ${seqs.map((q, i) => `<button role="tab" id="t-${id(q)}" aria-controls="p-${id(q)}" aria-selected="${i === 0}">${esc(plataforma(q.name))}</button>`).join("\n        ")}
      </div>
      ${seqs.map((q, i) => `<div class="panel" role="tabpanel" id="p-${id(q)}" aria-labelledby="t-${id(q)}"${i ? " hidden" : ""}>
        ${bi("p", `“${q.name}” · ${q.steps.length} steps over ${q.steps.at(-1).day} days`, `“${q.name}” · ${q.steps.length} passos em ${q.steps.at(-1).day} dias`, ' class="tl-code"')}
        ${existsSync(PORTFOLIO + `creators-img/apollo-${id(q).slice(3)}.png`) ? print(`apollo-${id(q).slice(3)}.png`, `${q.name} in the Apollo sequence editor`, "Screenshot from the Apollo editor (click to enlarge). Below, the same steps with the full text, from the API.", "Print do editor do Apollo (clique para ampliar). Abaixo, os mesmos passos com o texto, pela API.") : ""}
        <ol class="fc" aria-label="Apollo sequence for ${esc(plataforma(q.name))}, ${q.steps.length} steps over ${q.steps.at(-1).day} days">
          ${fluxo(q)}
        </ol>
      </div>`).join("\n      ")}
      <div class="tl-row">${bi("b", "Custom contact fields, filled from Attio", "Campos personalizados do contato, preenchidos pelo Attio")}<div class="tags">${snap.apollo.custom_fields.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div></div>
    </div>`;

// ---------- Attio (pipeline, registro, deal, task, schema) ----------
const ORDEM = ["Sourced", "Vetted", "Ready for outreach", "Contacted", "Replied", "Signed up", "Call", "Campaign-ready", "Rejected"];
const pipe = ORDEM.map((s) => snap.attio.pipeline.find((p) => p.stage === s)).filter(Boolean);
const ex = snap.attio.example_creator;
const TITULOS = { platform: "Platform", main_link: "Main link", passionfroot_category: "Passionfroot category", audience: "Audience", final_score: "Final score", passionfroot_fit: "Passionfroot fit", verdict: "Verdict", decided_by: "Decided by", rate_card_usd: "Rate card (US$)", batch: "Sourcing batch", vetting_rationale: "Vetting rationale", content_summary: "Content summary" };
const linhasEx = Object.entries(ex.values).filter(([, v]) => v != null).map(([k, v]) => `<tr><th>${TITULOS[k]}</th><td>${esc(typeof v === "number" ? v.toLocaleString("en-US") : String(v).slice(0, 260) + (String(v).length > 260 ? "…" : ""))}</td></tr>`).join("");
const dl = snap.attio.deal;
// Exemplo negativo (disputa, red flag) não identifica o creator na página pública
const anonimiza = (texto) => String(texto)
  .replace(/^Decide: .+? \((YouTube|LinkedIn|Newsletter)\)/, "Decide: [creator] ($1)")
  .replace(/https?:\/\/\S+/g, "[channel link]");
const painelAttio = `
    <div class="panel" role="tabpanel" id="p-tl-attio" aria-labelledby="t-tl-attio" hidden>
      <div class="panel-note">${bi("span", `The Supply pipeline list in Attio, ${snap.attio.creators} creators: ${pipe.filter((p) => p.count).map((p) => `${p.stage} ${p.count}`).join(", ")}.`, `A lista Supply pipeline no Attio, ${snap.attio.creators} creators: ${pipe.filter((p) => p.count).map((p) => `${p.stage} ${p.count}`).join(", ")}.`)}</div>
      ${print("attio-pipeline.png", `Attio Supply pipeline board: ${pipe.map((p) => `${p.stage} ${p.count}`).join(", ")}`, "Screenshot of the board in Attio (click to enlarge). The record, deal and task below come from the Attio API.", "Print do quadro no Attio (clique para ampliar). O registro, o deal e a task abaixo vêm da API do Attio.")}
      <div class="tl-grid">
        <div class="card"><b data-en="A creator record">Um registro de creator</b><strong style="font-size:1.1rem">${esc(ex.name)}</strong><table class="tl-table">${linhasEx}</table></div>
        <div class="tl-stack">
          <div class="card"><b data-en="A brief, as a deal">Um brief, como deal</b><strong style="font-size:1.1rem">${esc(dl.name)}</strong><table class="tl-table">
            <tr><th>Stage</th><td>${esc(dl.stage)}</td></tr><tr><th>Value</th><td>US$${dl.value?.toLocaleString("en-US")}</td></tr><tr><th>Budget (US$)</th><td>${dl.budget?.toLocaleString("en-US")}</td></tr>
            <tr><th>Target categories</th><td>${esc(dl.categories?.join(", "))}</td></tr><tr><th>Brief source</th><td>${esc(dl.brief_source)}</td></tr><tr><th>People</th><td>${dl.people} creators</td></tr></table>
            <p><b class="tl-mini">Note · ${esc(dl.note_title)}</b><br>${esc((dl.note_head ?? []).filter(Boolean).slice(0, 4).join(" ").slice(0, 420))}…</p></div>
          ${snap.attio.task ? `<div class="card"><b data-en="A review task, created by workflow 3">Uma task de revisão, criada pelo workflow 3</b><p>${esc(anonimiza(snap.attio.task.content))}</p><p class="tl-mini">Due ${esc(snap.attio.task.deadline)} · assigned to Michel</p></div>` : ""}
        </div>
      </div>
      <div class="tl-row">${bi("b", "Attributes added to People", "Atributos criados em People")}<div class="tags">${snap.attio.schema.people.map((a) => `<span class="tag">${esc(a.title)}</span>`).join("")}</div></div>
      <div class="tl-row">${bi("b", "On Deals (briefs) and on the pipeline list", "Em Deals (briefs) e na lista do pipeline")}<div class="tags">${[...snap.attio.schema.deals, ...snap.attio.schema.list].map((a) => `<span class="tag">${esc(a.title)}</span>`).join("")}</div></div>
    </div>`;

// ---------- Seção ----------
const data = new Date(snap.taken_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dataPt = new Date(snap.taken_at).toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
const abas = [["w1", "n8n · W1 brief"], ["w3", "n8n · W3 weekly"], ["w2", "n8n · W2 outreach"], ["clay", "Clay"], ["apollo", "Apollo"], ["attio", "Attio"]];
const secao = `<!-- TOOLS:START (gerado por scripts/case_figures.mjs no projeto Clay; não editar à mão) -->
  <section id="tools">
    <div class="sec-head">
      <span class="eyebrow" data-en="Under the hood">Por dentro</span>
      <h2 class="display" data-en="In the&lt;br&gt;tools">Nas<br>ferramentas</h2>
      ${bi("p", `What each tool actually holds, drawn from the real configuration: the n8n workflow files, the Clay workflow read through its CLI, and the Apollo and Attio APIs. Snapshot from ${data}.`, `O que cada ferramenta tem de verdade, desenhado da configuração real: os arquivos dos workflows do n8n, o workflow da Clay lido pela CLI e as APIs do Apollo e do Attio. Retrato de ${dataPt}.`, ' class="serif"')}
      <a class="jump" href="https://github.com/michelxxx2323/creator-supply-engine" target="_blank" rel="noopener" data-en="All the code on GitHub ↗">Todo o código no GitHub ↗</a>
    </div>
    <div class="tabs" role="tablist" aria-label="Ferramentas" data-en-label="Tools">
      ${abas.map(([id, nome], i) => `<button role="tab" id="t-tl-${id}" aria-controls="p-tl-${id}" aria-selected="${i === 0}">${nome}</button>`).join("\n      ")}
    </div>
${painelN8n("w1", w1, "w1_brief_shortlist.json", "Workflow 1, stage A: the 15 nodes as they sit in n8n. A form starts it; the summary at the end is what the campaign manager sees.", "Workflow 1, etapa A: os 15 nós como ficam no n8n. Um formulário dispara; o resumo no fim é o que o campaign manager vê.")}
${painelN8n("w3", w3, "w3_weekly_supply.json", "Workflow 3, stage B: 33 nodes and 3 notes. A schedule starts it every Monday; the Clay node is disabled on the free plan.", "Workflow 3, etapa B: 33 nós e 3 notas. Um agendamento dispara toda segunda; o nó da Clay fica desligado no plano gratuito.")}
${painelN8n("w2", w2, "w2_outreach_sync.json", "Workflow 2, stage B: an Attio webhook starts it. Imported, never activated.", "Workflow 2, etapa B: um webhook do Attio dispara. Importado, nunca ativado.")}
${painelClay}
${painelApollo}
${painelAttio}
    <dialog class="tl-zoom" aria-label="Screenshot, full size">
      <button type="button" class="tl-zoom-close" aria-label="Close">×</button>
      <div class="tl-zoom-body"><img alt=""></div>
    </dialog>
    <script>
    /* Clique para ampliar: o print abre por cima da página no tamanho original, com rolagem; Esc, clique fora ou × fecham.
       Sem JavaScript, o link abre a imagem numa aba nova. */
    (function(){
      var d = document.querySelector(".tl-zoom");
      if (!d || !d.showModal) return;
      var img = d.querySelector("img");
      document.querySelectorAll(".tl-shot a").forEach(function(a){
        a.addEventListener("click", function(e){
          e.preventDefault();
          var src = a.querySelector("img");
          img.src = a.href; img.alt = src.alt;
          d.showModal();
        });
      });
      d.querySelector(".tl-zoom-close").addEventListener("click", function(){ d.close(); });
      d.addEventListener("click", function(e){ if (e.target === d) d.close(); });
    })();
    </script>
  </section>
  <!-- TOOLS:END -->`;

const CSS = `/* Seção "In the tools": canvas de workflow, quadro do Attio */
.cv-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:var(--r);background:var(--sunk);padding:8px}
.cv{display:block;height:auto;max-width:none}
.cv-node{fill:var(--surface);stroke:var(--line);stroke-width:1.2}
.cv-node.is-trigger{stroke:var(--accent);stroke-width:1.6}
.cv-node.is-off{stroke-dasharray:5 4;opacity:.7}
.cv-kind{font:500 10px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;fill:var(--muted)}
.cv-name{font:500 12.5px var(--f-body);fill:var(--fg)}
.cv-edge{fill:none;stroke:var(--muted);stroke-width:1.3}
.cv-head{fill:var(--muted)}
.cv-port{font:500 9.5px var(--f-mono);fill:var(--accent-ink)}
.tl-code{font:500 .78rem/1.5 var(--f-mono);color:var(--muted);max-width:960px}
.tl-shot{margin:0;display:grid;gap:8px}
.tl-shot img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:var(--r);background:#fff}
.tl-shot figcaption{font-size:.8rem;color:var(--muted)}
.tl-shot a{display:block;cursor:zoom-in}
.tl-zoom{padding:0;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);max-width:96vw;max-height:92vh;width:max-content;overflow:hidden}
.tl-zoom::backdrop{background:rgba(0,0,0,.7)}
.tl-zoom-body{max-width:96vw;max-height:92vh;overflow:auto}
.tl-zoom-body img{display:block;max-width:none;height:auto;background:#fff}
.tl-zoom-close{position:absolute;top:8px;right:8px;width:36px;height:36px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--fg);font-size:1.3rem;line-height:1;cursor:pointer}
.tl-row{display:grid;gap:10px;max-width:960px}
.tl-row > b,.tl-mini{font:500 .7rem/1.2 var(--f-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--accent-ink)}
.tl-board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(168px,1fr);gap:10px;overflow-x:auto;padding-bottom:6px}
.tl-col{background:var(--sunk);border:1px solid var(--line);border-radius:12px;padding:10px;display:grid;gap:8px;align-content:start;min-height:120px}
.tl-col-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.tl-col-head b{font-size:.82rem;font-weight:600}
.tl-col-head span{font:600 .9rem var(--f-display);font-variant-numeric:tabular-nums}
.tl-card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:grid;gap:2px}
.tl-card b{font-size:.8rem;font-weight:600;line-height:1.3}
.tl-card small{font-size:.72rem;color:var(--muted)}
.tl-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px;max-width:960px}
.tl-stack{display:grid;gap:14px;align-content:start}
.tl-table{border-collapse:collapse;font-size:.84rem;width:100%}
.tl-table th{text-align:left;font-weight:500;color:var(--muted);padding:6px 12px 6px 0;vertical-align:top;white-space:nowrap}
.tl-table td{padding:6px 0;border-top:1px solid var(--line);word-break:break-word}
.tl-table tr:first-child td{border-top:0}
@media (max-width:760px){.tl-grid{grid-template-columns:1fr}.tl-table th{white-space:normal}}
/* /tools */`;

// ---------- Mapa de gaps: aprovados por categoria e mercado (B2B x estudantes e início de carreira) ----------
// Brasil e EUA na mesma escala e na mesma ordem de categorias (a do Brasil), para comparar os dois mercados
const gapsBR = snap.gaps.Brazil, gapsUS = snap.gaps["United States"];
const ordemCat = gapsBR.map((g) => g.category);
const maxGap = Math.max(...gapsBR.map((g) => g.approved), ...gapsUS.map((g) => g.approved));
const pct = (n) => ((100 * n) / maxGap).toFixed(2) + "%";
const total = (gs, k) => gs.reduce((t, g) => t + g[k], 0);
const linhas = (gs, mercado) => ordemCat.map((cat) => {
  const g = gs.find((x) => x.category === cat) ?? { category: cat, approved: 0, b2b: 0 };
  const outros = g.approved - g.b2b;
  const seg = (n, cls, en) => (n ? `<span class="gp-seg ${cls}" style="width:${pct(n)}" tabindex="0" data-tip="${esc(`${mercado} · ${g.category} · ${en}: ${n}`)}" aria-label="${esc(`${mercado}, ${g.category}, ${en}: ${n}`)}"></span>` : "");
  return `<div class="gp-row" role="listitem"><span class="gp-label">${esc(g.category)}</span><div class="gp-track">${seg(g.b2b, "is-b2b", "B2B audience")}${seg(outros, "is-pro", "students and early career")}</div><span class="gp-val">${g.approved}</span></div>`;
}).join("\n          ");
const bloco = (gs, mercado, pt, nota) => `<div class="gp-market">
        <h3 class="gp-title">${bi("span", `${mercado} · ${total(gs, "approved")} approved, ${total(gs, "b2b")} B2B`, `${pt} · ${total(gs, "approved")} aprovados, ${total(gs, "b2b")} B2B`)}</h3>
        <div class="gp-rows" role="list" aria-label="Approved creators by category, ${mercado}">
          ${linhas(gs, mercado)}
        </div>
        ${nota}
      </div>`;
const fino = gapsBR.at(-1), largo = gapsBR[0];
const prod = gapsBR.find((g) => g.category === "Productivity & Personal Development");
const usFinos = [...gapsUS].sort((a, b) => a.approved - b.approved).slice(0, 3).map((g) => g.category);
const leituraEn = `Brazil: ${fino.category} has ${fino.approved} approved creators against ${largo.approved} in ${largo.category}, and Productivity has ${prod?.approved} but only ${prod?.b2b} with a B2B audience. United States: the first round, from ${snap.attio.creators_by_market["United States"]} creators sourced; ${usFinos.join(", ")} are the thinnest. The weekly workflow searches the thinnest categories of each market first.`;
const leituraPt = `Brasil: ${fino.category} tem ${fino.approved} creators aprovados contra ${largo.approved} em ${largo.category}, e Produtividade tem ${prod?.approved}, mas só ${prod?.b2b} com público B2B. EUA: a primeira rodada, de ${snap.attio.creators_by_market["United States"]} creators encontrados; ${usFinos.join(", ")} são as mais finas. O workflow semanal busca primeiro nas categorias mais finas de cada mercado.`;
const tabela = (gs, mercado) => gs.map((g) => `<tr><td>${esc(mercado)}</td><td>${esc(g.category)}</td><td>${g.approved}</td><td>${g.b2b}</td><td>${g.approved - g.b2b}</td></tr>`).join("");
const secaoGaps = `<!-- GAPS:START (gerado por scripts/case_figures.mjs no projeto Clay; não editar à mão) -->
  <section id="gaps">
    <div class="sec-head">
      <span class="eyebrow" data-en="Where supply is thin">Onde falta supply</span>
      <h2 class="display" data-en="The gap&lt;br&gt;map">O mapa<br>de gaps</h2>
      ${bi("p", `Approved creators by Passionfroot category and market, live from Attio (${snap.attio.creators} creators in the pipeline: ${snap.attio.creators_by_market.Brazil} in Brazil, ${snap.attio.creators_by_market["United States"]} in the US). A B2B audience means a fit of 3.5 or more on the rubric.`, `Creators aprovados por categoria da Passionfroot e por mercado, ao vivo do Attio (${snap.attio.creators} creators no pipeline: ${snap.attio.creators_by_market.Brazil} no Brasil, ${snap.attio.creators_by_market["United States"]} nos EUA). Público B2B quer dizer fit de 3,5 ou mais na rubrica.`, ' class="serif"')}
    </div>
    <figure class="gp">
      <div class="gp-legend"><span><i class="gp-sw is-b2b"></i>${bi("span", "B2B audience (fit ≥ 3.5)", "Público B2B (fit ≥ 3,5)")}</span><span><i class="gp-sw is-pro"></i>${bi("span", "Students and early career", "Estudantes e início de carreira")}</span></div>
      <div class="gp-markets">
      ${bloco(gapsBR, "Brazil", "Brasil", "")}
      ${bloco(gapsUS, "United States", "Estados Unidos", "")}
      </div>
      ${bi("figcaption", leituraEn, leituraPt)}
      <details class="gp-table"><summary data-en="Table view">Ver em tabela</summary>
        <table class="tl-table"><tr><th>Market</th><th>Category</th><th>Approved</th><th>B2B audience</th><th>Students and early career</th></tr>
        ${tabela(gapsBR, "Brazil")}${tabela(gapsUS, "United States")}</table>
      </details>
    </figure>
  </section>
  <!-- GAPS:END -->`;
const CSS_GAPS = `/* Mapa de gaps (cores validadas com o validador de paleta, claro e escuro) */
:root{--gp-b2b:#C46F00;--gp-pro:#3B6FC4}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--gp-b2b:#CC7712;--gp-pro:#5A8BE0}}
:root[data-theme="dark"]{--gp-b2b:#CC7712;--gp-pro:#5A8BE0}
.gp{margin:0;display:grid;gap:16px;max-width:860px}
.gp-legend{display:flex;flex-wrap:wrap;gap:8px 20px;font-size:.84rem;color:var(--muted)}
.gp-legend > span{display:inline-flex;align-items:center;gap:8px}
.gp-sw{width:12px;height:12px;border-radius:3px;display:inline-block}
.gp-sw.is-b2b,.gp-seg.is-b2b{background:var(--gp-b2b)}
.gp-sw.is-pro,.gp-seg.is-pro{background:var(--gp-pro)}
.gp-markets{display:grid;gap:28px}
.gp-title{margin:0 0 10px;font:600 .9rem var(--f-body);color:var(--fg)}
.gp-rows{display:grid;gap:8px}
.gp-row{display:grid;grid-template-columns:minmax(120px,15rem) 1fr 3rem;align-items:center;gap:12px}
.gp-label{font-size:.86rem;color:var(--fg)}
.gp-track{display:flex;gap:2px;height:18px}
.gp-seg{position:relative;height:100%;outline-offset:2px}
.gp-seg:last-child{border-radius:0 4px 4px 0}
.gp-seg:hover,.gp-seg:focus-visible{filter:brightness(1.12)}
.gp-seg:hover::after,.gp-seg:focus-visible::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:0;white-space:nowrap;background:var(--fg);color:var(--bg);font:500 .72rem/1 var(--f-mono);padding:6px 8px;border-radius:6px;z-index:2;pointer-events:none}
.gp-val{font:600 .9rem var(--f-display);font-variant-numeric:tabular-nums;color:var(--fg)}
.gp figcaption{font-size:.9rem;color:var(--muted);max-width:72ch}
.gp-table summary{cursor:pointer;font-size:.84rem;color:var(--muted)}
@media (max-width:560px){.gp-row{grid-template-columns:1fr 2.5rem}.gp-label{grid-column:1 / -1}}
/* /gaps */`;

let pagina = readFileSync(PAGINA, "utf8");
// Mapa de gaps: entre os marcadores, ou logo antes da seção "In the tools" na primeira vez
const gIni = pagina.indexOf("<!-- GAPS:START"), gFim = pagina.indexOf("<!-- GAPS:END -->");
if (gIni >= 0 && gFim > gIni) pagina = pagina.slice(0, gIni) + secaoGaps + pagina.slice(gFim + "<!-- GAPS:END -->".length);
else pagina = pagina.replace("  <!-- TOOLS:START", `  ${secaoGaps}\n\n  <!-- TOOLS:START`);
const gcIni = pagina.indexOf("/* Mapa de gaps (cores"), gcFim = pagina.indexOf("/* /gaps */");
if (gcIni >= 0 && gcFim > gcIni) pagina = pagina.slice(0, gcIni) + CSS_GAPS + pagina.slice(gcFim + "/* /gaps */".length);
else pagina = pagina.replace("</style>", CSS_GAPS + "\n</style>");
const ini = pagina.indexOf("<!-- TOOLS:START"), fim = pagina.indexOf("<!-- TOOLS:END -->");
if (ini >= 0 && fim > ini) pagina = pagina.slice(0, ini) + secao + pagina.slice(fim + "<!-- TOOLS:END -->".length);
else {
  const ancora = "  <!-- CLAY -->";
  if (!pagina.includes(ancora)) throw new Error("âncora da seção não encontrada");
  pagina = pagina.replace(ancora, `  ${secao}\n\n${ancora}`);
}
const cssIni = pagina.indexOf("/* Seção \"In the tools\""), cssFim = pagina.indexOf("/* /tools */");
if (cssIni >= 0 && cssFim > cssIni) pagina = pagina.slice(0, cssIni) + CSS + pagina.slice(cssFim + "/* /tools */".length);
else pagina = pagina.replace("</style>", CSS + "\n</style>");
writeFileSync(PAGINA, pagina);
console.log(`seção "In the tools" gravada | n8n: ${w1.nodes.length}/${w3.nodes.length}/${w2.nodes.length} nós | Clay: ${ordem.length} nós | Apollo: ${seqs.length} sequências, ${seqs.map((q) => q.steps.length).join("/")} passos | Attio: ${pipe.length} estágios`);
