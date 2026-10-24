// Rubrica do duplo vetting, compartilhada por Jev e Claude.
// Notas de 1 a 5: o nível 0 da rubrica vale nota 1, o nível 4 vale nota 5.
// Rubrica da Passionfroot (Etapa 2, 22/10/2026): mede se uma marca pagaria para falar com o público,
// em qualquer nicho que a Passionfroot vende. A rubrica de tech da Etapa 1 está em data/rubrica_tech/.

// Portões: precisam ser verdadeiros
export const GATES = {
  pt_br: "O conteúdo do canal é produzido em português do Brasil",
  e_creator:
    "O canal pertence a uma pessoa ou dupla que cria o próprio conteúdo, e não a uma empresa, escola, veículo de imprensa ou instituição",
};

// Red flags: uma pergunta por tema, como a documentação do Jev recomenda; qualquer uma reprova.
// Trading só pega especulação e promessa de ganho: educação financeira e investimento de longo prazo passam.
const TRADING =
  "promove especulação, como day trade, sinais de compra e venda, apostas em criptomoedas ou promessas de ganho com investimentos. Educação financeira, finanças pessoais e análise de investimentos de longo prazo não contam";
export const RED_FLAGS = {
  apostas: "O canal promove apostas, cassinos ou jogos de azar",
  dinheiro_facil: "O canal promete dinheiro fácil, renda rápida ou ganhos garantidos",
  trading: `O canal ${TRADING}`,
  politica: "O canal faz conteúdo de política partidária ou eleitoral com frequência",
};

// Fit com a Passionfroot: a mesma escala em todas as plataformas, só muda a pergunta.
// Alinhada à galeria de creators da Passionfroot (22/10): público profissional e founders; produtividade, estudos
// e carreira só para estudantes e início de carreira; saúde, fitness e dinheiro do consumidor ficam no nível 2.
const FIT_PASSIONFROOT_LEVELS = [
  "Entretenimento, fofoca, humor, games ou estilo de vida",
  "Consumidores em geral: saúde, fitness, beleza, receitas, compras, dicas de banco, renda extra ou autoajuda genérica, sem foco em trabalho ou estudo",
  "Estudantes e profissionais em início de carreira, com estudos, produtividade e carreira; ou investidores pessoa física com análise",
  "Profissionais de uma área, como marketing, produto, design, vendas, dados, programação, finanças, RH, saúde, direito ou engenharia, e founders",
  "Quem decide a compra de software e serviços em empresas, como gestores, líderes, donos de negócio e executivos",
];
const fitPassionfroot = (sujeito) => ({
  instructions: `Uma marca B2B (software, ferramentas de trabalho, fintech ou edtech) pagaria para falar com o público ${sujeito}? Para quem é o conteúdo`,
  levels: FIT_PASSIONFROOT_LEVELS,
});

// Publi: qualquer marca conta, não só as de tecnologia
const publiLevels = (conteudo, proprios) => [
  "Nenhum sinal de parceria com marcas nem de contato comercial",
  `Vende apenas ${proprios}`,
  "Tem contato comercial, mídia kit ou se apresenta como creator, mas sem publis visíveis",
  `${conteudo} recentes mencionam patrocínio, publi ou parceria com uma marca`,
  "Faz publis com frequência, com marcas de qualquer setor",
];

