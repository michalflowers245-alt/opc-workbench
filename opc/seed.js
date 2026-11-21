import {readFileSync, mkdirSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {resolve, dirname, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROLES, ROLE_BY_SLUG, SKILL_BINDINGS, SUPPLEMENT_SKILLS, SKILL_LABELS, TOOL_CATALOG, DEMO_PROJECT_KEY} from './constants.js';
import {insert, insertIgnore, one, all, update, nowIso, json, sha256, setMeta, getMeta} from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};
const fileSha = (path) => sha256(readFileSync(path));
const exists = (path) => existsSync(path);

const REDCORE_ROLE_MAP = {
  'market-analyst':'industry-analysis', 'product-sourcing':'product-selection', 'visual-designer':'commerce-design',
  'copywriter':'commerce-copy', 'store-operator':'commerce-ops', 'presales-service':'pre-sales',
  'aftersales-service':'after-sales', 'data-analyst':'commerce-data',
};

export function seedOpc(db, {projectDir = resolve(here, '..'), dataDir, filesRoot, redcoreState = null} = {}) {
  const counts = {employees: 0, skills: 0, bindings: 0, projects: 0, workflows: 0, files: 0};
  const operator = seedOperator(db, redcoreState);
  seedModels(db);
  seedConnections(db, dataDir);
  const installed = installSkills(db, {projectDir, dataDir});
  seedEmployees(db, {redcoreState, installed});
  const demo = seedDemo(db, {projectDir, dataDir, filesRoot});
  counts.projects = 1;
  counts.workflows = seedWorkflows(db);
  counts.files = demo.files;
  counts.employees = all(db, 'SELECT id FROM opc_employees').length;
  counts.skills = all(db, 'SELECT id FROM opc_skills').length;
  counts.bindings = all(db, "SELECT id FROM opc_employee_skills WHERE relation='initial'").length;
  setMeta(db, 'seed_version', '1');
  setMeta(db, 'operator_id', operator.id);
  setMeta(db, 'demo_project_id', 'proj-demo-stand');
  setMeta(db, 'skill_bindings_count', 83);
  setMeta(db, 'initialized_at', nowIso());
  if (demo.mediaError) setMeta(db, 'media_error', demo.mediaError);
  return counts;
}

function seedOperator(db, redcoreState) {
  const existing = one(db, 'SELECT * FROM opc_operator LIMIT 1');
  const users = Array.isArray(redcoreState?.users) ? redcoreState.users : [];
  const owner = users.find(user => user.role === 'owner') || users[0] || null;
  const companyId = owner?.companyId || (Array.isArray(redcoreState?.companies) ? redcoreState.companies[0]?.id : null) || null;
  if (existing) {
    if (owner) {
      const patch = {};
      if (!existing.redcore_user_id) patch.redcore_user_id = owner.id;
      if (!existing.redcore_company_id) patch.redcore_company_id = companyId;
      if (!existing.name || existing.name === '本机经营者') patch.name = owner.name;
      if (Object.keys(patch).length) {
        update(db, 'opc_operator', existing.id, patch);
        return one(db, 'SELECT * FROM opc_operator WHERE id=?', existing.id);
      }
    }
    return existing;
  }
  const row = {
    id: 'op-owner', name: owner?.name || '本机经营者', email: owner?.email || null,
    redcore_user_id: owner?.id || null, redcore_company_id: companyId, created_at: nowIso(),
  };
  insertIgnore(db, 'opc_operator', row);
  return one(db, 'SELECT * FROM opc_operator WHERE id=?', 'op-owner');
}

function seedModels(db) {
  insertIgnore(db, 'opc_model_configs', {
    id: 'model-ollama-r1', name: '本机 Ollama · DeepSeek R1 1.5B', provider: 'ollama',
    base_url: 'http://127.0.0.1:11434', model: 'deepseek-r1:1.5b', enabled: 1, is_default: 1, updated_at: nowIso(),
  });
  const envBaseUrl = process.env.LLM_BASE_URL || '';
  const envModel = process.env.LLM_MODEL || '';
  if (envBaseUrl && envModel) {
    insertIgnore(db, 'opc_model_configs', {
      id: 'model-env', name: '环境变量模型（' + envModel + '）', provider: 'compatible',
      base_url: envBaseUrl, model: envModel, enabled: 1, is_default: 0, updated_at: nowIso(),
    });
  }
  insertIgnore(db, 'opc_model_configs', {
    id: 'model-deepseek', name: 'DeepSeek API · deepseek-chat', provider: 'compatible',
    base_url: 'https://api.deepseek.com', model: 'deepseek-chat', enabled: 1, is_default: 0, updated_at: nowIso(),
  });
}

