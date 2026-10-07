const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BQ_CONFIG = {
  projectId: process.env.GCP_PROJECT_ID || 'cheil-bi',
  dataset: process.env.BQ_DATASET_MAIN || 'apollo_gold',
  tables: {
    main: 'fConsolidated',
    dimensions: 'dAllDimensions',
  }
};

let bigqueryConfig = { projectId: BQ_CONFIG.projectId };

if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    bigqueryConfig.credentials = serviceAccount;
  } catch (error) {
    console.error('GCP Auth Error:', error.message);
  }
}

const bigquery = new BigQuery(bigqueryConfig);

console.log(`\n╔════════════════════════════════════════╗`);
console.log(`║   🔮 Oráculo de Dados - Cheil BI     ║`);
console.log(`║   Servidor rodando em: :${PORT}       ║`);
console.log(`╚════════════════════════════════════════╝\n`);

// ============================================================================
// HELPER: Period Filter
// ============================================================================

function getPeriodFilter(period) {
  const filters = {
    current_week: `AND DATE_TRUNC(fc.Date, WEEK) = DATE_TRUNC(CURRENT_DATE(), WEEK)`,
    last_week: `AND DATE_TRUNC(fc.Date, WEEK) = DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 WEEK), WEEK)`,
    current_month: `AND DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)`,
    last_month: `AND DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 MONTH), MONTH)`,
    custom: ``,
    all_time: ``
  };
  return filters[period] || filters['current_month'];
}

// ============================================================================
// GENERATE SQL
// ============================================================================

async function generateSQL(question, apiKey, context = {}) {
  const client = new Anthropic({ apiKey });
  const subsidiary = context.subsidiary || 'SEDA';
  const period = context.period || 'current_month';
  const periodFilter = getPeriodFilter(period);

  const systemPrompt = `You are a BigQuery SQL expert. Generate ONLY valid SQL. NO explanations.

CRITICAL CONTEXT:
- Subsidiary: ${subsidiary}
- Period: ${period}
- Always filter: WHERE dAllDimensions.SUB = '${subsidiary}' ${periodFilter}

DATABASE: cheil-bi.apollo_gold
Tables: fConsolidated, dProducts, dAllDimensions
Key columns: Date, DELIVERED, OPENS, CLICKS, Total_visits, Total_orders, Total_units, Revenue_SEDA, Source, CHANNEL

ABSOLUTE RULES:
1. Use backticks: \`cheil-bi.apollo_gold.fConsolidated\`
2. ALWAYS JOIN dAllDimensions ON fc.Tracking_code = d.TrackingCode
3. ALWAYS filter: WHERE d.SUB = '${subsidiary}' ${periodFilter}
4. For revenue: use SUM(fc.Revenue_SEDA) - this matches the Power BI dashboard
5. Group by month if asking about revenue trends
6. ORDER BY DESC, LIMIT 100

EXAMPLE: "Qual o revenue?"
SELECT 
  DATE_TRUNC(fc.Date, MONTH) as mes,
  SUM(fc.Revenue_SEDA) as revenue
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
WHERE d.SUB = '${subsidiary}' AND DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)
GROUP BY mes
ORDER BY mes DESC

ONLY SQL. NO EXPLANATIONS. If error: respond "ERROR"`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Generate SQL for: "${question}"` }]
    });

    let sql = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        sql = block.text.trim();
        break;
      }
    }

    if (!sql || sql.includes('ERROR')) throw new Error('SQL generation failed');
    
    if (sql.includes('```sql')) sql = sql.replace(/```sql\n?/g, '').replace(/```\n?/g, '');
    if (sql.includes('```')) sql = sql.replace(/```\n?/g, '');

    console.log(`[SQL] ${sql.substring(0, 80)}...`);
    return sql;
  } catch (error) {
    console.error('[SQL Error]', error.message);
    throw error;
  }
}

// ============================================================================
// EXECUTE QUERY
// ============================================================================

async function executeQuery(sql) {
  try {
    const [rows] = await bigquery.query({ query: sql, location: 'US' });
    return rows;
  } catch (error) {
    throw new Error(`BigQuery: ${error.message}`);
  }
}

// ============================================================================
// FORMAT ANSWER
// ============================================================================

async function formatAnswer(question, results, apiKey) {
  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Question: "${question}"\n\nData:\n${JSON.stringify(results, null, 2)}\n\nSummarize clearly in Portuguese. Show key numbers and trends. Keep it concise.`
      }]
    });

    let answer = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        answer = block.text.trim();
        break;
      }
    }

    // Remove markdown
    answer = answer.replace(/\*\*/g, '').replace(/\*(?!\w)/g, '').replace(/#{1,6}\s/g, '').replace(/`/g, '');
    
    return answer;
  } catch (error) {
    console.error('[Format Error]', error.message);
    throw error;
  }
}

// ============================================================================
// ROUTES
// ============================================================================

app.post('/api/ask', async (req, res) => {
  try {
    const { question, apiKey, context } = req.body;

    if (!apiKey) return res.status(401).json({ error: 'API Key required' });
    if (!question) return res.status(400).json({ error: 'Question required' });

    console.log(`[Ask] ${question} | ${context?.subsidiary || 'SEDA'}`);

    let sql = await generateSQL(question, apiKey, context);
    
    if (!sql || sql.includes('ERROR')) {
      return res.status(400).json({ error: 'Could not generate SQL' });
    }

    let results = await executeQuery(sql);
    let answer = await formatAnswer(question, results, apiKey);

    res.json({ success: true, answer });
  } catch (error) {
    console.error('[Error]', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/validate-key', (req, res) => {
  const { apiKey } = req.body;
  
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'Invalid API Key' });
  }
  
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`✅ Server ready on port ${PORT}\n`);
});
