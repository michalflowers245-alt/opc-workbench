import {one, all} from './db.js';
import {secret} from './secrets.js';

const now = () => new Date().toISOString();

export function extractJson(text) {
  if (typeof text !== 'string') return {ok:false, error:'模型输出为空'};
  let value = text.trim();
  value = value.replace(/^\uFEFF/, '');
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) value = fenced[1].trim();
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first >= 0 && last > first) value = value.slice(first, last + 1);
  try { return {ok:true, value:JSON.parse(value)}; }
  catch (failure) {
    try {
      const repaired = value.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
      return {ok:true, value:JSON.parse(repaired), repaired:true};
    } catch {
      return {ok:false, error:'模型返回不是合法 JSON：' + failure.message, raw:text.slice(0,2000)};
    }
  }
}

export function validateShape(value, shape, path = '') {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{path: path || '$', message:'必须是对象'}];
  }
  for (const [key, rule] of Object.entries(shape || {})) {
    const current = value[key];
    const location = path ? path + '.' + key : key;
    if (rule.required && (current === undefined || current === null || current === '')) {
      errors.push({path:location, message:'缺少必填字段'});
      continue;
    }
    if (current === undefined || current === null) continue;
    if (rule.type === 'array' && !Array.isArray(current)) errors.push({path:location, message:'必须是数组'});
    if (rule.type === 'object' && (typeof current !== 'object' || Array.isArray(current))) errors.push({path:location, message:'必须是对象'});
    if (rule.type === 'string' && typeof current !== 'string') errors.push({path:location, message:'必须是字符串'});
    if (rule.type === 'number' && typeof current !== 'number') errors.push({path:location, message:'必须是数字'});
    if (rule.minItems && Array.isArray(current) && current.length < rule.minItems) errors.push({path:location, message:'至少需要 ' + rule.minItems + ' 项'});
  }
  return errors;
}

export function resolveModel(db, employee) {
  const configs = all(db, 'SELECT * FROM opc_model_configs');
  const requested = configs.find(item => item.id === employee?.model_id && item.enabled) || null;
  const fallback = configs.find(item => item.is_default && item.enabled) || configs.find(item => item.enabled) || null;
  const chosen = requested || fallback;
  return {config:chosen || null, fallbackFrom: requested ? null : (employee?.model_id || null), requested};
}

async function ollamaChat({config, messages, schema, timeoutMs, maxTokens}) {
  const started = Date.now();
  const startedAt = now();
  const modelName = config.model;
  const body = {
    model: modelName, messages, stream: true, think: false,
    options: {temperature: 0.1, num_ctx: 8192, num_predict: maxTokens || 3000},
  };
  if (schema) body.format = schema; else body.format = 'json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 180000);
  try {
    let response = await fetch((config.base_url || 'http://127.0.0.1:11434').replace(/\/$/, '') + '/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      redirect:'error', signal:controller.signal,
    });
    if (!response.ok && response.status === 400 && body.format !== 'json') {
      body.format = 'json';
      response = await fetch((config.base_url || 'http://127.0.0.1:11434').replace(/\/$/, '') + '/api/chat', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
        redirect:'error', signal:controller.signal,
      });
    }
    if (!response.ok) {
      const text = await response.text();
      const status = response.status === 404 ? 'model_not_found' : response.status === 401 || response.status === 403 ? 'permission_denied' : response.status === 429 ? 'rate_limited' : 'failed';
      return {ok:false, status, error:'Ollama HTTP ' + response.status + (text ? '：' + text.slice(0,300) : ''), environment:'local', provider:'ollama', requestedModel:modelName, startedAt, durationMs:Date.now()-started};
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let firstTokenMs = null;
    let thinkingChars = 0;
    let providerModel = modelName;
    let tokensIn = null, tokensOut = null;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream:true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        if (chunk.model) providerModel = chunk.model;
        const delta = chunk.message?.content || '';
        const thinking = chunk.message?.thinking || '';
        if ((delta || thinking) && firstTokenMs === null) firstTokenMs = Date.now() - started;
        thinkingChars += thinking.length;
        content += delta;
        if (chunk.done) {
          tokensIn = chunk.prompt_eval_count ?? tokensIn;
          tokensOut = chunk.eval_count ?? tokensOut;
        }
      }
    }
    return {ok:true, status: content ? 'success' : 'empty_content', environment:'local', provider:'ollama', requestedModel:modelName,
      providerModel, content, firstTokenMs, thinkingChars, durationMs:Date.now()-started, startedAt, tokensIn, tokensOut,
      error: content ? null : '模型在思考阶段耗尽输出预算，未产生正文'};
  } catch (failure) {
    const timeout = failure?.name === 'AbortError';
    return {ok:false, status: timeout ? 'timeout' : 'failed', error: timeout ? '模型请求超时' : '模型请求失败：' + (failure?.message || 'unknown'),
      environment:'local', provider:'ollama', requestedModel:modelName, startedAt, durationMs:Date.now()-started, firstTokenMs:null};
  } finally {
    clearTimeout(timer);
  }
}

