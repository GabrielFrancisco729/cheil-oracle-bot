'use strict';
const {resolvePeriod}=require('./periods');
const {rawAggregates,metricSelect,metricQuality,metrics,currencyFor}=require('./metrics');
const metricIds=metrics.map(m=>m.id);
const GROUPS={overall:null,campaign:"COALESCE(fc._dim.CAMPAIGN, 'N/A')",product:"COALESCE(fc._productName, 'N/A')",channel:"COALESCE(fc._dim.CHANNEL, 'N/A')",subsidiary:"COALESCE(fc._dim.SUB, 'N/A')",day:'CAST(DATE(fc.Date) AS STRING)'};
function validateContext(context={}){
 if(!context||typeof context!=='object'||Array.isArray(context))throw Object.assign(new Error('Contexto inválido.'),{status:400});
 const subsidiaries=context.subsidiaries??['LAO'];
 if(!Array.isArray(subsidiaries)||!subsidiaries.length||subsidiaries.length>30||subsidiaries.some(s=>typeof s!=='string'||!s.trim()||s.length>80))throw Object.assign(new Error('Subsidiária inválida.'),{status:400});
 const period=context.period??'current_month';resolvePeriod(period);
 const normalized=[...new Set(subsidiaries.map(s=>s.trim()))].sort();
 // Currency is derived from SUB. Legacy clients may still send a currency selection.
 const currency=currencyFor(normalized);
 return {subsidiaries:normalized,period,currency};
}
function identifiers(config={}){
 const project=config.projectId||'cheil-bi',dataset=config.dataset||'apollo_gold';
 if(!/^[a-zA-Z0-9_-]+$/.test(project)||!/^[a-zA-Z0-9_]+$/.test(dataset))throw new Error('Configuração BigQuery inválida.');
 return {project,dataset,table:name=>`\`${project}.${dataset}.${name}\``};
}
function buildQuery(context,range,options={},config={}){
 context=validateContext(context);
 const group=options.groupBy??'overall',metric=options.orderMetric??'revenue',direction=options.direction??'desc',limit=options.limit??5;
 if(!Object.hasOwn(GROUPS,group)||!metricIds.includes(metric)||!['asc','desc'].includes(direction)||!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(new Error('Consulta de análise inválida.'),{status:400});
 if(['orders','cvr','aov'].includes(metric))throw Object.assign(new Error('Esta métrica depende de definições DAX ainda não fornecidas.'),{status:400});
 const {table}=identifiers(config),params={},types={},filters=[];
 if(range.start){filters.push('DATE(fc.Date) >= DATE(@startDate) AND DATE(fc.Date) < DATE(@endDate)');params.startDate=range.start;params.endDate=range.endExclusive;types.startDate='STRING';types.endDate='STRING';}
 if(!context.subsidiaries.includes('LAO')){filters.push("(d.SUB IN UNNEST(@subsidiaries) OR (@includeSela AND STARTS_WITH(UPPER(d.SUB), 'SELA')))");params.subsidiaries=context.subsidiaries;params.includeSela=context.subsidiaries.includes('SELA');types.subsidiaries=['STRING'];types.includeSela='BOOL';}
 const expression=GROUPS[group];
 const product=group==='product';
 const query=`WITH dimension_rows AS (
 SELECT TrackingCode, ARRAY_AGG(STRUCT(d.SUB AS SUB, d.CHANNEL AS CHANNEL, d.CAMPAIGN AS CAMPAIGN) ORDER BY TO_JSON_STRING(STRUCT(d.SUB, d.CHANNEL, d.CAMPAIGN)) LIMIT 1)[OFFSET(0)] AS v FROM ${table('dAllDimensions')} d GROUP BY TrackingCode
 ), dimensions AS (SELECT TrackingCode, v.* FROM dimension_rows), scoped AS (
 SELECT fc.*, d AS _dim${product?', dp.PRODUCT AS _productName':''}
 FROM ${table('fConsolidated')} fc LEFT JOIN dimensions d ON fc.Tracking_code = d.TrackingCode
 ${product?`LEFT JOIN (SELECT SKU, MIN(PRODUCT) AS PRODUCT FROM ${table('dProducts')} GROUP BY SKU) dp ON fc.Product = dp.SKU`:''}
 ${filters.length?`WHERE ${filters.join(' AND ')}`:''}
 ), grouped AS (
 SELECT ${expression?`${expression} AS name,`:''}${rawAggregates(context.currency==='BRL',config.factChannel)} FROM scoped fc ${expression?'GROUP BY name':''}
 )${product?`, no_product_filter AS (SELECT ${rawAggregates(context.currency==='BRL',config.factChannel)} FROM scoped fc)`:''}
 SELECT ${expression?'g.name,':''}${metricSelect('g',product?'np':'g')} FROM grouped g ${product?'CROSS JOIN no_product_filter np':''}
 ${expression?`ORDER BY ${metric} ${direction.toUpperCase()}, name ASC LIMIT ${limit}`:''}`;
 return {query,params,types,useLegacySql:false,location:config.location||'US',maximumBytesBilled:String(config.maximumBytesBilled||'10000000000'),jobTimeoutMs:60000};
}
function cleanRow(row){const result={};for(const [key,raw]of Object.entries(row))result[key]=raw&&typeof raw==='object'&&'value'in raw?raw.value:raw;return result;}
function createDataService(bigquery,config={}){
 const cache=new Map();let dimensionCache,channelCache;
 async function channelMapping(){
  if(channelCache&&channelCache.expires>Date.now())return channelCache.promise;
  const promise=(async()=>{
   try{
    const {dataset}=identifiers(config);const [metadata]=await bigquery.dataset(dataset).table('fConsolidated').getMetadata();
    if(metadata.schema?.fields?.some(f=>f.name.toUpperCase()==='CHANNEL'&&f.type==='STRING'&&f.mode!=='REPEATED'))return {expression:'fc.CHANNEL',source:'fConsolidated.CHANNEL',basis:'fact_schema'};
    return {expression:'fc._dim.CHANNEL',source:'dAllDimensions.CHANNEL',basis:'fact_channel_absent'};
   }catch(_){return {expression:'fc._dim.CHANNEL',source:'dAllDimensions.CHANNEL',basis:'fact_schema_unavailable'};}
  })();
  channelCache={promise,expires:Date.now()+3600000};return promise;
 }
 async function query(context,range,options){
  try{const mapping=await channelMapping();const [rows]=await bigquery.query(buildQuery(context,range,options,{...config,factChannel:mapping.expression}));return rows.map(cleanRow);}
  catch(error){error.service='bigquery';error.operation='performance_query';throw error;}
 }
 async function snapshot(rawContext){
  const context=validateContext(rawContext),period=resolvePeriod(context.period,new Date(),config.timezone||'America/Sao_Paulo'),key=JSON.stringify({context,period});
  if(cache.has(key)&&cache.get(key).expires>Date.now())return cache.get(key).promise;
  const promise=(async()=>{
   const [totals,campaigns,products,channels,previous]=await Promise.all([query(context,period),query(context,period,{groupBy:'campaign'}),query(context,period,{groupBy:'product'}),query(context,period,{groupBy:'channel',limit:100}),period.comparison?query(context,period.comparison):[]]);
   const current=totals[0]||{},prior=previous[0]||null,changes={};
   if(prior&&Number(prior.row_count)>0)for(const field of metricIds){const a=current[field],b=prior[field];changes[field]=a==null||b==null||Number(b)===0?null:(Number(a)-Number(b))/Math.abs(Number(b));}
   const mapping=await channelMapping();
   return {context,period,totals:current,previous:prior,changes,campaigns,products,channels,hasData:Number(current.row_count)>0,quality:{...metricQuality(),channel:{source:mapping.source,basis:mapping.basis}},definitions:{open_rate:'OR% do DOCX: EMAIL/WHATSAPP, deliveries > opens; caso contrário 0.',click_rate:'CTOR% do DOCX: EMAIL/WHATSAPP, opens > clicks; caso contrário 0.',ctr:'CTR2 efetivamente retornado no DAX: tClicks / tDeliveries.',visits:'Ajuste affiliate de 4,4%, com REMOVEFILTERS(dProducts).',cvr:'Pendente: tOrdersCRM_withVisits inclui dependências ausentes no DOCX.',aov:'Pendente: tOrdersCRM inclui dependências ausentes no DOCX.',currency:context.currency==='BRL'?'BRL (reais): todas as parcelas da receita usam Revenue_SEDA no recorte exclusivo SEDA.':'USD (dólares): todas as parcelas da receita usam Revenue. Inclui recortes LAO/SELA e demais subsidiárias.',rankings:'Campanhas/produtos: top 5 por receita. Não são listas completas.',revenue:'Composição do DOCX, com seleção automática da coluna de moeda confirmada pelo responsável do modelo. WEB PUSH apenas Source APP e GA4 apenas prefixo GA4_SEASA.',channel:`OR/CTOR e WEB PUSH usam ${mapping.source}. Quando CHANNEL não existe na fato, usa a dimensão ligada por TrackingCode; conciliar esse mapeamento com o Power BI.`,product:'Opens, clicks e visits removem filtro de dProducts. Em agrupamentos por produto são repetidos para reproduzir o DAX e não podem ser somados entre produtos.',dimension:'Uma linha determinística por TrackingCode/SKU; validar desempate e relações contra o Power BI.'}};
  })();
  if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(key,{expires:Date.now()+300000,promise});
  try{return await promise;}catch(error){cache.delete(key);throw error;}
 }
 async function subsidiaries(){const {project,dataset}=identifiers(config);const [rows]=await bigquery.query({query:`SELECT DISTINCT SUB FROM \`${project}.${dataset}.dAllDimensions\` WHERE SUB IS NOT NULL AND TRIM(SUB) NOT IN ('','-') ORDER BY SUB`,location:config.location||'US',maximumBytesBilled:String(config.maximumBytesBilled||'10000000000'),jobTimeoutMs:60000});return rows.map(row=>row.SUB);}
 async function dimensions(){
  if(dimensionCache&&dimensionCache.expires>Date.now())return dimensionCache.fields;
  const {dataset}=identifiers(config);const [metadata]=await bigquery.dataset(dataset).table('dAllDimensions').getMetadata();
  const fields=(metadata.schema?.fields||[]).filter(f=>f.mode!=='REPEATED'&&['STRING','INTEGER','INT64','FLOAT','FLOAT64','NUMERIC','BIGNUMERIC','BOOLEAN','BOOL','DATE','DATETIME','TIMESTAMP'].includes(f.type)&&!/[`\r\n]/.test(f.name)).map(f=>({id:f.name,label:f.name,type:f.type}));
  if(!fields.length)throw new Error('dAllDimensions não possui dimensões disponíveis.');dimensionCache={fields,expires:Date.now()+3600000};return fields;
 }
 return {query,snapshot,subsidiaries,dimensions};
}
module.exports={validateContext,buildQuery,createDataService,cleanRow};
