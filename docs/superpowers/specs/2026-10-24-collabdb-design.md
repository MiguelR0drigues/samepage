# SamePage — Memória partilhada da equipa para agentes de IA

Documento de desenho · 2026-10-24 · Autor: Miguel Rodrigues (com Claude)

## 1. Intenção e porquê

Os co-founders tomam decisões em muitos sítios: Google Meet, WhatsApp, conversas presenciais e conversas com os próprios agentes de IA. Depois, cada um tem de repetir esse contexto ao seu agente (Claude Code, Codex, ChatGPT, Claude, Gemini, Hermes...). As pessoas acabam por ser o mecanismo de sincronização. Isso dá trabalho repetido e, com o tempo, os contextos de cada agente afastam-se uns dos outros.

O SamePage é uma **fonte única de verdade** sobre decisões, visão e contexto da empresa. Os agentes de toda a equipa leem dela e alimentam-na. A partilha deve acontecer **por baixo, sem esforço**: ninguém deve ter de "ensinar" a mesma decisão várias vezes.

Serve a empresa toda, não só engenharia: produto, roadmap, marketing, posicionamento e tom de voz.

O que o distingue das ferramentas existentes (Supermemory, Decision Log, AQ, mem0, Graphiti; ver secção 11):

- **guarda o debate, não só o resultado**: quem defendia o quê, com que argumentos, e o grau de consenso;
- funciona para **uma equipa com autoria**, não para um utilizador;
- **custa zero**: usa as subscrições que a equipa já paga.

Para já, o objetivo é resolver o problema desta equipa. Open source ou produto ficam para mais tarde, se fizer sentido.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Os agentes de cada pessoa sabem o que foi decidido, por quem, porquê e com que convicção, sem ninguém o repetir.
- A captura é automática por defeito. Só há perguntas ao humano em caso de dúvida real.
- Quando um agente vai sugerir algo que contradiz uma decisão registada, avisa, apresenta os factos e pergunta o que fazer.
- A visão pessoal de cada pessoa fica visível para os agentes dos outros, com o nome do dono.

**Não-objetivos (v1)**
- Cobrir todas as ferramentas. A v1 cobre **Claude Code + Google Meet**. Codex, Hermes, as apps de chat e o Gemini ficam para fases seguintes.
- Interface web rica. A interação na v1 é feita através dos agentes.
- Multi-equipa, multi-empresa ou produto.
- Suportar várias bases de dados em simultâneo ou sincronizá-las.

**Anti-objetivos (falha mesmo que "funcione")**
- Pedir confirmação a cada gravação. Isso mata a praticidade.
- Assuntos pessoais (vida pessoal, projetos pessoais, ideias soltas não relacionadas com a empresa) a chegarem à memória partilhada.
- Consumir uma fatia relevante das subscrições de Claude da equipa, que são precisas para o trabalho do dia a dia.
- Encher a memória de ruído, com trivialidades registadas como "decisões".
- Uma pessoa anular em silêncio uma decisão da equipa.

## 3. Restrições

- **Custo monetário zero.** Nada de serviços pagos. Os tokens de IA vêm das subscrições existentes de Claude (Claude Code e rotinas). Se a API da Anthropic chegar a ser usada, deve ser uma exceção residual (o Haiku 5.5 custa ~0,003 $ por reunião de uma hora).
- **Poupança de tokens das subscrições.** Ver secção 6.4.
- **Privacidade.** As conversas com agentes não saem da máquina de cada pessoa. Ao servidor chegam apenas as entradas extraídas.
- **Base de dados fácil de trocar e migrar.** Ver secção 6.2.
- **Utilizadores:** uma equipa pequena de co-founders. Contas e tokens emitidos à mão chegam.

## 4. Fontes de informação (v1)

| Fonte | Captura | Confiança |
|---|---|---|
| **Google Meet** (notas/transcrições do Gemini) | Automática, através de uma rotina do Claude Code | **Fonte de verdade**: entra direto, sem perguntas (exceto filtragem de conversa pessoal ou de circunstância) |
| **Sessões do Claude Code** em repositórios da empresa | Automática, por hooks e um extrator local | Automática quando a certeza é alta; pergunta quando há dúvida |
| **Registo explícito** ("regista isto: decidimos X com o Y") em qualquer sessão do Claude Code com o MCP ligado | O agente chama a ferramenta MCP diretamente | Entra direto |

