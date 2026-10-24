// Guardrail de views x inscritos.
// Compara views médias por inscrito (escala log) com o segmento de preço do creator na tabela da Passionfroot.
// Usa mediana e MAD (desvio robusto), para poucos canais virais não distorcerem a referência.
// z = quantos desvios o creator está acima (+) ou abaixo (−) da mediana do segmento.

// Preço de tabela de um integrated ad no YouTube (Passionfroot Sponsorship Pricing Guide 2.0)
export const SEGMENTOS = [
  { nome: "até 100k", ate: 100_000, preco: 500 },
  { nome: "100k–500k", ate: 500_000, preco: 1_500 },
  { nome: "500k–1M", ate: 1_000_000, preco: 3_000 },
];

// Teto por alcance real: o preço nunca passa de US$ 100 por mil views médias (3 a 6 vezes o CPM de mercado,
// de US$ 15 a 30), com piso de US$ 200 para o creator pequeno não sair por um valor simbólico.
// O teto só reduz o preço; nunca aumenta.
export const CPM_TETO = 100;
export const PISO = 200;

export const FAIXAS = [
  { min: -Infinity, nome: "views incompatíveis", multiplicador: null }, // sai da shortlist
  { min: -1.5, nome: "abaixo do segmento", multiplicador: 0.7 },
  { min: -1, nome: "normal", multiplicador: 1 },
  { min: 1, nome: "audiência engajada", multiplicador: 1.2 },
  { min: 1.5, nome: "muito engajada", multiplicador: 1.4 },
];

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

export const segmentoDe = (inscritos) => SEGMENTOS.find((s) => inscritos < s.ate) ?? SEGMENTOS.at(-1);

// canais: [{ id, inscritos, views }] — de preferência o lote inteiro, não só a shortlist
export function calcularGuardrail(canais) {
  const porSegmento = new Map();
  for (const c of canais) {
    if (!c.views || !c.inscritos) continue;
    const seg = segmentoDe(c.inscritos).nome;
    if (!porSegmento.has(seg)) porSegmento.set(seg, []);
    porSegmento.get(seg).push({ ...c, x: Math.log10(c.views / c.inscritos) });
  }
  const resultado = {};
  for (const [seg, lista] of porSegmento) {
    const m = median(lista.map((c) => c.x));
    const desvio = median(lista.map((c) => Math.abs(c.x - m))) * 1.4826; // MAD na escala de um desvio padrão
    for (const c of lista) {
      const z = (c.x - m) / desvio;
      // A primeira faixa com min <= z, varrendo do topo
      const faixa = [...FAIXAS].reverse().find((f) => z >= f.min);
      const preco = segmentoDe(c.inscritos).preco;
      const pelaFaixa = faixa.multiplicador ? Math.round(preco * faixa.multiplicador) : null;
      const teto = Math.max(PISO, Math.round((c.views * CPM_TETO) / 1000));
      resultado[c.id] = {
        segmento: seg,
        z: +z.toFixed(2),
        faixa: faixa.nome,
        preco_tabela: preco,
        preco_ajustado: pelaFaixa === null ? null : Math.min(pelaFaixa, teto),
        limitado_pelo_teto: pelaFaixa !== null && teto < pelaFaixa ? "sim" : "",
        mediana_segmento: +(10 ** m).toFixed(3),
      };
    }
  }
  return resultado;
}
