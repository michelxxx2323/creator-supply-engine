// Sourcing de newsletters B2B no Substack (BR ou US, pelo nome do lote: us1 = EUA), pela busca pública do próprio Substack.
// Uso: node scripts/substack_sourcing.mjs <nome-do-lote>
// Variável opcional: MIN_ASSINANTES (padrão 1000).
// Saída: data/newsletters_<lote>.csv e data/newsletters_<lote>_states.json (estado para o Jev, como no YouTube).
// O beehiiv não tem busca pública; newsletters de lá entram à mão, a partir de listas.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { MERCADO } from "./rubric.mjs";
// O Substack só preenche o idioma quando a publicação escolhe um diferente do inglês: nos EUA, vazio conta como inglês
const IDIOMA = { BR: (l) => /^pt/.test(l ?? ""), US: (l) => !l || /^en/.test(l) }[MERCADO];

const lote = process.argv[2];
if (!lote) {
  console.error("Uso: node scripts/substack_sourcing.mjs <nome-do-lote>");
  process.exit(1);
}
const MIN_ASSINANTES = Number(process.env.MIN_ASSINANTES ?? 1000);

// Buscas por nicho do mapa de gaps (scripts/gap_map.mjs), com foco nos nichos sem supply.
// Lote 1 usou os nichos da rubrica de tech; do lote 2 em diante, as categorias Passionfroot com menos oferta.
const BUSCAS_POR_LOTE = {
  lote1: {
    "Produto e gestão": ["gestão de produto", "product manager", "produto digital", "liderança de times"],
    "Dados": ["análise de dados", "ciência de dados", "engenharia de dados", "power bi"],
    "Design": ["ux design", "design de produto", "ux research"],
    "RH": ["recursos humanos", "gestão de pessoas", "people analytics", "recrutamento e seleção"],
    "Finanças e contabilidade": ["finanças corporativas", "contabilidade", "gestão financeira empresas", "CFO"],
    "No-code": ["no-code", "low-code", "automação de processos"],
    "IA e automação": ["inteligência artificial para empresas", "agentes de IA", "IA generativa negócios"],
    "Vendas B2B": ["vendas B2B", "customer success", "SaaS"],
    "Marketing B2B": ["marketing B2B", "growth"],
    "Dev": ["engenharia de software", "carreira em tecnologia"],
  },
  lote2: {
    "Saúde": ["saúde mental", "nutrição", "medicina", "saúde no trabalho", "longevidade", "atividade física"],
    "Produtividade & Desenvolvimento pessoal": ["produtividade", "hábitos", "organização pessoal", "como estudar", "leitura", "foco e concentração"],
    "Finanças & Investimentos": ["finanças pessoais", "investimentos", "educação financeira", "economia brasileira", "renda fixa", "planejamento financeiro"],
    "Carreira": ["carreira", "mercado de trabalho", "entrevista de emprego", "liderança", "transição de carreira"],
    "Tech & Negócios": ["startups", "empreendedorismo", "founders", "venture capital"],
  },
  // Lote 3: nichos B2B da galeria da Passionfroot (creator-stories)
  lote3: {
    "Marketing & Design": ["marketing de produto", "branding", "copywriting", "social media para empresas", "design de interfaces", "product design", "growth"],
    "Tech & Negócios": ["product-led growth", "gestão de projetos", "PMO", "system design", "engenharia de dados", "SaaS B2B", "vendas consultivas", "prospecção", "cold email", "customer success", "e-commerce", "logística", "supply chain"],
    "Finanças & Investimentos": ["FP&A", "controladoria", "finanças corporativas", "valuation", "mercado financeiro carreira"],
    "Carreira": ["carreira em tecnologia", "liderança", "gestão de pessoas", "entrevista de emprego tech", "primeiro emprego"],
    "Saúde": ["healthtech", "saúde digital", "gestão em saúde"],
    "Outro": ["direito digital", "agronegócio", "construção civil gestão"],
  },
  // EUA, lote 1 (24/10): os mesmos nichos B2B da galeria, em inglês
  us1: {
    "Marketing & Design": ["B2B marketing", "product marketing", "demand generation", "brand strategy", "copywriting", "product design", "UX research"],
    "Tech & Negócios": ["SaaS", "product management", "startups", "founders", "sales leadership", "customer success", "RevOps", "data engineering", "engineering leadership"],
    "IA": ["AI for business", "AI agents", "applied AI"],
    "Finanças & Investimentos": ["FP&A", "CFO", "corporate finance", "fintech"],
    "Carreira": ["tech careers", "leadership", "people operations", "recruiting"],
    "Saúde": ["healthtech", "digital health", "healthcare operations"],
    "Produtividade & Desenvolvimento pessoal": ["productivity at work", "remote work"],
  },
};
export const BUSCAS = BUSCAS_POR_LOTE[lote] ?? BUSCAS_POR_LOTE.lote2;

const UA = { "User-Agent": "Mozilla/5.0" };
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    // Erro de rede (TLS recusado, conexão caída) conta como tentativa falha, não derruba o lote
    const res = await fetch(url, { headers: UA }).catch(() => null);
    if (!res) { await pausa(3000 * tentativa); continue; }
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status < 500) return null;
    await pausa(3000 * tentativa);
  }
  return null;
}
const cut = (s, n) => [...String(s ?? "")].slice(0, n).join("");

