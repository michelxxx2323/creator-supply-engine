// Duplo vetting das newsletters, em duas etapas como no lote 3 do YouTube.
// Uso:
//   node scripts/newsletter_vetting.mjs <lote> jev       → Jev avalia todas e sorteia a amostra do Claude (sem imprimir notas)
//   node scripts/newsletter_vetting.mjs <lote> comparar  → junta Jev, Claude e decisões do Michel
// Entradas: data/newsletters_<lote>.csv e _states.json; vetting_claude_newsletters_<lote>.json
// (índice → [pt_br, red_flag, e_creator, 4 notas, categoria, justificativa])
// Saídas: data/vetting_jev_newsletters_<lote>.json, amostra_claude_newsletters_<lote>.json, vetting_final_newsletters_<lote>.csv

import { readFileSync, writeFileSync } from "node:fs";
import {
  NEWSLETTER, OBJECTIVE, PESADOS, APROVACAO_MINIMA, FIT_MINIMO, notaEngajamentoNewsletter, notaConsistencia,
  perguntasJev, aplicarDecisao, soDiferencaDeNota, aprovaPelaMedia,
} from "./rubric.mjs";

const [lote, modo] = process.argv.slice(2);
if (!lote || !["jev", "comparar"].includes(modo)) {
  console.error("Uso: node scripts/newsletter_vetting.mjs <lote> <jev|comparar>");
  process.exit(1);
}
const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");
const write = (f, s) => writeFileSync(new URL(f, dataDir), s);
const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"'));
const [head, ...corpo] = read(`newsletters_${lote}.csv`).replace(/^﻿/, "").split("\n");
const header = head.split(",");
const pubs = Object.fromEntries(corpo.map((l) => Object.fromEntries(cells(l).map((v, i) => [header[i], v]))).map((r) => [r.pub_id, r]));
const states = JSON.parse(read(`newsletters_${lote}_states.json`));
const ids = Object.keys(states); // a ordem que o Claude usa nos índices

const KEYS = Object.keys(NEWSLETTER.criteria);
const peso = (k) => (NEWSLETTER.criteria[k] ?? OBJECTIVE[k]).peso;
const notaFinal = (notas) => Math.round(Object.entries(notas).reduce((s, [k, v]) => s + peso(k) * v, 0) / 5);
const objetivas = (p) => {
  const porMil = p.assinantes ? (1000 * Number(p.reacoes_medias_10)) / Number(p.assinantes) : 0;
  return { reacoes_por_mil: +porMil.toFixed(2), engajamento: notaEngajamentoNewsletter(porMil), consistencia: notaConsistencia(p.posts_ultimos_30d) };
};
const jevFile = `vetting_jev_newsletters_${lote}.json`;

