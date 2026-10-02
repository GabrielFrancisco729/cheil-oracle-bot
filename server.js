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

async function validateApiKey(apiKey) {
  try {
    const client = new Anthropic({
      apiKey: apiKey,
    });

    // Testa com uma pergunta simples
    await client.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: 'Test',
        }
      ]
    });

    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// ============================================================================
// FUNÇÃO: Gerar SQL com Claude usando key do usuário
// ============================================================================

async function generateSQL(question, userApiKey) {
  const client = new Anthropic({
    apiKey: userApiKey,
  });

  const response = await client.messages.create({
    model: 'claude-opus-4-1',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `
          Você é um expert em SQL e análise de dados do BigQuery.
          
          CONTEXTO DO BANCO DE DADOS:
          - Projeto: ${BQ_CONFIG.projectId}
          - Dataset: ${BQ_CONFIG.dataset}
          - Tabela de dados: \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.main}\`
          - Tabela de dimensões: \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.dimensions}\`
          
          INSTRUÇÕES:
          1. Analise a pergunta do usuário
          2. Gere uma query SQL válida para BigQuery
          3. Use as tabelas corretas com o caminho completo: \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.main}\` e \`${BQ_CONFIG.projectId}.${BQ_CONFIG.dataset}.${BQ_CONFIG.tables.dimensions}\`
          4. Responda APENAS com o SQL, sem explicação ou markdown
          5. Se não conseguir gerar SQL, responda: "ERROR: não consegui gerar SQL"
          
          PERGUNTA DO USUÁRIO: "${question}"
          
          SQL:
        `
      }
    ]
  });

  return response.content[0].text;
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

  const response = await client.messages.create({
    model: 'claude-opus-4-1',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: `
          PERGUNTA ORIGINAL: "${question}"
          
          RESULTADO DA QUERY (JSON):
          ${resultsJson}
          
          TAREFA:
          1. Analise os dados retornados
          2. Resuma de forma clara e útil em português
          3. Destaque os insights principais
          4. Use formatação simples (sem markdown complexo)
          5. Se não houver dados, explique por quê
          
          RESPOSTA:
        `
      }
    ]
  });

  return response.content[0].text;
}

// ============================================================================
// ROTA: Validar API Key
// ============================================================================

app.post('/api/validate-key', async (req, res) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey || apiKey.trim().length === 0) {
      return res.status(400).json({ error: 'API Key vazia' });
    }

    const validation = await validateApiKey(apiKey);

    if (validation.valid) {
      res.json({
        success: true,
        message: 'API Key válida! Você pode começar a fazer perguntas.'
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'API Key inválida. Verifique e tente novamente.'
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
    
    const sql = await generateSQL(question, apiKey);

    if (sql.includes('ERROR')) {
      return res.status(400).json({
        error: 'Não consegui gerar uma query SQL para sua pergunta',
        debug: sql
      });
    }

    // 2. Executar SQL no BigQuery
    console.log(`[User] Executando SQL`);
    const results = await executeQuery(sql);

    // 3. Formatar resposta com Claude
    console.log(`[User] Formatando resposta`);
    const answer = await formatAnswer(question, results, apiKey);

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
