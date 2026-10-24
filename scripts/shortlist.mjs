// Shortlist da Frente A: cruza o vetting com o fit do brief (Jev + Claude) e o guardrail de views.
// Uso: node scripts/shortlist.mjs <lote[,lote...]> [vagas=15]
// Entra quem foi aprovado no vetting, ninguém marcou clone da ElevenLabs, o guardrail não reprovou
// e não está em data/shortlist_exclusoes_<lote>.json. Prioridade para fit do brief ≥ 3,5; se faltar gente,
// completa com fit ≥ 3. As disputas pendentes ficam à parte, para o Michel decidir.
// Também calcula o budget de YouTube com o preço de tabela ajustado pelo guardrail.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { calcularGuardrail } from "./guardrail.mjs";

const [lotesArg, sizeArg] = process.argv.slice(2);
const LOTES = lotesArg.split(",");
const SIZE = Number(sizeArg ?? 15);
const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");
const readOpt = (f, fallback) => { try { return JSON.parse(read(f)); } catch { return fallback; } };
// A shortlist da ElevenAgents foi fechada com a rubrica de tech; o vetting dela fica congelado em data/rubrica_tech/
const TECH = "rubrica_tech/";

const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"'));
function parseCsv(text) {
  const lines = text.replace(/^﻿/, "").split("\n");
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [header[i], v])));
}

// Referência do guardrail: todos os lotes, só creators. Empresas e veículos têm poucas views por inscrito
// e puxariam a mediana para baixo.
const todosLotes = readdirSync(dataDir).map((f) => f.match(/^youtube_(lote\d+)\.csv$/)?.[1]).filter(Boolean);
const referencia = todosLotes.flatMap((lote) => {
  const ids = Object.keys(JSON.parse(read(`youtube_${lote}_states.json`)));
  const naoCreators = new Set(readOpt(`${TECH}vetting_claude_${lote}_nao_creators.json`, { indices: [] }).indices.map((i) => ids[i]));
  return parseCsv(read(`youtube_${lote}.csv`)).filter((c) => !naoCreators.has(c.channel_id));
});
const guardrail = calcularGuardrail(referencia.map((c) => ({ id: c.channel_id, inscritos: +c.inscritos, views: +c.views_medias_10 })));
// Quem ficou fora da referência (empresas) ainda recebe z calculado contra ela
const foraDaReferencia = todosLotes.flatMap((lote) => parseCsv(read(`youtube_${lote}.csv`))).filter((c) => !guardrail[c.channel_id]);
Object.assign(guardrail, Object.fromEntries(Object.entries(calcularGuardrail([
  ...referencia.map((c) => ({ id: c.channel_id, inscritos: +c.inscritos, views: +c.views_medias_10 })),
])).filter(([id]) => foraDaReferencia.some((c) => c.channel_id === id))));

const rows = [];
let agree = 0, compared = 0;
for (const lote of LOTES) {
  const ids = Object.keys(JSON.parse(read(`youtube_${lote}_states.json`)));
  const jev = JSON.parse(read(`brief_jev_${lote}.json`));
  const claude = JSON.parse(read(`brief_claude_${lote}.json`));
  const exclusoes = readOpt(`shortlist_exclusoes_${lote}.json`, { exclusoes: {} }).exclusoes;
  const claudeConflito = new Set(readOpt(`brief_claude_${lote}_conflito.json`, { indices: [] }).indices.map((i) => ids[i]));
  for (const v of parseCsv(read(`${TECH}vetting_final_${lote}.csv`))) {
    const j = jev[v.channel_id];
    const c = claude[ids.indexOf(v.channel_id)];
    if (!j || !c) continue;
    const [cFit, cClone] = c;
    compared++;
    if (Math.abs(j.fit_elevenagents - cFit) <= 1) agree++;
    const g = guardrail[v.channel_id] ?? {};
    rows.push({
      ...v,
      ...g,
      lote,
      fit_brief_jev: j.fit_elevenagents,
      fit_brief_claude: cFit,
      fit_brief: +((j.fit_elevenagents + cFit) / 2).toFixed(2),
      clone: j.clone_elevenlabs >= 0.5 || cClone === 1,
      conflito: [j.conflito >= 0.5 ? "Jev" : "", claudeConflito.has(v.channel_id) ? "Claude" : ""].filter(Boolean).join(" + "),
      excluido: exclusoes[v.nome] ?? (g.preco_ajustado === null ? "guardrail: views incompatíveis" : ""),
    });
  }
}

