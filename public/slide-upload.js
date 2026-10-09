'use strict';
(function(){
const get=id=>document.getElementById(id);let available=false,busy=false,previewObserver;
function node(tag,text,className){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(className)e.className=className;return e;}
function controls(){get('slideFile').disabled=busy;get('analyzeSlide').disabled=busy||!available||!get('slideFile').files.length;get('analyzeSlide').textContent=busy?'Analisando o modelo…':'Analisar e preencher ↗';get('uploadScope').textContent=window.OracleApp.contextText();}
function status(text,error=false){get('slideUploadStatus').textContent=text;get('slideUploadStatus').classList.toggle('upload-error',error);}
function showResult(data){
 const target=get('slideUploadResult');previewObserver?.disconnect();target.replaceChildren();target.hidden=false;
 const heading=node('div',null,'upload-result-heading'),copy=node('div');copy.append(node('h3','Modelo preenchido'),node('p',data.summary));
 copy.append(node('small',`${data.slideCount} slide(s) · ${data.changes.length} campo(s) preenchido(s) · ${data.context.subsidiaries.join(', ')} · ${data.currency} · números fictícios`));
 const download=node('a','Baixar PPTX preenchido ↓','primary-button download-link');download.href=data.downloadUrl;download.download=data.filename;heading.append(copy,download);target.append(heading);
 target.append(node('p','Os números deste material são demonstrativos. Baixe o arquivo agora: o download fica disponível temporariamente.','preview-note'));
 if(data.preview){
  const preview=node('div',null,'filled-image-preview'),image=document.createElement('img');image.src=data.preview.dataUrl;image.alt='Modelo enviado com valores demonstrativos sobrepostos';preview.append(image);
  for(const field of data.preview.fields){const box=node('span',field.value,'filled-image-value');box.style.left=field.box.x/10+'%';box.style.top=field.box.y/10+'%';box.style.width=field.box.w/10+'%';box.style.height=field.box.h/10+'%';box.style.backgroundColor='#'+field.box.background;box.style.color='#'+field.box.color;box.style.fontSize=Math.max(9,Math.min(32,field.box.h/1000*500*.58))+'px';preview.append(box);}
  target.append(preview);
  previewObserver=new ResizeObserver(()=>{const imageHeight=image.clientHeight,imageWidth=image.clientWidth;preview.querySelectorAll('.filled-image-value').forEach((box,index)=>{const f=data.preview.fields[index],height=f.box.h/1000*imageHeight,width=f.box.w/1000*imageWidth;box.style.fontSize=Math.max(1,Math.min(36,height*.58,width/Math.max(1,f.value.length*.62)))+'px';});});previewObserver.observe(preview);
 }
 const wrap=node('div',null,'report-table-wrap'),table=node('table',null,'report-table'),head=node('thead'),header=node('tr');['SLIDE','INDICADOR','CAMPO ORIGINAL','VALOR DE EXEMPLO'].forEach(text=>header.append(node('th',text)));head.append(header);table.append(head);
 const body=node('tbody');data.changes.forEach(change=>{const row=node('tr');[change.slide,change.metric,change.original,change.value].forEach(value=>row.append(node('td',String(value))));body.append(row);});table.append(body);wrap.append(table);target.append(wrap);
 if(data.warnings?.length){const notes=node('ul',null,'upload-notes');data.warnings.forEach(text=>notes.append(node('li',text)));target.append(notes);}
}
get('slideFile').addEventListener('change',()=>{get('slideUploadResult').hidden=true;const file=get('slideFile').files[0];status(file?`${file.name} · ${(file.size/1048576).toFixed(1)} MB`:'Escolha um arquivo para começar.');controls();});
get('slideUploadForm').addEventListener('submit',async event=>{
 event.preventDefault();const file=get('slideFile').files[0];if(!file||busy||!available)return;
 if(file.size>30*1048576){status('O arquivo deve ter no máximo 30 MB.',true);return;}
 busy=true;controls();get('slideUploadResult').hidden=true;status('Enviando o modelo, identificando os indicadores e preparando o PowerPoint…');
 try{const form=new FormData();form.append('template',file);form.append('context',JSON.stringify(window.OracleApp.getContext()));const response=await fetch('/api/slides/fill',{method:'POST',body:form});let data;try{data=await response.json();}catch(_){throw new Error('O servidor não concluiu o modelo. Tente novamente com um arquivo menor.');}if(!response.ok||!data.success)throw new Error((data.error||'Não foi possível preencher o modelo.')+(data.requestId?' Referência: '+data.requestId+'.':''));showResult(data);status('Pronto. Revise a prévia e baixe o PPTX com números de exemplo.');}
 catch(error){status(error.message,true);}finally{busy=false;controls();}
});
get('subsidiary').addEventListener('change',controls);get('period').addEventListener('change',controls);
fetch('/api/config').then(r=>r.json()).then(data=>{available=Boolean(data.slidesConfigured);if(!available)status('Configure a chave Claude no servidor para analisar modelos. Os downloads originais continuam disponíveis.');controls();}).catch(()=>status('Não foi possível verificar o serviço. Recarregue a página para tentar novamente.',true));controls();
})();
