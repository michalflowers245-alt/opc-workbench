const state = {
  session: null, boot: null, page: 'dashboard', hash: '#/dashboard', projectId: null, employeeSlug: null,
  workflowId: null, runId: null, tab: null, ticketId: null, data: {}, projects: [], filters: {}, runTimer: null,
  eventSource: null, modal: null, formNonce: Date.now(), importing: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const esc = (value) => String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money = (cents) => Number.isFinite(cents) ? (cents / 100).toFixed(2) : '—';
const num = (value) => Number.isFinite(value) ? Number(value).toLocaleString('zh-CN') : '—';
const pct = (value) => Number.isFinite(value) ? value.toFixed(2) + '%' : '—';
const shortDate = (value) => value ? new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
const day = (value) => value ? String(value).slice(0,10) : '—';
const badge = (status, label) => '<span class="badge b-' + esc(status || 'draft') + '">' + esc(label || (state.boot && state.boot.statusLabels && state.boot.statusLabels[status]) || status || '—') + '</span>';
const verification = (status) => '<span class="badge b-' + esc(status || 'pending') + '">' + esc((state.boot && state.boot.verificationLabels && state.boot.verificationLabels[status]) || status || '待核') + '</span>';
const roleBySlug = (slug) => (state.boot && state.boot.roles || []).find(item => item.slug === slug) || null;
const employeeBySlug = (slug) => (state.boot && state.boot.employees || []).find(item => item.slug === slug) || null;

function go(hash) {
  if (location.hash === hash) { route(); return; }
  location.hash = hash;
}

function toast(message, type = 'info') {
  const wrap = $('#toast');
  if (!wrap) return;
  const node = document.createElement('div');
  node.className = 'toast ' + (type === 'error' ? 'error' : type === 'ok' ? 'ok' : '');
  node.textContent = message;
  wrap.appendChild(node);
  setTimeout(() => node.remove(), type === 'error' ? 7000 : 4200);
}

async function api(path, opts = {}) {
  const headers = {'x-opc-csrf': state.session && state.session.csrf || ''};
  let body;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const response = await fetch('/api/opc' + path, {method: opts.method || 'GET', headers, body});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : ('请求失败 HTTP ' + response.status);
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function uploadFile(file, projectId, skuId) {
  const form = new FormData();
  form.append('file', file);
  if (projectId) form.append('projectId', projectId);
  if (skuId) form.append('skuId', skuId);
  const response = await fetch('/api/opc/files', {method:'POST', headers:{'x-opc-csrf': state.session.csrf}, body:form});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error && data.error.message || '上传失败');
  return data.file;
}

function loadingHtml(text = '正在读取本机数据…') {
  return '<div class="empty"><div class="big"><span class="spinner"></span></div>' + esc(text) + '</div>';
}

function openModal({title, body, footer = '', wide = false, slim = false}) {
  const wrap = $('#modal');
  wrap.innerHTML = '<div class="modal-backdrop" data-modal-close></div>' +
    '<div class="modal' + (wide ? ' wide' : '') + (slim ? ' slim' : '') + '">' +
    '<div class="modal-head"><h3>' + esc(title) + '</h3><button type="button" class="close" data-modal-close aria-label="关闭">×</button></div>' +
    '<div class="modal-body">' + body + '</div>' + (footer ? '<div class="modal-foot">' + footer + '</div>' : '') + '</div>';
  wrap.classList.add('open');
  state.modal = title;
}

function closeModal() {
  clearRunWatch();
  const wrap = $('#modal');
  wrap.classList.remove('open');
  wrap.innerHTML = '';
  state.modal = null;
}

function field(label, name, value = '', type = 'text', help = '', extra = '') {
  return '<div class="field"><label for="f-' + esc(name) + '">' + esc(label) + '</label><input id="f-' + esc(name) + '" class="input" name="' + esc(name) + '" type="' + esc(type) + '" value="' + esc(value) + '" ' + extra + '>' + (help ? '<span class="help">' + esc(help) + '</span>' : '') + '</div>';
}

function textarea(label, name, value = '', help = '', rows = 5) {
  return '<div class="field"><label for="f-' + esc(name) + '">' + esc(label) + '</label><textarea id="f-' + esc(name) + '" class="input" name="' + esc(name) + '" rows="' + rows + '">' + esc(value) + '</textarea>' + (help ? '<span class="help">' + esc(help) + '</span>' : '') + '</div>';
}

function selectField(label, name, options, value = '', help = '') {
  return '<div class="field"><label for="f-' + esc(name) + '">' + esc(label) + '</label><select id="f-' + esc(name) + '" class="input" name="' + esc(name) + '">' + options.map(option => '<option value="' + esc(option.value) + '"' + (String(option.value) === String(value) ? ' selected' : '') + '>' + esc(option.label) + '</option>').join('') + '</select>' + (help ? '<span class="help">' + esc(help) + '</span>' : '') + '</div>';
}

function statCard(label, value, sub, tone = '') {
  return '<div class="stat"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + '</div><div class="s">' + esc(sub || '') + '</div></div>';
}

function emptyBlock(text, action = '') {
  return '<div class="empty"><div class="big">·</div>' + esc(text) + (action ? '<div style="margin-top:10px">' + action + '</div>' : '') + '</div>';
}

function renderShell() {
  const counts = state.boot.counts || {};
  const issue = state.boot.connections.filter(item => ['permission_denied','failed','not_configured'].includes(item.status) && item.enabled).length;
  const nav = [
    ['dashboard','总览','◫'],['projects','项目与商品','▦'],['employees','数字员工','◎'],['workflows','工作流','⇄'],
    ['knowledge','知识库与文件','⌘'],['approvals','审批与工单','✓'],['settings','接入设置','⚙'],
  ];
  document.body.innerHTML = '<div class="app-shell">' +
    '<aside class="sidebar"><div class="brand"><span class="mark">OPC</span><h1>一人电商工作台</h1><p>八名数字员工 · 拼多多 × 1688<br>本机单经营者 · 数据不出机</p></div>' +
    '<nav class="nav">' + nav.map(([key,label,icon]) => '<a href="#/' + key + '" data-nav="' + key + '"><span class="ic">' + icon + '</span>' + label + '</a>').join('') +
    '<div class="sep"></div><div class="sub">当前工作区</div><div class="sub" style="padding:0 12px;color:#94a3b8;text-transform:none;letter-spacing:0;font-size:11px">' + esc((state.boot.projects[0] && state.boot.projects[0].name) || '尚未创建项目') + '</div></nav>' +
    '<div class="sidebar-foot"><div><span class="dot ' + (issue ? 'warn' : '') + '"></span>' + (issue ? issue + ' 项连接待处理' : '本机服务正常') + '</div><div>' + esc(counts.bindings || 83) + ' 条 Skill 绑定 · v' + esc(state.boot.version || '1.0.0') + '</div><div>' + esc(state.session.operator && state.session.operator.name || '本机经营者') + '</div></div></aside>' +
    '<div class="main"><header class="topbar"><div><div class="title" id="page-title">总览</div><div class="crumb" id="page-sub">进行中的项目、卡住的任务与待审核动作</div></div><div class="spacer"></div>' +
    '<button class="btn sm" data-act="refresh">刷新</button><button class="btn sm primary" data-act="new-project">＋ 新建项目</button></header>' +
    '<main class="content" id="content">' + loadingHtml() + '</main></div></div>' +
    '<nav class="mobile-nav">' + nav.slice(0,5).map(([key,label,icon]) => '<a href="#/' + key + '" data-nav="' + key + '"><span class="ic">' + icon + '</span>' + label + '</a>').join('') + '</nav>' +
    '<div class="modal-wrap" id="modal"></div><div class="toast-wrap" id="toast"></div>';
  document.addEventListener('click', onGlobalClick);
  document.addEventListener('submit', onGlobalSubmit);
  document.addEventListener('change', onGlobalChange);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('#modal') && $('#modal').classList.contains('open')) closeModal(); });
}

function setActiveNav() {
  $$('[data-nav]').forEach(node => node.classList.toggle('active', node.dataset.nav === state.page));
}

async function route() {
  const raw = location.hash || '#/dashboard';
  const [path, query] = raw.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  const segments = path.split('/').filter(Boolean);
  state.page = segments[0] || 'dashboard';
  state.projectId = segments[0] === 'projects' && segments[1] ? decodeURIComponent(segments[1]) : null;
  state.employeeSlug = segments[0] === 'employees' && segments[1] ? decodeURIComponent(segments[1]) : null;
  state.workflowId = segments[0] === 'workflows' && segments[1] ? decodeURIComponent(segments[1]) : null;
  state.runId = segments[0] === 'runs' && segments[1] ? decodeURIComponent(segments[1]) : null;
  state.tab = params.get('tab') || null;
  state.hash = raw;
  setActiveNav();
  const titles = {dashboard:['总览','进行中的项目、卡住的任务、待审核动作与最近产物'],projects:['项目与商品','项目、店铺、SKU、货源、报表与产物的统一视图'],employees:['数字员工','八名员工的独立心智、Skill、工具权限、任务与工作记录'],workflows:['工作流','流程 A/B/C 的步骤、上下游产物与失败恢复'],knowledge:['知识库与文件','店铺政策、商品知识、FAQ、报价、平台规则与报表导入'],approvals:['审批与工单','上架、改价、客服发送、退款等动作与售后工单'],settings:['接入设置','模型、1688、拼多多、生图、MCP、存储与各岗工具']};
  const title = titles[state.page] || ['OPC 工作台',''];
  $('#page-title').textContent = title[0];
  $('#page-sub').textContent = title[1] || '';
  clearRunWatch();
  const content = $('#content');
  content.innerHTML = loadingHtml();
  try {
    if (state.page === 'dashboard') await renderDashboard();
    else if (state.page === 'projects') { if (state.projectId) await renderProject(); else await renderProjects(); }
    else if (state.page === 'employees') { if (state.employeeSlug) await renderEmployee(); else await renderEmployees(); }
    else if (state.page === 'workflows') await renderWorkflows();
    else if (state.page === 'knowledge') await renderKnowledge();
    else if (state.page === 'approvals') await renderApprovals();
    else if (state.page === 'settings') await renderSettings();
    else if (state.page === 'runs') await renderRunPage();
    else content.innerHTML = emptyBlock('页面不存在', '<a class="btn" href="#/dashboard">回到总览</a>');
  } catch (error) {
    content.innerHTML = '<div class="card"><div class="notice bad"><b>加载失败：</b>' + esc(error.message) + '</div><div style="margin-top:12px"><button class="btn" data-act="refresh">重试</button></div></div>';
  }
}

