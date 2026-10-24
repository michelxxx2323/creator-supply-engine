// Sourcing de creators BR no YouTube: busca vídeos recentes em PT-BR por tema,
// agrupa por canal e coleta os sinais do scorecard. Sem dependências (Node 22+).
//
// Uso: node scripts/youtube_sourcing.mjs <nome-do-lote> "consulta 1" "consulta 2" ...
// Custo de cota: 100 unidades por consulta + ~3 unidades a cada 50 canais.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^YOUTUBE_API_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error("YOUTUBE_API_KEY não encontrada no .env");

const [batchName, ...queries] = process.argv.slice(2);
if (!batchName || queries.length === 0) {
  console.error('Uso: node scripts/youtube_sourcing.mjs <nome-do-lote> "consulta" ...');
  process.exit(1);
}

// Configuráveis por variável de ambiente: PAGES=3 MIN_SUBS=1000 node scripts/youtube_sourcing.mjs ...
const MIN_SUBS = Number(process.env.MIN_SUBS ?? 5_000);
const MAX_SUBS = 1_000_000;
const PAGES = Number(process.env.PAGES ?? 1); // cada página custa 100 unidades e traz até 50 vídeos
const DAYS_BACK = 90;
const RECENT_DAYS = 30;

let unitsUsed = 0;

async function yt(endpoint, params, cost) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = await res.json();
  unitsUsed += cost;
  if (json.error) throw new Error(`${endpoint}: ${json.error.code} ${json.error.message}`);
  return json;
}

// Corta por caractere, não por unidade UTF-16, para não partir emojis ao meio
const cut = (s, n) => Array.from(s ?? "").slice(0, n).join("");
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 86_400_000;

// 1. Vídeos recentes por consulta → canais e quantas consultas acharam cada um
const publishedAfter = new Date(Date.now() - DAYS_BACK * 86_400_000).toISOString();
const hits = new Map(); // channelId → Set de consultas
for (const q of queries) {
  let pageToken;
  let videos = 0;
  for (let page = 0; page < PAGES; page++) {
    const res = await yt("search", {
      part: "snippet", type: "video", q, maxResults: 50,
      regionCode: "BR", relevanceLanguage: "pt", publishedAfter,
      ...(pageToken ? { pageToken } : {}),
    }, 100);
    for (const item of res.items) {
      const id = item.snippet.channelId;
      if (!hits.has(id)) hits.set(id, new Set());
      hits.get(id).add(q);
    }
    videos += res.items.length;
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  console.error(`"${q}": ${videos} vídeos`);
}

// Canais já vistos em lotes anteriores não são buscados de novo
const dataDir = new URL("../data/", import.meta.url);
mkdirSync(dataDir, { recursive: true });
const jaVistos = new Set(readdirSync(dataDir)
  .filter((f) => /^youtube_.+_states\.json$/.test(f) && f !== `youtube_${batchName}_states.json`)
  .flatMap((f) => Object.keys(JSON.parse(readFileSync(new URL(f, dataDir), "utf8")))));
for (const id of jaVistos) hits.delete(id);
console.error(`canais já vistos em lotes anteriores: ${jaVistos.size} (ignorados)`);

// 2. Dados dos canais
const channels = [];
for (const ids of chunk([...hits.keys()], 50)) {
  const res = await yt("channels", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, 1);
  channels.push(...res.items);
}

// 3. Filtro barato antes de gastar mais cota: país, porte e nome
const candidates = channels.filter((c) => {
  const subs = Number(c.statistics.subscriberCount ?? 0);
  const country = c.snippet.country;
  return (!country || country === "BR")
    && !c.statistics.hiddenSubscriberCount
    && subs >= MIN_SUBS && subs <= MAX_SUBS
    && !/\bcortes?\b/i.test(c.snippet.title);
});

// 4. Últimos 10 vídeos de cada candidato → cadência, views médias e o "estado" para o vetting
const rows = [];
const states = {};
for (const c of candidates) {
  const uploads = c.contentDetails.relatedPlaylists.uploads;
  const pl = await yt("playlistItems", { part: "snippet,contentDetails", playlistId: uploads, maxResults: 10 }, 1);
  const videoIds = pl.items.map((i) => i.contentDetails.videoId);
  const dates = pl.items.map((i) => i.contentDetails.videoPublishedAt).filter(Boolean);
  let avgViews = 0;
  if (videoIds.length) {
    const vids = await yt("videos", { part: "statistics", id: videoIds.join(",") }, 1);
    const views = vids.items.map((v) => Number(v.statistics.viewCount ?? 0));
    avgViews = Math.round(views.reduce((a, b) => a + b, 0) / views.length);
  }
  const desc = c.snippet.description ?? "";
  const subs = Number(c.statistics.subscriberCount);
  const lastVideo = dates.length ? [...dates].sort().at(-1) : "";
  // Mesma entrada para os dois avaliadores (Jev e Claude); textos cortados para caber
  states[c.id] = {
    canal: c.snippet.title,
    descricao_do_canal: cut(desc, 600),
    ultimos_videos: pl.items.map((i) => ({
      titulo: i.snippet.title,
      descricao: cut(i.snippet.description, 150),
      data: (i.contentDetails.videoPublishedAt ?? "").slice(0, 10),
    })),
  };
  rows.push({
    channel_id: c.id,
    nome: c.snippet.title,
    link: c.snippet.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}`,
    plataforma_principal: "YouTube",
    instagram: desc.match(/instagram\.com\/([A-Za-z0-9_.]+)/i)?.[0] ?? "",
    linkedin: desc.match(/linkedin\.com\/(in|company)\/[A-Za-z0-9_\-%]+/i)?.[0] ?? "",
    pais: c.snippet.country ?? "",
    inscritos: subs,
    porte: subs < 100_000 ? "micro" : "médio",
    views_medias_10: avgViews,
    views_por_inscrito: (avgViews / subs).toFixed(3),
    videos_ultimos_30d: dates.filter((d) => daysAgo(d) <= RECENT_DAYS).length,
    ultimo_video: lastVideo.slice(0, 10),
    passa_portao_30d: lastVideo && daysAgo(lastVideo) <= RECENT_DAYS ? "sim" : "não",
    // Só sim/não: e-mails e telefones não entram no arquivo (LGPD)
    contato_comercial: /[\w.+-]+@[\w-]+\.[\w.]+|parceria|publi|contato comercial|business|m[ií]dia ?kit/i.test(desc) ? "sim" : "não",
    consultas: [...hits.get(c.id)].join(" | "),
    n_consultas: hits.get(c.id).size,
  });
}

rows.sort((a, b) => b.n_consultas - a.n_consultas || b.views_medias_10 - a.views_medias_10);

const csvCell = (v) => `"${String(v).replaceAll('"', '""')}"`;
const header = Object.keys(rows[0] ?? { nome: "" });
const csv = [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n");
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const out = new URL(`../data/youtube_${batchName}.csv`, import.meta.url);
writeFileSync(out, "﻿" + csv); // BOM para o Excel abrir acentos certo
writeFileSync(new URL(`../data/youtube_${batchName}_states.json`, import.meta.url), JSON.stringify(states, null, 1));

console.error(`canais encontrados: ${channels.length} | candidatos após filtro: ${rows.length} | cota usada: ${unitsUsed} unidades`);
console.log(out.pathname);
