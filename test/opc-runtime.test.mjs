import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {createOpcApp} from '../opc/index.js';
import {insert, nowIso, sha256} from '../opc/db.js';

const tmp = '/tmp/opc-runtime-' + process.pid;
rmSync(tmp, {recursive:true, force:true});

const badModel = async () => ({ok:true, status:'success', provider:'fake', requestedModel:'fake', providerModel:'fake', content:'这不是 JSON', firstTokenMs:1, durationMs:2, tokensIn:3, tokensOut:4, thinkingChars:0});

test('坏 JSON 保留原始错误与已完成步骤', async () => {
  const app = createOpcApp({dataDir:tmp, autoStart:false, redcoreState:null, modelClient:badModel});
  const run = app.runner.createRun({projectId:'proj-demo-stand', employeeSlug:'copywriter', skuId:'sku-demo-standard', input:{task:'写一条测试文案'}, dedupeKey:'bad-json-' + process.pid});
  const done = await app.runner.executeRun(run.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error_code, 'invalid_model_output');
  assert.match(done.error_message, /JSON|核心字段/);
  assert.ok(done.raw_model_output && done.raw_model_output.length > 0);
  const steps = app.db.prepare('SELECT key,status FROM opc_run_steps WHERE run_id=? ORDER BY seq').all(run.id);
  assert.equal(steps.find(item => item.key === 'validate_input').status, 'success');
  assert.equal(steps.find(item => item.key === 'model_call').status, 'failed');
  app.close();
});

test('重复点击使用同一去重键只创建一次运行', async () => {
  const app = createOpcApp({dataDir:tmp + '-dedupe', autoStart:false, redcoreState:null, modelClient:badModel});
  const payload = {projectId:'proj-demo-stand', employeeSlug:'copywriter', skuId:'sku-demo-standard', input:{task:'写一条测试文案'}, dedupeKey:'click-once-' + process.pid};
  const first = app.runner.createRun(payload);
  const second = app.runner.createRun(payload);
  assert.equal(second.id, first.id);
  assert.equal(second.deduplicated, true);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM opc_runs').get().c, 1);
  app.close();
});

test('失效租约被回收并继续未完成节点', async () => {
  const app = createOpcApp({dataDir:tmp + '-lease', autoStart:false, redcoreState:null, modelClient:badModel});
  const id = 'run-stale-' + process.pid;
  insert(app.db, 'opc_runs', {id, project_id:'proj-demo-stand', employee_id:'emp-copywriter', status:'running', input_json:'{"task":"x"}',
    dedupe_key:'stale-' + process.pid, created_at:nowIso(), started_at:nowIso(), lease_owner:'dead-worker', lease_until:Date.now() - 1000, recoverable:1});
  const count = app.runner.recoverStaleRuns();
  assert.ok(count >= 1);
  const run = app.db.prepare('SELECT status,error_code,error_message FROM opc_runs WHERE id=?').get(id);
  assert.equal(run.status, 'queued');
  assert.equal(run.error_code, 'lease_recovered');
  assert.match(run.error_message, /租约/);
  app.close();
});

test('排队任务取消后不再执行', async () => {
  const app = createOpcApp({dataDir:tmp + '-cancel', autoStart:false, redcoreState:null, modelClient:badModel});
  const run = app.runner.createRun({projectId:'proj-demo-stand', employeeSlug:'copywriter', skuId:'sku-demo-standard', input:{task:'取消测试'}, dedupeKey:'cancel-' + process.pid});
  app.runner.cancelRun(run.id);
  const done = await app.runner.executeRun(run.id);
  assert.equal(done.status, 'cancelled');
  app.close();
});

test('修改动作草稿使旧审批失效并生成新版本', async () => {
  const app = createOpcApp({dataDir:tmp + '-revise', autoStart:false, redcoreState:null, modelClient:badModel});
  const payload = {file:'x.txt'};
  const id = 'action-revise-' + process.pid;
  insert(app.db, 'opc_actions', {id, project_id:'proj-demo-stand', kind:'write_file', title:'改稿测试', payload_json:JSON.stringify(payload),
    version:1, payload_hash:sha256(JSON.stringify({kind:'write_file', title:'改稿测试', payload, version:1})), status:'pending',
    expires_at:new Date(Date.now()+3600000).toISOString(), dedupe_key:'revise-' + process.pid, created_at:nowIso()});
  const next = app.actions.revise(id, {payload:{file:'y.txt'}, note:'修改内容'});
  assert.equal(next.version, 2);
  assert.equal(next.status, 'pending');
  assert.equal(app.db.prepare('SELECT status FROM opc_actions WHERE id=?').get(id).status, 'superseded');
  app.close();
});
