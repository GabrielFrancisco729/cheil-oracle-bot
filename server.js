'use strict';
require('dotenv').config();
const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');
const { createDataService, validateContext } = require('./lib/data');
const { createAIService } = require('./lib/ai');
const metricContract = require('./lib/metrics');

function integerEnv(env, key, fallback) {
  const value = Number(env[key] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} deve ser um inteiro positivo.`);
  return value;
}
function validateConversation(body) {
  const message = body.message;
  const history = body.history ?? [];
  if (typeof message !== 'string' || !message.trim() || message.length > 4000) throw Object.assign(new Error('A pergunta deve ter entre 1 e 4.000 caracteres.'), { status: 400 });
  if (!Array.isArray(history) || history.length > 20 || history.some((m, i) => !m || m.role !== (i % 2 === 0 ? 'user' : 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 12000) || history.length % 2 || JSON.stringify(history).length > 90000) throw Object.assign(new Error('Histórico de conversa inválido.'), { status: 400 });
  return { message: message.trim(), history: history.map(({ role, content }) => ({ role, content })) };
}
function createApp({ env = process.env, dataService, aiService } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(env.TRUST_PROXY_HOPS || (env.RENDER ? 1 : 0)));
  app.use(express.json({ limit: '128kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'");
    next();
  });
  if (!dataService) {
    const config = { projectId: env.GCP_PROJECT_ID || 'cheil-bi', dataset: env.BQ_DATASET_MAIN || 'apollo_gold', location: env.BQ_LOCATION || 'US', timezone: env.APP_TIMEZONE || 'America/Sao_Paulo', maximumBytesBilled: env.BQ_MAXIMUM_BYTES_BILLED || '10000000000' };
    const credentials = env.GCP_SERVICE_ACCOUNT_JSON ? JSON.parse(env.GCP_SERVICE_ACCOUNT_JSON) : undefined;
    dataService = createDataService(new BigQuery({ projectId: config.projectId, ...(credentials ? { credentials } : {}) }), config);
  }
  if (!aiService && env.ANTHROPIC_API_KEY) aiService = createAIService(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60000, maxRetries: 1 }), dataService, env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001');
  app.get('/api/config', (req, res) => res.json({ success: true, aiConfigured: Boolean(aiService) }));
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/metric-contract', (req, res) => res.json({ success: true, version: metricContract.version, metrics: metricContract.metrics, quality: metricContract.metricQuality() }));
  app.get('/api/report-catalog', async (req, res) => {
    try {
      res.json({ success: true, source: 'bigquery', dimensions: await dataService.dimensions(), metrics: metricContract.metrics });
    } catch (_) {
      res.json({ success: true, source: 'reference', notice: 'Lista de exemplo: a leitura do schema de dAllDimensions ainda não está disponível.', dimensions: ['SUB', 'CHANNEL', 'CAMPAIGN', 'TrackingCode'].map(id => ({ id, label: id, type: 'STRING' })), metrics: metricContract.metrics });
    }
  });
  const templates = {
    monthly: 'SEDA-Report-Mensal-Agosto-2026.pptx',
    quarterly: 'SEDA-Report-Quarter-Q2-2026.pptx',
  };
  app.get('/api/templates/:type', (req, res, next) => {
    const name = Object.hasOwn(templates, req.params.type) ? templates[req.params.type] : null;
    if (!name) return res.status(404).json({ error: 'Modelo não encontrado.' });
    res.download(path.join(__dirname, 'public', 'downloads', name), name, error => { if (error) next(error); });
  });
  app.get('/api/subsidiaries', async (req, res, next) => {
    try { res.json({ success: true, subsidiaries: await dataService.subsidiaries() }); } catch (error) { error.service = 'bigquery'; next(error); }
  });
  const windowMs = 15 * 60 * 1000;
  const limits = new Map();
  const perWindow = integerEnv(env, 'AI_REQUESTS_PER_15_MIN', 30);
  const perDay = integerEnv(env, 'AI_REQUESTS_PER_DAY', 300);
  const maxConcurrent = integerEnv(env, 'AI_MAX_CONCURRENT', 6);
  let dailyDate = '', dailyCount = 0, active = 0;
  function allowAI(req, res, next) {
    if (!aiService) return res.status(503).json({ error: 'Configure ANTHROPIC_API_KEY no servidor para ativar o assistente.' });
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
    const now = Date.now(), day = new Date().toISOString().slice(0, 10);
    if (dailyDate !== day) { dailyDate = day; dailyCount = 0; }
    for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key);
    const key = req.ip;
    const entry = limits.get(key) || { count: 0, until: now + windowMs };
    if (entry.count >= perWindow || dailyCount >= perDay || active >= maxConcurrent) {
      res.setHeader('Retry-After', dailyCount >= perDay ? 3600 : active >= maxConcurrent ? 10 : Math.ceil((entry.until - now) / 1000));
      return res.status(429).json({ error: dailyCount >= perDay ? 'O limite diário de uso foi atingido. Tente novamente amanhã.' : 'Muitas solicitações no momento. Aguarde e tente novamente.' });
    }
    entry.count++; limits.set(key, entry); dailyCount++; active++;
    let released = false;
    res.locals.releaseAI = () => { if (!released) { released = true; active--; } };
    next();
  }
  app.post('/api/chat', (req, res, next) => {
    try { res.locals.context = validateContext(req.body.context); res.locals.conversation = validateConversation(req.body); next(); } catch (error) { next(error); }
  }, allowAI, async (req, res, next) => {
    try {
      const { history, message } = res.locals.conversation;
      res.json({ success: true, ...await aiService.chat(res.locals.context, history, message) });
    } catch (error) { next(error); } finally { res.locals.releaseAI(); }
  });
  app.post('/api/summary', (req, res, next) => {
    try {
      res.locals.context = validateContext(req.body.context);
      res.locals.summaryType = req.body.type || req.body.context?.type || 'executive';
      if (!['executive', 'managerial'].includes(res.locals.summaryType)) throw Object.assign(new Error('Tipo de resumo inválido.'), { status: 400 });
      next();
    } catch (error) { next(error); }
  }, allowAI, async (req, res, next) => {
    try { res.json({ success: true, type: res.locals.summaryType, ...await aiService.summary(res.locals.context, res.locals.summaryType) }); } catch (error) { next(error); } finally { res.locals.releaseAI(); }
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const inputError = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
    const status = inputError ? (error.type === 'entity.too.large' ? 413 : 400) : error.status === 400 ? 400 : error.status === 429 ? 429 : 502;
    console.error('[API error]', { route: req.path, status, name: error.name });
    res.status(status).json({ error: inputError ? 'Solicitação inválida ou muito grande.' : status === 400 ? error.message : status === 429 ? 'O provedor atingiu um limite de uso. Aguarde e tente novamente.' : error.service === 'bigquery' ? 'Não foi possível consultar as subsidiárias. Verifique a conexão do BigQuery.' : 'Não foi possível concluir a análise. Verifique as credenciais e os logs do servidor.' });
  });
  return app;
}
if (require.main === module) {
  createApp().listen(process.env.PORT || 10000, '0.0.0.0', () => console.log('Oráculo de Dados pronto.'));
}
module.exports = { createApp, validateConversation };
