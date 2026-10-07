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
// GET SUBSIDIARIES
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
    
    res.json({ success: true, subsidiaries: subs });
  } catch (error) {
    res.json({ success: true, subsidiaries: [] });
  }
});

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
// QUERY: BIG NUMBERS
// ============================================================================

function getBigNumbersSQL(context) {
  const subsidiary = context.subsidiary || 'SEDA';
  const period = context.period || 'current_month';
  const isLao = subsidiary === 'LAO';
  
  const whereClause = isLao 
    ? `WHERE DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)`
    : `WHERE d.SUB = '${subsidiary}' AND DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)`;
  
  return `
SELECT 
  SUM(fc.DELIVERED) as delivered,
  SUM(fc.OPENS) as opens,
  SUM(fc.CLICKS) as clicks,
  SUM(fc.Total_visits) as visits,
  SUM(fc.Total_orders) as orders,
  SUM(fc.Total_units) as units,
  ROUND((SUM(IF(fc.Source = 'ANALYTICS', fc.Revenue_SEDA, 0)) +
         SUM(IF(fc.Source = 'VTEX', fc.Revenue_SEDA, 0)) +
         SUM(IF(d.CHANNEL = 'APP PUSH', fc.Revenue_SEDA, 0)) +
         SUM(IF(d.CHANNEL = 'WEB PUSH', fc.Revenue_SEDA, 0)) +
         SUM(IF(fc.Source LIKE 'GA4%', fc.Revenue_SEDA, 0)) +
         (SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)) * 0.044)) -
        SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)), 2) as revenue,
  ROUND(SUM(fc.OPENS) / NULLIF(SUM(fc.DELIVERED), 0), 4) as open_rate,
  ROUND(SUM(fc.CLICKS) / NULLIF(SUM(fc.OPENS), 0), 4) as click_rate,
  ROUND(SUM(fc.Total_orders) / NULLIF(SUM(fc.Total_visits), 0), 4) as cvr
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
${whereClause}`;
}

// ============================================================================
// QUERY: TOP 5 CAMPAIGNS
// ============================================================================

function getTopCampaignsSQL(context) {
  const subsidiary = context.subsidiary || 'SEDA';
  const isLao = subsidiary === 'LAO';
  
  const whereClause = isLao 
    ? `WHERE DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)`
    : `WHERE d.SUB = '${subsidiary}' AND DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)`;
  
  return `
SELECT 
  IFNULL(d.CAMPAIGN, 'N/A') as campaign,
  SUM(fc.DELIVERED) as delivered,
  ROUND((SUM(IF(fc.Source = 'ANALYTICS', fc.Revenue_SEDA, 0)) +
         SUM(IF(fc.Source = 'VTEX', fc.Revenue_SEDA, 0)) +
         SUM(IF(d.CHANNEL = 'APP PUSH', fc.Revenue_SEDA, 0)) +
         SUM(IF(d.CHANNEL = 'WEB PUSH', fc.Revenue_SEDA, 0)) +
         SUM(IF(fc.Source LIKE 'GA4%', fc.Revenue_SEDA, 0)) +
         (SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)) * 0.044)) -
        SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)), 2) as revenue,
  ROUND(SUM(fc.OPENS) / NULLIF(SUM(fc.DELIVERED), 0), 4) as open_rate,
  SUM(fc.Total_orders) as orders
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
${whereClause}
GROUP BY d.CAMPAIGN
ORDER BY revenue DESC
LIMIT 5`;
}

// ============================================================================
// QUERY: TOP 5 PRODUCTS
// ============================================================================

