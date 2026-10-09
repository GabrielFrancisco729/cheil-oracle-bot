'use strict';
const $ = id => document.getElementById(id);
const state = { revision: 0, history: [], activeTab: 'chat', aiReady: false, setupReady: false, chatRequest: null, summaryRequests: {}, summaries: {}, recognition: null, listening: false, voiceGeneration: 0 };
const labels = { executive: 'resumo-exec', managerial: 'resumo-ger' };
try { localStorage.removeItem('cheil_oracle_api_key'); } catch (_) { /* Storage may be disabled. */ }
function context() { return { subsidiaries: [$('subsidiary').value], period: $('period').value }; }
function contextText() { return `${$('subsidiary').value} · ${$('period').selectedOptions[0].textContent} · ${window.OracleMetrics.currencyFor(context().subsidiaries)}`; }
function showNotice(message, retry = false) { $('noticeText').textContent = message; $('notice').hidden = !message; $('retrySetup').hidden = !retry; }
function updateControls() {
  const ready = state.aiReady && state.setupReady;
  $('send').disabled = !ready || Boolean(state.chatRequest) || state.listening;
  $('question').disabled = !ready || Boolean(state.chatRequest);
  $('mic').disabled = !ready || Boolean(state.chatRequest) || !state.recognition;
  document.querySelectorAll('.suggestions button').forEach(b => { b.disabled = !ready || Boolean(state.chatRequest); });
  document.querySelectorAll('.clarification-options button').forEach(b => { b.disabled = !ready || Boolean(state.chatRequest) || b.dataset.answered === 'true'; });
  document.querySelectorAll('.generate').forEach(b => { b.disabled = !ready || Boolean(state.summaryRequests[b.dataset.type]); });
}
async function api(path, body, signal) {
  const response = await fetch(path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal });
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('O servidor não retornou uma resposta válida. Tente novamente.'); }
  if (!response.ok || !data.success) throw new Error((data.error || 'Não foi possível concluir a solicitação.') + (data.requestId ? ` Referência: ${data.requestId}.` : ''));
  return data;
}
// Build formatting with DOM nodes; never inject user or model HTML.
function inline(parent, text) {
  const pieces = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  for (const piece of pieces) {
    if (piece.startsWith('**') && piece.endsWith('**')) { const b = document.createElement('strong'); b.textContent = piece.slice(2, -2); parent.append(b); }
    else if (piece.startsWith('`') && piece.endsWith('`')) { const code = document.createElement('code'); code.textContent = piece.slice(1, -1); parent.append(code); }
    else parent.append(document.createTextNode(piece));
  }
}
function formatted(parent, text) {
  parent.replaceChildren(); parent.classList.add('formatted');
  let list = null, paragraph = null;
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (!value) { list = null; paragraph = null; continue; }
    const heading = value.match(/^#{1,6}\s+(.+)$/);
    const bullet = value.match(/^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/);
    if (heading) { const h = document.createElement('h3'); inline(h, heading[1]); parent.append(h); list = null; paragraph = null; }
    else if (bullet) {
      const tag = /^\d/.test(value) ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) { list = document.createElement(tag.toLowerCase()); parent.append(list); }
      const li = document.createElement('li'); inline(li, bullet[1]); list.append(li); paragraph = null;
    } else {
      list = null;
      if (!paragraph) { paragraph = document.createElement('p'); parent.append(paragraph); } else paragraph.append(document.createElement('br'));
      inline(paragraph, line);
    }
  }
}
function addMessage(role, text, error = false) {
  $('welcome').hidden = true;
  const message = document.createElement('div'); message.className = `message ${role}${error ? ' error' : ''}`;
  if (role === 'bot') { const icon = document.createElement('span'); icon.className = 'message-label'; icon.textContent = '✦'; icon.setAttribute('aria-hidden', 'true'); message.append(icon); }
  const body = document.createElement('div'); body.className = 'message-body';
  if (role === 'user') body.textContent = text; else formatted(body, text);
  message.append(body); $('chatArea').append(message); $('chatArea').scrollTop = $('chatArea').scrollHeight;
  return message;
}
function loading(parent, text) { const p = document.createElement('p'); p.className = 'loading'; p.textContent = text; parent.replaceChildren(p); }
function abortChat() { if (state.chatRequest) state.chatRequest.abort(); state.chatRequest = null; }
function resetChat() {
  abortChat(); stopDictation(true); state.history = [];
  $('chatArea').querySelectorAll('.message').forEach(m => m.remove()); $('welcome').hidden = false;
  $('question').value = ''; updateControls();
}
function invalidateContext() {
  state.revision++;
  resetChat();
  for (const controller of Object.values(state.summaryRequests)) controller.abort();
  state.summaryRequests = {}; state.summaries = {};
  for (const type of Object.keys(labels)) { $(type + 'Content').replaceChildren(); $(type + 'Context').textContent = contextText(); }
  $('contextLabel').textContent = contextText(); $('chatContext').textContent = contextText();
  updateControls(); maybeGenerate(); window.OraclePrototypes?.contextChanged();
}
async function sendMessage(text) {
  const message = (typeof text === 'string' ? text : $('question').value).trim();
  if (!message || !state.aiReady || !state.setupReady || state.chatRequest || state.listening) return;
  const controller = new AbortController(), revision = state.revision;
  document.querySelectorAll('.clarification-options button').forEach(b => { b.dataset.answered = 'true'; });
  state.chatRequest = controller; addMessage('user', message); $('question').value = ''; updateControls();
  const pending = addMessage('bot', ''); loading(pending.querySelector('.message-body'), 'Consultando os dados e preparando a resposta…');
  try {
    const data = await api('/api/chat', { message, history: state.history.slice(-8), context: context() }, controller.signal);
    if (revision !== state.revision || state.chatRequest !== controller) return;
    formatted(pending.querySelector('.message-body'), data.reply + (data.truncated ? '\n\nA resposta atingiu o limite de tamanho. Peça para detalhar um ponto específico.' : ''));
    if (data.clarification?.options) {
      const choices = document.createElement('div'); choices.className = 'clarification-options';
      for (const option of data.clarification.options) { const button = document.createElement('button'); button.type = 'button'; button.textContent = option; button.addEventListener('click', () => sendMessage(option)); choices.append(button); }
      pending.querySelector('.message-body').append(choices);
    }
    const rememberedReply = data.reply + (data.clarification ? '\nOpções: ' + data.clarification.options.map((v, i) => `${i + 1}. ${v}`).join('; ') : '');
    state.history.push({ role: 'user', content: message }, { role: 'assistant', content: rememberedReply.slice(0, 12000) });
    state.history = state.history.slice(-8);
  } catch (error) {
    if (error.name !== 'AbortError' && revision === state.revision && state.chatRequest === controller) {
      pending.classList.add('error'); formatted(pending.querySelector('.message-body'), error.message);
      $('question').value = message;
    }
  } finally {
    if (state.chatRequest === controller) { state.chatRequest = null; updateControls(); }
    $('chatArea').scrollTop = $('chatArea').scrollHeight;
  }
}
function dateFormat(value) { return value ? value.split('-').reverse().join('/') : ''; }
function describePeriod(period) {
  if (!period?.start) return `${contextText()} · Todo o histórico disponível`;
  const main = `${contextText()} · ${dateFormat(period.start)} a ${dateFormat(period.end)} (${period.timezone})`;
  return period.comparison ? `${main} · Comparação: ${dateFormat(period.comparison.start)} a ${dateFormat(period.comparison.end)}` : main;
}
async function generateSummary(type, force = false) {
  if (!state.aiReady || !state.setupReady || state.summaryRequests[type] || (state.summaries[type] && !force)) return;
  const controller = new AbortController(), revision = state.revision;
  state.summaryRequests[type] = controller; updateControls();
  const target = $(type + 'Content'); target.classList.remove('summary-error');
  $(type + 'Context').textContent = contextText(); loading(target, 'Analisando o período e preparando o resumo…');
  try {
    const data = await api('/api/summary', { type, context: context() }, controller.signal);
    if (revision !== state.revision || state.summaryRequests[type] !== controller) return;
    formatted(target, data.summary + (data.truncated ? '\n\nO resumo atingiu o limite de tamanho. Use o chat para aprofundar pontos específicos.' : ''));
    $(type + 'Context').textContent = describePeriod(data.data?.period);
    state.summaries[type] = data;
  } catch (error) {
    if (error.name !== 'AbortError' && revision === state.revision && state.summaryRequests[type] === controller) { target.classList.add('summary-error'); target.textContent = error.message + ' Use “Atualizar resumo” para tentar novamente.'; delete state.summaries[type]; }
  } finally {
    if (state.summaryRequests[type] === controller) { delete state.summaryRequests[type]; updateControls(); }
  }
}
function maybeGenerate() { const type = Object.keys(labels).find(key => labels[key] === state.activeTab); if (type) generateSummary(type); }
function switchTab(tab) {
  state.activeTab = tab;
  if (tab !== 'chat') stopDictation(true);
  document.querySelectorAll('.tab').forEach(b => { const active = b.dataset.tab === tab; b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== tab; });
  maybeGenerate();
}
function stopDictation(abort = false) {
  if (abort) state.voiceGeneration++;
  if (state.recognition && state.listening) { try { abort ? state.recognition.abort() : state.recognition.stop(); } catch (_) {} }
  state.listening = false; $('mic').classList.remove('recording'); $('mic').setAttribute('aria-pressed', 'false'); updateControls();
}
function setupDictation() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { $('mic').title = 'Ditado indisponível neste navegador'; $('voiceStatus').textContent = 'Ditado indisponível neste navegador. Digite sua pergunta.'; updateControls(); return; }
  const recognition = new Recognition(); state.recognition = recognition;
  recognition.lang = 'pt-BR'; recognition.continuous = true; recognition.interimResults = true;
  let original = '', finalText = '', voiceRevision = 0, voiceGeneration = 0, voiceFailed = false;
  recognition.onstart = () => { if (voiceRevision !== state.revision || voiceGeneration !== state.voiceGeneration) { recognition.abort(); return; } state.listening = true; $('mic').classList.add('recording'); $('mic').setAttribute('aria-pressed', 'true'); $('voiceStatus').textContent = 'Ouvindo… clique no microfone para concluir.'; updateControls(); };
  recognition.onresult = event => {
    if (voiceRevision !== state.revision || voiceGeneration !== state.voiceGeneration) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) finalText += event.results[i][0].transcript + ' '; else interim += event.results[i][0].transcript;
    }
    $('question').value = [original, finalText.trim(), interim].filter(Boolean).join(' ').slice(0, 4000);
  };
  recognition.onerror = event => {
    voiceFailed = true;
    const errors = { 'not-allowed': 'Permita o acesso ao microfone no navegador para usar o ditado.', 'service-not-allowed': 'O serviço de ditado está bloqueado neste navegador.', 'audio-capture': 'Não foi possível acessar o microfone.', network: 'O serviço de ditado não está disponível. Verifique a conexão.', 'no-speech': 'Nenhuma fala foi detectada. Tente novamente.' };
    if (event.error !== 'aborted') $('voiceStatus').textContent = errors[event.error] || 'Não foi possível transcrever a fala. Tente novamente.';
  };
  recognition.onend = () => {
    if (state.listening && !voiceFailed) $('voiceStatus').textContent = 'Ditado concluído. Revise o texto e clique em Enviar.';
    state.listening = false; $('mic').classList.remove('recording'); $('mic').setAttribute('aria-pressed', 'false'); updateControls();
  };
  $('mic').addEventListener('click', () => {
    if (state.listening) { recognition.stop(); return; }
    if (!state.aiReady || !state.setupReady || state.chatRequest) return;
    original = $('question').value.trim(); finalText = ''; voiceRevision = state.revision; voiceGeneration = state.voiceGeneration; voiceFailed = false;
    try { recognition.start(); state.listening = true; $('voiceStatus').textContent = 'Iniciando o microfone…'; updateControls(); }
    catch (_) { state.listening = false; $('voiceStatus').textContent = 'Não foi possível iniciar o ditado. Tente novamente.'; updateControls(); }
  });
}
async function initialize() {
  state.setupReady = false; updateControls();
  const results = await Promise.allSettled([api('/api/config'), api('/api/subsidiaries')]);
  const [config, subsidiaries] = results;
  const errors = [];
  if (config.status === 'fulfilled') { state.aiReady = config.value.aiConfigured; if (!state.aiReady) errors.push('O assistente está aguardando a configuração do servidor.'); }
  else errors.push('Não foi possível verificar a disponibilidade do assistente.');
  if (subsidiaries.status === 'fulfilled') {
    const previous = $('subsidiary').value;
    const all = subsidiaries.value.subsidiaries;
    const options = ['LAO', ...all.filter(s => !/^SELA/i.test(s) && s !== 'LAO'), ...(all.some(s => /^SELA/i.test(s)) ? ['SELA'] : [])];
    $('subsidiary').replaceChildren(...[...new Set(options)].map(value => { const option = document.createElement('option'); option.value = value; option.textContent = value; return option; }));
    $('subsidiary').value = options.includes(previous) ? previous : 'LAO'; state.setupReady = true;
    $('contextLabel').textContent = contextText(); $('chatContext').textContent = contextText();
  } else errors.push('Não foi possível carregar as subsidiárias. Tente novamente.');
  showNotice(errors.join(' '), results.some(r => r.status === 'rejected')); updateControls(); maybeGenerate();
}
$('chatForm').addEventListener('submit', event => { event.preventDefault(); if (state.listening) { stopDictation(); return; } sendMessage(); });
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (state.listening) stopDictation(); else sendMessage(); } });
$('question').addEventListener('input', () => { $('question').style.height = 'auto'; $('question').style.height = Math.min($('question').scrollHeight, 120) + 'px'; });
$('subsidiary').addEventListener('change', invalidateContext); $('period').addEventListener('change', invalidateContext);
$('newChat').addEventListener('click', () => { resetChat(); switchTab('chat'); $('question').focus(); });
$('retrySetup').addEventListener('click', initialize);
document.querySelectorAll('.suggestions button').forEach(b => b.addEventListener('click', () => sendMessage(b.dataset.question)));
document.querySelectorAll('.generate').forEach(b => b.addEventListener('click', () => generateSummary(b.dataset.type, true)));
const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach((b, index) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
  b.addEventListener('keydown', event => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = tabs.length - 1; else return;
    event.preventDefault(); tabs[next].focus(); switchTab(tabs[next].dataset.tab);
  });
});
window.OracleApp = { getContext: context, contextText, switchTab };
setupDictation(); initialize();