export const CRITERIA = {
  fit_passionfroot: { peso: 30, ...fitPassionfroot("deste canal") },
  // Qualidade mede especialidade, não formato: análise, método, entrevista e tutorial valem igual
  qualidade: {
    peso: 20,
    instructions: "Quanto os vídeos recentes mostram domínio de um tema. Análise, método, entrevista e tutorial valem igual",
    levels: [
      "Títulos sensacionalistas ou clickbait, sem um tema concreto",
      "Reações, notícias ou listas genéricas, sem contribuição própria",
      "Opiniões e dicas gerais sobre o tema, sem método nem profundidade",
      "Conteúdo de especialista: explica um método, analisa casos ou dados, entrevista quem entende do tema ou ensina passo a passo",
      "Referência no tema: análises aprofundadas, método próprio, entrevistas de peso ou tutoriais completos, com domínio evidente do assunto",
    ],
  },
  prontidao_publi: {
    peso: 10,
    instructions: "Que sinais o canal mostra de trabalhar com marcas",
    levels: publiLevels("Vídeos", "produtos próprios, como cursos, mentorias ou comunidades"),
  },
  fit_regional: {
    peso: 10,
    instructions: "Para qual mercado o conteúdo é feito",
    levels: [
      "Outro idioma ou outro país",
      "Português, mas voltado a Portugal ou a outro mercado",
      "Português do Brasil, com temas genéricos e sem referência ao Brasil",
      "Português do Brasil, com exemplos e situações do dia a dia brasileiro",
      "Voltado ao público brasileiro, com casos, empresas, profissões, produtos ou regras do Brasil, como Pix, INSS, impostos ou o mercado de trabalho local",
    ],
  },
};

// Categoria Passionfroot (pergunta choice do Jev): fica fora da nota, alimenta o mapa de gaps
export const CATEGORIAS = {
  "Marketing & Design": "Marketing, vendas, growth, branding, social media, criação de conteúdo, design e UX",
  "Produtividade & Desenvolvimento pessoal": "Produtividade, organização, estudos, hábitos, leitura e desenvolvimento pessoal",
  "Tech & Negócios": "Programação, software, dados, produto, empreendedorismo, gestão, liderança e negócios",
  "IA": "Inteligência artificial: ferramentas, agentes e automações com IA",
  "Finanças & Investimentos": "Finanças pessoais, investimentos, economia, contabilidade e finanças de empresas",
  "Saúde": "Saúde, medicina, nutrição, saúde mental e exercícios",
  "Carreira": "Carreira, emprego, entrevistas, LinkedIn, RH e mercado de trabalho",
  "Outro": "Nenhuma das anteriores, como entretenimento, games, estilo de vida ou consumo",
};
// Nomes em inglês para o que o recrutador vê (Attio, n8n, site); a rubrica e o Jev seguem em PT
export const CATEGORIAS_EN = {
  "Marketing & Design": "Marketing & Design",
  "Produtividade & Desenvolvimento pessoal": "Productivity & Personal Development",
  "Tech & Negócios": "Tech & Business",
  "IA": "AI",
  "Finanças & Investimentos": "Finance & Investing",
  "Saúde": "Health",
  "Carreira": "Career",
  "Outro": "Other",
};
export const CATEGORIA_QUESTION = {
  type: "choice",
  instructions: "Qual é o tema principal do conteúdo deste creator",
  criteria: CATEGORIAS,
};

// Fit com o brief da Frente A (ElevenAgents). Fica fora da nota de supply: só ordena a shortlist.
export const BRIEF = {
  fit_elevenagents: {
    instructions: "Quanto o conteúdo do canal ajuda alguém a montar agentes de atendimento ou de vendas para empresas",
    levels: [
      "Conteúdo sem relação com automação, atendimento ou vendas",
      "Fala de IA de forma geral, sem mostrar automação de atendimento ou vendas",
      "Mostra automações de trabalho com IA, mas não de conversas com clientes",
      "Ensina chatbots, agentes ou automações de atendimento e vendas por texto, como no WhatsApp",
      "Ensina a montar agentes de voz ou de atendimento por telefone e WhatsApp para empresas e clientes",
    ],
  },
};
// Flags do brief. Clone: qualquer avaliador tira da shortlist. Conflito: os dois precisam concordar;
// se só um marcar, vira pendência do Michel. Em todos os casos o canal continua no supply map.
export const BRIEF_FLAGS = {
  clone_elevenlabs: "O canal divulga clones gratuitos, cópias ou alternativas grátis à ElevenLabs",
  conflito:
    "O canal promove um software próprio (SaaS, plataforma ou ferramenta com marca própria) de chatbots, agentes ou atendimento, que concorre com ferramentas de terceiros. Vender serviço de implementação ou consultoria não conta",
};

