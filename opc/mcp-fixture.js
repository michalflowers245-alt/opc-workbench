import {createServer} from 'node:http';
import {nowIso} from './db.js';

const PORT = Number(process.env.OPC_MCP_PORT || 4322);
const HOST = process.env.OPC_MCP_HOST || '127.0.0.1';

const TOOLS = [{
  name:'opc_sku_metrics',
  description:'返回本地受信测试服务中的 SKU 推广指标；仅用于工作台 MCP 协议与权限验收，不是第三方经营数据。',
  inputSchema:{type:'object', properties:{sku_id:{type:'string'}}, required:['sku_id']},
  annotations:{readOnlyHint:true, destructiveHint:false, openWorldHint:false},
}];

const SAMPLES = {
  'sku-demo-standard': {sku_id:'sku-demo-standard', impressions:10000, clicks:300, orders:15, ctr:0.03, click_cvr:0.05, roas:3.0, source:'opc-local-mcp', note:'本地受信 MCP 测试服务；合成演示指标'},
  'sku-demo-pro': {sku_id:'sku-demo-pro', impressions:8000, clicks:160, orders:8, ctr:0.02, click_cvr:0.05, roas:2.4, source:'opc-local-mcp', note:'本地受信 MCP 测试服务；合成演示指标'},
};

function reply(id, result) { return {jsonrpc:'2.0', id, result}; }
function failure(id, code, message) { return {jsonrpc:'2.0', id, error:{code, message}}; }

const server = createServer((request, response) => {
  if (request.method !== 'POST' || !request.url.startsWith('/mcp')) {
    response.writeHead(404, {'Content-Type':'application/json'}).end(JSON.stringify({error:'not_found'}));
    return;
  }
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    let message;
    try { message = JSON.parse(body); } catch {
      response.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0', id:null, error:{code:-32700, message:'Parse error'}}));
      return;
    }
    const id = message.id;
    let payload = null;
    if (message.method === 'initialize') {
      payload = reply(id, {protocolVersion:'2025-11-25', capabilities:{tools:{listChanged:false}}, serverInfo:{name:'opc-local-mcp', version:'1.0.0'}});
    } else if (message.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    } else if (message.method === 'tools/list') {
      payload = reply(id, {tools:TOOLS});
    } else if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (name !== 'opc_sku_metrics') payload = failure(id, -32602, 'Unknown tool');
      else if (!args.sku_id || !SAMPLES[args.sku_id]) payload = failure(id, -32602, 'Unknown SKU');
      else payload = reply(id, {content:[{type:'text', text:JSON.stringify({...SAMPLES[args.sku_id], retrieved_at:nowIso(), environment:'local-mcp-fixture'})}], isError:false});
    } else if (message.method === 'ping') {
      payload = reply(id, {});
    } else {
      payload = failure(id, -32601, 'Method not found');
    }
    const text = JSON.stringify(payload);
    response.writeHead(200, {'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(text)}).end(text);
    console.log(nowIso(), message.method, id, message.params?.name || '', argsSku(message.params));
  });
});

function argsSku(params) { return params?.arguments?.sku_id || ''; }

server.listen(PORT, HOST, () => {
  console.log('OPC local MCP fixture listening at http://' + HOST + ':' + PORT + '/mcp');
});
