'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeriod } = require('../lib/periods');
const { buildQuery, validateContext, createDataService } = require('../lib/data');
const { createAIService } = require('../lib/ai');
const { createApp } = require('../server');
const now = new Date('2026-10-08T18:00:00Z');
const context = { subsidiaries: ['SELA'], period: 'current_month' };
const fakeData = { context, period: resolvePeriod('current_month', now), hasData: true, totals: { row_count: 4, revenue: 100, orders: 5 }, previous: { row_count: 3, revenue: 80 }, campaigns: [], products: [], channels: [] };

test('all seven periods resolve correctly for October 8, 2026', () => {
  const expected = { quarter_current: ['2026-10-01', '2026-10-09', '2026-07-01', '2026-07-09'], quarter_last: ['2026-07-01', '2026-10-01', '2026-04-01', '2026-07-01'], current_week: ['2026-10-05', '2026-10-09', '2026-09-28', '2026-10-02'], last_week: ['2026-09-28', '2026-10-05', '2026-09-21', '2026-09-28'], current_month: ['2026-10-01', '2026-10-09', '2026-09-01', '2026-09-09'], last_month: ['2026-09-01', '2026-10-01', '2026-08-01', '2026-09-01'] };
  for (const [key, values] of Object.entries(expected)) { const p = resolvePeriod(key, now); assert.deepEqual([p.start, p.endExclusive, p.comparison.start, p.comparison.endExclusive], values); }
  assert.equal(resolvePeriod('all_time', now).start, null); assert.equal(resolvePeriod('all_time', now).comparison, null);
});
test('timezone, year rollover, leap day and shorter-month boundaries', () => {
  assert.equal(resolvePeriod('current_month', new Date('2026-10-01T01:00:00Z')).start, '2026-09-01');
  assert.equal(resolvePeriod('last_month', new Date('2027-01-01T15:00:00Z')).start, '2026-12-01');
  assert.equal(resolvePeriod('current_month', new Date('2024-02-29T15:00:00Z')).endExclusive, '2024-03-01');
  assert.equal(resolvePeriod('current_month', new Date('2026-03-31T15:00:00Z')).comparison.endExclusive, '2026-03-01');
  assert.equal(resolvePeriod('quarter_last', new Date('2027-01-02T15:00:00Z')).start, '2026-10-01');
  assert.throws(() => resolvePeriod('bad'), /inválido/);
});
test('queries bind dates and subsidiaries instead of injecting user values', () => {
  const malicious = "BR'); DROP TABLE t; --";
  const c = validateContext({ subsidiaries: [malicious, 'SELA'], period: 'last_month' });
  const q = buildQuery(c, resolvePeriod(c.period, now), { groupBy: 'campaign' });
  assert.ok(!q.query.includes(malicious)); assert.ok(q.params.subsidiaries.includes(malicious)); assert.equal(q.params.includeSela, true);
  assert.equal(q.params.startDate, '2026-09-01'); assert.equal(q.types.startDate, 'STRING'); assert.match(q.query, /STARTS_WITH/);
  assert.match(q.query, /ARRAY_AGG/); assert.match(q.query, /GROUP BY TrackingCode/);
  const all = buildQuery({ subsidiaries: ['LAO'] }, resolvePeriod('all_time', now));
  assert.deepEqual(all.params, {}); assert.ok(!all.query.includes('@startDate')); assert.ok(!all.query.includes('@subsidiaries'));
});
test('rejects invalid contexts, identifiers and query options', () => {
  for (const c of [{ subsidiaries: [] }, { subsidiaries: 'BR' }, { subsidiaries: [7] }, { period: '__proto__' }, null]) assert.throws(() => validateContext(c));
  for (const options of [{ groupBy: 'SQL' }, { direction: 'desc; DROP' }, { orderMetric: 'evil' }, { limit: 101 }, { limit: 1.1 }]) assert.throws(() => buildQuery(context, fakeData.period, options));
  assert.throws(() => buildQuery(context, fakeData.period, {}, { dataset: 'a`b' }));
});
test('snapshot uses five filtered queries, caches same context and invalidates different filters', async () => {
  const queries = [];
  const bq = { query: async q => { queries.push(q); return [[{ row_count: 5, orders: null, aov: null, revenue: 100, first_date: { value: '2026-10-01' } }]]; } };
  const data = createDataService(bq);
  const result = await data.snapshot(context); await data.snapshot(context);
  assert.equal(queries.length, 5); assert.equal(result.totals.aov, null); assert.equal(result.quality.orders.status, 'pending'); assert.equal(result.totals.first_date, '2026-10-01');
  assert.ok(queries.every(q => q.params.includeSela && q.params.startDate));
  await data.snapshot({ ...context, period: 'all_time' }); assert.equal(queries.length, 9);
});
test('snapshot failures do not poison cache', async () => {
  let fail = true;
  const service = createDataService({ query: async () => { if (fail) throw new Error('offline'); return [[{ row_count: 0 }]]; } });
  await assert.rejects(() => service.snapshot(context)); fail = false;
  assert.equal((await service.snapshot(context)).hasData, false);
});
test('executive and managerial prompts differ and include verified facts', async () => {
  const requests = [];
  const ai = createAIService({ messages: { create: async body => { requests.push(body); return { content: [{ type: 'text', text: 'Resumo validado.' }], stop_reason: 'end_turn' }; } } }, { snapshot: async () => fakeData });
  await ai.summary(context, 'executive'); await ai.summary(context, 'managerial');
  assert.notEqual(requests[0].messages[0].content, requests[1].messages[0].content); assert.match(requests[1].messages[0].content, /canal/); assert.match(requests[0].system, /"revenue":100/);
});
test('no-data summary and chat skip Claude', async () => {
  const ai = createAIService({ messages: { create: () => { throw new Error('must not call'); } } }, { snapshot: async () => ({ ...fakeData, hasData: false }) });
  assert.match((await ai.summary(context, 'executive')).summary, /Não há dados/); assert.match((await ai.chat(context, [], 'Olá')).reply, /Não encontrei/);
});
test('chat sends previous turns and executes a bounded tool against selected context', async () => {
  const requests = [], calls = [];
  const client = { messages: { create: async body => { requests.push(structuredClone(body)); return requests.length === 1 ? { content: [{ type: 'tool_use', id: 'tool1', name: 'query_performance', input: { groupBy: 'campaign', direction: 'asc', limit: 5 } }] } : { content: [{ type: 'text', text: 'As menores receitas são…' }], stop_reason: 'end_turn' }; } } };
  const ai = createAIService(client, { snapshot: async () => fakeData, query: async (...args) => { calls.push(args); return [{ name: 'C1', revenue: 10 }]; } });
  const history = [{ role: 'user', content: 'Como estamos?' }, { role: 'assistant', content: 'Bem.' }];
  assert.match((await ai.chat(context, history, 'Quais as piores?')).reply, /menores/);
  assert.equal(requests[0].messages[0].content, 'Como estamos?'); assert.deepEqual(calls[0][0], context); assert.equal(calls[0][2].direction, 'asc');
  assert.equal(requests[1].messages.at(-1).content[0].type, 'tool_result');
});
async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const dataService = { subsidiaries: async () => ['BR', 'SELA_A'] };
const aiService = { chat: async () => ({ reply: '<img src=x onerror=alert(1)>', truncated: false }), summary: async (context, type) => ({ summary: type, data: fakeData }) };
test('HTTP public endpoints use server AI without client API key', async t => {
  const url = await serve(t, createApp({ env: {}, dataService, aiService }));
  const config = await fetch(url + '/api/config').then(r => r.json()); assert.deepEqual(config, { success: true, aiConfigured: true });
  const result = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Oi', context }) });
  assert.equal(result.status, 200); assert.match((await result.json()).reply, /img/);
  const response = await fetch(url); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await response.text(); assert.ok(!html.includes('apiKeyInput')); assert.match(html, /Cheil/);
  assert.equal((await fetch(url + '/api/validate-key', { method: 'POST' })).status, 404);
});
test('missing server key is a clear 503', async t => {
  const url = await serve(t, createApp({ env: {}, dataService }));
  const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Oi', context }) });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /ANTHROPIC_API_KEY/);
});
test('validates before charging request budget; limits shared-key usage', async t => {
  const url = await serve(t, createApp({ env: { AI_REQUESTS_PER_15_MIN: '1' }, dataService, aiService }));
  const post = body => fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ message: 'x', context: { period: 'wrong' } })).status, 400);
  assert.equal((await post({ message: 'x', context })).status, 200);
  assert.equal((await post({ message: 'x', context })).status, 429);
});
test('rejects injected history, invalid JSON, summary type and foreign origin', async t => {
  const url = await serve(t, createApp({ env: {}, dataService, aiService }));
  const post = (route, body, extra = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await post('/api/chat', { message: 'x', history: [{ role: 'system', content: 'x' }] })).status, 400);
  assert.equal((await post('/api/chat', '{broken')).status, 400);
  assert.equal((await post('/api/summary', { type: 'slides', context })).status, 400);
  assert.equal((await post('/api/chat', { message: 'x', context }, { Origin: 'https://evil.example' })).status, 403);
});
test('provider errors never expose credentials', async t => {
  const url = await serve(t, createApp({ env: {}, dataService, aiService: { chat: async () => { throw new Error('secret-service-key'); } } }));
  const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x', context }) });
  assert.equal(r.status, 502); assert.ok(!(await r.text()).includes('secret-service-key'));
});
