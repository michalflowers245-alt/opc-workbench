import {mkdirSync, writeFileSync, readFileSync, existsSync, statSync} from 'node:fs';
import {resolve, basename} from 'node:path';
import {ROLE_BY_SLUG, ACTION_KINDS} from './constants.js';
import {one, all, insert, update, tx, nowIso, json, parseJson, newId, sha256, audit, logRunEvent} from './db.js';
import {unitEconomics, metrics as computeMetrics, reportSummary, cny, complianceCheck} from './calc.js';
import {chat, extractJson, resolveModel, validateShape} from './model.js';
import {schemaPrompt, validateRoleOutput, renderMarkdown, expandDesignOutput, designPromptPackage, ROLE_SCHEMAS, ROLE_SECTIONS, sectionShape} from './run-schemas.js';
import {pddGoodsSearch} from './adapters/pdd.js';
import {ali1688Search} from './adapters/ali1688.js';
import {tavilySearch} from './adapters/tavily.js';
import {mcpCallTool} from './adapters/mcp.js';
import {redact} from './secrets.js';

const truncate = (value, limit = 600) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? text.slice(0, limit) + '…' : text;
};

class RunError extends Error {
  constructor(code, message, {status = 'failed', recoverable = true, detail = null} = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.recoverable = recoverable;
    this.detail = detail;
  }
}

function toJsonSchema(shape) {
  const properties = {};
  const required = [];
  for (const [key, rule] of Object.entries(shape || {})) {
    if (rule.type === 'array') properties[key] = {type:'array', items:{type:'string'}};
    else if (rule.type === 'object') properties[key] = {type:'object'};
    else properties[key] = {type:rule.type || 'string'};
    if (rule.required) required.push(key);
  }
  return {type:'object', properties, required};
}

