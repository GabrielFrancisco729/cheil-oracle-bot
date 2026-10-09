'use strict';
const contract=require('../public/metric-contract');
const sum=expr=>`COALESCE(SUM(${expr}), 0)`;
const conditional=(condition,field)=>sum(`IF(${condition}, fc.\`${field}\`, 0)`);
function rawAggregates(localRevenue){
 const revenue=localRevenue?'Revenue_SEDA':'Revenue';
 const insider="fc.Source IN ('IOS','ANDROID','APP','ARQUITECT','ARCHITECT','EPP') OR fc.`CHANNEL / TRIGGER` = 'APP PUSH'";
 const insiderWithVisits="fc.Source IN ('IOS','ANDROID','APP','ARQUITECT','EPP') OR fc.`CHANNEL / TRIGGER` = 'APP PUSH'";
 const email="fc.CHANNEL IN ('EMAIL','WHATSAPP')";
 const fields={
 row_count:'COUNT(*)',tracking_count:'COUNT(DISTINCT fc.Tracking_code)',first_date:'MIN(DATE(fc.Date))',last_date:'MAX(DATE(fc.Date))',
 delivered:sum('fc.DELIVERED'),opens:sum('fc.OPENS'),clicks:sum('fc.CLICKS'),
 visits_all:sum('fc.Total_visits'),visits_affiliate:conditional("fc.DATA_SOURCE = 'AFFILIATE'",'Total_visits'),
 units_all:sum('fc.Total_units'),units_affiliate:conditional("fc.DATA_SOURCE = 'AFFILIATE'",'Total_units'),
 mail_delivered:conditional(email,'DELIVERED'),mail_opens:conditional(email,'OPENS'),mail_clicks:conditional(email,'CLICKS'),
 revenue_aa:conditional("fc.Source = 'ANALYTICS'",revenue),revenue_vtex:conditional("fc.Source = 'VTEX'",revenue),
 revenue_app:conditional("fc._dim.CHANNEL = 'APP PUSH'",revenue),revenue_web_app:conditional("fc.CHANNEL = 'WEB PUSH' AND fc.Source = 'APP'",revenue),
 revenue_ga4:conditional("SUBSTR(fc.Source, 1, 9) = 'GA4_SEASA'",'Revenue'),revenue_affiliate:conditional("fc.DATA_SOURCE = 'AFFILIATE'",'Revenue'),
 orders_insider:conditional(insider,'Total_orders'),orders_insider_with_visits:conditional(insiderWithVisits,'Total_orders'),
 orders_crm:conditional("fc.Source IN ('ANALYTICS','WHATSAPP')",'Total_orders'),orders_vtex:conditional("fc.Source = 'VTEX'",'Total_orders'),
 orders_affiliate:conditional("fc.DATA_SOURCE = 'AFFILIATE'",'Total_orders'),orders_vtex_cartapp:conditional("fc.DATA_SOURCE = 'VTEX_CARTAPP'",'Total_orders'),
 };
 return Object.entries(fields).map(([alias,expr])=>`${expr} AS ${alias}`).join(',\n');
}
function metricSelect(g='g',i='g'){
 const rev=`(${g}.revenue_aa + ${g}.revenue_vtex + ${g}.revenue_app + ${g}.revenue_web_app + ${g}.revenue_ga4 + ${g}.revenue_affiliate * 0.044 - ${g}.revenue_affiliate)`;
 return `${g}.row_count, ${g}.tracking_count, ${g}.first_date, ${g}.last_date,
 ${g}.delivered AS delivered, ${i}.opens AS opens, ${i}.clicks AS clicks,
 (${i}.visits_all - ${i}.visits_affiliate + ${i}.visits_affiliate * 0.044) AS visits,
 (${g}.units_all - ${g}.units_affiliate + ${g}.units_affiliate * 0.044) AS units,
 ${rev} AS revenue,
 IF(${g}.mail_delivered > ${i}.mail_opens, COALESCE(SAFE_DIVIDE(${i}.mail_opens, ${g}.mail_delivered), 0), 0) AS open_rate,
 IF(${i}.mail_opens > ${i}.mail_clicks, COALESCE(SAFE_DIVIDE(${i}.mail_clicks, ${i}.mail_opens), 0), 0) AS click_rate,
 SAFE_DIVIDE(${i}.clicks, ${g}.delivered) AS ctr,
 CAST(NULL AS FLOAT64) AS orders, CAST(NULL AS FLOAT64) AS cvr, CAST(NULL AS FLOAT64) AS aov`;
}
function metricQuality(){return {contract:contract.version,orders:{status:'pending',reason:contract.byId.orders.reason},cvr:{status:'pending',reason:contract.byId.cvr.reason},aov:{status:'pending',reason:contract.byId.aov.reason},reconciliation:'Regras traduzidas do DOCX. Conciliação com Power BI requer validar relações do modelo e dados reais.'};}
module.exports={...contract,rawAggregates,metricSelect,metricQuality};