const ordenar = (a, b) => b.fit_brief - a.fit_brief || Number(b.nota_final || b.nota_claude) - Number(a.nota_final || a.nota_claude);
// Conflito confirmado pelos dois avaliadores tira da shortlist; marcado por um só vira pendência
const conflitoConfirmado = (r) => r.conflito.includes("+");
const elegivel = (r, fitMin) => !r.clone && !r.conflito && !r.excluido && r.fit_brief >= fitMin;
const elegivelSalvoConflito = (r, fitMin) => !r.clone && !conflitoConfirmado(r) && !r.excluido && r.fit_brief >= fitMin;
const aprovados = rows.filter((r) => r.veredito === "Aprovado");

const shortlist = aprovados.filter((r) => elegivel(r, 3.5)).sort(ordenar).slice(0, SIZE);
if (shortlist.length < SIZE) {
  shortlist.push(...aprovados.filter((r) => elegivel(r, 3) && !shortlist.includes(r)).sort(ordenar).slice(0, SIZE - shortlist.length));
}
const reservas = aprovados.filter((r) => elegivel(r, 3) && !shortlist.includes(r)).sort(ordenar);
// Só importa a disputa em que pelo menos um avaliador aprova
const pendentes = [
  ...rows.filter((r) => elegivel(r, 3.5) && r.veredito.startsWith("Disputa") && (r.jev_aprova === "sim" || r.claude_aprova === "sim"))
    .map((r) => ({ ...r, motivo_pendencia: r.motivo_disputa })),
  ...rows.filter((r) => r.conflito && !conflitoConfirmado(r) && elegivelSalvoConflito(r, 3.5) && r.veredito === "Aprovado")
    .map((r) => ({ ...r, motivo_pendencia: `conflito de interesse marcado só pelo ${r.conflito}` })),
].sort(ordenar);
const fora = rows.filter((r) => (r.excluido || conflitoConfirmado(r)) && r.fit_brief >= 3.5 && r.veredito !== "Reprovado")
  .map((r) => ({ ...r, excluido: r.excluido || `conflito de interesse (${r.conflito})` }));

const nome = LOTES.join("+");
const cols = ["lote", "nome", "link", "inscritos", "porte", "fit_brief", "fit_brief_jev", "fit_brief_claude", "nota_final", "nota_jev", "nota_claude",
  "veredito", "decidido_por", "segmento", "z", "faixa", "preco_tabela", "preco_ajustado", "limitado_pelo_teto", "excluido", "justificativa_claude", "instagram"];
const cell = (x) => `"${String(x ?? "").replaceAll('"', '""')}"`;
const csv = (list) => "﻿" + [cols.join(","), ...list.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\n");
writeFileSync(new URL(`shortlist_elevenagents_${nome}.csv`, dataDir), csv(shortlist));
writeFileSync(new URL(`shortlist_elevenagents_${nome}_reservas.csv`, dataDir), csv(reservas));
writeFileSync(new URL(`shortlist_elevenagents_${nome}_pendentes.csv`, dataDir), csv(pendentes));
writeFileSync(new URL(`shortlist_elevenagents_${nome}_fora.csv`, dataDir), csv(fora));

const soma = (list, k) => list.reduce((s, r) => s + r[k], 0);
const linha = (r) => `${r.fit_brief} | ${r.nome} (${r.lote}) | ${r.inscritos} insc. | z ${r.z} (${r.faixa}) | US$ ${r.preco_tabela} → ${r.preco_ajustado}${r.limitado_pelo_teto ? " (teto)" : ""}`;

console.log(`referência do guardrail: ${referencia.length} creators de ${todosLotes.length} lotes`);
console.log(`fit do brief: Jev e Claude a até 1 ponto em ${(100 * agree / compared).toFixed(0)}% de ${compared} canais`);
console.log(`--- shortlist (${shortlist.length}) ---`);
shortlist.forEach((r) => console.log(linha(r)));
console.log(`--- reservas (${reservas.length}) ---`);
reservas.slice(0, 5).forEach((r) => console.log(linha(r)));
console.log(`--- pendentes do Michel (${pendentes.length}) ---`);
pendentes.forEach((r) => console.log(`${linha(r)} | ${r.motivo_pendencia}`));
console.log(`--- fora da shortlist (${fora.length}) ---`);
fora.forEach((r) => console.log(`${r.nome} | z ${r.z} | ${r.excluido}`));
console.log(`YouTube, shortlist: tabela US$ ${soma(shortlist, "preco_tabela")} → ajustado US$ ${soma(shortlist, "preco_ajustado")}`);