function safeName(name) {
  return String(name || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
}

export function createRunner({db, filesRoot, dataDir, modelClient = chat, workerId = 'worker-' + process.pid}) {
  const api = {};

  function receipt(run, toolKey, request, result, {environment = 'local', startedAt = null} = {}) {
    const id = newId('tool');
    const durationMs = result?.durationMs ?? null;
    insert(db, 'opc_tool_receipts', {
      id, run_id: run.id, employee_id: run.employee_id, tool_key: toolKey,
      request_json: json(redact(request)), response_json: json(redact(result?.result !== undefined ? {tool:result.tool, arguments:result.arguments, result:result.result, serverInfo:result.serverInfo} : (result?.data ?? result ?? null))),
      status: result?.status || (result?.ok ? 'success' : 'failed'), environment: result?.environment || environment,
      duration_ms: durationMs, receipt_id: result?.receiptId || null, error: result?.error || null,
      created_at: startedAt || nowIso(),
    });
    logRunEvent(db, run.id, 'tool_receipt', {tool:toolKey, status:result?.status || (result?.ok ? 'success' : 'failed'), receiptId:result?.receiptId || null});
    return {id, tool_key:toolKey, status:result?.status || (result?.ok ? 'success' : 'failed'), environment:result?.environment || environment, receipt_id:result?.receiptId || null, duration_ms:durationMs};
  }

  function setRun(runId, patch) {
    update(db, 'opc_runs', runId, patch);
  }

  async function step(run, key, name, fn) {
    const existing = one(db, 'SELECT * FROM opc_run_steps WHERE run_id=? AND key=? ORDER BY seq DESC LIMIT 1', run.id, key);
    if (existing?.status === 'success') {
      logRunEvent(db, run.id, 'step_resumed', {key, name});
      return parseJson(existing.output_json, {});
    }
    let seq = existing?.seq;
    if (!seq) seq = (one(db, 'SELECT COALESCE(MAX(seq),0) AS n FROM opc_run_steps WHERE run_id=?', run.id)?.n || 0) + 1;
    const id = existing?.id || newId('step');
    if (existing) update(db, 'opc_run_steps', id, {status:'running', error:null, started_at:nowIso(), finished_at:null});
    else insert(db, 'opc_run_steps', {id, run_id:run.id, seq, key, name, status:'running', input_json:null, output_json:null, error:null, started_at:nowIso(), finished_at:null});
    logRunEvent(db, run.id, 'step_started', {key, name, seq});
    try {
      const output = await fn();
      update(db, 'opc_run_steps', id, {status:'success', output_json:json(output ?? null), error:null, finished_at:nowIso()});
      logRunEvent(db, run.id, 'step_finished', {key, name, status:'success'});
      return output;
    } catch (failure) {
      update(db, 'opc_run_steps', id, {status:'failed', error:truncate(failure.message, 1800), finished_at:nowIso()});
      logRunEvent(db, run.id, 'step_failed', {key, name, error:truncate(failure.message, 800), code:failure.code || null});
      throw failure;
    }
  }

  function assertActive(runId) {
    const current = one(db, 'SELECT status FROM opc_runs WHERE id=?', runId);
    if (current?.status === 'cancelled') throw new RunError('cancelled', '运行已取消', {status:'cancelled', recoverable:false});
  }

  api.createRun = function createRun(payload) {
    const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', payload.projectId);
    if (!project) throw Object.assign(new Error('项目不存在'), {status:404});
    const employee = payload.employeeSlug ? one(db, 'SELECT * FROM opc_employees WHERE slug=?', payload.employeeSlug) : null;
    if (payload.employeeSlug && !employee) throw Object.assign(new Error('员工不存在'), {status:404});
    const sku = payload.skuId ? one(db, 'SELECT * FROM opc_skus WHERE id=? AND project_id=?', payload.skuId, project.id) : null;
    if (payload.skuId && !sku) throw Object.assign(new Error('SKU 不属于该项目'), {status:400});
    if (payload.ticketId) {
      const ticket = one(db, 'SELECT * FROM opc_tickets WHERE id=? AND project_id=?', payload.ticketId, project.id);
      if (!ticket) throw Object.assign(new Error('工单不属于该项目'), {status:400});
    }
    if (!employee && payload.mode !== 'system') throw Object.assign(new Error('缺少员工'), {status:400});
    const input = payload.input || {};
    if (typeof input.task !== 'string' || !input.task.trim()) throw Object.assign(new Error('任务说明不能为空'), {status:400});
    const upstream = payload.upstreamArtifactIds || [];
    const baseKey = payload.dedupeKey || sha256(JSON.stringify({
      projectId:project.id, employee:employee?.slug || 'system', skuId:sku?.id || null, ticketId:payload.ticketId || null,
      workflowId:payload.workflowId || null, step:payload.workflowStepId || null, task:input.task, upstream,
    }));
    const existing = one(db, 'SELECT * FROM opc_runs WHERE dedupe_key=?', baseKey);
    if (existing) return {...existing, deduplicated:true};
    const mind = employee ? one(db, 'SELECT * FROM opc_employee_minds WHERE employee_id=? AND version=?', employee.id, employee.mind_version) : null;
    const skills = employee ? all(db, 'SELECT s.slug,s.name,s.version,s.package_path,s.install_status,es.relation,es.binding_index FROM opc_employee_skills es JOIN opc_skills s ON s.id=es.skill_id WHERE es.employee_id=? ORDER BY es.binding_index IS NULL, es.binding_index', employee.id) : [];
    const grants = employee ? all(db, 'SELECT tool_key,level,enabled FROM opc_tool_grants WHERE employee_id=? ORDER BY tool_key', employee.id) : [];
    const model = employee ? resolveModel(db, employee) : {config:null};
    const context = {
      employee: employee ? {id:employee.id, slug:employee.slug, name:employee.name, role_key:employee.role_key,
        mind_version:employee.mind_version, mind_text:mind?.runtime_text || '', model_id:employee.model_id,
        context_rounds:employee.context_rounds, tool_limit:employee.tool_limit, timeout_ms:employee.timeout_ms,
        daily_token_limit:employee.daily_token_limit, redcore_agent_id:employee.redcore_agent_id} : null,
      model: model.config ? {id:model.config.id, provider:model.config.provider, base_url:model.config.base_url, model:model.config.model, name:model.config.name} : null,
      fallback_from: model.fallbackFrom,
      skills: skills.map(item => ({slug:item.slug, name:item.name, version:item.version, path:item.package_path, install_status:item.install_status, relation:item.relation, binding_index:item.binding_index})),
      grants,
      project: {id:project.id, name:project.name, platform:project.platform, category:project.category, audience:project.audience,
        price_min_cents:project.price_min_cents, price_max_cents:project.price_max_cents, budget_cents:project.budget_cents,
        fulfillment:project.fulfillment, constraints:project.constraints, is_demo:project.is_demo},
      sku: sku ? {id:sku.id, name:sku.name, code:sku.code, specs:parseJson(sku.specs_json,{}), price_cents:sku.price_cents,
        cost_cents:sku.cost_cents, shipping_cents:sku.shipping_cents, packaging_cents:sku.packaging_cents,
        fee_bps:sku.platform_fee_bps, refund_cents:sku.refund_cents, ad_cents:sku.ad_cents, tax_cents:sku.tax_cents,
        discount_cents:sku.discount_cents} : null,
      upstream_artifact_ids: upstream,
    };
    const id = newId('run');
    insert(db, 'opc_runs', {
      id, project_id:project.id, employee_id:employee?.id || null, sku_id:sku?.id || null, ticket_id:payload.ticketId || null,
      workflow_id:payload.workflowId || null, workflow_step_id:payload.workflowStepId || null, dedupe_key:baseKey,
      mode:payload.mode || 'employee', status:'queued', input_json:json(input), context_json:json(context),
      model_id:model.config?.id || null, mind_version:employee?.mind_version || null,
      skills_json:json(context.skills), tool_grants_json:json(grants), upstream_json:json(upstream),
      recoverable:1, created_at:nowIso(),
    });
    logRunEvent(db, id, 'queued', {employee:employee?.slug || 'system', mode:payload.mode || 'employee'});
    audit(db, {projectId:project.id, actor:payload.actor || '本机经营者', action:'创建运行', objectType:'run', objectId:id,
      detail:{employee:employee?.slug || 'system', task:truncate(input.task, 300), dedupeKey:baseKey}});
    return one(db, 'SELECT * FROM opc_runs WHERE id=?', id);
  };

  async function prefetchTools(run, context) {
    const role = run.employee_id ? ROLE_BY_SLUG[context.employee.slug] : null;
    const grants = new Map(context.grants.map(grant => [grant.tool_key, grant]));
    const can = (tool) => Boolean(grants.get(tool)?.enabled);
    const toolResults = {};
    const receipts = [];
    const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', run.project_id);
    const sku = run.sku_id ? one(db, 'SELECT * FROM opc_skus WHERE id=?', run.sku_id) : null;
    const input = parseJson(run.input_json, {});
    const knowledge = all(db, "SELECT id,kind,title,body,source,verification_status,last_verified_at FROM opc_knowledge WHERE project_id=? AND (sku_id IS NULL OR sku_id=?) ORDER BY CASE verification_status WHEN 'verified' THEN 0 WHEN 'synthetic' THEN 1 ELSE 2 END, created_at DESC LIMIT 12", run.project_id, run.sku_id || '');
    const report = one(db, "SELECT * FROM opc_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 1", run.project_id);
    const reportRows = report ? all(db, 'SELECT * FROM opc_report_rows WHERE report_id=? ORDER BY row_no', report.id).map(row => ({
      ...row, revenueCents:row.revenue_cents, adSpendCents:row.ad_spend_cents, errors:parseJson(row.errors_json, []),
    })) : [];

    const addLocal = (tool, request, data) => {
      if (!can(tool)) { const result = {ok:false, status:'permission_denied', error:'该工具未获授权', environment:'local'}; receipts.push(receipt(run, tool, request, result)); return null; }
      const result = {ok:true, status:'success', environment:'local', data};
      receipts.push(receipt(run, tool, request, result));
      return data;
    };

    if (Array.isArray(input.attachmentIds) && input.attachmentIds.length) {
      const files = input.attachmentIds.map(id => one(db, 'SELECT * FROM opc_files WHERE id=?', id)).filter(Boolean);
      const attachments = files.map(file => {
        let text = null;
        if (['text/plain','text/csv','text/markdown','application/json'].includes(file.mime)) {
          try { text = readFileSync(resolve(filesRoot, file.storage_path), 'utf8').slice(0, 4000); } catch {}
        }
        return {id:file.id, name:file.name, mime:file.mime, size:file.size, sha256:file.sha256, text};
      });
      if (can('file.read')) toolResults.attachments = addLocal('file.read', {fileIds:input.attachmentIds}, {attachments});
    }
    if (can('knowledge.search')) {
      const data = {items:knowledge.map(item => ({id:item.id, kind:item.kind, title:item.title, body:truncate(item.body, 320), source:item.source, verification:item.verification_status, lastVerifiedAt:item.last_verified_at}))};
      toolResults.knowledge = addLocal('knowledge.search', {projectId:run.project_id, skuId:run.sku_id}, data);
    }
    if (can('project.read')) toolResults.project = addLocal('project.read', {projectId:run.project_id}, {project:{...project}});
    if (can('sku.read') && sku) toolResults.sku = addLocal('sku.read', {skuId:sku.id}, {sku:{...sku, specs:parseJson(sku.specs_json,{})}});

    if (can('market.search')) {
      const query = input.searchQuery || [project.category, project.platform, '市场规模 价格带 竞争'].filter(Boolean).join(' ');
      const result = await tavilySearch({query, maxResults:5});
      receipts.push(receipt(run, 'market.search', {query}, result));
      toolResults.market = result.ok ? result.data : {error:result.error, status:result.status};
    }

    if (can('pdd.search')) {
      const queries = role?.slug === 'product-sourcing'
        ? ['折叠桌面手机支架', '桌面手机支架 折叠 铝合金', '手机支架 桌面 便携 折叠']
        : [input.pddQuery || project.category || '折叠桌面手机支架'];
      const collected = [];
      const attempts = [];
      for (const query of queries) {
        const result = await pddGoodsSearch({keyword:query, pageSize:10});
        receipts.push(receipt(run, 'pdd.search', {query}, result));
        attempts.push({query, ok:result.ok, status:result.status, receiptId:result.receiptId, totalCount:result.data?.totalCount ?? null, error:result.error || null});
        if (result.ok) collected.push(...result.data.items);
      }
      const deduped = new Map();
      for (const item of collected) if (item?.product_id && !deduped.has(item.product_id)) deduped.set(item.product_id, item);
      toolResults.pdd = {queries, attempts, uniqueCount:deduped.size, items:[...deduped.values()].slice(0, 12),
        dataScope:'多多进宝推广商品；价格单位为元；销量提示统计周期未知。'};
    }

    if (can('ali1688.search')) {
      const queries = ['折叠桌面手机支架 一件代发', '桌面手机支架 折叠 白色 裸装', '手机支架 折叠 桌面 铝合金'];
      const attempts = [];
      const collected = [];
      for (const query of queries) {
        const result = await ali1688Search({query, limit:10});
        receipts.push(receipt(run, 'ali1688.search', {query}, result));
        attempts.push({query, ok:result.ok, status:result.status, receiptId:result.receiptId, error:result.error || null, upstream:result.upstream || null});
        if (result.ok) collected.push(...result.data.items);
      }
      const deduped = new Map();
      for (const item of collected) if (item?.product_id && !deduped.has(item.product_id)) deduped.set(item.product_id, item);
      const historical = all(db, 'SELECT q.*, s.name AS supplier_name FROM opc_quotes q LEFT JOIN opc_suppliers s ON s.id=q.supplier_id JOIN opc_products p ON p.id=q.product_id WHERE p.project_id=? AND q.verification_status=? ORDER BY q.unit_price_cents ASC LIMIT 8', run.project_id, 'historical').map(row => ({
        quote_id:row.id, item_id:row.item_id, sku_ref:row.sku_ref, spec_text:row.spec_text, unit_price_cents:row.unit_price_cents,
        qty_min:row.qty_min, shipping_cents:row.shipping_cents, supplier:row.supplier_name, source:row.source, retrieved_at:row.retrieved_at, verification:row.verification_status,
      }));
      toolResults.ali1688 = {queries, attempts, uniqueCount:deduped.size, items:[...deduped.values()].slice(0,12), historical,
        note:attempts.every(item => !item.ok) ? '实时 1688 连接失败；历史回放报价单独标注，不等于本次回执。' : '实时 1688 返回与历史回放分开保存。'};
    }

    if (can('pdd.report.read') && report) {
      const summary = reportSummary(reportRows);
      toolResults.report = addLocal('pdd.report.read', {projectId:run.project_id, reportId:report.id}, {
        report:{id:report.id, name:report.name, kind:report.kind, period_start:report.period_start, period_end:report.period_end, channel:report.channel, metric_definitions:parseJson(report.metric_definitions_json,{})},
        rows:reportRows.map(row => ({row_no:row.row_no, date:row.date, impressions:row.impressions, clicks:row.clicks, orders:row.orders, revenueCents:row.revenue_cents, adSpendCents:row.ad_spend_cents, visitors:row.visitors, errors:row.errors, status:row.status})),
        summary:{impressions:summary.impressions, clicks:summary.clicks, orders:summary.orders, revenueCents:summary.revenueCents, adSpendCents:summary.adSpendCents, visitors:summary.visitors, validRows:summary.validRows, invalidRows:summary.invalidRows, metrics:summary.metrics},
      });
    }

    const skus = all(db, 'SELECT * FROM opc_skus WHERE project_id=? ORDER BY price_cents DESC', run.project_id);
    const economics = {};
    for (const item of skus) {
      economics[item.id] = unitEconomics({
        priceCents:item.price_cents, costCents:item.cost_cents, shippingCents:item.shipping_cents,
        packagingCents:item.packaging_cents, feeBps:item.platform_fee_bps, refundCents:item.refund_cents,
        adCents:item.ad_cents, taxCents:item.tax_cents, discountCents:item.discount_cents,
      });
    }
    if (can('calc.unit_economics')) {
      toolResults.economics = addLocal('calc.unit_economics', {skuIds:skus.map(item => item.id)}, {unitEconomics:economics});
    }

    if (can('calc.metrics') && report) {
      const summary = reportSummary(reportRows);
      toolResults.metrics = addLocal('calc.metrics', {reportId:report.id}, summary.metrics);
    }

    if (can('mcp.call')) {
      const connection = one(db, "SELECT * FROM opc_connections WHERE id='conn-mcp'");
      const config = parseJson(connection?.config_json, {});
      if (!connection?.enabled || !config.url) {
        const result = {ok:false, status:'not_configured', environment:'local', error:'MCP 服务地址未配置', tools:[]};
        receipts.push(receipt(run, 'mcp.call', {url:null, tool:'opc_sku_metrics'}, result));
        toolResults.mcp = {error:result.error, status:result.status};
      } else {
        const result = await mcpCallTool({url:config.url, tokenEnv:config.tokenEnv || 'MCP_ACCESS_TOKEN', name:'opc_sku_metrics', arguments:{sku_id:run.sku_id || sku?.id || null}});
        receipts.push(receipt(run, 'mcp.call', {url:config.url, tool:'opc_sku_metrics'}, result));
        toolResults.mcp = result.ok ? {tool:result.tool, result:result.result, serverInfo:result.serverInfo, tools:result.tools.map(tool => tool.name)} : {error:result.error, status:result.status, tools:result.tools};
      }
    }

    if (can('ticket.read') && run.ticket_id) {
      const ticket = one(db, 'SELECT * FROM opc_tickets WHERE id=?', run.ticket_id);
      toolResults.ticket = addLocal('ticket.read', {ticketId:run.ticket_id}, ticket ? {...ticket, evidence:parseJson(ticket.evidence_json,[]), pending_facts:parseJson(ticket.pending_facts_json,[])} : {error:'工单不存在'});
    }

    const upstreamIds = [...new Set([...(parseJson(run.upstream_json, []) || []), ...(input.upstreamArtifactIds || [])])];
    if (upstreamIds.length) {
      toolResults.upstream = addLocal('file.read', {artifactIds:upstreamIds}, {artifacts:upstreamIds.map(id => {
        const artifact = one(db, 'SELECT * FROM opc_artifacts WHERE id=?', id);
        return artifact ? {id:artifact.id, title:artifact.title, kind:artifact.kind, version:artifact.version, excerpt:truncate(artifact.content, 900)} : {id, error:'产物不存在'};
      })});
    } else {
      const refreshed = all(db, "SELECT * FROM opc_artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 8", run.project_id);
      toolResults.upstream = {artifacts:refreshed.map(item => ({id:item.id, title:item.title, kind:item.kind, version:item.version, excerpt:truncate(item.content, 500)}))};
    }
    return {toolResults, receipts, knowledge, report, reportRows, economics};
  }

  function buildMessages(run, context, prefetched) {
    const role = ROLE_BY_SLUG[context.employee.slug];
    const project = context.project;
    const sku = context.sku;
    const input = parseJson(run.input_json, {});
    const system = [
      context.employee.mind_text,
      '规则：只用输入、已核验知识和工具回执；合成演示/历史回放不得写成真实销量、库存、促销或承诺；金额、费率、转化率、ROAS 以后端核算为准；不得声称已执行外部动作；未知写“待核”。只输出 JSON，不要解释。',
    ].join('\n');
    const knowledge = (prefetched.knowledge || []).slice(0,5).map(item => '[' + item.verification_status + '] ' + item.title + '：' + truncate(item.body, 140)).join('\n');
    const primaryEconomics = context.sku ? prefetched.economics?.[context.sku.id] : Object.values(prefetched.economics || {})[0];
    const metricsFlat = prefetched.toolResults.metrics ? {ctrPct:prefetched.toolResults.metrics.ctrPct, clickCvrPct:prefetched.toolResults.metrics.clickCvrPct, cpcCents:prefetched.toolResults.metrics.cpcCents, roas:prefetched.toolResults.metrics.roas} : null;
    const toolSummary = {
      pdd: prefetched.toolResults.pdd ? {queries:prefetched.toolResults.pdd.queries, uniqueCount:prefetched.toolResults.pdd.uniqueCount, items:prefetched.toolResults.pdd.items.slice(0,4).map(item => ({id:item.product_id,title:truncate(item.title,50),price:item.group_price_cny}))} : null,
      ali1688: prefetched.toolResults.ali1688 ? {attempts:prefetched.toolResults.ali1688.attempts.map(item => ({query:item.query,ok:item.ok,status:item.status,error:truncate(item.error || '',80)})), historical:prefetched.toolResults.ali1688.historical.slice(0,3)} : null,
      market: prefetched.toolResults.market?.results ? prefetched.toolResults.market.results.slice(0,2).map(item => ({title:truncate(item.title,80),url:item.url,content:truncate(item.content,160)})) : prefetched.toolResults.market || null,
      report: prefetched.toolResults.report ? {period:prefetched.toolResults.report.report.period_start + '~' + prefetched.toolResults.report.report.period_end, totals:{impressions:prefetched.toolResults.report.summary.impressions,clicks:prefetched.toolResults.report.summary.clicks,orders:prefetched.toolResults.report.summary.orders,revenue:prefetched.toolResults.report.summary.revenueCents/100,spend:prefetched.toolResults.report.summary.adSpendCents/100,visitors:prefetched.toolResults.report.summary.visitors,invalidRows:prefetched.toolResults.report.summary.invalidRows}} : null,
      mcp: prefetched.toolResults.mcp ? truncate(prefetched.toolResults.mcp, 500) : null,
      ticket: prefetched.toolResults.ticket ? {id:prefetched.toolResults.ticket.id,type:prefetched.toolResults.ticket.type,message:truncate(prefetched.toolResults.ticket.original_message,200),evidence:truncate(prefetched.toolResults.ticket.evidence,300)} : null,
      attachments: (prefetched.toolResults.attachments?.attachments || []).slice(0,3).map(item => ({name:item.name,mime:item.mime,text:truncate(item.text || '', 500)})),
      upstream: (prefetched.toolResults.upstream?.artifacts || []).slice(0,2).map(item => ({title:item.title,version:item.version,excerpt:truncate(item.excerpt,200)})),
    };
    const user = [
      '项目:' + JSON.stringify({name:project.name, platform:project.platform, category:project.category, audience:project.audience, budget:project.budget_cents ? project.budget_cents/100 : null, fulfillment:project.fulfillment, constraints:project.constraints}),
      'SKU:' + JSON.stringify(sku ? {name:sku.name, code:sku.code, specs:sku.specs, price:sku.price_cents/100, cost:sku.cost_cents/100, shipping:sku.shipping_cents/100, packaging:sku.packaging_cents/100, feeBps:sku.fee_bps, refund:sku.refund_cents/100, ad:sku.ad_cents/100} : null),
      '知识:' + (knowledge || '无'),
      '工具:' + truncate(JSON.stringify(toolSummary), 1800),
      '核算:' + JSON.stringify(primaryEconomics ? {preAd:cny(primaryEconomics.preAdCents),postAd:cny(primaryEconomics.postAdCents),rate:primaryEconomics.preAdRatePct,breakEvenRoas:primaryEconomics.breakEvenRoas,platformFee:cny(primaryEconomics.platformFeeCents),metrics:metricsFlat} : {metrics:metricsFlat}),
      '任务:' + truncate(input.task || '', 500),
      '补充:' + truncate(input.note || '', 200),
      '只输出 JSON；字段简短；数组最多3项；不要复述输入。',
    ].join('\n');
    return {system, user, messages:[{role:'system', content:system}, {role:'user', content:user}]};
  }


function fillMissing(role, output, context, prefetched, notes) {
  const filled = (path) => notes.push(path + ' 缺失，已按确定性输入或工具结果补足');
  const add = (condition, apply, label) => { if (condition) { apply(); filled(label); } };
  const project = context.project;
  const sku = context.sku;
  const priceBand = project.price_min_cents && project.price_max_cents ? (project.price_min_cents/100) + '-' + (project.price_max_cents/100) + ' 元' : '待核';
  const economics = context.sku ? prefetched.economics?.[context.sku.id] : null;
  const metric = prefetched.toolResults?.metrics || null;
  const report = prefetched.toolResults?.report?.summary || null;
  if (role === 'market-analyst') {
    add(!output.segments || !output.segments.length, () => { output.segments = [{name:project.audience || '待核', need:'待核', price_band:priceBand}]; }, 'segments');
    add(!output.risks || !output.risks.length, () => { output.risks = ['需求与价格带尚未验证，需先做小规模测款']; }, 'risks');
    add(!output.rating || typeof output.rating !== 'object', () => { output.rating = {prospect:'待核', potential:'待核', timing:'观望，先验证'}; }, 'rating');
    add(!output.handoff || typeof output.handoff !== 'object', () => { output.handoff = {audience:project.audience || '待核', price_band:priceBand, budget:project.budget_cents ? (project.budget_cents/100) + ' 元测款' : '待核', product_directions:[project.category || '待核'], hypotheses:['目标人群是否愿意为折叠收纳支付 29.9-39.9 元']}; }, 'handoff');
    add(!output.sources || !output.sources.length, () => { output.sources = (prefetched.toolResults?.market?.results || []).slice(0,3).map(item => ({title:item.title, url:item.url, note:'公开搜索摘要；采用前回查原页'})); }, 'sources');
  }
  if (role === 'product-sourcing') {
    add(!output.directions || !output.directions.length, () => { output.directions = [project.category || '待核']; }, 'directions');
    add(!output.queries || !output.queries.length, () => { output.queries = prefetched.toolResults?.ali1688?.queries || prefetched.toolResults?.pdd?.queries || ['折叠桌面手机支架']; }, 'queries');
    add(!output.candidates || !output.candidates.length, () => {
      output.candidates = [
        ...(prefetched.toolResults?.ali1688?.historical || []).slice(0,4).map(item => ({product_id:item.item_id, title:item.spec_text, price:(item.unit_price_cents/100) + ' 元', moq:item.qty_min, supplier:item.supplier, source:'1688 历史回放（2026-11-18）', note:'运费/代发条件缺失'})),
        ...(prefetched.toolResults?.pdd?.items || []).slice(0,3).map(item => ({product_id:item.product_id, title:item.title, price:(item.group_price_cny ?? '待核') + ' 元', moq:null, supplier:item.shop, source:'拼多多检索（对照）', note:'下游平台价格，不是进货价'})),
      ];
    }, 'candidates');
    add(!output.recommended || typeof output.recommended !== 'object', () => { output.recommended = {sku_id:sku?.id || null, reason:'按当前主 SKU 补足，待经营者确认', suggested_price:sku ? (sku.price_cents/100).toFixed(2) + ' 元' : '待核'}; }, 'recommended');
    add(!output.profit || typeof output.profit !== 'object', () => { output.profit = economics ? {pre_ad:cny(economics.preAdCents) + ' 元', post_ad:cny(economics.postAdCents) + ' 元', rate:economics.preAdRatePct + '%', break_even_roas:economics.breakEvenRoas} : {pre_ad:'待核', post_ad:'待核', rate:'待核', break_even_roas:'待核'}; }, 'profit');
    add(!output.sample_checklist || !output.sample_checklist.length, () => { output.sample_checklist = ['核对材质与承重','核对折叠尺寸与手机适配','核对包装与运费','核对发货时效与代发条件']; }, 'sample_checklist');
    add(!output.risks || !output.risks.length, () => { output.risks = ['1688 实时报价未取得时需以历史回放为基准并重新询价','合成演示报价不能当作真实供应商承诺']; }, 'risks');
    add(!output.data_gaps || !output.data_gaps.length, () => { output.data_gaps = (prefetched.toolResults?.ali1688?.attempts || []).filter(item => !item.ok).map(item => item.query + '：' + item.status).slice(0,3); if (!output.data_gaps.length) output.data_gaps = ['供应商资质与代发条件待核']; }, 'data_gaps');
  }
  if (role === 'visual-designer') {
    add(!output.strategies || output.strategies.length < 2, () => {
      output.strategies = [...(output.strategies || []), {name:'A 版·极致清晰', concept:'浅色桌面，产品占画面 60%，折叠动作一眼看懂', palette:'米白/黑', main_selling:'折叠不占地', metric:'点击率'}, {name:'B 版·场景信任', concept:'办公桌场景，手机横竖两用，突出收纳', palette:'灰蓝', main_selling:'追剧办公两用', metric:'转化率'}].slice(0,2);
    }, 'strategies');
    add(!output.selected, () => { output.selected = output.strategies?.[0]?.name || 'A 版'; }, 'selected');
    add(!output.asset_checklist || !output.asset_checklist.length, () => { output.asset_checklist = ['商品原图 800x800','详情宽 750','已核实的规格与售后政策','不使用未授权字体与品牌元素']; }, 'asset_checklist');
    add(!output.quality_check || !output.quality_check.length, () => { output.quality_check = ['主图 800x800，详情宽 750','手机缩略图可读','无极限词与未核实承诺','SKU 外观与文案一致']; }, 'quality_check');
    add(!output.iteration, () => { output.iteration = 'CTR 低先改第 1 张主图的钩子；转化低先补第 3 张证据与详情首屏'; }, 'iteration');
  }
  if (role === 'copywriter') {
    add(!output.selling_points || !output.selling_points.length, () => { output.selling_points = [{point:'折叠收纳', benefit:'桌面不占地', evidence:'商品事实（材质与承重待核）'}]; }, 'selling_points');
    add(!output.keywords || !output.keywords.length, () => { output.keywords = String(output.title || '').split(/[\s,，]+/).filter(Boolean).slice(0,8); }, 'keywords');
    add(!output.main_image_lines || !output.main_image_lines.length, () => { output.main_image_lines = [{a:'折叠不占地', b:'桌面更清爽'}]; }, 'main_image_lines');
    add(!output.detail_opening || output.detail_opening.length < 3, () => { output.detail_opening = [...(output.detail_opening || []), '桌面总是被支架占满？', '折叠收起，展开即用。', '两个规格，按手机尺寸选。'].slice(0,3); }, 'detail_opening');
    add(!output.compliance || !output.compliance.length, () => { const check = complianceCheck(JSON.stringify(output)); output.compliance = check.hits.length ? ['命中待改：' + check.hits.join('、')] : ['未命中内置极限词表；材质、检测、活动仍须人工复核']; }, 'compliance');
    add(!output.test_plan, () => { output.test_plan = '主图 A/B 3-5 天，观察 CTR；详情首屏测试停留与转化。'; }, 'test_plan');
  }
  if (role === 'store-operator') {
    add(!output.funnel || typeof output.funnel !== 'object', () => { output.funnel = metric ? {impressions:metric.metrics.ctr.numerator, clicks:metric.metrics.ctr.denominator, orders:metric.metrics.clickCvr.numerator, ctr:metric.ctrPct + '%', cvr:metric.clickCvrPct + '%'} : {impressions:'待核', clicks:'待核', orders:'待核'}; }, 'funnel');
    add(!output.evidence || !output.evidence.length, () => { output.evidence = report ? ['报表：' + (prefetched.toolResults.report.report.id) + '，' + (prefetched.toolResults.report.report.period_start) + ' 至 ' + (prefetched.toolResults.report.report.period_end)] : ['报表缺失']; }, 'evidence');
    add(!output.actions || output.actions.length < 3, () => { output.actions = [...(output.actions || []), {priority:'P1', object:'主图', parameter:'A/B 第 1 张', budget:'50 元/天', stop_condition:'3 天 CTR 无提升即停', review_at:'3 日后'}, {priority:'P1', object:'详情页', parameter:'补规格与售后屏', budget:'0', stop_condition:'无', review_at:'7 日后'}, {priority:'P2', object:'数据', parameter:'补自然流量拆分', budget:'0', stop_condition:'无', review_at:'3 日后'}].slice(0,3); }, 'actions');
    add(!output.budget, () => { output.budget = project.budget_cents ? (project.budget_cents/100) + ' 元测款预算，单日不超过 100 元' : '待核'; }, 'budget');
    add(!output.stop_conditions || !output.stop_conditions.length, () => { output.stop_conditions = ['ROAS 连续 2 日低于盈亏平衡即停', '退款/售后集中升高即停']; }, 'stop_conditions');
    add(!output.review_at, () => { output.review_at = '3 日/7 日复盘'; }, 'review_at');
    add(!output.risks || !output.risks.length, () => { output.risks = ['报表为合成演示，不能当作真实投放结果']; }, 'risks');
  }
  if (role === 'presales-service') {
    add(!output.facts_used || !output.facts_used.length, () => { output.facts_used = (prefetched.knowledge || []).slice(0,3).map(item => item.title); }, 'facts_used');
    add(!output.unknowns || !output.unknowns.length, () => { output.unknowns = ['送达日期','赠品与库存','活动价']; }, 'unknowns');
    add(!output.transfer_after_sales || typeof output.transfer_after_sales !== 'object', () => { output.transfer_after_sales = {needed:false, reason:'未涉及已购、破损、丢件或退换'}; }, 'transfer_after_sales');
    add(!output.tone_check, () => { output.tone_check = '简短、无对抗性、未承诺未核实事项'; }, 'tone_check');
  }
  if (role === 'aftersales-service') {
    add(!output.severity, () => { output.severity = '中'; }, 'severity');
    add(!output.emotion, () => { output.emotion = '中'; }, 'emotion');
    add(!output.responsibility, () => { output.responsibility = '待证据核实'; }, 'responsibility');
    add(!output.evidence_needed || !output.evidence_needed.length, () => { output.evidence_needed = ['订单截图','商品破损近照','外箱照']; }, 'evidence_needed');
    add(!output.options || !output.options.length, () => { output.options = ['补发（待审核）','退货退款（待审核）','补偿券（待审核）']; }, 'options');
    add(!output.next_step, () => { output.next_step = '收到证据后提交待审处理动作'; }, 'next_step');
    add(!output.action || typeof output.action !== 'object', () => { output.action = {kind:'', amount_cents:0, reason:'待证据齐全后决定'}; }, 'action');
  }
  if (role === 'data-analyst') {
    add(!output.quality || typeof output.quality !== 'object', () => { output.quality = report ? {valid_rows:report.validRows, invalid_rows:report.invalidRows, note:'按报表行统计'} : {valid_rows:0, invalid_rows:0, note:'无报表'}; }, 'quality');
    add(!output.metrics || typeof output.metrics !== 'object', () => { output.metrics = metric ? {ctr:metric.ctrPct + '%', click_cvr:metric.clickCvrPct + '%', cpc:(metric.cpcCents/100).toFixed(2) + ' 元', roas:metric.roas?.toFixed(2)} : {ctr:'待核'}; }, 'metrics');
    add(!output.funnel || typeof output.funnel !== 'object', () => { output.funnel = report ? {impressions:report.impressions, clicks:report.clicks, orders:report.orders} : {impressions:0, clicks:0, orders:0}; }, 'funnel');
    add(!output.findings || !output.findings.length, () => { output.findings = ['当前数据可算，但样本仅 7 天，不能外推长期趋势']; }, 'findings');
    add(!output.actions || output.actions.length < 3, () => { output.actions = [...(output.actions || []), {data:'CTR ' + (metric?.ctrPct ?? '待核') + '%', hypothesis:'主图吸引力', action:'A/B 测试第 1 张主图'}, {data:'零分母行', hypothesis:'字段缺失或格式错误', action:'修复报表后重算'}, {data:'ROAS ' + (metric?.roas ?? '待核'), hypothesis:'素材或投放设置', action:'按停止条件复盘'}].slice(0,3); }, 'actions');
    add(!output.review_at, () => { output.review_at = '3-7 日后复盘'; }, 'review_at');
    add(!output.data_gaps || !output.data_gaps.length, () => { output.data_gaps = ['自然流量拆分','活动与价格变动标记','售后归因']; }, 'data_gaps');
  }
  if (notes.length) output._meta = {...(output._meta || {}), normalized:true, notes:[...((output._meta || {}).notes || []), ...notes]};
  return output;
}


function applyGrounding(role, output, context, prefetched, notes) {
  const project = context.project;
  const sku = context.sku;
  const eco = sku ? prefetched.economics?.[sku.id] : null;
  const metrics = prefetched.toolResults?.metrics || null;
  const report = prefetched.toolResults?.report?.summary || null;
  const overrides = [];
  const note = (text) => { notes.push(text); };
  const priceBand = project.price_min_cents && project.price_max_cents ? (project.price_min_cents/100) + '-' + (project.price_max_cents/100) + ' 元' : '待核';
  if (role === 'market-analyst') {
    output.handoff = output.handoff || {};
    output.handoff.audience = project.audience || output.handoff.audience || '待核';
    output.handoff.price_band = priceBand;
    output.handoff.budget = project.budget_cents ? (project.budget_cents/100) + ' 元测款' : '待核';
    overrides.push('handoff.audience/price_band/budget');
    const sourcePool = (prefetched.toolResults?.market?.results || []).map(item => ({title:item.title, url:item.url, note:'公开搜索摘要；采用前回查原页'}));
    output.sources = sourcePool.length ? sourcePool.slice(0,3) : [{title:'未取得可核来源', url:null, note:'需补公开报告或平台后台数据'}];
    overrides.push('sources');
    const marketSize = String(output.market_size || '');
    if (!/[0-9]/.test(marketSize) || !/(亿|万|元|%|待核|来源)/.test(marketSize)) {
      output.market_size = '待核（缺少可核市场规模数据）'; note('市场规模缺少可核来源，已标待核');
    }
    const cagr = String(output.cagr || '');
    if (cagr && !/(%|待核)/.test(cagr)) { output.cagr = '待核'; note('CAGR 缺少百分比或来源，已标待核'); }
    for (const key of ['prospect','potential','timing']) {
      const value = String(output.rating?.[key] || '');
      if (!/^(\d+(?:\.\d+)?\/10|高|中|低|待核)/.test(value)) { output.rating[key] = '待核'; overrides.push('rating.' + key); }
    }
    const brands = ['小米','华为','苹果','三星','倍魔','赛鲸'];
    if (brands.some(brand => String(output.competition || '').includes(brand))) {
      const contextText = JSON.stringify({project, knowledge:prefetched.toolResults?.knowledge});
      if (!brands.some(brand => contextText.includes(brand))) {
        output.competition = '竞争数据不足，需用平台榜单与公开报告验证，不引用未提供的品牌结论';
        note('品牌竞争表述缺少输入依据，已拦截');
      }
    }
  }
  if (role === 'product-sourcing') {
    const synthetic = [];
    const historical = [];
    const pddPool = [];
    const quotes = all(db, 'SELECT q.*, s.name AS supplier_name FROM opc_quotes q LEFT JOIN opc_suppliers s ON s.id=q.supplier_id JOIN opc_products p ON p.id=q.product_id WHERE p.project_id=? ORDER BY q.unit_price_cents', project.id);
    for (const quote of quotes) if (quote.verification_status !== 'historical') {
      synthetic.push({product_id:quote.item_id || quote.sku_ref || quote.id, title:quote.spec_text, price:(quote.unit_price_cents/100).toFixed(2) + ' 元', moq:quote.qty_min,
        supplier:quote.supplier_name, source:quote.source, note:'合成演示报价；运费与代发条件以报价记录为准', verification:quote.verification_status, retrieved_at:quote.retrieved_at});
    }
    for (const item of prefetched.toolResults?.ali1688?.historical || []) {
      historical.push({product_id:item.item_id, title:item.spec_text || item.title, price:(item.unit_price_cents/100).toFixed(2) + ' 元', moq:item.qty_min,
        supplier:item.supplier, source:'1688 历史回放（2026-11-18）', note:'历史回放；运费、资质与代发条件缺失', verification:'historical', retrieved_at:item.retrieved_at});
    }
    for (const item of prefetched.toolResults?.pdd?.items || []) {
      pddPool.push({product_id:item.product_id, title:item.title, price:(item.group_price_cny ?? '待核') + ' 元', moq:null, supplier:item.shop || null,
        source:'拼多多检索（对照，不是进货价）', note:'多多进宝推广商品口径', verification:'real_tool', retrieved_at:prefetched.toolResults?.pdd?.retrievedAt || null});
    }
    const ordered = [...synthetic, ...historical, ...pddPool].filter(item => item.product_id);
    const byId = new Map();
    for (const item of ordered) if (!byId.has(item.product_id)) byId.set(item.product_id, item);
    const modelCandidates = Array.isArray(output.candidates) ? output.candidates : [];
    const modelNote = new Map(modelCandidates.filter(item => item?.product_id).map(item => [String(item.product_id), item.note || item.reason || '']));
    const groundedCandidates = [...byId.values()].slice(0, 6).map(item => ({...item, note:[item.note, modelNote.get(item.product_id)].filter(Boolean).join('；')}));
    if (groundedCandidates.length) {
      output.candidates = groundedCandidates;
      overrides.push('candidates（合成报价/1688 历史回放/拼多多对照，按商品 ID 去重）');
    } else if (modelCandidates.length) {
      output.candidates = modelCandidates.slice(0, 6).map(item => ({...item, verification:'model_unverified', note:'未在本次工具回执中找到该商品 ID，需复核'}));
      note('候选未能在工具回执中定位，已标为待复核');
    }
    if (eco) {
      output.profit = {pre_ad:cny(eco.preAdCents) + ' 元', post_ad:cny(eco.postAdCents) + ' 元', rate:eco.preAdRatePct + '%', break_even_roas:eco.breakEvenRoas};
      overrides.push('profit（后端核算）');
      output.recommended = output.recommended || {};
      output.recommended.sku_id = sku.id;
      output.recommended.suggested_price = cny(sku.price_cents) + ' 元';
    }
  }
  if (role === 'store-operator') {
    if (report) {
      output.funnel = {impressions:report.impressions, clicks:report.clicks, orders:report.orders, ctr:metrics ? metrics.ctrPct + '%' : '待核', cvr:metrics ? metrics.clickCvrPct + '%' : '待核'};
      output.evidence = [...(output.evidence || []), '后端核算：' + prefetched.toolResults.report.report.id + '，' + prefetched.toolResults.report.report.period_start + ' 至 ' + prefetched.toolResults.report.report.period_end];
      overrides.push('funnel（后端核算）');
    }
    if (eco) output.budget = project.budget_cents ? (project.budget_cents/100) + ' 元测款预算，单日不超过 100 元' : '待核';
  }
  if (role === 'data-analyst') {
    if (report) {
      output.quality = {valid_rows:report.validRows, invalid_rows:report.invalidRows, note:'按报表行统计；零分母不生成指标'};
      output.funnel = {impressions:report.impressions, clicks:report.clicks, orders:report.orders};
      if (metrics) output.metrics = {ctr:metrics.ctrPct + '%', click_cvr:metrics.clickCvrPct + '%', cpc:(metrics.cpcCents/100).toFixed(2) + ' 元', roas:metrics.roas?.toFixed(2)};
      overrides.push('quality/metrics/funnel（后端核算）');
    }
  }
  if (role === 'presales-service') {
    const ticket = prefetched.toolResults?.ticket || null;
    const message = String(ticket?.original_message || '');
    const afterSalesIssue = /(买|收到|裂|坏|破损|少发|错发|丢件|签收|退货|退款|换货|维修)/.test(message);
    if (afterSalesIssue) {
      output.transfer_after_sales = {needed:true, reason:'顾客描述涉及已购、破损或退换，按流程转售后核实'};
      if (!/售后|转接/.test(String(output.reply || '')) || /(已购：无|库存充足|预计.{0,6}到货|保证|明天到|次日达)/.test(String(output.reply || ''))) {
        output.reply = '亲，非常抱歉给您带来不好的体验。我已将您的问题转给售后专员核实，请提供订单号、商品破损近照和外箱照，我们会尽快给您处理方案。';
      }
      output.facts_used = ['订单：' + (ticket?.order_ref || '待补'), 'SKU：' + (context.sku?.name || '待补'), '原问题：' + message.slice(0,80)];
      output.unknowns = ['商品破损近照', '外箱照', '订单与物流状态'];
      notes.push('顾客描述涉及已购/破损，已强制转售后并清理未核实承诺');
      overrides.push('transfer_after_sales/reply/facts_used（售后安全规则）');
    } else {
      const sanitized = String(output.reply || '').replace(/(库存充足|预计.{0,8}到货|保证[^。；]*|明天到|次日达)/g, '以物流实际为准');
      if (sanitized !== output.reply) { output.reply = sanitized; notes.push('已清理未核实承诺'); }
    }
  }
  if (role === 'aftersales-service') {
    const ticket = prefetched.toolResults?.ticket || null;
    const evidence = Array.isArray(output.evidence_needed) ? output.evidence_needed : [];
    if (!evidence.some(item => /照|视频|订单|物流/.test(String(item)))) {
      output.evidence_needed = ['订单截图','商品破损近照','外箱照'];
      notes.push('售后证据不足，已补标准证据清单');
    }
    const sanitized = String(output.reply || '').replace(/(马上退款|立刻退款|保证退款|全额退款|一定退)/g, '我们会按审核后的方案尽快处理');
    if (sanitized !== output.reply) { output.reply = sanitized; notes.push('已清理未审核退款承诺'); }
    if (ticket && ticket.order_ref) output.next_step = (output.next_step || '') + '（订单 ' + ticket.order_ref + '）';
  }
  if (role === 'copywriter') {
    output.keywords = [...new Set((output.keywords || []).map(item => String(item).trim()).filter(Boolean))].slice(0, 10);
    output.main_image_lines = (output.main_image_lines || []).slice(0, 3).map(item => ({a:String(item.a || '').slice(0,10), b:String(item.b || '').slice(0,10)}));
    const check = complianceCheck(JSON.stringify(output));
    const lines = (output.main_image_lines || []).flatMap(item => [item.a, item.b]).filter(Boolean);
    const tooLong = lines.filter(line => [...String(line)].length > 10);
    const issues = [...check.hits.map(hit => '命中极限词：' + hit), ...tooLong.map(line => '主图短句超过 10 字：' + line)];
    output.compliance = [...new Set([...(output.compliance || []), ...(issues.length ? issues : ['未命中内置极限词表；仍需人工复核广告法与平台规则'])])];
    if (issues.length) note('文案合规检查发现需改写项：' + issues.join('；'));
    overrides.push('compliance（后端检查）');
  }
  if (role === 'presales-service' || role === 'aftersales-service') {
    const reply = String(output.reply || '');
    const risky = ['明天到','保证到','一定到','百分百','绝对','保证退款','马上退款'].filter(word => reply.includes(word));
    if (risky.length) note('回复含未核实承诺，需人工复核：' + risky.join('、'));
  }
  if (overrides.length) {
    output._meta = {...(output._meta || {}), groundingOverrides:overrides};
  }
  return output;
}

  function coreMissing(role, output) {
    const checks = {
      'market-analyst':['summary'], 'product-sourcing':['candidates'], 'visual-designer':['strategies'],
      'copywriter':['title'], 'store-operator':['diagnosis'], 'presales-service':['reply'],
      'aftersales-service':['reply'], 'data-analyst':['findings'],
    };
    return (checks[role] || []).filter(key => {
      const value = output?.[key];
      return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
    });
  }

  async function modelStep(run, context, prefetched) {
    const role = context.employee.slug;
    const modelConfig = context.model ? one(db, 'SELECT * FROM opc_model_configs WHERE id=?', context.model.id) : null;
    if (!modelConfig) throw new RunError('model_not_configured', '没有可用模型配置，请到接入设置启用模型', {status:'awaiting_authorization'});
    const day = nowIso().slice(0, 10);
    const usage = one(db, 'SELECT * FROM opc_daily_usage WHERE employee_id=? AND day=?', context.employee.id, day);
    if (usage && usage.tokens >= context.employee.daily_token_limit) {
      throw new RunError('daily_token_limit', '今日用量已达上限（' + usage.tokens + ' tokens），可在接入设置提高上限或明日继续', {status:'paused'});
    }
    const sections = ROLE_SECTIONS[role] || [];
    if (!sections.length) throw new RunError('role_schema_missing', '岗位缺少结构化输出定义');
    const base = buildMessages(run, context, prefetched);
    const merged = {};
    const validation = [];
    const sectionResults = [];
    let tokensIn = 0, tokensOut = 0, firstToken = null, thinking = 0, duration = 0, attempts = 0;
    let provider = null, providerModel = null, requested = null;
    for (const section of sections) {
      assertActive(run.id);
      const messages = [...base.messages, {role:'user', content:'本次只输出以下字段，严格按 JSON schema：' + section.prompt + ' 不要输出其他字段，不要解释。'}];
      let parsed = null;
      let lastError = null;
      let raw = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        attempts += 1;
        const result = await modelClient({config:modelConfig, messages, schema:section.schema, timeoutMs:context.employee.timeout_ms, maxTokens:section.maxTokens || 1400});
        if (!result.ok) {
          lastError = result.error || result.status;
          if (result.status === 'empty_content' && attempt === 0) {
            messages.push({role:'user', content:'请直接输出 JSON，不要长篇思考。'});
            continue;
          }
          break;
        }
        provider = result.provider;
        providerModel = result.providerModel || providerModel;
        requested = result.requestedModel || requested;
        tokensIn += result.tokensIn || 0;
        tokensOut += result.tokensOut || 0;
        duration += result.durationMs || 0;
        thinking += result.thinkingChars || 0;
        if (firstToken === null && result.firstTokenMs !== null && result.firstTokenMs !== undefined) firstToken = result.firstTokenMs;
        raw = result.content || '';
        const extracted = extractJson(raw);
        if (!extracted.ok) {
          lastError = extracted.error;
          validation.push({path:section.key, message:extracted.error});
          messages.push({role:'assistant', content:truncate(raw, 1200)});
          messages.push({role:'user', content:'上面的输出不是合法 JSON。请只输出修正后的 JSON 对象。'});
          continue;
        }
        const shapeErrors = validateShape(extracted.value, sectionShape(section));
        if (shapeErrors.length) {
          lastError = shapeErrors.map(item => item.path + '：' + item.message).join('；');
          validation.push(...shapeErrors.map(item => ({path:section.key + '.' + item.path, message:item.message})));
          messages.push({role:'assistant', content:truncate(raw, 1200)});
          messages.push({role:'user', content:'未通过结构校验：' + lastError + '。请只输出修正后的 JSON。'});
          continue;
        }
        parsed = extracted.value;
        break;
      }
      if (parsed) Object.assign(merged, parsed);
      sectionResults.push({key:section.key, label:section.label, ok:Boolean(parsed), error:parsed ? null : (lastError || '未返回'), raw:truncate(raw, 2500)});
      logRunEvent(db, run.id, 'model_section', {section:section.key, ok:Boolean(parsed), error:parsed ? null : truncate(lastError || '', 300)});
    }
    const missingSections = sectionResults.filter(item => !item.ok).map(item => item.key);
    if (!Object.keys(merged).length) {
      throw new RunError('invalid_model_output', '模型所有分段均未返回可用 JSON：' + (sectionResults[0]?.error || ''), {detail:{raw:JSON.stringify(sectionResults).slice(0, 6000), validation}});
    }
    let output = merged;
    const notes = [];
    if (role === 'visual-designer') {
      const expanded = expandDesignOutput(output, {sku:context.sku});
      output = expanded.output;
      notes.push(...expanded.notes);
    }
    if (role === 'product-sourcing' && (!Array.isArray(output.candidates) || !output.candidates.length)) {
      output.candidates = (prefetched.toolResults.pdd?.items || []).slice(0, 5).map(item => ({product_id:item.product_id, title:item.title, price:item.group_price_cny + ' 元', source:'拼多多检索（对照）'}));
      notes.push('候选为空，已用拼多多公开检索结果补足');
    }
    fillMissing(role, output, context, prefetched, notes);
    applyGrounding(role, output, context, prefetched, notes);
    const missing = coreMissing(role, output);
    if (missing.length) {
      throw new RunError('invalid_model_output', '模型输出缺少核心字段：' + missing.join('、'), {detail:{raw:JSON.stringify(sectionResults).slice(0, 6000), validation, missing}});
    }
    output._meta = {
      normalized: notes.length > 0, notes,
      validationErrors: validation,
      missingSections,
      model: {requested, providerModel, provider, firstTokenMs:firstToken, durationMs:duration,
        tokensIn, tokensOut, thinkingChars:thinking, attempts,
        sections:sectionResults.map(item => ({key:item.key, ok:item.ok, error:item.error}))},
      dataNature: '合成演示 / 历史回放 / 真实调用按各字段来源标记',
    };
    setRun(run.id, {provider, provider_model:providerModel, tokens_in:tokensIn || null, tokens_out:tokensOut || null,
      first_token_ms:firstToken, model_id:modelConfig.id});
    return {output, raw:JSON.stringify({sections:sectionResults.map(item => ({key:item.key, ok:item.ok, raw:item.raw})), merged}, null, 2),
      validation, modelResult:{provider, providerModel, requestedModel:requested, firstTokenMs:firstToken, durationMs:duration, tokensIn, tokensOut, thinkingChars:thinking},
      attempt:attempts, notes, sectionResults};
  }

  function saveFile(run, {name, buffer, mime, source, skuId = null}) {
    const dir = resolve(filesRoot, run.project_id, 'runs', run.id);
    mkdirSync(dir, {recursive: true});
    const safe = safeName(name);
    const path = resolve(dir, safe);
    writeFileSync(path, buffer);
    const relative = path.slice(filesRoot.length).replace(/^[/\\]/, '');
    const id = newId('file');
    insert(db, 'opc_files', {
      id, project_id:run.project_id, sku_id:skuId, run_id:run.id, name:safe, mime: mime || 'application/octet-stream',
      size: statSync(path).size, sha256: sha256(buffer), storage_path: relative, access_scope:'project', source, created_at:nowIso(),
    });
    return {id, path, relative, size:statSync(path).size};
  }

  function writeArtifact(run, {lineage, kind, title, content, contentType = 'text/markdown', file = null, status = 'draft', evidence = null, skuId = null}) {
    const max = one(db, 'SELECT COALESCE(MAX(version),0) AS v FROM opc_artifacts WHERE lineage_key=?', lineage)?.v || 0;
    const id = newId('artifact');
    insert(db, 'opc_artifacts', {
      id, lineage_key:lineage, project_id:run.project_id, sku_id:skuId || run.sku_id, run_id:run.id, kind, title,
      version:max + 1, status, content_type:contentType, content, file_id:file?.id || null,
      evidence_json:evidence ? json(evidence) : null, created_at:nowIso(),
    });
    return one(db, 'SELECT * FROM opc_artifacts WHERE id=?', id);
  }

  function buildCsv(header, rows) {
    const escape = (value) => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    return [header.join(','), ...rows.map(row => row.map(escape).join(','))].join('\n');
  }

  async function writeArtifacts(run, context, output, prefetched) {
    const role = context.employee.slug;
    const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', run.project_id);
    const sku = run.sku_id ? one(db, 'SELECT * FROM opc_skus WHERE id=?', run.sku_id) : null;
    const computed = {unitEconomics:prefetched.economics, metrics:prefetched.toolResults.metrics || null,
      report:prefetched.toolResults.report?.summary || null};
    let design = null;
    if (role === 'visual-designer') {
      if (!context.grants.some(grant => grant.tool_key === 'image.prompt' && grant.enabled)) {
        receipt(run, 'image.prompt', {mode:'prompt_only'}, {ok:false,status:'permission_denied',error:'该员工未获提示词工具授权',environment:'local'});
        throw new RunError('image_prompt_not_authorized', '该员工未获提示词工具授权', {status:'awaiting_authorization'});
      }
      design = designPromptPackage(output, context, prefetched.toolResults);
      const promptItems = [...design.main, ...design.detail];
      output.main_images = design.main.map(item => ({...item, purpose:item.headline, copy:item.headline, visual:item.prompt}));
      output.detail_screens = design.detail.map(item => ({...item, purpose:item.headline, copy:item.headline, visual:item.prompt}));
      output.prompts = promptItems.map(item => item.prompt);
      output._meta = {...output._meta, image:{mode:'prompt_only',provider:'prompt-only',status:'prompt_ready',
        receiptId:'IMGPROMPT-' + run.id.slice(-8), count:design.main.length,promptCount:promptItems.length,
        detailCount:design.detail.length,generated:0,factStatus:design.facts.length ? 'verified' : 'pending'}};
      design.receipt = receipt(run, 'image.prompt', {count:promptItems.length,mode:'prompt_only'},
        {ok:true,status:'prompt_ready',environment:'local',provider:'prompt-only',mode:'prompt_only',
          receiptId:output._meta.image.receiptId,images:[],prompts:promptItems});
    }
    const toolReceipts = all(db, 'SELECT * FROM opc_tool_receipts WHERE run_id=? ORDER BY created_at', run.id);
    const markdown = renderMarkdown({role, project, sku, output, computed, run:{...run, status:'success', finished_at:nowIso()}, toolReceipts});
    const artifacts = [];
    const mdFile = saveFile(run, {name:'run-' + role + '.md', buffer:Buffer.from(markdown, 'utf8'), mime:'text/markdown', source:'OPC 运行产物'});
    artifacts.push(writeArtifact(run, {lineage:'artifact:' + run.project_id + ':' + role + ':' + (run.sku_id || 'project') + ':markdown',
      kind:'markdown', title:(ROLE_BY_SLUG[role]?.name || role) + ' · 可读产物', content:markdown, file:mdFile, evidence:{toolReceipts:toolReceipts.map(item => item.receipt_id), model:(output._meta || {}).model}}));
    const jsonContent = JSON.stringify({runId:run.id, role, projectId:run.project_id, skuId:run.sku_id, input:parseJson(run.input_json, {}), output, computed, context:{mindVersion:context.employee.mind_version, model:context.model, skills:context.skills, grants:context.grants}}, null, 2);
    const jsonFile = saveFile(run, {name:'run-' + role + '.json', buffer:Buffer.from(jsonContent, 'utf8'), mime:'application/json', source:'OPC 运行产物'});
    artifacts.push(writeArtifact(run, {lineage:'artifact:' + run.project_id + ':' + role + ':' + (run.sku_id || 'project') + ':json',
      kind:'json', title:(ROLE_BY_SLUG[role]?.name || role) + ' · 结构化结果', content:jsonContent, contentType:'application/json', file:jsonFile, evidence:{model:(output._meta || {}).model}}));

    if (role === 'product-sourcing') {
      const rows = (output.candidates || []).map(item => [item.product_id, item.title, item.price, item.moq, item.supplier, item.source, item.note]);
      const csv = buildCsv(['商品ID','标题','报价','起订量','供应商','来源','口径/备注'], rows);
      const file = saveFile(run, {name:'candidates.csv', buffer:Buffer.from(csv, 'utf8'), mime:'text/csv', source:'OPC 运行产物'});
      artifacts.push(writeArtifact(run, {lineage:'artifact:' + run.project_id + ':sourcing:candidates:' + (run.sku_id || 'project'), kind:'csv', title:'候选与报价表', content:csv, contentType:'text/csv', file, evidence:{rows:rows.length}}));
      const profitRows = Object.entries(prefetched.economics).map(([id, value]) => [id, cny(value.inputs.priceCents), cny(value.inputs.costCents), cny(value.inputs.shippingCents), cny(value.inputs.packagingCents), cny(value.platformFeeCents), cny(value.inputs.refundCents), cny(value.preAdCents), cny(value.inputs.adCents), cny(value.postAdCents), value.preAdRatePct, value.breakEvenRoas]);
      const profitCsv = buildCsv(['SKU','售价','进货','履约','包材','平台费','退款损耗','广告前贡献','广告费','广告后贡献','广告前贡献率%','盈亏平衡ROAS'], profitRows);
      const profitFile = saveFile(run, {name:'profit.csv', buffer:Buffer.from(profitCsv, 'utf8'), mime:'text/csv', source:'OPC 后端确定性核算'});
      artifacts.push(writeArtifact(run, {lineage:'artifact:' + run.project_id + ':sourcing:profit', kind:'csv', title:'单件利润核算表', content:profitCsv, contentType:'text/csv', file:profitFile, evidence:{formulas:Object.values(prefetched.economics)[0]?.formulas || []}}));
    }
    if (role === 'data-analyst') {
      const metrics = prefetched.toolResults.metrics || {};
      const csv = buildCsv(['指标','数值','分子','分母','口径'], Object.entries(metrics.metrics || {}).map(([key, item]) => [key, item.value, item.numerator, item.denominator, item.formula]));
      const file = saveFile(run, {name:'metrics.csv', buffer:Buffer.from(csv, 'utf8'), mime:'text/csv', source:'OPC 后端确定性核算'});
      artifacts.push(writeArtifact(run, {lineage:'artifact:' + run.project_id + ':data:metrics', kind:'csv', title:'指标计算表', content:csv, contentType:'text/csv', file, evidence:{formulas:metrics.formulas || []}}));
    }
    if (role === 'store-operator') {
      const csv = buildCsv(['优先级','对象','参数','预算上限','停止条件','复盘'], (output.actions || []).map(item => [item.priority, item.object, item.parameter, item.budget, item.stop_condition, item.review_at]));
      const file = saveFile(run, {name:'actions.csv', buffer:Buffer.from(csv, 'utf8'), mime:'text/csv', source:'OPC 运行产物'});
      artifacts.push(writeArtifact(run, {lineage:'artifact:' + run.project_id + ':operator:actions', kind:'csv', title:'运营动作表', content:csv, contentType:'text/csv', file, evidence:{actions:(output.actions || []).length}}));
    }
    if (design) {
      const header = ['序号','文件名','尺寸','主文案','辅助文案','完整提示词','负面约束','SKU','SKU名称','状态','来源','事实状态'];
      const groups = [{key:'main',title:'主图提示词',items:design.main}, {key:'detail',title:'详情提示词',items:design.detail}];
      for (const group of groups) {
        const markdown = ['# ' + group.title, '',
          '主文案与辅助文案供后期排版，图像提示词要求画面文字区留白。',
          '商品资料状态：' + (design.facts.length ? '已核验商品知识，来源见逐图证据。' : '商品事实与实物参考图待核验；补齐后再交给外部生图工具。'), '',
          ...group.items.map(item => ['## ' + item.index + ' · ' + item.filename,
            '- 尺寸：' + item.width + 'x' + item.height, '- 主文案：' + item.headline, '- 辅助文案：' + item.subline,
            '- 完整提示词：' + item.prompt, '- 负面约束：' + item.negative,
            '- SKU：' + (item.sku_id || '待选择') + ' · ' + item.sku_name,
            '- 状态：' + item.status, '- 来源：' + item.source,
            '- 核验资料：' + (item.evidence.join('、') || '待补')].join('\n'))].join('\n\n');
        const csv = buildCsv(header,group.items.map(item => [item.index,item.filename,item.width + 'x' + item.height,
          item.headline,item.subline,item.prompt,item.negative,item.sku_id,item.sku_name,item.status,item.source,item.fact_status]));
        for (const [kind,content,mime] of [['markdown',markdown,'text/markdown'],['csv',csv,'text/csv']]) {
          const file = saveFile(run, {name:group.key + '-image-prompts.' + (kind === 'markdown' ? 'md' : 'csv'),
            buffer:Buffer.from(content,'utf8'),mime,source:'OPC 运行产物（仅提示词）'});
          artifacts.push(writeArtifact(run, {lineage:'artifact:' + run.project_id + ':design:prompts:' + group.key + ':' + kind + ':' + (run.sku_id || 'project'),
            kind,title:group.title + (kind === 'csv' ? '（CSV）' : '（Markdown）'),content,contentType:mime,file,
            evidence:{mode:'prompt_only',rows:group.items.length,skuId:run.sku_id || null,imageReceipt:design.receipt.id,generated:0}}));
        }
      }
    }
    const fileWrite = receipt(run, 'file.write', {artifacts:artifacts.map(item => item.id)}, {ok:true, status:'success', environment:'local', data:{artifacts:artifacts.length}});
    for (const artifact of artifacts) {
      insert(db, 'opc_audit', {id:newId('audit'), project_id:run.project_id, actor:context.employee.name, action:'写入产物', object_type:'artifact', object_id:artifact.id,
        detail_json:json({runId:run.id, version:artifact.version, title:artifact.title, fileId:artifact.file_id, receipt:fileWrite.receipt_id}), created_at:nowIso()});
    }
    return {artifacts, computed, toolReceipts, ...(design ? {output} : {})};
  }

  function createActions(run, context, output, artifacts) {
    const role = context.employee.slug;
    const created = [];
    const add = (kind, title, payload, {amountCents = null, impact = '', evidence = null, dedupe = null} = {}) => {
      if (!ACTION_KINDS[kind]) return null;
      const version = 1;
      const payloadHash = sha256(JSON.stringify({kind, title, payload, version}));
      const id = newId('action');
      const key = dedupe || ('action:' + run.id + ':' + kind + ':' + payloadHash.slice(0, 12));
      const existing = one(db, 'SELECT * FROM opc_actions WHERE dedupe_key=?', key);
      if (existing) { created.push(existing); return existing; }
      insert(db, 'opc_actions', {
        id, project_id:run.project_id, sku_id:run.sku_id, run_id:run.id, kind, object_type:'run', object_id:run.id,
        title, payload_json:json(payload), amount_cents:amountCents, business_impact:impact, evidence_json:json(evidence || {runId:run.id, artifacts:artifacts.map(item => item.id)}),
        version, payload_hash:payloadHash, status:'pending', expires_at:new Date(Date.now() + 24*3600*1000).toISOString(),
        dedupe_key: key, created_at:nowIso(),
      });
      const action = one(db, 'SELECT * FROM opc_actions WHERE id=?', id);
      created.push(action);
      return action;
    };
    if (role === 'store-operator') {
      for (const item of output.actions || []) {
        const text = JSON.stringify(item);
        const kind = /价/.test(text) ? 'change_price' : /预算|推广费/.test(text) ? 'change_budget' : /库存/.test(text) ? 'change_stock' : /活动/.test(text) ? 'join_campaign' : null;
        if (kind) add(kind, ACTION_KINDS[kind] + '：' + (item.object || item.parameter || '运营动作'), {action:item, sourceRun:run.id}, {impact:item.parameter || '', evidence:{runId:run.id, artifactIds:artifacts.map(a => a.id)}});
      }
    }
    if (role === 'aftersales-service' && output.action && ACTION_KINDS[output.action.kind]) {
      add(output.action.kind, ACTION_KINDS[output.action.kind] + '：' + (output.action.reason || '售后处理'), {action:output.action, ticketId:run.ticket_id, sourceRun:run.id},
        {amountCents:Number.isInteger(output.action.amount_cents) ? output.action.amount_cents : null, impact:output.next_step || '', evidence:{runId:run.id, ticketId:run.ticket_id}});
    }
    if (role === 'visual-designer') {
      const promptArtifacts = artifacts.filter(item => /提示词/.test(item.title || ''));
      if (promptArtifacts.length) {
        add('approve_creative', '出图提示词审核：五张主图与详情脚本', {artifactIds:promptArtifacts.map(item => item.id), mode:'prompt_only'},
          {impact:'确认提示词后交由外部生图；工作台不生成图片', evidence:{runId:run.id, mode:'prompt_only'}});
      } else if (artifacts.some(item => item.kind === 'image')) {
        add('approve_creative', '图稿审核：五张主图与详情脚本', {artifactIds:artifacts.filter(item => item.kind === 'image').map(item => item.id)}, {impact:'确认后才可进入上架资料包', evidence:{runId:run.id}});
      }
    }
    if (created.length) {
      for (const action of created) {
        insert(db, 'opc_audit', {id:newId('audit'), project_id:run.project_id, actor:context.employee.name, action:'创建待审动作', object_type:'action', object_id:action.id,
          detail_json:json({runId:run.id, kind:action.kind, title:action.title}), created_at:nowIso()});
      }
      receipt(run, 'action.create', {count:created.length}, {ok:true, status:'success', environment:'local', data:{actions:created.map(item => ({id:item.id, kind:item.kind, status:item.status}))}});
    }
    return created;
  }

  function updateTicket(run, context, output) {
    if (!run.ticket_id) return null;
    const ticket = one(db, 'SELECT * FROM opc_tickets WHERE id=?', run.ticket_id);
    if (!ticket) return null;
    const role = context.employee.slug;
    if (role === 'presales-service') {
      const transfer = output.transfer_after_sales || {};
      const evidence = [...parseJson(ticket.evidence_json, []), {type:'presales_draft', runId:run.id, reply:output.reply}];
      update(db, 'opc_tickets', ticket.id, {status: transfer.needed ? 'transferred' : 'replied', reply_draft:output.reply,
        evidence_json:json(evidence), pending_facts_json:json(output.unknowns || []), owner_employee_id:context.employee.id, updated_at:nowIso()});
      let nextTicket = null;
      if (transfer.needed) {
        const id = 'ticket-' + run.id.slice(-12);
        if (!one(db, 'SELECT id FROM opc_tickets WHERE id=?', id)) insert(db, 'opc_tickets', {id, project_id:run.project_id, sku_id:run.sku_id, order_ref:ticket.order_ref, type:'售后-转交',
          severity:'待分级', emotion:'待判断', status:'open', owner_employee_id:null,
          original_message:ticket.original_message, evidence_json:json(evidence), pending_facts_json:json(output.unknowns || []),
          reply_draft:output.reply, resolution:null, receipt_json:null, created_at:nowIso(), updated_at:nowIso()});
        nextTicket = one(db, 'SELECT * FROM opc_tickets WHERE id=?', id);
      }
      receipt(run, 'ticket.update', {ticketId:ticket.id, transfer:Boolean(transfer.needed)}, {ok:true, status:'success', environment:'local', data:{ticketId:ticket.id, nextTicketId:nextTicket?.id || null}});
      if (nextTicket) {
        insert(db, 'opc_handoffs', {id:newId('handoff'), workflow_id:run.workflow_id, from_run_id:run.id, to_run_id:null,
          from_employee_id:context.employee.id, to_employee_id:'emp-aftersales-service', handoff_key:'ticket:' + nextTicket.id,
          payload_json:json({ticketId:nextTicket.id, fromTicket:ticket.id, reply:output.reply, unknowns:output.unknowns, runId:run.id}), created_at:nowIso()});
      }
      return {ticketId:ticket.id, nextTicketId:nextTicket?.id || null};
    }
    if (role === 'aftersales-service') {
      update(db, 'opc_tickets', ticket.id, {status:'processing', severity:output.severity, emotion:output.emotion,
        reply_draft:output.reply, resolution:output.next_step, owner_employee_id:context.employee.id,
        evidence_json:json([...parseJson(ticket.evidence_json, []), {type:'aftersales_analysis', runId:run.id, needed:output.evidence_needed, options:output.options}]),
        pending_facts_json:json(output.evidence_needed || []), updated_at:nowIso()});
      receipt(run, 'ticket.update', {ticketId:ticket.id}, {ok:true, status:'success', environment:'local', data:{ticketId:ticket.id, status:'processing'}});
      return {ticketId:ticket.id};
    }
    return null;
  }

  function updateWorkflow(run, context, output, artifacts) {
    if (!run.workflow_id || !run.workflow_step_id) return null;
    const step = one(db, 'SELECT * FROM opc_workflow_steps WHERE id=?', run.workflow_step_id);
    if (!step) return null;
    update(db, 'opc_workflow_steps', step.id, {status:'success', run_id:run.id, artifact_ref:artifacts[0]?.id || null, updated_at:nowIso()});
    const steps = all(db, 'SELECT * FROM opc_workflow_steps WHERE workflow_id=? ORDER BY seq', run.workflow_id);
    const current = steps.filter(item => item.status === 'success').length;
    const next = steps.find(item => item.seq > step.seq);
    if (next) {
      insert(db, 'opc_handoffs', {id:newId('handoff'), workflow_id:run.workflow_id, from_run_id:run.id, to_run_id:null,
        from_employee_id:context.employee.id, to_employee_id:next.employee_id || null,
        handoff_key:run.workflow_id + ':' + step.key + '->' + next.key,
        payload_json:json({fromStep:step.key, toStep:next.key, runId:run.id, artifactIds:artifacts.map(item => item.id),
          summary:truncate(output.summary || output.diagnosis || output.reply || '', 400)}), created_at:nowIso()});
    }
    update(db, 'opc_workflows', run.workflow_id, {current_step:current, status: current === steps.length ? 'success' : 'running', updated_at:nowIso()});
    return {workflowId:run.workflow_id, currentStep:current, totalSteps:steps.length};
  }

  api.executeRun = async function executeRun(runId) {
    const run = one(db, 'SELECT * FROM opc_runs WHERE id=?', runId);
    if (!run) return null;
    if (run.status === 'cancelled' || run.status === 'success') return run;
    const claimed = db.prepare("UPDATE opc_runs SET status='running', started_at=COALESCE(started_at,?), lease_owner=?, lease_until=?, heartbeat_at=?, attempt=attempt+1 WHERE id=? AND status='queued'")
      .run(nowIso(), workerId, Date.now() + 60000, nowIso(), run.id);
    if (!claimed.changes) return one(db, 'SELECT * FROM opc_runs WHERE id=?', run.id);
    logRunEvent(db, run.id, 'started', {worker:workerId});
    const heartbeat = setInterval(() => {
      try { update(db, 'opc_runs', run.id, {lease_until:Date.now() + 60000, heartbeat_at:nowIso()}); } catch {}
    }, 5000);
    heartbeat.unref?.();
    const context = parseJson(run.context_json, {});
    try {
      const validated = await step(run, 'validate_input', '校验输入与数据范围', async () => {
        const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', run.project_id);
        if (!project) throw new RunError('project_missing', '项目不存在');
        if (run.employee_id) {
          const employee = one(db, 'SELECT * FROM opc_employees WHERE id=?', run.employee_id);
          if (!employee) throw new RunError('employee_missing', '员工不存在');
          if (employee.status !== 'active') throw new RunError('employee_disabled', '员工已停用');
        }
        if (run.sku_id) {
          const sku = one(db, 'SELECT * FROM opc_skus WHERE id=? AND project_id=?', run.sku_id, run.project_id);
          if (!sku) throw new RunError('sku_missing', 'SKU 不属于该项目');
        }
        const input = parseJson(run.input_json, {});
        if (!input.task || !String(input.task).trim()) throw new RunError('task_missing', '任务说明为空', {status:'needs_info'});
        return {projectId:run.project_id, employeeId:run.employee_id, skuId:run.sku_id, ticketId:run.ticket_id, task:truncate(input.task, 300)};
      });
      const config = await step(run, 'load_employee_config', '加载岗位、心智、Skill 与工具授权', async () => {
        if (!context.employee) return {system:true};
        const mind = one(db, 'SELECT * FROM opc_employee_minds WHERE employee_id=? AND version=?', context.employee.id, context.employee.mind_version);
        if (!mind) throw new RunError('mind_missing', '员工心智版本不存在');
        const grants = all(db, 'SELECT * FROM opc_tool_grants WHERE employee_id=?', context.employee.id);
        const skills = all(db, 'SELECT s.slug,s.name,s.version,s.package_path,s.install_status,es.relation FROM opc_employee_skills es JOIN opc_skills s ON s.id=es.skill_id WHERE es.employee_id=?', context.employee.id);
        const model = context.model ? one(db, 'SELECT * FROM opc_model_configs WHERE id=?', context.model.id) : null;
        if (!model?.enabled) throw new RunError('model_not_configured', '模型未启用', {status:'awaiting_authorization'});
        return {mindVersion:mind.version, skills:skills.length, grantedTools:grants.filter(g => g.enabled).length,
          model:{id:model.id, provider:model.provider, model:model.model, providerModel:null, fallbackFrom:context.fallback_from || null}};
      });
      const loaded = await step(run, 'load_context', '读取知识、报表与上游产物', async () => {
        const prefetched = await prefetchTools(run, context);
        const prompt = buildMessages(run, context, prefetched);
        return {knowledge:prefetched.knowledge.length, reportId:prefetched.report?.id || null, receipts:prefetched.receipts.length,
          promptChars:prompt.system.length + prompt.user.length, toolResults:prefetched.toolResults, economics:prefetched.economics,
          report:prefetched.report ? {id:prefetched.report.id, name:prefetched.report.name} : null};
      });
      const generated = await step(run, 'model_call', '调用模型并校验结构化输出', async () => modelStep(run, context, {...loaded, knowledge:all(db, 'SELECT * FROM opc_knowledge WHERE project_id=? LIMIT 12', run.project_id)}));
      const validatedOutput = await step(run, 'validate_output', '结构化输出复核与补足', async () => {
        const errors = validateRoleOutput(context.employee.slug, generated.output);
        return {errors, normalized:(generated.output._meta || {}).normalized === true, notes:(generated.output._meta || {}).notes || []};
      });
      const written = await step(run, 'write_artifacts', '写入可读产物、文件与证据', async () => writeArtifacts(run, context, generated.output, {...loaded, economics:loaded.economics}));
      if (written.output) generated.output = written.output;
      const finalized = await step(run, 'finalize', '创建待审动作、工单与工作流交接', async () => {
        const actions = createActions(run, context, generated.output, written.artifacts);
        const ticket = updateTicket(run, context, generated.output);
        const workflow = updateWorkflow(run, context, generated.output, written.artifacts);
        const day = nowIso().slice(0, 10);
        const modelInfo = generated.output._meta?.model || {};
        const tokens = (modelInfo.tokensIn || 0) + (modelInfo.tokensOut || 0);
        db.prepare('INSERT INTO opc_daily_usage(employee_id,day,tokens,runs) VALUES(?,?,?,1) ON CONFLICT(employee_id,day) DO UPDATE SET tokens=tokens+excluded.tokens, runs=runs+1')
          .run(context.employee.id, day, tokens);
        return {actions:actions.map(item => ({id:item.id, kind:item.kind, status:item.status})), ticket, workflow, tokens};
      });
      const currentStatus = one(db, 'SELECT status FROM opc_runs WHERE id=?', run.id)?.status;
      if (currentStatus === 'cancelled') return one(db, 'SELECT * FROM opc_runs WHERE id=?', run.id);
      const modelInfo = generated.output._meta?.model || {};
      setRun(run.id, {status:'success', output_json:json({output:generated.output, computed:written.computed, meta:{validation:validatedOutput, model:modelInfo, image:(generated.output._meta || {}).image || null}}),
        raw_model_output:truncate(generated.raw, 20000), error_code:null, error_message:null, provider:modelInfo.provider || null,
        provider_model:modelInfo.providerModel || null, tokens_in:modelInfo.tokensIn ?? null, tokens_out:modelInfo.tokensOut ?? null,
        first_token_ms:modelInfo.firstTokenMs ?? null, duration_ms:Date.now() - new Date(run.started_at || run.created_at).getTime(),
        tool_calls:all(db, 'SELECT COUNT(*) AS n FROM opc_tool_receipts WHERE run_id=?', run.id)[0].n,
        finished_at:nowIso(), lease_owner:null, lease_until:null, heartbeat_at:nowIso()});
      logRunEvent(db, run.id, 'finished', {status:'success', artifacts:written.artifacts.length, actions:finalized.actions.length});
      audit(db, {projectId:run.project_id, actor:context.employee?.name || '系统', action:'运行成功', objectType:'run', objectId:run.id,
        detail:{artifacts:written.artifacts.map(item => item.id), actions:finalized.actions.map(item => item.id), model:modelInfo}});
      return one(db, 'SELECT * FROM opc_runs WHERE id=?', run.id);
    } catch (failure) {
      const status = failure.status || 'failed';
      setRun(run.id, {status, error_code:failure.code || 'execution_failed', error_message:truncate(failure.message, 1800),
        raw_model_output:failure.detail?.raw ? truncate(failure.detail.raw, 20000) : null, recoverable:failure.recoverable === false ? 0 : 1,
        finished_at:nowIso(), lease_owner:null, lease_until:null, heartbeat_at:nowIso(),
        duration_ms:Date.now() - new Date(run.started_at || run.created_at).getTime()});
      logRunEvent(db, run.id, 'failed', {status, code:failure.code || 'execution_failed', error:truncate(failure.message, 800), recoverable:failure.recoverable !== false});
      audit(db, {projectId:run.project_id, actor:context.employee?.name || '系统', action:'运行失败', objectType:'run', objectId:run.id,
        detail:{code:failure.code || 'execution_failed', message:truncate(failure.message, 800), status}});
      return one(db, 'SELECT * FROM opc_runs WHERE id=?', run.id);
    } finally {
      clearInterval(heartbeat);
    }
  };

  api.retryRun = function retryRun(runId, {fromStep = null, actor = '本机经营者'} = {}) {
    const run = one(db, 'SELECT * FROM opc_runs WHERE id=?', runId);
    if (!run) throw Object.assign(new Error('运行不存在'), {status:404});
    if (run.status === 'running') throw Object.assign(new Error('运行进行中，不能重试'), {status:409});
    const steps = all(db, 'SELECT * FROM opc_run_steps WHERE run_id=? ORDER BY seq', runId);
    const targetKey = fromStep || steps.find(item => item.status === 'failed')?.key || 'model_call';
    const target = steps.find(item => item.key === targetKey);
    if (!target) throw Object.assign(new Error('找不到重试节点'), {status:400});
    tx(db, () => {
      db.prepare('DELETE FROM opc_run_steps WHERE run_id=? AND seq>=?').run(runId, target.seq);
      update(db, 'opc_runs', runId, {status:'queued', error_code:null, error_message:null, output_json: targetKey === 'finalize' ? run.output_json : null,
        raw_model_output: targetKey === 'finalize' ? run.raw_model_output : null, finished_at:null, lease_owner:null, lease_until:null, heartbeat_at:null});
      logRunEvent(db, runId, 'retry', {fromStep:targetKey, actor});
      audit(db, {projectId:run.project_id, actor, action:'重试运行', objectType:'run', objectId:runId, detail:{fromStep:targetKey}});
    });
    return one(db, 'SELECT * FROM opc_runs WHERE id=?', runId);
  };

  api.cancelRun = function cancelRun(runId, actor = '本机经营者') {
    const run = one(db, 'SELECT * FROM opc_runs WHERE id=?', runId);
    if (!run) throw Object.assign(new Error('运行不存在'), {status:404});
    if (run.status === 'success') throw Object.assign(new Error('已成功的运行不能取消'), {status:409});
    update(db, 'opc_runs', runId, {status:'cancelled', finished_at:nowIso(), lease_owner:null, lease_until:null});
    logRunEvent(db, runId, 'cancelled', {actor});
    audit(db, {projectId:run.project_id, actor, action:'取消运行', objectType:'run', objectId:runId});
    return one(db, 'SELECT * FROM opc_runs WHERE id=?', runId);
  };

  api.recoverStaleRuns = function recoverStaleRuns() {
    const now = Date.now();
    const stale = all(db, "SELECT * FROM opc_runs WHERE status='running' AND (lease_until IS NULL OR lease_until<?)", now);
    for (const run of stale) {
      update(db, 'opc_runs', run.id, {status:'queued', lease_owner:null, lease_until:null, error_code:'lease_recovered', error_message:'执行器租约过期，已回收并继续未完成节点'});
      logRunEvent(db, run.id, 'lease_recovered', {previousWorker:run.lease_owner});
    }
    return stale.length;
  };

  api.tick = async function tick() {
    if (api._busy) return;
    api._busy = true;
    try {
      const next = one(db, "SELECT id FROM opc_runs WHERE status='queued' ORDER BY created_at LIMIT 1");
      if (next) await api.executeRun(next.id);
    } finally {
      api._busy = false;
    }
  };

  api.start = function start({intervalMs = 1000} = {}) {
    if (api._timer) return;
    api.recoverStaleRuns();
    api._timer = setInterval(() => { api.tick().catch(() => {}); }, intervalMs);
    api._timer.unref?.();
  };

  api.stop = function stop() {
    if (api._timer) clearInterval(api._timer);
    api._timer = null;
  };

  api.getRun = function getRun(runId) {
    const run = one(db, 'SELECT * FROM opc_runs WHERE id=?', runId);
    if (!run) return null;
    return {...run,
      input:parseJson(run.input_json, {}), context:parseJson(run.context_json, {}), output:parseJson(run.output_json, null),
      steps:all(db, 'SELECT * FROM opc_run_steps WHERE run_id=? ORDER BY seq', runId),
      receipts:all(db, 'SELECT * FROM opc_tool_receipts WHERE run_id=? ORDER BY created_at', runId).map(item => ({...item, request:parseJson(item.request_json,null), response:parseJson(item.response_json,null)})),
      artifacts:all(db, 'SELECT * FROM opc_artifacts WHERE run_id=? ORDER BY created_at', runId),
      actions:all(db, 'SELECT * FROM opc_actions WHERE run_id=? ORDER BY created_at', runId).map(item => ({...item, payload:parseJson(item.payload_json,null)})),
      events:all(db, 'SELECT * FROM opc_run_events WHERE run_id=? ORDER BY id', runId),
    };
  };

  return api;
}
