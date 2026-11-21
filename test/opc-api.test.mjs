import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync, existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createOpcApp} from '../opc/index.js';
import {insert, nowIso, sha256} from '../opc/db.js';

const tmp = '/tmp/opc-test-' + process.pid;
rmSync(tmp, {recursive:true, force:true});

test('OPC API：登录、初始化、核算、导入、审批、跨项目文件、流程装配', async (t) => {
  const app = createOpcApp({dataDir:tmp, autoStart:false, redcoreState:null});
  const base = 'http://127.0.0.1:4318/api/opc';
  const request = async (path, {method='GET', body, cookie='', csrf='', form} = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-opc-csrf'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.handle(new Request(base + path, {method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body))}));
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = {raw:text}; }
    return {status:response.status, data, headers:response.headers};
  };

  const login = await request('/session', {method:'POST'});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = login.data.csrf;
  assert.ok(cookie.startsWith('opc_session='));

  const noAuth = await request('/bootstrap');
  assert.equal(noAuth.status, 401);
  const noCsrf = await request('/projects', {method:'POST', cookie, body:{name:'x'}});
  assert.equal(noCsrf.status, 403);

  const boot = await request('/bootstrap', {cookie});
  assert.equal(boot.status, 200);
  assert.equal(boot.data.counts.employees, 8);
  assert.equal(boot.data.counts.bindings, 83);
  assert.equal(boot.data.employees.length, 8);

  const project = await request('/projects/proj-demo-stand', {cookie});
  assert.equal(project.status, 200);
  const standard = project.data.project.skus.find(item => item.id === 'sku-demo-standard');
  assert.equal(standard.economics.preAdCents, 1201);
  assert.equal(standard.economics.postAdCents, 701);
  assert.ok(project.data.project.files.length >= 3);

  const created = await request('/projects', {method:'POST', cookie, csrf, body:{name:'测试项目', platform:'拼多多', category:'测试', priceMin:19.9, priceMax:29.9, budget:500}});
  assert.equal(created.status, 201);
  const newProjectId = created.data.project.id;
  const sku = await request('/projects/' + newProjectId + '/skus', {method:'POST', cookie, csrf, body:{name:'测试 SKU', code:'T-1', price:29.9, cost:11, shipping:4, packaging:0.5, feeBps:600, refund:0.6, ad:5}});
  assert.equal(sku.status, 201);
  assert.equal(sku.data.sku.economics.preAdCents, 1201);
  assert.equal(sku.data.sku.economics.postAdCents, 701);

  const file = project.data.project.files.find(item => item.mime === 'text/csv');
  const crossProject = await request('/files/' + file.id + '?projectId=' + newProjectId, {cookie});
  assert.equal(crossProject.status, 404);
  const ownFile = await request('/files/' + file.id + '?projectId=proj-demo-stand', {cookie});
  assert.equal(ownFile.status, 200);

  const csv = ['日期,曝光,点击,成交单量,归因销售额,推广费用,访客数','2026-11-10,10000,300,15,450,150,1000','2026-13-40,100,10,1,10,5,10'].join('\n');
  const form = new FormData();
  form.append('file', new Blob([csv], {type:'text/csv'}), 'test-report.csv');
  form.append('projectId', 'proj-demo-stand');
  const preview = await request('/imports/preview', {method:'POST', cookie, csrf, form});
  assert.equal(preview.status, 200);
  assert.equal(preview.data.totals.valid, 1);
  assert.equal(preview.data.totals.invalid, 1);
  const commit = await request('/imports/commit', {method:'POST', cookie, csrf, body:{projectId:'proj-demo-stand', fileId:preview.data.file.id, mapping:preview.data.mapping, name:'测试导入'}});
  assert.equal(commit.status, 200);
  assert.equal(commit.data.duplicate, false);
  const again = await request('/imports/commit', {method:'POST', cookie, csrf, body:{projectId:'proj-demo-stand', fileId:preview.data.file.id, mapping:preview.data.mapping}});
  assert.equal(again.data.duplicate, true);

  const workflow = await request('/workflows', {method:'POST', cookie, csrf, body:{projectId:'proj-demo-stand', type:'A'}});
  assert.equal(workflow.status, 201);
  const workflowId = workflow.data.workflow.id;
  const confirmed = await request('/workflows/' + workflowId + '/steps/confirm_sku/run', {method:'POST', cookie, csrf, body:{skuId:'sku-demo-standard'}});
  assert.equal(confirmed.status, 200);
  const listing = await request('/workflows/' + workflowId + '/steps/listing/run', {method:'POST', cookie, csrf, body:{}});
  assert.equal(listing.status, 200);
  assert.equal(listing.data.kind, 'listing');
  assert.ok(listing.data.artifactId);
  assert.ok(listing.data.actionId);
  const actions = await request('/actions?projectId=proj-demo-stand', {cookie});
  const publish = actions.data.actions.find(item => item.id === listing.data.actionId);
  assert.equal(publish.kind, 'publish_listing');
  assert.equal(publish.status, 'pending');
  const approved = await request('/actions/' + publish.id + '/decision', {method:'POST', cookie, csrf, body:{decision:'approve', note:'测试'}});
  assert.equal(approved.status, 200);
  assert.equal(approved.data.action.status, 'awaiting_authorization');
  assert.equal(approved.data.action.receipt.externalExecuted, false);

  const writePayload = {file:'approval-proof.txt', content:'SAVED-3834'};
  const writeId = 'action-test-write-' + process.pid;
  insert(app.db, 'opc_actions', {id:writeId, project_id:'proj-demo-stand', sku_id:null, run_id:null, kind:'write_file', object_type:'test', object_id:null,
    title:'本地写审批测试', payload_json:JSON.stringify(writePayload), amount_cents:null, business_impact:'本地写入', evidence_json:'{}',
    version:1, payload_hash:sha256(JSON.stringify({kind:'write_file', title:'本地写审批测试', payload:writePayload, version:1})),
    status:'pending', expires_at:new Date(Date.now()+3600000).toISOString(), dedupe_key:'dedupe-write-' + process.pid, created_at:nowIso()});
  const firstApprove = await request('/actions/' + writeId + '/decision', {method:'POST', cookie, csrf, body:{decision:'approve'}});
  assert.equal(firstApprove.status, 200);
  assert.equal(firstApprove.data.action.status, 'executed');
  const proof = resolve(tmp, 'opc-files', 'proj-demo-stand', 'actions', writeId + '.txt');
  assert.ok(existsSync(proof));
  assert.match(readFileSync(proof, 'utf8'), /SAVED-3834/);
  const secondApprove = await request('/actions/' + writeId + '/decision', {method:'POST', cookie, csrf, body:{decision:'approve'}});
  assert.equal(secondApprove.data.duplicate, true);

  const rejectId = 'action-test-reject-' + process.pid;
  insert(app.db, 'opc_actions', {id:rejectId, project_id:'proj-demo-stand', sku_id:null, run_id:null, kind:'write_file', object_type:'test', object_id:null,
    title:'本地拒绝测试', payload_json:'{"file":"reject.txt"}', amount_cents:null, business_impact:'本地写入', evidence_json:'{}',
    version:1, payload_hash:sha256(JSON.stringify({kind:'write_file', title:'本地拒绝测试', payload:{file:'reject.txt'}, version:1})),
    status:'pending', expires_at:new Date(Date.now()+3600000).toISOString(), dedupe_key:'dedupe-reject-' + process.pid, created_at:nowIso()});
  const rejected = await request('/actions/' + rejectId + '/decision', {method:'POST', cookie, csrf, body:{decision:'reject', note:'不允许'}});
  assert.equal(rejected.data.action.status, 'rejected');
  assert.equal(existsSync(resolve(tmp, 'opc-files', 'proj-demo-stand', 'actions', rejectId + '.txt')), false);

  app.close();
});
