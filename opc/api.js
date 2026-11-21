import {randomBytes, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, statSync, existsSync, unlinkSync} from 'node:fs';
import {resolve, sep, extname, basename} from 'node:path';
import {one, all, insert, update, tx, nowIso, json, parseJson, newId, sha256, audit} from './db.js';
import {ROLES, ROLE_BY_SLUG, STATUS_LABELS, TOOL_CATALOG, ACTION_KINDS, VERIFICATION_LABELS, SKILL_BINDINGS, OPC_VERSION} from './constants.js';
import {unitEconomics, reportSummary, cny} from './calc.js';
import {testModel} from './model.js';
import {pddGoodsSearch, pddAuthorizationChecks} from './adapters/pdd.js';
import {ali1688Search} from './adapters/ali1688.js';
import {tavilySearch} from './adapters/tavily.js';
import {mcpListTools} from './adapters/mcp.js';

import {pythonFor} from './python.js';
import {previewReport} from './import.js';
import {createZip} from './zip.js';

const SESSION_COOKIE = 'opc_session';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.json':'application/json; charset=utf-8'};
const LOOPBACK = new Set(['127.0.0.1','localhost','::1','[::1]']);

const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...headers},
});
const errorResponse = (failure) => {
  const status = failure?.status || 500;
  return jsonResponse({error:{code:failure?.code || (status === 500 ? 'internal_error' : 'request_error'), message:failure?.message || '请求失败'}}, status);
};
const textResponse = (text, status = 200) => new Response(text, {status, headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
const csvEscape = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};
const toCsv = (header, rows) => [header.join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\n');
const safeName = (name) => String(name || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
const parseCookies = (request) => Object.fromEntries((request.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map(part => {
  const index = part.indexOf('=');
  return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
}));

export function createOpcHttp({db, runner, actions, workflows, filesRoot, dataDir, publicDir, projectDir}) {
  const api = {};

  function currentSession(request) {
    const sid = parseCookies(request)[SESSION_COOKIE];
    if (!sid) return null;
    const session = one(db, 'SELECT * FROM opc_sessions WHERE id=?', sid);
    if (!session) return null;
    if (session.expires_at < Date.now()) { db.prepare('DELETE FROM opc_sessions WHERE id=?').run(sid); return null; }
    return session;
  }

  function createSession() {
    const operator = one(db, 'SELECT * FROM opc_operator LIMIT 1');
    if (!operator) throw Object.assign(new Error('本机经营者未初始化'), {status:500});
    const id = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    insert(db, 'opc_sessions', {id, operator_id:operator.id, csrf, expires_at:Date.now() + SESSION_TTL, created_at:nowIso()});
    return {session:{id, csrf}, operator};
  }

  function requireSession(request) {
    const session = currentSession(request);
    if (!session) throw Object.assign(new Error('请先在本机进入工作台'), {status:401, code:'unauthorized'});
    return session;
  }

  function requireCsrf(request, session) {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const token = request.headers.get('x-opc-csrf') || '';
    if (!token || token !== session.csrf) throw Object.assign(new Error('CSRF 校验失败，请刷新页面重试'), {status:403, code:'csrf_failed'});
  }

  function assertLoopback(request) {
    if (process.env.OPC_ALLOW_REMOTE === '1') return;
    const host = new URL(request.url).hostname;
    if (!LOOPBACK.has(host)) throw Object.assign(new Error('OPC 工作台默认只允许本机访问'), {status:403, code:'local_only'});
  }

  function assertOrigin(request) {
    const origin = request.headers.get('origin');
    if (!origin) return;
    const host = request.headers.get('host');
    try { if (new URL(origin).host !== host) throw new Error('origin'); }
    catch { throw Object.assign(new Error('跨站请求被拒绝'), {status:403, code:'cross_origin'}); }
  }

  async function readJson(request) {
    const type = request.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw Object.assign(new Error('请求体必须是 JSON'), {status:415});
    const text = await request.text();
    if (text.length > MAX_BODY) throw Object.assign(new Error('请求体过大'), {status:413});
    try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('JSON 解析失败'), {status:400}); }
  }

  function employeeView(employee) {
    const role = ROLE_BY_SLUG[employee.slug];
    const model = employee.model_id ? one(db, 'SELECT name,model,provider,enabled FROM opc_model_configs WHERE id=?', employee.model_id) : null;
    const skillCount = one(db, 'SELECT COUNT(*) AS n FROM opc_employee_skills WHERE employee_id=?', employee.id)?.n || 0;
    const grantCount = one(db, 'SELECT COUNT(*) AS n FROM opc_tool_grants WHERE employee_id=? AND enabled=1', employee.id)?.n || 0;
    const lastRun = one(db, 'SELECT id,status,created_at,finished_at FROM opc_runs WHERE employee_id=? ORDER BY created_at DESC LIMIT 1', employee.id);
    return {...employee, permissions:parseJson(employee.permissions_json, {}), role:role ? {key:role.key, description:role.description, taskTitle:role.taskTitle, taskPlaceholder:role.taskPlaceholder, tools:role.tools, outputFields:role.outputFields} : null,
      model, skillCount, grantCount, lastRun:lastRun || null};
  }

  function projectSummary(project) {
    if (!project) return null;
    const skus = all(db, 'SELECT * FROM opc_skus WHERE project_id=? ORDER BY price_cents', project.id);
    return {...project,
      skuCount:skus.length, knowledgeCount:one(db, 'SELECT COUNT(*) AS n FROM opc_knowledge WHERE project_id=?', project.id)?.n || 0,
      artifactCount:one(db, 'SELECT COUNT(*) AS n FROM opc_artifacts WHERE project_id=?', project.id)?.n || 0,
      openTickets:one(db, "SELECT COUNT(*) AS n FROM opc_tickets WHERE project_id=? AND status NOT IN ('closed','resolved')", project.id)?.n || 0,
      pendingActions:one(db, "SELECT COUNT(*) AS n FROM opc_actions WHERE project_id=? AND status='pending'", project.id)?.n || 0,
      activeRuns:one(db, "SELECT COUNT(*) AS n FROM opc_runs WHERE project_id=? AND status IN ('queued','running')", project.id)?.n || 0,
      skus:skus.map(sku => ({...sku, specs:parseJson(sku.specs_json, {}), economics:unitEconomics({priceCents:sku.price_cents,costCents:sku.cost_cents,shippingCents:sku.shipping_cents,packagingCents:sku.packaging_cents,feeBps:sku.platform_fee_bps,refundCents:sku.refund_cents,adCents:sku.ad_cents,taxCents:sku.tax_cents,discountCents:sku.discount_cents})}))};
  }

  function projectDetail(projectId) {
    const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', projectId);
    if (!project) throw Object.assign(new Error('项目不存在'), {status:404});
    const store = one(db, 'SELECT * FROM opc_stores WHERE project_id=? ORDER BY created_at LIMIT 1', projectId);
    const product = one(db, 'SELECT * FROM opc_products WHERE project_id=? ORDER BY created_at LIMIT 1', projectId);
    const reports = all(db, 'SELECT * FROM opc_reports WHERE project_id=? ORDER BY created_at DESC', projectId).map(report => {
      const rows = all(db, 'SELECT * FROM opc_report_rows WHERE report_id=? ORDER BY row_no', report.id).map(row => ({...row, revenueCents:row.revenue_cents, adSpendCents:row.ad_spend_cents, errors:parseJson(row.errors_json, []), warnings:parseJson(row.warnings_json, [])}));
      const summary = reportSummary(rows);
      return {...report, metricDefinitions:parseJson(report.metric_definitions_json, {}), summary, metrics:summary.metrics, invalidRows:rows.filter(row => row.status === 'invalid').length, rows:rows.slice(0, 60)};
    });
    return {...project, ...projectSummary(project), store:store ? {...store, facts:parseJson(store.facts_json, {})} : null, product,
      suppliers:all(db, 'SELECT * FROM opc_suppliers ORDER BY created_at').map(row => ({...row, evidence:parseJson(row.evidence_json, {})})),
      quotes:all(db, 'SELECT q.*, s.name AS supplier_name FROM opc_quotes q LEFT JOIN opc_suppliers s ON s.id=q.supplier_id JOIN opc_products p ON p.id=q.product_id WHERE p.project_id=? ORDER BY q.unit_price_cents', projectId).map(row => ({...row, raw:parseJson(row.raw_json, {})})),
      reports, knowledge:all(db, 'SELECT * FROM opc_knowledge WHERE project_id=? ORDER BY created_at DESC', projectId),
      tickets:all(db, 'SELECT * FROM opc_tickets WHERE project_id=? ORDER BY updated_at DESC', projectId).map(row => ({...row, evidence:parseJson(row.evidence_json, []), pendingFacts:parseJson(row.pending_facts_json, [])})),
      runs:all(db, 'SELECT id,employee_id,status,error_code,error_message,created_at,finished_at,provider_model FROM opc_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 20', projectId),
      artifacts:all(db, 'SELECT id,title,kind,version,status,run_id,file_id,created_at FROM opc_artifacts WHERE project_id=? ORDER BY created_at DESC LIMIT 30', projectId),
      workflows:workflows.list(projectId), actions:actions.list({projectId, limit:30}),
      files:all(db, 'SELECT id,name,mime,size,sha256,source,created_at FROM opc_files WHERE project_id=? ORDER BY created_at DESC', projectId),
    };
  }

  function saveUpload({buffer, name, mime, projectId, skuId = null, runId = null, source = '上传附件'}) {
    if (buffer.length > MAX_UPLOAD) throw Object.assign(new Error('文件超过 25 MB 限制'), {status:413});
    const dir = resolve(filesRoot, projectId || 'shared', 'uploads');
    mkdirSync(dir, {recursive:true});
    const id = newId('file');
    const safe = id.slice(-8) + '-' + safeName(name);
    const path = resolve(dir, safe);
    writeFileSync(path, buffer);
    const relative = path.slice(filesRoot.length).replace(/^[/\\]/, '');
    insert(db, 'opc_files', {id, project_id:projectId || null, sku_id:skuId, run_id:runId, name:safeName(name), mime: mime || 'application/octet-stream',
      size:statSync(path).size, sha256:sha256(buffer), storage_path:relative, access_scope:'project', source, created_at:nowIso()});
    return one(db, 'SELECT * FROM opc_files WHERE id=?', id);
  }

  function fileResponse(file, {inline = false, downloadName = null} = {}) {
    const path = resolve(filesRoot, file.storage_path);
    if (!path.startsWith(filesRoot + sep) || !existsSync(path)) throw Object.assign(new Error('文件不存在'), {status:404});
    const buffer = readFileSync(path);
    const disposition = (inline ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(downloadName || file.name);
    return new Response(buffer, {headers:{'Content-Type':file.mime || 'application/octet-stream','Content-Length':String(buffer.length),
      'Content-Disposition':disposition,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }

  async function serveStatic(pathname, request) {
    let rel = pathname;
    if (rel === '/opc' || rel === '/opc/') rel = '/opc.html';
    const target = resolve(publicDir, '.' + rel);
    if (!target.startsWith(publicDir + sep)) return new Response('Not found', {status:404});
    if (!existsSync(target) || !statSync(target).isFile()) return new Response('Not found', {status:404});
    const body = request.method === 'HEAD' ? null : readFileSync(target);
    return new Response(body, {headers:{'Content-Type':MIME[extname(target)] || 'application/octet-stream','Cache-Control':'no-cache',
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"}});
  }

  function sse(runId, request) {
    const url = new URL(request.url);
    let last = Number(request.headers.get('last-event-id') || url.searchParams.get('after') || 0) || 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let timer = null;
        let heartbeat = null;
        const close = () => { if (closed) return; closed = true; clearInterval(timer); clearInterval(heartbeat); try { controller.close(); } catch {} };
        const sendEvent = (event) => {
          if (closed) return;
          controller.enqueue(encoder.encode('id: ' + event.id + '\nevent: ' + event.type + '\ndata: ' + (event.payload_json || '{}') + '\n\n'));
        };
        const tick = () => {
          if (closed) return;
          const events = all(db, 'SELECT * FROM opc_run_events WHERE run_id=? AND id>? ORDER BY id LIMIT 50', runId, last);
          for (const event of events) { last = event.id; sendEvent(event); }
          const run = one(db, 'SELECT status FROM opc_runs WHERE id=?', runId);
          if (!run) { controller.enqueue(encoder.encode('event: error\ndata: {"error":"run_not_found"}\n\n')); close(); return; }
          if (['success','failed','cancelled','paused','needs_info','awaiting_authorization'].includes(run.status) && !events.length) {
            controller.enqueue(encoder.encode('event: done\ndata: ' + JSON.stringify({status:run.status}) + '\n\n'));
            setTimeout(close, 120);
          }
        };
        timer = setInterval(tick, 800);
        heartbeat = setInterval(() => { if (!closed) { try { controller.enqueue(encoder.encode(': keepalive\n\n')); } catch { close(); } } }, 15000);
        timer.unref?.();
        heartbeat.unref?.();
        request.signal.addEventListener('abort', close);
        tick();
      },
    }, {highWaterMark:32});
    return new Response(stream, {headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'}});
  }

  async function handle(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    try {
      if (pathname === '/opc' || pathname.startsWith('/opc/')) {
        assertLoopback(request);
        return await serveStatic(pathname, request);
      }
      if (!pathname.startsWith('/api/opc')) return new Response('Not found', {status:404});
      assertLoopback(request);
      assertOrigin(request);
      const path = pathname.slice('/api/opc'.length) || '/';
      const method = request.method;

      if (path === '/health' && method === 'GET') {
        return jsonResponse({ok:true, version:OPC_VERSION, database:'sqlite', files:existsSync(filesRoot), worker:Boolean(runner._timer),
          counts:{projects:one(db, 'SELECT COUNT(*) AS n FROM opc_projects')?.n || 0, employees:one(db, 'SELECT COUNT(*) AS n FROM opc_employees')?.n || 0,
            runs:one(db, 'SELECT COUNT(*) AS n FROM opc_runs')?.n || 0, artifacts:one(db, 'SELECT COUNT(*) AS n FROM opc_artifacts')?.n || 0},
          now:nowIso()});
      }

      if (path === '/session' && method === 'POST') {
        const existing = currentSession(request);
        if (existing) {
          const operator = one(db, 'SELECT * FROM opc_operator WHERE id=?', existing.operator_id);
          return jsonResponse({ok:true, operator, csrf:existing.csrf, resumed:true});
        }
        const {session, operator} = createSession();
        return jsonResponse({ok:true, operator, csrf:session.csrf}, 200, {'Set-Cookie':SESSION_COOKIE + '=' + session.id + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_TTL/1000)});
      }
      if (path === '/session' && method === 'GET') {
        const session = currentSession(request);
        if (!session) return jsonResponse({error:{code:'unauthorized', message:'未登录'}}, 401);
        const operator = one(db, 'SELECT * FROM opc_operator WHERE id=?', session.operator_id);
        return jsonResponse({ok:true, operator, csrf:session.csrf});
      }
      if (path === '/session' && method === 'DELETE') {
        const sid = parseCookies(request)[SESSION_COOKIE];
        if (sid) db.prepare('DELETE FROM opc_sessions WHERE id=?').run(sid);
        return jsonResponse({ok:true}, 200, {'Set-Cookie':SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
      }

      const session = requireSession(request);
      requireCsrf(request, session);
      const operator = one(db, 'SELECT * FROM opc_operator WHERE id=?', session.operator_id);
      const actor = operator?.name || '本机经营者';

      if (path === '/bootstrap' && method === 'GET') {
        const employees = all(db, 'SELECT * FROM opc_employees ORDER BY created_at').map(employeeView);
        return jsonResponse({operator, csrf:session.csrf, version:OPC_VERSION,
          counts:{projects:one(db, 'SELECT COUNT(*) AS n FROM opc_projects')?.n || 0, employees:employees.length,
            skills:one(db, 'SELECT COUNT(*) AS n FROM opc_skills')?.n || 0, bindings:one(db, 'SELECT COUNT(*) AS n FROM opc_employee_skills WHERE relation=\'initial\'')?.n || 0,
            installed:one(db, "SELECT COUNT(*) AS n FROM opc_skills WHERE install_status='installed'")?.n || 0,
            pendingActions:one(db, "SELECT COUNT(*) AS n FROM opc_actions WHERE status='pending'")?.n || 0,
            running:one(db, "SELECT COUNT(*) AS n FROM opc_runs WHERE status IN ('queued','running')")?.n || 0},
          employees, projects:all(db, 'SELECT id,name,platform,category,is_demo,status,created_at FROM opc_projects ORDER BY created_at DESC'),
          models:all(db, 'SELECT id,name,provider,base_url,model,enabled,is_default,last_test_at,last_test_status,last_test_detail FROM opc_model_configs'),
          connections:all(db, 'SELECT id,kind,name,status,last_test_at,last_test_status,last_test_detail,enabled FROM opc_connections'),
          roles:ROLES.map(role => ({slug:role.slug,name:role.name,avatar:role.avatar,color:role.color,description:role.description,taskTitle:role.taskTitle,taskPlaceholder:role.taskPlaceholder,tools:role.tools})),
          toolCatalog:TOOL_CATALOG, statusLabels:STATUS_LABELS, actionKinds:ACTION_KINDS, verificationLabels:VERIFICATION_LABELS,
          demoProjectId:'proj-demo-stand', skillBindingsCount:SKILL_BINDINGS.length});
      }

      if (path === '/dashboard' && method === 'GET') {
        const stuckBefore = new Date(Date.now() - 120000).toISOString();
        return jsonResponse({
          counts:{projects:one(db, 'SELECT COUNT(*) AS n FROM opc_projects')?.n || 0,
            activeRuns:one(db, "SELECT COUNT(*) AS n FROM opc_runs WHERE status IN ('queued','running')")?.n || 0,
            failedRuns:one(db, "SELECT COUNT(*) AS n FROM opc_runs WHERE status='failed'")?.n || 0,
            pendingActions:one(db, "SELECT COUNT(*) AS n FROM opc_actions WHERE status='pending'")?.n || 0,
            openTickets:one(db, "SELECT COUNT(*) AS n FROM opc_tickets WHERE status NOT IN ('closed','resolved')")?.n || 0,
            artifacts:one(db, 'SELECT COUNT(*) AS n FROM opc_artifacts')?.n || 0,
            connectionIssues:one(db, "SELECT COUNT(*) AS n FROM opc_connections WHERE status IN ('permission_denied','failed','not_configured') AND enabled=1")?.n || 0},
          projects:all(db, 'SELECT p.*, (SELECT COUNT(*) FROM opc_skus s WHERE s.project_id=p.id) AS skuCount, (SELECT COUNT(*) FROM opc_runs r WHERE r.project_id=p.id AND r.status IN (\'queued\',\'running\')) AS activeRuns FROM opc_projects p ORDER BY p.created_at DESC'),
          running:all(db, "SELECT r.id,r.project_id,r.employee_id,r.status,r.started_at,r.heartbeat_at,r.error_message,e.name AS employee_name,p.name AS project_name FROM opc_runs r LEFT JOIN opc_employees e ON e.id=r.employee_id LEFT JOIN opc_projects p ON p.id=r.project_id WHERE r.status IN ('queued','running') ORDER BY r.created_at DESC LIMIT 10"),
          stuck:all(db, "SELECT id,project_id,employee_id,status,started_at,heartbeat_at,error_message FROM opc_runs WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at<?) LIMIT 10", stuckBefore),
          failed:all(db, "SELECT r.id,r.project_id,r.employee_id,r.error_code,r.error_message,r.created_at,e.name AS employee_name FROM opc_runs r LEFT JOIN opc_employees e ON e.id=r.employee_id WHERE r.status='failed' ORDER BY r.created_at DESC LIMIT 10"),
          actions:actions.list({status:'pending', limit:10}),
          tickets:all(db, "SELECT t.*, p.name AS project_name FROM opc_tickets t LEFT JOIN opc_projects p ON p.id=t.project_id WHERE t.status NOT IN ('closed','resolved') ORDER BY t.updated_at DESC LIMIT 10"),
          artifacts:all(db, 'SELECT a.id,a.project_id,a.title,a.kind,a.version,a.status,a.created_at,p.name AS project_name FROM opc_artifacts a LEFT JOIN opc_projects p ON p.id=a.project_id ORDER BY a.created_at DESC LIMIT 12'),
          connections:all(db, "SELECT id,kind,name,status,last_test_at,last_test_detail FROM opc_connections WHERE status IN ('permission_denied','failed','not_configured') AND enabled=1 ORDER BY updated_at DESC"),
        });
      }

      if (path === '/employees' && method === 'GET') {
        return jsonResponse({employees:all(db, 'SELECT * FROM opc_employees ORDER BY created_at').map(employeeView)});
      }
      const employeeMatch = path.match(/^\/employees\/([^/]+)(?:\/(minds|tools|test))?$/);
      if (employeeMatch) {
        const employee = one(db, 'SELECT * FROM opc_employees WHERE slug=?', decodeURIComponent(employeeMatch[1]));
        if (!employee) throw Object.assign(new Error('员工不存在'), {status:404});
        if (employeeMatch[2] === 'minds' && method === 'POST') {
          const body = await readJson(request);
          const runtimeText = String(body.runtimeText || '').trim();
          if (!runtimeText || runtimeText.length > 20000) throw Object.assign(new Error('心智文本不能为空且不超过 20000 字'), {status:400});
          const versions = all(db, 'SELECT version FROM opc_employee_minds WHERE employee_id=? ORDER BY created_at', employee.id);
          const current = employee.mind_version || '1.0.0';
          const next = body.version || current.replace(/(\d+)$/, n => String(Number(n) + 1));
          if (versions.some(item => item.version === next)) throw Object.assign(new Error('版本已存在'), {status:409});
          tx(db, () => {
            insert(db, 'opc_employee_minds', {id:newId('mind'), employee_id:employee.id, version:next, runtime_text:runtimeText,
              source:body.source || '经营者编辑', source_text:body.sourceText || null, created_at:nowIso(), created_by:actor});
            update(db, 'opc_employees', employee.id, {mind_version:next, updated_at:nowIso()});
            audit(db, {projectId:null, actor, action:'发布员工心智版本', objectType:'employee', objectId:employee.id, detail:{version:next, previous:current}});
          });
          return jsonResponse({ok:true, employee:employeeView(one(db, 'SELECT * FROM opc_employees WHERE id=?', employee.id))});
        }
        if (employeeMatch[2] === 'tools' && method === 'PATCH') {
          const body = await readJson(request);
          if (!body.toolKey || !TOOL_CATALOG[body.toolKey]) throw Object.assign(new Error('未知工具'), {status:400});
          const level = ['L1','L2','L3'].includes(body.level) ? body.level : 'L1';
          const enabled = body.enabled === false ? 0 : 1;
          db.prepare('INSERT INTO opc_tool_grants(employee_id,tool_key,level,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(employee_id,tool_key) DO UPDATE SET level=excluded.level,enabled=excluded.enabled,updated_at=excluded.updated_at')
            .run(employee.id, body.toolKey, level, enabled, nowIso());
          audit(db, {projectId:null, actor, action:'修改工具授权', objectType:'employee', objectId:employee.id, detail:{tool:body.toolKey, level, enabled}});
          return jsonResponse({ok:true, grants:all(db, 'SELECT * FROM opc_tool_grants WHERE employee_id=? ORDER BY tool_key', employee.id)});
        }
        if (employeeMatch[2] === 'test' && method === 'POST') {
          const body = await readJson(request);
          const run = runner.createRun({projectId:body.projectId || 'proj-demo-stand', employeeSlug:employee.slug, skuId:body.skuId || undefined,
            input:{task:body.task || '请用一句话确认你已就岗，并说明你能交付的第一项产物。'}, dedupeKey:body.dedupeKey || ('test:' + employee.slug + ':' + Date.now())});
          return jsonResponse({ok:true, run:runner.getRun(run.id)}, 201);
        }
        if (method === 'PATCH') {
          const body = await readJson(request);
          const patch = {};
          for (const key of ['name','status','model_id','mind_version']) if (typeof body[key] === 'string' && body[key].trim()) patch[key] = body[key].trim();
          for (const key of ['context_rounds','tool_limit','timeout_ms','daily_token_limit']) if (Number.isInteger(body[key]) && body[key] > 0) patch[key] = body[key];
          if (body.model_id && !one(db, 'SELECT id FROM opc_model_configs WHERE id=?', body.model_id)) throw Object.assign(new Error('模型不存在'), {status:400});
          patch.updated_at = nowIso();
          update(db, 'opc_employees', employee.id, patch);
          audit(db, {projectId:null, actor, action:'修改员工配置', objectType:'employee', objectId:employee.id, detail:patch});
          return jsonResponse({ok:true, employee:employeeView(one(db, 'SELECT * FROM opc_employees WHERE id=?', employee.id))});
        }
        if (method === 'GET') {
          const mind = one(db, 'SELECT * FROM opc_employee_minds WHERE employee_id=? AND version=?', employee.id, employee.mind_version);
          const model = employee.model_id ? one(db, 'SELECT * FROM opc_model_configs WHERE id=?', employee.model_id) : null;
          return jsonResponse({employee:employeeView(employee), mind, minds:all(db, 'SELECT id,version,source,created_at,created_by,length(runtime_text) AS chars FROM opc_employee_minds WHERE employee_id=? ORDER BY created_at DESC', employee.id),
            model, skills:all(db, 'SELECT es.id,es.label,es.relation,es.binding_index,es.status,s.slug,s.name,s.version,s.install_status,s.package_path,s.source,s.origin FROM opc_employee_skills es JOIN opc_skills s ON s.id=es.skill_id WHERE es.employee_id=? ORDER BY es.binding_index IS NULL, es.binding_index', employee.id),
            grants:all(db, 'SELECT * FROM opc_tool_grants WHERE employee_id=? ORDER BY tool_key', employee.id),
            logs:all(db, 'SELECT id,status,error_code,error_message,created_at,finished_at,provider_model,tokens_in,tokens_out,first_token_ms,workflow_id,sku_id FROM opc_runs WHERE employee_id=? ORDER BY created_at DESC LIMIT 30', employee.id),
            artifacts:all(db, 'SELECT id,title,kind,version,status,created_at FROM opc_artifacts WHERE run_id IN (SELECT id FROM opc_runs WHERE employee_id=?) ORDER BY created_at DESC LIMIT 12', employee.id)});
        }
        throw Object.assign(new Error('不支持的员工操作'), {status:405});
      }

      if (path === '/skills' && method === 'GET') {
        return jsonResponse({skills:all(db, 'SELECT * FROM opc_skills ORDER BY is_supplement, slug').map(skill => ({...skill,
          manifest:parseJson(skill.manifest_json, []), boundEmployees:all(db, 'SELECT e.slug,e.name,es.relation,es.binding_index FROM opc_employee_skills es JOIN opc_employees e ON e.id=es.employee_id WHERE es.skill_id=? ORDER BY es.binding_index', skill.id)}))});
      }
      const skillMatch = path.match(/^\/skills\/([^/]+)(?:\/(verify))?$/);
      if (skillMatch) {
        const skill = one(db, 'SELECT * FROM opc_skills WHERE slug=?', decodeURIComponent(skillMatch[1]));
        if (!skill) throw Object.assign(new Error('Skill 不存在'), {status:404});
        if (skillMatch[2] === 'verify' && method === 'POST') {
          if (!skill.package_path || !existsSync(skill.package_path)) {
            update(db, 'opc_skills', skill.id, {last_trial_at:nowIso(), last_trial_status:'missing_package'});
            return jsonResponse({ok:false, status:'missing_package', message:'只有名称，安装包未提供', skill}, 409);
          }
          const manifest = parseJson(skill.manifest_json, []);
          let files = 0, mismatches = 0;
          for (const item of manifest) {
            const full = resolve(skill.package_path, item.path);
            if (!full.startsWith(skill.package_path)) continue;
            if (!existsSync(full)) { mismatches += 1; continue; }
            if (sha256(readFileSync(full)) !== item.sha256) mismatches += 1; else files += 1;
          }
          const skillMd = resolve(skill.package_path, 'SKILL.md');
          const hasSkillMd = existsSync(skillMd);
          const status = mismatches ? 'files_mismatch' : hasSkillMd ? 'verified' : 'missing_skill_md';
          update(db, 'opc_skills', skill.id, {runtime_loaded: status === 'verified' ? 1 : 0, last_trial_at:nowIso(), last_trial_status:status, verified_at:nowIso()});
          audit(db, {projectId:null, actor, action:'核验 Skill 安装', objectType:'skill', objectId:skill.id, detail:{status, files, mismatches}});
          return jsonResponse({ok:status === 'verified', status, files, mismatches, hasSkillMd, manifestCount:manifest.length, skill:one(db, 'SELECT * FROM opc_skills WHERE id=?', skill.id)});
        }
        const files = [];
        if (skill.package_path && existsSync(skill.package_path)) {
          for (const item of parseJson(skill.manifest_json, []).slice(0, 30)) {
            const full = resolve(skill.package_path, item.path);
            files.push({path:item.path, exists:existsSync(full), sha256:item.sha256});
          }
        }
        return jsonResponse({skill:{...skill, manifest:parseJson(skill.manifest_json, [])}, files,
          skillMd:skill.package_path && existsSync(resolve(skill.package_path, 'SKILL.md')) ? readFileSync(resolve(skill.package_path, 'SKILL.md'), 'utf8').slice(0, 6000) : null,
          boundEmployees:all(db, 'SELECT e.slug,e.name,es.relation,es.binding_index FROM opc_employee_skills es JOIN opc_employees e ON e.id=es.employee_id WHERE es.skill_id=? ORDER BY es.binding_index', skill.id)});
      }

      if (path === '/projects' && method === 'GET') {
        return jsonResponse({projects:all(db, 'SELECT * FROM opc_projects ORDER BY created_at DESC').map(projectSummary)});
      }
      if (path === '/projects' && method === 'POST') {
        const body = await readJson(request);
        if (!body.name || !String(body.name).trim()) throw Object.assign(new Error('项目名称不能为空'), {status:400});
        const id = newId('project');
        const storeId = newId('store');
        const productId = newId('product');
        const priceMin = Number.isFinite(body.priceMin) ? Math.round(body.priceMin * 100) : null;
        const priceMax = Number.isFinite(body.priceMax) ? Math.round(body.priceMax * 100) : null;
        const budget = Number.isFinite(body.budget) ? Math.round(body.budget * 100) : null;
        tx(db, () => {
          insert(db, 'opc_projects', {id, seed_key:null, name:String(body.name).slice(0,160), description:String(body.description || '').slice(0,4000),
            platform:String(body.platform || '拼多多').slice(0,40), category:String(body.category || '').slice(0,80), audience:String(body.audience || '').slice(0,300),
            price_min_cents:priceMin, price_max_cents:priceMax, budget_cents:budget, fulfillment:String(body.fulfillment || '一件代发').slice(0,40),
            constraints:String(body.constraints || '').slice(0,2000), status:'active', is_demo:0, redcore_company_id:operator.redcore_company_id || null, created_at:nowIso(), updated_at:nowIso()});
          insert(db, 'opc_stores', {id:storeId, project_id:id, platform:String(body.platform || '拼多多').slice(0,40), name:String(body.storeName || (body.name + ' · 店铺')).slice(0,120),
            shop_ref:null, authorization_status:'not_configured', facts_json:json({shopName:body.storeName || body.name, platform:body.platform || '拼多多', handlingTime:'待核', afterSales:'待核'}), created_at:nowIso()});
          insert(db, 'opc_products', {id:productId, project_id:id, store_id:storeId, name:String(body.productName || body.name).slice(0,160), category:String(body.category || '').slice(0,80),
            status:'candidate', platform:String(body.platform || '拼多多').slice(0,40), description:String(body.description || '').slice(0,2000), created_at:nowIso()});
          audit(db, {projectId:id, actor, action:'创建项目', objectType:'project', objectId:id, detail:{name:body.name}});
        });
        return jsonResponse({ok:true, project:projectDetail(id)}, 201);
      }
      const projectMatch = path.match(/^\/projects\/([^/]+)(?:\/(export|export\.csv|skus|knowledge|reports|artifacts|tickets|runs))?$/);
      if (projectMatch) {
        const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', decodeURIComponent(projectMatch[1]));
        if (!project) throw Object.assign(new Error('项目不存在'), {status:404});
        const action = projectMatch[2];
        if (!action && method === 'GET') return jsonResponse({project:projectDetail(project.id)});
        if (!action && method === 'PATCH') {
          const body = await readJson(request);
          const patch = {};
          for (const key of ['name','description','platform','category','audience','fulfillment','constraints','status']) if (typeof body[key] === 'string') patch[key] = body[key].slice(0, key === 'constraints' ? 2000 : 300);
          for (const [key, field] of [['priceMin','price_min_cents'],['priceMax','price_max_cents'],['budget','budget_cents']]) if (Number.isFinite(body[key])) patch[field] = Math.round(body[key] * 100);
          patch.updated_at = nowIso();
          update(db, 'opc_projects', project.id, patch);
          audit(db, {projectId:project.id, actor, action:'修改项目', objectType:'project', objectId:project.id, detail:patch});
          return jsonResponse({ok:true, project:projectDetail(project.id)});
        }
        if (action === 'skus' && method === 'POST') {
          const body = await readJson(request);
          if (!body.name || !Number.isFinite(body.price) || body.price <= 0) throw Object.assign(new Error('SKU 名称和售价必填'), {status:400});
          const product = one(db, 'SELECT * FROM opc_products WHERE project_id=? ORDER BY created_at LIMIT 1', project.id);
          const sku = {id:newId('sku'), product_id:product?.id || null, project_id:project.id, code:String(body.code || ('SKU-' + Date.now())).slice(0,40),
            name:String(body.name).slice(0,120), specs_json:json(body.specs || {}), price_cents:Math.round(body.price * 100),
            cost_cents:Math.round((body.cost || 0) * 100), shipping_cents:Math.round((body.shipping || 0) * 100),
            packaging_cents:Math.round((body.packaging || 0) * 100), platform_fee_bps:Number.isInteger(body.feeBps) ? body.feeBps : 600,
            platform_fee_rounding:'四舍五入到分', refund_cents:Math.round((body.refund || 0) * 100), ad_cents:Math.round((body.ad || 0) * 100),
            tax_cents:Math.round((body.tax || 0) * 100), discount_cents:Math.round((body.discount || 0) * 100), stock:Number.isInteger(body.stock) ? body.stock : null,
            supplier_id:body.supplierId || null, quote_id:body.quoteId || null, status:'draft', evidence_json:json({source:'经营者录入'}), effective_at:nowIso(), created_at:nowIso(), updated_at:nowIso()};
          insert(db, 'opc_skus', sku);
          audit(db, {projectId:project.id, actor, action:'创建 SKU', objectType:'sku', objectId:sku.id, detail:{name:sku.name, price:sku.price_cents}});
          return jsonResponse({ok:true, sku:{...sku, specs:body.specs || {}, economics:unitEconomics({priceCents:sku.price_cents,costCents:sku.cost_cents,shippingCents:sku.shipping_cents,packagingCents:sku.packaging_cents,feeBps:sku.platform_fee_bps,refundCents:sku.refund_cents,adCents:sku.ad_cents})}}, 201);
        }
        if (action === 'knowledge' && method === 'GET') return jsonResponse({knowledge:all(db, 'SELECT * FROM opc_knowledge WHERE project_id=? ORDER BY created_at DESC', project.id)});
        if (action === 'knowledge' && method === 'POST') {
          const body = await readJson(request);
          if (!body.title || !body.body) throw Object.assign(new Error('知识标题和正文必填'), {status:400});
          const row = {id:newId('kn'), project_id:project.id, sku_id:body.skuId || null, scope:body.scope || 'project', kind:String(body.kind || '商品知识').slice(0,40),
            title:String(body.title).slice(0,200), body:String(body.body).slice(0,20000), source:String(body.source || '经营者录入').slice(0,300), source_url:body.sourceUrl || null,
            verification_status:['verified','pending','synthetic','historical','extracted'].includes(body.verificationStatus) ? body.verificationStatus : 'pending',
            effective_from:body.effectiveFrom || nowIso(), effective_to:body.effectiveTo || null, last_verified_at:body.verificationStatus === 'verified' ? nowIso() : null,
            created_by:actor, created_at:nowIso()};
          insert(db, 'opc_knowledge', row);
          audit(db, {projectId:project.id, actor, action:'新增知识', objectType:'knowledge', objectId:row.id, detail:{title:row.title, kind:row.kind}});
          return jsonResponse({ok:true, knowledge:row}, 201);
        }
        if (action === 'reports' && method === 'GET') {
          return jsonResponse({reports:all(db, 'SELECT * FROM opc_reports WHERE project_id=? ORDER BY created_at DESC', project.id).map(report => {
            const rows = all(db, 'SELECT * FROM opc_report_rows WHERE report_id=? ORDER BY row_no', report.id).map(row => ({...row, errors:parseJson(row.errors_json, [])}));
            return {...report, summary:reportSummary(rows)};
          })});
        }
        if (action === 'artifacts' && method === 'GET') return jsonResponse({artifacts:all(db, 'SELECT id,title,kind,version,status,run_id,file_id,created_at FROM opc_artifacts WHERE project_id=? ORDER BY created_at DESC', project.id)});
        if (action === 'tickets' && method === 'GET') return jsonResponse({tickets:all(db, 'SELECT * FROM opc_tickets WHERE project_id=? ORDER BY updated_at DESC', project.id).map(row => ({...row, evidence:parseJson(row.evidence_json, []), pendingFacts:parseJson(row.pending_facts_json, [])}))});
        if (action === 'tickets' && method === 'POST') {
          const body = await readJson(request);
          if (!body.originalMessage) throw Object.assign(new Error('原问题不能为空'), {status:400});
          const row = {id:newId('ticket'), project_id:project.id, sku_id:body.skuId || null, order_ref:body.orderRef || null, type:String(body.type || '售前咨询').slice(0,40),
            severity:body.severity || null, emotion:body.emotion || null, status:'open', owner_employee_id:null, original_message:String(body.originalMessage).slice(0,4000),
            evidence_json:json(body.evidence || []), pending_facts_json:json(body.pendingFacts || []), reply_draft:null, resolution:null, receipt_json:null, created_at:nowIso(), updated_at:nowIso()};
          insert(db, 'opc_tickets', row);
          audit(db, {projectId:project.id, actor, action:'创建工单', objectType:'ticket', objectId:row.id, detail:{type:row.type}});
          return jsonResponse({ok:true, ticket:row}, 201);
        }
        if (action === 'runs' && method === 'GET') return jsonResponse({runs:all(db, 'SELECT id,employee_id,status,error_code,error_message,created_at,finished_at,provider_model FROM opc_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 50', project.id)});
        if (action === 'export' && method === 'GET') {
          const entries = [];
          const detail = projectDetail(project.id);
          entries.push({name:'manifest.json', data:JSON.stringify({project:project.id, name:project.name, generatedAt:nowIso(), dataNature:'合成演示/历史回放/真实调用按记录标记', artifacts:detail.artifacts.map(item => ({id:item.id,title:item.title,version:item.version,kind:item.kind})), files:all(db, 'SELECT id,name,mime,size,sha256 FROM opc_files WHERE project_id=?', project.id)}, null, 2)});
          entries.push({name:'project.json', data:JSON.stringify(detail, null, 2)});
          entries.push({name:'skus.csv', data:toCsv(['SKU','编码','售价','进货','履约','包材','平台费','退款','广告前贡献','广告后贡献','贡献率%','盈亏平衡ROAS'],
            detail.skus.map(sku => [sku.name,sku.code,cny(sku.price_cents),cny(sku.cost_cents),cny(sku.shipping_cents),cny(sku.packaging_cents),cny(sku.economics.platformFeeCents),cny(sku.refund_cents),cny(sku.economics.preAdCents),cny(sku.economics.postAdCents),sku.economics.preAdRatePct,sku.economics.breakEvenRoas]))});
          entries.push({name:'knowledge.json', data:JSON.stringify(detail.knowledge, null, 2)});
          const report = detail.reports[0];
          if (report) entries.push({name:'report-summary.csv', data:toCsv(['指标','数值','分子','分母','口径'], Object.entries(report.metrics.metrics || {}).map(([key, item]) => [key,item.value,item.numerator,item.denominator,item.formula]))});
          for (const artifact of all(db, 'SELECT * FROM opc_artifacts WHERE project_id=? ORDER BY created_at LIMIT 80', project.id)) {
            const ext = artifact.kind === 'image' ? '.json' : artifact.content_type === 'application/json' ? '.json' : '.md';
            entries.push({name:'artifacts/artifact-' + artifact.id.slice(-12) + '-v' + artifact.version + ext, data:artifact.kind === 'image' ? JSON.stringify({id:artifact.id, fileId:artifact.file_id, title:artifact.title, evidence:parseJson(artifact.evidence_json, null)}, null, 2) : (artifact.content || '')});
          }
          for (const file of all(db, 'SELECT * FROM opc_files WHERE project_id=? AND size<=5000000 ORDER BY created_at LIMIT 40', project.id)) {
            const path = resolve(filesRoot, file.storage_path);
            if (existsSync(path)) entries.push({name:'files/file-' + file.id.slice(-8) + (extname(file.name) || ''), data:readFileSync(path)});
          }
          const zip = createZip(entries);
          audit(db, {projectId:project.id, actor, action:'导出项目包', objectType:'project', objectId:project.id, detail:{entries:entries.length, bytes:zip.length}});
          return new Response(zip, {headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename*=UTF-8\'\'' + encodeURIComponent(safeName(project.name) + '-' + nowIso().slice(0,10) + '.zip'),'Cache-Control':'no-store'}});
        }
        if (action === 'export.csv' && method === 'GET') {
          const detail = projectDetail(project.id);
          const csv = toCsv(['SKU','编码','售价','进货','履约','包材','平台费','退款','广告前贡献','广告后贡献','贡献率%','盈亏平衡ROAS'],
            detail.skus.map(sku => [sku.name,sku.code,cny(sku.price_cents),cny(sku.cost_cents),cny(sku.shipping_cents),cny(sku.packaging_cents),cny(sku.economics.platformFeeCents),cny(sku.refund_cents),cny(sku.economics.preAdCents),cny(sku.economics.postAdCents),sku.economics.preAdRatePct,sku.economics.breakEvenRoas]));
          return new Response(csv, {headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="skus.csv"','Cache-Control':'no-store'}});
        }
      }

      const skuMatch = path.match(/^\/skus\/([^/]+)$/);
      if (skuMatch && method === 'PATCH') {
        const sku = one(db, 'SELECT * FROM opc_skus WHERE id=?', decodeURIComponent(skuMatch[1]));
        if (!sku) throw Object.assign(new Error('SKU 不存在'), {status:404});
        const body = await readJson(request);
        const patch = {};
        for (const key of ['name','code','status']) if (typeof body[key] === 'string') patch[key] = body[key].slice(0,120);
        for (const [key, field] of [['price','price_cents'],['cost','cost_cents'],['shipping','shipping_cents'],['packaging','packaging_cents'],['refund','refund_cents'],['ad','ad_cents'],['tax','tax_cents'],['discount','discount_cents']]) if (Number.isFinite(body[key])) patch[field] = Math.round(body[key] * 100);
        if (Number.isInteger(body.feeBps)) patch.platform_fee_bps = body.feeBps;
        if (body.specs && typeof body.specs === 'object') patch.specs_json = json(body.specs);
        patch.updated_at = nowIso();
        update(db, 'opc_skus', sku.id, patch);
        audit(db, {projectId:sku.project_id, actor, action:'修改 SKU', objectType:'sku', objectId:sku.id, detail:patch});
        const saved = one(db, 'SELECT * FROM opc_skus WHERE id=?', sku.id);
        return jsonResponse({ok:true, sku:{...saved, specs:parseJson(saved.specs_json, {}), economics:unitEconomics({priceCents:saved.price_cents,costCents:saved.cost_cents,shippingCents:saved.shipping_cents,packagingCents:saved.packaging_cents,feeBps:saved.platform_fee_bps,refundCents:saved.refund_cents,adCents:saved.ad_cents,taxCents:saved.tax_cents,discountCents:saved.discount_cents})}});
      }

      const knowledgeMatch = path.match(/^\/knowledge\/([^/]+)$/);
      if (knowledgeMatch && method === 'PATCH') {
        const row = one(db, 'SELECT * FROM opc_knowledge WHERE id=?', decodeURIComponent(knowledgeMatch[1]));
        if (!row) throw Object.assign(new Error('知识不存在'), {status:404});
        const body = await readJson(request);
        const patch = {last_verified_at:body.verificationStatus === 'verified' ? nowIso() : row.last_verified_at};
        for (const key of ['title','body','source','source_url','verification_status','effective_from','effective_to']) if (typeof body[key] === 'string') patch[key] = body[key];
        update(db, 'opc_knowledge', row.id, patch);
        audit(db, {projectId:row.project_id, actor, action:'修改知识', objectType:'knowledge', objectId:row.id, detail:{title:patch.title || row.title, verification:patch.verification_status || row.verification_status}});
        return jsonResponse({ok:true, knowledge:one(db, 'SELECT * FROM opc_knowledge WHERE id=?', row.id)});
      }

      const artifactMatch = path.match(/^\/artifacts\/([^/]+)(?:\/(download|versions))?$/);
      if (artifactMatch) {
        const artifact = one(db, 'SELECT * FROM opc_artifacts WHERE id=?', decodeURIComponent(artifactMatch[1]));
        if (!artifact) throw Object.assign(new Error('产物不存在'), {status:404});
        if (artifactMatch[2] === 'versions' && method === 'GET') return jsonResponse({versions:all(db, 'SELECT id,version,status,created_at,run_id FROM opc_artifacts WHERE lineage_key=? ORDER BY version DESC', artifact.lineage_key)});
        if (artifactMatch[2] === 'download' && method === 'GET') {
          if (artifact.file_id) {
            const file = one(db, 'SELECT * FROM opc_files WHERE id=?', artifact.file_id);
            if (file) return fileResponse(file, {inline:url.searchParams.get('inline') === '1', downloadName:artifact.title + (extname(file.name) || '')});
          }
          return new Response(artifact.content || '', {headers:{'Content-Type':artifact.content_type || 'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="artifact-' + artifact.version + '.md"','Cache-Control':'no-store'}});
        }
        return jsonResponse({artifact, versions:all(db, 'SELECT id,version,status,created_at FROM opc_artifacts WHERE lineage_key=? ORDER BY version DESC', artifact.lineage_key),
          file:artifact.file_id ? one(db, 'SELECT id,name,mime,size,sha256 FROM opc_files WHERE id=?', artifact.file_id) : null});
      }

      const fileMatch = path.match(/^\/files\/([^/]+)(?:\/(download))?$/);
      if (fileMatch && method === 'GET') {
        const file = one(db, 'SELECT * FROM opc_files WHERE id=?', decodeURIComponent(fileMatch[1]));
        if (!file) throw Object.assign(new Error('文件不存在'), {status:404});
        const projectId = url.searchParams.get('projectId');
        if (projectId && projectId !== file.project_id) throw Object.assign(new Error('文件不属于该项目'), {status:404});
        if (fileMatch[2] === 'download') return fileResponse(file, {inline:url.searchParams.get('inline') === '1'});
        const text = ['text/markdown','text/csv','text/plain','application/json'].includes(file.mime) ? readFileSync(resolve(filesRoot, file.storage_path), 'utf8').slice(0, 200000) : null;
        return jsonResponse({file:{...file, download:'/api/opc/files/' + file.id + '/download'}, content:text});
      }
      if (path === '/files' && method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') throw Object.assign(new Error('缺少文件'), {status:400});
        const projectId = String(form.get('projectId') || '') || null;
        if (projectId && !one(db, 'SELECT id FROM opc_projects WHERE id=?', projectId)) throw Object.assign(new Error('项目不存在'), {status:404});
        const buffer = Buffer.from(await file.arrayBuffer());
        const saved = saveUpload({buffer, name:file.name, mime:file.type, projectId, skuId:String(form.get('skuId') || '') || null});
        audit(db, {projectId, actor, action:'上传文件', objectType:'file', objectId:saved.id, detail:{name:saved.name, size:saved.size, sha256:saved.sha256}});
        return jsonResponse({ok:true, file:saved}, 201);
      }

      if (path === '/tickets' && method === 'GET') return jsonResponse({tickets:all(db, 'SELECT * FROM opc_tickets ORDER BY updated_at DESC').map(row => ({...row, evidence:parseJson(row.evidence_json, []), pendingFacts:parseJson(row.pending_facts_json, [])}))});
      const ticketMatch = path.match(/^\/tickets\/([^/]+)(?:\/(draft))?$/);
      if (ticketMatch) {
        const ticket = one(db, 'SELECT * FROM opc_tickets WHERE id=?', decodeURIComponent(ticketMatch[1]));
        if (!ticket) throw Object.assign(new Error('工单不存在'), {status:404});
        if (ticketMatch[2] === 'draft' && method === 'POST') {
          const body = await readJson(request);
          if (typeof body.replyDraft !== 'string') throw Object.assign(new Error('回复草稿必填'), {status:400});
          update(db, 'opc_tickets', ticket.id, {reply_draft:body.replyDraft.slice(0,4000), status:body.status || ticket.status, updated_at:nowIso()});
          audit(db, {projectId:ticket.project_id, actor, action:'保存客服草稿', objectType:'ticket', objectId:ticket.id, detail:{length:body.replyDraft.length, sent:false}});
          return jsonResponse({ok:true, ticket:one(db, 'SELECT * FROM opc_tickets WHERE id=?', ticket.id), sent:false});
        }
        if (method === 'GET') return jsonResponse({ticket:{...ticket, evidence:parseJson(ticket.evidence_json, []), pendingFacts:parseJson(ticket.pending_facts_json, [])}});
      }

      if (path === '/reports' || path === '/knowledge' || path === '/artifacts' || path === '/actions' || path === '/tickets') {
        if (method !== 'GET') throw Object.assign(new Error('方法不允许'), {status:405});
        if (path === '/actions') return jsonResponse({actions:actions.list({projectId:url.searchParams.get('projectId') || null, status:url.searchParams.get('status') || null, limit:Math.min(200, Number(url.searchParams.get('limit')) || 100)})});
        if (path === '/tickets') return jsonResponse({tickets:all(db, 'SELECT * FROM opc_tickets ORDER BY updated_at DESC')});
      }

      if (path === '/runs' && method === 'GET') {
        const filters = []; const params = [];
        if (url.searchParams.get('projectId')) { filters.push('project_id=?'); params.push(url.searchParams.get('projectId')); }
        if (url.searchParams.get('status')) { filters.push('status=?'); params.push(url.searchParams.get('status')); }
        const sql = 'SELECT id,project_id,employee_id,sku_id,status,error_code,error_message,created_at,finished_at,provider_model,tokens_in,tokens_out,first_token_ms FROM opc_runs' + (filters.length ? ' WHERE ' + filters.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT 100';
        return jsonResponse({runs:db.prepare(sql).all(...params), statusLabels:STATUS_LABELS});
      }
      if (path === '/runs' && method === 'POST') {
        const body = await readJson(request);
        if (!body.projectId || !body.employeeSlug) throw Object.assign(new Error('项目和员工必填'), {status:400});
        if (!body.input || typeof body.input.task !== 'string' || !body.input.task.trim()) throw Object.assign(new Error('任务说明不能为空'), {status:400});
        const run = runner.createRun({...body, actor});
        return jsonResponse({ok:true, run:runner.getRun(run.id), deduplicated:run.deduplicated === true}, run.deduplicated ? 200 : 201);
      }
      const runMatch = path.match(/^\/runs\/([^/]+)(?:\/(events|retry|cancel))?$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const run = one(db, 'SELECT * FROM opc_runs WHERE id=?', runId);
        if (!run) throw Object.assign(new Error('运行不存在'), {status:404});
        if (runMatch[2] === 'events' && method === 'GET') return sse(runId, request);
        if (runMatch[2] === 'retry' && method === 'POST') {
          const body = await readJson(request);
          const retried = runner.retryRun(runId, {fromStep:body.fromStep || null, actor});
          return jsonResponse({ok:true, run:runner.getRun(retried.id)});
        }
        if (runMatch[2] === 'cancel' && method === 'POST') return jsonResponse({ok:true, run:runner.cancelRun(runId, actor)});
        if (method === 'GET') {
          const full = runner.getRun(runId);
          return jsonResponse({run:{...full, employee:full.employee_id ? one(db, 'SELECT slug,name,avatar FROM opc_employees WHERE id=?', full.employee_id) : null,
            project:one(db, 'SELECT id,name,is_demo FROM opc_projects WHERE id=?', full.project_id),
            statusLabels:STATUS_LABELS}});
        }
      }

      if (path === '/workflows' && method === 'GET') return jsonResponse({workflows:workflows.list(url.searchParams.get('projectId') || null)});
      if (path === '/workflows' && method === 'POST') {
        const body = await readJson(request);
        if (!body.projectId || !body.type) throw Object.assign(new Error('项目和流程类型必填'), {status:400});
        return jsonResponse({ok:true, workflow:workflows.create({projectId:body.projectId, type:body.type, name:body.name, actor})}, 201);
      }
      const workflowStepMatch = path.match(/^\/workflows\/([^/]+)\/steps\/([^/]+)$/);
      if (workflowStepMatch && method === 'PATCH') {
        const body = await readJson(request);
        return jsonResponse({ok:true, workflow:workflows.updateStep(decodeURIComponent(workflowStepMatch[1]), decodeURIComponent(workflowStepMatch[2]), {...body, actor})});
      }
      const workflowMatch = path.match(/^\/workflows\/([^/]+)(?:\/(pause|steps\/([^/]+)\/(run|confirm)))?$/);
      if (workflowMatch) {
        const workflowId = decodeURIComponent(workflowMatch[1]);
        if (!one(db, 'SELECT id FROM opc_workflows WHERE id=?', workflowId)) throw Object.assign(new Error('流程不存在'), {status:404});
        if (workflowMatch[2] === 'pause' && method === 'POST') return jsonResponse({ok:true, workflow:workflows.pause(workflowId, actor)});
        if (workflowMatch[3] && (workflowMatch[4] === 'run' || workflowMatch[4] === 'confirm') && method === 'POST') {
          const body = await readJson(request);
          const result = await workflows.runStep(workflowId, decodeURIComponent(workflowMatch[3]), {...body, actor});
          return jsonResponse({ok:true, ...result});
        }
        if (!workflowMatch[2] && method === 'GET') return jsonResponse({workflow:workflows.get(workflowId)});
      }

      if (path === '/actions' && method === 'GET') return jsonResponse({actions:actions.list({projectId:url.searchParams.get('projectId') || null, status:url.searchParams.get('status') || null, limit:Math.min(200, Number(url.searchParams.get('limit')) || 100)})});
      const actionMatch = path.match(/^\/actions\/([^/]+)\/(decision|revise)$/);
      if (actionMatch && method === 'POST') {
        const body = await readJson(request);
        if (actionMatch[2] === 'decision') {
          const result = actions.decide(decodeURIComponent(actionMatch[1]), {decision:body.decision, note:body.note || '', actor});
          const parsed = {...result, payload:parseJson(result.payload_json, null), evidence:parseJson(result.evidence_json, null), receipt:parseJson(result.receipt_json, null)};
          return jsonResponse({ok:true, action:parsed, duplicate:result.duplicate === true});
        }
        const result = actions.revise(decodeURIComponent(actionMatch[1]), {payload:body.payload, note:body.note || '', actor});
        return jsonResponse({ok:true, action:{...result, payload:parseJson(result.payload_json, null), evidence:parseJson(result.evidence_json, null), receipt:parseJson(result.receipt_json, null)}});
      }

      if (path === '/connections' && method === 'GET') {
        return jsonResponse({connections:all(db, 'SELECT * FROM opc_connections ORDER BY kind,id').map(row => ({...row, config:parseJson(row.config_json, {}), lastReceipt:parseJson(row.last_receipt_json, null)}))});
      }
      const connectionMatch = path.match(/^\/connections\/([^/]+)(?:\/(test))?$/);
      if (connectionMatch) {
        const connection = one(db, 'SELECT * FROM opc_connections WHERE id=?', decodeURIComponent(connectionMatch[1]));
        if (!connection) throw Object.assign(new Error('连接不存在'), {status:404});
        if (connectionMatch[2] === 'test' && method === 'POST') {
          const started = Date.now();
          const config = parseJson(connection.config_json, {});
          const body = request.headers.get('content-type')?.includes('application/json') ? await readJson(request) : {};
          let result;
          if (connection.id === 'conn-ollama') {
            const model = one(db, 'SELECT * FROM opc_model_configs WHERE is_default=1 AND enabled=1') || one(db, 'SELECT * FROM opc_model_configs WHERE id=?', 'model-ollama-r1');
            result = await testModel(db, model);
          } else if (connection.id === 'conn-pdd-search') {
            const pdd = await pddGoodsSearch({keyword:'折叠桌面手机支架', pageSize:10, baseUrl:config.url || config.baseUrl});
            result = {ok:pdd.ok, status:pdd.ok ? 'success' : pdd.status, detail:pdd.ok ? '返回 ' + pdd.data.items.length + ' 个推广商品，总数 ' + pdd.data.totalCount : pdd.error, receiptId:pdd.receiptId, durationMs:pdd.durationMs,
              missing:pdd.missing || [], upstream:pdd.upstream || null, data:pdd.data ? {totalCount:pdd.data.totalCount, first:pdd.data.items.slice(0,2).map(item => ({id:item.product_id,title:item.title,price:item.group_price_cny}))} : null};
          } else if (['conn-pdd-store','conn-pdd-orders','conn-pdd-write'].includes(connection.id)) {
            const checks = pddAuthorizationChecks(connection.id, body.capability || null);
            if (!checks) throw Object.assign(new Error('该连接不支持此测试能力'), {status:400, code:'invalid_capability'});
            result = {ok:false, status:'not_configured', detail:checks.map(item => item.label + '：缺少 ' + item.missing.join('、')).join('；'),
              receiptId:'PDD-CHECK-' + randomUUID(), durationMs:Date.now() - started, externalExecuted:false,
              missing:[...new Set(checks.flatMap(item => item.missing))], checks, data:{checks}};
          } else if (connection.id === 'conn-tavily') {
            const tav = await tavilySearch({query:'折叠桌面手机支架 拼多多 市场', maxResults:3});
            result = {ok:tav.ok, status:tav.ok ? 'success' : tav.status, detail:tav.ok ? '返回 ' + tav.data.results.length + ' 条公开结果' : tav.error, receiptId:tav.receiptId, durationMs:tav.durationMs, data:tav.data ? {results:tav.data.results.map(item => ({title:item.title,url:item.url}))} : null};
          } else if (connection.id === 'conn-1688') {
            const ali = await ali1688Search({query:'折叠桌面手机支架', limit:10, baseUrl:config.url || config.baseUrl, path:config.path});
            result = {ok:ali.ok, status:ali.ok ? 'success' : ali.status, detail:ali.ok ? '返回 ' + ali.data.items.length + ' 个商品' : ali.error, receiptId:ali.receiptId, durationMs:ali.durationMs, upstream:ali.upstream || null,
              missing:ali.missing || [], data:ali.data ? {items:ali.data.items.slice(0,2), retrievedAt:ali.data.retrievedAt} : null};
          } else if (connection.id === 'conn-mcp') {
            const config = parseJson(connection.config_json, {});
            const mcp = await mcpListTools({url:config.url, tokenEnv:config.tokenEnv || 'MCP_ACCESS_TOKEN'});
            result = {ok:mcp.ok, status:mcp.ok ? 'success' : mcp.status, detail:mcp.ok ? '读取 ' + mcp.tools.length + ' 个工具' : mcp.error, receiptId:mcp.receiptId, durationMs:mcp.durationMs, data:mcp.ok ? {tools:mcp.tools.map(tool => tool.name), serverInfo:mcp.serverInfo} : null};
          } else if (connection.id === 'conn-image') {
            result = {ok:true, status:'success',
              detail:'提示词模式：只输出逐图提示词，不调用本地或 AI 生图',
              durationMs:Date.now() - started, data:{mode:'prompt_only', generated:0}};
          } else if (connection.id === 'conn-storage') {
            const probe = resolve(filesRoot, 'health-probe.txt');
            mkdirSync(filesRoot, {recursive:true});
            writeFileSync(probe, 'OPC storage probe ' + nowIso(), 'utf8');
            const text = readFileSync(probe, 'utf8');
            result = {ok:text.includes('OPC storage probe'), status:'success', detail:'本地存储可写可读', durationMs:Date.now() - started, data:{path:probe}};
          } else {
            const config = parseJson(connection.config_json, {});
            result = {ok:false, status:'not_configured', detail:'未授权：缺少 ' + (config.secretNames || []).join('、') + '；当前仅支持报表导入与人工核对', durationMs:Date.now() - started, data:{missing:config.secretNames || []}};
          }
          const status = result.ok ? (result.status === 'degraded' ? 'degraded' : 'success') : result.status;
          const previousChecks = parseJson(connection.last_receipt_json, {})?.checks || [];
          const savedChecks = result.checks ? [...previousChecks.filter(previous => !result.checks.some(check => check.capability === previous.capability)), ...result.checks] : null;
          update(db, 'opc_connections', connection.id, {status, last_test_at:nowIso(), last_test_status:status, last_test_detail:String(result.detail || '').slice(0, 1200),
            last_receipt_json:json({ok:result.ok, status, detail:result.detail, receiptId:result.receiptId || null, durationMs:result.durationMs,
              externalExecuted:result.externalExecuted ?? false, missing:result.missing || [], checks:savedChecks, upstream:result.upstream || null, data:result.data || null})});
          audit(db, {projectId:null, actor, action:'测试连接', objectType:'connection', objectId:connection.id, detail:{status, detail:result.detail}});
          return jsonResponse({ok:result.ok, connection:one(db, 'SELECT * FROM opc_connections WHERE id=?', connection.id), result});
        }
        if (method === 'PATCH') {
          const body = await readJson(request);
          const config = {...parseJson(connection.config_json, {})};
          if (typeof body.url === 'string') config.url = body.url.trim();
          if (typeof body.baseUrl === 'string') config.baseUrl = body.baseUrl.trim();
          if (typeof body.note === 'string') config.note = body.note.slice(0, 1000);
          const enabled = body.enabled === undefined ? connection.enabled : body.enabled ? 1 : 0;
          const changed = JSON.stringify(config) !== JSON.stringify(parseJson(connection.config_json, {}));
          const status = changed && !['conn-pdd-store','conn-pdd-orders','conn-pdd-write'].includes(connection.id) ? 'configured' : connection.status;
          update(db, 'opc_connections', connection.id, {config_json:json(config), enabled, status, updated_at:nowIso()});
          audit(db, {projectId:null, actor, action:'修改连接配置', objectType:'connection', objectId:connection.id, detail:{enabled, url:config.url || null}});
          return jsonResponse({ok:true, connection:{...one(db, 'SELECT * FROM opc_connections WHERE id=?', connection.id), config:parseJson(one(db, 'SELECT config_json FROM opc_connections WHERE id=?', connection.id).config_json, {})}});
        }
      }

      if (path === '/models' && method === 'GET') return jsonResponse({models:all(db, 'SELECT * FROM opc_model_configs ORDER BY is_default DESC, name')});
      const modelMatch = path.match(/^\/models\/([^/]+)(?:\/(test))?$/);
      if (modelMatch) {
        const model = one(db, 'SELECT * FROM opc_model_configs WHERE id=?', decodeURIComponent(modelMatch[1]));
        if (!model) throw Object.assign(new Error('模型不存在'), {status:404});
        if (modelMatch[2] === 'test' && method === 'POST') {
          const result = await testModel(db, model);
          update(db, 'opc_model_configs', model.id, {last_test_at:nowIso(), last_test_status:result.status, last_test_detail:String(result.detail || '').slice(0,1200)});
          return jsonResponse({ok:result.ok, result, model:one(db, 'SELECT * FROM opc_model_configs WHERE id=?', model.id)});
        }
        if (method === 'PATCH') {
          const body = await readJson(request);
          const patch = {updated_at:nowIso()};
          const configurationChanged = typeof body.model === 'string' && body.model.trim() !== model.model ||
            typeof body.base_url === 'string' && body.base_url.trim() !== model.base_url;
          if (body.is_default === true && model.provider === 'compatible' && (configurationChanged || model.last_test_status !== 'success')) {
            throw Object.assign(new Error('请先测试当前模型配置成功，再设为默认'), {status:409, code:'model_test_required'});
          }
          if (configurationChanged) {
            patch.last_test_at = null;
            patch.last_test_status = null;
            patch.last_test_detail = null;
          }
          if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
          if (body.is_default === true) { db.prepare('UPDATE opc_model_configs SET is_default=0').run(); patch.is_default = 1; patch.enabled = 1; }
          if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
          if (typeof body.base_url === 'string') patch.base_url = body.base_url.trim();
          update(db, 'opc_model_configs', model.id, patch);
          audit(db, {projectId:null, actor, action:'修改模型配置', objectType:'model', objectId:model.id, detail:patch});
          return jsonResponse({ok:true, model:one(db, 'SELECT * FROM opc_model_configs WHERE id=?', model.id)});
        }
      }

      if (path === '/imports/preview' && method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');
        const projectId = String(form.get('projectId') || '');
        if (!file || typeof file === 'string') throw Object.assign(new Error('缺少报表文件'), {status:400});
        const buffer = Buffer.from(await file.arrayBuffer());
        const name = file.name || 'report.csv';
        const isXlsx = /\.xlsx?$/i.test(name) || (file.type || '').includes('spreadsheet');
        const saved = saveUpload({buffer, name, mime:file.type || (isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv'), projectId:projectId || null, source:'报表导入原始文件'});
        const preview = previewReport({text:isXlsx ? null : buffer.toString('utf8'), xlsxBuffer:isXlsx ? buffer : null, filename:name, dataDir});
        if (!preview.ok) return jsonResponse({ok:false, error:{code:'preview_failed', message:preview.error}, file:saved, headers:preview.headers || []}, 400);
        return jsonResponse({ok:true, file:saved, headers:preview.headers, mapping:preview.mapping, rows:preview.rows.slice(0, 80), totals:preview.totals, duplicates:preview.duplicates.length, invalid:preview.invalid.slice(0, 30)});
      }
      if (path === '/imports/commit' && method === 'POST') {
        const body = await readJson(request);
        const file = one(db, 'SELECT * FROM opc_files WHERE id=?', body.fileId);
        if (!file) throw Object.assign(new Error('导入文件不存在'), {status:404});
        const project = one(db, 'SELECT * FROM opc_projects WHERE id=?', body.projectId);
        if (!project) throw Object.assign(new Error('项目不存在'), {status:404});
        const existing = one(db, 'SELECT * FROM opc_import_batches WHERE sha256=? AND status=?', file.sha256, 'committed');
        if (existing?.report_id) return jsonResponse({ok:true, duplicate:true, reportId:existing.report_id, batchId:existing.id});
        const isXlsx = /\.xlsx?$/i.test(file.name);
        const buffer = readFileSync(resolve(filesRoot, file.storage_path));
        const preview = previewReport({text:isXlsx ? null : buffer.toString('utf8'), xlsxBuffer:isXlsx ? buffer : null, filename:file.name, dataDir});
        if (!preview.ok) throw Object.assign(new Error(preview.error), {status:400});
        const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : preview.mapping;
        const rows = preview.rows.map(row => ({...row}));
        const valid = rows.filter(row => row.status === 'valid');
        if (!valid.length) throw Object.assign(new Error('没有可用的数据行'), {status:400});
        const reportId = newId('report');
        const batchId = newId('batch');
        const periodStart = body.periodStart || valid[0].date;
        const periodEnd = body.periodEnd || valid[valid.length - 1].date;
        const summary = reportSummary(rows.map(row => ({...row, revenueCents:row.revenueCents, adSpendCents:row.adSpendCents, errors:row.errors})));
        tx(db, () => {
          insert(db, 'opc_reports', {id:reportId, project_id:project.id, store_id:one(db, 'SELECT id FROM opc_stores WHERE project_id=?', project.id)?.id || null,
            kind:'推广报表', name:String(body.name || ('导入推广报表 ' + periodStart + '~' + periodEnd)).slice(0,160), period_start:periodStart, period_end:periodEnd,
            channel:String(body.channel || '全站推广').slice(0,40), source_file_id:file.id, import_batch:batchId, status:'valid',
            metric_definitions_json:json({ctr:'点击÷曝光×100%', click_cvr:'成交÷点击×100%', cpc:'推广费用÷点击', roas:'归因销售额÷推广费用', amounts:'元，入库为分'}),
            created_at:nowIso()});
          let inserted = 0;
          for (const row of rows) {
            if (row.status === 'duplicate') continue;
            insert(db, 'opc_report_rows', {id:newId('rrow'), report_id:reportId, row_no:row.rowNo, date:row.date, plan:row.plan, channel:row.channel,
              impressions:row.impressions, clicks:row.clicks, orders:row.orders, revenue_cents:row.revenueCents, ad_spend_cents:row.adSpendCents, visitors:row.visitors,
              errors_json:json(row.errors), warnings_json:json(row.warnings), status:row.status});
            inserted += 1;
          }
          insert(db, 'opc_import_batches', {id:batchId, project_id:project.id, report_id:reportId, file_id:file.id, sha256:file.sha256, mapping_json:json(mapping),
            rows_total:rows.length, rows_valid:valid.length, rows_invalid:rows.filter(row => row.status === 'invalid').length,
            status:'committed', created_at:nowIso()});
          audit(db, {projectId:project.id, actor, action:'导入报表', objectType:'report', objectId:reportId, detail:{fileId:file.id, rows:inserted, valid:valid.length, summary:{impressions:summary.impressions,clicks:summary.clicks,orders:summary.orders}}});
        });
        return jsonResponse({ok:true, duplicate:false, reportId, batchId, summary, valid:valid.length, invalid:rows.filter(row => row.status === 'invalid').length});
      }
      if (path === '/imports' && method === 'GET') return jsonResponse({batches:all(db, 'SELECT * FROM opc_import_batches ORDER BY created_at DESC LIMIT 50')});

      if (path === '/search' && method === 'GET') {
        const q = String(url.searchParams.get('q') || '').trim();
        if (!q) return jsonResponse({q, results:[]});
        const like = '%' + q + '%';
        return jsonResponse({q, results:[
          ...all(db, 'SELECT id,title,kind,project_id FROM opc_knowledge WHERE title LIKE ? OR body LIKE ? LIMIT 10', like, like).map(item => ({type:'knowledge', ...item})),
          ...all(db, 'SELECT id,title,kind,project_id,version FROM opc_artifacts WHERE title LIKE ? OR content LIKE ? LIMIT 10', like, like).map(item => ({type:'artifact', ...item})),
          ...all(db, 'SELECT id,name,code,project_id,price_cents FROM opc_skus WHERE name LIKE ? OR code LIKE ? LIMIT 10', like, like).map(item => ({type:'sku', ...item})),
          ...all(db, 'SELECT id,type,status,project_id,original_message FROM opc_tickets WHERE original_message LIKE ? LIMIT 10', like).map(item => ({type:'ticket', ...item})),
          ...all(db, 'SELECT id,name,status FROM opc_projects WHERE name LIKE ? LIMIT 10', like).map(item => ({type:'project', ...item})),
        ]});
      }

      if (path === '/audit' && method === 'GET') {
        const projectId = url.searchParams.get('projectId');
        return jsonResponse({audit:(projectId ? db.prepare('SELECT * FROM opc_audit WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(projectId)
          : db.prepare('SELECT * FROM opc_audit ORDER BY created_at DESC LIMIT 100').all()).map(row => ({...row, detail:parseJson(row.detail_json, null)}))});
      }

      return jsonResponse({error:{code:'not_found', message:'接口不存在：' + method + ' ' + path}}, 404);
    } catch (failure) {
      if (failure?.status >= 500 || !failure?.status) console.error('OPC API', request.method, pathname, failure);
      return errorResponse(failure);
    }
  }

  api.handle = handle;
  return api;
}
