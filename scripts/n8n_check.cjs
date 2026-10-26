// Uso: node scripts/n8n_check.cjs  (depois de node scripts/n8n_workflows.mjs)
// Checagem estática dos workflows gerados: conexões, sintaxe dos nós de código e referências $('Nó')
const fs = require("fs");
for (const f of ["w1_brief_shortlist.json", "w2_outreach_sync.json", "w3_weekly_supply.json"]) {
  const w = JSON.parse(fs.readFileSync(require("path").join(__dirname, "..", "n8n", f), "utf8"));
  const names = new Set(w.nodes.map((n) => n.name));
  const broken = Object.entries(w.connections).flatMap(([a, c]) => [a, ...c.main.flat().map((x) => x.node)]).filter((n) => !names.has(n));
  const syntax = [];
  const refs = new Set();
  for (const n of w.nodes) {
    const textos = JSON.stringify(n.parameters);
    for (const m of textos.matchAll(/\$\(\\?["']([^"'\\]+)\\?["']\)/g)) refs.add(m[1]);
    if (n.type !== "n8n-nodes-base.code") continue;
    try { new Function("$", "$input", "$json", "$getWorkflowStaticData", "return (async () => {" + n.parameters.jsCode + "\n})"); }
    catch (e) { syntax.push(n.name + ": " + e.message); }
  }
  const faltam = [...refs].filter((r) => !names.has(r));
  const ligados = new Set(Object.entries(w.connections).flatMap(([a, c]) => [a, ...c.main.flat().map((x) => x.node)]));
  const soltos = w.nodes.filter((n) => n.type !== "n8n-nodes-base.stickyNote" && !ligados.has(n.name)).map((n) => n.name);
  console.log(f, "|", w.nodes.length, "nós | conexões quebradas:", broken, "| sintaxe:", syntax, "| $() inexistente:", faltam, "| nós soltos:", soltos,
    "| tamanho:", (JSON.stringify(w).length / 1024).toFixed(0) + "KB");
}
