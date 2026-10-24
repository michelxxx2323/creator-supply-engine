// Chamada à API do Attio com a chave do .env e nova tentativa quando bate no limite de taxa
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const KEY = env.match(/^ATTIO_API_KEY=(.+)$/m)?.[1].trim();
if (!KEY) throw new Error("ATTIO_API_KEY não encontrada no .env");

export async function attio(method, path, body) {
  for (let tentativa = 1; ; tentativa++) {
    const res = await fetch(`https://api.attio.com/v2/${path}`, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && tentativa < 5) { await new Promise((r) => setTimeout(r, 1000 * tentativa)); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }
}
