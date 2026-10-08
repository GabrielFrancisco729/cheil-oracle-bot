'use strict';
const { resolvePeriod } = require('./periods');

function validateContext(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw Object.assign(new Error('Contexto inválido.'), { status: 400 });
  const subsidiaries = context.subsidiaries ?? ['LAO'];
  if (!Array.isArray(subsidiaries) || !subsidiaries.length || subsidiaries.length > 30 || subsidiaries.some(s => typeof s !== 'string' || !s.trim() || s.length > 80)) throw Object.assign(new Error('Subsidiária inválida.'), { status: 400 });
  const period = context.period ?? 'current_month';
  resolvePeriod(period);
  return { subsidiaries: [...new Set(subsidiaries.map(s => s.trim()))].sort(), period };
}

// Preserve the existing revenue rule, including the affiliate adjustment.
const REVENUE = `ROUND((SUM(IF(fc.Source = 'ANALYTICS', fc.Revenue_SEDA, 0)) +
 SUM(IF(fc.Source = 'VTEX', fc.Revenue_SEDA, 0)) +
 SUM(IF(d.CHANNEL = 'APP PUSH', fc.Revenue_SEDA, 0)) +
 SUM(IF(d.CHANNEL = 'WEB PUSH', fc.Revenue_SEDA, 0)) +
 SUM(IF(fc.Source LIKE 'GA4%', fc.Revenue_SEDA, 0)) +
 SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)) * 0.044) -
 SUM(IF(fc.DATA_SOURCE = 'AFFILIATE', fc.Revenue_SEDA, 0)), 2)`;
const METRICS = `COUNT(*) AS row_count, COUNT(DISTINCT fc.Tracking_code) AS tracking_count,
 MIN(DATE(fc.Date)) AS first_date, MAX(DATE(fc.Date)) AS last_date,
 SUM(fc.DELIVERED) AS delivered, SUM(fc.OPENS) AS opens, SUM(fc.CLICKS) AS clicks,
 SUM(fc.Total_visits) AS visits, SUM(fc.Total_orders) AS orders, SUM(fc.Total_units) AS units,
 ${REVENUE} AS revenue,
 SAFE_DIVIDE(SUM(fc.OPENS), SUM(fc.DELIVERED)) AS open_rate,
 SAFE_DIVIDE(SUM(fc.CLICKS), SUM(fc.OPENS)) AS click_rate,
 SAFE_DIVIDE(SUM(fc.Total_orders), SUM(fc.Total_visits)) AS cvr`;
const GROUPS = {
  overall: null, campaign: "COALESCE(d.CAMPAIGN, 'N/A')", product: "COALESCE(dp.PRODUCT, 'N/A')",
  channel: "COALESCE(d.CHANNEL, 'N/A')", subsidiary: "COALESCE(d.SUB, 'N/A')", day: 'CAST(DATE(fc.Date) AS STRING)',
};
const ORDER_METRICS = ['revenue', 'delivered', 'opens', 'clicks', 'visits', 'orders', 'units', 'open_rate', 'click_rate', 'cvr'];

function buildQuery(context, range, options = {}, config = {}) {
  const group = options.groupBy ?? 'overall';
  const metric = options.orderMetric ?? 'revenue';
  const direction = options.direction ?? 'desc';
  const limit = options.limit ?? 5;
  if (!Object.hasOwn(GROUPS, group) || !ORDER_METRICS.includes(metric) || !['asc', 'desc'].includes(direction) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('Consulta de análise inválida.'), { status: 400 });
  const project = config.projectId || 'cheil-bi';
  const dataset = config.dataset || 'apollo_gold';
  if (!/^[a-zA-Z0-9_-]+$/.test(project) || !/^[a-zA-Z0-9_]+$/.test(dataset)) throw new Error('Configuração BigQuery inválida.');
  const table = name => `\`${project}.${dataset}.${name}\``;
  const params = {}, types = {}, filters = [];
  if (range.start) {
    filters.push('DATE(fc.Date) >= DATE(@startDate) AND DATE(fc.Date) < DATE(@endDate)');
    params.startDate = range.start; params.endDate = range.endExclusive;
    // SDK 7.x expects wrapper objects for DATE parameters. Bind ISO strings
    // and convert in SQL so the serialized parameter values remain intact.
    types.startDate = 'STRING'; types.endDate = 'STRING';
  }
  if (!context.subsidiaries.includes('LAO')) {
    filters.push('(d.SUB IN UNNEST(@subsidiaries) OR (@includeSela AND STARTS_WITH(UPPER(d.SUB), \'SELA\')))');
    params.subsidiaries = context.subsidiaries; params.includeSela = context.subsidiaries.includes('SELA');
    types.subsidiaries = ['STRING']; types.includeSela = 'BOOL';
  }
  // Select a whole, deterministic dimension row per key to avoid inflating sums.
  const dims = `WITH dimension_rows AS (
 SELECT TrackingCode, ARRAY_AGG(STRUCT(SUB, CHANNEL, CAMPAIGN) ORDER BY TO_JSON_STRING(STRUCT(SUB, CHANNEL, CAMPAIGN)) LIMIT 1)[OFFSET(0)] AS v
 FROM ${table('dAllDimensions')} GROUP BY TrackingCode
), dimensions AS (SELECT TrackingCode, v.* FROM dimension_rows)`;
  const products = group === 'product' ? `\nLEFT JOIN (SELECT SKU, MIN(PRODUCT) AS PRODUCT FROM ${table('dProducts')} GROUP BY SKU) dp ON fc.Product = dp.SKU` : '';
  const expression = GROUPS[group];
  const query = `${dims}\nSELECT ${expression ? `${expression} AS name,` : ''}\n${METRICS}
 FROM ${table('fConsolidated')} fc LEFT JOIN dimensions d ON fc.Tracking_code = d.TrackingCode${products}
 ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
 ${expression ? `GROUP BY name ORDER BY ${metric} ${direction.toUpperCase()}, name ASC LIMIT ${limit}` : ''}`;
  return { query, params, types, useLegacySql: false, location: config.location || 'US', maximumBytesBilled: String(config.maximumBytesBilled || '10000000000'), jobTimeoutMs: 60000 };
}

