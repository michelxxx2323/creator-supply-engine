// Liga o Attio ao n8n: cria o webhook que avisa o W2 quando um creator muda de estágio no Supply pipeline.
// Uso: node scripts/attio_webhook.mjs <URL de produção do webhook do n8n>
//   ex.: node scripts/attio_webhook.mjs https://michel.app.n8n.cloud/webhook/attio-estagio
// Idempotente: se já existe um webhook para essa URL, não cria outro.

import { attio } from "./attio_api.mjs";

const url = process.argv[2];
if (!url?.startsWith("https://")) {
  console.error("Uso: node scripts/attio_webhook.mjs <URL https do webhook do n8n>");
  process.exit(1);
}
const lista = (await attio("GET", "lists/supply_pipeline")).data.id.list_id;
const existentes = (await attio("GET", "webhooks")).data;
const igual = existentes.find((w) => w.target_url === url);
if (igual) {
  console.log("webhook já existe:", igual.id.webhook_id, "| status:", igual.status);
} else {
  // Só eventos da lista Supply pipeline; o W2 ainda confere se o estágio virou "Contacted"
  const filtro = { $and: [{ field: "id.list_id", operator: "equals", value: lista }] };
  const { data } = await attio("POST", "webhooks", { data: {
    target_url: url,
    subscriptions: ["list-entry.created", "list-entry.updated"].map((event_type) => ({ event_type, filter: filtro })),
  } });
  console.log("webhook criado:", data.id.webhook_id, "| eventos:", data.subscriptions.map((s) => s.event_type).join(", "));
}
