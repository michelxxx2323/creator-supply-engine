// Duplo vetting: compara Jev e Claude e chega ao veredito.
// Uso: node scripts/compare_vetting.mjs <nome-do-lote>
// Entradas: data/youtube_<lote>.csv, _states.json, vetting_jev_<lote>.json, vetting_claude_<lote>.json
// (índice → [pt_br, red_flag, e_creator, 4 notas, categoria, justificativa])
// Saída: data/vetting_final_<lote>.csv e um resumo no terminal.
//
// Disputa (Michel decide) quando: red flag ou status de creator divergentes, ou diferença ≥ 2 pontos num
// critério pesado (fit Passionfroot, qualidade). Vereditos diferentes só por nota (e confiança do Jev < 0,3
// perto do corte) decidem pela média. Diferenças nos critérios leves viram observação.
// Categoria: a do Claude quando ele revisou, senão a do Jev; divergência vira observação.

import { readFileSync, writeFileSync } from "node:fs";
import {
  CRITERIA, OBJECTIVE, PESADOS, notaEngajamento, notaConsistencia, APROVACAO_MINIMA, FIT_MINIMO,
  aplicarDecisao, soDiferencaDeNota, aprovaPelaMedia,
} from "./rubric.mjs";

const batchName = process.argv[2];
if (!batchName) {
  console.error("Uso: node scripts/compare_vetting.mjs <nome-do-lote>");
  process.exit(1);
}
const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const channels = Object.fromEntries(parseCsv(read(`youtube_${batchName}.csv`)).map((r) => [r.channel_id, r]));
const ids = Object.keys(JSON.parse(read(`youtube_${batchName}_states.json`))); // a ordem que o Claude avaliou
const jev = JSON.parse(read(`vetting_jev_${batchName}.json`));
let claudeByIndex = {};
try { claudeByIndex = JSON.parse(read(`vetting_claude_${batchName}.json`)); } catch {}
// Decisões humanas nas disputas, quando já existem
let decisoes = {};
try { decisoes = JSON.parse(read(`decisoes_michel_${batchName}.json`)).decisoes; } catch {}

const KEYS = Object.keys(CRITERIA);
const peso = (k) => (CRITERIA[k] ?? OBJECTIVE[k]).peso;

function notaFinal(notas) {
  const total = Object.entries(notas).reduce((s, [k, v]) => s + peso(k) * v, 0);
  return Math.round(total / 5);
}

const out = [];
const diffs = Object.fromEntries(KEYS.map((k) => [k, []]));
let gateAgree = 0;

