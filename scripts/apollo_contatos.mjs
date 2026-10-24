// Leva os creators aprovados no vetting do LinkedIn para o Apollo, como contatos numa lista.
// O e-mail é revelado depois, na interface do Apollo: no plano gratuito a API de enrich de pessoas é bloqueada.
// Uso: node scripts/apollo_contatos.mjs <lote>
// Lê data/vetting_final_linkedin_<lote>.csv (só Aprovado) e grava data/apollo_contatos_<lote>.json.
// Rodar de novo não duplica: pula quem já tem id salvo e pede deduplicação ao Apollo.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const LISTA = "Creator Supply — LinkedIn";
const lote = process.argv[2];
if (!lote) {
  console.error("Uso: node scripts/apollo_contatos.mjs <lote>");
  process.exit(1);
}
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^APOLLO_API_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error("APOLLO_API_KEY não encontrada no .env");

const dataDir = new URL("../data/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dataDir), "utf8");
const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"'));
const [head, ...linhas] = read(`vetting_final_linkedin_${lote}.csv`).replace(/^﻿/, "").split("\n");
const header = head.split(",");
const aprovados = linhas.map((l) => Object.fromEntries(cells(l).map((v, i) => [header[i], v]))).filter((r) => r.veredito === "Aprovado");

const perfis = JSON.parse(read(`linkedin_${lote}_perfis.json`));
// Lotes que vieram de lista (não da busca da Clay) não têm o arquivo da busca: o nome sai do perfil
const busca = existsSync(new URL(`linkedin_${lote}_raw.json`, dataDir))
  ? Object.fromEntries(JSON.parse(read(`linkedin_${lote}_raw.json`)).data.map((r) => [r.linkedin_url, r])) : {};
function nomes(r) {
  if (busca[r.linkedin]) return busca[r.linkedin];
  const [first_name, ...resto] = r.nome.replace(/\(.*?\)/g, "").trim().split(/\s+/);
  return { first_name, last_name: resto.join(" ") };
}
const arquivo = new URL(`apollo_contatos_${lote}.json`, dataDir);
const saida = existsSync(arquivo) ? JSON.parse(readFileSync(arquivo, "utf8")) : {};

let criados = 0;
for (const r of aprovados) {
  if (saida[r.linkedin]?.apollo_contact_id) continue;
  const atual = perfis[r.linkedin].experiencias_atuais[0] ?? {};
  const res = await fetch("https://api.apollo.io/api/v1/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": KEY },
    body: JSON.stringify({
      first_name: nomes(r).first_name,
      last_name: nomes(r).last_name,
      title: atual.cargo,
      organization_name: atual.empresa,
      linkedin_url: r.linkedin,
      label_names: [LISTA],
      run_dedupe: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${r.nome}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    if ([401, 403, 422, 429].includes(res.status)) break;
    continue;
  }
  saida[r.linkedin] = { nome: r.nome, apollo_contact_id: body.contact?.id, nota_final: r.nota_final };
  criados++;
}
writeFileSync(arquivo, JSON.stringify(saida, null, 1));
console.log(`aprovados: ${aprovados.length} | criados agora: ${criados} | no Apollo: ${Object.values(saida).filter((x) => x.apollo_contact_id).length} | lista: ${LISTA}`);
