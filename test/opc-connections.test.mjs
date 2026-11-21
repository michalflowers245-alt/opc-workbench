import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pddAuthorizationChecks, pddGoodsSearch} from '../opc/adapters/pdd.js';
import {ali1688Search} from '../opc/adapters/ali1688.js';
import {createOpcApp} from '../opc/index.js';
import {insert, sha256, nowIso} from '../opc/db.js';

function envForTest(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function fetchForTest(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

test('1688 过期凭据在 HTTP 200/401 均标记权限不足并保留 traceId', async t => {
  const key = Buffer.from('x'.repeat(32) + 'fixture-access-id').toString('base64url');
  envForTest(t, {ALI_1688_AK:key});
  let httpStatus = 200;
  let upstreamBody = {success:false, msgCode:'ACCESS_KEY_EXPIRED', message:'expired ' + key, traceId:'fixture-trace'};
  fetchForTest(t, async url => {
    assert.equal(String(url), 'https://skills-gateway.1688.com/api/find_product/1.0.0');
    return new Response(JSON.stringify(upstreamBody), {status:httpStatus});
  });
  for (const status of [200, 401]) {
    httpStatus = status;
    const result = await ali1688Search({query:'验收支架'});
    assert.equal(result.status, 'permission_denied');
    assert.equal(result.data, null);
    assert.equal(result.upstream.traceId, 'fixture-trace');
    assert.match(result.error, /需要新的 ALI_1688_AK/);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  upstreamBody = {success:false, msgCode:'401', code:'ACCESS_KEY_EXPIRED', httpCode:401, traceId:'realistic-trace'};
  const realShape = await ali1688Search({query:'验收支架'});
  assert.equal(realShape.status, 'permission_denied');
  assert.equal(realShape.upstream.code, 'ACCESS_KEY_EXPIRED');
  assert.equal(realShape.upstream.msgCode, '401');
  assert.equal(realShape.upstream.traceId, 'realistic-trace');
  assert.deepEqual(realShape.missing, ['新的 ALI_1688_AK']);
  assert.match(realShape.error, /需要新的 ALI_1688_AK/);
});

test('保存的错误网关会阻止凭据发往其他提供方', async t => {
  fetchForTest(t, async () => { assert.fail('invalid endpoint must not be called'); });
  assert.equal((await ali1688Search({query:'x', baseUrl:'https://example.com'})).status, 'not_configured');
  assert.equal((await pddGoodsSearch({keyword:'x', baseUrl:'https://example.com'})).status, 'not_configured');
});

test('PDD 权限按报表、订单、客服接收发送和测试店铺逐项核对', () => {
  const absent = () => '';
  assert.equal(pddAuthorizationChecks('conn-pdd-store', null, absent)[0].capability, 'store_report');
  const orders = pddAuthorizationChecks('conn-pdd-orders', null, absent);
  assert.deepEqual(orders.map(item => item.capability), ['order_query','customer_receive','customer_send']);
  for (const item of orders) {
    assert.equal(item.status, 'not_configured');
    assert.equal(item.externalExecuted, false);
    assert.ok(item.missing.includes('ECOMMERCE_PDD_ACCESS_TOKEN'));
  }
  const withToken = name => name.startsWith('ECOMMERCE_') ? 'fixture-present' : '';
  const send = pddAuthorizationChecks('conn-pdd-orders', 'customer_send', withToken)[0];
  assert.ok(send.missing.includes('客服发送授权'));
  assert.equal(send.missing.includes('客服接收授权'), false);
  assert.equal(send.externalExecuted, false);
  assert.ok(pddAuthorizationChecks('conn-pdd-write', null, absent)[0].missing.includes('测试店铺授权'));
  assert.equal(pddAuthorizationChecks('conn-pdd-orders', 'store_write', absent), null);
});

test('OPC 连接分项回执、外部动作授权和模型默认切换门禁', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-connection-'));
  const app = createOpcApp({dataDir, autoStart:false, redcoreState:null});
  t.after(() => { app.close(); rmSync(dataDir, {recursive:true, force:true}); });
  let cookie = '', csrf = '';
  const call = async (path, method = 'GET', body) => {
    const headers = {cookie, 'x-opc-csrf':csrf};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.handle(new Request('http://127.0.0.1:4318/api/opc' + path, {method, headers,
      body:body === undefined ? undefined : JSON.stringify(body)}));
    return {status:res.status, headers:res.headers, data:await res.json()};
  };
  const login = await call('/session', 'POST');
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = login.data.csrf;

  const grouped = await call('/connections/conn-pdd-orders/test', 'POST', {});
  assert.equal(grouped.status, 200);
  assert.equal(grouped.data.result.checks.length, 3);
  assert.equal(grouped.data.result.externalExecuted, false);
  assert.ok(grouped.data.result.checks.every(item => item.status === 'not_configured'));
  const selected = await call('/connections/conn-pdd-orders/test', 'POST', {capability:'customer_receive'});
  assert.equal(selected.data.result.checks.length, 1);
  assert.equal(selected.data.result.checks[0].capability, 'customer_receive');
  const persisted = JSON.parse(app.db.prepare('SELECT last_receipt_json FROM opc_connections WHERE id=?').get('conn-pdd-orders').last_receipt_json);
  assert.equal(persisted.checks.length, 3);
  assert.ok(persisted.checks.some(check => check.capability === 'customer_receive'));
  assert.ok(persisted.checks.some(check => check.capability === 'order_query'));
  assert.equal((await call('/connections/conn-pdd-orders/test', 'POST', {capability:'store_write'})).status, 400);

  await call('/connections/conn-pdd-store', 'PATCH', {enabled:false});
  const saved = await call('/connections/conn-pdd-store', 'PATCH', {baseUrl:'https://gw-api.pinduoduo.com/api/router'});
  assert.equal(saved.data.connection.status, 'not_configured');
  assert.equal(saved.data.connection.enabled, 0);

  for (const kind of ['publish_listing','refund','send_customer_message']) {
    const id = 'auth-' + kind;
    const payload = {fixture:true};
    insert(app.db, 'opc_actions', {id, project_id:'proj-demo-stand', kind, title:kind, payload_json:JSON.stringify(payload),
      version:1, amount_cents:123, payload_hash:sha256(JSON.stringify({kind,title:kind,payload,version:1})),
      status:'pending', expires_at:new Date(Date.now()+60_000).toISOString(), dedupe_key:id, created_at:nowIso()});
    const result = await call('/actions/' + id + '/decision', 'POST', {decision:'approve'});
    assert.equal(result.data.action.status, 'awaiting_authorization');
    assert.equal(result.data.action.receipt.externalExecuted, false);
    assert.equal(result.data.action.executed_at, null);
    assert.equal(result.data.action.receipt.approvalBinding.amountCents, 123);
    assert.equal(result.data.action.receipt.approvalBinding.actionId, id);
    assert.equal(result.data.action.receipt.connectionId, kind === 'send_customer_message' ? 'conn-pdd-orders' : 'conn-pdd-write');
  }

  insert(app.db, 'opc_model_configs', {id:'model-test-compatible', name:'fixture model', provider:'compatible',
    base_url:'https://api.deepseek.com', model:'deepseek-chat', enabled:1, is_default:0, updated_at:nowIso()});
  const originalDefault = app.db.prepare('SELECT id FROM opc_model_configs WHERE is_default=1').get().id;
  const refused = await call('/models/model-test-compatible', 'PATCH', {is_default:true});
  assert.equal(refused.status, 409);
  assert.equal(app.db.prepare('SELECT id FROM opc_model_configs WHERE is_default=1').get().id, originalDefault);
  app.db.prepare("UPDATE opc_model_configs SET last_test_status='success' WHERE id='model-test-compatible'").run();
  assert.equal((await call('/models/model-test-compatible', 'PATCH', {is_default:true})).status, 200);
  assert.equal((await call('/models/model-test-compatible', 'PATCH', {model:'unverified-model',is_default:true})).status, 409);
  assert.equal((await call('/models/model-test-compatible', 'PATCH', {model:'unverified-model'})).status, 200);
  assert.equal(app.db.prepare("SELECT last_test_status FROM opc_model_configs WHERE id='model-test-compatible'").get().last_test_status, null);
});
