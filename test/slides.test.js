'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), JSZip = require('jszip'), PptxGenJS = require('pptxgenjs'), sharp = require('sharp');
const { createSlideService, inspectPptx, validateUpload } = require('../lib/slides');
const { createAIService } = require('../lib/ai');
const { createApp } = require('../server');
const context = { subsidiaries: ['SEDA'], period: 'current_month' };
async function fixture() {
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; const slide = pptx.addSlide();
  slide.addText('Modelo Samsung', { x: .5, y: .3, w: 8, h: .5, fontSize: 30 });
  slide.addText('Revenue', { x: .5, y: 1, w: 4, h: .3 });
  slide.addText('{{Revenue}}', { x: .5, y: 1.5, w: 5, h: .7, fontSize: 32 });
  slide.addText([{ text: 'R$ ' }, { text: '10,2M' }], { x: .5, y: 2.5, w: 4, h: .6, fontSize: 28 });
  slide.addText([{ text: '12,3' }, { text: '%' }], { x: 6, y: 1.5, w: 3, h: .6, fontSize: 28 });
  slide.addText('Em 2026 a receita chegou a R$ 7.8M.', { x: .5, y: 4, w: 10, h: .6 });
  slide.addText('2026', { x: 10, y: .3, w: 2, h: .5 });
  slide.addText('Galaxy S26', { x: 6, y: 2.5, w: 4, h: .5 });
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}
function clientForPptx(requests = []) { return { messages: { create: async body => {
  requests.push(body); const slides = JSON.parse(body.messages[0].content[0].text.split('\n').slice(1).join('\n'));
  const replacements = slides.flatMap(s => s.text.filter(f => f.eligible).map(f => ({ id: f.id, metric: /%/.test(f.text) ? 'click_rate' : 'revenue' })));
  return { content: [{ type: 'tool_use', name: 'identify_slide_fields', input: { summary: 'Modelo com receita e engajamento.', replacements, imageFields: [] } }] };
} } }; }
const imageFields = [{ metric: 'delivered', x: 150, y: 740, w: 72, h: 25, background: 'FFFFFF', color: '222222' }, { metric: 'open_rate', x: 235, y: 740, w: 60, h: 25, background: 'FFFFFF', color: '222222' }];
test('chat returns a clarification and continues from the chosen option without asking in summaries', async () => {
  const requests = [], fakeData = { hasData: true, context, period: {}, totals: { revenue: 10 } };
  const ai = createAIService({ messages: { create: async body => { requests.push(body); return requests.length === 1 ? { content: [{ type: 'tool_use', name: 'request_clarification', input: { question: 'Qual resultado você quer melhorar?', options: ['Receita e conversão', 'Engajamento dos emails'] } }] } : { content: [{ type: 'text', text: 'Vamos priorizar receita.' }] }; } } }, { snapshot: async () => fakeData, query: () => { throw new Error('Clarification should not run additional queries'); } });
  const first = await ai.chat(context, [], 'Quero melhorar os resultados'); assert.equal(first.clarification.options.length, 2); assert.match(first.reply, /Qual resultado/);
  const history = [{ role: 'user', content: 'Quero melhorar os resultados' }, { role: 'assistant', content: first.reply }];
  const second = await ai.chat(context, history, 'Receita e conversão'); assert.match(second.reply, /priorizar receita/); assert.equal(requests[1].messages[0].content, history[0].content);
  await ai.summary(context, 'executive'); assert.ok(!requests[2].tools); assert.ok(!requests[2].system.includes('No chat, esclareça'));
});
test('PPTX inspection treats split runs as one value and protects dates and narrative text', async () => {
  const inspected = await inspectPptx(await fixture()); assert.equal(inspected.slides.length, 1); assert.deepEqual(inspected.fields.map(f => f.original), ['{{Revenue}}', 'R$ 10,2M', '12,3%']);
  assert.ok(!inspected.fields.some(f => f.original.includes('2026')));
});
test('fills PPTX values, keeps the original structure and stamps fictitious numbers', async () => {
  const input = await fixture(), requests = [], result = await createSlideService(clientForPptx(requests)).fill({ originalname: 'modelo.pptx', buffer: input }, context);
  assert.equal(result.slideCount, 1); assert.equal(result.currency, 'BRL'); assert.equal(result.changes.length, 3); assert.equal(result.demo, true);
  const before = await JSZip.loadAsync(input), after = await JSZip.loadAsync(result.buffer), xml = await after.file('ppt/slides/slide1.xml').async('string');
  assert.match(xml, /R\$\s644\.500,00/); assert.match(xml, /R\$ 0,64M/); assert.ok(!xml.includes('%%')); assert.match(xml, /números fictícios/); assert.match(xml, /Galaxy S26/); assert.match(xml, /Em 2026 a receita chegou a R\$ 7.8M/);
  for (const name of Object.keys(before.files).filter(n => !/^ppt\/slides\/slide\d+\.xml$/.test(n) && !before.files[n].dir)) assert.deepEqual(await after.file(name).async('nodebuffer'), await before.file(name).async('nodebuffer'), name);
  assert.equal(requests[0].tools[0].name, 'identify_slide_fields'); assert.equal(requests[0].tool_choice.type, 'tool');
});
test('image uses Claude vision and creates a PPTX with editable values over the reference', async () => {
  const input = fs.readFileSync(path.resolve(__dirname, 'fixtures/slide-reference.png')); let request;
  const client = { messages: { create: async body => { request = body; return { content: [{ type: 'tool_use', name: 'identify_slide_fields', input: { summary: 'Comparação Best x Worst.', replacements: [], imageFields } }] }; } } };
  const result = await createSlideService(client).fill({ originalname: 'modelo.png', buffer: input }, { subsidiaries: ['LAO'], period: 'current_month' });
  assert.equal(result.sourceType, 'image'); assert.equal(result.currency, 'USD'); assert.equal(result.slideCount, 1); assert.equal(result.changes.length, 2); assert.ok(result.preview.dataUrl.startsWith('data:image/jpeg;base64,'));
  const source = request.messages[0].content[0]; assert.equal(source.type, 'image'); assert.equal(source.source.media_type, 'image/jpeg'); const metadata = await sharp(Buffer.from(source.source.data, 'base64')).metadata(); assert.ok(metadata.width <= 1568 && metadata.height <= 1568);
  const output = await JSZip.loadAsync(result.buffer), xml = await output.file('ppt/slides/slide1.xml').async('string'); assert.match(xml, /634\.000/); assert.match(xml, /números fictícios/); assert.ok(Object.keys(output.files).some(n => /^ppt\/media\/image/.test(n)));
});
test('rejects unsupported or corrupted uploads and refuses fabricated field identifiers', async () => {
  assert.throws(() => validateUpload({ originalname: 'old.ppt', buffer: Buffer.from('data') }), /como .pptx/);
  await assert.rejects(() => inspectPptx(Buffer.from('not a zip')), /corrompido/);
  const service = createSlideService({ messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'identify_slide_fields', input: { summary: 'test', replacements: [{ id: 'nonexistent-id', metric: 'revenue' }], imageFields: [] } }] }) } });
  await assert.rejects(async () => service.fill({ originalname: 'test.pptx', buffer: await fixture() }, context), e => e.status === 422);
});
async function serve(t, options) { const app = createApp(options), server = app.listen(0, '127.0.0.1'); await new Promise(r => server.on('listening', r)); t.after(async () => { await app.locals.slideDownloads.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); }); return `http://127.0.0.1:${server.address().port}`; }
function form(buffer, filename) { const body = new FormData(); body.append('template', new Blob([buffer]), filename); body.append('context', JSON.stringify(context)); return body; }
test('upload route uses the server AI and returns a downloadable PPTX without base64 file payload', async t => {
  const url = await serve(t, { env: {}, dataService: {}, slideService: createSlideService(clientForPptx()) }), input = await fixture();
  const response = await fetch(url + '/api/slides/fill', { method: 'POST', body: form(input, 'test.pptx') }); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.context.currency, 'BRL'); assert.ok(!result.buffer);
  const downloaded = await fetch(url + result.downloadUrl); assert.equal(downloaded.status, 200); assert.match(downloaded.headers.get('content-disposition'), /DEMO-BRL.pptx/); assert.match(downloaded.headers.get('cache-control'), /no-store/); assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.equal((await fetch(url + '/api/slides/download/' + '0'.repeat(64))).status, 404);
});
test('invalid legacy upload does not consume request budget and origins are checked', async t => {
  const url = await serve(t, { env: { AI_REQUESTS_PER_15_MIN: '1' }, dataService: {}, slideService: createSlideService(clientForPptx()) }), input = await fixture();
  assert.equal((await fetch(url + '/api/slides/fill', { method: 'POST', body: form(input, 'old.ppt') })).status, 400);
  assert.equal((await fetch(url + '/api/slides/fill', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: form(input, 'test.pptx') })).status, 403);
  assert.equal((await fetch(url + '/api/slides/fill', { method: 'POST', body: form(input, 'test.pptx') })).status, 200);
  assert.equal((await fetch(url + '/api/slides/fill', { method: 'POST', body: form(input, 'test.pptx') })).status, 429);
});
test('original monthly and quarter templates remain readable for AI filling', async () => {
  for (const [name, count] of [['SEDA-Report-Mensal-Agosto-2026.pptx', 25], ['SEDA-Report-Quarter-Q2-2026.pptx', 36]]) { const template = await inspectPptx(fs.readFileSync(path.resolve(__dirname, '../public/downloads', name))); assert.equal(template.slides.length, count); assert.ok(template.fields.length > 30); }
});
