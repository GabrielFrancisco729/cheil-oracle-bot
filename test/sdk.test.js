'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BigQuery } = require('@google-cloud/bigquery');
const { Anthropic } = require('@anthropic-ai/sdk');
const { buildQuery } = require('../lib/data');
const { resolvePeriod } = require('../lib/periods');
const { createAIService } = require('../lib/ai');
const context = { subsidiaries: ['SELA'], period: 'current_month' };
const period = resolvePeriod('current_month', new Date('2026-10-08T18:00:00Z'));

test('installed BigQuery SDK serializes actual dates, arrays and booleans', () => {
  const bq = new BigQuery({ projectId: 'cheil-bi' });
  const q = buildQuery(context, period);
  const wire = bq.buildQueryParams_(q.params, q.types).params;
  assert.equal(wire.find(p => p.name === 'startDate').parameterValue.value, '2026-10-01');
  assert.equal(wire.find(p => p.name === 'endDate').parameterValue.value, '2026-10-09');
  assert.deepEqual(wire.find(p => p.name === 'subsidiaries').parameterValue.arrayValues, [{ value: 'SELA' }]);
  assert.equal(wire.find(p => p.name === 'includeSela').parameterValue.value, true);
});
test('installed Anthropic SDK sends server key and correct Messages payload', async t => {
  const http = require('node:http');
  let request;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      request = { path: req.url, key: req.headers['x-api-key'], body: JSON.parse(raw) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'Resposta SDK.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = new Anthropic({ apiKey: 'test-key-not-a-secret', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
  const ai = createAIService(client, { snapshot: async () => ({ context, period, hasData: true, totals: { revenue: 100 } }) });
  assert.equal((await ai.summary(context, 'managerial')).summary, 'Resposta SDK.');
  assert.equal(request.path, '/v1/messages'); assert.equal(request.key, 'test-key-not-a-secret');
  assert.equal(request.body.model, 'claude-haiku-4-5-20251001'); assert.equal(request.body.messages[0].role, 'user');
});
