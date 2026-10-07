const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// CONFIG
// ============================================================================

const BQ_CONFIG = {
  projectId: process.env.GCP_PROJECT_ID || 'cheil-bi',
  dataset: process.env.BQ_DATASET_MAIN || 'apollo_gold',
  tables: {
    main: 'fConsolidated',
    dimensions: 'dAllDimensions',
  }
};

// Initialize BigQuery
let bigqueryConfig = {
  projectId: BQ_CONFIG.projectId,
};

if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    bigqueryConfig.credentials = serviceAccount;
  } catch (error) {
    console.error('Erro ao parsear GCP_SERVICE_ACCOUNT_JSON:', error.message);
    bigqueryConfig.keyFilename = process.env.GCP_SERVICE_ACCOUNT_JSON;
  }
}

const bigquery = new BigQuery(bigqueryConfig);

console.log(`╔════════════════════════════════════════╗`);
console.log(`║   Oráculo de Dados - Cheil BI 🔮      ║`);
console.log(`║                                        ║`);
console.log(`║   Servidor rodando em:                 ║`);
console.log(`║   http://localhost:${PORT}             ║`);
console.log(`║                                        ║`);
console.log(`║   Modo: Cada usuário usa sua API Key  ║`);
console.log(`╚════════════════════════════════════════╝`);

// ============================================================================
// FUNÇÃO: Validar API Key
// ============================================================================

function validateApiKey(apiKey) {
  if (!apiKey || apiKey.trim().length === 0) {
    return { valid: false, error: 'API Key vazia' };
  }

  if (!apiKey.startsWith('sk-ant-')) {
    return { valid: false, error: 'API Key deve começar com sk-ant- (Claude/Anthropic)' };
  }

  return { valid: true };
}

// ============================================================================
// FUNÇÃO: Gerar SQL com Claude
// ============================================================================

