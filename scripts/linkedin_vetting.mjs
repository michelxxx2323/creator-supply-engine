// Duplo vetting do LinkedIn: Jev e Claude avaliam perfil + últimos posts (lidos na Clay) e o código compara.
// Uso: node scripts/linkedin_vetting.mjs <lote>
// Entradas: data/linkedin_<lote>_perfis.json, linkedin_<lote>_posts.json, vetting_claude_linkedin_<lote>.json
// Saídas: data/vetting_jev_linkedin_<lote>.json e data/vetting_final_linkedin_<lote>.csv
// Mesmas regras de disputa do YouTube: vereditos, portões ou red flag diferentes, ou ≥ 2 pontos em fit Passionfroot ou qualidade.
// Claude por URL: [pt_br, red_flag, e_creator, 4 notas, categoria, justificativa].

import { readFileSync, writeFileSync } from "node:fs";
import {
  LINKEDIN_TRIAGEM, LINKEDIN_CRITERIA, OBJECTIVE, PESADOS, APROVACAO_MINIMA, FIT_MINIMO,
  notaEngajamentoLinkedin, notaConsistenciaLinkedin, perguntasJev, aplicarDecisao, soDiferencaDeNota, aprovaPelaMedia,
} from "./rubric.mjs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error("TYPESAFE_API_KEY não encontrada no .env");

const lote = process.argv[2];
if (!lote) {
  console.error("Uso: node scripts/linkedin_vetting.mjs <lote>");
  process.exit(1);
}
const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const perfis = read(`linkedin_${lote}_perfis.json`);
const posts = read(`linkedin_${lote}_posts.json`);
const claude = read(`vetting_claude_linkedin_${lote}.json`);
// Decisões humanas nas disputas, quando já existem
let decisoes = {};
try { decisoes = read(`decisoes_michel_linkedin_${lote}.json`).decisoes; } catch {}

const GATES = { pt_br: "Os posts da pessoa são escritos em português do Brasil", e_creator: LINKEDIN_TRIAGEM.gates.e_creator };
const RED_FLAGS = { apostas: "A pessoa promove apostas, cassinos ou jogos de azar", ...LINKEDIN_TRIAGEM.red_flags };
const KEYS = Object.keys(LINKEDIN_CRITERIA);
const questions = perguntasJev({ ...GATES, ...RED_FLAGS }, LINKEDIN_CRITERIA);

// Métricas objetivas: reposts sem texto não contam para engajamento
const DIA = 864e5;
function objetivas(url) {
  const ps = posts[url].posts.filter((p) => !p.repost_sem_texto && p.data);
  const reacoes = ps.map((p) => p.reacoes).sort((a, b) => a - b);
  const mediana = reacoes.length ? reacoes[Math.floor(reacoes.length / 2)] : 0;
  const porMil = perfis[url].seguidores ? (1000 * mediana) / perfis[url].seguidores : 0;
  const datas = ps.map((p) => new Date(p.data).getTime()).sort((a, b) => b - a);
  const ultimos30 = datas.filter((d) => Date.now() - d <= 30 * DIA).length;
  const dias3 = datas.length >= 3 ? (datas[0] - datas[2]) / DIA : Infinity;
  // Isca: post curto (até 30 caracteres, como "Excelente noite!" ou um emoji) com 100+ reações.
  // Critério absoluto: quando a isca domina o perfil, ela também puxa a mediana para cima.
  const isca = ps.some((p) => [...(p.texto ?? "")].length <= 30 && p.reacoes >= 100);
  return {
    mediana_reacoes: mediana,
    reacoes_por_mil: +porMil.toFixed(2),
    posts_30d: ultimos30,
    engajamento: notaEngajamentoLinkedin(porMil),
    consistencia: notaConsistenciaLinkedin(ultimos30, dias3),
    isca,
  };
}

const estado = (url) => {
  const p = perfis[url];
  return {
    nome: p.nome, headline: p.headline, sobre: p.sobre, seguidores: p.seguidores,
    cargos_atuais: p.experiencias_atuais.map((e) => `${e.cargo} @ ${e.empresa}`),
    posts_recentes: posts[url].posts.map((x) => ({ data: x.data, tipo: x.tipo, texto: x.texto, reacoes: x.reacoes, comentarios: x.comentarios })),
  };
};

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

const jevFile = new URL(`../data/vetting_jev_linkedin_${lote}.json`, import.meta.url);
let jev = {};
try { jev = JSON.parse(readFileSync(jevFile, "utf8")); } catch {}
const urls = Object.keys(posts);
await Promise.all(urls.filter((u) => !jev[u] || jev[u].erro).map(async (url) => {
  try {
    const a = (await ask(estado(url))).answers;
    jev[url] = {
      ...Object.fromEntries(Object.keys(GATES).map((k) => [k, a[k].noul])),
      red_flags: Object.fromEntries(Object.keys(RED_FLAGS).map((k) => [k, a[k].noul])),
      notas: Object.fromEntries(KEYS.map((k) => [k, +(a[k].score + 1).toFixed(2)])),
      confianca: Object.fromEntries(KEYS.map((k) => [k, a[k].confidence])),
      categoria: a.categoria.choice,
      categoria_confianca: a.categoria.confidence,
    };
  } catch (err) {
    jev[url] = { erro: String(err.message ?? err) };
  }
}));
writeFileSync(jevFile, JSON.stringify(jev, null, 1));

