// Mapa de gaps: quantos creators aprovados existem por categoria Passionfroot e por plataforma.
// A categoria vem do vetting (a do Claude quando ele revisou, senão a do Jev), igual nas três plataformas.
// Uso: node scripts/gap_map.mjs
// Lê data/vetting_final_lote*.csv, vetting_final_linkedin_*.csv e vetting_final_newsletters_*.csv;
// grava data/mapa_de_gaps.csv.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { CATEGORIAS } from "./rubric.mjs";

const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");
const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"'));
function parseCsv(text) {
  const lines = text.replace(/^﻿/, "").split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [header[i], v])));
}

const PLATAFORMAS = {
  youtube: /^vetting_final_lote\d+\.csv$/,
  linkedin: /^vetting_final_linkedin_.+\.csv$/,
  newsletters: /^vetting_final_newsletters_.+\.csv$/,
};
const linhas = Object.fromEntries(Object.keys(CATEGORIAS).map((c) => [c, {
  categoria: c,
  ...Object.fromEntries(Object.keys(PLATAFORMAS).flatMap((p) => [[`${p}_avaliados`, 0], [`${p}_aprovados`, 0]])),
  youtube_alta_confianca: 0, youtube_so_jev: 0, youtube_micro: 0, youtube_medio: 0, disputas: 0,
}]));

const arquivos = readdirSync(dataDir);
for (const [p, padrao] of Object.entries(PLATAFORMAS)) {
  for (const f of arquivos.filter((f) => padrao.test(f))) {
    for (const r of parseCsv(read(f))) {
      const l = linhas[r.categoria];
      if (!l) continue;
      l[`${p}_avaliados`]++;
      if (r.veredito.startsWith("Disputa")) l.disputas++;
      if (r.veredito !== "Aprovado") continue;
      l[`${p}_aprovados`]++;
      if (p !== "youtube") continue;
      if (r.decidido_por.startsWith("só Jev")) l.youtube_so_jev++; else l.youtube_alta_confianca++;
      if (r.porte === "micro") l.youtube_micro++; else l.youtube_medio++;
    }
  }
}

const tabela = Object.values(linhas).map((l) => {
  const avaliados = l.youtube_avaliados + l.linkedin_avaliados + l.newsletters_avaliados;
  const aprovados = l.youtube_aprovados + l.linkedin_aprovados + l.newsletters_aprovados;
  return { ...l, total_avaliados: avaliados, total_aprovados: aprovados, taxa_aprovacao: avaliados ? +(aprovados / avaliados).toFixed(2) : 0 };
}).sort((a, b) => a.total_aprovados - b.total_aprovados);

const header = Object.keys(tabela[0]);
writeFileSync(new URL("mapa_de_gaps.csv", dataDir),
  "﻿" + [header.join(","), ...tabela.map((r) => header.map((h) => `"${r[h]}"`).join(","))].join("\n"));

console.log("categoria | YouTube aprovados/avaliados (alta conf. / só Jev, micro/médio) | LinkedIn | newsletters | total | taxa | disputas");
for (const r of tabela) {
  console.log(`${r.categoria} | ${r.youtube_aprovados}/${r.youtube_avaliados} (${r.youtube_alta_confianca}/${r.youtube_so_jev}, ${r.youtube_micro}/${r.youtube_medio})`
    + ` | ${r.linkedin_aprovados}/${r.linkedin_avaliados} | ${r.newsletters_aprovados}/${r.newsletters_avaliados} | ${r.total_aprovados}/${r.total_avaliados} | ${r.taxa_aprovacao} | ${r.disputas}`);
}