// Triagem do LinkedIn só pelo perfil (headline, sobre, seguidores, cargos), antes de pagar a leitura
// dos posts. Decide quem tem os posts lidos; o vetting completo usa os posts.
export const LINKEDIN_TRIAGEM = {
  gates: {
    mercado_br: "A pessoa atua no mercado de trabalho brasileiro e fala com um público do Brasil",
    e_creator:
      "A pessoa publica conteúdo próprio com frequência, como creator, Top Voice, newsletter, podcast ou canal, e não é apenas um executivo ou recrutador com muitos seguidores",
  },
  red_flags: {
    dinheiro_facil: "O perfil promete dinheiro fácil, renda rápida ou ganhos garantidos",
    trading: `O perfil ${TRADING}`,
    politica: "O perfil faz conteúdo de política partidária ou eleitoral",
  },
  criteria: {
    fit_passionfroot: fitPassionfroot("desta pessoa"),
  },
};

// Vetting completo do LinkedIn (perfil + últimos posts). Mesmos pesos do YouTube; muda o texto
// dos critérios, porque post não é vídeo. Engajamento e consistência saem dos posts, pelo código.
export const LINKEDIN_CRITERIA = {
  fit_passionfroot: { peso: 30, ...LINKEDIN_TRIAGEM.criteria.fit_passionfroot },
  qualidade: {
    peso: 20,
    instructions: "Quanto os posts recentes mostram domínio de um tema. Análise, método, caso real e passo a passo valem igual",
    levels: [
      "Isca de engajamento, como emojis, memes ou frases soltas, ou só marca outras pessoas",
      "Frases motivacionais, vagas ou avisos, sem desenvolver um tema",
      "Reflexões e opiniões gerais sobre um tema",
      "Conteúdo de especialista: análises com dados, casos reais, um método explicado ou passo a passo",
      "Referência no tema: método próprio, análises aprofundadas e exemplos práticos com frequência",
    ],
  },
  prontidao_publi: {
    peso: 10,
    instructions: "Que sinais a pessoa mostra de trabalhar com marcas",
    levels: publiLevels("Posts", "serviços ou produtos próprios, como consultoria, cursos ou palestras"),
  },
  fit_regional: { peso: 10, ...CRITERIA.fit_regional },
};

// Vetting das newsletters (Substack): edição não é vídeo nem post, então muda o texto dos critérios
export const NEWSLETTER = {
  gates: {
    pt_br: "As edições são escritas em português do Brasil",
    e_creator:
      "A newsletter é escrita por uma pessoa ou dupla com voz própria, e não por uma empresa, escola, veículo de imprensa ou instituição",
  },
  red_flags: {
    apostas: "A newsletter promove apostas, cassinos ou jogos de azar",
    dinheiro_facil: "A newsletter promete dinheiro fácil, renda rápida ou ganhos garantidos",
    trading: `A newsletter ${TRADING}`,
    politica: "A newsletter faz conteúdo de política partidária ou eleitoral com frequência",
  },
  criteria: {
    fit_passionfroot: { peso: 30, ...fitPassionfroot("desta newsletter") },
    qualidade: {
      peso: 20,
      instructions: "Quanto as edições recentes mostram domínio de um tema. Análise, método, entrevista e passo a passo valem igual",
      levels: [
        "Diário pessoal, crônicas ou literatura, sem um tema de trabalho, dinheiro, saúde ou aprendizado",
        "Links ou notícias reunidos sem análise própria",
        "Reflexões e opiniões gerais sobre um tema",
        "Conteúdo de especialista: análises com dados, casos reais, entrevistas, um método explicado ou passo a passo",
        "Referência no tema: análises aprofundadas, método próprio ou entrevistas de peso, com domínio evidente do assunto",
      ],
    },
    prontidao_publi: {
      peso: 10,
      instructions: "Que sinais a newsletter mostra de trabalhar com marcas",
      levels: publiLevels("Edições", "assinatura paga ou produtos próprios, como cursos e mentorias"),
    },
    fit_regional: { peso: 10, ...CRITERIA.fit_regional },
  },
};

