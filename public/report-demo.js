(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./metric-contract'));else root.OracleReportDemo=factory(root.OracleMetrics);})(typeof globalThis!=='undefined'?globalThis:this,function(contract){
'use strict';
const examples=[
 {sub:'SEM',channel:'EMAIL',campaign:'Galaxy · Lançamento',product:'Galaxy S26',category:'GTM',trigger:'LAUNCH',phase:'Launch',delivered:180000,opens:63000,clicks:9450,visits:5200,orders:182,revenueUSD:21100,revenueBRL:128000},
 {sub:'SAM',channel:'EMAIL',campaign:'Fold7 · Pré-venda',product:'Galaxy Z Fold7',category:'GTM',trigger:'PRE ORDER',phase:'Pre order',delivered:140000,opens:47600,clicks:8092,visits:4800,orders:216,revenueUSD:35800,revenueBRL:198000},
 {sub:'SECH',channel:'APP PUSH',campaign:'Galaxy · Benefícios no app',product:'Galaxy Buds',category:'GTM',trigger:'PROMOTION',phase:'Sustain',delivered:52000,opens:18200,clicks:3240,visits:2400,orders:72,revenueUSD:9600,revenueBRL:54800},
 {sub:'SECO',channel:'WHATSAPP',campaign:'Galaxy · Oferta exclusiva',product:'Galaxy Watch',category:'GTM',trigger:'PROMOTION',phase:'Sustain',delivered:38000,opens:22800,clicks:4560,visits:1800,orders:90,revenueUSD:12400,revenueBRL:71000},
 {sub:'SEPR',channel:'EMAIL',campaign:'Cyber Wow · Multicategoria',product:'Galaxy S26',category:'GTM',trigger:'PROMOTION',phase:'Sustain',delivered:160000,opens:43200,clicks:6480,visits:3900,orders:117,revenueUSD:15400,revenueBRL:86200},
 {sub:'SEDA',channel:'EMAIL',campaign:'Carrinho · Recuperação',product:'Galaxy Z Fold7',category:'TRIGGER',trigger:'ABANDONED CART',phase:'Always on',delivered:64000,opens:25600,clicks:6400,visits:2100,orders:126,revenueUSD:18900,revenueBRL:106500},
];
const canonical=id=>id.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'');
function exampleDate(period,index,now){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(now).map(p=>[p.type,p.value]));
 const today=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day))),start=new Date(today),end=new Date(today);end.setUTCDate(end.getUTCDate()+1);
 if(period==='last_month'){start.setUTCDate(1);end.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()-1);}
 else if(period==='quarter_current'||period==='quarter_last'){start.setUTCDate(1);start.setUTCMonth(Math.floor(start.getUTCMonth()/3)*3);if(period==='quarter_last'){end.setTime(start.getTime());start.setUTCMonth(start.getUTCMonth()-3);}}
 else if(period==='current_week'||period==='last_week'){start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);if(period==='last_week'){end.setTime(start.getTime());start.setUTCDate(start.getUTCDate()-7);}}
 else if(period==='all_time'){start.setUTCMonth(start.getUTCMonth()-6);start.setUTCDate(1);}
 else start.setUTCDate(1);
 const days=Math.max(1,Math.round((end-start)/86400000));start.setUTCDate(start.getUTCDate()+Math.floor(index*days/examples.length));return start.toISOString().slice(0,10);
}
function dimensionValue(field,item,index,context,now){
 const key=canonical(field.id),sub=context.subsidiaries[0],aggregate=sub==='LAO'||sub==='SELA';
 const country=aggregate?item.sub:sub;
 const values={SUB:country,SUBSIDIARY:country,SUBSIDIARIA:country,CHANNEL:item.channel,CAMPAIGN:item.campaign,TRACKINGCODE:`EXEMPLO_${country}_${index+1}_galaxy`,TRACKING_CODE:`EXEMPLO_${country}_${index+1}_galaxy`,CAMPAIGN_CATEGORY:item.category,CHANNEL_TRIGGER:item.channel,TRIGGER:item.trigger,PHASE:item.phase,BU_CAMPAIGN:'MX',PRODUCT:item.product,PRODUCT_FAMILY:item.product,SKU:`EXEMPLO_SKU_${index+1}`,TAXONOMY:`EXEMPLO_${item.category}_${item.trigger}`,COUNTRY:country};
 if(Object.hasOwn(values,key))return values[key];
 if(['DATE','DATETIME','TIMESTAMP'].includes(field.type)||key==='DATE')return exampleDate(context.period,index,now)+(field.type==='TIMESTAMP'?'T12:00:00Z':field.type==='DATETIME'?' 12:00:00':'');
 if(['INTEGER','INT64','FLOAT','FLOAT64','NUMERIC','BIGNUMERIC'].includes(field.type))return index%3+1;
 if(['BOOLEAN','BOOL'].includes(field.type))return index%2===0;
 return `${field.label} · Exemplo ${index%3+1}`;
}
function build(context,dimensions,now=new Date()){
 const currency=contract.currencyFor(context.subsidiaries),factor={current_week:.24,last_week:.28,current_month:1,last_month:1.15,quarter_current:1.8,quarter_last:3.2,all_time:8}[context.period]||1,groups=new Map();
 examples.forEach((item,index)=>{
  const values=dimensions.map(field=>dimensionValue(field,item,index,context,now)),key=JSON.stringify(values);
  const counts=['delivered','opens','clicks','visits','orders'].map(field=>Math.round(item[field]*factor)),revenue=Math.round(item[currency==='BRL'?'revenueBRL':'revenueUSD']*factor*100)/100;
  const components=contract.componentsForEmail(...counts,revenue);
  if(!['EMAIL','WHATSAPP'].includes(item.channel))components.mail_delivered=components.mail_opens=components.mail_clicks=0;
  if(!groups.has(key))groups.set(key,{dimensions:values,components:Object.fromEntries(Object.keys(components).map(k=>[k,0]))});
  const group=groups.get(key);for(const [field,value]of Object.entries(components))group.components[field]+=value;
 });
 return {currency,rows:[...groups.values()].map(g=>({dimensions:g.dimensions,metrics:contract.calculate(g.components,g.components,{appsflyer:0,ga4:0})}))};
}
return {build};
});
