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
// GET SUBSIDIARIES (UNIQUE)
// ============================================================================

app.get('/api/subsidiaries', async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT SUB 
      FROM \`cheil-bi.apollo_gold.dAllDimensions\`
      WHERE SUB IS NOT NULL
      ORDER BY SUB ASC
    `;
    
    const [rows] = await bigquery.query({ query, location: 'US' });
    const subs = rows.map(row => row.SUB).filter(Boolean);
    
    console.log('[Subs] Loaded:', subs);
    res.json({ success: true, subsidiaries: subs });
  } catch (error) {
    console.error('[Get Subs Error]', error.message);
    res.json({ success: true, subsidiaries: [] });
  }
});

// ============================================================================
// GENERATE SQL
// ============================================================================

async function generateSQL(question, apiKey, context = {}) {
  const subsidiary = context.subsidiary || 'SEDA';
  const isLao = subsidiary === 'LAO';
  
  // Construir filtro WHERE dinamicamente
  const whereClause = isLao ? '' : `WHERE d.SUB = '${subsidiary}'`;
  const andClause = isLao ? '' : `AND d.SUB = '${subsidiary}'`;
  
  const isRevenue = /revenue|receita|faturamento|ganho/i.test(question);
  const isDelivery = /deliver|entrega|enviado/i.test(question);
  
  let sql = '';
  
  if (isRevenue) {
    sql = `
WITH revenue_data AS (
  SELECT 
    DATE_TRUNC(fc.Date, MONTH) as mes,
    ROUND(
      (SUM(IF(fc.Source = 'ANALYTICS', fc.Revenue_SEDA, 0)) +
       SUM(IF(fc.Source = 'VTEX', fc.Revenue_SEDA, 0)) +
       SUM(IF(d.CHANNEL = 'APP PUSH', fc.Revenue_SEDA, 0)) +
       SUM(IF(d.CHANNEL = 'WEB PUSH', fc.Revenue_SEDA, 0)) +
       SUM(IF(fc.Source LIKE 'GA4%', fc.Revenue_SEDA, 0)) +
       (SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)) * 0.044)) -
      SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)), 2
    ) as tRevenueCRM
  FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
  LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
  ${whereClause}
  GROUP BY mes
)
SELECT 'REVENUE' as metric, mes, ROUND(tRevenueCRM, 2) as value FROM revenue_data ORDER BY mes DESC LIMIT 2
UNION ALL
SELECT 'TOP_PRODUCTS' as metric, NULL as mes, CONCAT(dp.PRODUCT, ': R$ ', ROUND(SUM(fc.Revenue_SEDA), 2)) as value
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
JOIN \`cheil-bi.apollo_gold.dProducts\` dp ON fc.Product = dp.SKU
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
WHERE DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH) ${andClause}
GROUP BY dp.PRODUCT
ORDER BY SUM(fc.Revenue_SEDA) DESC
LIMIT 3
UNION ALL
SELECT 'TOP_CAMPAIGNS' as metric, NULL as mes, CONCAT(IFNULL(d.CAMPAIGN, 'N/A'), ': R$ ', ROUND(SUM(fc.Revenue_SEDA), 2)) as value
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
WHERE DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH) ${andClause}
GROUP BY d.CAMPAIGN
ORDER BY SUM(fc.Revenue_SEDA) DESC
LIMIT 3`;
  } else if (isDelivery) {
    sql = `
SELECT 'DELIVERIES' as type, DATE_TRUNC(fc.Date, MONTH) as mes, SUM(fc.DELIVERED) as value
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
${whereClause}
GROUP BY mes
ORDER BY mes DESC
LIMIT 2
UNION ALL
SELECT 'TOP_PRODUCTS' as type, NULL as mes, CONCAT(dp.PRODUCT, ': ', CAST(SUM(fc.DELIVERED) AS STRING)) as value
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
JOIN \`cheil-bi.apollo_gold.dProducts\` dp ON fc.Product = dp.SKU
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
WHERE DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH) ${andClause}
GROUP BY dp.PRODUCT
ORDER BY SUM(fc.DELIVERED) DESC
LIMIT 3`;
  } else {
    sql = `
SELECT 
  'OVERVIEW' as type,
  DATE_TRUNC(fc.Date, MONTH) as mes,
  ROUND(SUM(fc.Revenue_SEDA), 2) as revenue,
  SUM(fc.DELIVERED) as delivered,
  SUM(fc.OPENS) as opens,
  ROUND(SUM(fc.OPENS) / SUM(fc.DELIVERED), 4) as open_rate,
  SUM(fc.CLICKS) as clicks,
  ROUND(SUM(fc.CLICKS) / SUM(fc.OPENS), 4) as click_rate,
  SUM(fc.Total_orders) as orders
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
${whereClause}
GROUP BY mes
ORDER BY mes DESC
LIMIT 3`;
  }
  
  console.log(`[SQL] Generated for: ${question.substring(0, 60)}...`);
  return sql;
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

  const resultsText = JSON.stringify(results, null, 2);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Pergunta: "${question}"\n\nDados:\n${resultsText}\n\nResponda em português. Mostre: valor principal, variação vs período anterior (%), top 3 itens, principais rates. Seja direto. Sem markdown.`
      }]
    });

    let answer = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        answer = block.text.trim();
        break;
      }
    }

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

    const sub = context?.subsidiary || 'SEDA';
    console.log(`[Ask] ${question} | SUB: ${sub}`);

    let sql = await generateSQL(question, apiKey, context);
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
