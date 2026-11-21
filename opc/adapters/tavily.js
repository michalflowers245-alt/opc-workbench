import {randomUUID} from 'node:crypto';
import {secret, missing} from '../secrets.js';

const now = () => new Date().toISOString();

export async function tavilySearch({query, maxResults = 5, timeoutMs = 20000} = {}) {
  const started = Date.now();
  const startedAt = now();
  const receiptId = 'TAV-' + started + '-' + randomUUID().slice(0, 8);
  const missingParams = missing(['TAVILY_API_KEY']);
  if (missingParams.length) {
    return {ok:false, status:'not_configured', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      error:'缺少参数：TAVILY_API_KEY', missing:missingParams, request:{query}, data:null};
  }
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({api_key:secret('TAVILY_API_KEY'), query:String(query || '').slice(0,400), max_results:Math.max(1, Math.min(10, maxResults)), search_depth:'basic', include_answer:false}),
      redirect:'error', signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    if (!response.ok) {
      return {ok:false, status: response.status === 401 || response.status === 403 ? 'permission_denied' : response.status === 429 ? 'rate_limited' : 'failed',
        environment:'real', receiptId, startedAt, durationMs:Date.now()-started, error:'Tavily HTTP ' + response.status,
        upstream:{httpStatus:response.status, body:text.slice(0,500)}, request:{query}, data:null};
    }
    if (!Array.isArray(payload?.results)) {
      return {ok:false, status:'failed', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
        error:'Tavily 返回结构异常', upstream:{httpStatus:response.status, body:text.slice(0,300)}, request:{query}, data:null};
    }
    return {ok:true, status:'success', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      data:{platform:'tavily', query, retrievedAt:startedAt,
        results:payload.results.slice(0, maxResults).map(item => ({title:item.title || null, url:item.url || null, content:typeof item.content === 'string' ? item.content.slice(0,1200) : null, score:item.score ?? null})),
        dataScope:'公开网页搜索摘要；不包含平台后台经营数据，采用前需回查原始页面。'},
      request:{query}};
  } catch (failure) {
    const timeout = failure?.name === 'TimeoutError' || failure?.name === 'AbortError';
    return {ok:false, status: timeout ? 'timeout' : 'failed', environment:'real', receiptId, startedAt,
      durationMs:Date.now()-started, error: timeout ? 'Tavily 请求超时' : 'Tavily 请求失败：' + (failure?.message || 'unknown'),
      request:{query}, data:null};
  }
}
