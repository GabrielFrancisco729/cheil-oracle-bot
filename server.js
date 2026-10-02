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
const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GCP_SERVICE_ACCOUNT_JSON,
});

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

async function generateSQL(question, userApiKey) {
  const client = new Anthropic({
    apiKey: userApiKey,
  });

  const systemPrompt = `Você é um expert em SQL e análise de dados do BigQuery.

CONTEXTO DO BANCO DE DADOS:
- Projeto: ${BQ_CONFIG.projectId}
- Dataset: ${BQ_CONFIG.dataset}
- Tabela de dados consolidados: \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.main}\`
- Tabela de dimensões: \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.dimensions}\`

INSTRUÇÕES:
1. Responda APENAS com uma query SQL válida para BigQuery
2. Use os nomes corretos das tabelas com o caminho completo
3. Não inclua explicações, apenas o SQL
4. Se não conseguir gerar SQL, responda: "ERROR"`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Pergunta: "${question}"\n\nGere a query SQL:`
        }
      ]
    });

    // Extrair texto da resposta de forma segura
    if (response && response.content && Array.isArray(response.content) && response.content.length > 0) {
      const text = response.content[0].text;
      
      if (!text || typeof text !== 'string') {
        console.error('[SQL Error] Texto da resposta inválido:', response.content[0]);
        throw new Error('Resposta do Claude não é texto válido');
      }
      
      console.log(`[SQL Generated] ${text.substring(0, 100)}...`);
      return text;
    } else {
      console.error('[SQL Error] Resposta vazia do Claude:', response);
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
      location: 'southamerica-east1', // Brazil South
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

Resultado dos dados (em JSON):
${resultsJson}

Por favor, resuma esses dados de forma clara em português. Destaque os pontos principais.`
        }
      ]
    });

    // Extrair texto da resposta de forma segura
    if (response && response.content && Array.isArray(response.content) && response.content.length > 0) {
      const text = response.content[0].text;
      
      if (!text || typeof text !== 'string') {
        console.error('[Format Answer Error] Texto inválido:', response.content[0]);
        throw new Error('Resposta do Claude não é texto válido');
      }
      
      return text;
    } else {
      console.error('[Format Answer Error] Resposta vazia:', response);
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
    const { question, apiKey } = req.body;

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
      sql = await generateSQL(question, apiKey);
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