const peso = (k) => (LINKEDIN_CRITERIA[k] ?? OBJECTIVE[k]).peso;
const notaFinal = (notas) => Math.round(Object.entries(notas).reduce((s, [k, v]) => s + peso(k) * v, 0) / 5);

const out = [];
for (const url of urls) {
  const j = jev[url];
  const c = claude[url];
  if (!j || j.erro || !c) continue;
  const obj = objetivas(url);
  const objNotas = { engajamento: obj.engajamento, consistencia: obj.consistencia };
  const jevFlags = Object.entries(j.red_flags).filter(([, p]) => p >= 0.5).map(([k]) => k);
  const aval = {
    jev: { pt_br: j.pt_br >= 0.5, e_creator: j.e_creator >= 0.5, red_flag: jevFlags.length > 0, notas: { ...j.notas, ...objNotas } },
    claude: { pt_br: c[0] === 1, red_flag: c[1] === 1, e_creator: c[2] === 1, notas: { ...Object.fromEntries(KEYS.map((k, i) => [k, c[3 + i]])), ...objNotas } },
  };
  for (const a of Object.values(aval)) {
    a.nota = notaFinal(a.notas);
    a.aprovado = a.pt_br && a.e_creator && !a.red_flag && obj.posts_30d > 0
      && a.nota >= APROVACAO_MINIMA && a.notas.fit_passionfroot >= FIT_MINIMO;
  }
  const motivos = [];
  if (aval.jev.aprovado !== aval.claude.aprovado) motivos.push("vereditos diferentes");
  if (aval.jev.red_flag !== aval.claude.red_flag) motivos.push(`red flag divergente (Jev: ${jevFlags.join(", ") || "nenhuma"})`);
  if (aval.jev.e_creator !== aval.claude.e_creator) motivos.push("divergem se é creator");
  for (const k of PESADOS) {
    if (Math.abs(aval.jev.notas[k] - aval.claude.notas[k]) >= 2) motivos.push(`${k}: Jev ${aval.jev.notas[k]} x Claude ${aval.claude.notas[k]}`);
  }
  const decisao = aplicarDecisao(decisoes[perfis[url].nome], [aval.jev.aprovado, aval.claude.aprovado]);
  if (decisao?.motivo) motivos.push(decisao.motivo);
  const decidiu = decisao && !decisao.motivo; // a decisão do Michel continua valendo
  const pelaMedia = !decidiu && soDiferencaDeNota(motivos);
  const disputa = !decidiu && !pelaMedia && motivos.length > 0;
  const aprovado = pelaMedia ? aprovaPelaMedia(aval.jev, aval.claude) : aval.jev.aprovado;
  const categoria = c[3 + KEYS.length];
  out.push({
    nome: perfis[url].nome, linkedin: url, seguidores: perfis[url].seguidores,
    categoria, jev_categoria: j.categoria, claude_categoria: categoria,
    veredito: decidiu ? decisao.veredito : disputa ? "Disputa: Michel decide" : aprovado ? "Aprovado" : "Reprovado",
    decidido_por: decidiu ? "Michel" : disputa ? "" : pelaMedia ? "média Jev + Claude" : "consenso Jev + Claude",
    nota_final: disputa ? "" : Math.round((aval.jev.nota + aval.claude.nota) / 2),
    nota_jev: aval.jev.nota, nota_claude: aval.claude.nota,
    motivo_disputa: disputa ? motivos.join("; ") : "",
    observacoes: [pelaMedia && `decidido pela média (${motivos.join("; ")})`,
      obj.isca && "posts de isca de engajamento", obj.posts_30d === 0 && "sem posts nos últimos 30 dias",
      j.categoria !== categoria && `categoria: Jev ${j.categoria} x Claude ${categoria}`].filter(Boolean).join("; "),
    justificativa_claude: c[4 + KEYS.length],
    mediana_reacoes: obj.mediana_reacoes, reacoes_por_mil_seguidores: obj.reacoes_por_mil, posts_30d: obj.posts_30d,
    ...Object.fromEntries(KEYS.flatMap((k) => [[`jev_${k}`, aval.jev.notas[k]], [`claude_${k}`, aval.claude.notas[k]]])),
    engajamento: obj.engajamento, consistencia: obj.consistencia,
  });
}
const ordem = { "Aprovado": 0, "Disputa: Michel decide": 1, "Reprovado": 2 };
out.sort((a, b) => ordem[a.veredito] - ordem[b.veredito] || (b.nota_final || b.nota_claude) - (a.nota_final || a.nota_claude));
const header = Object.keys(out[0]);
const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
writeFileSync(new URL(`../data/vetting_final_linkedin_${lote}.csv`, import.meta.url),
  "﻿" + [header.join(","), ...out.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n"));

for (const r of out) {
  console.log(`${r.veredito} | ${r.nome} | final ${r.nota_final} (Jev ${r.nota_jev} / Claude ${r.nota_claude}) | ${r.reacoes_por_mil_seguidores} reações/mil | ${r.motivo_disputa} ${r.observacoes}`);
}
