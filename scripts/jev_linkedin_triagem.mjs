// Triagem dos perfis do LinkedIn pelo Jev, antes de pagar a leitura dos posts na Clay.
// Uso: node scripts/jev_linkedin_triagem.mjs <lote> [vagas=20]
// Lê data/linkedin_<lote>_perfis.json (saída do enrich da Clay) e grava data/triagem_jev_linkedin_<lote>.json.
// Ordena quem passa nos portões pelo fit Passionfroot e imprime quem deve ter os posts lidos.

import { readFileSync, writeFileSync } from "node:fs";
import { LINKEDIN_TRIAGEM } from "./rubric.mjs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error("TYPESAFE_API_KEY não encontrada no .env");

const [lote, vagasArg] = process.argv.slice(2);
if (!lote) {
  console.error("Uso: node scripts/jev_linkedin_triagem.mjs <lote> [vagas=20]");
  process.exit(1);
}
const vagas = Number(vagasArg) || 20;
const perfis = JSON.parse(readFileSync(new URL(`../data/linkedin_${lote}_perfis.json`, import.meta.url), "utf8"));

const { gates, red_flags, criteria } = LINKEDIN_TRIAGEM;
const questions = {};
for (const [id, text] of Object.entries({ ...gates, ...red_flags })) questions[id] = { type: "noul", instructions: text };
for (const [id, c] of Object.entries(criteria)) questions[id] = { type: "score", instructions: c.instructions, criteria: c.levels };

const estado = (p) => ({
  nome: p.nome,
  headline: p.headline,
  sobre: p.sobre,
  seguidores: p.seguidores,
  local: p.local,
  idiomas: p.idiomas,
  cargos_atuais: p.experiencias_atuais.map((e) => `${e.cargo} @ ${e.empresa}`),
});

async function ask(state, attempt = 1) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions }, (_, v) => (typeof v === "string" ? v.toWellFormed() : v)),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return ask(state, attempt + 1);
  }
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const outFile = new URL(`../data/triagem_jev_linkedin_${lote}.json`, import.meta.url);
let results = {};
try { results = JSON.parse(readFileSync(outFile, "utf8")); } catch {}
const urls = Object.keys(perfis).filter((u) => !results[u] || results[u].erro);
const CONCURRENCY = 5;
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  await Promise.all(urls.slice(i, i + CONCURRENCY).map(async (url) => {
    try {
      const a = (await ask(estado(perfis[url]))).answers;
      results[url] = {
        nome: perfis[url].nome,
        ...Object.fromEntries(Object.keys(gates).map((k) => [k, a[k].noul])),
        red_flags: Object.fromEntries(Object.keys(red_flags).map((k) => [k, a[k].noul])),
        fit_passionfroot: +(a.fit_passionfroot.score + 1).toFixed(2),
        confianca_fit: a.fit_passionfroot.confidence,
      };
    } catch (err) {
      results[url] = { erro: String(err.message ?? err) };
    }
  }));
}
writeFileSync(outFile, JSON.stringify(results, null, 1));

const linhas = Object.entries(results).filter(([, r]) => !r.erro).map(([url, r]) => {
  const motivos = [];
  if (r.mercado_br < 0.5) motivos.push("fora do mercado");
  if (r.e_creator < 0.5) motivos.push("não é creator");
  const flags = Object.entries(r.red_flags).filter(([, p]) => p >= 0.5).map(([k]) => k);
  if (flags.length) motivos.push(`red flag: ${flags.join(", ")}`);
  return { url, ...r, passa: motivos.length === 0, motivos };
});
const passam = linhas.filter((l) => l.passa).sort((a, b) => b.fit_passionfroot - a.fit_passionfroot || b.e_creator - a.e_creator);
const ler = passam.slice(0, vagas);
writeFileSync(new URL(`../data/linkedin_${lote}_ler_posts.json`, import.meta.url), JSON.stringify(ler.map((l) => l.url), null, 1));

console.log(`perfis: ${linhas.length} | passam nos portões: ${passam.length} | erros: ${Object.values(results).filter((r) => r.erro).length}`);
const motivos = {};
for (const l of linhas) for (const m of l.motivos) motivos[m] = (motivos[m] ?? 0) + 1;
console.log("reprovados por:", motivos);
console.log(`posts a ler (${ler.length}):`, ler.map((l) => `${l.nome} (${l.fit_passionfroot.toFixed(1)})`).join("; "));