Decisões tomadas por WhatsApp ou presencialmente entram pelo registo explícito.

**Nota:** muitas decisões não passam pelo Meet. Na prática, o Claude Code é a fonte principal.

## 5. Modelo de dados (conceptual)

### 5.1 Tipos de entrada
- **Decisão de equipa**: ver 5.2.
- **Visão ou opinião pessoal**: "o Miguel acha que devíamos posicionar-nos como X". Tem dono e não é uma decisão. Pode mais tarde dar origem a uma decisão.
- **Princípio**: visão do produto, tom de voz, posicionamento. É estável e entra sempre no contexto dos agentes.
- **Exploração**: ideia ou hipótese discutida, sem conclusão. Serve para não confundir brainstorming com decisões.
- **Proposta de revisão**: alguém quer contrariar ou alterar uma decisão existente. Fica visível para a equipa até ser fechada. Não substitui nada sozinha.

### 5.2 Decisão de equipa: campos
- **Questão**: o problema em cima da mesa.
- **Posições** (opcional): o que cada pessoa defendia e os seus argumentos, atribuídos pelo nome.
- **Veredicto**: o caminho escolhido.
- **Consenso** (opcional): unânime e convicto, maioria, ou "avançámos sem consenso total". Inclui o **porquê** de avançar assim.
- **Área**: engenharia, produto, marketing, posicionamento, negócio...
- **Origem**: Meet (com a referência da reunião), sessão de Claude Code de X, ou registo explícito.
- **Autor(es)**, **data** e **estado**: ativa, substituída ou em revisão.
- **Substitui / substituída por**: as decisões nunca se apagam por evolução. A decisão antiga fica no histórico, ligada à nova.

**A riqueza do registo depende da fonte.** Um Meet com transcrição permite preencher posições, argumentos e consenso. As outras fontes entram tipicamente resumidas: questão, veredicto, quem e porquê. Por isso os campos de debate são opcionais.

### 5.3 Entidades de apoio
- **Pessoas**: membros da equipa, cada um com o seu token.
- **Pendentes**: dúvidas do extrator à espera de resposta do autor.
- **Correções**: respostas do tipo "sim, isto era da empresa" ou "não, isto era pessoal". Ficam guardadas como exemplos para o extrator errar menos.

## 6. Arquitetura

### 6.1 Servidor MCP remoto
- Escrito em TypeScript com o SDK oficial de MCP, transporte HTTP.
- **Um token por pessoa.** O token define quem escreveu cada entrada, por isso a autoria é automática. A rotina do Meet usa um **token de sistema próprio** ("Meet"), e não o de uma pessoa.
- **Autoria:** uma entrada pode ter vários autores. Por exemplo, os participantes de uma decisão, ou os oradores de um Meet, mapeados para a equipa. Quem a gravou fica registado à parte, como "gravado por".
- **Controlo de acessos na interface de armazenamento**, não com row-level security do Postgres. Todas as regras de permissão vivem num só sítio, que é a camada que as ferramentas MCP chamam, e assim a base de dados continua fácil de trocar. A troca é uma segurança "abaixo do MCP" sem ficar presa ao Postgres.
- **Editar e apagar:** qualquer autor listado pode apagar uma entrada sua, incluindo decisões de equipa onde figura como autor. A remoção aparece nas novidades dos outros, por transparência. O veredicto de uma decisão **não se edita**: muda-se com substituição ou proposta de revisão, para preservar o histórico. Correções de texto, como gralhas ou clarificações, são permitidas ao autor.
- **Ferramentas** (nomes indicativos; **todo o produto é em inglês**: código, ferramentas, mensagens e texto visto pelos agentes):
  - `search_context(query, area?)`: devolve entradas relevantes, **curtas** (para poupar o contexto do agente).
  - `list_decisions(area?, status?)`
  - `record(type, content...)`: usada no registo explícito e pelo extrator.
  - `supersede_decision(old_id, ...)` e `propose_revision(decision_id, suggestion, justification)`
  - `delete_entry(id)`: **só o autor** pode apagar. Editar segue a mesma regra.
  - `pending()` e `answer_pending(id, answer)`
