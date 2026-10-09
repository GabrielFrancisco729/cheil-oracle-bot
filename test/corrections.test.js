'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {build}=require('../public/report-demo');
const {metrics}=require('../public/metric-contract');
const {createApp}=require('../server');
const {createAIService}=require('../lib/ai');
const {describeError,safeLogMessage}=require('../lib/errors');
const now=new Date('2026-10-09T21:00:00Z');
test('demo report contains grouped data for every selectable metric, including conversion examples',()=>{
 const fields=[{id:'SUB',type:'STRING'},{id:'CAMPAIGN',type:'STRING'}],preview=build({subsidiaries:['LAO'],period:'current_month'},fields,now);
 assert.equal(preview.currency,'USD');assert.equal(preview.rows.length,6);
 assert.deepEqual(preview.rows[0].dimensions,['SEM','Galaxy · Lançamento']);
 assert.equal(preview.rows[0].metrics.revenue,21100);assert.equal(preview.rows[0].metrics.open_rate,.35);assert.equal(preview.rows[0].metrics.click_rate,.15);assert.equal(preview.rows[0].metrics.cvr,.035);
 for(const row of preview.rows)for(const metric of metrics)assert.ok(Number.isFinite(row.metrics[metric.id]),metric.id);
});
test('SEDA preview aggregates its single SUB in BRL and recomputes rates from totals',()=>{
 const preview=build({subsidiaries:['SEDA'],period:'current_month'},[{id:'SUB',type:'STRING'}],now);
 assert.equal(preview.currency,'BRL');assert.equal(preview.rows.length,1);assert.deepEqual(preview.rows[0].dimensions,['SEDA']);
 const totals=preview.rows[0].metrics;assert.equal(totals.revenue,644500);assert.equal(totals.delivered,634000);assert.equal(totals.orders,803);
 assert.ok(Math.abs(totals.open_rate-202200/582000)<1e-12);
 assert.ok(Math.abs(totals.cvr-803/20200)<1e-12);
});
test('demo values follow the selected period and date dimensions stay within it',()=>{
 const context={subsidiaries:['SEM'],period:'last_month'},fields=[{id:'Date',type:'DATE'}];
 const previous=build(context,fields,now),current=build({...context,period:'current_month'},fields,now);
 assert.ok(previous.rows.every(r=>r.dimensions[0].startsWith('2026-09-')));
 assert.ok(current.rows.every(r=>r.dimensions[0]>='2026-10-01'&&r.dimensions[0]<='2026-10-09'));
 assert.ok(previous.rows[0].metrics.revenue>current.rows[0].metrics.revenue);
});
test('backend errors distinguish schema, BigQuery access, Claude key and Claude model',()=>{
 const cases=[[{service:'bigquery',code:400,message:'Name CHANNEL not found inside fc'},'BIGQUERY_SCHEMA'],[{service:'bigquery',code:403,message:'Access Denied'},'BIGQUERY_ACCESS'],[{service:'claude',status:401},'CLAUDE_AUTH'],[{service:'claude',status:404},'CLAUDE_MODEL']];
 for(const [error,expected]of cases)assert.equal(describeError(error).errorCode,expected);
 assert.equal(safeLogMessage({message:'failed using secret-service-key sk-ant-secret Bearer token-value'},{ANTHROPIC_API_KEY:'secret-service-key'}),'failed using [REDACTED] [REDACTED] Bearer [REDACTED]');
});
test('Claude failures carry a service tag for the HTTP diagnostic',async()=>{
 const ai=createAIService({messages:{create:async()=>{throw Object.assign(new Error('model missing'),{status:404});}}},{snapshot:async()=>({hasData:true})});
 await assert.rejects(()=>ai.summary({},'managerial'),e=>e.service==='claude'&&e.status===404);
});
test('summary errors return a log reference without exposing provider details',async t=>{
 const service={summary:async()=>{throw Object.assign(new Error('Name CHANNEL not found inside fc; sk-ant-secret'),{service:'bigquery',code:400});}};
 const server=createApp({env:{},dataService:{},aiService:service}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/summary`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'managerial',context:{subsidiaries:['LAO']}})});
 assert.equal(response.status,502);const data=await response.json();assert.equal(data.errorCode,'BIGQUERY_SCHEMA');assert.match(data.requestId,/^[a-f0-9-]{36}$/);assert.ok(!JSON.stringify(data).includes('sk-ant-secret'));assert.ok(!data.error.includes('inside fc'));
});
