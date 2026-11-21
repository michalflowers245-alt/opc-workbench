import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chat, testModel} from '../opc/model.js';
import {createOpcApp} from '../opc/index.js';

const official = {id:'model-deepseek', provider:'compatible', base_url:'https://api.deepseek.com', model:'deepseek-chat'};
const stream = (content, {model='deepseek-chat', crlf=false} = {}) => {
  const separator = crlf ? '\r\n\r\n' : '\n\n';
  return new Response([
    {model, choices:[{delta:{content}}]},
    {model, choices:[], usage:{prompt_tokens:17, completion_tokens:4}},
  ].map(value => 'data: ' + JSON.stringify(value) + separator).join('') + 'data: [DONE]' + separator);
};

test('DeepSeek 使用专属密钥、读取 CRLF 流式用量并校验实际 JSON', async () => {
  const prior = {deepseek:process.env.DEEPSEEK_API_KEY, llm:process.env.LLM_API_KEY, fetch:globalThis.fetch};
  process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-private';
  process.env.LLM_API_KEY = 'fixture-unrelated-provider';
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer fixture-deepseek-private');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'deepseek-chat');
      assert.equal(body.response_format.type, 'json_object');
      return stream('{"ok":true}', {crlf:true});
    };
    const result = await testModel(null, official);
    assert.equal(result.ok, true);
    assert.equal(result.providerModel, 'deepseek-chat');
    assert.equal(result.tokensIn, 17);
    assert.equal(result.tokensOut, 4);
    globalThis.fetch = async () => stream('请求成功但这不是 JSON');
    const invalid = await testModel(null, official);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 'invalid_model_output');
    globalThis.fetch = async () => stream('');
    assert.equal((await testModel(null, official)).ok, false);
    globalThis.fetch = async () => stream('{"ok":true}', {model:null});
    assert.equal((await testModel(null, official)).status, 'provider_model_missing');
    globalThis.fetch = async () => stream('{"ok":true}', {model:'unrequested-model'});
    assert.equal((await testModel(null, official)).status, 'model_mismatch');
  } finally {
    for (const [key, value] of [['DEEPSEEK_API_KEY',prior.deepseek],['LLM_API_KEY',prior.llm]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.fetch = prior.fetch;
  }
});

test('DeepSeek 拒绝请求保存 HTTP 状态并清理提供方回显密钥', async () => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = 'fixture-secret-value';
  try {
    globalThis.fetch = async () => new Response('invalid key fixture-secret-value', {status:401});
    const result = await chat({config:official, messages:[]});
    assert.equal(result.status, 'permission_denied');
    assert.equal(result.httpStatus, 401);
    assert.ok(!JSON.stringify(result).includes('fixture-secret-value'));
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test('重复初始化保留手改模型、附件与提示词测试回执，且新库只初始化文字文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-model-seed-'));
  let app;
  try {
    app = createOpcApp({dataDir:dir});
    const model = app.db.prepare('SELECT * FROM opc_model_configs WHERE id=?').get('model-deepseek');
    assert.equal(model.model, 'deepseek-chat');
    assert.equal(model.is_default, 0);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM opc_employee_skills WHERE relation='initial'").get().n, 83);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM opc_files').get().n, 3);
    app.db.prepare("UPDATE opc_model_configs SET name='经营者编辑',model='custom-chat' WHERE id='model-deepseek'").run();
    app.db.prepare("UPDATE opc_connections SET last_test_status='success',last_receipt_json=? WHERE id='conn-image'").run('{"receiptId":"existing-probe"}');
    const attachment = join(dir, 'opc-files/proj-demo-stand/attachments/product-description.md');
    writeFileSync(attachment, '经营者已编辑的附件');
    app.close();
    app = createOpcApp({dataDir:dir});
    assert.equal(app.db.prepare("SELECT model FROM opc_model_configs WHERE id='model-deepseek'").get().model, 'custom-chat');
    assert.equal(readFileSync(attachment, 'utf8'), '经营者已编辑的附件');
    assert.equal(app.db.prepare("SELECT last_receipt_json FROM opc_connections WHERE id='conn-image'").get().last_receipt_json, '{"receiptId":"existing-probe"}');
    const files = readdirSync(join(dir,'opc-files'), {recursive:true});
    assert.ok(files.every(file => !/\.(png|jpe?g|webp)$/i.test(file)));
  } finally {
    app?.close();
    rmSync(dir, {recursive:true, force:true});
  }
});