- As **instruções do servidor MCP** e as descrições das ferramentas ensinam o comportamento de leitura (6.6).
- O servidor de MCP **não chama modelos de IA**: só lê e escreve dados.

### 6.2 Armazenamento
- **Base de dados inicial: Postgres no Neon** (nível gratuito). A escolha é do Claude; o Miguel prefere evitar o Supabase.
- **Interface de armazenamento própria.** O servidor fala com uma interface pequena (guardar, procurar, substituir, listar...), nunca diretamente com a base de dados. Há **um só adaptador** na v1 (Postgres). Usar um ORM com vários dialetos SQL (por exemplo Drizzle) torna barata a troca para SQLite/Turso ou MySQL.
- **Exportar e importar em JSON** neutro, por entidade. Serve para migrar entre quaisquer bases de dados e para backup.
- **Pesquisa:** começa com a pesquisa de texto do Postgres. Pesquisa semântica (embeddings) só se fizer falta. Nesse caso, os embeddings são **dados derivados**: regeneram-se a partir do texto ao migrar ou ao trocar de modelo.

### 6.3 Integração com o Claude Code
- **MCP ligado por projeto**: só nos repositórios da empresa. Em projetos pessoais, o agente nem sabe que a memória existe.
- **Hook de início de sessão:** injeta um resumo de até ~500 tokens com os princípios, as decisões recentes ou relevantes, as **novidades desde a última sessão da pessoa** e os **pendentes** dessa pessoa.
- **Hook de fim de sessão:** corre o extrator local (6.4) sobre a sessão.
- **Passagem a meio só em sessões longas** (por exemplo, a cada ~40 mensagens). É o único momento em que o agente pode fazer uma pergunta de dúvida na própria conversa, através de contexto injetado por um hook.
- **Controlos determinísticos de privacidade**, verificados pelo hook **antes** de qualquer processamento:
  - `/privado` (ou equivalente): nada desta conversa é processado;
  - "isto não": exclui a última parte da conversa.

  Não dependem de um modelo perceber a intenção.

### 6.4 Extrator (local, com a subscrição de cada pessoa)
1. O hook junta as **mensagens novas** desde a última passagem. Só o texto do utilizador e do agente, sem resultados de ferramentas nem código, e com um teto máximo de tamanho.
2. Se o excerto for abaixo de um tamanho mínimo, ou trivial, **não corre**.
3. Vai buscar à memória (via MCP) as entradas relacionadas com o excerto.
4. Chama o Claude Code em modo não interativo (`claude -p`) com o **Haiku**. Passa-lhe o excerto, as entradas relacionadas, a regra do que guardar e as correções anteriores como exemplos.
5. Recebe uma lista estruturada. Para cada item: tipo, conteúdo, autor, área, relação com o que existe (novo, atualização, substitui, duplicado) e **grau de certeza de que é sobre a empresa**.
6. Decide pelo grau de certeza:
   - alta → grava;
   - baixa → ignora;
   - intermédia → cria um **pendente** (perguntado na conversa se for uma passagem a meio; caso contrário, aparece no início da sessão seguinte).
7. Ao servidor só chegam as entradas extraídas. **A conversa nunca sai da máquina.**

**Fasquia alta:** o extrator deve preferir guardar de menos a guardar de mais. Deve juntar o que é novo a entradas existentes e marcar ideias soltas como "exploração". As perguntas de dúvida devem ser **raras**: se forem frequentes, voltamos à fricção que se quer evitar.

**Poupança de tokens:**
- Haiku sempre;
- corre só no fim da sessão (mais a passagem a meio em sessões longas);
- ignora sessões curtas;
- só texto, com teto;
- resumo inicial pequeno;
- **limite diário configurável** por pessoa. Ao atingi-lo, o extrator para até ao dia seguinte e o trabalho normal não é afetado.

