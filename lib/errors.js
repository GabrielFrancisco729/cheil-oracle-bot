'use strict';
function describeError(error){
 const service=error.service,code=Number(error.status||error.code),message=String(error.message||'');
 if(error.type==='entity.parse.failed'||error.type==='entity.too.large')return {status:error.type==='entity.too.large'?413:400,errorCode:'INVALID_REQUEST',error:'Solicitação inválida ou muito grande.'};
 if(service==='bigquery'){
  if(/Unrecognized name|Name .* not found|Field .*not found|No matching signature|invalidQuery/i.test(message))return {status:502,errorCode:'BIGQUERY_SCHEMA',error:'A consulta encontrou um campo ou tipo diferente no BigQuery. O detalhe está nos logs do servidor com a referência abaixo.'};
  if(code===401||/invalid_grant|Could not load the default credentials|invalid.*credential/i.test(message))return {status:503,errorCode:'BIGQUERY_AUTH',error:'O acesso ao BigQuery não foi autenticado. Confira GCP_SERVICE_ACCOUNT_JSON no Render.'};
  if(code===403||/Access Denied|permission/i.test(message))return {status:503,errorCode:'BIGQUERY_ACCESS',error:'A conta de serviço não tem acesso necessário ao BigQuery. Confira as permissões do dataset e de execução de consultas.'};
  if(code===404)return {status:502,errorCode:'BIGQUERY_TABLE',error:'Uma tabela do BigQuery não foi encontrada. Confira o projeto, o dataset e a região configurados no Render.'};
  if(/maximum bytes billed|bytes.*limit/i.test(message))return {status:502,errorCode:'BIGQUERY_COST_LIMIT',error:'A consulta excedeu o limite de leitura configurado. Use um período menor ou ajuste BQ_MAXIMUM_BYTES_BILLED no Render.'};
  return {status:502,errorCode:'BIGQUERY_QUERY',error:'Não foi possível consultar os dados no BigQuery. Consulte os logs do servidor com a referência abaixo.'};
 }
 if(service==='claude'){
  if(code===401||code===403)return {status:503,errorCode:'CLAUDE_AUTH',error:'Claude recusou o acesso. Confira ANTHROPIC_API_KEY e as permissões da chave no Render.'};
  if(code===404||/model.*not found|model.*not available/i.test(message))return {status:503,errorCode:'CLAUDE_MODEL',error:'O modelo Claude configurado não está disponível para esta chave. Confira CLAUDE_MODEL no Render.'};
  if(/credit balance|billing|insufficient.*credit/i.test(message))return {status:503,errorCode:'CLAUDE_CREDITS',error:'A conta Claude está sem créditos disponíveis. Confira o saldo na Anthropic.'};
  if(code===429)return {status:429,errorCode:'CLAUDE_RATE_LIMIT',error:'Claude atingiu um limite de uso. Aguarde e tente novamente.'};
  return {status:502,errorCode:'CLAUDE_RESPONSE',error:'Claude não concluiu a resposta. Tente novamente ou consulte os logs com a referência abaixo.'};
 }
 if(code===400)return {status:400,errorCode:'INVALID_REQUEST',error:message};
 if(code===429)return {status:429,errorCode:'RATE_LIMIT',error:'O provedor atingiu um limite de uso. Aguarde e tente novamente.'};
 return {status:502,errorCode:'ANALYSIS_FAILED',error:'Não foi possível concluir a análise. Consulte os logs do servidor com a referência abaixo.'};
}
function safeLogMessage(error,env){
 let message=String(error.message||'');
 for(const [name,value]of Object.entries(env))if(/key|token|secret|credential|password|service_account/i.test(name)&&value)message=message.split(String(value)).join('[REDACTED]');
 return message.replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g,'[REDACTED]').replace(/\bsk-[a-zA-Z0-9_-]+/g,'[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,1000);
}
module.exports={describeError,safeLogMessage};