function seedConnections(db, dataDir) {
  const rows = [
    ['conn-ollama','model','本机模型（Ollama）','configured',{baseUrl:'http://127.0.0.1:11434',model:'deepseek-r1:1.5b',secretSource:'无需密钥'}],
    ['conn-pdd-search','pdd','拼多多多多进宝商品检索','configured',{baseUrl:'https://gw-api.pinduoduo.com/api/router',api:'pdd.ddk.goods.search',secretNames:['ECOMMERCE_PDD_CLIENT_ID','ECOMMERCE_PDD_CLIENT_SECRET','ECOMMERCE_PDD_PID'],secretSource:'环境变量'}],
    ['conn-tavily','search','公开市场搜索（Tavily）','configured',{baseUrl:'https://api.tavily.com',secretNames:['TAVILY_API_KEY'],secretSource:'环境变量'}],
    ['conn-1688','sourcing','1688 找货网关','configured',{baseUrl:'https://skills-gateway.1688.com',path:'/api/find_product/1.0.0',secretNames:['ALI_1688_AK'],secretSource:'环境变量'}],
    ['conn-pdd-store','pdd','拼多多自有店铺报表','not_configured',{secretNames:['ECOMMERCE_PDD_ACCESS_TOKEN','店铺授权'],note:'无店铺授权；使用报表导入与人工核对。'}],
    ['conn-pdd-orders','pdd','拼多多订单/物流/客服会话','not_configured',{secretNames:['ECOMMERCE_PDD_ACCESS_TOKEN','客服接收授权','客服发送授权'],note:'只读查询与客服收发需分别授权。'}],
    ['conn-pdd-write','pdd','拼多多店铺写入','not_configured',{secretNames:['生产应用权限','店铺操作授权'],note:'上架、改价、库存、活动、退款等写入均需审核与第三方回执。'}],
    ['conn-image','image','图片交付（仅提示词）','configured',{mode:'prompt_only',provider:'prompt-only',note:'按经营者要求仅交付逐图提示词，不调用本地合成器，也不调用 AI 生图服务。'}],
    ['conn-mcp','mcp','受信 MCP 服务','configured',{url:'http://127.0.0.1:4322/mcp',tokenEnv:'MCP_ACCESS_TOKEN',secretNames:['MCP_ACCESS_TOKEN'],note:'默认连接本机受信 MCP 测试服务；真实第三方需替换 URL 与令牌。'}],
    ['conn-storage','storage','本地文件存储','configured',{path:dataDir ? resolve(dataDir, 'opc-files') : '',note:'附件不通过静态目录暴露，下载均经会话与项目校验。'}],
  ];
  for (const [id, kind, name, status, config] of rows) {
    insertIgnore(db, 'opc_connections', {
      id, kind, name, status, config_json: json(config), enabled: 1, updated_at: nowIso(),
    });
  }
  const image = one(db, 'SELECT * FROM opc_connections WHERE id=?', 'conn-image');
  const imageConfig = readJsonConfig(image?.config_json);
  if (imageConfig.mode !== 'prompt_only' || imageConfig.provider !== 'prompt-only') {
    update(db, 'opc_connections', 'conn-image', {
      status:'configured',
      config_json:json({...imageConfig, mode:'prompt_only', provider:'prompt-only',
        note:'仅输出主图与详情逐图提示词。'}),
      last_test_at:null, last_test_status:null, last_test_detail:null, last_receipt_json:null,
      updated_at:nowIso(),
    });
  }
}

function readJsonConfig(value) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

function roleSkillMarkdown(role) {
  return [
    '---', 'name: role-' + role.slug, 'version: 1.0.0',
    'description: OPC 工作台内置岗位流程：' + role.name, '---', '',
    '# ' + role.name + '岗位流程', '',
    '## 适用', role.description, '',
    '## 当前模式', role.slug === 'visual-designer' ? '- 仅输出主图/详情提示词，不调用本地合成器或 AI 生图。' : '- 按岗位配置执行。', '',
    '## 输入', '- 项目与 SKU 事实、已核验知识、上游产物版本；调用前由执行器校验权限。', '',
    '## 步骤',
    '1. 校验项目、SKU、时间窗和上游版本，缺失时标记待补。',
    '2. 只读取本任务有权访问的知识与附件，保留来源和核验时间。',
    '3. 调用岗位获准工具，保存请求、回执、环境和时间。',
    '4. 按结构化字段输出，模型不编造金额、销量、费率或承诺。',
    '5. 后端确定性计算利润与指标，产物写版本并登记证据。', '',
    '## 工具', role.tools.join('、'), '',
    '## 结构化输出', role.outputFields.join('、'), '',
    '## 质量检查', '- 事实与待核项分开；- 数字有口径；- 外部动作只创建待审；- 失败保留原始错误并给恢复入口。', '',
    '## 禁止', '不虚构商品参数、检测、赠品、库存、送达时效、优惠或经营结果；不绕过审批执行外部写入。', '',
  ].join('\n');
}

