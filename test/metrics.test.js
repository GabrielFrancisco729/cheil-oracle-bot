'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {calculate,metrics,rawAggregates}=require('../lib/metrics');
const {buildQuery,validateContext,createDataService}=require('../lib/data');const {createApp}=require('../server');
const fixture={delivered:1000,opens:300,clicks:60,visits_all:1100,visits_affiliate:100,units_all:210,units_affiliate:10,mail_delivered:800,mail_opens:240,mail_clicks:48,revenue_aa:100,revenue_vtex:200,revenue_app:300,revenue_web_app:400,revenue_ga4:500,revenue_affiliate:100,orders_insider:20,orders_insider_with_visits:15,orders_crm:10,orders_vtex:30,orders_affiliate:10,orders_vtex_cartapp:3};
const almost=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
test('DAX affiliate adjustments, separate conversion numerator and rate guards',()=>{
 const v=calculate(fixture,fixture,{appsflyer:5,ga4:7});
 almost(v.visits,1004.4);almost(v.units,200.44);almost(v.revenue,1404.4);almost(v.orders,62.44);almost(v.cvr,.024);almost(v.aov,1404.4/62.44);
 almost(v.open_rate,.3);almost(v.click_rate,.2);almost(v.ctr,.06);
});
test('missing auxiliary and GA4 definitions produce no approximate order metrics',()=>{
 const v=calculate(fixture);assert.equal(v.orders,null);assert.equal(v.cvr,null);assert.equal(v.aov,null);
 const q=buildQuery(validateContext({subsidiaries:['SEDA']}),{start:null});
 assert.match(q.query,/CAST\(NULL AS FLOAT64\) AS orders/);assert.match(q.query,/CAST\(NULL AS FLOAT64\) AS cvr/);assert.match(q.query,/CAST\(NULL AS FLOAT64\) AS aov/);
 assert.throws(()=>buildQuery({subsidiaries:['LAO']},{start:null},{orderMetric:'cvr'}),/depende/);
});
test('OR and CTOR return zero for equal or inverted numerator/denominator',()=>{
 let v=calculate({...fixture,mail_delivered:240,mail_opens:240,mail_clicks:240});assert.equal(v.open_rate,0);assert.equal(v.click_rate,0);
 v=calculate({...fixture,mail_delivered:0,mail_opens:2,mail_clicks:3,delivered:0});assert.equal(v.open_rate,0);assert.equal(v.click_rate,0);assert.equal(v.ctr,null);
});
test('product context repeats ignored metrics and keeps product-specific delivery denominator',()=>{
 const perProduct={...fixture,delivered:100,mail_delivered:120,opens:20,clicks:4,visits_all:40,visits_affiliate:0};
 const v=calculate(perProduct,fixture);assert.equal(v.opens,300);assert.equal(v.clicks,60);almost(v.visits,1004.4);assert.equal(v.open_rate,0);almost(v.click_rate,.2);almost(v.ctr,.6);
 const q=buildQuery({subsidiaries:['LAO']},{start:null},{groupBy:'product'});assert.match(q.query,/CROSS JOIN no_product_filter/);assert.match(q.query,/np.opens AS opens/);assert.match(q.query,/g.delivered AS delivered/);
});
test('revenue selects one currency column in every source branch and does not round',()=>{
 const standard=rawAggregates(false,'fc.CHANNEL'),local=rawAggregates(true);
 assert.match(standard,/fc.CHANNEL = 'WEB PUSH' AND fc.Source = 'APP'/);assert.match(standard,/SUBSTR\(fc.Source, 1, 9\) = 'GA4_SEASA'/);assert.ok(!standard.includes("LIKE 'GA4%'"));
 assert.match(local,/fc.Source = 'ANALYTICS', fc.`Revenue_SEDA`/);assert.match(local,/DATA_SOURCE = 'AFFILIATE', fc.`Revenue_SEDA`/);assert.match(local,/GA4_SEASA', fc.`Revenue_SEDA`/);assert.ok(!standard.includes('ROUND('));
 assert.equal(validateContext({subsidiaries:['SELA'],currency:'BRL'}).currency,'USD');assert.equal(validateContext({subsidiaries:['SEDA'],currency:'standard'}).currency,'BRL');
 assert.ok(!standard.includes('CHANNEL / TRIGGER'));assert.ok(!standard.includes('Total_orders'));
});
test('automatic subsidiary currency cannot be overridden by old clients',()=>{
 const seda=buildQuery({subsidiaries:['SEDA'],currency:'USD'},{start:null});assert.match(seda.query,/fc.`Revenue_SEDA`/);assert.ok(!seda.query.includes('fc.`Revenue`'));
 for(const subsidiaries of [['LAO'],['SELA'],['SEM'],['SEDA','SEM']]){const q=buildQuery({subsidiaries,currency:'BRL'},{start:null});assert.match(q.query,/fc.`Revenue`/);assert.ok(!q.query.includes('Revenue_SEDA'));}
});
test('missing fact CHANNEL and unused order fields do not prevent summaries',async()=>{
 let reads=0;const queries=[];
 const service=createDataService({dataset:()=>({table:()=>({getMetadata:async()=>{reads++;return[{schema:{fields:[{name:'Revenue',type:'FLOAT'},{name:'CHANNEL / TRIGGER',type:'STRING'}]}}];}})}),query:async q=>{queries.push(q);assert.ok(!q.query.includes('fc.CHANNEL'));assert.ok(!q.query.includes('CHANNEL / TRIGGER'));return [[{row_count:4,revenue:100}]];}});
 const snapshot=await service.snapshot({subsidiaries:['SEDA']});assert.equal(snapshot.hasData,true);assert.equal(snapshot.quality.channel.source,'dAllDimensions.CHANNEL');assert.equal(reads,1);assert.equal(queries.length,5);
});
test('available fact CHANNEL is preserved instead of replacing the DAX source',async()=>{
 const service=createDataService({dataset:()=>({table:()=>({getMetadata:async()=>[{schema:{fields:[{name:'channel',type:'STRING'}]}}]})}),query:async q=>{assert.match(q.query,/fc.CHANNEL IN/);return [[{row_count:1}]];}});
 const snapshot=await service.snapshot({subsidiaries:['LAO']});assert.equal(snapshot.quality.channel.source,'fConsolidated.CHANNEL');
});
test('dimensions come from live dAllDimensions schema, excluding repeated and record fields',async()=>{
 let metadataCalls=0;const bq={dataset: name=>{assert.equal(name,'apollo_gold');return{table:name=>{assert.equal(name,'dAllDimensions');return{getMetadata:async()=>{metadataCalls++;return[{schema:{fields:[{name:'SUB',type:'STRING'},{name:'TRIGGER CATEGORY',type:'STRING'},{name:'CHANNEL / TRIGGER',type:'STRING'},{name:'REPEATED',type:'STRING',mode:'REPEATED'},{name:'NESTED',type:'RECORD'}]}}];}};}};}};
 const service=createDataService(bq);const dims=await service.dimensions();await service.dimensions();assert.equal(metadataCalls,1);assert.deepEqual(dims.map(d=>d.id),['SUB','TRIGGER CATEGORY','CHANNEL / TRIGGER']);
});
async function serve(t,app){const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return`http://127.0.0.1:${server.address().port}`;}
test('catalog returns all discovered dimensions and shared metric definitions without needing AI',async t=>{
 const url=await serve(t,createApp({env:{},dataService:{dimensions:async()=>[{id:'SUB',label:'SUB',type:'STRING'},{id:'CAMPAIGN CATEGORY',label:'CAMPAIGN CATEGORY',type:'STRING'}]}}));
 const c=await fetch(url+'/api/report-catalog').then(r=>r.json());assert.equal(c.source,'bigquery');assert.equal(c.dimensions.length,2);assert.equal(c.metrics.length,12);assert.equal(c.metrics.find(m=>m.id==='orders').status,'pending');
 const defs=await fetch(url+'/api/metric-contract').then(r=>r.json());assert.deepEqual(defs.metrics,metrics);
});
test('catalog fallback is explicitly labelled as an example list',async t=>{
 const url=await serve(t,createApp({env:{},dataService:{dimensions:async()=>{throw new Error('test');}}}));const c=await fetch(url+'/api/report-catalog').then(r=>r.json());assert.equal(c.source,'reference');assert.match(c.notice,/exemplo/);
});
test('two original PowerPoint files are downloadable without Claude key',async t=>{
 const url=await serve(t,createApp({env:{},dataService:{}}));
 for(const type of ['monthly','quarterly']){const r=await fetch(url+'/api/templates/'+type,{headers:{Range:'bytes=0-15'}});assert.equal(r.status,206);assert.match(r.headers.get('content-disposition'),/attachment.*pptx/);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');}
 assert.equal((await fetch(url+'/api/templates/unknown')).status,404);
});
