import {randomUUID} from 'node:crypto';
import {secret} from '../secrets.js';

const now = () => new Date().toISOString();

function headersFor(token, sessionId, protocolVersion) {
  const headers = {
    'Content-Type':'application/json',
    'Accept':'application/json, text/event-stream',
    'MCP-Protocol-Version': protocolVersion,
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return headers;
}

async function readRpcResponse(response, expectedId, timeoutMs) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return {parseError:text.slice(0,400)}; }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream:true});
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.id === expectedId || parsed.result || parsed.error) return parsed;
          } catch {}
        }
      }
    }
    return {parseError:'SSE 未在时限内返回匹配响应'};
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

async function rpc({url, token, method, params, id, sessionId, protocolVersion, timeoutMs}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method:'POST', headers: headersFor(token, sessionId, protocolVersion),
      body: JSON.stringify({jsonrpc:'2.0', id, method, params}), redirect:'error', signal: controller.signal,
    });
    const responseSession = response.headers.get('mcp-session-id') || sessionId || null;
    if (!response.ok) {
      const text = await response.text();
      return {httpStatus:response.status, error:'MCP HTTP ' + response.status, body:text.slice(0,500), sessionId:responseSession};
    }
    const payload = await readRpcResponse(response, id, timeoutMs);
    return {httpStatus:response.status, payload, sessionId:responseSession};
  } finally {
    clearTimeout(timer);
  }
}

export async function mcpListTools({url, tokenEnv = 'MCP_ACCESS_TOKEN', timeoutMs = 15000} = {}) {
  const started = Date.now();
  const startedAt = now();
  const receiptId = 'MCP-' + started + '-' + randomUUID().slice(0, 8);
  if (!url) return {ok:false, status:'not_configured', environment:'local', receiptId, startedAt, durationMs:0, error:'缺少 MCP 服务地址', tools:[]};
  const token = secret(tokenEnv);
  const protocolVersion = '2025-11-25';
  try {
    const init = await rpc({url, token, method:'initialize', params:{protocolVersion, capabilities:{}, clientInfo:{name:'opc-workbench', version:'1.0.0'}}, id:1, protocolVersion, timeoutMs});
    if (init.error || init.payload?.error) {
      const error = init.payload?.error?.message || init.error || '初始化失败';
      const status = init.httpStatus === 401 || init.httpStatus === 403 ? 'permission_denied' : 'failed';
      return {ok:false, status, environment:'local', receiptId, startedAt, durationMs:Date.now()-started, error, upstream:{httpStatus:init.httpStatus ?? null, body:init.body ?? null}, tools:[]};
    }
    const sessionId = init.sessionId;
    await fetch(url, {method:'POST', headers:headersFor(token, sessionId, protocolVersion), body:JSON.stringify({jsonrpc:'2.0', method:'notifications/initialized'}), redirect:'error', signal:AbortSignal.timeout(timeoutMs)}).catch(() => null);
    const listed = await rpc({url, token, method:'tools/list', params:{}, id:2, sessionId, protocolVersion, timeoutMs});
    if (listed.error || listed.payload?.error) {
      return {ok:false, status:'failed', environment:'local', receiptId, startedAt, durationMs:Date.now()-started,
        error: listed.payload?.error?.message || listed.error || 'tools/list 失败', upstream:{httpStatus:listed.httpStatus ?? null}, tools:[]};
    }
    const tools = Array.isArray(listed.payload?.result?.tools) ? listed.payload.result.tools : [];
    return {ok:true, status:'success', environment:'local', receiptId, startedAt, durationMs:Date.now()-started,
      sessionId, protocolVersion, serverInfo: init.payload?.result?.serverInfo || null,
      tools: tools.map(tool => ({name:tool.name, description:tool.description || '', inputSchema:tool.inputSchema || null, annotations:tool.annotations || null})),
      data:{toolCount:tools.length}};
  } catch (failure) {
    const timeout = failure?.name === 'AbortError';
    return {ok:false, status: timeout ? 'timeout' : 'failed', environment:'local', receiptId, startedAt,
      durationMs:Date.now()-started, error: timeout ? 'MCP 请求超时' : 'MCP 请求失败：' + (failure?.message || 'unknown'), tools:[]};
  }
}

export async function mcpCallTool({url, tokenEnv = 'MCP_ACCESS_TOKEN', name, arguments: args = {}, timeoutMs = 15000} = {}) {
  const listed = await mcpListTools({url, tokenEnv, timeoutMs});
  if (!listed.ok) return listed;
  const allowed = listed.tools.find(tool => tool.name === name);
  if (!allowed) return {...listed, ok:false, status:'permission_denied', error:'MCP 服务未列出工具 ' + name, called:false};
  const token = secret(tokenEnv);
  try {
    const called = await rpc({url, token, method:'tools/call', params:{name, arguments:args}, id:3, sessionId:listed.sessionId, protocolVersion:listed.protocolVersion, timeoutMs});
    if (called.error || called.payload?.error) {
      return {...listed, ok:false, status:'failed', error: called.payload?.error?.message || called.error || 'MCP 工具调用失败', called:false};
    }
    return {...listed, ok:true, status:'success', called:true, tool:name, arguments:args,
      result: called.payload?.result ?? null, receipt:{sessionId:listed.sessionId, calledAt:now()}};
  } catch (failure) {
    return {...listed, ok:false, status: failure?.name === 'AbortError' ? 'timeout' : 'failed',
      error:'MCP 工具调用失败：' + (failure?.message || 'unknown'), called:false};
  }
}