function installSkills(db, {projectDir, dataDir}) {
  const installed = new Map();
  const skillsRoot = dataDir ? resolve(dataDir, 'opc-skills') : resolve(projectDir, '.data', 'opc-skills');

  // 1) 三个 1688 公开发行包：逐文件落盘并校验。
  const cachePath = resolve(projectDir, '.data', 'desktop-selection-skills.json');
  const packages = readJson(cachePath, []);
  for (const pkg of packages) {
    if (!pkg || typeof pkg.slug !== 'string' || !Array.isArray(pkg.files)) continue;
    const version = String(pkg.version || '0.0.0');
    const target = resolve(skillsRoot, pkg.slug, version);
    const manifest = [];
    let files = 0;
    try {
      for (const file of pkg.files) {
        if (typeof file.path !== 'string' || !file.path) continue;
        const full = resolve(target, file.path);
        if (full !== target && !full.startsWith(target + sep)) continue;
        mkdirSync(dirname(full), {recursive: true});
        writeFileSync(full, String(file.content ?? ''), 'utf8');
        manifest.push({path: file.path, sha256: sha256(String(file.content ?? ''))});
        files += 1;
      }
      const skillRow = {
        slug: pkg.slug, name: SKILL_LABELS[pkg.slug] || pkg.slug, version,
        source: 'ClawHub 公开发行包（1688aiinfra）', source_url: 'https://clawhub.ai/1688aiinfra/skills/' + pkg.slug,
        package_path: target, install_status: 'installed', files_count: files,
        manifest_json: json(manifest), verified_at: nowIso(),
        origin: SKILL_BINDINGS.some(b => b.skillSlug === pkg.slug)
          ? '《AI数字员工提示词+skill.docx》第六节初始绑定' : '原站补充项（非 83 条初始绑定）',
        is_supplement: pkg.slug === '1688-ranking' ? 1 : 0,
      };
      const existingSkill = one(db, 'SELECT id FROM opc_skills WHERE slug=?', pkg.slug);
      if (existingSkill) update(db, 'opc_skills', existingSkill.id, skillRow);
      else insert(db, 'opc_skills', {...skillRow, id:'skill-' + pkg.slug, created_at:nowIso()});
      installed.set(pkg.slug, {version, path: target, files});
    } catch {
      // 已存在的同名技能保留原记录；安装失败在接入页显示待验证。
    }
  }

  // 2) 每岗内置流程技能，真实 SKILL.md 文件。
  for (const role of ROLES) {
    const slug = 'role-' + role.slug;
    const target = resolve(projectDir, 'opc', 'skills', slug);
    mkdirSync(target, {recursive: true});
    const path = resolve(target, 'SKILL.md');
    const content = roleSkillMarkdown(role);
    writeFileSync(path, content, 'utf8');
    insertIgnore(db, 'opc_skills', {
      id: 'skill-' + slug, slug, name: role.name + '岗位流程', version: '1.0.0', source: 'OPC 工作台内置',
      package_path: path, install_status: 'installed', files_count: 1,
      manifest_json: json([{path: 'SKILL.md', sha256: sha256(content)}]), verified_at: nowIso(),
      origin: '工作台内置，不替代原始 83 条绑定', is_supplement: 0, created_at: nowIso(),
    });
  }

  // 3) 83 条原始绑定 + 原站补充项：只有名称的保留名录。
  for (const binding of SKILL_BINDINGS) {
    const existing = one(db, 'SELECT * FROM opc_skills WHERE slug=?', binding.skillSlug);
    if (!existing) {
      insertIgnore(db, 'opc_skills', {
        id: 'skill-' + binding.skillSlug, slug: binding.skillSlug, name: SKILL_LABELS[binding.skillSlug] || binding.skillSlug,
        version: null, source: '原始绑定名录（仅名称，待提供安装包）', package_path: null,
        install_status: 'catalog_only', files_count: 0, manifest_json: json([]), origin: binding.origin,
        is_supplement: 0, created_at: nowIso(),
      });
    }
  }
  for (const supplement of SUPPLEMENT_SKILLS) {
    const existing = one(db, 'SELECT * FROM opc_skills WHERE slug=?', supplement.slug);
    if (!existing) {
      insertIgnore(db, 'opc_skills', {
        id: 'skill-' + supplement.slug, slug: supplement.slug, name: SKILL_LABELS[supplement.slug] || supplement.slug,
        version: supplement.version, source: '原站补充项（公开包）', install_status: 'catalog_only',
        files_count: 0, manifest_json: json([]), origin: supplement.origin, is_supplement: 1, created_at: nowIso(),
      });
    }
  }

  return installed;
}

function seedEmployees(db, {redcoreState, installed}) {
  const agents = Array.isArray(redcoreState?.agents) ? redcoreState.agents : [];
  for (const role of ROLES) {
    const redcoreKey = REDCORE_ROLE_MAP[role.slug];
    const agent = agents.find(item => item.templateId === 'role-' + redcoreKey) || null;
    insertIgnore(db, 'opc_employees', {
      id: role.id, slug: role.slug, role_key: role.key, name: role.name, avatar: role.avatar, color: role.color,
      description: role.description, mind_version: '1.0.0', model_id: role.model, status: 'active',
      context_rounds: role.contextRounds, tool_limit: role.toolLimit, timeout_ms: role.timeoutMs,
      daily_token_limit: role.dailyTokenLimit, permissions_json: json({visibility:'private', externalWrite:'approval', scope:'project'}),
      redcore_agent_id: agent?.id || null, created_at: nowIso(), updated_at: nowIso(),
    });
    if (agent) {
      const saved = one(db, 'SELECT id,redcore_agent_id FROM opc_employees WHERE id=?', role.id);
      if (saved && !saved.redcore_agent_id) update(db, 'opc_employees', saved.id, {redcore_agent_id: agent.id, updated_at: nowIso()});
    }
    const mind = one(db, 'SELECT id FROM opc_employee_minds WHERE employee_id=? AND version=?', role.id, '1.0.0');
    if (!mind) {
      insert(db, 'opc_employee_minds', {
        id: 'mind-' + role.slug + '-1', employee_id: role.id, version: '1.0.0', runtime_text: role.mind,
        source: '工作台内置岗位说明', source_text: null, created_at: nowIso(), created_by: '系统初始化',
      });
    }
    for (const toolKey of role.tools) {
      const catalog = TOOL_CATALOG[toolKey];
      insertIgnore(db, 'opc_tool_grants', {
        employee_id: role.id, tool_key: toolKey, level: catalog?.defaultLevel || 'L1', enabled: 1, updated_at: nowIso(),
      });
    }
    if (role.slug === 'visual-designer') {
      db.prepare("UPDATE opc_tool_grants SET enabled=0, updated_at=? WHERE employee_id=? AND tool_key='image.generate'").run(nowIso(), role.id);
    }
    const roleSkill = one(db, 'SELECT id FROM opc_skills WHERE slug=?', 'role-' + role.slug);
    if (roleSkill) {
      insertIgnore(db, 'opc_employee_skills', {
        id: 'es-' + role.slug + '-role', employee_id: role.id, skill_id: roleSkill.id, binding_index: null,
        label: role.name + '岗位流程（内置）', relation: 'role', status: 'installed', created_at: nowIso(),
      });
    }
    for (const binding of SKILL_BINDINGS.filter(item => item.employeeSlug === role.slug)) {
      const skill = one(db, 'SELECT * FROM opc_skills WHERE slug=?', binding.skillSlug);
      if (!skill) continue;
      insertIgnore(db, 'opc_employee_skills', {
        id: 'es-' + role.slug + '-' + binding.index, employee_id: role.id, skill_id: skill.id,
        binding_index: binding.index, label: binding.originalName, relation: 'initial',
        status: skill.install_status === 'installed' ? 'installed' : 'registered', created_at: nowIso(),
      });
    }
    for (const supplement of SUPPLEMENT_SKILLS.filter(item => item.employeeSlug === role.slug)) {
      const skill = one(db, 'SELECT * FROM opc_skills WHERE slug=?', supplement.slug);
      if (!skill) continue;
      insertIgnore(db, 'opc_employee_skills', {
        id: 'es-' + role.slug + '-supplement-' + supplement.slug, employee_id: role.id, skill_id: skill.id,
        binding_index: null, label: supplement.name, relation: 'supplement',
        status: skill.install_status === 'installed' ? 'installed' : 'registered', created_at: nowIso(),
      });
    }
  }
}

