'use strict';
(function(){
const $=id=>document.getElementById(id);
const app=window.OracleApp,contract=window.OracleMetrics;
const report={step:'dimensions',catalog:null,dimensions:[],metrics:[]};
function node(tag,text,className){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(className)e.className=className;return e;}
function currentLabel(){return app.contextText();}
function wizardMessage(role,text){const e=node('div',text,'wizard-message '+role);$('reportChat').append(e);return e;}
function materialChoice(reportMode){$('slideLibrary').hidden=reportMode;$('reportBuilder').hidden=!reportMode;$('chooseSlides').classList.toggle('selected',!reportMode);$('chooseReport').classList.toggle('selected',reportMode);$('chooseSlides').setAttribute('aria-pressed',String(!reportMode));$('chooseReport').setAttribute('aria-pressed',String(reportMode));if(reportMode&&!$('reportChat').children.length)startReport();}
function templateChoice(){const quarterly=document.querySelector('input[name="slideTemplate"]:checked').value==='quarterly';$('downloadTemplate').href='/api/templates/'+(quarterly?'quarterly':'monthly');$('chosenTemplateLabel').textContent=quarterly?'Modelo trimestral selecionado':'Modelo mensal selecionado';}
function steps(step){const order=['dimensions','metrics','review'];for(let i=0;i<order.length;i++){const e=$('step'+order[i][0].toUpperCase()+order[i].slice(1));e.classList.toggle('current',order[i]===step);e.classList.toggle('completed',i<order.indexOf(step));}report.step=step;}
async function catalog(){
 if(report.catalog)return report.catalog;
 try{const response=await fetch('/api/report-catalog');const data=await response.json();if(!response.ok||!data.success)throw new Error();report.catalog=data;}
 catch(_){report.catalog={source:'reference',notice:'Lista de exemplo: não foi possível carregar dAllDimensions agora.',dimensions:['SUB','CHANNEL','CAMPAIGN','TrackingCode'].map(id=>({id,label:id,type:'STRING'})),metrics:contract.metrics};}
 return report.catalog;
}
async function startReport(){
 steps('dimensions');report.dimensions=[];report.metrics=[];$('reportChat').replaceChildren();$('reportAnswer').replaceChildren(node('p','Carregando as dimensões…','loading'));
 wizardMessage('bot','Vamos montar o relatório. Quais dimensões você quer usar? Selecione uma ou mais colunas para agrupar a análise.');
 await catalog();if(report.step==='dimensions')renderDimensions();
}
function selectionControls(items,selected,name,metric=false){
 const grid=node('div',null,'choice-grid'+(metric?' metrics-grid':''));
 items.forEach(item=>{
  const label=node('label',null,'choice-item');label.dataset.search=item.label.toLowerCase();
  const input=document.createElement('input');input.type='checkbox';input.name=name;input.value=item.id;input.checked=selected.includes(item.id);
  input.addEventListener('change',()=>{const values=name==='dimension'?report.dimensions:report.metrics;if(input.checked&&!values.includes(item.id))values.push(item.id);else if(!input.checked){const index=values.indexOf(item.id);if(index>=0)values.splice(index,1);}updateSelection();});
  const copy=node('span');copy.append(node('strong',item.label));if(metric){copy.append(node('small',item.formula));if(item.status==='pending')copy.append(node('span','Definição pendente','pending-tag'));}else copy.append(node('small',item.type));
  label.append(input,copy);grid.append(label);
 });return grid;
}
function updateSelection(){const count=report.step==='dimensions'?report.dimensions.length:report.metrics.length;const summary=$('selectionCount'),next=$('wizardNext');if(summary)summary.textContent=`${count} ${report.step==='dimensions'?'dimensão(ões)':'métrica(s)'} selecionada(s)`;if(next)next.disabled=count===0;}
function renderDimensions(){
 const target=$('reportAnswer');target.replaceChildren();
 if(report.catalog.source!=='bigquery')target.append(node('p',report.catalog.notice,'catalog-note'));
 const search=document.createElement('input');search.className='search-dimensions';search.placeholder='Buscar dimensão…';search.type='search';search.setAttribute('aria-label','Buscar dimensão');target.append(search);
 const grid=selectionControls(report.catalog.dimensions,report.dimensions,'dimension');target.append(grid);
 search.addEventListener('input',()=>grid.querySelectorAll('.choice-item').forEach(e=>{e.hidden=!e.dataset.search.includes(search.value.toLowerCase());}));
 const actions=node('div',null,'wizard-actions'),count=node('p');count.id='selectionCount';const next=node('button','Continuar: métricas →','primary-button');next.id='wizardNext';next.type='button';
 next.addEventListener('click',()=>{if(!report.dimensions.length)return;wizardMessage('user',report.dimensions.join(', '));wizardMessage('bot','Quais métricas você quer incluir? As definições abaixo seguem o documento DAX. As métricas pendentes podem entrar na estrutura, mas ainda não terão valores.');steps('metrics');renderMetrics();});
 actions.append(count,next);target.append(actions);updateSelection();
}
function renderMetrics(){
 const target=$('reportAnswer');target.replaceChildren(selectionControls(report.catalog.metrics,report.metrics,'metric',true));
 const actions=node('div',null,'wizard-actions'),count=node('p');count.id='selectionCount';
 const buttons=node('div'),back=node('button','← Alterar dimensões','wizard-secondary'),next=node('button','Ver estrutura →','primary-button');next.id='wizardNext';back.type=next.type='button';
 back.addEventListener('click',()=>{steps('dimensions');$('reportChat').replaceChildren();wizardMessage('bot','Quais dimensões você quer usar?');renderDimensions();});
 next.addEventListener('click',()=>{if(!report.metrics.length)return;wizardMessage('user',report.metrics.map(id=>contract.byId[id].label).join(', '));wizardMessage('bot','Sua estrutura está pronta. Confira o recorte e as colunas. Neste protótipo, o download contém apenas os cabeçalhos do relatório, sem dados de negócio.');steps('review');renderReview();});
 buttons.className='comparison-actions';buttons.append(back,next);actions.append(count,buttons);target.append(actions);updateSelection();
}
function cell(value){const s=String(value);const protectedValue=/^[=+\-@\t\r]/.test(s)?"'"+s:s;return '"'+protectedValue.replace(/"/g,'""')+'"';}
function downloadStructure(){
 const headings=[...report.dimensions,...report.metrics.map(id=>contract.byId[id].label)];
 const data='\uFEFF'+headings.map(cell).join(';')+'\r\n';
 const blob=new Blob([data],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 const c=app.getContext();a.href=url;a.download=`Relatorio-estrutura-${c.subsidiaries[0].replace(/[^a-zA-Z0-9_-]/g,'_')}-${c.period}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function renderReview(){
 const target=$('reportAnswer');target.replaceChildren(node('h3','Prévia da estrutura','report-title'),node('p',currentLabel(),'report-selection'));
 target.append(node('p','Este é um protótipo de configuração. O CSV contém apenas as colunas escolhidas; os espaços abaixo representam dados ainda não carregados.','preview-note'));
 const wrap=node('div',null,'report-table-wrap'),table=node('table',null,'report-table'),thead=node('thead'),tr=node('tr');
 [...report.dimensions,...report.metrics.map(id=>contract.byId[id].label)].forEach(value=>{const th=node('th',value);th.scope='col';tr.append(th);});thead.append(tr);table.append(thead);
 const tbody=node('tbody');for(let i=0;i<3;i++){const row=node('tr');for(let j=0;j<report.dimensions.length+report.metrics.length;j++)row.append(node('td','—'));tbody.append(row);}table.append(tbody);wrap.append(table);target.append(wrap);
 const pending=report.metrics.filter(id=>contract.byId[id].status==='pending');if(pending.length)target.append(node('p','Definições ainda pendentes: '+pending.map(id=>contract.byId[id].label).join(', ')+'.','report-selection'));
 const actions=node('div',null,'wizard-actions'),back=node('button','← Alterar métricas','wizard-secondary'),download=node('button','Baixar estrutura CSV ↓','primary-button');back.type=download.type='button';back.addEventListener('click',()=>{steps('metrics');renderMetrics();});download.addEventListener('click',downloadStructure);actions.append(back,download);target.append(actions);
}
// Example outcomes are deliberately separate from BigQuery and labelled as simulated.
const items=[
 {id:'email-01',name:'Cyber Wow · Oferta principal',image:'cyber-wow.jpg',subject:'¡Llegó el Cyber Wow! Descubre tus ofertas Galaxy',preheader:'Promos, envío gratis y beneficios para tu compra.',delivery:'EXEMPLO-email-cyberwow-oferta-principal',components:contract.componentsForEmail(180000,54000,6480,8000,224,35000),notes:'O primeiro bloco concentra a oferta. Preços, descontos e CTAs aparecem em várias seções.',actions:['Testar um CTA principal com menos ofertas concorrentes.','Comparar uma versão focada em uma categoria com a versão multicategoria.']},
 {id:'email-02',name:'Galaxy Fold7 · Pré-venda',image:'galaxy-preorder.jpg',subject:'Ultra elegante. Ultra cámara. Reservá tu Galaxy',preheader:'Reserva, memoria ampliada y beneficios para tu nuevo Galaxy.',delivery:'EXEMPLO-email-fold7-preorder-beneficios',components:contract.componentsForEmail(140000,47600,8092,5200,468,61000),notes:'A peça alterna benefícios de reserva, demonstrações de câmera e recursos de IA. O conteúdo é extenso e tem diversos CTAs.',actions:['Testar os benefícios principais em uma versão mais curta.','Separar público pronto para comprar de público que ainda precisa conhecer o produto.']},
 {id:'email-03',name:'Cyber Wow · Variante de mensagem',image:'cyber-wow.jpg',subject:'Conocé las novedades y ofertas de tu próximo Galaxy',preheader:'Descubrí productos y beneficios para tu próxima compra.',delivery:'EXEMPLO-email-cyberwow-variante-mensagem',components:contract.componentsForEmail(95000,9500,380,1700,17,2200),notes:'A mesma peça aparece como variante ilustrativa para mostrar como um resultado menor pode pedir outra investigação. O ranking não avalia apenas a aparência.',actions:['Testar assunto e pré-header com um benefício mais específico.','Validar a coerência entre promessa do email, CTA e página de destino.']},
 {id:'email-04',name:'Cyber Wow · Variante de audiência',image:'cyber-wow.jpg',subject:'Las ofertas que estabas esperando están acá',preheader:'Encuentra tu próximo Galaxy y aprovechá los beneficios.',delivery:'EXEMPLO-email-cyberwow-variante-audiencia',components:contract.componentsForEmail(160000,27200,1360,4000,80,12000),notes:'A peça usa várias categorias e uma chamada comercial forte. O menor resultado de exemplo pede avaliar segmentação e relevância da oferta.',actions:['Testar segmentação por afinidade com a categoria.','Verificar a correspondência entre oferta e interesse recente da audiência.']},
].map(item=>({...item,metrics:contract.calculate(item.components,item.components,{appsflyer:0,ga4:0})}));
let rank='open_rate';
const rankDescriptions={open_rate:{label:'OR%',name:'abertura',definition:'Opens / Deliveries de EMAIL e WHATSAPP, com as condições do DAX. Use assunto, pré-header, audiência e entregabilidade como hipóteses de investigação.',test:'Assunto e pré-header',kpi:'OR% e entregabilidade',advice:'Compare assuntos em uma audiência equivalente e observe o impacto nas aberturas.'},click_rate:{label:'CTOR%',name:'engajamento após abertura',definition:'Clicks / Opens de EMAIL e WHATSAPP, com as condições do DAX. Investigue hierarquia da oferta, CTA, relevância e extensão do email.',test:'Oferta e CTA',kpi:'CTOR% e visitas',advice:'Teste uma hierarquia de ofertas mais simples e um CTA principal, mantendo a audiência comparável.'},cvr:{label:'CVR%',name:'conversão',definition:'Nesta demonstração, CVR usa componentes simulados completos de tOrdersCRM_withVisits e a regra de visitas do DOCX. Os dados reais ainda dependem das definições complementares.',test:'Página de destino e oferta',kpi:'CVR% e pedidos válidos',advice:'Verifique a continuidade entre email, oferta, disponibilidade e página de destino antes de mudar apenas o criativo.'}};
const percent=value=>new Intl.NumberFormat('pt-BR',{style:'percent',minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
const integer=value=>new Intl.NumberFormat('pt-BR').format(value);
function showCreative(item){$('creativeTitle').textContent=item.name;$('creativeFullImage').src='/assets/creatives/'+item.image;$('creativeFullImage').alt='Criativo completo: '+item.name;$('creativeDialog').showModal();}
function assetCard(item,kind){
 const isBest=kind==='best',detail=rankDescriptions[rank],card=node('article',null,'asset-card '+kind),header=node('div',null,'asset-card-header');
 header.append(node('h3',(isBest?'Best ':'Worst ')+detail.label),node('strong',percent(item.metrics[rank]),'ranking-value'));card.append(header);
 const body=node('div',null,'asset-card-body'),preview=node('button',null,'asset-preview');preview.type='button';preview.setAttribute('aria-label','Ver criativo completo: '+item.name);
 const image=document.createElement('img');image.src='/assets/creatives/'+item.image;image.alt=item.name;image.loading='lazy';preview.append(image,node('span','Ver criativo completo ↗'));preview.addEventListener('click',()=>showCreative(item));body.append(preview);
 const meta=node('dl',null,'asset-meta');[['SUBSIDIÁRIA',app.getContext().subsidiaries[0]+' · exemplo'],['SUBJECT',item.subject],['PRE-HEADER',item.preheader],['DELIVERY NAME',item.delivery]].forEach(([name,value])=>meta.append(node('dt',name),node('dd',value)));body.append(meta);
 const metrics=node('div',null,'asset-metrics');[['delivered','DELIVERIES'],['open_rate','OR%'],['click_rate','CTOR%'],['cvr','CVR%']].forEach(([id,label])=>{const c=node('div',null,id===rank?'metric-emphasis':'');c.append(node('strong',id==='delivered'?integer(item.metrics[id]):percent(item.metrics[id])),node('small',label));metrics.append(c);});body.append(metrics);
 const analysis=node('div',null,'asset-analysis'),insights=node('div'),actions=node('div');insights.append(node('h4','INSIGHTS'),node('p',item.notes+' '+(isBest?'O resultado de exemplo sugere priorizar a validação desse padrão em um teste controlado.':'O resultado de exemplo pede separar problemas de audiência, mensagem e jornada.')));
 actions.append(node('h4','ACTION ITEMS'));const ul=node('ul');item.actions.forEach(text=>ul.append(node('li',text)));actions.append(ul);analysis.append(insights,actions);body.append(analysis);card.append(body);return card;
}
function renderRanking(){
 const minimum=Number($('minimumVolume').value),eligible=items.filter(i=>i.metrics.delivered>=minimum).sort((a,b)=>b.metrics[rank]-a.metrics[rank]);
 const target=$('assetComparison'),intel=$('comparisonIntelligence');target.replaceChildren();intel.replaceChildren();
 $('rankingScope').textContent=eligible.length+' assets de exemplo · '+currentLabel();$('rankingExplanation').textContent=rankDescriptions[rank].definition;
 if(eligible.length<2){target.append(node('p','Selecione um volume menor para comparar pelo menos dois assets.'));return;}
 const best=eligible[0],worst=eligible.at(-1),gap=(best.metrics[rank]-worst.metrics[rank])*100;
 target.append(assetCard(best,'best'),assetCard(worst,'worst'));
 intel.append(node('h3','O que priorizar na próxima rodada?'),node('p',`Há uma diferença ilustrativa de ${gap.toLocaleString('pt-BR',{maximumFractionDigits:2})} pontos percentuais em ${rankDescriptions[rank].label}. ${rankDescriptions[rank].advice} As métricas do ranking, sozinhas, não demonstram que o criativo causou essa diferença.`));
 const actions=node('div',null,'comparison-actions');[['TESTE SUGERIDO',rankDescriptions[rank].test],['ACOMPANHAR',rankDescriptions[rank].kpi],['ANTES DE ESCALAR','Mantenha período, audiência e volume comparáveis. Verifique qualidade de dados e o comportamento da página de destino.']].forEach(([title,text])=>{const e=node('div',null,'comparison-action');e.append(node('strong',title),node('span',text));actions.append(e);});intel.append(actions);
}
$('chooseSlides').addEventListener('click',()=>materialChoice(false));$('chooseReport').addEventListener('click',()=>materialChoice(true));$('restartReport').addEventListener('click',startReport);
document.querySelectorAll('input[name="slideTemplate"]').forEach(input=>input.addEventListener('change',templateChoice));
document.querySelectorAll('[data-rank]').forEach(b=>b.addEventListener('click',()=>{rank=b.dataset.rank;document.querySelectorAll('[data-rank]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});renderRanking();}));
$('minimumVolume').addEventListener('change',renderRanking);$('closeCreative').addEventListener('click',()=>$('creativeDialog').close());
window.OraclePrototypes={contextChanged(){renderRanking();if(report.step==='review')renderReview();},renderRanking};
templateChoice();renderRanking();
})();