async function compatibleChat({config, messages, schema, timeoutMs, maxTokens}) {
  const started = Date.now();
  const startedAt = now();
  const baseUrl = (config.base_url || '').replace(/\/$/, '');
  const endpoint = baseUrl.endsWith('/v1') ? baseUrl + '/chat/completions' : baseUrl + '/v1/chat/completions';
  const officialDeepSeek = new URL(baseUrl).hostname === 'api.deepseek.com';
  const apiKey = officialDeepSeek
    ? secret('DEEPSEEK_API_KEY') || secret('LLM_API_KEY')
    : secret('LLM_API_KEY');
  if (!apiKey) return {ok:false, status:'not_configured', error:officialDeepSeek ? '缺少 DEEPSEEK_API_KEY' : '缺少 LLM_API_KEY',
    missing:[officialDeepSeek ? 'DEEPSEEK_API_KEY' : 'LLM_API_KEY'], environment:'real', provider:'compatible', requestedModel:config.model, startedAt, durationMs:0};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 180000);
  try {
    const response = await fetch(endpoint, {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + apiKey},
      body: JSON.stringify({model:config.model, messages, temperature:0.2, max_tokens:maxTokens || 900,
        response_format:{type:'json_object'}, stream:true, stream_options:{include_usage:true}}),
      redirect:'error', signal:controller.signal,
    });
    if (!response.ok) {
      const text = (await response.text()).split(apiKey).join('[redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
      return {ok:false, status:response.status === 401 || response.status === 403 ? 'permission_denied' : response.status === 429 ? 'rate_limited' : 'failed',
        httpStatus:response.status, error:'模型服务 HTTP ' + response.status + '：' + text.slice(0,300), environment:'real', provider:'compatible', requestedModel:config.model, startedAt, durationMs:Date.now()-started};
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let firstTokenMs = null;
    let providerModel = null;
    let tokensIn = null, tokensOut = null;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream:true});
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let chunk; try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.model) providerModel = chunk.model;
          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (delta && firstTokenMs === null) firstTokenMs = Date.now() - started;
          content += delta;
          if (chunk.usage) { tokensIn = chunk.usage.prompt_tokens ?? tokensIn; tokensOut = chunk.usage.completion_tokens ?? tokensOut; }
        }
      }
    }
    return {ok:Boolean(content), status:content ? 'success' : 'empty_content', error:content ? null : '模型未返回正文',
      environment:'real', provider:'compatible', requestedModel:config.model,
      providerModel, content, firstTokenMs, durationMs:Date.now()-started, startedAt, tokensIn, tokensOut};
  } catch (failure) {
    const timeout = failure?.name === 'AbortError';
    return {ok:false, status: timeout ? 'timeout' : 'failed', error: timeout ? '模型请求超时' : '模型请求失败：' + (failure?.message || 'unknown'),
      environment:'real', provider:'compatible', requestedModel:config.model, startedAt, durationMs:Date.now()-started};
  } finally {
    clearTimeout(timer);
  }
}

export async function chat({config, messages, schema, timeoutMs, maxTokens}) {
  if (!config) return {ok:false, status:'not_configured', error:'没有可用模型配置'};
  if (config.provider === 'ollama') return ollamaChat({config, messages, schema, timeoutMs, maxTokens});
  return compatibleChat({config, messages, schema, timeoutMs, maxTokens});
}

export async function testModel(db, config) {
  const started = Date.now();
  if (!config) return {ok:false, status:'not_configured', detail:'没有模型配置', durationMs:0};
  try {
    if (config.provider === 'ollama') {
      const response = await fetch((config.base_url || 'http://127.0.0.1:11434').replace(/\/$/, '') + '/api/tags', {redirect:'error', signal:AbortSignal.timeout(5000)});
      if (!response.ok) return {ok:false, status:'failed', detail:'Ollama HTTP ' + response.status, durationMs:Date.now()-started};
      const data = await response.json();
      const found = (data.models || []).some(item => item.name === config.model || item.model === config.model);
      return {ok:found, status:found ? 'success' : 'model_not_found', detail:found ? '模型可用：' + config.model : 'Ollama 未找到模型 ' + config.model,
        providerModel:config.model, durationMs:Date.now()-started, models:(data.models || []).map(item => item.name).slice(0,10)};
    }
    const probe = await chat({config, messages:[{role:'user', content:'只输出 {"ok":true}'}], schema:{type:'object', properties:{ok:{type:'boolean'}}, required:['ok']}, timeoutMs:30000, maxTokens:30});
    const parsed = probe.ok ? extractJson(probe.content) : null;
    const structured = parsed?.ok && parsed.value?.ok === true;
    const officialDeepSeek = new URL(config.base_url).hostname === 'api.deepseek.com';
    const modelMatches = !officialDeepSeek || probe.providerModel === config.model;
    const success = Boolean(probe.ok && structured && modelMatches);
    const status = !probe.ok ? probe.status : !structured ? 'invalid_model_output'
      : !modelMatches ? (probe.providerModel ? 'model_mismatch' : 'provider_model_missing') : 'success';
    const detail = !probe.ok ? probe.error : !structured ? '模型响应未通过 JSON 校验，需返回 {"ok":true}'
      : !modelMatches ? '提供方模型标识未匹配：预期 ' + config.model + '，实际 ' + (probe.providerModel || '未提供')
      : '模型返回结构化响应';
    return {ok:success, status, detail,
      requestedModel:config.model, providerModel:probe.providerModel, httpStatus:probe.httpStatus, missing:probe.missing,
      tokensIn:probe.tokensIn, tokensOut:probe.tokensOut, firstTokenMs:probe.firstTokenMs, durationMs:Date.now()-started};
  } catch (failure) {
    return {ok:false, status:'failed', detail:'模型测试失败：' + (failure?.message || 'unknown'), durationMs:Date.now()-started};
  }
}