function addFile(db, {filesRoot, projectId, name, path, mime, source, skuId = null, runId = null}) {
  if (!exists(path)) return null;
  const stat = statSync(path);
  const relative = path.slice(filesRoot.length).replace(/^[/\\]/, '');
  const id = 'file-' + sha256(path + name).slice(0, 12);
  insertIgnore(db, 'opc_files', {
    id, project_id: projectId, sku_id: skuId, run_id: runId, name, mime, size: stat.size, sha256: fileSha(path),
    storage_path: relative, access_scope: 'project', source, created_at: nowIso(),
  });
  return id;
}

function seedDemo(db, {projectDir, dataDir, filesRoot}) {
  if (!filesRoot) filesRoot = resolve(dataDir, 'opc-files');
  const projectId = 'proj-demo-stand';
  const storeId = 'store-demo-pdd';
  const productId = 'product-demo-stand';
  const createdAt = '2026-11-18T10:00:00.000Z';
  insertIgnore(db, 'opc_projects', {
    id: projectId, seed_key: DEMO_PROJECT_KEY, name: '折叠桌面手机支架（合成演示）',
    description: '拼多多单人店测款演示。所有经营数字、报价、素材和顾客消息均明确标为合成演示或历史回放，不代表真实销量或促销。',
    platform: '拼多多', category: '手机支架 / 桌面配件', audience: '租房上班族、大学生、桌面办公与追剧人群',
    price_min_cents: 2990, price_max_cents: 3990, budget_cents: 100000, fulfillment: '一件代发',
    constraints: '不做三无产品；不使用未授权品牌；不承诺未核实的检测报告、赠品、库存和送达时效。',
    status: 'active', is_demo: 1, redcore_company_id: one(db, 'SELECT redcore_company_id FROM opc_operator LIMIT 1')?.redcore_company_id || null,
    created_at: createdAt, updated_at: createdAt,
  });
  insertIgnore(db, 'opc_stores', {
    id: storeId, project_id: projectId, platform: '拼多多', name: 'OPC 演示店（未授权）', shop_ref: 'DEMO-PDD-001',
    authorization_status: 'not_configured', facts_json: json({
      shopName: 'OPC 演示店（未授权）', platform: '拼多多', shipFrom: '浙江金华（演示）',
      handlingTime: '48 小时内发出（合成演示，待供应商确认）', delivery: '送达时间以物流为准，不承诺次日达',
      afterSales: '7 天无理由退换；破损需提供外箱照与商品破损近照',
      notes: ['店铺授权未配置', '本店事实仅用于演示', '不得将演示时效当作真实承诺'],
    }), created_at: createdAt,
  });
  insertIgnore(db, 'opc_products', {
    id: productId, project_id: projectId, store_id: storeId, name: '折叠桌面手机支架', category: '手机支架',
    status: 'candidate', platform: '拼多多',
    description: '可折叠收纳的桌面手机支架，合成演示用。标准款与加强款两个 SKU；材质、承重、尺寸和检测报告待供应商复核。',
    created_at: createdAt,
  });
  insertIgnore(db, 'opc_suppliers', {
    id: 'sup-demo-a', name: '义乌.demo 折叠支架厂（合成演示）', shop_url: 'https://example.invalid/supplier-a',
    location: '浙江金华 · 义乌', qualifications: '诚信通 5 年（演示）', moq: 1, lead_time_hours: 48, dropship: 1,
    rating: '4.8 / 5（演示）', source: '合成演示报价，不对应真实店铺',
    evidence_json: json({note:'仅用于工作台验收，禁止当作真实供应商资质', quote_files:['demo-quotes.csv']}), created_at: createdAt,
  });
  insertIgnore(db, 'opc_suppliers', {
    id: 'sup-demo-b', name: '深圳.demo 数码配件商（合成演示）', shop_url: 'https://example.invalid/supplier-b',
    location: '广东深圳', qualifications: '实力商家（演示）', moq: 2, lead_time_hours: 72, dropship: 1,
    rating: '4.6 / 5（演示）', source: '合成演示报价，不对应真实店铺',
    evidence_json: json({note:'备选报价，运费已含在代发价内'}), created_at: createdAt,
  });
  const skuStd = {
    id: 'sku-demo-standard', product_id: productId, project_id: projectId, code: 'STAND-STD-BLK', name: '标准款·黑色',
    specs_json: json({颜色:'黑色', 材质:'ABS + 硅胶防滑垫（待复核）', 折叠:'可折叠', 承重:'待复核', 包装:'独立彩盒（演示）'}),
    price_cents: 2990, cost_cents: 1100, shipping_cents: 400, packaging_cents: 50, platform_fee_bps: 600,
    platform_fee_rounding: '四舍五入到分', refund_cents: 60, ad_cents: 500, tax_cents: 0, discount_cents: 0,
    stock: null, supplier_id: 'sup-demo-a', quote_id: 'quote-demo-std', status: 'draft',
    evidence_json: json({source:'合成演示输入', note:'售价 29.90、进货 11、快递 4、包材 0.50、平台费率 6%、退款 0.60、广告 5/单'}),
    effective_at: createdAt, created_at: createdAt, updated_at: createdAt,
  };
  const skuPro = {
    id: 'sku-demo-pro', product_id: productId, project_id: projectId, code: 'STAND-PRO-GRY', name: '加强款·深灰',
    specs_json: json({颜色:'深灰', 材质:'铝合金 + ABS（待复核）', 折叠:'可折叠', 伸缩臂:'有', 承重:'待复核', 包装:'独立彩盒（演示）'}),
    price_cents: 3990, cost_cents: 1650, shipping_cents: 450, packaging_cents: 60, platform_fee_bps: 600,
    platform_fee_rounding: '四舍五入到分', refund_cents: 800, ad_cents: 650, tax_cents: 0, discount_cents: 0,
    stock: null, supplier_id: 'sup-demo-a', quote_id: 'quote-demo-pro', status: 'draft',
    evidence_json: json({source:'合成演示输入', note:'第二 SKU 用于对比与版本切换'}),
    effective_at: createdAt, created_at: createdAt, updated_at: createdAt,
  };
  insertIgnore(db, 'opc_skus', skuStd);
  insertIgnore(db, 'opc_skus', skuPro);
  insertIgnore(db, 'opc_quotes', {
    id:'quote-demo-std', supplier_id:'sup-demo-a', product_id:productId, sku_id:'sku-demo-standard', item_id:'DEMO-1688-STD',
    sku_ref:'STD-BLK', spec_text:'标准款·黑色·独立彩盒', qty_min:1, qty_max:99, unit_price_cents:1100, shipping_cents:400,
    dropship:1, retrieved_at:createdAt, source:'合成演示报价（供应商 A）', source_url:'https://example.invalid/supplier-a',
    verification_status:'synthetic', raw_json:json({note:'运费不含在报价内，SKU 单列快递 4 元'}), created_at:createdAt,
  });
  insertIgnore(db, 'opc_quotes', {
    id:'quote-demo-pro', supplier_id:'sup-demo-a', product_id:productId, sku_id:'sku-demo-pro', item_id:'DEMO-1688-PRO',
    sku_ref:'PRO-GRY', spec_text:'加强款·深灰·伸缩臂·独立彩盒', qty_min:1, qty_max:99, unit_price_cents:1650, shipping_cents:450,
    dropship:1, retrieved_at:createdAt, source:'合成演示报价（供应商 A）', source_url:'https://example.invalid/supplier-a',
    verification_status:'synthetic', raw_json:json({note:'运费不含在报价内，SKU 单列快递 4.50 元'}), created_at:createdAt,
  });
  insertIgnore(db, 'opc_quotes', {
    id:'quote-demo-alt', supplier_id:'sup-demo-b', product_id:productId, sku_id:'sku-demo-standard', item_id:'DEMO-1688-ALT',
    sku_ref:'ALT-01', spec_text:'标准款·黑·代发含运费', qty_min:2, qty_max:200, unit_price_cents:1250, shipping_cents:0,
    dropship:1, retrieved_at:createdAt, source:'合成演示报价（供应商 B）', source_url:'https://example.invalid/supplier-b',
    verification_status:'synthetic', raw_json:json({shipping_included:true, note:'代发价已含运费；若采用此报价，SKU 履约费应改为 0 以免重复计入'}), created_at:createdAt,
  });
  // 历史 1688 真实回放：只作基准，不冒充当前报价。
  const historical = [
    ['969851659203','5919618320998','白色 裸装','直供手机支架多角度旋转懒人支架可折叠式手机架直播平板支架LOGO',32,1,54,4.44],
    ['714926558065','5555217660184','加重升级款【珍珠白】','热销桌面手机支架通用折叠智能手机平板电脑支架便携拍照视频直播',144,1,495,4.31],
    ['996048229050','6145842991324','K72【全合金-米白色】720°旋转折叠','金属手机支架桌面企业礼品活动广告定制logo旋转折叠便携ipad支架',450,1,165,4.59],
    ['1034642047556','6052418941005','黑色 裸装','手机平板通用桌面支架便携式折叠平板支架简易小巧桌面支架',75,2,94,4.57],
    ['923712816540','6097477946698','【K99黑色】加大加厚','桌面手机支架360旋转胡桃木纹底座支撑架手机平板通用爆款懒人架',650,2,16,4.51],
  ];
  historical.forEach(([itemId, skuId, skuTitle, title, price, qtyMin, sold30d, yx], index) => {
    const supplierId = 'sup-hist-' + (index + 1);
    insertIgnore(db, 'opc_suppliers', {
      id: supplierId, name: '1688 历史回放 · 商品 ' + itemId + '（供应商名未在原回执）', shop_url: 'https://detail.1688.com/offer/' + itemId + '.html',
      location: '原回执未提供', qualifications: '原回执未提供', moq: qtyMin, lead_time_hours: null, dropship: null,
      rating: '原回执未提供', source: '原站历史回放 1688（2026-11-18）', evidence_json: json({item_id:itemId, retrieved_at:'2026-11-18', note:'历史回放，不是本次请求回执'}),
      created_at: createdAt,
    });
    insertIgnore(db, 'opc_quotes', {
      id:'quote-hist-' + (index + 1), supplier_id:supplierId, product_id:productId, sku_id:null, item_id:itemId,
      sku_ref:String(skuId), spec_text:skuTitle, qty_min:qtyMin, qty_max:null, unit_price_cents:price * 100,
      shipping_cents:null, dropship:null, retrieved_at:'2026-11-18T09:00:00.000Z', source:'原站历史回放 1688（2026-11-18）',
      source_url:'https://detail.1688.com/offer/' + itemId + '.html', verification_status:'historical',
      raw_json:json({title, sold_30d:sold30d, yx_index:yx, query:'折叠桌面手机支架 一件代发', note:'原回执缺少供应商名、运费和代发条件，按缺失处理'}), created_at:createdAt,
    });
  });

  const knowledge = [
    ['kn-demo-product','商品知识','折叠桌面手机支架 · 商品事实（合成）','标准款约 29.90 元、加强款 39.90 元；颜色黑/深灰；可折叠；材质、承重、折叠尺寸和检测报告尚未提供，必须标待核。','合成演示资料','synthetic',{known:['两个 SKU','可折叠','颜色'],pending:['材质','承重','尺寸','检测报告']}],
    ['kn-demo-logistics','店铺政策','发货与送达口径（合成）','本店演示政策：48 小时内发出；送达时间以物流实际为准；不承诺次日达、不承诺加急；节假日顺延。','合成演示店铺政策','synthetic',null],
    ['kn-demo-aftersales','店铺政策','退换与破损处理（合成）','7 天无理由退换；破损需外箱照与商品破损近照；退款、补发、发券金额以审核后的方案为准，客服不主动报金额。','合成演示店铺政策','synthetic',null],
    ['kn-demo-faq','FAQ','常见问题（合成）','Q：多高手机能用？A：详情页未提供适配尺寸，需按 SKU 事实复核。Q：有赠品吗？A：当前无已核实赠品。Q：能次日达吗？A：不承诺。Q：会刮花手机吗？A：接触面为硅胶垫（待复核）。','合成演示 FAQ','synthetic',null],
    ['kn-demo-fee','平台规则','拼多多技术服务费口径（待核）','演示采用 6% 平台费率并四舍五入到分。该费率仅为本项目输入，不是平台当前费率的声明；上线前须在商家后台核对类目费率、活动与减免。','商家后台待核对','pending',null],
    ['kn-demo-audience','商品知识','目标人群与场景（合成）','租房上班族、大学生、桌面办公与追剧人群；主要场景是桌面追剧、视频会议、线上课与床头/工位收纳。','合成演示项目定义','synthetic',null],
    ['kn-demo-baseline','经营事实','推广样例口径（合成）','样例汇总：曝光 10,000、点击 300、成交 15、归因销售额 450 元、推广费用 150 元、访客 1,000。按此口径 CTR 3%、点击成交率 5%、CPC 0.50 元、ROAS 3.00；不是实际投放结果。','合成演示报表','synthetic',null],
    ['kn-demo-sample-note','经营事实','演示数据声明','本项目所有商品、供应商、报价、报表、顾客消息、素材和经营结果均为合成演示或历史回放，不得写成实际销量、促销、库存或承诺。','工作台初始化','synthetic',null],
    ['kn-demo-1688-history','供应商报价','1688 历史回放说明（2026-11-18）','原站 2026-11-18 用三组搜索词获得 27 款去重商品，价格带 0.11/0.58/1.47/4.48/25.00 元，起订量 1 的占 67%。本机 2026-11-19 复测返回 HTTP 401 ACCESS_KEY_EXPIRED，需更新 ALI_1688_AK。历史报价只作基准，不代表当前可下单。','原站历史回执 + 本机复测','historical',null],
    ['kn-demo-claims','商品知识','未核实宣称清单','材质、承重、折叠尺寸、适配手机尺寸、检测报告、赠品、库存、送达时效、限时折扣均未取得可核依据。文案、美工和客服不得写成确定事实。','工作台初始化','pending',null],
  ];
  for (const [id, kind, title, body, source, status, extra] of knowledge) {
    insertIgnore(db, 'opc_knowledge', {
      id, project_id: projectId, sku_id: null, scope:'project', kind, title, body, source, source_url:null,
      verification_status:status, effective_from: createdAt, effective_to:null,
      last_verified_at: status === 'synthetic' ? createdAt : null, created_by:'系统初始化',
      created_at: createdAt,
    });
  }

  const reportId = 'report-demo-promo';
  insertIgnore(db, 'opc_reports', {
    id: reportId, project_id: projectId, store_id: storeId, kind:'推广报表', name:'近 7 日推广报表（合成演示）',
    period_start:'2026-11-10', period_end:'2026-11-16', channel:'全站推广', import_batch:'demo-seed',
    status:'valid', metric_definitions_json: json({
      impressions:'曝光量', clicks:'点击量', orders:'成交单量', revenue:'归因销售额（元）', ad_spend:'推广费用（元）',
      visitors:'访客数', ctr:'点击 ÷ 曝光 × 100%', click_cvr:'成交 ÷ 点击 × 100%', cpc:'推广费用 ÷ 点击', roas:'归因销售额 ÷ 推广费用',
    }), created_at: createdAt,
  });
  const daily = [
    ['2026-11-10',1200,30,1,3000,1500,120], ['2026-11-11',1400,40,2,6000,2000,140],
    ['2026-11-12',1500,45,2,6000,2250,150], ['2026-11-13',1600,50,3,9000,2500,160],
    ['2026-11-14',1500,45,2,6000,2250,150], ['2026-11-15',1400,45,2,6000,2250,140],
    ['2026-11-16',1400,45,3,9000,2250,140],
  ];
  daily.forEach((row, index) => {
    insertIgnore(db, 'opc_report_rows', {
      id:'rr-demo-' + (index + 1), report_id:reportId, row_no:index + 1, date:row[0], plan:'全站推广',
      channel:'全站推广', impressions:row[1], clicks:row[2], orders:row[3], revenue_cents:row[4], ad_spend_cents:row[5],
      visitors:row[6], errors_json:json([]), warnings_json:json([]), status:'valid',
    });
  });
  const invalid = [
    ['2026-13-40',100,10,1,1000,500,10,['日期无效：月份或日期越界']],
    ['2026-11-17',100,'abc',1,1000,500,10,['点击量不是数字']],
    ['2026-11-18',100,0,3,1000,500,10,['成交单量不能大于点击量']],
    ['2026-11-19',100,500,3,1000,500,10,['点击量不能大于曝光量']],
    ['2026-11-20',100,10,1,-1000,500,10,['归因销售额不能为负数']],
  ];
  invalid.forEach((row, index) => {
    insertIgnore(db, 'opc_report_rows', {
      id:'rr-demo-x' + (index + 1), report_id:reportId, row_no:daily.length + index + 1, date:row[0], plan:'全站推广',
      channel:'全站推广', impressions:row[1], clicks:typeof row[2] === 'number' ? row[2] : null,
      orders:row[3], revenue_cents:row[4], ad_spend_cents:row[5], visitors:row[6],
      errors_json:json(row[7]), warnings_json:json([]), status:'invalid',
    });
  });

  const tickets = [
    ['ticket-demo-pre-1','售前咨询',null,'PDD-DEMO-Q1','明天能到吗？有赠品吗？','标准款黑色 29.90 元；顾客询问次日送达与赠品。',null,'open'],
    ['ticket-demo-pre-2','售前咨询',null,'PDD-DEMO-Q2','标准款和加强款有什么区别？我的手机 6.7 英寸能用吗？','顾客在比较两个 SKU，并询问适配尺寸。',null,'open'],
    ['ticket-demo-after-1','售后-破损','sku-demo-standard','PDD-DEMO-1001','收到支架底座裂了，很生气，要求退款！','顾客提供外箱照，缺商品破损近照；订单已签收。',null,'open'],
    ['ticket-demo-after-2','售后-物流丢件','sku-demo-standard','PDD-DEMO-1002','物流显示签收但我没收到，怎么回事？','顾客称未收到货；物流状态待查。',null,'open'],
  ];
  for (const [id, type, skuId, orderRef, message, note, reply, status] of tickets) {
    insertIgnore(db, 'opc_tickets', {
      id, project_id:projectId, sku_id:skuId, order_ref:orderRef, type,
      severity: type.startsWith('售后') ? (id.endsWith('1') ? '高' : '中') : null,
      emotion: id.endsWith('1') ? '高' : '中', status, owner_employee_id:null, original_message:message,
      evidence_json: json([{type:'message', text:message},{type:'note', text:note}]), pending_facts_json: json([]),
      reply_draft: reply, resolution:null, receipt_json:null, created_at:createdAt, updated_at:createdAt,
    });
  }

  // 仅登记已存在的历史图片；新初始化同样采用提示词模式。
  const mediaNames = ['product-original-main.png','product-original-angle.png','product-detail-750x1000.png','product-sku-pro.png'];
  const media = {ok:true, files:mediaNames.map(name => resolve(filesRoot, projectId, 'demo-media', name)).filter(path => exists(path))};
  const attachmentDir = resolve(filesRoot, projectId, 'attachments');
  mkdirSync(attachmentDir, {recursive:true});
  const quotesCsv = ['商品ID,SKU规格,单价(元),起订量,运费(元),代发,来源,核验状态',
    'DEMO-1688-STD,标准款·黑色,11.00,1,4.00,是,合成演示供应商A,合成演示',
    'DEMO-1688-PRO,加强款·深灰,16.50,1,4.50,是,合成演示供应商A,合成演示',
    'DEMO-1688-ALT,标准款·黑·代发含运费,12.50,2,0.00,是,合成演示供应商B,合成演示',
    '969851659203,白色 裸装,0.32,1,,未提供,原站历史回放 1688,历史回放',
    '714926558065,加重升级款【珍珠白】,1.44,1,,未提供,原站历史回放 1688,历史回放',
  ].join('\n');
  if (!exists(resolve(attachmentDir, 'demo-quotes.csv'))) writeFileSync(resolve(attachmentDir, 'demo-quotes.csv'), quotesCsv, 'utf8');
  const reportCsv = ['日期,曝光,点击,成交单量,归因销售额,推广费用,访客数',
    ...daily.map(row => [row[0], row[1], row[2], row[3], (row[4] / 100).toFixed(2), (row[5] / 100).toFixed(2), row[6]].join(',')),
    '2026-13-40,100,10,1,10.00,5.00,10',
    '2026-11-17,100,abc,1,10.00,5.00,10',
    '2026-11-18,100,0,3,10.00,5.00,10',
    '2026-11-19,100,500,3,10.00,5.00,10',
    '2026-11-20,100,10,1,-10.00,5.00,10',
  ].join('\n');
  if (!exists(resolve(attachmentDir, 'demo-promo-report.csv'))) writeFileSync(resolve(attachmentDir, 'demo-promo-report.csv'), reportCsv, 'utf8');
  const description = ['# 折叠桌面手机支架（合成演示）','','- 平台：拼多多','- 店铺：OPC 演示店（未授权）','- SKU：标准款·黑色 29.90 元；加强款·深灰 39.90 元','- 模式：一件代发','- 已知：可折叠、两个颜色/规格','- 待核：材质、承重、尺寸、检测报告、赠品、库存、送达时效','- 声明：本文件为合成演示资料，不是商品页面或真实销量证明。',''].join('\n');
  if (!exists(resolve(attachmentDir, 'product-description.md'))) writeFileSync(resolve(attachmentDir, 'product-description.md'), description, 'utf8');
  let files = 0;
  if (media.ok) {
    for (const image of media.images || []) {
      if (addFile(db, {filesRoot, projectId, name: image.filename, path: image.path, mime:'image/png', source:'合成演示素材（本地合成，自有）'})) files += 1;
    }
    if (!media.images) {
      for (const path of media.files) {
        if (addFile(db, {filesRoot, projectId, name: path.split('/').pop(), path, mime:'image/png', source:'合成演示素材（本地合成，自有）'})) files += 1;
      }
    }
  }
  if (addFile(db, {filesRoot, projectId, name:'demo-quotes.csv', path:resolve(attachmentDir, 'demo-quotes.csv'), mime:'text/csv', source:'合成演示数据'})) files += 1;
  if (addFile(db, {filesRoot, projectId, name:'demo-promo-report.csv', path:resolve(attachmentDir, 'demo-promo-report.csv'), mime:'text/csv', source:'合成演示数据'})) files += 1;
  if (addFile(db, {filesRoot, projectId, name:'product-description.md', path:resolve(attachmentDir, 'product-description.md'), mime:'text/markdown', source:'合成演示数据'})) files += 1;
  return {files, mediaError: media.ok ? null : media.error};
}

