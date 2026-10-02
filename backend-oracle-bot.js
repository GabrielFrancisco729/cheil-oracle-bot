/**
 * BACKEND COMPLETO: Oráculo de Dados Cheil BI
 * 
 * Funcionalidades:
 * - OAuth com OpenAI (usuários logam com ChatGPT deles)
 * - Integração BigQuery (Google Cloud)
 * - Integração Claude API (processa perguntas)
 * - Chat interativo
 * 
 * Stack: Express + JWT + BigQuery + Claude
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const axios = require('axios');
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

const OPENAI_CLIENT_ID = process.env.OPENAI_CLIENT_ID;
const OPENAI_CLIENT_SECRET = process.env.OPENAI_CLIENT_SECRET;
const OPENAI_REDIRECT_URI = process.env.OPENAI_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const JWT_SECRET = process.env.JWT_SECRET || 'seu-secret-super-seguro-aqui-mude-em-producao';

// BigQuery
const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GCP_SERVICE_ACCOUNT_JSON,
});

// ============================================================================
// HELPER: Extrair configurações do BigQuery
// ============================================================================

const BQ_CONFIG = {
  projectId: process.env.GCP_PROJECT_ID || 'cheil-bi',
  datasets: {
    main: process.env.BQ_DATASET_MAIN || 'consolidated',
    dimensions: process.env.BQ_DATASET_DIMENSIONS || 'alldimensions',
  }
};

// ============================================================================
// ROTA: Login - Redireciona para OpenAI OAuth
// ============================================================================

app.get('/auth/login', (req, res) => {
  const authUrl = new URL('https://auth.openai.com/authorize');
  
  authUrl.searchParams.append('client_id', OPENAI_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', OPENAI_REDIRECT_URI);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', 'openai-api');
  
  res.redirect(authUrl.toString());
});

// ============================================================================
// ROTA: Callback - OpenAI redireciona aqui após autorização
// ============================================================================

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=${error}`);
  }

  try {
    // 1. Trocar código por access token
    const tokenResponse = await axios.post('https://auth.openai.com/token', {
      client_id: OPENAI_CLIENT_ID,
      client_secret: OPENAI_CLIENT_SECRET,
      code,
      redirect_uri: OPENAI_REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const { access_token, refresh_token } = tokenResponse.data;

    // 2. Buscar informações do usuário
    const userResponse = await axios.get('https://api.openai.com/v1/user', {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    const user = userResponse.data;

    // 3. Criar JWT com token do OpenAI
    const jwtToken = jwt.sign(
      {
        userId: user.id,
        userEmail: user.email,
        openaiAccessToken: access_token,
        openaiRefreshToken: refresh_token,
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 4. Redirecionar com token
    res.redirect(`${process.env.FRONTEND_URL}?token=${jwtToken}`);

  } catch (error) {
    console.error('Erro no callback:', error.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// ============================================================================
// MIDDLEWARE: Validar JWT
// ============================================================================

function validateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ============================================================================
// FUNÇÃO: Gerar SQL com Claude usando token do usuário
// ============================================================================

async function generateSQL(question, userOpenaiToken) {
  const client = new Anthropic({
    apiKey: userOpenaiToken, // Usa token do usuário!
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
          - Dataset "consolidated": contém dados consolidados
          - Dataset "alldimensions": contém dimensões e lookups
          
          INSTRUÇÕES:
          1. Analise a pergunta do usuário
          2. Gere uma query SQL válida para BigQuery
          3. Use os datasets disponíveis: ${BQ_CONFIG.datasets.main}, ${BQ_CONFIG.datasets.dimensions}
          4. Responda APENAS com o SQL, sem explicação
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

async function formatAnswer(question, sqlResults, userOpenaiToken) {
  const client = new Anthropic({
    apiKey: userOpenaiToken,
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
          3. Destaque insights principais
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
// ROTA: Fazer pergunta (requer autenticação)
// ============================================================================

app.post('/api/ask', validateToken, async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: 'Pergunta vazia' });
    }

    // 1. Gerar SQL com Claude (usando token do usuário)
    console.log(`[${req.user.userEmail}] Gerando SQL para: ${question}`);
    
    const sql = await generateSQL(question, req.user.openaiAccessToken);

    if (sql.includes('ERROR')) {
      return res.status(400).json({
        error: 'Não consegui gerar uma query SQL para sua pergunta',
        debug: sql
      });
    }

    // 2. Executar SQL no BigQuery
    console.log(`[${req.user.userEmail}] Executando SQL`);
    const results = await executeQuery(sql);

    // 3. Formatar resposta com Claude
    console.log(`[${req.user.userEmail}] Formatando resposta`);
    const answer = await formatAnswer(question, results, req.user.openaiAccessToken);

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
// ROTA: Verificar se está autenticado
// ============================================================================

app.get('/api/me', validateToken, (req, res) => {
  res.json({
    userId: req.user.userId,
    email: req.user.userEmail,
    authenticated: true
  });
});

// ============================================================================
// ROTA: Health check
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
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
╚════════════════════════════════════════╝
  `);
  
  // Validações de startup
  if (!OPENAI_CLIENT_ID) console.warn('⚠️  OPENAI_CLIENT_ID não configurado');
  if (!OPENAI_CLIENT_SECRET) console.warn('⚠️  OPENAI_CLIENT_SECRET não configurado');
  if (!process.env.GCP_PROJECT_ID) console.warn('⚠️  GCP_PROJECT_ID não configurado');
  if (!process.env.GCP_SERVICE_ACCOUNT_JSON) console.warn('⚠️  GCP_SERVICE_ACCOUNT_JSON não configurado');
});

module.exports = app;
