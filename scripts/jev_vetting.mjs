// Primeiro avaliador do duplo vetting: Jev (TypeSafe) pontua cada canal pela rubrica.
// Uso: node scripts/jev_vetting.mjs <nome-do-lote>
// Lê data/youtube_<lote>_states.json e grava data/vetting_jev_<lote>.json.
// Não imprime as notas, para o segundo avaliador continuar às cegas.

import { readFileSync, writeFileSync } from "node:fs";
import { GATES, RED_FLAGS, CRITERIA, perguntasJev } from "./rubric.mjs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error("TYPESAFE_API_KEY não encontrada no .env");

const batchName = process.argv[2];
if (!batchName) {
  console.error("Uso: node scripts/jev_vetting.mjs <nome-do-lote>");
  process.exit(1);
}
const states = JSON.parse(readFileSync(new URL(`../data/youtube_${batchName}_states.json`, import.meta.url), "utf8"));

const questions = perguntasJev({ ...GATES, ...RED_FLAGS }, CRITERIA);

async function ask(state, attempt = 1) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    // toWellFormed: estados antigos podem ter emojis partidos, que a API recusa
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

// Rodar de novo só refaz os canais que faltam ou deram erro
const outFile = new URL(`../data/vetting_jev_${batchName}.json`, import.meta.url);
let results = {};
try { results = JSON.parse(readFileSync(outFile, "utf8")); } catch {}
let inputTokens = 0;
let failures = 0;
const ids = Object.keys(states).filter((id) => !results[id] || results[id].erro);
const CONCURRENCY = 5;

for (let i = 0; i < ids.length; i += CONCURRENCY) {
  await Promise.all(ids.slice(i, i + CONCURRENCY).map(async (id) => {
    try {
      const r = await ask(states[id]);
      inputTokens += r.usage?.input_tokens ?? 0;
      const a = r.answers;
      results[id] = {
        modelo: r.model,
        ...Object.fromEntries(Object.keys(GATES).map((k) => [k, a[k].noul])),
        red_flags: Object.fromEntries(Object.keys(RED_FLAGS).map((k) => [k, a[k].noul])),
        notas: Object.fromEntries(Object.keys(CRITERIA).map((k) => [k, +(a[k].score + 1).toFixed(2)])),
        confianca: Object.fromEntries(Object.keys(CRITERIA).map((k) => [k, a[k].confidence])),
        categoria: a.categoria.choice,
        categoria_confianca: a.categoria.confidence,
      };
    } catch (err) {
      failures++;
      results[id] = { erro: String(err.message ?? err) };
    }
  }));
  console.error(`${Math.min(i + CONCURRENCY, ids.length)}/${ids.length}`);
}

writeFileSync(outFile, JSON.stringify(results, null, 1));
console.error(`canais avaliados: ${ids.length - failures} | falhas: ${failures} | tokens de entrada: ${inputTokens}`);