function seedWorkflows(db) {
  const createdAt = '2026-11-18T10:00:00.000Z';
  const definitions = [
    ['wf-demo-a','A','流程 A｜从经营想法到商品上架资料包',[
      ['market','市场判断与验证计划','emp-market-analyst'],
      ['sourcing','1688 找货与利润核算','emp-product-sourcing'],
      ['confirm_sku','经营者确认主推 SKU',''],
      ['copy','卖点提炼与全渠道文案','emp-copywriter'],
      ['design_strategy','两套视觉策略与选择','emp-visual-designer'],
      ['design_assets','五图与详情逐屏出图','emp-visual-designer'],
      ['listing','组装上架资料包',''],
      ['operator_plan','上新与测款运营计划','emp-store-operator'],
    ]],
    ['wf-demo-b','B','流程 B｜从售前咨询转成售后工单',[
      ['presales','售前识别与回复草稿','emp-presales-service'],
      ['ticket','转售后并建工单','emp-presales-service'],
      ['aftersales','售后退货分级与方案','emp-aftersales-service'],
      ['approval','补偿/补发动作审核',''],
    ]],
    ['wf-demo-c','C','流程 C｜从数据分析回到下一轮运营',[
      ['data','数据质量、漏斗与利润','emp-data-analyst'],
      ['operator','运营复盘与下一轮动作','emp-store-operator'],
      ['review','经营者确认复盘',''],
    ]],
  ];
  for (const [id, type, name, steps] of definitions) {
    insertIgnore(db, 'opc_workflows', {
      id, project_id:'proj-demo-stand', type, name, status:'draft', current_step:0, created_at:createdAt, updated_at:createdAt,
    });
    steps.forEach(([key, stepName, employeeId], index) => {
      insertIgnore(db, 'opc_workflow_steps', {
        id:'wfs-' + id.slice(-1) + '-' + key, workflow_id:id, seq:index + 1, key, name:stepName,
        employee_id:employeeId || null, status:'pending', run_id:null, depends_on:index ? steps[index - 1][0] : null,
        artifact_ref:null, note: key === 'confirm_sku' ? '需要经营者选择主推 SKU 后才能继续' : '',
        created_at:createdAt, updated_at:createdAt,
      });
    });
  }
  return definitions.length;
}
