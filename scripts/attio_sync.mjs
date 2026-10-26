// Leva o supply avaliado para o Attio: aprovados e disputas de YouTube, LinkedIn e newsletters.
// Uso: node scripts/attio_sync.mjs
// Cria ou atualiza o creator em People (deduplicado pelo creator_id) e põe na lista "Supply pipeline":
// Aprovado → Vetted, Disputa → Sourced. Quem já está na lista mantém o estágio (o funil não anda para trás).

import { readFileSync, readdirSync } from "node:fs";
import { attio } from "./attio_api.mjs";
import { CATEGORIAS_EN, MERCADOS, mercadoDoLote } from "./rubric.mjs";

const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");
const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"'));
function parseCsv(text) {
  const [head, ...linhas] = text.replace(/^﻿/, "").split("\n").filter((l) => l.trim());
  const header = head.split(",");
  return linhas.map((l) => Object.fromEntries(cells(l).map((v, i) => [header[i], v])));
}

// Faixas de preço da tabela da Passionfroot para YouTube (ver guardrail.mjs)
const precoTabela = (inscritos) => (inscritos < 100_000 ? 500 : inscritos < 500_000 ? 1500 : 3000);
// Os CSVs estão em PT; o Attio, em inglês
const DECIDIDO_EN = { "consenso Jev + Claude": "Jev + Claude agree", "média Jev + Claude": "Jev + Claude average", "só Jev": "Jev only", Michel: "Michel" };
const decididoPor = (d) => DECIDIDO_EN[d.startsWith("só Jev") ? "só Jev" : d] ?? null;
const nota = (r) => Number(r.nota_final || Math.round((Number(r.nota_jev) + Number(r.nota_claude || r.nota_jev)) / 2));
const fit = (r) => Number(r.claude_fit_passionfroot || r.jev_fit_passionfroot);

// Resumo do conteúdo para o W1 ranquear contra o brief: bio ou descrição + títulos recentes, no idioma do creator
const cortar = (s, n) => [...String(s ?? "").replace(/\s+/g, " ").trim()].slice(0, n).join("");
const estados = {};
for (const f of readdirSync(dataDir).filter((f) => /_states\.json$/.test(f))) Object.assign(estados, JSON.parse(read(f)));
const perfisLi = {}, postsLi = {};
for (const f of readdirSync(dataDir)) {
  if (/^linkedin_.+_perfis\.json$/.test(f)) Object.assign(perfisLi, JSON.parse(read(f)));
  if (/^linkedin_.+_posts\.json$/.test(f)) Object.assign(postsLi, JSON.parse(read(f)));
}
function resumo(c) {
  if (c.plataforma === "YouTube") {
    const s = estados[c.channel_id];
    if (!s) return null;
    return cortar(s.descricao_do_canal, 300) + " | Recent videos: " + (s.ultimos_videos ?? []).slice(0, 6).map((v) => cortar(v.titulo, 90)).join(" / ");
  }
  if (c.plataforma === "Newsletter") {
    const s = estados[c.pub_id];
    if (!s) return null;
    return cortar(s.bio_autor, 200) + " | Recent posts: " + (s.posts_recentes ?? []).slice(0, 6).map((p) => cortar(p.titulo, 90)).join(" / ");
  }
  const p = perfisLi[c.linkedin];
  if (!p) return null;
  return cortar(p.headline, 160) + " | " + cortar(p.sobre, 250) + " | Recent posts: " + (postsLi[c.linkedin]?.posts ?? []).slice(0, 3).map((x) => cortar(x.texto, 120)).join(" / ");
}