for (const [i, id] of ids.entries()) {
  const ch = channels[id];
  const j = jev[id];
  const c = claudeByIndex[i];
  if (!ch || !j || j.erro) continue;

  const objetivas = {
    engajamento: notaEngajamento(ch.views_por_inscrito),
    consistencia: notaConsistencia(ch.videos_ultimos_30d),
  };
  const portao30d = ch.passa_portao_30d === "sim";

  const jevFlags = Object.entries(j.red_flags).filter(([, p]) => p >= 0.5).map(([k]) => k);
  const jevAval = {
    pt_br: j.pt_br >= 0.5,
    e_creator: j.e_creator >= 0.5,
    red_flag: jevFlags.length > 0,
    notas: { ...j.notas, ...objetivas },
  };

  // Vetting em duas etapas: fora da amostra do Claude, decide só o Jev
  if (!c) {
    jevAval.nota = notaFinal(jevAval.notas);
    jevAval.aprovado = jevAval.pt_br && jevAval.e_creator && !jevAval.red_flag && portao30d
      && jevAval.nota >= APROVACAO_MINIMA && jevAval.notas.fit_passionfroot >= FIT_MINIMO;
    const decisao = aplicarDecisao(decisoes[ch.nome], [jevAval.aprovado]);
    out.push({
      channel_id: id, nome: ch.nome, link: ch.link, inscritos: ch.inscritos, porte: ch.porte,
      categoria: j.categoria, jev_categoria: j.categoria, claude_categoria: "",
      veredito: decisao?.veredito ?? (jevAval.aprovado ? "Aprovado" : "Reprovado"),
      decidido_por: decisao ? (decisao.motivo ? "" : "Michel") : "só Jev (fora da amostra)",
      nota_final: decisao?.motivo ? "" : jevAval.nota, nota_jev: jevAval.nota, nota_claude: "",
      jev_aprova: jevAval.aprovado ? "sim" : "não", claude_aprova: "",
      motivo_disputa: decisao?.motivo ?? "", observacoes: "", justificativa_claude: "",
      portao_30d: portao30d ? "sim" : "não",
      ...Object.fromEntries(KEYS.flatMap((k) => [[`jev_${k}`, jevAval.notas[k]], [`claude_${k}`, ""]])),
      engajamento: objetivas.engajamento, consistencia: objetivas.consistencia,
      jev_confianca_min: Math.min(...PESADOS.map((k) => j.confianca[k])).toFixed(2),
      instagram: ch.instagram,
    });
    continue;
  }

  const [cPt, cRed, cCreator, ...cNotas] = c;
  const claudeAval = {
    pt_br: cPt === 1,
    e_creator: cCreator === 1,
    red_flag: cRed === 1,
    notas: { ...Object.fromEntries(KEYS.map((k, n) => [k, cNotas[n]])), ...objetivas },
    categoria: c[3 + KEYS.length],
    justificativa: c[4 + KEYS.length],
  };

  for (const a of [jevAval, claudeAval]) {
    a.nota = notaFinal(a.notas);
    a.portoes = a.pt_br && a.e_creator && !a.red_flag && portao30d;
    a.aprovado = a.portoes && a.nota >= APROVACAO_MINIMA && a.notas.fit_passionfroot >= FIT_MINIMO;
  }

  if (["pt_br", "e_creator", "red_flag"].every((g) => jevAval[g] === claudeAval[g])) gateAgree++;
  for (const k of KEYS) diffs[k].push(Math.abs(jevAval.notas[k] - claudeAval.notas[k]));

  const motivos = [];
  const observacoes = [];
  if (jevAval.aprovado !== claudeAval.aprovado) motivos.push("vereditos diferentes");
  if (jevAval.red_flag !== claudeAval.red_flag) {
    motivos.push(`red flag divergente (Jev: ${jevFlags.join(", ") || "nenhuma"})`);
  }
  // A dúvida do Jev sobre ser creator (0,5–0,7) não vira disputa quando o Claude revisou e concorda (decisão do Michel, 22/10)
  if (jevAval.e_creator !== claudeAval.e_creator) motivos.push("divergem se é creator ou empresa");
  for (const k of KEYS) {
    if (Math.abs(jevAval.notas[k] - claudeAval.notas[k]) < 2) continue;
    const texto = `${k}: Jev ${jevAval.notas[k]} x Claude ${claudeAval.notas[k]}`;
    (PESADOS.includes(k) ? motivos : observacoes).push(texto);
  }
  const confMin = Math.min(...PESADOS.map((k) => j.confianca[k]));
  const media = Math.round((jevAval.nota + claudeAval.nota) / 2);
  if (confMin < 0.3 && Math.abs(media - APROVACAO_MINIMA) <= 5) motivos.push(`confiança do Jev baixa (${confMin.toFixed(2)}) perto do corte`);
  if (j.categoria !== claudeAval.categoria) observacoes.push(`categoria: Jev ${j.categoria} x Claude ${claudeAval.categoria}`);

  const decisao = aplicarDecisao(decisoes[ch.nome], [jevAval.aprovado, claudeAval.aprovado]);
  if (decisao?.motivo) motivos.push(decisao.motivo);
  const decidiu = decisao && !decisao.motivo; // a decisão do Michel continua valendo
  const pelaMedia = !decidiu && soDiferencaDeNota(motivos);
  const disputa = !decidiu && !pelaMedia && motivos.length > 0;
  if (pelaMedia) observacoes.unshift(`decidido pela média (${motivos.join("; ")})`);
  const aprovado = pelaMedia ? aprovaPelaMedia(jevAval, claudeAval) : jevAval.aprovado;
  out.push({
    channel_id: id,
    nome: ch.nome,
    link: ch.link,
    inscritos: ch.inscritos,
    porte: ch.porte,
    categoria: claudeAval.categoria,
    jev_categoria: j.categoria,
    claude_categoria: claudeAval.categoria,
    veredito: decidiu ? decisao.veredito : disputa ? "Disputa: Michel decide" : aprovado ? "Aprovado" : "Reprovado",
    decidido_por: decidiu ? "Michel" : disputa ? "" : pelaMedia ? "média Jev + Claude" : "consenso Jev + Claude",
    nota_final: disputa ? "" : media,
    nota_jev: jevAval.nota,
    nota_claude: claudeAval.nota,
    jev_aprova: jevAval.aprovado ? "sim" : "não",
    claude_aprova: claudeAval.aprovado ? "sim" : "não",
    motivo_disputa: disputa ? motivos.join("; ") : "",
    observacoes: observacoes.join("; "),
    justificativa_claude: claudeAval.justificativa,
    portao_30d: portao30d ? "sim" : "não",
    ...Object.fromEntries(KEYS.flatMap((k) => [[`jev_${k}`, jevAval.notas[k]], [`claude_${k}`, claudeAval.notas[k]]])),
    engajamento: objetivas.engajamento,
    consistencia: objetivas.consistencia,
    jev_confianca_min: confMin.toFixed(2),
    instagram: ch.instagram,
  });
}

