import {mkdirSync, writeFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {one, insert, update, tx, nowIso, json, parseJson, newId, sha256, audit} from './db.js';

const EXTERNAL_KINDS = new Set(['publish_listing','change_price','change_budget','change_stock','join_campaign','send_customer_message','refund','reship','coupon','contact_supplier','sample_order']);

function payloadHash(action) {
  return sha256(JSON.stringify({kind:action.kind, title:action.title, payload:parseJson(action.payload_json, null), version:action.version}));
}

export function createActions({db, filesRoot}) {
  const api = {};

  api.decide = function decide(actionId, {decision, note = '', actor = '本机经营者'}) {
    if (!['approve','reject','return'].includes(decision)) throw Object.assign(new Error('审批决定必须为 approve/reject/return'), {status:400});
    const action = one(db, 'SELECT * FROM opc_actions WHERE id=?', actionId);
    if (!action) throw Object.assign(new Error('动作不存在'), {status:404});
    if (action.status === 'executed' && decision === 'approve') return {...action, duplicate:true};
    if (action.status === 'rejected' && decision === 'reject') return {...action, duplicate:true};
    if (!['pending','awaiting_authorization','unknown_result'].includes(action.status)) {
      throw Object.assign(new Error('动作当前状态为 ' + action.status + '，不能重复审批'), {status:409, code:'invalid_state'});
    }
    if (action.expires_at && Date.parse(action.expires_at) < Date.now()) {
      update(db, 'opc_actions', actionId, {status:'rejected', decided_by:actor, decided_at:nowIso(), decision_note:'审批已过期：' + note});
      audit(db, {projectId:action.project_id, actor, action:'审批过期', objectType:'action', objectId:actionId});
      throw Object.assign(new Error('审批已过期，请重新提交'), {status:409, code:'expired'});
    }
    if (payloadHash(action) !== action.payload_hash) {
      throw Object.assign(new Error('动作内容已变更，旧审批失效，请重新提交'), {status:409, code:'payload_changed'});
    }
    if (decision === 'reject') {
      update(db, 'opc_actions', actionId, {status:'rejected', decided_by:actor, decided_at:nowIso(), decision_note:note || '已拒绝', receipt_json:null});
      audit(db, {projectId:action.project_id, actor, action:'拒绝动作', objectType:'action', objectId:actionId, detail:{kind:action.kind, note}});
      return one(db, 'SELECT * FROM opc_actions WHERE id=?', actionId);
    }
    if (decision === 'return') {
      update(db, 'opc_actions', actionId, {status:'returned', decided_by:actor, decided_at:nowIso(), decision_note:note || '退回修改', receipt_json:null});
      audit(db, {projectId:action.project_id, actor, action:'退回动作', objectType:'action', objectId:actionId, detail:{kind:action.kind, note}});
      return one(db, 'SELECT * FROM opc_actions WHERE id=?', actionId);
    }

    let execution;
    if (action.kind === 'write_file') {
      const dir = resolve(filesRoot, action.project_id, 'actions');
      mkdirSync(dir, {recursive:true});
      const path = resolve(dir, action.id + '.txt');
      const content = 'OPC 本地写入动作\n动作：' + action.title + '\n执行人：' + actor + '\n时间：' + nowIso() + '\n内容：' + JSON.stringify(parseJson(action.payload_json, null), null, 2);
      writeFileSync(path, content, 'utf8');
      execution = {status:'executed', receipt:{ok:true, environment:'local', executedAt:nowIso(), path, size:statSync(path).size, sha256:sha256(content), businessId:action.id}};
    } else if (action.kind === 'approve_creative' || action.kind === 'approve_listing') {
      const payload = parseJson(action.payload_json, {});
      const artifactIds = Array.isArray(payload.artifactIds) ? payload.artifactIds : [];
      for (const id of artifactIds) {
        const artifact = one(db, 'SELECT * FROM opc_artifacts WHERE id=? AND project_id=?', id, action.project_id);
        if (artifact) update(db, 'opc_artifacts', id, {status:'confirmed'});
      }
      execution = {status:'executed', receipt:{ok:true, environment:'local', executedAt:nowIso(), confirmedArtifacts:artifactIds, businessId:action.id}};
    } else if (EXTERNAL_KINDS.has(action.kind)) {
      const connectionId = action.kind === 'send_customer_message' ? 'conn-pdd-orders' : 'conn-pdd-write';
      const connection = one(db, 'SELECT * FROM opc_connections WHERE id=?', connectionId);
      const config = parseJson(connection?.config_json, {});
      const permissions = action.kind === 'send_customer_message' ? ['客服发送授权'] : ['生产应用权限','店铺操作授权','测试店铺授权'];
      execution = {status:'awaiting_authorization', receipt:{ok:false, environment:'real', checkedAt:nowIso(), externalExecuted:false,
        reason:'尚未取得此动作的店铺权限与对应执行适配器，等待授权。',
        missing:[...new Set(['ECOMMERCE_PDD_ACCESS_TOKEN','店铺授权',...permissions,...(config.secretNames || [])])],
        connectionId, connectionStatus:connection?.status || 'not_configured', businessId:null,
        approvalBinding:{actionId:action.id, kind:action.kind, version:action.version, amountCents:action.amount_cents ?? null,
          expiresAt:action.expires_at, payloadHash:action.payload_hash},
        next:'在有效期内取得该动作授权与执行适配器后复核内容、金额和版本，并保存第三方回执'}};
    } else {
      execution = {status:'unknown_result', receipt:{ok:false, environment:'local', executedAt:nowIso(), externalExecuted:false, reason:'未知动作类型，未执行'}};
    }
    update(db, 'opc_actions', actionId, {status:execution.status, decided_by:actor, decided_at:nowIso(), decision_note:note || '已批准',
      receipt_json:json(execution.receipt), executed_at:execution.status === 'executed' ? nowIso() : null});
    audit(db, {projectId:action.project_id, actor, action:execution.status === 'executed' ? '批准并执行' : '批准等待授权',
      objectType:'action', objectId:actionId, detail:{kind:action.kind, receipt:execution.receipt}});
    return one(db, 'SELECT * FROM opc_actions WHERE id=?', actionId);
  };

  api.revise = function revise(actionId, {payload, note = '', actor = '本机经营者'}) {
    const action = one(db, 'SELECT * FROM opc_actions WHERE id=?', actionId);
    if (!action) throw Object.assign(new Error('动作不存在'), {status:404});
    if (!['pending','returned','awaiting_authorization'].includes(action.status)) throw Object.assign(new Error('当前状态不能修改草稿'), {status:409});
    const version = action.version + 1;
    const id = newId('action');
    const nextPayload = payload ?? parseJson(action.payload_json, null);
    const hash = sha256(JSON.stringify({kind:action.kind, title:action.title, payload:nextPayload, version}));
    tx(db, () => {
      update(db, 'opc_actions', actionId, {status:'superseded', decision_note:'已修改草稿，旧审批失效：' + note});
      insert(db, 'opc_actions', {
        id, project_id:action.project_id, sku_id:action.sku_id, run_id:action.run_id, kind:action.kind, object_type:action.object_type, object_id:action.object_id,
        title:action.title, payload_json:json(nextPayload), amount_cents:action.amount_cents, business_impact:action.business_impact,
        evidence_json:action.evidence_json, version, payload_hash:hash, status:'pending', expires_at:new Date(Date.now() + 24*3600*1000).toISOString(),
        dedupe_key:'action-revise:' + actionId + ':' + version, created_at:nowIso(),
      });
      audit(db, {projectId:action.project_id, actor, action:'修改动作草稿', objectType:'action', objectId:id, detail:{previous:actionId, version}});
    });
    return one(db, 'SELECT * FROM opc_actions WHERE id=?', id);
  };

  api.list = function list({projectId = null, status = null, limit = 100} = {}) {
    const select = "SELECT a.*, e.name AS submitter_name, e.slug AS submitter_slug FROM opc_actions a LEFT JOIN opc_runs r ON r.id=a.run_id LEFT JOIN opc_employees e ON e.id=r.employee_id";
    const rows = projectId
      ? db.prepare(select + ' WHERE a.project_id=? ORDER BY a.created_at DESC LIMIT ?').all(projectId, limit)
      : db.prepare(select + ' ORDER BY a.created_at DESC LIMIT ?').all(limit);
    return rows.filter(row => !status || row.status === status).map(row => {
      const payload = parseJson(row.payload_json, null);
      const evidence = parseJson(row.evidence_json, null);
      const rawImpact = payload && (payload.businessImpact || payload.impact || payload.business_impact || payload.description || payload.note || payload.reason || payload.summary || payload.prompt);
      const businessImpact = rawImpact ? (typeof rawImpact === 'string' ? rawImpact : JSON.stringify(rawImpact)) : null;
      return {...row, submitter: row.submitter_name || '系统/经营者', submitter_slug: row.submitter_slug || null,
        business_impact: businessImpact ? businessImpact.slice(0, 160) : null,
        payload, evidence, receipt:parseJson(row.receipt_json, null)};
    });
  };

  return api;
}