if (modo === "jev") {
  const env = read("../.env");
  const KEY = env.match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1].trim();
  if (!KEY) throw new Error("TYPESAFE_API_KEY não encontrada no .env");
  const questions = perguntasJev({ ...NEWSLETTER.gates, ...NEWSLETTER.red_flags }, NEWSLETTER.criteria);

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

  let jev = {};
  try { jev = JSON.parse(read(jevFile)); } catch {}
  const faltam = ids.filter((id) => !jev[id] || jev[id].erro);
  for (let i = 0; i < faltam.length; i += 5) {
    await Promise.all(faltam.slice(i, i + 5).map(async (id) => {
      try {
        const a = (await ask(states[id])).answers;
        jev[id] = {
          ...Object.fromEntries(Object.keys(NEWSLETTER.gates).map((k) => [k, a[k].noul])),
          red_flags: Object.fromEntries(Object.keys(NEWSLETTER.red_flags).map((k) => [k, a[k].noul])),
          notas: Object.fromEntries(KEYS.map((k) => [k, +(a[k].score + 1).toFixed(2)])),
          confianca: Object.fromEntries(KEYS.map((k) => [k, a[k].confidence])),
          categoria: a.categoria.choice,
          categoria_confianca: a.categoria.confidence,
        };
      } catch (err) {
        jev[id] = { erro: String(err.message ?? err) };
      }
    }));
  }
  write(jevFile, JSON.stringify(jev, null, 1));

  // Amostra do Claude: fronteira (nota 55–65 ou portão de creator em dúvida) + 15% dos casos claros, com semente fixa
  let semente = 42;
  const sorteio = () => ((semente = (semente * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const fronteira = [], claros = [];
  for (const [i, id] of ids.entries()) {
    const j = jev[id];
    if (!j || j.erro) continue;
    const { engajamento, consistencia } = objetivas(pubs[id]);
    const nota = notaFinal({ ...j.notas, engajamento, consistencia });
    const duvida = (j.e_creator >= 0.4 && j.e_creator <= 0.7) || (j.pt_br >= 0.4 && j.pt_br <= 0.6);
    (nota >= 55 && nota <= 65) || duvida ? fronteira.push(i) : claros.push(i);
  }
  const controle = claros.filter(() => sorteio() < 0.15);
  write(`amostra_claude_newsletters_${lote}.json`, JSON.stringify({ indices: [...fronteira, ...controle].sort((a, b) => a - b) }));
  write(`amostra_claude_newsletters_${lote}_chave.json`, JSON.stringify({ fronteira: fronteira.map((i) => ids[i]), controle: controle.map((i) => ids[i]) }));
  console.log(`Jev: ${Object.values(jev).filter((j) => !j.erro).length} avaliadas, ${Object.values(jev).filter((j) => j.erro).length} erros`
    + ` | amostra do Claude: ${fronteira.length + controle.length} (os índices estão em amostra_claude_newsletters_${lote}.json)`);
  process.exit(0);
}

// modo comparar
const jev = JSON.parse(read(jevFile));
let claude = {};
try { claude = JSON.parse(read(`vetting_claude_newsletters_${lote}.json`)); } catch {}
let decisoes = {};
try { decisoes = JSON.parse(read(`decisoes_michel_newsletters_${lote}.json`)).decisoes; } catch {}
const chave = JSON.parse(read(`amostra_claude_newsletters_${lote}_chave.json`));

const out = [];
for (const [i, id] of ids.entries()) {
  const p = pubs[id];
  const j = jev[id];
  if (!j || j.erro) continue;
  const obj = objetivas(p);
  const portao30d = p.passa_portao_30d === "sim";
  const jevFlags = Object.entries(j.red_flags).filter(([, v]) => v >= 0.5).map(([k]) => k);
  const aval = { jev: { pt_br: j.pt_br >= 0.5, e_creator: j.e_creator >= 0.5, red_flag: jevFlags.length > 0, notas: { ...j.notas, engajamento: obj.engajamento, consistencia: obj.consistencia } } };
  const c = claude[i];
  if (c) aval.claude = { pt_br: c[0] === 1, red_flag: c[1] === 1, e_creator: c[2] === 1, notas: { ...Object.fromEntries(KEYS.map((k, n) => [k, c[3 + n]])), engajamento: obj.engajamento, consistencia: obj.consistencia } };
  for (const a of Object.values(aval)) {
    a.nota = notaFinal(a.notas);
    a.aprovado = a.pt_br && a.e_creator && !a.red_flag && portao30d
      && a.nota >= APROVACAO_MINIMA && a.notas.fit_passionfroot >= FIT_MINIMO;
  }
  const motivos = [];
  if (aval.claude) {
    if (aval.jev.aprovado !== aval.claude.aprovado) motivos.push("vereditos diferentes");
    if (aval.jev.red_flag !== aval.claude.red_flag) motivos.push(`red flag divergente (Jev: ${jevFlags.join(", ") || "nenhuma"})`);
    if (aval.jev.e_creator !== aval.claude.e_creator) motivos.push("divergem se é creator");
    for (const k of PESADOS) {
      if (Math.abs(aval.jev.notas[k] - aval.claude.notas[k]) >= 2) motivos.push(`${k}: Jev ${aval.jev.notas[k]} x Claude ${aval.claude.notas[k]}`);
    }
  }
  const decisao = aplicarDecisao(decisoes[p.nome], [aval.jev.aprovado, aval.claude?.aprovado]);
  if (decisao?.motivo) motivos.push(decisao.motivo);
  const decidiu = decisao && !decisao.motivo; // a decisão do Michel continua valendo
  const pelaMedia = !decidiu && soDiferencaDeNota(motivos);
  const disputa = !decidiu && !pelaMedia && motivos.length > 0;
  const aprovado = pelaMedia ? aprovaPelaMedia(aval.jev, aval.claude) : aval.jev.aprovado;
  const claudeCategoria = c?.[3 + KEYS.length] ?? "";
  out.push({
    pub_id: id, nome: p.nome, link: p.link, autor: p.autor, assinantes: p.assinantes, nichos: p.nichos,
    categoria: claudeCategoria || j.categoria, jev_categoria: j.categoria, claude_categoria: claudeCategoria,
    veredito: decidiu ? decisao.veredito : disputa ? "Disputa: Michel decide" : aprovado ? "Aprovado" : "Reprovado",
    decidido_por: decidiu ? "Michel" : disputa ? "" : pelaMedia ? "média Jev + Claude"
      : aval.claude ? "consenso Jev + Claude" : "só Jev (fora da amostra)",
    nota_final: disputa ? "" : aval.claude ? Math.round((aval.jev.nota + aval.claude.nota) / 2) : aval.jev.nota,
    nota_jev: aval.jev.nota, nota_claude: aval.claude?.nota ?? "",
    motivo_disputa: disputa ? motivos.join("; ") : pelaMedia ? `decidido pela média (${motivos.join("; ")})` : "",
    justificativa_claude: c?.[4 + KEYS.length] ?? "",
    portao_30d: portao30d ? "sim" : "não", reacoes_por_mil_assinantes: obj.reacoes_por_mil,
    ...Object.fromEntries(KEYS.flatMap((k) => [[`jev_${k}`, aval.jev.notas[k]], [`claude_${k}`, aval.claude?.notas[k] ?? ""]])),
    engajamento: obj.engajamento, consistencia: obj.consistencia,
  });
}
const ordem = { "Aprovado": 0, "Disputa: Michel decide": 1, "Reprovado": 2 };
out.sort((a, b) => ordem[a.veredito] - ordem[b.veredito] || (b.nota_final || b.nota_jev) - (a.nota_final || a.nota_jev));
const cols = Object.keys(out[0]);
const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
write(`vetting_final_newsletters_${lote}.csv`, "﻿" + [cols.join(","), ...out.map((r) => cols.map((h) => cell(r[h])).join(","))].join("\n"));

const conta = (v) => out.filter((r) => r.veredito === v).length;
const pct = (n, d) => `${(100 * n / d).toFixed(1)}%`;
console.log(`newsletters: ${out.length} | aprovadas: ${conta("Aprovado")} | reprovadas: ${conta("Reprovado")} | disputas: ${conta("Disputa: Michel decide")}`);
for (const [nome, grupo] of [["fronteira", chave.fronteira], ["controle", chave.controle]]) {
  const rs = out.filter((r) => grupo.includes(r.pub_id) && r.nota_claude !== "");
  const iguais = rs.filter((r) => !r.motivo_disputa.includes("vereditos diferentes")).length;
  if (rs.length) console.log(`  ${nome}: ${rs.length} | Jev e Claude com o mesmo veredito em ${pct(iguais, rs.length)}`);
}