async function generateSQL(question, userApiKey, history = []) {
  const client = new Anthropic({
    apiKey: userApiKey,
  });

  const systemPrompt = `You are a BigQuery SQL expert. Generate ONLY valid SQL. NO explanations.

CHEIL BI DATABASE (cheil-bi.apollo_gold):

Tables:
1. fConsolidated: Date, Product, Tracking_code, DELIVERED, OPENS, CLICKS, Total_visits, Total_orders, Total_units, Revenue_SEDA, Source, CHANNEL, DATA_SOURCE
2. dProducts: SKU, PRODUCT, BU, FAMILY  
3. dAllDimensions: TrackingCode, SUB (SEDA/MX/CE/DA), CAMPAIGN, CHANNEL

Relationships:
- fConsolidated.Product = dProducts.SKU
- fConsolidated.Tracking_code = dAllDimensions.TrackingCode

RULES:
1. Always use backticks for table names
2. If question mentions SEDA → filter WHERE dAllDimensions.SUB = 'SEDA'
3. Use SUM(Revenue_SEDA) for revenue
4. GROUP BY DATE_TRUNC(Date, MONTH) to compare periods
5. ORDER BY DESC, LIMIT 100

METRICS: DELIVERED, OPENS, CLICKS, Total_visits, Total_orders, Total_units, Revenue_SEDA

Example: "Revenue SEDA?"
SELECT DATE_TRUNC(fc.Date, MONTH) as period, SUM(fc.Revenue_SEDA) as revenue
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
WHERE d.SUB = 'SEDA'
GROUP BY period ORDER BY period DESC

Context: Keep filters from previous questions.
If error: respond only "ERROR"
ONLY SQL. NO EXPLANATIONS.`;

  try {
    const messages = [];
    
    if (history && history.length > 0) {
      history.forEach(msg => {
        if (msg.role && msg.content) {
          messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content.substring(0, 300)
          });
        }
      });
    }
    
    messages.push({
      role: 'user',
      content: `Question: "${question}"\n\nGenerate SQL:`
    });

    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages
    });

    if (response && response.content && Array.isArray(response.content)) {
      let textBlock = null;
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          textBlock = block;
          break;
        }
      }
      
      if (!textBlock) {
        throw new Error('Claude did not generate SQL');
      }

      let text = textBlock.text.trim();
      
      if (text.includes('```sql')) {
        text = text.replace(/```sql\n?/g, '').replace(/```\n?/g, '');
      }
      if (text.includes('```')) {
        text = text.replace(/```\n?/g, '');
      }
      
      text = text.trim();
      
      if (!text) {
        throw new Error('Claude generated empty response');
      }

      console.log(`[SQL] ${text.substring(0, 80)}...`);
      return text;
    } else {
      throw new Error('Invalid Claude response');
    }
  } catch (error) {
    console.error('[SQL Error]', error.message);
    throw error;
  }
}

// ============================================================================
// FUNÇÃO: Executar Query
// ============================================================================

async function executeQuery(sql) {
  try {
    const options = {
      query: sql,
      location: 'US',
    };

    const [rows] = await bigquery.query(options);
    return rows;
  } catch (error) {
    throw new Error(`BigQuery Error: ${error.message}`);
  }
}

// ============================================================================
// FUNÇÃO: Formatar Resposta
// ============================================================================

async function formatAnswer(question, sqlResults, userApiKey) {
  const client = new Anthropic({
    apiKey: userApiKey,
  });

  const resultsJson = JSON.stringify(sqlResults, null, 2);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: `Question: "${question}"\n\nData (JSON):\n${resultsJson}\n\nSummarize clearly in Portuguese. Show numbers and comparisons if available. Keep it concise.`
        }
      ]
    });

    if (response && response.content && Array.isArray(response.content)) {
      let textBlock = null;
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          textBlock = block;
          break;
        }
      }
      
      if (!textBlock) {
        throw new Error('Claude did not generate answer');
      }
      
      let text = textBlock.text.trim();
      text = text.replace(/\*\*/g, '').replace(/\*(?!\w)/g, '').replace(/#{1,6}\s/g, '').replace(/`/g, '');
      
      return text;
    } else {
      throw new Error('Invalid Claude response');
    }
  } catch (error) {
    console.error('[Format Error]', error.message);
    throw error;
  }
}

// ============================================================================
// ROTA: Validar Key
// ============================================================================

app.post('/api/validate-key', (req, res) => {
  try {
    const { apiKey } = req.body;
    const validation = validateApiKey(apiKey);

    if (validation.valid) {
      res.json({
        success: true,
        message: 'API Key accepted! You can start asking questions.'
      });
    } else {
      res.status(400).json({
        success: false,
        error: validation.error
      });
    }
  } catch (error) {
    console.error('[Validate Error]', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ROTA: Ask Question
// ============================================================================

app.post('/api/ask', async (req, res) => {
  try {
    const { question, apiKey, history } = req.body;

    if (!apiKey) {
      return res.status(401).json({ error: 'API Key not provided' });
    }

    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: 'Empty question' });
    }

    console.log(`[Ask] ${question}`);
    
    // Generate SQL
    let sql;
    try {
      sql = await generateSQL(question, apiKey, history || []);
    } catch (error) {
      return res.status(400).json({ error: `Error generating SQL: ${error.message}` });
    }

    // Validate SQL
    if (!sql || sql.includes('ERROR')) {
      return res.status(400).json({ error: 'Could not generate SQL for your question' });
    }

    // Execute query
    let results;
    try {
      results = await executeQuery(sql);
    } catch (error) {
      return res.status(400).json({ error: `Query execution error: ${error.message}` });
    }

    // Format answer
    let answer;
    try {
      answer = await formatAnswer(question, results, apiKey);
    } catch (error) {
      return res.status(400).json({ error: `Error formatting answer: ${error.message}` });
    }

    res.json({ success: true, answer });
  } catch (error) {
    console.error('[Ask Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ROTA: Health Check
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
