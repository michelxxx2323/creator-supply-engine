// Jev pontua o fit com o brief da Frente A, só nos canais que não foram reprovados no vetting.
// Uso: node scripts/jev_brief.mjs <nome-do-lote>
// Grava data/brief_jev_<lote>.json sem imprimir as notas (o Claude avalia às cegas).

import { readFileSync, writeFileSync } from "node:fs";
import { BRIEF, BRIEF_FLAGS } from "./rubric.mjs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1].trim();
const batchName = process.argv[2];
const dataDir = new URL("../data/", import.meta.url);
const states = JSON.parse(readFileSync(new URL(`youtube_${batchName}_states.json`, dataDir), "utf8"));

// channel_id é a primeira coluna e veredito a sétima no CSV final. O brief usa o vetting congelado da rubrica de tech.
const finalCsv = readFileSync(new URL(`rubrica_tech/vetting_final_${batchName}.csv`, dataDir), "utf8").replace(/^﻿/, "");
const ids = finalCsv.split("\n").slice(1)
  .map((line) => line.match(/^"([^"]+)"/)?.[1])
  .filter((id, n) => id && !finalCsv.split("\n")[n + 1].includes('"Reprovado"'));

const questions = {
  ...Object.fromEntries(Object.entries(BRIEF_FLAGS).map(([k, t]) => [k, { type: "noul", instructions: t }])),
  ...Object.fromEntries(Object.entries(BRIEF).map(([k, c]) => [k, { type: "score", instructions: c.instructions, criteria: c.levels }])),
};

const results = {};
for (let i = 0; i < ids.length; i += 5) {
  await Promise.all(ids.slice(i, i + 5).map(async (id) => {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: states[id], model: "jev-latest", questions },
        (_, v) => (typeof v === "string" ? v.toWellFormed() : v)),
    });
    const json = await res.json();
    if (!res.ok) { results[id] = { erro: JSON.stringify(json).slice(0, 200) }; return; }
    const a = json.answers;
    results[id] = {
      ...Object.fromEntries(Object.keys(BRIEF_FLAGS).map((k) => [k, a[k].noul])),
      ...Object.fromEntries(Object.keys(BRIEF).map((k) => [k, +(a[k].score + 1).toFixed(2)])),
      confianca: Object.fromEntries(Object.keys(BRIEF).map((k) => [k, a[k].confidence])),
    };
  }));
}
writeFileSync(new URL(`brief_jev_${batchName}.json`, dataDir), JSON.stringify(results, null, 1));
console.error(`canais avaliados: ${Object.values(results).filter((r) => !r.erro).length} | erros: ${Object.values(results).filter((r) => r.erro).length}`);
