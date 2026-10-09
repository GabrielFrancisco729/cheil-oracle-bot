(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OracleMetrics=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const metrics=[
 {id:'delivered',label:'Deliveries',measure:'tDeliveries',format:'number',formula:'SUM(DELIVERED)',status:'implemented'},
 {id:'opens',label:'Opens',measure:'tOpens',format:'number',formula:'SUM(OPENS), removendo filtros de produto',status:'implemented'},
 {id:'clicks',label:'Clicks',measure:'tClicks',format:'number',formula:'SUM(CLICKS), removendo filtros de produto',status:'implemented'},
 {id:'visits',label:'Visits',measure:'tVisits',format:'number',formula:'Visits sem affiliate + 4,4% das visits affiliate; sem filtro de produto',status:'implemented'},
 {id:'orders',label:'Orders',measure:'tOrdersCRM',format:'number',formula:'AppsFlyer + Insider + CRM + VTEX + GA4 − 95,6% de affiliate',status:'pending',reason:'Faltam tOrdersGA4 e o relacionamento de auxOrderIDPerDate.'},
 {id:'units',label:'Units',measure:'tUnits AA',format:'number',formula:'Units sem affiliate + 4,4% das units affiliate',status:'implemented'},
 {id:'revenue',label:'Revenue',measure:'tRevenueCRM',format:'money',formula:'AA + VTEX + APP + WEB PUSH/APP + GA4_SEASA − 95,6% de affiliate',status:'implemented'},
 {id:'open_rate',label:'OR%',measure:'OR%',format:'percent',formula:'Opens / Deliveries de EMAIL e WHATSAPP, apenas se Deliveries > Opens; senão 0',status:'implemented'},
 {id:'click_rate',label:'CTOR%',measure:'CTOR%',format:'percent',formula:'Clicks / Opens de EMAIL e WHATSAPP, apenas se Opens > Clicks; senão 0',status:'implemented'},
 {id:'ctr',label:'CTR%',measure:'CTR%',format:'percent',formula:'tClicks / tDeliveries (retorno efetivo CTR2 do DAX)',status:'implemented'},
 {id:'cvr',label:'CVR%',measure:'CVR%',format:'percent',formula:'tOrdersCRM_withVisits / (tVisits − tVisits no recorte affiliate)',status:'pending',reason:'Faltam tOrdersGA4 e o relacionamento de auxOrderIDPerDate.'},
 {id:'aov',label:'AOV',measure:'AOV',format:'money',formula:'tRevenueCRM / tOrdersCRM',status:'pending',reason:'Depende de tOrdersCRM completo.'},
];
const byId=Object.fromEntries(metrics.map(m=>[m.id,m]));
const divide=(a,b,fallback=null)=>a==null||b==null?null:Number(b)===0?fallback:Number(a)/Number(b);
// Aggregate components are shared between SQL, tests and explicitly simulated assets.
function calculate(c,ignoreProduct=c,orderComponents=null){
 const i=ignoreProduct;
 const revenue=c.revenue_aa+c.revenue_vtex+c.revenue_app+c.revenue_web_app+c.revenue_ga4+c.revenue_affiliate*.044-c.revenue_affiliate;
 const visits=i.visits_all-i.visits_affiliate+i.visits_affiliate*.044;
 const orders=orderComponents?orderComponents.appsflyer+orderComponents.ga4+c.orders_insider+c.orders_crm+c.orders_vtex+c.orders_affiliate*.044-c.orders_affiliate:null;
 const ordersWithVisits=orderComponents?orderComponents.appsflyer+orderComponents.ga4+c.orders_insider_with_visits+c.orders_crm-c.orders_vtex_cartapp-c.orders_affiliate:null;
 return {delivered:c.delivered,opens:i.opens,clicks:i.clicks,visits,orders,units:c.units_all-c.units_affiliate+c.units_affiliate*.044,revenue,
 open_rate:c.mail_delivered>i.mail_opens?divide(i.mail_opens,c.mail_delivered,0):0,
 click_rate:i.mail_opens>i.mail_clicks?divide(i.mail_clicks,i.mail_opens,0):0,
 ctr:divide(i.clicks,c.delivered),cvr:orderComponents?divide(ordersWithVisits,visits-i.visits_affiliate*.044,0):null,aov:divide(revenue,orders)};
}
function componentsForEmail(delivered,opens,clicks,visits,orders,revenue){return {delivered,opens,clicks,visits_all:visits,visits_affiliate:0,units_all:orders,units_affiliate:0,mail_delivered:delivered,mail_opens:opens,mail_clicks:clicks,revenue_aa:revenue,revenue_vtex:0,revenue_app:0,revenue_web_app:0,revenue_ga4:0,revenue_affiliate:0,orders_insider:0,orders_insider_with_visits:0,orders_crm:orders,orders_vtex:0,orders_affiliate:0,orders_vtex_cartapp:0};}
function currencyFor(subsidiaries){return Array.isArray(subsidiaries)&&subsidiaries.length===1&&subsidiaries[0].toUpperCase()==='SEDA'?'BRL':'USD';}
return {version:'dax-docx-2026-10-09-currency-auto',metrics,byId,calculate,componentsForEmail,currencyFor};
});
