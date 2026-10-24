// Vetting em duas etapas: o Jev avalia tudo, o Claude revisa uma amostra pequena e direcionada.
// A amostra = os casos de fronteira, onde o Jev mais erra (nota perto do corte ou portões em dúvida),
// + uma fração aleatória dos casos claros, como controle da taxa de erro.
// A lista sai embaralhada e sem o veredito do Jev, para a revisão do Claude continuar às cegas.
// Uso: node scripts/amostra_claude.mjs <nome-do-lote> [fracao_controle=0.1]
// Grava data/amostra_claude_<lote>.json (índices para o Claude) e data/amostra_claude_<lote>_chave.json
// (quem o Jev aprovou; só é lido depois, pelo compare_vetting).

import { readFileSync, writeFileSync } from "node:fs";
import { CRITERIA, notaEngajamento, notaConsistencia, APROVACAO_MINIMA, FIT_MINIMO } from "./rubric.mjs";

const [batchName, fracArg] = process.argv.slice(2);
const FRACAO = Number(fracArg ?? 0.1);
const FRONTEIRA_NOTA = [58, 64]; // nota do Jev (0–100) perto do corte de 60
const FRONTEIRA_PROB = [0.45, 0.6]; // portões em que o Jev não tem certeza
const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");

const ids = Object.keys(JSON.parse(read(`youtube_${batchName}_states.json`)));
const jev = JSON.parse(read(`vetting_jev_${batchName}.json`));
const lines = read(`youtube_${batchName}.csv`).replace(/^﻿/, "").split("\n");
const header = lines[0].split(",");
const canais = Object.fromEntries(lines.slice(1).map((l) => {
  const r = Object.fromEntries([...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m, i) => [header[i], m[1]]));
  return [r.channel_id, r];
}));

const pesos = { ...Object.fromEntries(Object.entries(CRITERIA).map(([k, c]) => [k, c.peso])), engajamento: 15, consistencia: 15 };
function avaliarJev(id) {
  const j = jev[id], c = canais[id];
  if (!j || j.erro || !c) return { aprova: false, fronteira: false };
  const notas = { ...j.notas, engajamento: notaEngajamento(c.views_por_inscrito), consistencia: notaConsistencia(c.videos_ultimos_30d) };
  const nota = Object.entries(notas).reduce((s, [k, v]) => s + pesos[k] * v, 0) / 5;
  const flags = Object.values(j.red_flags).some((p) => p >= 0.5);
  const aprova = j.pt_br >= 0.5 && j.e_creator >= 0.5 && !flags && c.passa_portao_30d === "sim"
    && nota >= APROVACAO_MINIMA && j.notas.fit_passionfroot >= FIT_MINIMO;
  const duvida = (p) => p >= FRONTEIRA_PROB[0] && p <= FRONTEIRA_PROB[1];
  const fronteira = c.passa_portao_30d === "sim" && (
    (nota >= FRONTEIRA_NOTA[0] && nota <= FRONTEIRA_NOTA[1])
    || duvida(j.e_creator) || duvida(j.pt_br) || Object.values(j.red_flags).some(duvida));
  return { aprova, fronteira };
}

// Embaralhamento com semente fixa, para a amostra ser reproduzível
let seed = 20261022;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffle = (arr) => arr.map((v) => [rand(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

const av = Object.fromEntries(ids.map((id) => [id, avaliarJev(id)]));
const aprovados = ids.filter((id) => av[id].aprova);
const fronteira = ids.filter((id) => av[id].fronteira);
const claros = ids.filter((id) => !av[id].fronteira);
// Controle estratificado: a mesma fração entre os claros aprovados e os claros reprovados
const controle = [
  ...shuffle(claros.filter((id) => av[id].aprova)).slice(0, Math.round(claros.filter((id) => av[id].aprova).length * FRACAO)),
  ...shuffle(claros.filter((id) => !av[id].aprova)).slice(0, Math.round(claros.filter((id) => !av[id].aprova).length * FRACAO)),
];
// Quem o Michel já decidiu também entra: se o veredito mudar, a mudança passou pelos dois avaliadores
let decisoes = {};
try { decisoes = JSON.parse(read(`decisoes_michel_${batchName}.json`)).decisoes; } catch {}
const decididos = ids.filter((id) => decisoes[canais[id]?.nome]);
const amostra = shuffle([...new Set([...fronteira, ...controle, ...decididos])]);

writeFileSync(new URL(`amostra_claude_${batchName}.json`, dataDir),
  JSON.stringify({ indices: amostra.map((id) => ids.indexOf(id)).sort((a, b) => a - b) }, null, 1));
writeFileSync(new URL(`amostra_claude_${batchName}_chave.json`, dataDir),
  JSON.stringify({ jev_aprovados: aprovados, fronteira, controle, decididos, fracao_controle: FRACAO }, null, 1));

console.log(`canais no lote: ${ids.length} | amostra para o Claude: ${amostra.length} (sem dizer o veredito do Jev)`);
console.log(`  fronteira: ${fronteira.length} | controle (${FRACAO * 100}% dos casos claros): ${controle.length} | já decididos pelo Michel: ${decididos.length}`);
console.log(`fora da amostra (decididos só pelo Jev): ${ids.length - amostra.length}`);
