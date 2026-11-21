import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOpcApp} from '../opc/index.js';
import {ROLE_SCHEMAS, designPromptPackage} from '../opc/run-schemas.js';

const fixtureModel = async () => ({ok:true,status:'success',provider:'fixture',requestedModel:'fixture',providerModel:'fixture',
  content:JSON.stringify({...ROLE_SCHEMAS['visual-designer'].example,
    main_images:[{index:1,purpose:'未经核验承诺',visual:'杜撰铝合金承重999公斤',copy:'赠送十件次日达',evidence:'模型猜测'}],
    detail_screens:Array.from({length:8},(_,i) => ({index:i+1,purpose:'详情',visual:'杜撰铝合金承重999公斤',copy:'免费赠送十件',evidence:'模型猜测'}))}),
  tokensIn:12,tokensOut:24,firstTokenMs:1,durationMs:2});

function filesUnder(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry => entry.isDirectory() ? filesUnder(join(dir,entry.name)) : [join(dir,entry.name)]);
}

test('美工产物独立交付主图与详情 Markdown/CSV，JSON 与回执一致且没有图片文件', async t => {
  const dataDir=mkdtempSync(join(tmpdir(),'opc-prompt-only-'));
  const app=createOpcApp({dataDir,autoStart:false,modelClient:fixtureModel});
  t.after(() => {app.close();rmSync(dataDir,{recursive:true,force:true});});
  const run=app.runner.createRun({projectId:'proj-demo-stand',employeeSlug:'visual-designer',skuId:'sku-demo-standard',input:{task:'只输出逐图提示词'}});
  const done=await app.runner.executeRun(run.id);
  assert.equal(done.status,'success');
  const output=JSON.parse(done.output_json).output;
  assert.equal(output._meta.image.mode,'prompt_only');
  assert.equal(output._meta.image.generated,0);
  assert.equal(output.main_images.length,5);
  assert.equal(output.detail_screens.length,8);
  for (const row of [...output.main_images,...output.detail_screens]) {
    assert.equal(row.status,'prompt_only');
    assert.equal(row.sku_id,'sku-demo-standard');
    assert.equal(row.width,row.type==='main' ? 800 : 750);
    assert.equal(row.height,row.type==='main' ? 800 : 1000);
    assert.ok(row.headline && row.subline && row.prompt);
    for (const word of ['不生成文字','水印','品牌 logo','检测报告','认证标志','赠品','具体价格','次日达','夸张承重','不改变产品结构']) assert.ok(row.negative.includes(word));
    assert.doesNotMatch(row.prompt,/杜撰铝合金|承重999|免费赠送十件|黑色款|硅胶防滑垫/);
  }
  const artifacts=app.db.prepare('SELECT * FROM opc_artifacts WHERE run_id=?').all(run.id);
  assert.equal(artifacts.some(item => item.kind==='image'),false);
  const files=app.db.prepare('SELECT * FROM opc_files WHERE run_id=?').all(run.id);
  for (const name of ['main-image-prompts.md','main-image-prompts.csv','detail-image-prompts.md','detail-image-prompts.csv']) {
    const file=files.find(item => item.name===name);
    assert.ok(file,name);
    const content=readFileSync(join(app.filesRoot,file.storage_path),'utf8');
    assert.match(content,/SKU/);
    assert.match(content,/负面约束/);
    assert.match(content,/prompt_only/);
  }
  const json=artifacts.find(item => item.kind==='json');
  assert.equal(JSON.parse(json.content).output._meta.image.mode,'prompt_only');
  const receipts=app.db.prepare("SELECT tool_key,response_json FROM opc_tool_receipts WHERE run_id=? AND tool_key LIKE 'image.%'").all(run.id);
  assert.deepEqual(receipts.map(row => row.tool_key),['image.prompt']);
  assert.equal(JSON.parse(receipts[0].response_json).prompts.length,13);
  const action=app.db.prepare("SELECT payload_json FROM opc_actions WHERE run_id=? AND kind='approve_creative'").get(run.id);
  assert.equal(JSON.parse(action.payload_json).artifactIds.length,4);
  assert.equal(filesUnder(dataDir).some(path => /\.(png|jpe?g|webp)$/i.test(path)),false);
  app.db.prepare("UPDATE opc_runs SET status='queued' WHERE id=?").run(run.id);
  const resumed=await app.runner.executeRun(run.id);
  assert.equal(resumed.status,'success');
  assert.equal(JSON.parse(resumed.output_json).output._meta.image.mode,'prompt_only');
  assert.equal(JSON.parse(resumed.output_json).output.main_images[0].status,'prompt_only');
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM opc_artifacts WHERE run_id=?').get(run.id).n,artifacts.length);
});

test('撤销提示词工具授权时停止产物写入，保留等待授权回执',async t => {
  const dataDir=mkdtempSync(join(tmpdir(),'opc-prompt-revoked-'));
  const app=createOpcApp({dataDir,autoStart:false,modelClient:fixtureModel});
  t.after(() => {app.close();rmSync(dataDir,{recursive:true,force:true});});
  app.db.prepare("UPDATE opc_tool_grants SET enabled=0 WHERE employee_id='emp-visual-designer' AND tool_key='image.prompt'").run();
  const run=app.runner.createRun({projectId:'proj-demo-stand',employeeSlug:'visual-designer',skuId:'sku-demo-standard',input:{task:'检查提示词授权'}});
  const done=await app.runner.executeRun(run.id);
  assert.equal(done.status,'awaiting_authorization');
  assert.equal(done.error_code,'image_prompt_not_authorized');
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM opc_artifacts WHERE run_id=?').get(run.id).n,0);
  assert.equal(app.db.prepare("SELECT status FROM opc_tool_receipts WHERE run_id=? AND tool_key='image.prompt'").get(run.id).status,'permission_denied');
});

test('提示词资料仅取已核验商品知识，待核与合成信息不进入已核验事实',() => {
  const output={detail_screens:Array.from({length:10},()=>({}))};
  const context={sku:{id:'sku-real',name:'红色款'},project:{name:'实际商品'}};
  const pack=designPromptPackage(output,context,{knowledge:{items:[
    {id:'fact-good',kind:'商品知识',verification:'verified',body:'原图展示红色外壳',source:'实物照片'},
    {id:'fact-pending',kind:'商品知识',verification:'pending',body:'赠送十件次日达',source:'待核'},
    {id:'fact-demo',kind:'商品知识',verification:'synthetic',body:'承重999公斤',source:'合成演示'},
  ]}});
  assert.equal(pack.main.length,5);
  assert.equal(pack.detail.length,10);
  assert.deepEqual(pack.facts.map(item=>item.id),['fact-good']);
  assert.match(pack.main[0].prompt,/原图展示红色外壳/);
  assert.doesNotMatch(pack.main[0].prompt,/承重999|赠送十件/);
});