async function renderDashboard() {
  const data = await api('/dashboard');
  const projects = data.projects || [];
  state.projects = projects;
  const demo = projects.find(item => item.is_demo);
  const latestArtifacts = data.artifacts || [];
  const html = '<div class="page-head"><div><h2>今天先处理什么？</h2><p>项目、任务、审批和连接状态都从本机 SQLite 读取。演示项目已明确标为「合成演示」，不会把示例数字当成真实经营结果。</p></div><div class="actions">' +
    '<button class="btn" data-act="new-project">＋ 新建项目</button>' + (demo ? '<button class="btn primary" data-go="#/projects/' + esc(demo.id) + '">进入演示项目</button>' : '') + '</div></div>' +
    '<div class="grid g5">' +
    statCard('进行中项目', data.counts.projects, '含合成演示项目') + statCard('运行中任务', data.counts.activeRuns, '排队与执行中的员工任务') +
    statCard('待审核动作', data.counts.pendingActions, '上架、改价、退款、外发等') + statCard('未结工单', data.counts.openTickets, '售前转售后与售后处理') +
    statCard('连接异常', data.counts.connectionIssues, '需要授权或修复的连接') + '</div>' +
    '<div class="split" style="margin-top:14px"><div class="stack">' +
    '<div class="card"><div class="between"><h3>进行中的项目</h3><span class="small muted">所有数据来自后端</span></div>' +
    (projects.length ? '<div class="list">' + projects.map(project => '<div class="list-item"><div class="avatar" style="background:#2f5bea">' + esc(project.name.slice(0,1)) + '</div><div class="grow"><div class="t">' + esc(project.name) + ' ' + (project.is_demo ? '<span class="pill demo">合成演示</span>' : '') + '</div><div class="s">' + esc(project.platform) + ' · ' + esc(project.category || '未填类目') + ' · ' + num(project.skuCount) + ' 个 SKU · ' + num(project.activeRuns) + ' 个运行中</div></div><div class="btn-row"><button class="btn sm" data-go="#/projects/' + esc(project.id) + '">打开</button><button class="btn sm primary" data-act="continue-project" data-id="' + esc(project.id) + '">继续任务</button></div></div>').join('') + '</div>' : emptyBlock('还没有项目，先创建一个经营项目。')) + '</div>' +
    '<div class="card"><div class="between"><h3>卡住与失败</h3><span class="small muted">可恢复的运行</span></div>' +
    ((data.stuck.length || data.failed.length) ? '<div class="list">' + data.stuck.map(run => '<div class="list-item"><div class="grow"><div class="t">' + esc(run.employee_name || '系统任务') + ' · 运行中但心跳超时</div><div class="s">' + esc(run.error_message || '租约已过期，执行器会回收') + '</div></div><button class="btn sm" data-act="open-run" data-id="' + esc(run.id) + '">查看</button></div>').join('') + data.failed.slice(0,5).map(run => '<div class="list-item"><div class="grow"><div class="t">' + esc(run.employee_name || '系统任务') + ' · ' + esc(run.error_code || '失败') + '</div><div class="s">' + esc(run.error_message || '') + '</div></div><button class="btn sm" data-act="open-run" data-id="' + esc(run.id) + '">查看</button><button class="btn sm" data-act="retry-run" data-id="' + esc(run.id) + '">重试</button></div>').join('') + '</div>' : '<div class="empty">当前没有卡住或失败的任务。</div>') + '</div>' +
    '<div class="card"><div class="between"><h3>最近产物</h3><span class="small muted">可下载与追溯版本</span></div>' +
    (latestArtifacts.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>产物</th><th>项目</th><th>状态</th><th></th></tr></thead><tbody>' + latestArtifacts.slice(0,8).map(item => '<tr><td><b>' + esc(item.title) + '</b><div class="tiny muted">' + esc(item.kind) + ' · v' + item.version + '</div></td><td class="small">' + esc(item.project_name || '—') + '</td><td>' + badge(item.status) + '</td><td class="num"><button class="btn sm" data-act="open-artifact" data-id="' + esc(item.id) + '">查看</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">还没有产物。运行一名员工或一条流程后会自动生成。</div>') + '</div>' +
    '</div><div class="stack">' +
    '<div class="card"><div class="between"><h3>待审核动作</h3><span class="small muted">审批绑定内容版本</span></div>' +
    (data.actions.length ? '<div class="list">' + data.actions.map(action => '<div class="list-item"><div class="grow"><div class="t">' + esc(action.title) + '</div><div class="s">' + esc(action.kind) + ' · v' + action.version + ' · 至 ' + shortDate(action.expires_at) + '</div></div><div class="btn-row"><button class="btn sm primary" data-act="decide-action" data-id="' + esc(action.id) + '" data-decision="approve">批准</button><button class="btn sm danger" data-act="decide-action" data-id="' + esc(action.id) + '" data-decision="reject">拒绝</button></div></div>').join('') + '</div>' : '<div class="empty">没有待审核动作。</div>') + '</div>' +
    '<div class="card"><div class="between"><h3>连接异常</h3><span class="small muted">点开接入设置处理</span></div>' +
    (data.connections.length ? '<div class="list">' + data.connections.map(item => '<div class="list-item"><div class="grow"><div class="t">' + esc(item.name) + '</div><div class="s">' + esc(item.last_test_detail || '尚未测试；需要授权或配置') + '</div></div>' + badge(item.status) + '</div>').join('') + '</div>' : '<div class="empty">全部连接正常或未启用。</div>') +
    '<div style="margin-top:10px"><button class="btn block" data-go="#/settings">打开接入设置</button></div></div>' +
    (demo ? '<div class="card"><h3>演示项目</h3><p class="hint">' + esc(demo.name) + '</p><div class="notice warn">合成演示：售价、进货、报表、供应商与顾客消息都是演示输入；真实连接回执单独标记。</div><div class="btn-row" style="margin-top:12px"><button class="btn sm" data-act="create-workflow" data-id="' + esc(demo.id) + '" data-type="A">跑流程 A</button><button class="btn sm" data-act="create-workflow" data-id="' + esc(demo.id) + '" data-type="B">跑流程 B</button><button class="btn sm" data-act="create-workflow" data-id="' + esc(demo.id) + '" data-type="C">跑流程 C</button></div></div>' : '') +
    '</div></div>';
  $('#content').innerHTML = html;
}

async function renderProjects() {
  const data = await api('/projects');
  state.projects = data.projects;
  const filter = (state.filters.project || '').toLowerCase();
  const projects = data.projects.filter(project => !filter || (project.name + project.category + project.platform).toLowerCase().includes(filter));
  $('#content').innerHTML = '<div class="page-head"><div><h2>项目与商品</h2><p>每个项目绑定一个店铺、一个商品档案与多个 SKU。SKU 的售价、进货、履约、包材、平台费、退款和广告都由后端确定性核算。</p></div><div class="actions"><button class="btn" data-act="new-project">＋ 新建项目</button></div></div>' +
    '<div class="toolbar"><input class="input" id="project-filter" placeholder="搜索项目、类目或平台" value="' + esc(state.filters.project || '') + '" data-act="filter-project"><span class="small muted">共 ' + projects.length + ' 个项目</span></div>' +
    (projects.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>项目</th><th>平台 / 类目</th><th class="num">SKU</th><th class="num">产物</th><th class="num">待审</th><th class="num">未结工单</th><th>创建时间</th><th></th></tr></thead><tbody>' +
      projects.map(project => '<tr><td><a href="#/projects/' + esc(project.id) + '"><b>' + esc(project.name) + '</b></a> ' + (project.is_demo ? '<span class="pill demo">合成演示</span>' : '') + '<div class="tiny muted">' + esc(project.id) + '</div></td><td>' + esc(project.platform) + '<div class="tiny muted">' + esc(project.category || '—') + '</div></td><td class="num">' + num(project.skuCount) + '</td><td class="num">' + num(project.artifactCount) + '</td><td class="num">' + num(project.pendingActions) + '</td><td class="num">' + num(project.openTickets) + '</td><td class="small">' + shortDate(project.created_at) + '</td><td class="num"><button class="btn sm" data-go="#/projects/' + esc(project.id) + '">打开</button></td></tr>').join('') +
      '</tbody></table></div>' : emptyBlock('还没有项目。', '<button class="btn primary" data-act="new-project">创建第一个项目</button>'));
}

function projectForm() {
  return '<form data-form="create-project" class="form">' +
    field('项目名称','name','折叠桌面手机支架 · 新项目','text','用于工作台内部识别') +
    '<div class="form-row">' + field('销售平台','platform','拼多多') + field('类目 / 场景','category','手机支架 / 桌面配件') + '</div>' +
    field('目标客群','audience','租房上班族、大学生、桌面办公人群') +
    '<div class="form-row g3">' + field('价格下限（元）','priceMin','29.90','number') + field('价格上限（元）','priceMax','39.90','number') + field('测款预算（元）','budget','1000','number') + '</div>' +
    '<div class="form-row">' + field('经营模式','fulfillment','一件代发') + field('店铺名称','storeName','OPC 演示店（未授权）') + '</div>' +
    textarea('限制条件','constraints','不做三无产品；不承诺未核实的检测、赠品、库存和送达时效。','每行一条或一段说明',3) +
    '<div class="notice">创建后可在项目页新增 SKU、知识、报表与流程。项目默认只在本机可见。</div>' +
    '<div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn primary" type="submit">创建项目</button></div></form>';
}

async function renderProject() {
  const data = await api('/projects/' + encodeURIComponent(state.projectId));
  const project = data.project;
  state.currentProject = project;
  const tab = state.tab || 'overview';
  const tabs = [['overview','概览'],['skus','SKU 与核算'],['sourcing','货源与报价'],['reports','报表与指标'],['knowledge','商品知识'],['artifacts','产物'],['tickets','工单'],['runs','运行记录']];
  $('#content').innerHTML = '<div class="page-head"><div><h2>' + esc(project.name) + ' ' + (project.is_demo ? '<span class="pill demo">合成演示</span>' : '') + '</h2><p>' + esc(project.description || '') + '</p><div class="row small muted" style="margin-top:6px"><span>' + esc(project.platform) + '</span><span>·</span><span>' + esc(project.category || '未填类目') + '</span><span>·</span><span>' + esc(project.fulfillment || '') + '</span><span>·</span><span>预算 ' + (project.budget_cents ? money(project.budget_cents) + ' 元' : '待填') + '</span></div></div><div class="actions">' +
    '<a class="btn" href="/api/opc/projects/' + esc(project.id) + '/export">导出项目包</a><a class="btn" href="/api/opc/projects/' + esc(project.id) + '/export.csv">导出 CSV</a>' +
    '<button class="btn" data-act="add-sku" data-id="' + esc(project.id) + '">＋ SKU</button><button class="btn primary" data-act="create-workflow" data-id="' + esc(project.id) + '" data-type="A">启动流程 A</button></div></div>' +
    '<div class="tabs">' + tabs.map(([key,label]) => '<button data-act="project-tab" data-tab="' + key + '" class="' + (tab === key ? 'active' : '') + '">' + label + '</button>').join('') + '</div>' +
    '<div id="project-tab">' + renderProjectTab(project, tab) + '</div>';
}

function renderProjectTab(project, tab) {
  const firstSku = project.skus && project.skus[0];
  const latestReport = project.reports && project.reports[0];
  if (tab === 'overview') {
    return '<div class="grid g4">' +
      statCard('SKU', project.skuCount, '正式与候选') + statCard('知识条目', project.knowledgeCount, '含待核与历史回放') +
      statCard('产物', project.artifactCount, '含版本') + statCard('未结工单', project.openTickets, '售前转售后') + '</div>' +
      '<div class="split" style="margin-top:14px"><div class="stack">' +
      '<div class="card"><h3>店铺事实</h3><div class="kv">' + Object.entries(project.store && project.store.facts || {}).map(([key,value]) => '<span class="k">' + esc(key) + '</span><span class="v">' + esc(Array.isArray(value) ? value.join('；') : value) + '</span>').join('') + '</div>' +
      '<div class="divider"></div><div class="row"><span class="small muted">店铺授权</span>' + badge(project.store && project.store.authorization_status || 'not_configured') + '<span class="small muted">平台写入未授权；上架等动作会创建待审动作，不会外发。</span></div></div>' +
      (firstSku ? '<div class="card"><div class="between"><h3>单件利润核算 · ' + esc(firstSku.name) + '</h3><button class="btn sm" data-act="edit-sku" data-id="' + esc(firstSku.id) + '">编辑输入</button></div><div class="grid g4" style="margin:10px 0">' +
        statCard('广告前贡献', money(firstSku.economics.preAdCents) + ' 元', '已扣平台费与退款损耗') +
        statCard('广告后贡献', money(firstSku.economics.postAdCents) + ' 元', '再扣单件广告费') +
        statCard('广告前贡献率', pct(firstSku.economics.preAdRatePct), '贡献 ÷ 确认收入') +
        statCard('盈亏平衡 ROAS', firstSku.economics.breakEvenRoas || '—', '1 ÷ 广告前贡献率') + '</div>' +
        '<div class="formula">' + esc(firstSku.economics.formulas.join('\n')) + '</div></div>' : '<div class="card">' + emptyBlock('还没有 SKU，先添加一个。') + '</div>') +
      '<div class="card"><div class="between"><h3>流程</h3><button class="btn sm" data-act="create-workflow" data-id="' + esc(project.id) + '" data-type="A">新建流程</button></div>' +
        (project.workflows.length ? '<div class="list">' + project.workflows.map(flow => '<div class="list-item"><div class="grow"><div class="t">' + esc(flow.name) + '</div><div class="s">' + flow.current_step + '/' + flow.steps.length + ' 步完成 · ' + esc(flow.status) + '</div></div><button class="btn sm" data-go="#/workflows/' + esc(flow.id) + '">打开</button></div>').join('') + '</div>' : '<div class="empty">还没有流程。可以从流程 A/B/C 开始。</div>') + '</div>' +
      '</div><div class="stack">' +
      '<div class="card"><h3>最近产物</h3>' + (project.artifacts.length ? '<div class="list">' + project.artifacts.slice(0,8).map(item => '<div class="list-item"><div class="grow"><div class="t">' + esc(item.title) + '</div><div class="s">' + esc(item.kind) + ' · v' + item.version + ' · ' + shortDate(item.created_at) + '</div></div><button class="btn sm" data-act="open-artifact" data-id="' + esc(item.id) + '">查看</button></div>').join('') + '</div>' : '<div class="empty">还没有产物。</div>') + '</div>' +
      '<div class="card"><h3>最近运行</h3>' + (project.runs.length ? '<div class="list">' + project.runs.slice(0,6).map(run => '<div class="list-item"><div class="grow"><div class="t">' + esc(run.id.slice(-8)) + ' · ' + badge(run.status) + '</div><div class="s">' + esc(run.error_message || run.provider_model || '') + '</div></div><button class="btn sm" data-act="open-run" data-id="' + esc(run.id) + '">查看</button></div>').join('') + '</div>' : '<div class="empty">还没有运行。</div>') + '</div>' +
      '</div></div>';
  }
  if (tab === 'skus') {
    if (!project.skus.length) return '<div class="card">' + emptyBlock('还没有 SKU。', '<button class="btn primary" data-act="add-sku" data-id="' + esc(project.id) + '">添加 SKU</button>') + '</div>';
    const sku = firstSku;
    return '<div class="split"><div class="stack"><div class="card pad0"><div class="table-wrap"><table class="table"><thead><tr><th>SKU</th><th class="num">售价</th><th class="num">进货</th><th class="num">履约/包材</th><th class="num">平台费</th><th class="num">退款</th><th class="num">广告前</th><th class="num">广告后</th><th>状态</th><th></th></tr></thead><tbody>' +
      project.skus.map(item => '<tr><td><b>' + esc(item.name) + '</b><div class="tiny muted">' + esc(item.code) + ' · ' + esc(item.status) + '</div></td><td class="num">' + money(item.price_cents) + '</td><td class="num">' + money(item.cost_cents) + '</td><td class="num">' + money(item.shipping_cents) + ' / ' + money(item.packaging_cents) + '</td><td class="num">' + money(item.economics.platformFeeCents) + '</td><td class="num">' + money(item.refund_cents) + '</td><td class="num"><b>' + money(item.economics.preAdCents) + '</b></td><td class="num"><b>' + money(item.economics.postAdCents) + '</b></td><td>' + badge(item.status) + '</td><td class="num"><button class="btn sm" data-act="edit-sku" data-id="' + esc(item.id) + '">编辑</button></td></tr>').join('') +
      '</tbody></table></div></div>' +
      '<div class="card"><h3>计算口径</h3><p class="hint">金额入库为整数分；平台费按 SKU 上确认的费率四舍五入到分。代发报价已含运费时，履约费用应填 0，避免重复计入。</p><div class="formula">' + esc(sku.economics.formulas.join('\n')) + '\n\n' + esc((sku.economics.notes || []).join('\n')) + '</div></div></div>' +
      '<div class="card"><h3>SKU 输入</h3><div class="kv"><span class="k">售价</span><span class="v">' + money(sku.price_cents) + ' 元</span><span class="k">进货</span><span class="v">' + money(sku.cost_cents) + ' 元</span><span class="k">快递/代发</span><span class="v">' + money(sku.shipping_cents) + ' 元</span><span class="k">包材</span><span class="v">' + money(sku.packaging_cents) + ' 元</span><span class="k">平台费率</span><span class="v">' + (sku.platform_fee_bps / 100).toFixed(2) + '%（四舍五入到分）</span><span class="k">退款损耗</span><span class="v">' + money(sku.refund_cents) + ' 元</span><span class="k">广告/单</span><span class="v">' + money(sku.ad_cents) + ' 元</span></div><div class="divider"></div><div class="small muted">规格</div><div class="formula">' + esc(JSON.stringify(sku.specs, null, 2)) + '</div></div></div>';
  }
  if (tab === 'sourcing') {
    const conn = (state.boot.connections || []).find(item => item.id === 'conn-1688');
    return '<div class="notice ' + (conn && conn.status === 'permission_denied' ? 'bad' : '') + '" style="margin-bottom:12px"><b>1688 连接：</b>' + badge(conn && conn.status) + ' ' + esc(conn && conn.last_test_detail || '尚未实测；选品专家会记录每次真实请求回执。') + '<div style="margin-top:6px"><button class="btn sm" data-act="test-connection" data-id="conn-1688">重新测试</button> <button class="btn sm primary" data-go="#/employees/product-sourcing?project=' + esc(project.id) + '&sku=' + esc(firstSku && firstSku.id || '') + '">去选品专家找货</button></div></div>' +
      '<div class="card pad0"><div class="between" style="padding:14px 16px"><h3>供应商</h3><span class="small muted">合成演示与历史回放分开标记</span></div><div class="table-wrap"><table class="table"><thead><tr><th>供应商</th><th>产地</th><th>资质</th><th class="num">起订</th><th>发货</th><th>来源</th></tr></thead><tbody>' + project.suppliers.map(item => '<tr><td><b>' + esc(item.name) + '</b><div class="tiny muted">' + esc(item.id) + '</div></td><td>' + esc(item.location || '—') + '</td><td>' + esc(item.qualifications || '—') + '</td><td class="num">' + (item.moq || '—') + '</td><td>' + (item.lead_time_hours ? item.lead_time_hours + ' 小时' : '—') + '</td><td class="small">' + esc(item.source || '—') + '</td></tr>').join('') + '</tbody></table></div></div>' +
      '<div class="card pad0" style="margin-top:14px"><div class="between" style="padding:14px 16px"><h3>报价</h3><span class="small muted">报价必须对应规格、数量级与运费口径</span></div><div class="table-wrap"><table class="table"><thead><tr><th>商品 / 规格</th><th class="num">单价</th><th class="num">起订</th><th class="num">运费</th><th>供应商</th><th>时间</th><th>核验</th></tr></thead><tbody>' + project.quotes.map(item => '<tr><td><b>' + esc(item.spec_text || item.title || '—') + '</b><div class="tiny muted">' + esc(item.item_id || '') + ' · ' + esc(item.sku_ref || '') + '</div></td><td class="num">' + money(item.unit_price_cents) + '</td><td class="num">' + (item.qty_min || '—') + '</td><td class="num">' + (item.shipping_cents === null ? '缺失' : money(item.shipping_cents)) + '</td><td class="small">' + esc(item.supplier_name || '—') + '</td><td class="small">' + day(item.retrieved_at) + '</td><td>' + verification(item.verification_status) + '</td></tr>').join('') + '</tbody></table></div></div>';
  }
  if (tab === 'reports') {
    if (!latestReport) return '<div class="card">' + emptyBlock('还没有报表。导入 CSV/Excel 推广报表后会自动计算指标。', '<button class="btn primary" data-go="#/knowledge?tab=import&project=' + esc(project.id) + '">导入报表</button>') + '</div>';
    const m = latestReport.summary.metrics;
    return '<div class="card"><div class="between"><div><h3>' + esc(latestReport.name) + '</h3><p class="hint">' + esc(latestReport.period_start) + ' 至 ' + esc(latestReport.period_end) + ' · ' + esc(latestReport.channel || '渠道未填') + ' · 有效 ' + latestReport.summary.validRows + ' 行 / 无效 ' + latestReport.invalidRows + ' 行</p></div><button class="btn sm" data-go="#/knowledge?tab=import&project=' + esc(project.id) + '">导入新报表</button></div>' +
      '<div class="grid g4">' + statCard('CTR', pct(m.ctrPct), '点击 ' + num(m.ctr.numerator) + ' ÷ 曝光 ' + num(m.ctr.denominator)) + statCard('点击成交转化率', pct(m.clickCvrPct), '成交 ' + num(m.clickCvr.numerator) + ' ÷ 点击 ' + num(m.clickCvr.denominator)) + statCard('CPC', money(m.cpcCents) + ' 元', '推广费用 ÷ 点击') + statCard('ROAS', m.roas === null ? '—' : m.roas.toFixed(2), '归因销售额 ÷ 推广费用') + '</div>' +
      '<div class="formula" style="margin-top:12px">' + esc(m.formulas.join('\n')) + '</div>' +
      '<div class="table-wrap" style="margin-top:14px"><table class="table"><thead><tr><th>行</th><th>日期</th><th class="num">曝光</th><th class="num">点击</th><th class="num">成交</th><th class="num">销售额</th><th class="num">推广费</th><th class="num">访客</th><th>校验</th></tr></thead><tbody>' +
      latestReport.rows.map(row => '<tr' + (row.errors && row.errors.length ? ' style="background:#fffbfa"' : '') + '><td class="num">' + row.row_no + '</td><td>' + esc(row.date || '—') + '</td><td class="num">' + num(row.impressions) + '</td><td class="num">' + num(row.clicks) + '</td><td class="num">' + num(row.orders) + '</td><td class="num">' + money(row.revenue_cents) + '</td><td class="num">' + money(row.ad_spend_cents) + '</td><td class="num">' + num(row.visitors) + '</td><td>' + (row.errors && row.errors.length ? '<span class="badge b-failed">' + esc(row.errors.join('；')) + '</span>' : '<span class="badge b-success">通过</span>') + '</td></tr>').join('') +
      '</tbody></table></div></div>';
  }
  if (tab === 'knowledge') {
    return '<div class="between" style="margin-bottom:10px"><h3 style="margin:0">商品与店铺知识</h3><button class="btn sm primary" data-act="add-knowledge" data-id="' + esc(project.id) + '">＋ 知识</button></div>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th>标题</th><th>类型</th><th>来源</th><th>适用</th><th>核验</th><th>最后核验</th></tr></thead><tbody>' +
      project.knowledge.map(item => '<tr><td><b>' + esc(item.title) + '</b><div class="tiny muted">' + esc(String(item.body).slice(0,90)) + '…</div></td><td>' + esc(item.kind) + '</td><td class="small">' + esc(item.source || '—') + '</td><td class="small">' + esc(item.effective_from ? day(item.effective_from) : '—') + '</td><td>' + verification(item.verification_status) + '</td><td class="small">' + (item.last_verified_at ? shortDate(item.last_verified_at) : '—') + '</td></tr>').join('') + '</tbody></table></div>';
  }
  if (tab === 'artifacts') {
    return project.artifacts.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>产物</th><th>类型</th><th class="num">版本</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>' + project.artifacts.map(item => '<tr><td><b>' + esc(item.title) + '</b></td><td>' + esc(item.kind) + '</td><td class="num">v' + item.version + '</td><td>' + badge(item.status) + '</td><td class="small">' + shortDate(item.created_at) + '</td><td class="num"><button class="btn sm" data-act="open-artifact" data-id="' + esc(item.id) + '">查看</button><button class="btn sm" data-act="artifact-versions" data-id="' + esc(item.id) + '">版本</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="card">' + emptyBlock('还没有产物。运行员工或流程后生成。') + '</div>';
  }
  if (tab === 'tickets') {
    return project.tickets.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>问题</th><th>类型</th><th>订单</th><th>状态</th><th>情绪</th><th>更新时间</th><th></th></tr></thead><tbody>' + project.tickets.map(item => '<tr><td><b>' + esc(String(item.original_message || '').slice(0,50)) + '</b><div class="tiny muted">' + esc(item.id) + '</div></td><td>' + esc(item.type) + '</td><td class="small">' + esc(item.order_ref || '—') + '</td><td>' + badge(item.status) + '</td><td>' + esc(item.emotion || '—') + '</td><td class="small">' + shortDate(item.updated_at) + '</td><td class="num"><button class="btn sm" data-act="open-ticket" data-id="' + esc(item.id) + '">打开</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="card">' + emptyBlock('还没有工单。') + '</div>';
  }
  if (tab === 'runs') {
    return project.runs.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>运行</th><th>员工</th><th>状态</th><th>模型</th><th>错误</th><th>时间</th><th></th></tr></thead><tbody>' + project.runs.map(run => '<tr><td class="mono">' + esc(run.id.slice(-10)) + '</td><td>' + esc((employeeBySlug((state.boot.employees.find(e => e.id === run.employee_id) || {}).slug) || {}).name || '系统/未知') + '</td><td>' + badge(run.status) + '</td><td class="small">' + esc(run.provider_model || '—') + '</td><td class="small">' + esc(run.error_message || '—') + '</td><td class="small">' + shortDate(run.created_at) + '</td><td class="num"><button class="btn sm" data-act="open-run" data-id="' + esc(run.id) + '">查看</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="card">' + emptyBlock('还没有运行。') + '</div>';
  }
  return '';
}

async function renderEmployees() {
  const data = await api('/employees');
  state.boot.employees = data.employees;
  $('#content').innerHTML = '<div class="page-head"><div><h2>八名数字员工</h2><p>每名员工有独立心智版本、模型、Skill 绑定、工具授权、任务入口和工作日志。真实调用与演示数据在结果里分别标记。</p></div><div class="actions"><button class="btn" data-act="new-project">＋ 新建项目</button></div></div>' +
    '<div class="grid g4">' + data.employees.map(employee => '<div class="card"><div class="row"><div class="avatar" style="background:' + esc(employee.color || '#2f5bea') + '">' + esc(employee.avatar || employee.name.slice(0,1)) + '</div><div class="grow"><h3 style="margin:0">' + esc(employee.name) + '</h3><div class="tiny muted">' + esc(employee.slug) + ' · 心智 v' + esc(employee.mind_version) + '</div></div></div>' +
      '<p class="hint" style="margin-top:10px">' + esc(employee.description || '') + '</p>' +
      '<div class="row small muted" style="gap:6px"><span class="pill">模型 ' + esc(employee.model && employee.model.model || '继承默认') + '</span><span class="pill">' + employee.skillCount + ' Skill</span><span class="pill">' + employee.grantCount + ' 工具</span></div>' +
      '<div class="row" style="margin-top:10px"><span class="small muted">最近：</span>' + (employee.lastRun ? badge(employee.lastRun.status) + '<span class="tiny muted">' + shortDate(employee.lastRun.created_at) + '</span>' : '<span class="tiny muted">尚未运行</span>') + '</div>' +
      '<div class="btn-row" style="margin-top:12px"><button class="btn sm primary" data-go="#/employees/' + esc(employee.slug) + '?tab=task">派任务</button><button class="btn sm" data-go="#/employees/' + esc(employee.slug) + '?tab=mind">心智与配置</button></div></div>').join('') + '</div>';
}

async function renderEmployee() {
  const data = await api('/employees/' + encodeURIComponent(state.employeeSlug));
  state.employeeData = data;
  const employee = data.employee;
  const role = employee.role || roleBySlug(employee.slug) || {};
  const projects = state.projects.length ? state.projects : (await api('/projects')).projects;
  state.projects = projects;
  const url = new URLSearchParams((location.hash.split('?')[1] || ''));
  const projectId = url.get('project') || (projects.find(item => item.is_demo) || projects[0] || {}).id || '';
  const skuId = url.get('sku') || '';
  const tab = state.tab || 'task';
  const tabs = [['task','任务' ],['mind','心智'],['skills','Skill'],['tools','工具权限'],['knowledge','知识库'],['logs','工作日志']];
  let html = '<div class="page-head"><div><h2>' + esc(employee.name) + '</h2><p>' + esc(employee.description || '') + '</p><div class="row small muted" style="margin-top:6px"><span>心智 v' + esc(employee.mind_version) + '</span><span>·</span><span>' + esc(employee.slug) + '</span><span>·</span><span>模型 ' + esc(data.model && data.model.model || '继承默认') + '</span><span>·</span><span>' + esc(employee.status) + '</span></div></div><div class="actions"><button class="btn" data-act="employee-model" data-id="' + esc(employee.slug) + '">切换模型</button><button class="btn" data-go="#/employees">返回八岗</button></div></div>' +
    '<div class="tabs">' + tabs.map(([key,label]) => '<button data-act="employee-tab" data-tab="' + key + '" data-id="' + esc(employee.slug) + '" class="' + (tab === key ? 'active' : '') + '">' + label + '</button>').join('') + '</div><div id="employee-tab">';
  if (tab === 'task') {
    const project = projects.find(item => item.id === projectId) || projects[0];
    const skus = project && project.skus || [];
    const selectedSku = skus.find(item => item.id === skuId) || skus[0];
    const template = role.taskTitle || '自定义任务';
    html += '<div class="split"><div class="card"><h3>派一个任务</h3><p class="hint">任务会固定本次员工心智版本、模型、Skill、工具授权与上游产物版本；刷新或重复点击使用同一请求号去重。</p>' +
      '<form data-form="run-employee" data-slug="' + esc(employee.slug) + '" class="form">' +
      '<div class="form-row">' + selectField('项目','projectId',projects.map(item => ({value:item.id,label:item.name})),projectId) + '<div class="field"><label for="f-skuId">SKU</label><select id="f-skuId" class="input" name="skuId">' + skus.map(item => '<option value="' + esc(item.id) + '"' + (selectedSku && item.id === selectedSku.id ? ' selected' : '') + '>' + esc(item.name) + ' · ' + money(item.price_cents) + ' 元</option>').join('') + '</select><span class="help">不选则按项目执行</span></div></div>' +
      '<div class="form-row">' + selectField('任务模板','template',[{value:template,label:template},{value:'自定义任务',label:'自定义任务'}],template) + field('请求号','requestId',String(Date.now()) + '-' + Math.random().toString(36).slice(2,8),'text','重复点击同一请求号只处理一次') + '</div>' +
      textarea('任务说明','task',role.taskPlaceholder || employee.description || '请完成一项本岗位任务。','写清输入、时间窗、证据要求与禁止事项',6) +
      '<div class="field"><label for="f-attachment">附件（可选）</label><input id="f-attachment" class="input" name="attachment" type="file"><span class="help">上传后作为本次任务的附件引用；不会公开为静态资源。</span></div>' +
      '<div class="notice warn">当前模型：' + esc(data.model && data.model.model || '继承默认') + '。模型只负责分析与表达，利润、漏斗与比率由后端核算；输出中的未核实项会标“待核”。' + (employee.slug === 'visual-designer' ? ' 当前为提示词模式：只产出逐图提示词与脚本，不生成图片。' : '') + '</div>' +
      '<div class="btn-row" style="justify-content:flex-end"><button class="btn primary" type="submit">开始任务</button></div></form></div>' +
      '<div class="stack"><div class="card"><h3>运行结果</h3><div id="employee-run">' + (data.logs.length ? '<div class="small muted">最近一次：</div>' + runSummary(data.logs[0]) : '<div class="empty">还没有运行。提交任务后在这里看到步骤、工具回执和产物。</div>') + '</div></div>' +
      '<div class="card"><h3>岗位模板</h3><div class="kv"><span class="k">典型输入</span><span class="v">' + esc(role.taskPlaceholder || '') + '</span><span class="k">结构化字段</span><span class="v">' + esc((role.outputFields || []).join('、')) + '</span><span class="k">允许工具</span><span class="v">' + esc((role.tools || []).join('、')) + '</span></div></div></div></div>';
  } else if (tab === 'mind') {
    html += '<div class="split"><div class="card"><h3>当前运行版本 v' + esc(employee.mind_version) + '</h3><form data-form="save-mind" data-slug="' + esc(employee.slug) + '" class="form">' + textarea('心智文本','runtimeText',data.mind && data.mind.runtime_text || '','保存后生成新版本，旧运行仍回查旧版本',14) + '<div class="btn-row" style="justify-content:flex-end"><button class="btn primary" type="submit">发布新版本</button></div></form></div>' +
      '<div class="stack"><div class="card"><h3>版本历史</h3>' + (data.minds.length ? '<div class="list">' + data.minds.map(item => '<div class="list-item"><div class="grow"><div class="t">v' + esc(item.version) + ' ' + (item.version === employee.mind_version ? badge('success','当前') : '') + '</div><div class="s">' + esc(item.source || '') + ' · ' + shortDate(item.created_at) + ' · ' + item.chars + ' 字</div></div></div>').join('') + '</div>' : '<div class="empty">暂无版本。</div>') + '</div>' +
      '<div class="card"><h3>原始配置来源</h3><div class="small muted">' + esc(data.mind && data.mind.source || '') + '</div><details style="margin-top:8px"><summary class="small">查看原始心智材料</summary><pre class="code" style="max-height:320px">' + esc((data.mind && data.mind.source_text || '未保存原始材料').slice(0,12000)) + '</pre></details></div></div></div>';
  } else if (tab === 'skills') {
    html += '<div class="card"><div class="between"><h3>Skill 绑定</h3><span class="small muted">' + data.skills.length + ' 条，其中初始绑定 ' + data.skills.filter(item => item.relation === 'initial').length + ' 条</span></div><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Skill</th><th>版本</th><th>来源</th><th>安装状态</th><th></th></tr></thead><tbody>' + data.skills.map(item => '<tr><td class="num">' + (item.binding_index || '内置') + '</td><td><b>' + esc(item.name || item.label) + '</b><div class="tiny muted">' + esc(item.slug) + ' · ' + esc(item.relation) + '</div></td><td>' + esc(item.version || '待提供') + '</td><td class="small">' + esc(item.source || item.origin || '—') + '</td><td>' + badge(item.install_status) + '</td><td class="num">' + (item.package_path ? '<button class="btn sm" data-act="verify-skill" data-id="' + esc(item.slug) + '">核验文件</button>' : '<span class="tiny muted">仅名录</span>') + '</td></tr>').join('') + '</tbody></table></div></div>';
  } else if (tab === 'tools') {
    html += '<div class="card"><h3>工具授权</h3><p class="hint">L1 自动、L2 执行后通知、L3 需审批。外部写入一律先创建待审动作；未获授权的工具调用会被拒绝并留下回执。</p><div class="table-wrap"><table class="table"><thead><tr><th>工具</th><th>说明</th><th>当前级别</th><th>启用</th><th></th></tr></thead><tbody>' + (state.boot.toolCatalog ? Object.entries(state.boot.toolCatalog).map(([key, tool]) => {
      const grant = data.grants.find(item => item.tool_key === key) || {level:tool.defaultLevel, enabled:0};
      return '<tr><td><b>' + esc(tool.label) + '</b><div class="tiny muted">' + esc(key) + '</div></td><td class="small">' + esc(tool.description) + '</td><td><select class="input" style="width:90px" data-act="grant-tool" data-slug="' + esc(employee.slug) + '" data-tool="' + esc(key) + '"><option value="L1"' + (grant.level === 'L1' ? ' selected' : '') + '>L1</option><option value="L2"' + (grant.level === 'L2' ? ' selected' : '') + '>L2</option><option value="L3"' + (grant.level === 'L3' ? ' selected' : '') + '>L3</option></select></td><td><input type="checkbox" data-act="grant-enabled" data-slug="' + esc(employee.slug) + '" data-tool="' + esc(key) + '"' + (grant.enabled ? ' checked' : '') + '></td><td class="tiny muted">' + (grant.enabled ? '已授权' : '未授权') + '</td></tr>';
    }).join('') : '') + '</tbody></table></div></div>';
  } else if (tab === 'knowledge') {
    const project = projects.find(item => item.id === projectId) || projects[0];
    const detail = project ? await api('/projects/' + project.id) : null;
    const knowledge = detail ? detail.project.knowledge : [];
    html += '<div class="card"><div class="between"><h3>本岗位可读知识 · ' + esc(project ? project.name : '') + '</h3><span class="small muted">按项目共享；客服、文案和美工只能把已核验条目写成事实</span></div><div class="table-wrap"><table class="table"><thead><tr><th>标题</th><th>类型</th><th>来源</th><th>核验</th><th>最后核验</th></tr></thead><tbody>' + (knowledge.length ? knowledge.map(item => '<tr><td><b>' + esc(item.title) + '</b><div class="tiny muted">' + esc(String(item.body).slice(0,100)) + '</div></td><td>' + esc(item.kind) + '</td><td class="small">' + (item.source_url ? '<a href="' + esc(item.source_url) + '" target="_blank" rel="noreferrer">' + esc(item.source || item.source_url) + '</a>' : esc(item.source || '—')) + '</td><td>' + verification(item.verification_status) + '</td><td class="small">' + (item.last_verified_at ? shortDate(item.last_verified_at) : '—') + '</td></tr>').join('') : '<tr><td colspan="5">' + emptyBlock('该项目还没有知识。') + '</td></tr>') + '</tbody></table></div><div style="margin-top:10px"><button class="btn sm" data-go="#/knowledge?project=' + esc(project ? project.id : '') + '">在知识库中新增/维护</button></div></div>';
  } else if (tab === 'logs') {
    html += '<div class="card pad0"><div class="table-wrap"><table class="table"><thead><tr><th>运行</th><th>状态</th><th>模型</th><th class="num">Token</th><th>错误</th><th>时间</th><th></th></tr></thead><tbody>' + (data.logs.length ? data.logs.map(run => '<tr><td class="mono">' + esc(run.id.slice(-10)) + '</td><td>' + badge(run.status) + '</td><td class="small">' + esc(run.provider_model || '—') + '</td><td class="num">' + num((run.tokens_in || 0) + (run.tokens_out || 0)) + '</td><td class="small">' + esc(run.error_message || '—') + '</td><td class="small">' + shortDate(run.created_at) + '</td><td class="num"><button class="btn sm" data-act="open-run" data-id="' + esc(run.id) + '">查看</button></td></tr>').join('') : '<tr><td colspan="7">' + emptyBlock('还没有工作日志。') + '</td></tr>') + '</tbody></table></div></div>';
  }
  html += '</div>';
  $('#content').innerHTML = html;
}

function runSummary(run) {
  return '<div class="row"><span class="mono">' + esc(run.id.slice(-10)) + '</span>' + badge(run.status) + '<span class="small muted">' + shortDate(run.created_at) + '</span><button class="btn sm" data-act="open-run" data-id="' + esc(run.id) + '">打开运行</button></div>';
}

async function renderWorkflows() {
  const data = await api('/workflows');
  const projects = state.projects.length ? state.projects : (await api('/projects')).projects;
  state.projects = projects;
  if (state.workflowId) {
    const detail = await api('/workflows/' + encodeURIComponent(state.workflowId));
    const wf = detail.workflow;
    const project = projects.find(item => item.id === wf.project_id);
    $('#content').innerHTML = '<div class="page-head"><div><h2>' + esc(wf.name) + '</h2><p>' + esc(project && project.name || '') + ' · ' + esc(wf.type) + ' 型流程 · ' + esc(wf.status) + '</p></div><div class="actions"><button class="btn" data-go="#/workflows">返回流程</button><button class="btn" data-act="pause-workflow" data-id="' + esc(wf.id) + '">暂停</button></div></div>' +
      '<div class="split"><div class="card"><div class="between"><h3>步骤</h3><span class="small muted">' + wf.current_step + '/' + wf.steps.length + ' 完成</span></div><div class="progress" style="margin:10px 0 16px"><i style="width:' + Math.round((wf.current_step / Math.max(1,wf.steps.length)) * 100) + '%"></i></div>' +
      '<div class="steps">' + wf.steps.map(step => '<div class="step ' + esc(step.status) + '"><div class="dot">' + (step.status === 'success' ? '✓' : step.status === 'failed' ? '!' : step.status === 'running' ? '…' : step.seq) + '</div><div class="body"><div class="t">' + esc(step.seq) + '. ' + esc(step.name) + ' ' + badge(step.status) + '</div><div class="s">' + (step.employee ? '负责：' + esc(step.employee.name) : '人工/系统步骤') + ' · 上游：' + esc(step.depends_on || '无') + (step.note ? ' · ' + esc(step.note) : '') + '</div>' +
        (step.run ? '<div class="small muted" style="margin-top:4px">运行 ' + esc(step.run.id.slice(-10)) + ' · 模型 ' + esc(step.run.provider_model || '—') + ' · ' + badge(step.run.status) + '</div>' : '') +
        (step.artifact ? '<div class="small" style="margin-top:4px">产物：' + esc(step.artifact.title) + ' v' + step.artifact.version + ' <button class="btn sm" data-act="open-artifact" data-id="' + esc(step.artifact.id) + '">查看</button></div>' : '') +
        '<div class="btn-row" style="margin-top:8px">' +
        (step.status === 'success' ? ((step.run ? '<button class="btn sm" data-act="open-run" data-id="' + esc(step.run.id) + '">查看运行</button>' : '') + '<button class="btn sm" data-act="workflow-step" data-force="1" data-wf="' + esc(wf.id) + '" data-step="' + esc(step.key) + '">重跑此步</button>') : '<button class="btn sm primary" data-act="workflow-step" data-wf="' + esc(wf.id) + '" data-step="' + esc(step.key) + '">' + (step.status === 'failed' ? '从失败处恢复' : step.key === 'listing' ? '装配资料包' : step.key === 'confirm_sku' ? '选择主推 SKU' : '运行此步') + '</button>') +
        '<button class="btn sm" data-act="workflow-note" data-wf="' + esc(wf.id) + '" data-step="' + esc(step.key) + '">补资料</button>' +
        '<button class="btn sm" data-act="workflow-step-force" data-wf="' + esc(wf.id) + '" data-step="' + esc(step.key) + '">从中间开工</button>' +
        '</div></div></div>').join('') + '</div></div>' +
      '<div class="stack"><div class="card"><h3>交接记录</h3>' + (wf.handoffs.length ? '<div class="list">' + wf.handoffs.map(item => '<div class="list-item"><div class="grow"><div class="t">' + esc((item.payload && item.payload.fromStep) || '交接') + ' → ' + esc((item.payload && item.payload.toStep) || '') + '</div><div class="s">' + esc(JSON.stringify(item.payload || {}).slice(0,180)) + ' · ' + shortDate(item.created_at) + '</div></div></div>').join('') + '</div>' : '<div class="empty">还没有交接。运行步骤后自动记录上游产物版本。</div>') + '</div>' +
      '<div class="card"><h3>流程说明</h3><div class="small muted">每一步固定岗位心智版本、模型、Skill、工具授权和上游产物版本。人工确认步骤不调用模型；失败可从允许重试的节点继续，已成功产物保留。</div><div class="divider"></div><button class="btn block" data-go="#/projects/' + esc(wf.project_id) + '">打开项目</button></div></div></div>';
    return;
  }
  const projectFilter = state.filters.workflowProject || 'all';
  const list = data.workflows.filter(item => projectFilter === 'all' || item.project_id === projectFilter);
  $('#content').innerHTML = '<div class="page-head"><div><h2>工作流</h2><p>流程 A：市场 → 选品 → 确认 SKU → 文案 → 美工 → 上架包 → 运营；流程 B：售前 → 售后；流程 C：数据 → 运营复盘。</p></div><div class="actions">' +
    '<button class="btn" data-act="create-workflow" data-id="' + esc((projects.find(p => p.is_demo) || projects[0] || {}).id || '') + '" data-type="A">新建流程 A</button><button class="btn" data-act="create-workflow" data-id="' + esc((projects.find(p => p.is_demo) || projects[0] || {}).id || '') + '" data-type="B">新建流程 B</button><button class="btn" data-act="create-workflow" data-id="' + esc((projects.find(p => p.is_demo) || projects[0] || {}).id || '') + '" data-type="C">新建流程 C</button></div></div>' +
    '<div class="toolbar"><select class="input" data-act="workflow-project-filter"><option value="all">全部项目</option>' + projects.map(p => '<option value="' + esc(p.id) + '"' + (projectFilter === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select><span class="small muted">' + list.length + ' 条流程</span></div>' +
    (list.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>流程</th><th>项目</th><th>进度</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>' + list.map(flow => '<tr><td><b>' + esc(flow.name) + '</b><div class="tiny muted">' + esc(flow.id) + '</div></td><td class="small">' + esc((projects.find(p => p.id === flow.project_id) || {}).name || flow.project_id) + '</td><td><div class="progress" style="width:120px"><i style="width:' + Math.round((flow.current_step / Math.max(1,flow.steps.length)) * 100) + '%"></i></div><div class="tiny muted">' + flow.current_step + '/' + flow.steps.length + '</div></td><td>' + badge(flow.status) + '</td><td class="small">' + shortDate(flow.updated_at) + '</td><td class="num"><button class="btn sm" data-go="#/workflows/' + esc(flow.id) + '">打开</button></td></tr>').join('') + '</tbody></table></div>' : emptyBlock('还没有流程。选择项目后创建流程 A/B/C。'));
}

async function renderApprovals() {
  const [actionsData, ticketsData, projects] = await Promise.all([api('/actions'), api('/tickets'), api('/projects')]);
  state.projects = projects.projects;
  const tab = state.tab || 'actions';
  const projectsById = Object.fromEntries(projects.projects.map(item => [item.id, item]));
  const actions = actionsData.actions || [];
  const tickets = ticketsData.tickets || [];
  $('#content').innerHTML = '<div class="page-head"><div><h2>审批与工单</h2><p>审批绑定动作内容版本、金额与有效期；修改草稿后旧审批失效。外部写入只有在取得有效连接与第三方回执后才算成功。</p></div><div class="actions"><button class="btn" data-go="#/knowledge?tab=import">导入报表</button></div></div>' +
    '<div class="grid g4">' + statCard('待审动作', actions.filter(item => item.status === 'pending').length, '上架、改价、退款、外发') + statCard('等待授权', actions.filter(item => item.status === 'awaiting_authorization').length, '已批准但未外发') + statCard('未结工单', tickets.filter(item => !['closed','resolved'].includes(item.status)).length, '售前转售后') + statCard('已拒绝', actions.filter(item => item.status === 'rejected').length, '保持未执行') + '</div>' +
    '<div class="tabs" style="margin-top:14px"><button data-act="approval-tab" data-tab="actions" class="' + (tab === 'actions' ? 'active' : '') + '">待审动作</button><button data-act="approval-tab" data-tab="tickets" class="' + (tab === 'tickets' ? 'active' : '') + '">售后与售前工单</button></div>' +
    (tab === 'tickets' ? '<div class="table-wrap"><table class="table"><thead><tr><th>问题</th><th>项目 / SKU</th><th>类型</th><th>状态</th><th>情绪</th><th>订单</th><th>更新时间</th><th></th></tr></thead><tbody>' + (tickets.length ? tickets.map(ticket => '<tr><td><b>' + esc(String(ticket.original_message || '').slice(0,60)) + '</b><div class="tiny muted">' + esc(ticket.id) + '</div></td><td class="small">' + esc((projectsById[ticket.project_id] || {}).name || '—') + '<div class="tiny muted">' + esc(ticket.sku_id || '') + '</div></td><td>' + esc(ticket.type) + '</td><td>' + badge(ticket.status) + '</td><td>' + esc(ticket.emotion || '—') + '</td><td class="small">' + esc(ticket.order_ref || '—') + '</td><td class="small">' + shortDate(ticket.updated_at) + '</td><td class="num"><button class="btn sm" data-act="open-ticket" data-id="' + esc(ticket.id) + '">打开</button></td></tr>').join('') : '<tr><td colspan="8">' + emptyBlock('还没有工单。') + '</td></tr>') + '</tbody></table></div>' :
      '<div class="table-wrap"><table class="table"><thead><tr><th>动作</th><th>提交人</th><th>项目</th><th>类型</th><th class="num">金额</th><th>状态</th><th>版本</th><th>有效期</th><th>回执</th><th></th></tr></thead><tbody>' + (actions.length ? actions.map(action => '<tr><td><b>' + esc(action.title) + '</b><div class="tiny muted">' + esc(action.business_impact || '') + '</div></td><td class="small">' + esc(action.submitter || '系统/经营者') + '</td><td class="small">' + esc((projectsById[action.project_id] || {}).name || '—') + '</td><td>' + esc(action.kind) + '</td><td class="num">' + (Number.isInteger(action.amount_cents) ? money(action.amount_cents) : '—') + '</td><td>' + badge(action.status) + '</td><td class="num">v' + action.version + '</td><td class="small">' + shortDate(action.expires_at) + '</td><td class="small">' + (action.receipt ? esc(String(action.receipt.reason || action.receipt.businessId || '').slice(0,50)) : '—') + '</td><td class="num"><div class="btn-row">' + (action.status === 'pending' ? '<button class="btn sm primary" data-act="decide-action" data-id="' + esc(action.id) + '" data-decision="approve">批准</button><button class="btn sm danger" data-act="decide-action" data-id="' + esc(action.id) + '" data-decision="reject">拒绝</button><button class="btn sm" data-act="revise-action" data-id="' + esc(action.id) + '">改稿</button>' : '<button class="btn sm" data-act="view-action" data-id="' + esc(action.id) + '">详情</button>') + '</div></td></tr>').join('') : '<tr><td colspan="10">' + emptyBlock('没有待审动作。运营或售后运行后会在这里生成。') + '</td></tr>') + '</tbody></table></div>');
}

async function renderKnowledge() {
  const projects = state.projects.length ? state.projects : (await api('/projects')).projects;
  state.projects = projects;
  const query = new URLSearchParams((location.hash.split('?')[1] || ''));
  const projectId = query.get('project') || state.filters.knowledgeProject || (projects.find(item => item.is_demo) || projects[0] || {}).id;
  const tab = state.tab || 'knowledge';
  if (!projectId) { $('#content').innerHTML = emptyBlock('请先创建项目。'); return; }
  const data = await api('/projects/' + encodeURIComponent(projectId));
  const project = data.project;
  $('#content').innerHTML = '<div class="page-head"><div><h2>知识库与文件</h2><p>按项目和 SKU 管理店铺政策、商品知识、FAQ、供应商报价、平台规则、原图与报表。每条知识保存来源、适用时间和核验状态。</p></div><div class="actions"><a class="btn" href="/api/opc/projects/' + esc(project.id) + '/export">导出项目包</a></div></div>' +
    '<div class="toolbar"><select class="input" data-act="knowledge-project">' + projects.map(item => '<option value="' + esc(item.id) + '"' + (item.id === projectId ? ' selected' : '') + '>' + esc(item.name) + '</option>').join('') + '</select><span class="small muted">' + esc(project.platform) + ' · ' + esc(project.category || '') + '</span></div>' +
    '<div class="tabs"><button data-act="knowledge-tab" data-tab="knowledge" class="' + (tab === 'knowledge' ? 'active' : '') + '">知识</button><button data-act="knowledge-tab" data-tab="files" class="' + (tab === 'files' ? 'active' : '') + '">文件</button><button data-act="knowledge-tab" data-tab="import" class="' + (tab === 'import' ? 'active' : '') + '">报表导入</button><button data-act="knowledge-tab" data-tab="artifacts" class="' + (tab === 'artifacts' ? 'active' : '') + '">产物</button></div>';
  if (tab === 'knowledge') {
    $('#content').innerHTML += '<div class="between" style="margin-bottom:10px"><span class="small muted">原始数据、自动提取、人工确认与样例均单独标记。</span><button class="btn sm primary" data-act="add-knowledge" data-id="' + esc(project.id) + '">＋ 知识</button></div><div class="table-wrap"><table class="table"><thead><tr><th>标题</th><th>类型</th><th>来源</th><th>适用</th><th>核验</th><th>最后核验</th></tr></thead><tbody>' + (project.knowledge.length ? project.knowledge.map(item => '<tr><td><b>' + esc(item.title) + '</b><div class="tiny muted">' + esc(String(item.body).slice(0,110)) + '</div></td><td>' + esc(item.kind) + '</td><td class="small">' + esc(item.source || '—') + '</td><td class="small">' + day(item.effective_from) + '</td><td>' + verification(item.verification_status) + '</td><td class="small">' + (item.last_verified_at ? shortDate(item.last_verified_at) : '—') + '</td></tr>').join('') : '<tr><td colspan="6">' + emptyBlock('还没有知识。') + '</td></tr>') + '</tbody></table></div>';
  } else if (tab === 'files') {
    $('#content').innerHTML += '<div class="split"><div class="card"><h3>文件</h3><div class="table-wrap"><table class="table"><thead><tr><th>名称</th><th>类型</th><th class="num">大小</th><th>来源</th><th></th></tr></thead><tbody>' + ((project.files || []).length ? project.files.map(file => '<tr><td><b>' + esc(file.name) + '</b><div class="tiny muted mono">' + esc(file.sha256 || '').slice(0,16) + '…</div></td><td class="small">' + esc(file.mime) + '</td><td class="num">' + (file.size > 1024*1024 ? (file.size/1024/1024).toFixed(1) + ' MB' : Math.round(file.size/1024) + ' KB') + '</td><td class="small">' + esc(file.source || '—') + '</td><td class="num"><div class="btn-row"><a class="btn sm" href="/api/opc/files/' + esc(file.id) + '/download?projectId=' + esc(project.id) + '&inline=1" target="_blank">预览</a><a class="btn sm" href="/api/opc/files/' + esc(file.id) + '/download?projectId=' + esc(project.id) + '" target="_blank">下载</a></div></td></tr>').join('') : '<tr><td colspan="5">' + emptyBlock('还没有文件。') + '</td></tr>') + '</tbody></table></div></div>' +
      '<div class="card"><h3>上传文件</h3><form data-form="upload-file" data-project="' + esc(project.id) + '" class="form"><div class="field"><label>选择文件</label><input class="input" type="file" name="file" required><span class="help">最大 25 MB；文本、CSV、图片、PDF 等均可。附件不作为静态资源公开。</span></div><button class="btn primary" type="submit">上传并登记</button></form></div></div>';
  } else if (tab === 'import') {
    $('#content').innerHTML += '<div class="card"><h3>导入 CSV / Excel 推广报表</h3><p class="hint">预览列、映射字段、识别零分母/日期错误/非数字/重复行；提交后生成报表与行级错误。原始文件按校验值去重。</p><form data-form="import-preview" data-project="' + esc(project.id) + '" class="form"><div class="form-row"><div class="field"><label>报表文件</label><input class="input" type="file" name="file" accept=".csv,.xlsx,.xls" required><span class="help">支持中文表头；推荐列：日期、曝光、点击、成交单量、归因销售额、推广费用、访客数</span></div>' + field('报表名称（可选）','name','近 7 日推广报表','text','留空自动生成') + '</div><div class="btn-row"><button class="btn primary" type="submit">预览</button><a class="btn" href="/api/opc/files/file-demo-report" hidden>下载样例</a></div></form><div id="import-preview"></div></div>';
  } else if (tab === 'artifacts') {
    $('#content').innerHTML += '<div class="table-wrap"><table class="table"><thead><tr><th>产物</th><th>类型</th><th class="num">版本</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>' + (project.artifacts.length ? project.artifacts.map(item => '<tr><td><b>' + esc(item.title) + '</b></td><td>' + esc(item.kind) + '</td><td class="num">v' + item.version + '</td><td>' + badge(item.status) + '</td><td class="small">' + shortDate(item.created_at) + '</td><td class="num"><button class="btn sm" data-act="open-artifact" data-id="' + esc(item.id) + '">查看</button><button class="btn sm" data-act="artifact-versions" data-id="' + esc(item.id) + '">版本</button></td></tr>').join('') : '<tr><td colspan="6">' + emptyBlock('还没有产物。') + '</td></tr>') + '</tbody></table></div>';
  }
}

function connectionCard(item) {
  const config = item.config || {};
  const address = config.url ?? config.baseUrl;
  const field = config.url !== undefined ? 'url' : 'baseUrl';
  const checks = item.lastReceipt && item.lastReceipt.checks || [];
  const tests = item.id === 'conn-pdd-orders'
    ? [{key:'order_query',label:'订单查询'}, {key:'customer_receive',label:'客服接收'}, {key:'customer_send',label:'客服发送授权'}]
    : [];
  return '<div class="card"><div class="between"><div><h3 style="margin:0">' + esc(item.name) + '</h3><div class="tiny muted">' + esc(item.kind) + ' · ' + esc(item.id) + '</div></div>' + badge(item.status) + '</div>' +
    '<div class="small muted" style="margin-top:8px">' + esc(item.last_test_detail || '尚未测试') + '</div>' +
    '<div class="tiny muted" style="margin-top:4px">上次测试：' + (item.last_test_at ? shortDate(item.last_test_at) : '—') + '</div>' +
    (address !== undefined ? '<div class="field" style="margin-top:8px"><label>' + (item.id === 'conn-mcp' ? 'MCP 服务地址' : '接口地址') + '</label><input class="input" data-conn-field="' + field + '" data-conn-url="' + esc(item.id) + '" value="' + esc(address) + '"></div>' : '') +
    (config.path ? '<div class="tiny muted mono">' + esc(config.path) + '</div>' : '') +
    ((config.secretNames || []).length ? '<div class="tiny muted" style="margin-top:6px">配置项：' + config.secretNames.map(esc).join('、') + '</div>' : '') +
    '<div class="btn-row" style="margin-top:10px"><button class="btn sm primary" data-act="test-connection" data-id="' + esc(item.id) + '">' + (item.id === 'conn-pdd-write' ? '核验测试店铺授权' : tests.length ? '分项核验' : '测试') + '</button>' +
    (address !== undefined ? '<button class="btn sm" data-act="save-connection" data-id="' + esc(item.id) + '">保存地址</button>' : '') + '<button class="btn sm ' + (item.enabled ? 'danger' : '') + '" data-act="toggle-connection" data-id="' + esc(item.id) + '">' + (item.enabled ? '停用' : '启用') + '</button></div>' +
    (tests.length ? '<div class="btn-row" style="margin-top:6px">' + tests.map(test => '<button class="btn sm" data-act="test-connection" data-id="' + esc(item.id) + '" data-capability="' + test.key + '">' + test.label + '</button>').join('') + '</div>' : '') +
    (checks.length ? '<div style="margin-top:8px">' + checks.map(check => '<div class="tiny" style="margin-top:5px">' + esc(check.label) + ' ' + badge(check.status) + '<div class="muted">' + esc((check.missing || []).join('、')) + '</div></div>').join('') + '</div>' : '') +
    (item.lastReceipt ? '<details style="margin-top:8px"><summary class="tiny muted">上次回执</summary><pre class="code" style="max-height:160px;margin-top:6px">' + esc(JSON.stringify(item.lastReceipt, null, 2)) + '</pre></details>' : '') + '</div>';
}

async function renderSettings() {
  const [connections, models, skills, health] = await Promise.all([api('/connections'), api('/models'), api('/skills'), api('/health')]);
  const gaps = connections.connections.filter(item => ['permission_denied','failed','not_configured'].includes(item.status) && item.enabled);
  $('#content').innerHTML = '<div class="page-head"><div><h2>接入设置</h2><p>每项连接都能配置、测试、查看上次结果与停用。秘密只从服务端环境或 macOS 钥匙串读取，界面与日志不显示密钥。</p></div><div class="actions"><button class="btn" data-act="refresh">刷新状态</button></div></div>' +
    (gaps.length ? '<div class="notice warn" style="margin-bottom:12px"><b>待处理的授权缺项：</b>' + gaps.map(item => esc(item.name) + '（' + esc(item.status) + '）').join(' · ') + '</div>' : '<div class="notice ok" style="margin-bottom:12px">当前没有待处理连接缺项。</div>') +
    '<div class="grid g3">' + connections.connections.map(connectionCard).join('') + '</div>' +
    '<div class="card" style="margin-top:14px"><h3>模型</h3><div class="table-wrap"><table class="table"><thead><tr><th>模型</th><th>提供方</th><th>地址 / 模型标识</th><th>启用</th><th>上次测试</th><th></th></tr></thead><tbody>' + models.models.map(model => '<tr><td><b>' + esc(model.name) + '</b><div class="tiny muted">' + esc(model.id) + '</div></td><td>' + esc(model.provider) + '</td><td class="small mono">' + esc(model.base_url || '—') + '<br>' + esc(model.model) + '</td><td>' + (model.enabled ? badge('success','启用') : badge('draft','停用')) + (model.is_default ? ' <span class="pill">默认</span>' : '') + '</td><td class="small">' + (model.last_test_detail ? esc(model.last_test_detail) : '尚未测试') + '</td><td class="num"><button class="btn sm" data-act="test-model" data-id="' + esc(model.id) + '">测试</button><button class="btn sm" data-act="set-model" data-id="' + esc(model.id) + '">设为默认</button></td></tr>').join('') + '</tbody></table></div></div>' +
    '<div class="card" style="margin-top:14px"><div class="between"><h3>Skill 登记与安装</h3><span class="small muted">83 条初始绑定 + 原站补充项 + 工作台内置岗位流程</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Skill</th><th>版本</th><th>来源</th><th>安装状态</th><th>绑定的员工</th><th></th></tr></thead><tbody>' + skills.skills.map(skill => '<tr><td><b>' + esc(skill.name || skill.slug) + '</b><div class="tiny muted">' + esc(skill.slug) + '</div></td><td>' + esc(skill.version || '—') + '</td><td class="small">' + esc(skill.source || skill.origin || '—') + '</td><td>' + badge(skill.install_status) + (skill.last_trial_status ? '<div class="tiny muted">核验：' + esc(skill.last_trial_status) + '</div>' : '') + '</td><td class="small">' + (skill.boundEmployees || []).map(item => esc(item.name)).join('、') + '</td><td class="num">' + (skill.package_path ? '<button class="btn sm" data-act="verify-skill" data-id="' + esc(skill.slug) + '">核验</button>' : '<span class="tiny muted">仅名录</span>') + '</td></tr>').join('') + '</tbody></table></div></div>' +
    '<div class="split" style="margin-top:14px"><div class="card"><h3>本机运行与数据</h3><div class="kv"><span class="k">版本</span><span class="v">v' + esc(health.version) + '</span><span class="k">数据库</span><span class="v">SQLite · ' + esc(health.database) + '</span><span class="k">文件存储</span><span class="v">' + (health.files ? '可写' : '不可写') + '</span><span class="k">执行器</span><span class="v">' + (health.worker ? '运行中' : '未启动') + '</span><span class="k">计数</span><span class="v">' + JSON.stringify(health.counts) + '</span></div><div class="divider"></div><div class="small muted">备份：<span class="mono">node opc/cli.js backup &lt;目录&gt;</span><br>恢复：<span class="mono">node opc/cli.js restore &lt;备份&gt; --data-dir &lt;新目录&gt;</span></div></div>' +
    '<div class="card"><h3>授权与安全</h3><div class="small muted">密钥只从服务端环境或 macOS 钥匙串读取；界面只显示参数名。审批绑定内容版本，修改草稿会失效。外部写入未获授权时动作停在“等待授权”，不会伪造成功。</div><div class="divider"></div><div class="small muted">环境变量名：LLM_BASE_URL、LLM_API_KEY、LLM_MODEL、ALI_1688_AK、TAVILY_API_KEY、ECOMMERCE_PDD_CLIENT_ID、ECOMMERCE_PDD_CLIENT_SECRET、ECOMMERCE_PDD_PID、IMAGE_BASE_URL、IMAGE_API_KEY、IMAGE_MODEL、MCP_ACCESS_TOKEN。</div></div></div>';
}

function runDetailHtml(run) {
  const output = run.output && run.output.output;
  const meta = output && output._meta;
  const steps = run.steps || [];
  const current = steps.find(item => item.status === 'running') || steps.find(item => item.status === 'failed');
  const artifacts = run.artifacts || [];
  const receipts = run.receipts || [];
  const actions = run.actions || [];
  const images = artifacts.filter(item => item.kind === 'image');
  const terminal = ['success','failed','cancelled','paused','needs_info','awaiting_authorization'].includes(run.status);
  return '<div class="run-banner"><div class="grow"><div class="row"><b>' + esc(run.employee && run.employee.name || '系统任务') + '</b>' + badge(run.status) + '<span class="small muted">' + esc(run.id) + '</span></div><div class="small muted" style="margin-top:3px">' + esc(run.project && run.project.name || '') + ' · ' + esc(run.steps && run.steps[0] ? '固定心智 v' + (run.mind_version || '') : '') + ' · 模型 ' + esc(run.provider_model || run.model_id || '—') + '</div>' +
    (run.status === 'running' ? '<div class="small" style="margin-top:5px"><span class="spinner"></span> 当前处理：' + esc(current && current.name || '准备中') + '</div>' : '') +
    (run.error_message ? '<div class="notice bad" style="margin-top:8px"><b>' + esc(run.error_code || '失败') + '：</b>' + esc(run.error_message) + '</div>' : '') + '</div>' +
    (!terminal ? '<button class="btn sm danger" data-act="cancel-run" data-id="' + esc(run.id) + '">取消</button>' : '') +
    '<button class="btn sm" data-act="retry-run" data-id="' + esc(run.id) + '">重试</button></div>' +
    '<div class="grid g4">' + statCard('Token 用量', num((run.tokens_in || 0) + (run.tokens_out || 0)), '输入 ' + num(run.tokens_in) + ' / 输出 ' + num(run.tokens_out)) + statCard('首字耗时', run.first_token_ms !== null && run.first_token_ms !== undefined ? run.first_token_ms + ' ms' : '—', '提供方返回') + statCard('整轮耗时', run.duration_ms ? (run.duration_ms/1000).toFixed(1) + ' 秒' : '—', '含工具与校验') + statCard('工具调用', num(run.tool_calls), '每次调用均有回执') + '</div>' +
    '<div class="card" style="margin-top:12px"><h3>执行步骤</h3><div class="steps">' + steps.map(step => '<div class="step ' + esc(step.status) + '"><div class="dot">' + (step.status === 'success' ? '✓' : step.status === 'failed' ? '!' : step.status === 'running' ? '…' : step.seq) + '</div><div class="body"><div class="t">' + esc(step.name) + ' ' + badge(step.status) + '</div><div class="s">' + esc(step.error || '') + '</div></div></div>').join('') + '</div></div>' +
    '<div class="grid g2" style="margin-top:12px"><div class="card"><h3>产物</h3>' + (artifacts.length ? '<div class="list">' + artifacts.map(item => '<div class="list-item">' + (item.kind === 'image' ? '<img src="/api/opc/artifacts/' + esc(item.id) + '/download?inline=1" alt="" style="width:44px;height:44px;border-radius:7px;object-fit:cover">' : '<div class="avatar" style="background:#eef2ff;color:#2f5bea;font-size:12px">' + esc((item.kind || 'f').slice(0,1).toUpperCase()) + '</div>') + '<div class="grow"><div class="t">' + esc(item.title) + '</div><div class="s">v' + item.version + ' · ' + esc(item.status) + '</div></div><a class="btn sm" href="/api/opc/artifacts/' + esc(item.id) + '/download">下载</a></div>').join('') + '</div>' : '<div class="empty">还没有产物；运行成功后写入。</div>') + '</div>' +
    '<div class="card"><h3>工具回执</h3>' + (receipts.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>工具</th><th>状态</th><th>环境</th><th>回执编号</th><th class="num">耗时</th></tr></thead><tbody>' + receipts.map(item => '<tr><td class="mono">' + esc(item.tool_key) + '<div class="tiny muted">' + esc(item.error || '') + '</div></td><td>' + badge(item.status) + '</td><td class="small">' + esc(item.environment) + '</td><td class="small mono">' + esc(item.receipt_id || '—') + '</td><td class="num">' + (item.duration_ms || '—') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">没有工具回执。</div>') + '</div></div>' +
    (images.length ? '<div class="card" style="margin-top:12px"><h3>成图</h3><div class="image-grid">' + images.map(item => '<div class="image-card"><img src="/api/opc/artifacts/' + esc(item.id) + '/download?inline=1" alt="' + esc(item.title) + '"><div class="cap"><span>' + esc(item.title.slice(-12)) + '</span><span class="badge b-' + esc(item.status) + '">' + esc(item.status) + '</span></div></div>').join('') + '</div><div class="tiny muted" style="margin-top:6px">历史运行图片保留其原始来源与回执。当前美工交付五张主图与详情逐屏提示词，状态为 prompt_only。</div></div>' : '') +
    (actions.length ? '<div class="card" style="margin-top:12px"><h3>本次产生的待审动作</h3><div class="list">' + actions.map(item => '<div class="list-item"><div class="grow"><div class="t">' + esc(item.title) + '</div><div class="s">' + esc(item.kind) + ' · ' + esc(item.status) + '</div></div>' + badge(item.status) + '<button class="btn sm" data-act="view-action" data-id="' + esc(item.id) + '">详情</button></div>').join('') + '</div></div>' : '') +
    (output ? '<div class="card" style="margin-top:12px"><h3>结构化结果</h3><div class="small muted">归一化：' + (meta && meta.normalized ? '已补足' : '模型原始结构完整') + (meta && meta.groundingOverrides ? ' · 确定性覆盖：' + esc(meta.groundingOverrides.join('、')) : '') + '</div><details style="margin-top:8px"><summary class="small">展开 JSON</summary><pre class="code" style="max-height:420px">' + esc(JSON.stringify(output, null, 2)) + '</pre></details></div>' : '') +
    (run.raw_model_output && !output ? '<div class="card" style="margin-top:12px"><h3>原始模型输出（失败保留）</h3><pre class="code">' + esc(run.raw_model_output.slice(0, 8000)) + '</pre></div>' : '');
}

function clearRunWatch() {
  if (state.runTimer) clearInterval(state.runTimer);
  state.runTimer = null;
  if (state.eventSource) { try { state.eventSource.close(); } catch {} }
  state.eventSource = null;
}

async function watchRun(runId, selector) {
  clearRunWatch();
  const tick = async () => {
    try {
      const data = await api('/runs/' + encodeURIComponent(runId));
      const target = $(selector);
      if (target) target.innerHTML = runDetailHtml(data.run);
      if (['success','failed','cancelled','paused','needs_info','awaiting_authorization'].includes(data.run.status)) {
        clearRunWatch();
        if (state.boot && state.boot.employees) {
          api('/employees').then(result => { if (state.boot) state.boot.employees = result.employees; }).catch(() => {});
        }
      }
    } catch (error) {
      const target = $(selector);
      if (target) target.innerHTML = '<div class="notice bad">读取运行失败：' + esc(error.message) + '</div>';
    }
  };
  await tick();
  state.runTimer = setInterval(tick, 1600);
  try {
    const source = new EventSource('/api/opc/runs/' + encodeURIComponent(runId) + '/events');
    ['step_started','step_finished','step_failed','tool_receipt','model_section','finished','failed','lease_recovered'].forEach(name => source.addEventListener(name, () => tick()));
    source.addEventListener('done', () => { tick(); try { source.close(); } catch {} });
    state.eventSource = source;
  } catch {}
}

async function openRun(runId) {
  openModal({title:'运行详情', body:'<div id="run-live">' + loadingHtml('正在读取运行…') + '</div>', wide:true, footer:'<button class="btn" data-modal-close>关闭</button>'});
  await watchRun(runId, '#run-live');
}

async function renderRunPage() {
  const data = await api('/runs/' + encodeURIComponent(state.runId));
  $('#content').innerHTML = '<div class="page-head"><div><h2>运行详情</h2><p>' + esc(data.run.id) + '</p></div><div class="actions"><button class="btn" data-go="#/dashboard">返回总览</button></div></div><div id="run-live">' + runDetailHtml(data.run) + '</div>';
  await watchRun(state.runId, '#run-live');
}

async function openArtifact(id) {
  const data = await api('/artifacts/' + encodeURIComponent(id));
  const artifact = data.artifact;
  let body;
  if (artifact.kind === 'image' || String(artifact.content_type || '').startsWith('image/')) {
    body = '<img src="/api/opc/artifacts/' + esc(id) + '/download?inline=1" style="max-width:100%;border-radius:10px;border:1px solid #e4e7ec" alt=""><div class="small muted" style="margin-top:8px">' + esc(artifact.title) + ' · v' + artifact.version + ' · ' + esc(artifact.status) + '</div>' + (data.file ? '<div class="tiny muted">' + esc(data.file.mime) + ' · ' + data.file.size + ' B · SHA-256 ' + esc(data.file.sha256 || '').slice(0,16) + '…</div>' : '');
  } else {
    body = '<div class="row small muted" style="margin-bottom:8px"><span>' + esc(artifact.kind) + ' · v' + artifact.version + ' · ' + esc(artifact.status) + '</span></div><pre class="code" style="max-height:55vh">' + esc(artifact.content || '（该产物仅含文件，请下载查看）') + '</pre>';
  }
  openModal({title:artifact.title, body, wide:true, footer:'<button class="btn" data-act="artifact-versions" data-id="' + esc(id) + '">版本历史</button><a class="btn primary" href="/api/opc/artifacts/' + esc(id) + '/download">下载</a><button class="btn" data-modal-close>关闭</button>'});
}

async function openArtifactVersions(id) {
  const data = await api('/artifacts/' + encodeURIComponent(id) + '/versions');
  openModal({title:'产物版本', body:'<div class="table-wrap"><table class="table"><thead><tr><th>版本</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>' + data.versions.map(item => '<tr><td>v' + item.version + '</td><td>' + badge(item.status) + '</td><td class="small">' + shortDate(item.created_at) + '</td><td class="num"><button class="btn sm" data-act="open-artifact" data-id="' + esc(item.id) + '">查看</button></td></tr>').join('') + '</tbody></table></div>', footer:'<button class="btn" data-modal-close>关闭</button>'});
}

async function openTicket(id) {
  const data = await api('/tickets/' + encodeURIComponent(id));
  const ticket = data.ticket;
  openModal({title:'工单 · ' + esc(ticket.type), wide:true, body:'<div class="grid g4">' + statCard('状态', ticket.status, ticket.id) + statCard('严重度', ticket.severity || '—', '售后分级') + statCard('情绪', ticket.emotion || '—', '顾客情绪') + statCard('订单', ticket.order_ref || '—', '订单引用') + '</div>' +
    '<div class="card" style="margin-top:12px"><h3>原始问题</h3><div class="notice">' + esc(ticket.original_message) + '</div><div class="small muted" style="margin-top:8px">证据</div><pre class="code" style="max-height:120px">' + esc(JSON.stringify(ticket.evidence, null, 2)) + '</pre><div class="small muted">待确认</div><pre class="code" style="max-height:100px">' + esc(JSON.stringify(ticket.pendingFacts, null, 2)) + '</pre></div>' +
    '<form data-form="ticket-draft" data-id="' + esc(ticket.id) + '" class="form" style="margin-top:12px">' + textarea('回复草稿（不会发送）','replyDraft',ticket.reply_draft || '','保存仅写入草稿；发送需另建待审动作并取得渠道回执',5) + '<div class="btn-row"><button class="btn primary" type="submit">保存草稿</button><button class="btn" type="button" data-act="copy-reply" data-id="' + esc(ticket.id) + '">复制回复</button></div></form>', footer:'<button class="btn" data-modal-close>关闭</button>'});
}

function actionModal(action, decision) {
  const labels = {approve:'批准', reject:'拒绝', return:'退回修改'};
  openModal({title:labels[decision] + '动作', body:'<div class="notice ' + (decision === 'approve' ? 'warn' : '') + '"><b>' + esc(action.title) + '</b><br>类型：' + esc(action.kind) + ' · 版本 v' + action.version + ' · 金额 ' + (Number.isInteger(action.amount_cents) ? money(action.amount_cents) + ' 元' : '—') + '<br>业务影响：' + esc(action.business_impact || '—') + '<br>有效期：' + shortDate(action.expires_at) + '</div><div class="small muted" style="margin-top:8px">审批绑定当前内容版本。修改草稿后本审批失效。' + (decision === 'approve' ? '外部写入未授权时会停在“等待授权”，不会显示成功。' : '') + '</div><form data-form="decision-action" data-id="' + esc(action.id) + '" data-decision="' + esc(decision) + '" class="form" style="margin-top:12px">' + textarea('审批备注','note','','可写依据、限制或拒绝原因',3) + '<div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn ' + (decision === 'approve' ? 'primary' : 'danger') + '" type="submit">' + labels[decision] + '</button></div></form>'});
}

function importPreviewHtml(data) {
  const fields = [['date','日期'],['impressions','曝光'],['clicks','点击'],['orders','成交单量'],['revenue','归因销售额'],['ad_spend','推广费用'],['visitors','访客'],['plan','计划'],['channel','渠道']];
  const mapping = data.mapping || {};
  const options = (selected) => '<option value="">不映射</option>' + (data.headers || []).map((header, index) => '<option value="' + index + '"' + (String(selected) === String(index) ? ' selected' : '') + '>' + esc(header || ('第 ' + (index+1) + ' 列')) + '</option>').join('');
  return '<div class="card" style="margin-top:14px"><div class="between"><div><h3>预览与字段映射</h3><p class="hint">共 ' + data.totals.rows + ' 行，有效 ' + data.totals.valid + ' 行，需修复 ' + data.totals.invalid + ' 行，重复 ' + data.totals.duplicates + ' 行</p></div><button class="btn sm" data-act="refresh-import">重新选择文件</button></div>' +
    '<div class="grid g3">' + fields.map(([key,label]) => '<div class="field"><label>' + label + '</label><select class="input" data-map="' + key + '">' + options(mapping[key]) + '</select></div>').join('') + '</div>' +
    '<div class="table-wrap" style="margin-top:12px"><table class="table"><thead><tr><th>行</th><th>日期</th><th class="num">曝光</th><th class="num">点击</th><th class="num">成交</th><th class="num">销售额</th><th class="num">推广费</th><th class="num">访客</th><th>状态 / 错误</th></tr></thead><tbody>' + data.rows.map(row => '<tr' + (row.errors && row.errors.length ? ' style="background:#fffbfa"' : '') + '><td class="num">' + row.rowNo + '</td><td>' + esc(row.date || '—') + '</td><td class="num">' + num(row.impressions) + '</td><td class="num">' + num(row.clicks) + '</td><td class="num">' + num(row.orders) + '</td><td class="num">' + money(row.revenueCents) + '</td><td class="num">' + money(row.adSpendCents) + '</td><td class="num">' + num(row.visitors) + '</td><td>' + (row.status === 'invalid' ? '<span class="badge b-failed">' + esc((row.errors || []).join('；')) + '</span>' : row.status === 'duplicate' ? '<span class="badge b-draft">重复，已归并</span>' : '<span class="badge b-success">通过</span>') + '</td></tr>').join('') + '</tbody></table></div>' +
    '<div class="btn-row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-act="commit-import">提交导入（仅有效行）</button></div></div>';
}

async function runEmployeeForm(form) {
  const data = Object.fromEntries(new FormData(form));
  const slug = form.dataset.slug;
  let attachmentIds = [];
  const fileInput = form.querySelector('input[type=file]');
  if (fileInput && fileInput.files && fileInput.files[0]) {
    const uploaded = await uploadFile(fileInput.files[0], data.projectId, data.skuId);
    attachmentIds = [uploaded.id];
  }
  const response = await api('/runs', {method:'POST', body:{projectId:data.projectId, employeeSlug:slug, skuId:data.skuId || undefined,
    input:{task:data.task, note:'', attachmentIds}, dedupeKey:data.requestId}});
  toast(response.deduplicated ? '相同请求号已存在，返回原运行' : '任务已进入持久队列', 'ok');
  const requestField = form.querySelector('input[name="requestId"]');
  if (requestField) requestField.value = String(Date.now()) + '-' + Math.random().toString(36).slice(2,8);
  await openRun(response.run.id);
}

async function commitImport(projectId) {
  if (!state.importing) throw new Error('请先预览报表');
  const mapping = {};
  $$('[data-map]').forEach(node => { if (node.value !== '') mapping[node.dataset.map] = Number(node.value); });
  const data = await api('/imports/commit', {method:'POST', body:{projectId, fileId:state.importing.fileId, mapping, name:state.importing.name || ''}});
  state.importing = null;
  toast(data.duplicate ? '该文件已导入过，返回原报表' : '报表已导入，指标已计算', 'ok');
  go('#/projects/' + projectId + '?tab=reports');
}

async function onGlobalClick(event) {
  const close = event.target.closest('[data-modal-close]');
  if (close) { event.preventDefault(); closeModal(); return; }
  const goNode = event.target.closest('[data-go]');
  if (goNode) { event.preventDefault(); go(goNode.dataset.go); return; }
  const node = event.target.closest('[data-act]');
  if (!node) return;
  const act = node.dataset.act;
  const id = node.dataset.id;
  try {
    if (act === 'refresh') return route();
    if (act === 'reload') { location.reload(); return; }
    if (act === 'new-project') { openModal({title:'新建项目', body:projectForm(), wide:true, footer:'<button class="btn" data-modal-close>取消</button><button class="btn primary" type="button" data-act="submit-project-form">创建</button>'}); return; }
    if (act === 'submit-project-form') { const form = $('#modal form'); if (form) form.requestSubmit(); return; }
    if (act === 'continue-project') return go('#/projects/' + id);
    if (act === 'project-tab') return go('#/projects/' + state.projectId + '?tab=' + node.dataset.tab);
    if (act === 'employee-tab') { const params = new URLSearchParams(location.hash.split('?')[1] || ''); params.set('tab', node.dataset.tab); return go('#/employees/' + id + '?' + params.toString()); }
    if (act === 'approval-tab') return go('#/approvals?tab=' + node.dataset.tab);
    if (act === 'knowledge-tab') { const project = (state.currentProject && state.currentProject.id) || state.filters.knowledgeProject || ''; return go('#/knowledge?tab=' + node.dataset.tab + (project ? '&project=' + encodeURIComponent(project) : '')); }
    if (act === 'create-workflow') { const result = await api('/workflows', {method:'POST', body:{projectId:id, type:node.dataset.type}}); toast('已创建 ' + node.dataset.type + ' 型流程', 'ok'); return go('#/workflows/' + result.workflow.id); }
    if (act === 'workflow-step' || act === 'workflow-step-force') return await startWorkflowStep(node.dataset.wf, node.dataset.step, act === 'workflow-step-force' || node.dataset.force === '1');
    if (act === 'workflow-note') {
      const detail = await api('/workflows/' + node.dataset.wf);
      const step = detail.workflow.steps.find(item => item.key === node.dataset.step);
      return openModal({title:'补资料 / 步骤备注', body:'<div class="notice">补资料不会清空已完成产物；保存后步骤标为待资料，可重新运行。资料请写进项目知识或 SKU 事实，避免只留在备注里。</div><form data-form="workflow-note" data-wf="' + esc(node.dataset.wf) + '" data-step="' + esc(node.dataset.step) + '" class="form">' + textarea('备注与待补资料','note', step && step.note || '','写清缺什么、从哪里补、补齐后谁继续',4) + '<div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn primary" type="submit">保存并标为待资料</button></div></form>', slim:true});
    }
    if (act === 'employee-model') {
      const employee = state.boot.employees.find(item => item.slug === id);
      const models = state.boot.models || [];
      return openModal({title:'切换模型 · ' + (employee ? employee.name : id), body:'<div class="notice">每名员工可单独选择模型；未设时继承工作台默认。切换只影响新运行，旧运行保留原模型记录。</div><form data-form="employee-model" data-slug="' + esc(id) + '" class="form">' + selectField('模型','modelId', models.map(item => ({value:item.id,label:item.name + ' · ' + item.model + (item.enabled ? '' : '（停用）')})), employee && employee.model_id || '') + '<div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn primary" type="submit">保存</button></div></form>', slim:true});
    }
    if (act === 'pause-workflow') { await api('/workflows/' + id + '/pause', {method:'POST'}); toast('流程已暂停'); return route(); }
    if (act === 'open-run') return openRun(id);
    if (act === 'retry-run') { const result = await api('/runs/' + id + '/retry', {method:'POST', body:{}}); toast('已从允许重试的节点继续', 'ok'); return openRun(result.run.id); }
    if (act === 'cancel-run') { const result = await api('/runs/' + id + '/cancel', {method:'POST'}); toast('已取消未提交的任务'); return openRun(result.run.id); }
    if (act === 'open-artifact') return openArtifact(id);
    if (act === 'artifact-versions') return openArtifactVersions(id);
    if (act === 'open-ticket') return openTicket(id);
    if (act === 'copy-reply') { const ticket = await api('/tickets/' + id); await navigator.clipboard.writeText(ticket.ticket.reply_draft || ''); toast('回复草稿已复制（未发送）', 'ok'); return; }
    if (act === 'add-sku') return addSkuModal(id);
    if (act === 'edit-sku') return editSkuModal(id);
    if (act === 'add-knowledge') return addKnowledgeModal(id);
    if (act === 'decide-action') return actionModal((await api('/actions')).actions.find(item => item.id === id), node.dataset.decision);
    if (act === 'view-action') {
      const action = (await api('/actions')).actions.find(item => item.id === id);
      const detail = '<div class="kv"><span class="k">动作</span><span class="v">' + esc(action.title) + '</span><span class="k">提交人</span><span class="v">' + esc(action.submitter || '系统/经营者') + '</span><span class="k">状态</span><span class="v">' + badge(action.status) + '</span><span class="k">版本 / 金额</span><span class="v">v' + action.version + ' · ' + (Number.isInteger(action.amount_cents) ? money(action.amount_cents) : '—') + '</span><span class="k">有效期</span><span class="v">' + shortDate(action.expires_at) + '</span><span class="k">业务影响</span><span class="v">' + esc(action.business_impact || '见下方依据与载荷') + '</span></div>' +
        '<h4>依据 / 证据</h4><pre class="code">' + esc(JSON.stringify(action.evidence || {}, null, 2)) + '</pre>' +
        '<h4>载荷</h4><pre class="code">' + esc(JSON.stringify(action.payload || {}, null, 2)) + '</pre>' +
        '<h4>执行回执</h4><pre class="code">' + esc(JSON.stringify(action.receipt || {}, null, 2)) + '</pre>';
      return openModal({title:'动作详情', body:detail, wide:true, footer:'<button class="btn" data-modal-close>关闭</button>'});
    }
    if (act === 'revise-action') { const action = (await api('/actions')).actions.find(item => item.id === id); return openModal({title:'修改动作草稿', body:'<div class="notice warn">保存后旧审批失效，新版本需要重新审批。</div><form data-form="revise-action" data-id="' + esc(id) + '" class="form"><div class="field"><label>动作内容（JSON）</label><textarea class="input" name="payload" rows="12">' + esc(JSON.stringify(action.payload, null, 2)) + '</textarea></div><div class="field"><label>修改说明</label><input class="input" name="note" value=""></div><div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn primary" type="submit">保存新版本</button></div></form>', wide:true}); }
    if (act === 'test-connection') { const label = node.textContent; node.disabled = true; node.textContent = '测试中…'; try { const result = await api('/connections/' + id + '/test', {method:'POST', body:{capability:node.dataset.capability || null}}); toast((result.ok ? '测试通过：' : '测试未通过：') + (result.result && result.result.detail || ''), result.ok ? 'ok' : 'error'); } finally { node.disabled = false; node.textContent = label; } return route(); }
    if (act === 'save-connection') { const input = $('[data-conn-url="' + id + '"]'); const result = await api('/connections/' + id, {method:'PATCH', body:input ? {[input.dataset.connField || 'url']:input.value} : {}}); toast('地址已保存，请重新测试', 'ok'); return route(); }
    if (act === 'toggle-connection') { const current = (await api('/connections')).connections.find(item => item.id === id); await api('/connections/' + id, {method:'PATCH', body:{enabled:!current.enabled}}); toast(current.enabled ? '已停用' : '已启用'); return route(); }
    if (act === 'test-model') { const result = await api('/models/' + id + '/test', {method:'POST'}); toast((result.ok ? '模型可用：' : '模型不可用：') + (result.result && result.result.detail || ''), result.ok ? 'ok' : 'error'); return route(); }
    if (act === 'set-model') { await api('/models/' + id, {method:'PATCH', body:{is_default:true}}); toast('已设为默认模型', 'ok'); return route(); }
    if (act === 'verify-skill') { const result = await api('/skills/' + encodeURIComponent(id) + '/verify', {method:'POST'}); toast(result.ok ? 'Skill 文件核验通过' : 'Skill 核验：' + result.message + '（' + result.status + '）', result.ok ? 'ok' : 'error'); return route(); }
    if (act === 'refresh-import') { state.importing = null; const el = $('#import-preview'); if (el) el.innerHTML = ''; return; }
    if (act === 'commit-import') return await commitImport(state.currentProject.id);
  } catch (error) { toast(error.message, 'error'); }
}

async function startWorkflowStep(workflowId, key, force = false) {
  const detail = await api('/workflows/' + workflowId);
  const step = detail.workflow.steps.find(item => item.key === key);
  if (key === 'confirm_sku') {
    const project = state.projects.find(item => item.id === detail.workflow.project_id);
    const skus = project && project.skus || [];
    openModal({title:'选择主推 SKU', body:'<div class="notice">确认后生成正式商品档案，并把选择结果交给文案与美工。</div><form data-form="workflow-confirm-sku" data-wf="' + esc(workflowId) + '" class="form"><div class="field"><label>主推 SKU</label><select class="input" name="skuId">' + skus.map(item => '<option value="' + esc(item.id) + '">' + esc(item.name) + ' · ' + money(item.price_cents) + ' 元</option>').join('') + '</select></div><button class="btn primary" type="submit">确认主推 SKU</button></form>', slim:true});
    return;
  }
  if (key === 'review') return openModal({title:'确认复盘', body:'<form data-form="workflow-review" data-wf="' + esc(workflowId) + '" class="form"><div class="field"><label>决定</label><select class="input" name="decision"><option value="approve">确认复盘</option><option value="return">退回修改</option></select></div>' + textarea('备注','note','','写清确认范围或退回原因',3) + '<button class="btn primary" type="submit">提交</button></form>', slim:true});
  const result = await api('/workflows/' + workflowId + '/steps/' + key + '/run', {method:'POST', body:{skuId:(state.currentProject && state.currentProject.skus && state.currentProject.skus[0] || {}).id, force}});
  if (result.kind === 'run') { toast('步骤已进入执行队列', 'ok'); return openRun(result.runId); }
  if (result.kind === 'listing') { toast('上架资料包与发布待审动作已创建', 'ok'); return go('#/workflows/' + workflowId); }
  if (result.kind === 'approval') { toast(result.pendingActions.length ? '请处理待审动作' : '无需补偿动作'); return go('#/approvals'); }
  toast('步骤已完成'); return route();
}

function addSkuModal(projectId) {
  openModal({title:'新增 SKU', body:'<form data-form="add-sku" data-project="' + esc(projectId) + '" class="form"><div class="form-row">' + field('SKU 名称','name','标准款·黑色') + field('编码','code','STAND-STD-BLK') + '</div><div class="form-row g3">' + field('售价（元）','price','29.90','number') + field('进货（元）','cost','11.00','number') + field('快递/代发（元）','shipping','4.00','number') + '</div><div class="form-row g3">' + field('包材（元）','packaging','0.50','number') + field('平台费率（%）','feePercent','6','number') + field('退款损耗（元）','refund','0.60','number') + '</div><div class="form-row g3">' + field('单件广告（元）','ad','5.00','number') + field('库存（可空）','stock','','number') + field('规格说明','specs','黑色 / 可折叠 / 独立彩盒','text','可写 JSON 或文字') + '</div><div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn primary" type="submit">保存并核算</button></div></form>', wide:true});
}

function editSkuModal(skuId) {
  const project = state.currentProject;
  const sku = project && project.skus.find(item => item.id === skuId);
  if (!sku) { toast('SKU 未加载，请刷新项目', 'error'); return; }
  openModal({title:'编辑 SKU · ' + sku.name, body:'<form data-form="edit-sku" data-id="' + esc(skuId) + '" class="form"><div class="form-row">' + field('SKU 名称','name',sku.name) + field('编码','code',sku.code) + '</div><div class="form-row g3">' + field('售价（元）','price',money(sku.price_cents),'number') + field('进货（元）','cost',money(sku.cost_cents),'number') + field('快递/代发（元）','shipping',money(sku.shipping_cents),'number') + '</div><div class="form-row g3">' + field('包材（元）','packaging',money(sku.packaging_cents),'number') + field('平台费率（%）','feePercent',(sku.platform_fee_bps/100).toFixed(2),'number') + field('退款损耗（元）','refund',money(sku.refund_cents),'number') + '</div><div class="form-row g3">' + field('单件广告（元）','ad',money(sku.ad_cents),'number') + field('库存（可空）','stock',sku.stock === null ? '' : sku.stock,'number') + field('状态','status',sku.status,'text','draft/confirmed') + '</div><div class="small muted">修改后利润由服务端重新计算；旧产物仍在版本历史中。</div><div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn primary" type="submit">保存并重算</button></div></form>', wide:true});
}

function addKnowledgeModal(projectId) {
  openModal({title:'新增知识', body:'<form data-form="add-knowledge" data-project="' + esc(projectId) + '" class="form"><div class="form-row">' + selectField('类型','kind',['店铺政策','商品知识','FAQ','供应商报价','平台规则','检测材料','经营事实'].map(item => ({value:item,label:item})),'商品知识') + selectField('核验状态','verificationStatus',[{value:'pending',label:'待核验'},{value:'verified',label:'已核验'},{value:'synthetic',label:'合成演示'},{value:'historical',label:'历史回放'}],'pending') + '</div>' + field('标题','title','例如：材质与承重') + textarea('正文','body','写清已知事实、未知项与适用条件。','客服、文案、美工只能把已核验条目写成确定事实',5) + '<div class="form-row">' + field('来源','source','经营者录入') + field('来源链接','sourceUrl','') + '</div><div class="btn-row" style="justify-content:flex-end"><button type="button" class="btn" data-modal-close>取消</button><button class="btn primary" type="submit">保存知识</button></div></form>', wide:true});
}

async function onGlobalSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (kind === 'create-project') {
      const body = {name:data.name, platform:data.platform, category:data.category, audience:data.audience, priceMin:Number(data.priceMin), priceMax:Number(data.priceMax), budget:Number(data.budget), fulfillment:data.fulfillment, storeName:data.storeName, constraints:data.constraints, description:'由经营者创建的项目'};
      const result = await api('/projects', {method:'POST', body});
      closeModal(); toast('项目已创建', 'ok'); return go('#/projects/' + result.project.id);
    }
    if (kind === 'add-sku') {
      const body = {name:data.name, code:data.code, price:Number(data.price), cost:Number(data.cost), shipping:Number(data.shipping), packaging:Number(data.packaging), feeBps:Math.round(Number(data.feePercent) * 100), refund:Number(data.refund), ad:Number(data.ad), stock:data.stock === '' ? null : Number(data.stock), specs:{text:data.specs}};
      await api('/projects/' + form.dataset.project + '/skus', {method:'POST', body}); closeModal(); toast('SKU 已保存并核算', 'ok'); return route();
    }
    if (kind === 'edit-sku') {
      const body = {name:data.name, code:data.code, price:Number(data.price), cost:Number(data.cost), shipping:Number(data.shipping), packaging:Number(data.packaging), feeBps:Math.round(Number(data.feePercent) * 100), refund:Number(data.refund), ad:Number(data.ad), stock:data.stock === '' ? null : Number(data.stock), status:data.status};
      await api('/skus/' + form.dataset.id, {method:'PATCH', body}); closeModal(); toast('SKU 已更新，利润已重算', 'ok'); return route();
    }
    if (kind === 'add-knowledge') {
      const body = {kind:data.kind, title:data.title, body:data.body, source:data.source, sourceUrl:data.sourceUrl, verificationStatus:data.verificationStatus};
      await api('/projects/' + form.dataset.project + '/knowledge', {method:'POST', body}); closeModal(); toast('知识已保存', 'ok'); return route();
    }
    if (kind === 'save-mind') {
      await api('/employees/' + form.dataset.slug + '/minds', {method:'POST', body:{runtimeText:data.runtimeText}}); toast('已发布新的心智版本', 'ok'); return route();
    }
    if (kind === 'run-employee') { const button = form.querySelector('button[type=submit]'); if (button) { button.disabled = true; button.textContent = '提交中…'; } try { await runEmployeeForm(form); } finally { if (button) { button.disabled = false; button.textContent = '开始任务'; } } return; }
    if (kind === 'workflow-confirm-sku') { await api('/workflows/' + form.dataset.wf + '/steps/confirm_sku/run', {method:'POST', body:{skuId:data.skuId}}); closeModal(); toast('主推 SKU 已确认', 'ok'); return go('#/workflows/' + form.dataset.wf); }
    if (kind === 'workflow-review') { await api('/workflows/' + form.dataset.wf + '/steps/review/run', {method:'POST', body:{decision:data.decision, note:data.note}}); closeModal(); toast('复盘已记录', 'ok'); return go('#/workflows/' + form.dataset.wf); }
    if (kind === 'workflow-note') { await api('/workflows/' + form.dataset.wf + '/steps/' + form.dataset.step, {method:'PATCH', body:{note:data.note, status:'needs_info'}}); closeModal(); toast('已保存补资料备注', 'ok'); return go('#/workflows/' + form.dataset.wf); }
    if (kind === 'employee-model') { await api('/employees/' + form.dataset.slug, {method:'PATCH', body:{model_id:data.modelId}}); closeModal(); toast('模型已切换，新运行生效', 'ok'); return route(); }
    if (kind === 'decision-action') { const result = await api('/actions/' + form.dataset.id + '/decision', {method:'POST', body:{decision:form.dataset.decision, note:data.note}}); closeModal(); toast(result.duplicate ? '该审批已处理过，返回原回执' : (result.action.status === 'awaiting_authorization' ? '已批准，等待外部授权；未外发' : '审批已处理：' + result.action.status), result.action.status === 'executed' ? 'ok' : 'info'); return route(); }
    if (kind === 'revise-action') { const payload = JSON.parse(data.payload); await api('/actions/' + form.dataset.id + '/revise', {method:'POST', body:{payload, note:data.note}}); closeModal(); toast('已生成新版本，旧审批失效', 'ok'); return route(); }
    if (kind === 'ticket-draft') { await api('/tickets/' + form.dataset.id + '/draft', {method:'POST', body:{replyDraft:data.replyDraft}}); closeModal(); toast('草稿已保存，未发送', 'ok'); return route(); }
    if (kind === 'upload-file') { const file = form.querySelector('input[type=file]').files[0]; if (!file) throw new Error('请选择文件'); await uploadFile(file, form.dataset.project); toast('文件已上传并登记', 'ok'); return route(); }
    if (kind === 'import-preview') {
      const file = form.querySelector('input[type=file]').files[0]; if (!file) throw new Error('请选择 CSV 或 Excel 文件');
      const fd = new FormData(); fd.append('file', file); fd.append('projectId', form.dataset.project); fd.append('name', data.name || '');
      const response = await fetch('/api/opc/imports/preview', {method:'POST', headers:{'x-opc-csrf':state.session.csrf}, body:fd});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error && result.error.message || '预览失败');
      state.importing = {fileId:result.file.id, name:data.name || '', projectId:form.dataset.project};
      $('#import-preview').innerHTML = importPreviewHtml(result);
      return;
    }
  } catch (error) { toast(error.message, 'error'); }
}

async function onGlobalChange(event) {
  const node = event.target;
  if (node.matches('[data-act="grant-tool"]')) {
    const grant = (state.employeeData && state.employeeData.grants || []).find(item => item.tool_key === node.dataset.tool);
    try { await api('/employees/' + node.dataset.slug + '/tools', {method:'PATCH', body:{toolKey:node.dataset.tool, level:node.value, enabled:grant ? Boolean(grant.enabled) : false}}); toast('工具级别已更新'); } catch (error) { toast(error.message, 'error'); }
  }
  if (node.matches('[data-act="grant-enabled"]')) {
    const grant = (state.employeeData && state.employeeData.grants || []).find(item => item.tool_key === node.dataset.tool);
    try { await api('/employees/' + node.dataset.slug + '/tools', {method:'PATCH', body:{toolKey:node.dataset.tool, level:(grant && grant.level) || 'L1', enabled:node.checked}}); toast(node.checked ? '已授权工具' : '已停用工具'); } catch (error) { toast(error.message, 'error'); }
  }
  if (node.matches('[data-act="workflow-project-filter"]')) { state.filters.workflowProject = node.value; return route(); }
  if (node.matches('[data-act="knowledge-project"]')) return go('#/knowledge?project=' + encodeURIComponent(node.value));
  if (node.matches('[data-form="run-employee"][name="projectId"], form[data-form="run-employee"] select[name="projectId"]')) {
    const form = node.closest('form'); const project = state.projects.find(item => item.id === node.value); const select = form.querySelector('select[name="skuId"]');
    if (select) select.innerHTML = (project && project.skus || []).map(item => '<option value="' + esc(item.id) + '">' + esc(item.name) + ' · ' + money(item.price_cents) + ' 元</option>').join('');
  }
  if (node.matches('form[data-form="run-employee"] select[name="template"]')) {
    const form = node.closest('form'); const textareaNode = form.querySelector('textarea[name="task"]');
    if (textareaNode && node.value !== '自定义任务') textareaNode.value = node.value;
  }
}

function onGlobalInput(event) {
  if (event.target.matches('[data-act="filter-project"]')) {
    state.filters.project = event.target.value;
    clearTimeout(state.filterTimer);
    state.filterTimer = setTimeout(() => renderProjects().catch(error => toast(error.message, 'error')), 250);
  }
}

async function boot() {
  try {
    let session = await fetch('/api/opc/session').then(async response => response.ok ? response.json() : null).catch(() => null);
    if (!session || !session.operator) session = await fetch('/api/opc/session', {method:'POST'}).then(response => response.json());
    if (!session || !session.operator) throw new Error('无法创建本机会话');
    state.session = session;
    state.boot = await api('/bootstrap');
    renderShell();
    document.addEventListener('input', onGlobalInput);
    window.addEventListener('hashchange', route);
    await route();
  } catch (error) {
    document.getElementById('app').innerHTML = '<div class="boot"><div class="boot-card"><div class="boot-mark">OPC</div><h1>工作台未连接</h1><p>' + esc(error.message) + '</p><p class="small muted">请确认服务已在本机启动，且从 http://127.0.0.1 访问。</p><button class="btn primary" data-act="reload">重新加载</button></div></div>';
  }
}

boot();