const creators = [];
const arquivos = readdirSync(dataDir);
// Lotes loteN são do Brasil; usN, dos EUA
const LOTE = /(lote|us)\d+/;
for (const f of arquivos.filter((f) => /^vetting_final_(lote|us)\d+\.csv$/.test(f))) {
  for (const r of parseCsv(read(f))) creators.push({ ...r, plataforma: "YouTube", id: `yt:${r.channel_id}`, link: r.link,
    audiencia: Number(r.inscritos), preco: precoTabela(Number(r.inscritos)), lote: f.match(LOTE)[0] });
}
for (const f of arquivos.filter((f) => /^vetting_final_linkedin_.+\.csv$/.test(f))) {
  for (const r of parseCsv(read(f))) creators.push({ ...r, plataforma: "LinkedIn", id: `li:${r.linkedin}`, link: r.linkedin,
    audiencia: Number(r.seguidores), lote: `linkedin_${f.match(LOTE)[0]}` });
}
for (const f of arquivos.filter((f) => /^vetting_final_newsletters_.+\.csv$/.test(f))) {
  for (const r of parseCsv(read(f))) creators.push({ ...r, plataforma: "Newsletter", id: `nl:${r.pub_id}`, link: r.link,
    audiencia: Number(r.assinantes) || null, lote: `newsletters_${f.match(LOTE)[0]}`, nomePessoa: r.autor });
}
const alvo = creators.filter((c) => c.veredito === "Aprovado" || c.veredito.startsWith("Disputa")).slice(0, Number(process.env.LIMITE) || undefined);

// Registros e entradas que já estão no Attio
async function todos(path) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const { data } = await attio("POST", path, { limit: 500, offset });
    out.push(...data);
    if (data.length < 500) return out;
  }
}
const porCreatorId = new Map();
// Rejeitados à mão no Attio (decisão do Michel, ex.: personas sintéticas em 26/10) não voltam a Approved
const rejeitadosNoAttio = new Set();
for (const p of await todos("objects/people/records/query")) {
  const id = p.values.creator_id?.[0]?.value;
  if (id) porCreatorId.set(id, p.id.record_id);
  if (id && p.values.verdict?.[0]?.option?.title === "Rejected") rejeitadosNoAttio.add(id);
}
const naLista = new Set((await todos("lists/supply_pipeline/entries/query")).map((e) => e.parent_record_id));

// O Attio recusa null: campo sem valor fica de fora
const semVazios = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "" && !Number.isNaN(v)));

function valores(c) {
  const nome = c.nomePessoa || c.nome;
  return semVazios({
    name: [{ first_name: "", last_name: "", full_name: nome }],
    description: c.plataforma === "Newsletter" ? c.nome : null,
    creator_id: c.id,
    platform: c.plataforma,
    market: MERCADOS[mercadoDoLote(c.lote.replace(/^(linkedin|newsletters)_/, ""))].nome,
    main_link: c.link,
    ...(c.plataforma === "LinkedIn" ? { linkedin: c.link } : {}),
    passionfroot_category: CATEGORIAS_EN[c.categoria] ?? null,
    audience: c.audiencia || null,
    final_score: nota(c),
    passionfroot_fit: fit(c) || null,
    verdict: c.veredito.startsWith("Disputa") ? "Dispute" : "Approved",
    decided_by: decididoPor(c.decidido_por),
    rate_card_usd: c.preco ?? null,
    vetting_rationale: c.justificativa_claude || null,
    dispute_reason: c.motivo_disputa || null,
    batch: c.lote,
    content_summary: resumo(c),
  });
}

let criados = 0, atualizados = 0, entradas = 0, falhas = 0;
for (let i = 0; i < alvo.length; i += 5) {
  await Promise.all(alvo.slice(i, i + 5).map(async (c) => {
    try {
      if (rejeitadosNoAttio.has(c.id)) return;
      let recordId = porCreatorId.get(c.id);
      if (recordId) {
        await attio("PATCH", `objects/people/records/${recordId}`, { data: { values: valores(c) } });
        atualizados++;
      } else {
        recordId = (await attio("POST", "objects/people/records", { data: { values: valores(c) } })).data.id.record_id;
        porCreatorId.set(c.id, recordId);
        criados++;
      }
      if (!naLista.has(recordId)) {
        await attio("POST", "lists/supply_pipeline/entries", { data: {
          parent_record_id: recordId, parent_object: "people",
          entry_values: { stage: c.veredito === "Aprovado" ? "Vetted" : "Sourced" },
        } });
        naLista.add(recordId);
        entradas++;
      }
    } catch (err) {
      falhas++;
      if (falhas <= 3) console.error(c.nome, String(err.message).slice(0, 900));
    }
  }));
}
console.log(`creators no alvo: ${alvo.length} | criados: ${criados} | atualizados: ${atualizados} | novos na lista: ${entradas} | falhas: ${falhas}`);