### 6.5 Google Meet
- As notas e transcrições do Gemini caem no Drive de quem organiza a reunião. Combina-se uma **pasta partilhada** para as notas das reuniões da equipa. Só as reuniões nessa pasta (ou com dois ou mais membros da equipa) são processadas.
- **Base:** uma **rotina agendada do Claude Code** (na cloud, com a subscrição; intervalo mínimo de 1 hora) procura notas novas na pasta, extrai as entradas e grava-as através do MCP.
- **Melhoria opcional:** um Google Apps Script (gratuito no Workspace) vigia a pasta a cada poucos minutos e dispara a rotina pelo seu endpoint HTTP quando aparece uma nota nova. O Google não tem um evento nativo de "notas prontas".
- Se houver transcrição completa, preenchem-se as posições, os argumentos e o consenso. Os oradores são mapeados para as pessoas da equipa.
- O Meet é **fonte de verdade**: entra sem pendentes, mas ignora conversa de circunstância e assuntos pessoais.

### 6.6 Comportamento de leitura dos agentes
- O agente consulta a memória antes de trabalho relevante (decisões de arquitetura, produto, marketing, posicionamento). Também tem os princípios sempre presentes, através do resumo inicial.
- **Contradição com uma decisão registada:** o agente **dá a sugestão na mesma**, mas avisa e apresenta os factos:
  - a sugestão e a sua justificação;
  - a decisão registada que ela contradiz;
  - o contexto dessa decisão: quando, quem, posições, argumentos e grau de consenso.

  Depois **pergunta sempre o que fazer**.
- Se a pessoa escolher avançar contra a decisão, cria-se uma **proposta de revisão** visível para a equipa.

### 6.7 Regra de substituição de decisões
- **Substitui diretamente** quando a nova decisão também é de equipa: vem de um Meet, ou de um registo explícito com outros participantes ("decidimos X com o Y"). Isto aplica-se também quando o extrator identifica uma decisão de equipa que substitui outra.
- **Vira proposta de revisão** quando é uma só pessoa a contrariar uma decisão de equipa. Por exemplo: o agente avisou da contradição e a pessoa escolheu avançar, ou alguém chama `supersede_decision` sozinho sobre uma decisão em que outros participaram.
- **Fechar uma proposta:**
  - ela é **aceite** quando **outra pessoa da equipa** (não o proponente) a aceita, de preferência alguém que participou na decisão original. Nesse momento, a proposta passa a decisão e substitui a original;
  - ela é **rejeitada** da mesma forma, e a decisão original mantém-se.
- Ferramentas necessárias: `accept_proposal(id)` e `reject_proposal(id, reason?)`. As propostas abertas aparecem nas novidades e nos pendentes dos outros membros.

## 7. Privacidade: resumo das camadas
1. **Onde está ligado:** só em repositórios ou projetos da empresa.
2. **Controlos determinísticos:** `/privado` e "isto não", aplicados antes de qualquer processamento.
3. **Processamento local:** a conversa não sai da máquina; só as entradas extraídas são enviadas.
4. **Filtro do extrator:** ignora assuntos pessoais e pergunta em caso de dúvida.
5. **Autor apaga ou edita** qualquer entrada sua.
6. **Transparência:** cada pessoa vê as novidades no início da sessão, por isso algo pessoal que escape é detetado depressa.

## 8. Fases sugeridas
1. **Núcleo:** base de dados, interface de armazenamento, servidor MCP com tokens, registo explícito, consulta, resumo de início de sessão, exportar e importar.
2. **Captura automática no Claude Code:** hooks, extrator local, controlos de privacidade, pendentes e correções.
3. **Google Meet:** pasta partilhada e rotina agendada; Apps Script opcional.
4. **Mais tarde (fora da v1):**
   - Codex e Hermes, que guardam sessões em disco e podem usar o mesmo extrator local;
   - apps de chat (Claude, ChatGPT) via conector MCP, com captura de melhor esforço;
   - Gemini, via um Google Doc vivo exportado para o Drive;
   - interface web;
   - pesquisa semântica;
   - rascunhos privados ("só meu" até ser promovido).