function cleanRow(row) {
  const result = {};
  for (const [key, raw] of Object.entries(row)) result[key] = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  result.aov = Number(result.orders) > 0 && result.revenue != null ? Number(result.revenue) / Number(result.orders) : null;
  return result;
}
function createDataService(bigquery, config = {}) {
  const cache = new Map();
  async function query(context, range, options) {
    const [rows] = await bigquery.query(buildQuery(context, range, options, config));
    return rows.map(cleanRow);
  }
  async function snapshot(rawContext) {
    const context = validateContext(rawContext);
    const period = resolvePeriod(context.period, new Date(), config.timezone || 'America/Sao_Paulo');
    const key = JSON.stringify({ context, period });
    if (cache.has(key) && cache.get(key).expires > Date.now()) return cache.get(key).promise;
    const promise = (async () => {
      const [totals, campaigns, products, channels, previous] = await Promise.all([
        query(context, period), query(context, period, { groupBy: 'campaign' }), query(context, period, { groupBy: 'product' }),
        query(context, period, { groupBy: 'channel', limit: 100 }), period.comparison ? query(context, period.comparison) : [],
      ]);
      const current = totals[0] || {};
      const prior = previous[0] || null;
      const changes = {};
      if (prior && Number(prior.row_count) > 0) for (const field of ORDER_METRICS) {
        const a = current[field], b = prior[field];
        changes[field] = a == null || b == null || Number(b) === 0 ? null : (Number(a) - Number(b)) / Math.abs(Number(b));
      }
      return { context, period, totals: current, previous: prior, changes, campaigns, products, channels, hasData: Number(current.row_count) > 0,
        definitions: { open_rate: 'opens / delivered', click_rate: 'clicks / opens (CTOR; não clicks / delivered)', cvr: 'orders / visits', aov: 'revenue / orders', currency: 'Não foi validada a moeda/conversão de Revenue_SEDA. Não atribua BRL, USD ou R$ sem confirmação.', rankings: 'Campanhas e produtos: top 5 por receita, não lista completa.', revenue: 'Regra de Revenue_SEDA preservada do projeto original.', dimension: 'Uma linha determinística por TrackingCode/SKU; validar a regra de desempate se houver divergências.' } };
    })();
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { expires: Date.now() + 300000, promise });
    try { return await promise; } catch (error) { cache.delete(key); throw error; }
  }
  async function subsidiaries() {
    const { projectId = 'cheil-bi', dataset = 'apollo_gold' } = config;
    // Validate identifiers through the same builder used for all other queries.
    buildQuery({ subsidiaries: ['LAO'] }, { start: null }, {}, config);
    const [rows] = await bigquery.query({ query: `SELECT DISTINCT SUB FROM \`${projectId}.${dataset}.dAllDimensions\` WHERE SUB IS NOT NULL AND TRIM(SUB) NOT IN ('', '-') ORDER BY SUB`, location: config.location || 'US', maximumBytesBilled: String(config.maximumBytesBilled || '10000000000'), jobTimeoutMs: 60000 });
    return rows.map(row => row.SUB);
  }
  return { snapshot, query, subsidiaries };
}
module.exports = { validateContext, buildQuery, createDataService, cleanRow };