// Critérios pesados: diferença ≥ 2 entre Jev e Claude vira disputa
export const PESADOS = ["fit_passionfroot", "qualidade"];

// Fit mínimo como portão (decisão do Michel, 22/10): entretenimento e consumo reprovam mesmo com engajamento alto
export const FIT_MINIMO = 2.5;

// Desempate pela média (decisão do Michel, 22/10): disputa que é só diferença de nota, sem portão divergente,
// decide pela média de Jev e Claude, contra o corte e o fit mínimo
export const soDiferencaDeNota = (motivos) =>
  motivos.length > 0 && motivos.every((m) => m === "vereditos diferentes" || m.startsWith("confiança do Jev"));
export const aprovaPelaMedia = (jev, claude) =>
  (jev.nota + claude.nota) / 2 >= APROVACAO_MINIMA
  && (jev.notas.fit_passionfroot + claude.notas.fit_passionfroot) / 2 >= FIT_MINIMO;

// Perguntas do Jev a partir de portões, red flags e critérios, mais a categoria
export function perguntasJev(textos, criterios) {
  const q = {};
  for (const [id, text] of Object.entries(textos)) q[id] = { type: "noul", instructions: text };
  for (const [id, c] of Object.entries(criterios)) q[id] = { type: "score", instructions: c.instructions, criteria: c.levels };
  q.categoria = CATEGORIA_QUESTION;
  return q;
}

// Decisões do Michel valem enquanto algum avaliador da rubrica atual concordar com elas.
// Se a rubrica nova contradiz a decisão (consenso ou só Jev), ela volta para o Michel.
export function aplicarDecisao(decisao, votos) {
  if (!decisao) return null;
  const vereditos = votos.filter((v) => v !== undefined).map((v) => (v ? "Aprovado" : "Reprovado"));
  if (vereditos.includes(decisao)) return { veredito: decisao, motivo: "" };
  return { veredito: "Disputa: Michel decide", motivo: `Michel decidiu ${decisao} na rubrica de tech; a nova rubrica diz ${vereditos[0]}` };
}

// Reações médias por edição, por mil assinantes
export function notaEngajamentoNewsletter(reacoesPorMil) {
  const v = Number(reacoesPorMil);
  if (v >= 10) return 5;
  if (v >= 5) return 4;
  if (v >= 2) return 3;
  if (v >= 0.5) return 2;
  return 1;
}

export function notaEngajamentoLinkedin(reacoesPorMilSeguidores) {
  const v = Number(reacoesPorMilSeguidores);
  if (v >= 3) return 5;
  if (v >= 1) return 4;
  if (v >= 0.5) return 3;
  if (v >= 0.1) return 2;
  return 1;
}

// Com 3 posts lidos por perfil, a consistência mede em quantos dias saíram os 3 últimos
export function notaConsistenciaLinkedin(postsUltimos30d, diasDosUltimos3) {
  if (postsUltimos30d >= 3) return diasDosUltimos3 <= 7 ? 5 : 4;
  if (postsUltimos30d === 2) return 3;
  if (postsUltimos30d === 1) return 2;
  return 1;
}

// Critérios objetivos, calculados pelo código e iguais para os dois avaliadores
export const OBJECTIVE = {
  engajamento: { peso: 15 }, // views médias dos últimos 10 vídeos por inscrito
  consistencia: { peso: 15 }, // vídeos nos últimos 30 dias
};

export function notaEngajamento(viewsPorInscrito) {
  const v = Number(viewsPorInscrito);
  if (v >= 0.15) return 5;
  if (v >= 0.07) return 4;
  if (v >= 0.03) return 3;
  if (v >= 0.01) return 2;
  return 1;
}

export function notaConsistencia(videos30d) {
  const n = Number(videos30d);
  if (n >= 8) return 5;
  if (n >= 4) return 4;
  if (n >= 2) return 3;
  if (n >= 1) return 2;
  return 1;
}

export const APROVACAO_MINIMA = 60; // nota final de 0 a 100