// "5.9K+ subscribers" → 5900; sem número exato, usa a faixa aproximada do Substack
const FAIXAS = { "Tens": 10, "Hundreds": 100, "Thousands": 1000, "Tens of thousands": 10000, "Hundreds of thousands": 100000 };
function assinantes(perfil) {
  const m = String(perfil?.subscriberCountString ?? "").match(/([\d.,]+)\s*([KM]?)\+?\s*subscriber/i);
  if (m) return Math.round(parseFloat(m[1].replace(",", "")) * ({ K: 1e3, M: 1e6 }[m[2].toUpperCase()] ?? 1));
  return FAIXAS[perfil?.rough_num_free_subscribers] ?? null;
}

// Publicações já vistas em outros lotes não entram de novo
const dataDir = new URL("../data/", import.meta.url);
const vistas = new Set(readdirSync(dataDir)
  .filter((f) => /^newsletters_.+_states\.json$/.test(f) && f !== `newsletters_${lote}_states.json`)
  .flatMap((f) => Object.keys(JSON.parse(readFileSync(new URL(f, dataDir), "utf8")))));

const pubs = new Map(); // subdomínio → { pub, handle, consultas }
for (const [nicho, consultas] of Object.entries(BUSCAS)) {
  for (const q of consultas) {
    const d = await get(`https://substack.com/api/v1/top/search?query=${encodeURIComponent(q)}&limit=50`);
    for (const item of d?.items ?? []) {
      const achados = item.type === "profileSearchResults"
        ? item.results.map((r) => ({ pub: r.primaryPublication, handle: r.handle }))
        : (item.context?.users ?? []).map((u) => ({ pub: u.primary_publication, handle: u.handle }));
      for (const { pub, handle } of achados) {
        if (!pub?.subdomain || !IDIOMA(pub.language)) continue;
        const atual = pubs.get(pub.subdomain) ?? { pub, handle, consultas: new Set(), nichos: new Set() };
        atual.consultas.add(q);
        atual.nichos.add(nicho);
        pubs.set(pub.subdomain, atual);
      }
    }
    await pausa(400);
  }
}
console.error(`publicações no idioma do mercado (${MERCADO}) encontradas: ${pubs.size}`);

const linhas = [];
const states = {};
const DIA = 864e5;
for (const [sub, { pub, handle, consultas, nichos }] of pubs) {
  if (vistas.has(sub)) continue;
  const perfil = await get(`https://substack.com/api/v1/user/${handle}/public_profile`);
  const n = assinantes(perfil);
  if (n !== null && n < MIN_ASSINANTES) continue;
  const base = pub.custom_domain ? `https://${pub.custom_domain}` : `https://${sub}.substack.com`;
  const posts = (await get(`${base}/api/v1/archive?sort=new&limit=10`)) ?? [];
  await pausa(300);
  const datas = posts.map((p) => new Date(p.post_date).getTime());
  const media = (k) => (posts.length ? +(posts.reduce((s, p) => s + (p[k] ?? 0), 0) / posts.length).toFixed(1) : 0);
  const linha = {
    pub_id: sub,
    nome: pub.name,
    link: base,
    autor: perfil?.name ?? "",
    assinantes: n ?? "",
    assinantes_texto: perfil?.subscriberCountString ?? perfil?.rough_num_free_subscribers ?? "",
    idioma: pub.language,
    nichos: [...nichos].join(" | "),
    posts_ultimos_30d: datas.filter((d) => Date.now() - d <= 30 * DIA).length,
    ultimo_post: posts[0]?.post_date?.slice(0, 10) ?? "",
    reacoes_medias_10: media("reaction_count"),
    comentarios_medios_10: media("comment_count"),
    pagos_nos_10: posts.filter((p) => p.audience === "only_paid").length,
    consultas: [...consultas].join(" | "),
  };
  linha.passa_portao_30d = linha.posts_ultimos_30d > 0 ? "sim" : "não";
  linhas.push(linha);
  states[sub] = {
    nome: pub.name,
    autor: perfil?.name ?? "",
    bio_autor: cut(perfil?.bio, 500),
    assinantes: linha.assinantes_texto,
    posts_recentes: posts.map((p) => ({
      data: p.post_date?.slice(0, 10), titulo: p.title, subtitulo: cut(p.subtitle, 200),
      tipo: p.type, so_pagantes: p.audience === "only_paid", trecho: cut(p.truncated_body_text ?? p.description, 400),
    })),
  };
}

const header = Object.keys(linhas[0] ?? { pub_id: "" });
const cell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
writeFileSync(new URL(`newsletters_${lote}.csv`, dataDir),
  "﻿" + [header.join(","), ...linhas.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n"));
writeFileSync(new URL(`newsletters_${lote}_states.json`, dataDir), JSON.stringify(states, null, 1));
console.error(`com ${MIN_ASSINANTES}+ assinantes (ou sem número público): ${linhas.length}`
  + ` | postaram nos últimos 30 dias: ${linhas.filter((l) => l.passa_portao_30d === "sim").length}`);
