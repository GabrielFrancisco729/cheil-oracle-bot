/**
 * BACKEND SIMPLIFICADO: Oráculo de Dados Cheil BI
 * 
 * Versão 2: Usuário fornece sua própria API Key do Claude/OpenAI
 * 
 * Funcionalidades:
 * - Sem OAuth (mais simples)
 * - Usuário coloca sua API Key
 * - Backend valida e processa
 * - Integração BigQuery
 * - Integração Claude API (com key do usuário)
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { BigQuery } = require('@google-cloud/bigquery');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();

const app = express();

// CORS habilitado
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

app.use(express.json());

// ============================================================================
// CONFIGURAÇÕES GLOBAIS
// ============================================================================

const BQ_CONFIG = {
  projectId: process.env.GCP_PROJECT_ID || 'cheil-bi',
  dataset: process.env.BQ_DATASET_MAIN || 'apollo_gold',
  tables: {
    main: 'fConsolidated',
    dimensions: 'dAllDimensions',
  }
};

// BigQuery (usa credenciais do servidor)
let bigqueryConfig = {
  projectId: process.env.GCP_PROJECT_ID,
};

// Se GCP_SERVICE_ACCOUNT_JSON for uma string JSON, parsear
if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    bigqueryConfig.credentials = serviceAccount;
  } catch (error) {
    console.error('Erro ao parsear GCP_SERVICE_ACCOUNT_JSON:', error.message);
    // Tenta usar como caminho de arquivo
    bigqueryConfig.keyFilename = process.env.GCP_SERVICE_ACCOUNT_JSON;
  }
}

const bigquery = new BigQuery(bigqueryConfig);

// ============================================================================
// FUNÇÃO: Validar API Key
// ============================================================================

function validateApiKey(apiKey) {
  // Validação simples - apenas checar se tem o formato correto
  if (!apiKey || apiKey.trim().length === 0) {
    return { valid: false, error: 'API Key vazia' };
  }

  // Deve começar com sk-ant- (Claude/Anthropic)
  if (!apiKey.startsWith('sk-ant-')) {
    return { valid: false, error: 'API Key deve começar com sk-ant- (Claude/Anthropic)' };
  }

  // Se passou nessas verificações, a key é válida
  // O teste real será quando o usuário fizer a primeira pergunta
  return { valid: true };
}

// ============================================================================
// FUNÇÃO: Gerar SQL com Claude usando key do usuário
// ============================================================================

async function generateSQL(question, userApiKey, history = []) {
  const client = new Anthropic({
    apiKey: userApiKey,
  });

  const systemPrompt = `Você é um expert em SQL BigQuery. RESPONDA APENAS COM SQL, SEM EXPLICAÇÕES.

SCHEMA - CORRESPONDE AO POWER BI DASHBOARD CHEIL BI:
Projeto: ${BQ_CONFIG.projectId} | Dataset: ${BQ_CONFIG.dataset}

1. \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.main}\` (fConsolidated - MÉTRICAS)
   COLUNAS PRINCIPAIS:
   - Date: data
   - DELIVERED: entregas, OPENS: aberturas, CLICKS: cliques
   - Total_visits: visitas, Total_orders: pedidos, Revenue: receita
   - Revenue_SEDA: receita em BRL, Total_units: unidades
   - Product: SKU, Tracking_code: código de rastreamento
   - Source: origem (ANALYTICS, VTEX, GA4, IOS, ANDROID, APP, WHATSAPP)
   - CHANNEL: EMAIL, WHATSAPP, APP PUSH, WEB PUSH, PUSH
   - DATA_SOURCE: AFFILIATE, VTEX_CARTAPP, etc
   - COUNTRY_NAME, CAMPAIGN_SEDA, TRIGGER_SEDA
   
2. \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.dProducts\` (PRODUTOS)
   JOIN: fConsolidated.Product = dProducts.SKU
   - SKU, PRODUCT, BU, SUB BU, subCATEGORY, FAMILY
   
3. \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.dimensions}\` (dAllDimensions)
   JOIN: fConsolidated.Tracking_code = dAllDimensions.TrackingCode
   - SUB: SUBSIDIÁRIA (SEDA, MX, CE, DA, HA, WM, VD, AC) ← USE PARA FILTRAR!
   - CAMPAIGN, CHANNEL, SEGMENT GROUP, AUDIENCE, BU CAMPAIGN, TRIGGER
   
MÉTRICAS DO DASHBOARD (REVENUE - CRÍTICO):
- Revenue_SEDA = Receita em BRL (Real) - USE SEMPRE para SEDA
- Revenue = Receita em moeda original (USD) - USE para outras subsidiárias ou sem especificação
- Entregas (DELIVERED), Aberturas (OPENS), Cliques (CLICKS)
- Visitas (Total_visits), Pedidos (Total_orders), Unidades (Total_units)
- Taxas: OR% = OPENS/DELIVERED, CTOR% = CLICKS/OPENS, CTR% = CLICKS/DELIVERED
- CVR% = Total_orders/Total_visits, AOV = Revenue/Total_orders

REGRA REVENUE (CRÍTICO):
- Pergunta menciona SEDA? → USE Revenue_SEDA (em BRL)
- Pergunta NÃO menciona SEDA? → USE Revenue (normal)
- NUNCA use ambos na mesma query

COMPARAÇÕES (QUANDO APLICÁVEL):
- Se pergunta é aberta, adicione GROUP BY para dar contexto
- Podem ser: GROUP BY mês, produto, canal, ou subsidiary
- Use UNION para comparar períodos se necessário
- Sempre ORDER BY resultado DESC para TOP itens
- Limite a 100 registros (LIMIT 100)

FILTROS COMUNS:
- MÊS ATUAL: WHERE DATE_TRUNC(fConsolidated.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)
- MÊS ANTERIOR: WHERE DATE_TRUNC(fConsolidated.Date, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)
- SUBSIDIÁRIA SEDA: JOIN dAllDimensions WHERE dAllDimensions.SUB = 'SEDA'
- CANAL EMAIL: WHERE fConsolidated.CHANNEL = 'EMAIL'
- FONTE ANALYTICS: WHERE fConsolidated.Source = 'ANALYTICS'
- PRODUTO: WHERE dProducts.PRODUCT LIKE '%nome%'

PADRÃO DE QUERY SIMPLES - EXEMPLO:
SELECT SUM(Revenue_SEDA) as revenue
FROM cheil-bi.apollo_gold.fConsolidated fc
JOIN cheil-bi.apollo_gold.dAllDimensions d ON fc.Tracking_code = d.TrackingCode
WHERE d.SUB = 'SEDA' 
  AND DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)

REGRA: SEMPRE use backticks para table names: `cheil-bi.apollo_gold.fConsolidated`

CONTEXTO CONVERSACIONAL: Se mencionou SEDA antes, continua usando SEDA na query
SE NÃO CONSEGUIR GERAR SQL VÁLIDO: Responda apenas: ERROR

IMPORTANTE: Gere APENAS SQL. Nada mais. Sem explicações.`;

  try {
    // Preparar mensagens com histórico
    const messages = [];
    
    // Adicionar histórico anterior (se tiver)
    if (history && history.length > 0) {
      history.forEach(msg => {
        if (msg.role && msg.content) {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content.substring(0, 500) // Limitar tamanho
          });
        }
      });
    }
    
    // Adicionar pergunta atual
    messages.push({
      role: 'user',
      content: `Pergunta: "${question}"\n\nGere a query SQL:`
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages
    });

    // Extrair texto da resposta de forma segura
    if (response && response.content && Array.isArray(response.content) && response.content.length > 0) {
      // Procura pelo primeiro bloco do tipo "text" (pode haver blocos de "thinking" primeiro)
      let textBlock = null;
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          textBlock = block;
          break;
        }
      }
      
      if (!textBlock || !textBlock.text) {
        console.error('[SQL Error] Nenhum bloco de texto encontrado');
        throw new Error('Resposta do Claude não contém bloco de texto');
      }
      
      let text = textBlock.text;
      
      // Remove markdown se tiver
      if (text.includes('```sql')) {
        text = text.replace(/```sql\n?/g, '').replace(/```\n?/g, '');
      }
      if (text.includes('```')) {
        text = text.replace(/```\n?/g, '');
      }
      
      text = text.trim();
      
      if (!text || text.length === 0) {
        throw new Error('Claude gerou resposta vazia');
      }
      
      console.log(`[SQL Generated] ${text.substring(0, 100)}...`);
      return text;
    } else {
      console.error('[SQL Error] Resposta vazia do Claude');
      throw new Error('Resposta vazia do Claude');
    }
  } catch (error) {
    console.error('[SQL Error]', error.message);
    throw error;
  }
}

// ============================================================================
// FUNÇÃO: Executar Query no BigQuery
// ============================================================================

async function executeQuery(sql) {
  try {
    const options = {
      query: sql,
      location: 'US', // Dataset location is US
    };

    const [rows] = await bigquery.query(options);
    return rows;
  } catch (error) {
    throw new Error(`BigQuery Error: ${error.message}`);
  }
}

// ============================================================================
// FUNÇÃO: Processar resposta com Claude
// ============================================================================

async function formatAnswer(question, sqlResults, userApiKey) {
  const client = new Anthropic({
    apiKey: userApiKey,
  });

  const resultsJson = JSON.stringify(sqlResults, null, 2);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: `Pergunta: "${question}"

Resultado dos dados (JSON):
${resultsJson}

INSTRUÇÕES PARA FORMATAÇÃO:
- Resuma os dados de forma clara em português
- Se há múltiplas linhas: liste cada uma com valor principal
- Se há apenas 1 valor: explique o contexto (período, categoria, etc)
- Formato claro sem markdown (sem **, ##, etc)
- Números em formato brasileiro (R$ 1.000,00)
- Se há 2+ períodos: mostre a diferença em porcentagem
- Destaque TOP 3 itens se há muitos registros
- Máximo 500 caracteres de resposta`
        }
      ]
    });

    // Extrair texto da resposta de forma segura
    if (response && response.content && Array.isArray(response.content) && response.content.length > 0) {
      // Procura pelo primeiro bloco do tipo "text"
      let textBlock = null;
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          textBlock = block;
          break;
        }
      }
      
      if (!textBlock || !textBlock.text) {
        console.error('[Format Answer Error] Nenhum bloco de texto encontrado');
        throw new Error('Resposta do Claude não contém bloco de texto');
      }
      
      let text = textBlock.text.trim();
      
      // Remove markdown formatting para exibição no frontend
      text = text.replace(/\*\*/g, '');  // Remove **bold**
      text = text.replace(/\*(?!\w)/g, ''); // Remove *asteriscos*
      text = text.replace(/#{1,6}\s/g, ''); // Remove headers (#, ##, etc)
      text = text.replace(/`/g, '');        // Remove codeblocks
      
      return text;
    } else {
      console.error('[Format Answer Error] Resposta vazia do Claude');
      throw new Error('Resposta vazia do Claude ao formatar resposta');
    }
  } catch (error) {
    console.error('[Format Answer Error]', error.message);
    throw error;
  }
}

// ============================================================================
// ROTA: Validar API Key
// ============================================================================

app.post('/api/validate-key', (req, res) => {
  try {
    const { apiKey } = req.body;

    const validation = validateApiKey(apiKey);

    if (validation.valid) {
      res.json({
        success: true,
        message: 'API Key válida! Você pode começar a fazer perguntas.'
      });
    } else {
      res.status(400).json({
        success: false,
        error: validation.error
      });
    }

  } catch (error) {
    console.error('Erro ao validar key:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// ROTA: Fazer pergunta (requer API Key do usuário)
// ============================================================================

app.post('/api/ask', async (req, res) => {
  try {
    const { question, apiKey, history } = req.body;

    if (!apiKey || apiKey.trim().length === 0) {
      return res.status(401).json({ error: 'API Key não fornecida' });
    }

    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: 'Pergunta vazia' });
    }

    // 1. Gerar SQL com Claude (usando key do usuário)
    console.log(`[User] Gerando SQL para: ${question}`);
    
    let sql;
    try {
      sql = await generateSQL(question, apiKey, history || []);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: `Erro ao gerar SQL: ${error.message}`
      });
    }

    // Validar se conseguiu gerar SQL
    if (!sql || sql.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Não consegui gerar uma query SQL para sua pergunta (resposta vazia)'
      });
    }

    if (sql.includes('ERROR')) {
      return res.status(400).json({
        success: false,
        error: 'Não consegui gerar uma query SQL para sua pergunta'
      });
    }

    // 2. Executar SQL no BigQuery
    console.log(`[User] Executando SQL`);
    let results;
    try {
      results = await executeQuery(sql);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: `Erro ao executar query: ${error.message}`
      });
    }

    // 3. Formatar resposta com Claude
    console.log(`[User] Formatando resposta`);
    let answer;
    try {
      answer = await formatAnswer(question, results, apiKey);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: `Erro ao formatar resposta: ${error.message}`
      });
    }

    res.json({
      success: true,
      question,
      answer,
      rowsReturned: results.length,
      sqlUsed: sql
    });

  } catch (error) {
    console.error('Erro ao processar pergunta:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao processar pergunta'
    });
  }
});

// ============================================================================
// ROTA: Health check
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    bigquery: 'connected',
    mode: 'user-api-key'
  });
});

// ============================================================================
// ROTA: Servir Frontend (index.html)
// ============================================================================

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Oráculo de Dados - Cheil BI 🔮      ║
║                                        ║
║   Servidor rodando em:                 ║
║   http://localhost:${PORT}             ║
║                                        ║
║   Modo: Cada usuário usa sua API Key  ║
╚════════════════════════════════════════╝
  `);
  
  // Validações de startup
  if (!process.env.GCP_PROJECT_ID) console.warn('⚠️  GCP_PROJECT_ID não configurado');
  if (!process.env.GCP_SERVICE_ACCOUNT_JSON) console.warn('⚠️  GCP_SERVICE_ACCOUNT_JSON não configurado');
});

module.exports = app;