## 9. O que foi decidido e por quem

**Decidido pelo Miguel**
- Resolver primeiro o problema da equipa; produto ou open source talvez depois.
- Para a empresa toda, não só engenharia.
- Registo de decisões com posições, argumentos, veredicto e grau de consenso, com riqueza dependente da fonte.
- Google Meet como fonte de verdade.
- Custo monetário zero, usando as subscrições, mas com poucos tokens.
- Base de dados fácil de trocar e migrar. Evitar o Supabase se houver melhor.
- Captura automática sem confirmações. Pergunta só em caso de dúvida, com opção de "não gravar isto" ou "não gravar esta conversa" e de corrigir ("é da empresa, percebeste mal").
- O autor pode apagar o que é seu.
- v1 = Meet + Claude Code.
- Contradições: avisar, justificar, apresentar os factos e perguntar sempre o que fazer.
- Regra de substituição (6.7). Decisões de equipa substituem diretamente. Uma pessoa sozinha cria uma proposta de revisão. Outra pessoa da equipa aceita ou rejeita a proposta.

**Escolhas do Claude (podem ser revistas)**
- Servidor MCP próprio em TypeScript, em vez de Notion ou repositório Git.
- Neon (Postgres) e Drizzle, com interface de armazenamento e exportação em JSON.
- Os cinco tipos de entrada da secção 5.1, incluindo "exploração" e "proposta de revisão".
- Extrator local com `claude -p` e Haiku. A conversa nunca sai da máquina.
- Passagem a meio só em sessões longas. Pendentes mostrados no início da sessão seguinte.
- Resumo inicial de até ~500 tokens. Limite diário de extração.
- MCP e hooks configurados por projeto, nos repositórios da empresa.
- Rotina agendada para o Meet como base, com Apps Script opcional.
- "Novidades desde a última sessão" no resumo inicial como mecanismo de transparência, em vez de um resumo diário por email.
- Controlo de acessos na interface de armazenamento (sem row-level security), para manter a base de dados fácil de trocar.
- Token de sistema para a rotina do Meet. Vários autores por entrada, com "gravado por" à parte.
- Qualquer autor listado pode apagar, e a remoção aparece nas novidades. O veredicto não se edita: muda por substituição ou proposta de revisão.

## 10. Deixado ao construtor
- Alojamento gratuito do servidor MCP (por exemplo Cloudflare Workers ou Render). **Evitar o plano Hobby da Vercel**, cujos termos excluem uso comercial.
- Esquema concreto das tabelas, nomes exatos das ferramentas e formato do JSON de exportação.
- Texto da regra de extração e calibração dos limiares de certeza.
- Valores concretos dos tetos (tamanho mínimo e máximo do excerto, frequência da passagem a meio, limite diário).
- Sintaxe exata dos controlos de privacidade.
- Como os hooks guardam o estado da "última passagem".

## 11. A verificar antes ou durante o plano
- Limites atuais do nível gratuito do Neon, na página oficial.
- Se uma rotina do Claude Code na cloud tem acesso ao conector do Google Drive. Limites diários de execução das rotinas (ainda em pré-visualização).
- Uso de `claude -p` dentro de hooks com a subscrição: comportamento, limites, e garantir que o próprio processo não dispara os hooks recursivamente.
- Localização real das notas do Meet no vosso Workspace, e se o vosso plano inclui transcrições.

**Pesquisa de mercado (outubro de 2026):** nenhuma ferramenta cobre o conjunto.
- A [Supermemory](https://supermemory.ai/docs/supermemory-mcp) tem memória de equipa via MCP, mas genérica e paga.
- O [Decision Log](https://mcpservers.org/servers/www-decisionlog-ai) tem decisões com substituição e proveniência, mas não guarda posições por pessoa nem consenso, e não ingere o Meet.
- O [AQ](https://aq.dev/guides/team-memory-for-coding-agents/) é só para código, por repositório, e pago.
- O mem0/OpenMemory e o Graphiti estão orientados para um único utilizador.
