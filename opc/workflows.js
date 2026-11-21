import {mkdirSync, writeFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {ROLE_BY_SLUG} from './constants.js';
import {one, all, insert, update, tx, nowIso, json, parseJson, newId, sha256, audit, logRunEvent} from './db.js';
import {unitEconomics, cny, reportSummary} from './calc.js';

export const WORKFLOW_TEMPLATES = {
  A: { name:'流程 A｜从经营想法到商品上架资料包', steps:[
    ['market','市场判断与验证计划','emp-market-analyst'],
    ['sourcing','1688 找货与利润核算','emp-product-sourcing'],
    ['confirm_sku','经营者确认主推 SKU',null],
    ['copy','卖点提炼与全渠道文案','emp-copywriter'],
    ['design_strategy','两套视觉策略与选择','emp-visual-designer'],
    ['design_assets','五图与详情逐屏出图','emp-visual-designer'],
    ['listing','组装上架资料包',null],
    ['operator_plan','上新与测款运营计划','emp-store-operator'],
  ]},
  B: { name:'流程 B｜从售前咨询转成售后工单', steps:[
    ['presales','售前识别与回复草稿','emp-presales-service'],
    ['ticket','转售后并建工单',null],
    ['aftersales','售后退货分级与方案','emp-aftersales-service'],
    ['approval','补偿/补发动作审核',null],
  ]},
  C: { name:'流程 C｜从数据分析回到下一轮运营', steps:[
    ['data','数据质量、漏斗与利润','emp-data-analyst'],
    ['operator','运营复盘与下一轮动作','emp-store-operator'],
    ['review','经营者确认复盘',null],
  ]},
};

export function createWorkflows({db, runner, actions, filesRoot}) {
  const api = {};

  api.create = function create({projectId, type, name, actor = '本机经营者'}) {
    const template = WORKFLOW_TEMPLATES[type];
    if (!template) throw Object.assign(new Error('未知流程类型'), {status:400});
    const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', projectId);
    if (!project) throw Object.assign(new Error('项目不存在'), {status:404});
    const id = newId('wf');
    tx(db, () => {
      insert(db, 'opc_workflows', {id, project_id:projectId, type, name:name || template.name, status:'draft', current_step:0, created_at:nowIso(), updated_at:nowIso()});
      template.steps.forEach(([key, label, employeeId], index) => {
        insert(db, 'opc_workflow_steps', {
          id:newId('wfs'), workflow_id:id, seq:index+1, key, name:label, employee_id:employeeId,
          status:'pending', run_id:null, depends_on:index ? template.steps[index-1][0] : null, artifact_ref:null,
          note:key === 'confirm_sku' ? '需要经营者选择主推 SKU 后才能继续' : key === 'listing' ? '由系统装配上架资料包并创建发布待审动作' : '', created_at:nowIso(), updated_at:nowIso(),
        });
      });
      audit(db, {projectId, actor, action:'创建流程', objectType:'workflow', objectId:id, detail:{type, name:name || template.name}});
    });
    return api.get(id);
  };

  api.get = function get(id) {
    const workflow = one(db, 'SELECT * FROM opc_workflows WHERE id=?', id);
    if (!workflow) return null;
    const steps = all(db, 'SELECT * FROM opc_workflow_steps WHERE workflow_id=? ORDER BY seq', id).map(step => ({
      ...step,
      employee: step.employee_id ? one(db, 'SELECT slug,name,avatar,color FROM opc_employees WHERE id=?', step.employee_id) : null,
      run: step.run_id ? one(db, 'SELECT id,status,error_code,error_message,created_at,finished_at,provider_model FROM opc_runs WHERE id=?', step.run_id) : null,
      artifact: step.artifact_ref ? one(db, 'SELECT id,title,kind,version,file_id FROM opc_artifacts WHERE id=?', step.artifact_ref) : null,
    }));
    return {...workflow, steps, handoffs:all(db, 'SELECT * FROM opc_handoffs WHERE workflow_id=? ORDER BY created_at', id).map(item => ({...item, payload:parseJson(item.payload_json, null)}))};
  };

  api.list = function list(projectId = null) {
    const rows = projectId ? db.prepare('SELECT * FROM opc_workflows WHERE project_id=? ORDER BY created_at DESC').all(projectId)
      : db.prepare('SELECT * FROM opc_workflows ORDER BY created_at DESC').all();
    return rows.map(row => ({...row, steps:all(db, 'SELECT id,seq,key,name,status,employee_id,run_id,artifact_ref FROM opc_workflow_steps WHERE workflow_id=? ORDER BY seq', row.id)}));
  };

  function upstreamArtifacts(workflowId, step) {
    const previous = all(db, 'SELECT * FROM opc_workflow_steps WHERE workflow_id=? AND seq<? ORDER BY seq DESC', workflowId, step.seq);
    const ids = [];
    for (const item of previous) {
      if (item.artifact_ref) ids.push(item.artifact_ref);
      if (item.run_id) {
        const artifacts = all(db, 'SELECT id FROM opc_artifacts WHERE run_id=? ORDER BY created_at', item.run_id);
        ids.push(...artifacts.map(a => a.id));
      }
    }
    return [...new Set(ids)].slice(0, 8);
  }

  function refreshWorkflow(workflowId) {
    const steps = all(db, 'SELECT * FROM opc_workflow_steps WHERE workflow_id=? ORDER BY seq', workflowId);
    const success = steps.filter(step => step.status === 'success').length;
    update(db, 'opc_workflows', workflowId, {current_step:success, status: success === steps.length ? 'success' : 'running', updated_at:nowIso()});
  }

  api.runStep = async function runStep(workflowId, stepKey, body = {}) {
    const workflow = one(db, 'SELECT * FROM opc_workflows WHERE id=?', workflowId);
    if (!workflow) throw Object.assign(new Error('流程不存在'), {status:404});
    const step = one(db, 'SELECT * FROM opc_workflow_steps WHERE workflow_id=? AND key=?', workflowId, stepKey);
    if (!step) throw Object.assign(new Error('步骤不存在'), {status:404});
    if (step.status === 'running') throw Object.assign(new Error('该步骤正在运行'), {status:409});
    const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', workflow.project_id);
    const latestSku = body.skuId || one(db, 'SELECT id FROM opc_skus WHERE project_id=? ORDER BY price_cents LIMIT 1', workflow.project_id)?.id || null;

    if (!step.employee_id) {
      if (stepKey === 'confirm_sku') {
        if (!body.skuId) throw Object.assign(new Error('请选择主推 SKU'), {status:400});
        const sku = one(db, 'SELECT * FROM opc_skus WHERE id=? AND project_id=?', body.skuId, workflow.project_id);
        if (!sku) throw Object.assign(new Error('SKU 不属于该项目'), {status:400});
        tx(db, () => {
          update(db, 'opc_skus', sku.id, {status:'confirmed', updated_at:nowIso()});
          const product = one(db, 'SELECT * FROM opc_products WHERE id=?', sku.product_id);
          if (product) update(db, 'opc_products', product.id, {status:'confirmed'});
          update(db, 'opc_workflow_steps', step.id, {status:'success', note:'主推 SKU：' + sku.name + '（' + cny(sku.price_cents) + ' 元）', updated_at:nowIso()});
          const next = one(db, 'SELECT * FROM opc_workflow_steps WHERE workflow_id=? AND seq>? ORDER BY seq LIMIT 1', workflowId, step.seq);
          if (next) insert(db, 'opc_handoffs', {id:newId('handoff'), workflow_id:workflowId, from_run_id:null, to_run_id:null, from_employee_id:null, to_employee_id:next.employee_id || null,
            handoff_key:workflowId + ':' + step.key + '->' + next.key, payload_json:json({fromStep:step.key, toStep:next.key, skuId:sku.id, priceCents:sku.price_cents, decidedBy:body.actor || '本机经营者'}), created_at:nowIso()});
          audit(db, {projectId:workflow.project_id, actor:body.actor || '本机经营者', action:'确认主推 SKU', objectType:'sku', objectId:sku.id, detail:{workflowId, step:step.key}});
        });
        refreshWorkflow(workflowId);
        return {kind:'confirmation', skuId:body.skuId, workflow:api.get(workflowId)};
      }
      if (stepKey === 'listing') return api.assembleListing(workflowId, step, body);
      if (stepKey === 'approval') {
        const pending = actions.list({projectId:workflow.project_id, status:'pending', limit:20});
        update(db, 'opc_workflow_steps', step.id, {status:pending.length ? 'pending_review' : 'success', note:pending.length ? '有待审动作：' + pending.map(item => item.title).join('；') : '无需补偿动作', updated_at:nowIso()});
        refreshWorkflow(workflowId);
        return {kind:'approval', pendingActions:pending, workflow:api.get(workflowId)};
      }
      if (stepKey === 'review') {
        const decision = body.decision || 'approve';
        update(db, 'opc_workflow_steps', step.id, {status:decision === 'approve' ? 'success' : 'returned', note:body.note || (decision === 'approve' ? '经营者已确认复盘' : '退回修改'), updated_at:nowIso()});
        audit(db, {projectId:workflow.project_id, actor:body.actor || '本机经营者', action:'流程复盘确认', objectType:'workflow', objectId:workflowId, detail:{decision, note:body.note || ''}});
        refreshWorkflow(workflowId);
        return {kind:'review', decision, workflow:api.get(workflowId)};
      }
      if (stepKey === 'ticket') {
        const ticket = one(db, 'SELECT * FROM opc_tickets WHERE project_id=? ORDER BY updated_at DESC LIMIT 1', workflow.project_id);
        update(db, 'opc_workflow_steps', step.id, {status:'success', note:ticket ? '已关联工单 ' + ticket.id : '暂无工单', updated_at:nowIso()});
        refreshWorkflow(workflowId);
        return {kind:'ticket', ticketId:ticket?.id || null, workflow:api.get(workflowId)};
      }
      throw Object.assign(new Error('该步骤需要人工处理'), {status:400});
    }

    const employee = one(db, 'SELECT * FROM opc_employees WHERE id=?', step.employee_id);
    if (!employee) throw Object.assign(new Error('步骤员工不存在'), {status:404});
    const role = ROLE_BY_SLUG[employee.slug];
    const task = body.task || (stepKey === 'design_strategy'
      ? '为' + project.name + '给出两套 A/B 视觉策略，并说明每套的构图、配色、主卖点和验证指标。'
      : stepKey === 'design_assets'
        ? '基于已确认的视觉策略，为' + project.name + '输出五张主图脚本、7-10 屏详情脚本和逐图出图提示词。'
        : stepKey === 'operator_plan'
          ? '读取上游商品包与经营数据，为' + project.name + '生成上新、测款、推广、活动和复盘计划；涉及改价/预算时只创建待审动作。'
          : role?.taskTitle + '：' + project.name);
    const upstream = upstreamArtifacts(workflowId, step);
    let ticketId = body.ticketId || null;
    if (!ticketId && stepKey === 'presales') {
      ticketId = one(db, "SELECT id FROM opc_tickets WHERE project_id=? AND type=? AND status NOT IN ('closed','resolved') ORDER BY updated_at DESC LIMIT 1", workflow.project_id, '售前咨询')?.id || null;
    }
    if (!ticketId && stepKey === 'aftersales') {
      ticketId = one(db, "SELECT id FROM opc_tickets WHERE project_id=? AND (type LIKE '售后%' OR type=?) AND status NOT IN ('closed','resolved') ORDER BY updated_at DESC LIMIT 1", workflow.project_id, '售后-转交')?.id || null;
    }
    const dedupeBase = 'wf:' + workflowId + ':' + stepKey + ':' + sha256(JSON.stringify({task, upstream, skuId:latestSku})).slice(0, 16);
    const run = runner.createRun({
      projectId:workflow.project_id, employeeSlug:employee.slug, skuId:latestSku || undefined, ticketId,
      workflowId, workflowStepId:step.id, input:{task, note:body.note || '', upstreamArtifactIds:upstream},
      dedupeKey: body.dedupeKey || (body.force ? dedupeBase + ':rerun:' + Date.now() : dedupeBase),
    });
    if (run.deduplicated) {
      const existing = one(db, 'SELECT * FROM opc_runs WHERE id=?', run.id);
      if (existing) {
        update(db, 'opc_workflow_steps', step.id, {status: existing.status === 'success' ? 'success' : existing.status === 'queued' || existing.status === 'running' ? 'running' : 'failed', run_id:run.id, updated_at:nowIso()});
        return {kind:'run', runId:run.id, run:runner.getRun(run.id), workflow:api.get(workflowId), deduplicated:true};
      }
    }
    update(db, 'opc_workflow_steps', step.id, {status:'running', run_id:run.id, updated_at:nowIso()});
    update(db, 'opc_workflows', workflowId, {status:'running', updated_at:nowIso()});
    audit(db, {projectId:workflow.project_id, actor:body.actor || '本机经营者', action:'启动流程步骤', objectType:'run', objectId:run.id, detail:{workflowId, step:stepKey, employee:employee.slug, upstream}});
    return {kind:'run', runId:run.id, run:runner.getRun(run.id), workflow:api.get(workflowId)};
  };

  api.updateStep = function updateStep(workflowId, stepKey, body = {}) {
    const step = one(db, 'SELECT * FROM opc_workflow_steps WHERE workflow_id=? AND key=?', workflowId, stepKey);
    if (!step) throw Object.assign(new Error('步骤不存在'), {status:404});
    const patch = {updated_at:nowIso()};
    if (body.note !== undefined) patch.note = String(body.note).slice(0, 2000);
    if (['needs_info','pending','running'].includes(body.status)) patch.status = body.status;
    update(db, 'opc_workflow_steps', step.id, patch);
    audit(db, {projectId:one(db, 'SELECT project_id FROM opc_workflows WHERE id=?', workflowId)?.project_id, actor:body.actor || '本机经营者', action:'更新流程步骤备注', objectType:'workflow_step', objectId:step.id, detail:{stepKey, note:patch.note, status:patch.status}});
    return api.get(workflowId);
  };

  api.assembleListing = function assembleListing(workflowId, step, body = {}) {
    const workflow = one(db, 'SELECT * FROM opc_workflows WHERE id=?', workflowId);
    const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', workflow.project_id);
    const sku = body.skuId ? one(db, 'SELECT * FROM opc_skus WHERE id=?', body.skuId) : one(db, 'SELECT * FROM opc_skus WHERE project_id=? AND status=?', project.id, 'confirmed') || one(db, 'SELECT * FROM opc_skus WHERE project_id=? ORDER BY price_cents LIMIT 1', project.id);
    const artifacts = all(db, 'SELECT * FROM opc_artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 40', project.id);
    const latest = (role) => artifacts.find(item => item.title.includes(role) && item.kind === 'markdown') || artifacts.find(item => item.kind === 'markdown') || null;
    const market = latest('市场行业分析师');
    const sourcing = latest('选品专家');
    const copy = latest('电商文案专家');
    const design = latest('美工设计师');
    const report = one(db, 'SELECT * FROM opc_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 1', project.id);
    const rows = report ? all(db, 'SELECT * FROM opc_report_rows WHERE report_id=? ORDER BY row_no', report.id).map(row => ({...row, revenueCents:row.revenue_cents, adSpendCents:row.ad_spend_cents, errors:parseJson(row.errors_json, [])})) : [];
    const summary = reportSummary(rows);
    const economics = sku ? unitEconomics({priceCents:sku.price_cents, costCents:sku.cost_cents, shippingCents:sku.shipping_cents, packagingCents:sku.packaging_cents, feeBps:sku.platform_fee_bps, refundCents:sku.refund_cents, adCents:sku.ad_cents, taxCents:sku.tax_cents, discountCents:sku.discount_cents}) : null;
    const clip = (value, limit = 700) => String(value || '').slice(0, limit);
    const content = [
      '# 上架资料包 · ' + project.name,
      '', '- 平台：拼多多', '- 店铺：OPC 演示店（未授权）', '- SKU：' + (sku ? sku.name + '（' + sku.code + '）' : '待确认'), '- 售价：' + (sku ? cny(sku.price_cents) + ' 元' : '待确认'),
      '- 生成时间：' + nowIso(), '- 数据性质：合成演示 / 历史回放 / 真实调用；不得当作真实销量、库存或促销证明。', '',
      '## 1. 商品事实与 SKU', '~~~~json', JSON.stringify(sku ? {name:sku.name, code:sku.code, specs:parseJson(sku.specs_json, {}), price:cny(sku.price_cents), status:sku.status} : null, null, 2), '~~~~', '',
      '## 2. 利润核算（后端确定性）', '~~~~json', JSON.stringify(economics ? {preAd:cny(economics.preAdCents), postAd:cny(economics.postAdCents), rate:economics.preAdRatePct + '%', breakEvenRoas:economics.breakEvenRoas, formulas:economics.formulas} : null, null, 2), '~~~~', '',
      '## 3. 近 7 日推广汇总（合成演示）', '~~~~json', JSON.stringify({impressions:summary.impressions, clicks:summary.clicks, orders:summary.orders, revenue:cny(summary.revenueCents), adSpend:cny(summary.adSpendCents), ctr:summary.metrics.ctrPct + '%', clickCvr:summary.metrics.clickCvrPct + '%', cpc:cny(summary.metrics.cpcCents), roas:summary.metrics.roas}, null, 2), '~~~~', '',
      '## 4. 市场判断（引用 ' + (market?.id || '缺失') + ' v' + (market?.version || '-') + '）', clip(market?.content, 1200) || '缺失', '',
      '## 5. 选品与报价（引用 ' + (sourcing?.id || '缺失') + ' v' + (sourcing?.version || '-') + '）', clip(sourcing?.content, 1200) || '缺失', '',
      '## 6. 文案（引用 ' + (copy?.id || '缺失') + ' v' + (copy?.version || '-') + '）', clip(copy?.content, 1500) || '缺失', '',
      '## 7. 视觉与图片（引用 ' + (design?.id || '缺失') + ' v' + (design?.version || '-') + '）', clip(design?.content, 1400) || '缺失', '',
      '## 8. 物流与售后政策', '- 48 小时内发出（合成演示，待供应商确认）', '- 送达时间以物流为准，不承诺次日达', '- 7 天无理由退换；破损需外箱照与破损近照', '- 退款、补发、发券以审核后的方案为准', '',
      '## 9. 上架前检查', '- [ ] SKU 规格、材质、承重经样品复核', '- [ ] 图片为自有或已授权素材', '- [ ] 文案无极限词与未核实承诺', '- [ ] 价格与利润核算经经营者确认', '- [ ] 发布动作已审批并取得平台回执', '',
      '## 10. 引用索引', ...artifacts.slice(0, 12).map(item => '- ' + item.title + '：' + item.id + ' v' + item.version), '',
      '---', '本资料包未执行任何平台写入；上架需经审批并由拼多多适配器取得第三方回执。',
    ].join('\n');
    const dir = resolve(filesRoot, project.id, 'runs', 'listing-' + workflowId);
    mkdirSync(dir, {recursive:true});
    const path = resolve(dir, 'listing-package.md');
    writeFileSync(path, content, 'utf8');
    const relative = path.slice(filesRoot.length).replace(/^[/\\]/, '');
    const fileId = newId('file');
    insert(db, 'opc_files', {id:fileId, project_id:project.id, sku_id:sku?.id || null, run_id:null, name:'listing-package.md', mime:'text/markdown',
      size:statSync(path).size, sha256:sha256(content), storage_path:relative, access_scope:'project', source:'OPC 上架资料包（系统装配）', created_at:nowIso()});
    const max = one(db, 'SELECT COALESCE(MAX(version),0) AS v FROM opc_artifacts WHERE lineage_key=?', 'artifact:' + project.id + ':listing:package')?.v || 0;
    const artifactId = newId('artifact');
    insert(db, 'opc_artifacts', {id:artifactId, lineage_key:'artifact:' + project.id + ':listing:package', project_id:project.id, sku_id:sku?.id || null, run_id:null,
      kind:'listing', title:'上架资料包 v' + (max + 1), version:max + 1, status:'pending_review', content_type:'text/markdown', content, file_id:fileId,
      evidence_json:json({market:market?.id || null, sourcing:sourcing?.id || null, copy:copy?.id || null, design:design?.id || null, report:report?.id || null, economics}), created_at:nowIso()});
    const actionId = newId('action');
    const payload = {skuId:sku?.id || null, artifactIds:[artifactId, market?.id, sourcing?.id, copy?.id, design?.id].filter(Boolean), priceCents:sku?.price_cents || null, platform:'拼多多'};
    const actionTitle = '上架发布：' + project.name + (sku ? ' · ' + sku.name : '');
    insert(db, 'opc_actions', {id:actionId, project_id:project.id, sku_id:sku?.id || null, run_id:null, kind:'publish_listing', object_type:'artifact', object_id:artifactId,
      title:actionTitle, payload_json:json(payload), amount_cents:null,
      business_impact:'创建拼多多上架待审动作；未授权前不会外发', evidence_json:json({artifactIds:payload.artifactIds, workflowId}),
      version:1, payload_hash:sha256(JSON.stringify({kind:'publish_listing', title:actionTitle, payload, version:1})),
      status:'pending', expires_at:new Date(Date.now() + 24*3600*1000).toISOString(), dedupe_key:'listing:' + workflowId + ':' + artifactId, created_at:nowIso()});
    const runId = newId('run');
    insert(db, 'opc_runs', {id:runId, project_id:project.id, employee_id:null, sku_id:sku?.id || null, workflow_id:workflowId, workflow_step_id:step.id,
      dedupe_key:'system-listing:' + workflowId + ':' + artifactId, mode:'system', status:'success', input_json:json({task:'组装上架资料包'}), context_json:json({system:true}),
      output_json:json({artifact:artifactId, action:actionId, references:payload.artifactIds}), started_at:nowIso(), finished_at:nowIso(), duration_ms:0,
      tokens_in:0, tokens_out:0, tool_calls:0, created_at:nowIso()});
    update(db, 'opc_workflow_steps', step.id, {status:'success', run_id:runId, artifact_ref:artifactId, updated_at:nowIso()});
    refreshWorkflow(workflowId);
    logRunEvent(db, runId, 'finished', {status:'success', artifact:artifactId, action:actionId});
    audit(db, {projectId:project.id, actor:body.actor || '本机经营者', action:'组装上架资料包', objectType:'artifact', objectId:artifactId, detail:{workflowId, actionId}});
    return {kind:'listing', artifactId, actionId, fileId, runId, workflow:api.get(workflowId)};
  };

  api.pause = function pause(workflowId, actor = '本机经营者') {
    update(db, 'opc_workflows', workflowId, {status:'paused', updated_at:nowIso()});
    audit(db, {projectId:one(db, 'SELECT project_id FROM opc_workflows WHERE id=?', workflowId)?.project_id, actor, action:'暂停流程', objectType:'workflow', objectId:workflowId});
    return api.get(workflowId);
  };

  return api;
}
