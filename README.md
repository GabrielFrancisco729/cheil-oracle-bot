# Oráculo de Dados — Cheil BI

## Atualização 1.2.1: moeda automática, relatório preenchido e consultas corrigidas

- **Slides / Relatórios:** escolha o modelo mensal (Agosto/2026) ou trimestral (Q2/2026) e baixe os PPTX originais. Os filtros não reescrevem o conteúdo desses arquivos.
- **Relatório:** assistente em formato de conversa para escolher dimensões de `dAllDimensions`, depois métricas e conferir uma tabela preenchida com dados explicitamente demonstrativos. As linhas são agrupadas pelas dimensões escolhidas, as taxas são recalculadas dos totais e o CSV inclui os mesmos valores da prévia. A leitura de schema é dinâmica; se falhar, a lista de dimensões é identificada como exemplo.
- **Best x Worst:** exemplos por OR, CTOR e CVR, filtro de volume mínimo, criativos em tamanho completo, insights e ações para testar. Todas as métricas, assuntos e posições são explicitamente simulados. Não há inferência de relação entre os JPG enviados e campanhas reais.
- **Métricas compartilhadas:** regras documentadas de Visits, Units, Revenue, OR, CTOR e CTR, incluindo os efeitos de `REMOVEFILTERS(dProducts)`. Orders, CVR e AOV reais estão pendentes de `tOrdersGA4` e do schema/relacionamentos de `auxOrderIDPerDate`; não são calculados por aproximação.
- **Moeda automática:** o recorte exclusivo SEDA usa `Revenue_SEDA` em reais em todas as parcelas da receita. As demais subsidiárias, LAO, SELA e recortes combinados usam `Revenue` em dólares. Não há seletor de moeda nem conversão de câmbio adicional. Esta regra foi confirmada pelo responsável do modelo e substitui a seleção parcial de moeda do DOCX.
- **Consulta de resumos/chat:** não exige mais campos de pedidos que não eram usados no resultado. Se `CHANNEL` existir na fato, usa esse campo; caso contrário, utiliza `dAllDimensions.CHANNEL`, como na consulta original do app. O schema da fato é verificado e armazenado em cache. A desduplicação da dimensão lê apenas TrackingCode, SUB, CHANNEL e CAMPAIGN, reduzindo a leitura desnecessária.
- **Diagnóstico de erros:** a interface diferencia falha no schema/acesso do BigQuery, autenticação/modelo/créditos Claude e limites de leitura. Cada falha tem uma referência para localizar o detalhe nos logs do Render; chaves conhecidas são removidas da mensagem registrada.

Leia `METRIC_CONTRACT.md` para as regras completas e as dependências que faltam. O DOCX original acompanha o projeto em `reference/`. Nenhuma variável nova obrigatória é necessária no Render; as novas abas usam os arquivos estáticos e o schema obtido com a mesma conexão BigQuery.



Aplicação Express + HTML/CSS/JavaScript com Claude e BigQuery. O acesso é direto, sem login. Chat e resumos usam exclusivamente a chave configurada no servidor.

## O que mudou

- Chat com histórico e consultas adicionais de dados via ferramentas Claude. Pode agregar por campanha, produto, canal, subsidiária ou dia, dentro do recorte selecionado.
- Resumos gerados pelo Claude: Executivo com foco no negócio; Gerencial com foco em canais, funil e ações operacionais.
- Os sete períodos filtram todas as consultas, incluindo rankings e ferramentas do chat.
- Comparação com período anterior. Períodos em andamento usam igual quantidade de dias, limitada ao fim do período anterior; períodos encerrados usam o anterior completo. O dia corrente pode estar incompleto.
- Semanas de segunda a domingo; calendário no fuso `America/Sao_Paulo`, configurável por `APP_TIMEZONE`.
- LAO = todas as subsidiárias. SELA = nomes com prefixo SELA, sem distinguir maiúsculas/minúsculas. Outras opções usam correspondência exata.
- Ditado em português preenche a pergunta; o usuário revisa antes de enviar.
- Cabeçalho Samsung preto / Cheil branco, abas retangulares com os textos originais e filtros no estilo da dashboard.
- Filtros sempre disponíveis. Alterá-los limpa a conversa e os resumos e cancela respostas obsoletas na interface.
- Os dois modelos PPTX estão disponíveis para download. Relatório e Best x Worst são protótipos com o escopo descrito acima.