const ordem = { "Aprovado": 0, "Disputa: Michel decide": 1, "Reprovado": 2 }; // decisões do Michel entram como Aprovado/Reprovado
out.sort((a, b) => ordem[a.veredito] - ordem[b.veredito] || (b.nota_final || b.nota_claude) - (a.nota_final || a.nota_claude));

const header = Object.keys(out[0]);
const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
writeFileSync(new URL(`vetting_final_${batchName}.csv`, dataDir),
  "﻿" + [header.join(","), ...out.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n"));

const count = (v) => out.filter((r) => r.veredito === v).length;
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const pct = (n, d) => `${(100 * n / d).toFixed(1)}%`;
const revisados = out.filter((r) => r.claude_aprova !== "");
console.log(`canais no lote: ${out.length} | revisados pelos dois: ${revisados.length} | só Jev: ${out.length - revisados.length}`);
console.log(`aprovados: ${count("Aprovado")} | reprovados: ${count("Reprovado")} | disputas: ${count("Disputa: Michel decide")}`);
console.log(`concordância de veredito Jev x Claude: ${pct(revisados.filter((r) => r.jev_aprova === r.claude_aprova).length, revisados.length)}`);
console.log(`concordância nos portões (PT-BR, creator e red flag): ${pct(gateAgree, revisados.length)}`);
console.log(`concordância de categoria: ${pct(revisados.filter((r) => r.jev_categoria === r.claude_categoria).length, revisados.length)}`);
// Na amostra em duas etapas, separa a fronteira (onde o Jev mais erra) do controle (casos claros)
try {
  const chave = JSON.parse(read(`amostra_claude_${batchName}_chave.json`));
  for (const [nome, grupo] of [["fronteira", chave.fronteira], ["controle", chave.controle]]) {
    const rs = revisados.filter((r) => grupo.includes(r.channel_id));
    if (rs.length) console.log(`  ${nome}: ${rs.length} canais | Jev e Claude concordam em ${pct(rs.filter((r) => r.jev_aprova === r.claude_aprova).length, rs.length)}`);
  }
} catch {}
const humanas = out.filter((r) => r.decidido_por === "Michel");
if (humanas.length) {
  const bate = (col) => humanas.filter((r) => (r[col] === "sim") === (r.veredito === "Aprovado")).length;
  console.log(`decisões do Michel: ${humanas.length} | concordou com o Jev em ${bate("jev_aprova")} e com o Claude em ${bate("claude_aprova")}`);
}
for (const k of KEYS) {
  console.log(`  ${k}: diferença média ${mean(diffs[k]).toFixed(2)} | dentro de 1 ponto: ${(100 * diffs[k].filter((d) => d <= 1).length / diffs[k].length).toFixed(0)}%`);
}