function getTopProductsSQL(context) {
  const subsidiary = context.subsidiary || 'SEDA';
  const isLao = subsidiary === 'LAO';
  
  const whereClause = isLao 
    ? `WHERE DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)`
    : `WHERE d.SUB = '${subsidiary}' AND DATE_TRUNC(fc.Date, MONTH) = DATE_TRUNC(CURRENT_DATE(), MONTH)`;
  
  return `
SELECT 
  dp.PRODUCT as product,
  SUM(fc.DELIVERED) as delivered,
  ROUND((SUM(IF(fc.Source = 'ANALYTICS', fc.Revenue_SEDA, 0)) +
         SUM(IF(fc.Source = 'VTEX', fc.Revenue_SEDA, 0)) +
         SUM(IF(d.CHANNEL = 'APP PUSH', fc.Revenue_SEDA, 0)) +
         SUM(IF(d.CHANNEL = 'WEB PUSH', fc.Revenue_SEDA, 0)) +
         SUM(IF(fc.Source LIKE 'GA4%', fc.Revenue_SEDA, 0)) +
         (SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)) * 0.044)) -
        SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)), 2) as revenue,
  ROUND(SUM(fc.OPENS) / NULLIF(SUM(fc.DELIVERED), 0), 4) as open_rate,
  SUM(fc.Total_orders) as orders
FROM \`cheil-bi.apollo_gold.fConsolidated\` fc
JOIN \`cheil-bi.apollo_gold.dProducts\` dp ON fc.Product = dp.SKU
LEFT JOIN \`cheil-bi.apollo_gold.dAllDimensions\` d ON fc.Tracking_code = d.TrackingCode
${whereClause}
GROUP BY dp.PRODUCT
ORDER BY revenue DESC
LIMIT 5`;
}

// ============================================================================
// FORMAT SUMMARY
// ============================================================================

async function formatSummary(bigNumbers, campaigns, products, apiKey) {
  const client = new Anthropic({ apiKey });

  const data = {
    bigNumbers: bigNumbers[0] || {},
    topCampaigns: campaigns || [],
    topProducts: products || []
  };

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Formatte esse resumo executivo em português, bem legível:

BIG NUMBERS:
- Entregas: ${data.bigNumbers.delivered || 0}
- Aberturas: ${data.bigNumbers.opens || 0} (Taxa: ${(data.bigNumbers.open_rate * 100).toFixed(2)}%)
- Cliques: ${data.bigNumbers.clicks || 0}
- Visitas: ${data.bigNumbers.visits || 0}
- Pedidos: ${data.bigNumbers.orders || 0} (CVR: ${(data.bigNumbers.cvr * 100).toFixed(2)}%)
- Unidades: ${data.bigNumbers.units || 0}
- Revenue: R$ ${data.bigNumbers.revenue || 0}

TOP 5 CAMPANHAS:
${campaigns.map((c, i) => `${i+1}. ${c.campaign}: R$ ${c.revenue} (${c.delivered} entregas, ${(c.open_rate * 100).toFixed(2)}% OR)`).join('\n')}

TOP 5 PRODUTOS:
${products.map((p, i) => `${i+1}. ${p.product}: R$ ${p.revenue} (${p.delivered} entregas, ${(p.open_rate * 100).toFixed(2)}% OR)`).join('\n')}

Faça um resumo executivo bem estruturado, sem markdown, bem profissional.`
      }]
    });

    let summary = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        summary = block.text.trim();
        break;
      }
    }

    return summary;
  } catch (error) {
    console.error('[Format Error]', error.message);
    return JSON.stringify(data, null, 2);
  }
}

// ============================================================================
// ROUTES
// ============================================================================

app.post('/api/summary', async (req, res) => {
  try {
    const { apiKey, context } = req.body;

    if (!apiKey) return res.status(401).json({ error: 'API Key required' });

    console.log(`[Summary] ${context?.subsidiary || 'SEDA'} | ${context?.period || 'current_month'}`);

    // Executar 3 queries
    const bigNumbers = await executeQuery(getBigNumbersSQL(context));
    const campaigns = await executeQuery(getTopCampaignsSQL(context));
    const products = await executeQuery(getTopProductsSQL(context));

    // Formatar resumo
    const summary = await formatSummary(bigNumbers, campaigns, products, apiKey);

    res.json({ 
      success: true, 
      summary,
      data: { bigNumbers: bigNumbers[0], campaigns, products }
    });
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
