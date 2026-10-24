// Exporta o resultado dos workflows da Clay (um run por linha do CSV) para JSON local.
// Uso: node scripts/clay_export_runs.mjs <perfis|posts> <workflowId> <lote>
// Saída: data/linkedin_<lote>_<tipo>.json, indexado pela URL do LinkedIn.
// Lê só os runs concluídos; se o mesmo perfil rodou duas vezes, fica o run mais recente.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [tipo, workflowId, lote] = process.argv.slice(2);
if (!["perfis", "posts"].includes(tipo) || !workflowId || !lote) {
  console.error("Uso: node scripts/clay_export_runs.mjs <perfis|posts> <workflowId> <lote>");
  process.exit(1);
}
const clay = (...args) => JSON.parse(execFileSync("clay", args, { encoding: "utf8", shell: true, maxBuffer: 64 << 20 }));
const cut = (s, n) => [...String(s ?? "")].slice(0, n).join("");

function perfil(r) {
  const atuais = (r.current_experience ?? []).map((e) => ({ cargo: e.title, empresa: e.company, dominio: e.company_domain }));
  return {
    headline: r.headline ?? "",
    sobre: cut(r.summary, 1500),
    seguidores: r.num_followers ?? null,
    conexoes: r.connections ?? null,
    local: r.location_name ?? "",
    idiomas: (r.languages ?? []).map((l) => l.language),
    experiencias_atuais: atuais.slice(0, 6),
  };
}

function posts(r) {
  return (r.posts ?? []).map((p) => ({
    data: p.created_at,
    tipo: p.activity_type,
    repost_sem_texto: p.is_repost_with_no_additional_text_or_content ?? false,
    reacoes: p.reaction_counts?.total ?? 0,
    comentarios: p.comment_count ?? 0,
    compartilhamentos: p.share_count ?? 0,
    texto: cut(p.text, 600),
  }));
}

const arquivo = new URL(`../data/linkedin_${lote}_${tipo}.json`, import.meta.url);
const saida = existsSync(arquivo) ? JSON.parse(readFileSync(arquivo, "utf8")) : {};
const vistos = new Set();
let cursor, novos = 0, falhas = 0;
do {
  const page = clay("workflows", "runs", "list", workflowId, "--limit", "100", ...(cursor ? ["--cursor", cursor] : []));
  for (const run of page.data) {
    if (run.status !== "completed") { if (run.status === "failed") falhas++; continue; }
    const det = clay("workflows", "runs", "get", run.runId, "--verbose");
    // O workflow de pipeline tem os dois nós: escolhe o de posts ou o de perfil pelo formato da saída
    const passo = det.nodes.find((n) => n.outputs?.result && (tipo === "posts") === ("posts" in n.outputs.result));
    const gatilho = det.nodes.find((n) => n.outputs?.linkedin_url)?.outputs ?? passo?.inputs ?? {};
    const url = gatilho.linkedin_url;
    if (!passo || !url || vistos.has(url)) continue; // lista vem do mais novo para o mais antigo
    vistos.add(url);
    const r = passo.outputs.result ?? {};
    saida[url] = { nome: gatilho.name, ...(tipo === "perfis" ? perfil(r) : { posts: posts(r) }), clay_run: run.runId };
    novos++;
  }
  cursor = page.cursor;
} while (cursor);

writeFileSync(arquivo, JSON.stringify(saida, null, 1));
console.log(`${tipo}: ${novos} perfis exportados (${Object.keys(saida).length} no arquivo), ${falhas} runs com falha`);