## Atualizar o serviço existente no Render

Não é necessário criar outro serviço nem substituir as credenciais de BigQuery que já funcionam.

1. Extraia o ZIP e copie o conteúdo de `cheil-oracle-bot-main/` para a raiz do repositório conectado ao serviço. Inclua `lib/`, `public/`, `package.json`, `package-lock.json`, `server.js` e os demais arquivos do projeto. Faça commit/push na branch que o Render publica.
2. No Render, abra o **Web Service** atual. Em **Settings**, confirme:
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
   - **Root Directory:** a pasta que contém `package.json`, conforme a estrutura do seu repositório (deixe vazio se está na raiz).
3. Em **Environment → Add Environment Variable**, adicione:

| Variável | Valor |
| --- | --- |
| `ANTHROPIC_API_KEY` | Sua chave Claude, apenas no Render |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` (ou outro modelo habilitado na sua conta) |
| `NODE_VERSION` | `22.16.0` |
| `GCP_PROJECT_ID` | `cheil-bi` |
| `BQ_DATASET_MAIN` | `apollo_gold` |
| `BQ_LOCATION` | `US` (confirme a região real do dataset) |
| `APP_TIMEZONE` | `America/Sao_Paulo` |
| `GCP_SERVICE_ACCOUNT_JSON` | JSON completo da service account, caso essa seja a autenticação atual |

4. Se as variáveis Google já existem, preserve seus valores. Como alternativa a `GCP_SERVICE_ACCOUNT_JSON`, a autenticação padrão do SDK continua disponível, inclusive `GOOGLE_APPLICATION_CREDENTIALS` apontando para um Secret File do Render. Não coloque JSON de credenciais no repositório.
5. Clique em **Save, rebuild, and deploy** (ou salve e faça **Manual Deploy → Deploy latest commit**, conforme a interface disponível). O servidor respeita a variável `PORT` do Render.
6. Abra a URL do serviço. Não aparecerá tela de chave. Verifique se as subsidiárias carregam; escolha o período e envie uma pergunta. Depois abra cada resumo. Teste também uma subsidiária SELA e um período anterior, conferindo os números com a dashboard.

A service account precisa executar jobs no projeto e ler `fConsolidated`, `dAllDimensions` e `dProducts`. Usualmente isso corresponde a BigQuery Job User no projeto e BigQuery Data Viewer no dataset. Preserve o acesso já estabelecido.

`render.yaml` é uma opção para implantação via Blueprint. Adicionar esse arquivo a um serviço criado manualmente **não** configura automaticamente as variáveis desse serviço: use a página Environment acima.

## Chave e uso compartilhado

O navegador nunca recebe a chave. A antiga chave salva em `localStorage` é removida ao carregar a versão nova. Todos que acessam o app utilizam a chave do servidor e podem consultar o dataset configurado.

Há limites configuráveis, sem introduzir login:

| Variável | Padrão | Aplicação |
| --- | --- | --- |
| `AI_REQUESTS_PER_15_MIN` | `30` | Perguntas/resumos por IP a cada 15 minutos |
| `AI_REQUESTS_PER_DAY` | `300` | Total diário UTC por instância, incluindo tentativas |
| `AI_MAX_CONCURRENT` | `6` | Requisições de IA simultâneas por instância |
| `BQ_MAXIMUM_BYTES_BILLED` | `10000000000` | Até 10 GB faturáveis por consulta, não por conversa |
| `TRUST_PROXY_HOPS` | `1` no Render; `0` local | Quantidade de proxies confiáveis |

Limites e cache são em memória: reinícios zeram os contadores, e réplicas têm limites separados. Eles não são um teto financeiro mensal. Defina também limites/alertas de uso na conta Claude, se desejar controlar o gasto compartilhado. Uma pergunta pode gerar várias chamadas à IA e ao BigQuery. O cache de dados dura cinco minutos; os resumos ficam na sessão do navegador até mudar o filtro ou clicar em Atualizar.

## Escopo de dados e definições

- As ferramentas geram somente SQL parametrizado, a partir de agrupamentos e métricas permitidos. A IA não executa SQL livre, não altera dados e não muda o recorte dos filtros.
- O chat pode ordenar qualquer um dos indicadores por maior/menor valor. Cada consulta adicional retorna até 50 grupos e uma pergunta pode executar até seis consultas adicionais.
- A visão inicial contém totais, top 5 campanhas/produtos por receita, canais e totais do período anterior. Resultados sem linha não são apresentados como zero.
- As definições vigentes estão em `METRIC_CONTRACT.md`, traduzidas do documento DAX. Taxas não são médias de taxas de linha. As três medidas de pedidos pendentes não recebem valores aproximados.
- As dimensões são reduzidas a uma linha por TrackingCode/SKU antes do join para evitar multiplicar fatos. Valide as chaves e o desempate contra o modelo Power BI.

- O arquivo original já utilizava as tabelas principais. `CHANNEL / TRIGGER` e `Total_orders` deixaram de ser exigidos pelas consultas, pois as medidas reais de pedidos estão pendentes. O canal é obtido da fato quando disponível, ou da dimensão. Sem acesso à base real, a equivalência deste mapeamento com o Power BI precisa ser conciliada no ambiente.
- O resumo gerencial é uma proposta inicial de lógica: diagnóstico do funil, canais, destaques e ações priorizadas. Usa dados reais disponíveis. A nova aba Best x Worst é uma demonstração separada.

## Microfone

Implementado com `SpeechRecognition` / `webkitSpeechRecognition`, em `pt-BR`, com resultados parciais e finais. Clique no microfone para iniciar e novamente para concluir. O texto aparece no campo; somente Enviar inicia a análise.

A API de reconhecimento não está disponível em todos os navegadores. Use uma versão compatível de Chrome/Edge e permita o microfone, em HTTPS (ou localhost). O reconhecimento pode depender do serviço de fala do próprio navegador e enviar áudio a esse serviço. Claude não recebe áudio nesta implementação. Não é necessária outra chave de transcrição; quando o navegador não oferecer o recurso, a interface informa isso e permite digitar normalmente.

## Rodar e verificar localmente

Requer Node 22 ou 24.

```sh
npm ci
cp .env.example .env
# Preencha .env localmente sem versioná-lo.
npm start
```

Abra `http://localhost:10000` ou a porta configurada em `PORT`.

```sh
npm test
```

Os testes usam serviços simulados: validam datas (incluindo fuso, ano e fevereiro), filtros/SQL parametrizado, cache, histórico, ferramentas, diferenciação dos resumos, ausência de dados, erros, ausência de chave e limites de uso. Não consomem créditos reais.

Nesta entrega, a interface também foi verificada com respostas simuladas em desktop/celular. A prévia visual mostra o estado inicial sem dados fictícios de negócio. A validação de Claude, voz real e BigQuery com credenciais de produção deve ser feita após o deploy; não há credenciais no ZIP.

## Referências técnicas

- Claude Messages: https://platform.claude.com/docs/en/api/messages/create
- BigQuery parâmetros: https://docs.cloud.google.com/bigquery/docs/parameterized-queries
- Render variáveis: https://render.com/docs/configure-environment-variables
- Render Express: https://render.com/docs/deploy-node-express-app
- Web Speech: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
