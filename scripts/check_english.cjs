// Uso: node scripts/check_english.cjs  (rodar antes de cada push do creators.html)
// Procura texto visível que continua em português quando a página abre em inglês (?lang=en):
// texto fora de qualquer elemento com data-en é mostrado como está.
const fs = require("fs");
const html = fs.readFileSync(require("path").join(__dirname, "..", "..", "portfolio", "creators.html"), "utf8")
  .replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
const VAZIOS = new Set(["br", "img", "meta", "link", "input", "hr", "source", "path", "rect", "line", "circle", "polygon"]);
const pilha = [];
const achados = [];
const PT = /\b(de|que|não|para|com|uma|um|dos|das|nos|pelo|pela|são|está|você|também|ção|ões)\b|ção|ões|ê|ã/i;
for (const m of html.matchAll(/<\/?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g)) {
  if (m[3] !== undefined) {
    const txt = m[3].replace(/&[a-z]+;/g, " ").trim();
    if (!txt || pilha.some((e) => e.en)) continue;
    if (PT.test(txt)) achados.push(`${pilha.map((e) => e.tag).slice(-3).join(">")}: ${txt.slice(0, 110)}`);
    continue;
  }
  const tag = m[1].toLowerCase();
  if (m[0].startsWith("</")) { while (pilha.length && pilha.pop().tag !== tag); continue; }
  if (VAZIOS.has(tag) || m[0].endsWith("/>")) continue;
  pilha.push({ tag, en: /\sdata-en=/.test(m[2]) });
}
console.log(`trechos em português sem tradução: ${achados.length}`);
for (const a of achados) console.log(" -", a);
