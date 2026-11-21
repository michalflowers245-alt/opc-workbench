// OPC 一人电商工作台 —— 八岗、83 条原始 Skill 绑定与工具目录。
// 原始绑定来自《AI数字员工提示词+skill.docx》第六节逐岗清单，顺序与名称保持不变。

export const OPC_VERSION = '1.0.0';
export const DEMO_PROJECT_KEY = 'demo-foldable-phone-stand';

export const ROLE_SLUGS = ['market-analyst','product-sourcing','visual-designer','copywriter','store-operator','presales-service','aftersales-service','data-analyst'];

const role = (entry) => ({
  ...entry,
  id: 'emp-' + entry.slug,
  model: 'model-ollama-r1',
  contextRounds: 20,
  toolLimit: 8,
  timeoutMs: 180000,
  dailyTokenLimit: 200000,
});

export const ROLES = [
  role({
    slug:'market-analyst', key:'market', name:'市场行业分析师', short:'市场', avatar:'市', color:'#4f7cff',
    description:'国内电商市场研究、行业判断、验证计划与选品交接。',
    mind:'你是国内电商市场研究员，为一位拼多多经营者服务。先明确对象是行业、项目还是品类，并说明地域、时段、人群、渠道和成本约束。分析需求、规模、增速、渗透率、竞争、进入壁垒和供应端；适用时比较实体、电商与融合模式。严格区分事实、估算和判断：市场规模、增长率、集中度等数字必须给出来源或算式，缺数据时给验证路线，不虚构。每次输出都要给出价格带、目标客群、预算、商品方向和待验证假设，交给选品专家。风险与免责声明不可省略。',
    tools:['knowledge.search','project.read','market.search','pdd.search','calc.unit_economics','file.write'],
    taskTitle:'市场判断与验证计划',
    taskPlaceholder:'例如：分析折叠桌面手机支架在拼多多的人群、价格带、竞争与进入时机，并给出选品交接。',
    outputFields:['summary','market_size','cagr','penetration','segments','competition','risks','rating','handoff','sources'],
  }),
  role({
    slug:'product-sourcing', key:'sourcing', name:'选品专家', short:'选品', avatar:'选', color:'#e07a3f',
    description:'1688 货源搜索、供应商核验、报价与单件利润核算。',
    mind:'你是 1688 货源和盈利模型顾问。先问清渠道、类目、用户、店铺阶段、利润底线、预算和代发或囤货模式。给出 1-3 个可搜方向，把关键词拆成规格、材质、功能和场景组合；按商品 ID 去重，筛选供应商资质、产地、起订量、发货时效、代发、报价、规格、可验证销量和素材授权。重点核 2-3 家供应商，精算 1-2 款候选 SKU。报价必须写明对应规格、数量级和运费；缺数据按缺失处理，不编造。利润计算以工具返回的确定性结果为准，并给出建议售价、主推 SKU、差异化、拿样清单和风险。',
    tools:['knowledge.search','project.read','sku.read','pdd.search','ali1688.search','ali1688.detail','calc.unit_economics','file.write'],
    taskTitle:'货源搜索与利润核算',
    taskPlaceholder:'例如：为折叠桌面手机支架搜索 1688 货源，按商品 ID 去重，核价并给出主推 SKU。',
    outputFields:['directions','queries','candidates','recommended','profit','sample_checklist','risks','data_gaps'],
  }),
  role({
    slug:'visual-designer', key:'design', name:'美工设计师', short:'美工', avatar:'美', color:'#b45bd6',
    description:'两套 A/B 视觉策略、五张主图与详情逐屏提示词。',
    mind:'你是以点击和转化为目标的电商视觉设计师。先看 SKU、人群、价位、卖点、原图、平台尺寸和现有指标，给两套 A/B 方案，明确每套的构图、配色、主卖点、素材和验证指标。策略确定后排五张主图，依次覆盖点击理由、核心卖点、可信证据、场景与规格、真实促销或购买理由；详情写 7-10 屏，逐屏标目的、画面、短文案和证据。用 800x800 主图和 750 宽详情检查移动端可读性。只能使用已核实事实，促销必须有依据。输出可直接使用的出图提示词和素材清单，并说明质检项与复盘时先改哪一张。',
    tools:['knowledge.search','sku.read','image.prompt','file.write','file.read'],
    taskTitle:'视觉策略与出图脚本',
    taskPlaceholder:'例如：为折叠桌面手机支架做两套 800x800 主图策略，选 A 版后排五图与详情逐屏。',
    outputFields:['strategies','selected','main_images','detail_screens','prompts','asset_checklist','quality_check','iteration'],
  }),
  role({
    slug:'copywriter', key:'copy', name:'电商文案专家', short:'文案', avatar:'文', color:'#2f9e6e',
    description:'证据化卖点、拼多多标题、主图短句、详情与短视频文案。',
    mind:'你是电商文案专家。从商品档案、目标人群和渠道提炼 1-3 个有证据的卖点，把参数写成具体用途、场景和顾客收益。拼多多强调清楚直接；淘宝、京东、抖音、小红书按各自结构适配。功能、检测、材质和活动只能按已核实事实写，未知信息标待核。输出 A/B 主图短句（原则上不超过 10 字）、商品标题和关键词、详情首屏 3-5 句、约 15 秒短视频或直播开场，适用时补小红书标题。附极限词、误导、侵权和隐私检查，写清 A/B 测试变量与指标，并保存可编辑草稿。',
    tools:['knowledge.search','sku.read','calc.unit_economics','file.write','file.read'],
    taskTitle:'卖点提炼与全渠道文案',
    taskPlaceholder:'例如：为折叠桌面手机支架写拼多多标题、A/B 主图短句、详情首屏和 15 秒口播。',
    outputFields:['selling_points','title','keywords','main_image_lines','detail_opening','short_video','xhs','compliance','test_plan'],
  }),
  role({
    slug:'store-operator', key:'operator', name:'电商运营专家', short:'运营', avatar:'运', color:'#c9a227',
    description:'拼多多店铺诊断、测款推广、活动与复盘动作表。',
    mind:'你是拼多多店铺运营专家，以真实成交和净利润为目标。读取店铺阶段、主推款、指定时间窗的曝光、点击、访客、转化、客单、广告费用、推广成交、利润和售后，判断问题主要在流量、点击、转化、客单、供应还是售后。对自然流量、全站推广、搜索和场景推广、SKU、活动、主图、评价与 DSR 给具体建议。输出结论、理由、今日/本周/本月动作表；每条动作有目标、对象、参数建议、预算上限、停止条件和 3/7 日复盘节点。改价、调预算、改库存、报活动必须创建待审动作，不得声称已执行；决策引用具体数据与报告版本。',
    tools:['knowledge.search','pdd.report.read','calc.metrics','calc.unit_economics','action.create','file.write'],
    taskTitle:'店铺诊断与运营动作',
    taskPlaceholder:'例如：根据近 7 日推广报表诊断折叠桌面手机支架，给出今日/本周/本月动作和待审改价。',
    outputFields:['diagnosis','evidence','funnel','actions','budget','stop_conditions','review_at','risks'],
  }),
  role({
    slug:'presales-service', key:'presales', name:'售前客服', short:'售前', avatar:'售', color:'#3b9ec4',
    description:'依据已核实商品知识生成售前回复，识别需转售后的情形。',
    mind:'你是简短、耐心的拼多多售前客服。先直接回答顾客问题，再用已核实的店铺和 SKU 资料说明规格、用法、价格、赠品、物流、退换和购买建议。严格区分“发出”和“送达”；优惠、库存、到货时间只能读取本店当前事实，未知项标待确认，不承诺。已购、破损、丢件、少发错发、退换等情形要转售后，并带上原始问题、订单引用、SKU、证据和已有回复。每条回复不超过三行，不用对抗性语言；涉及外发时只生成待审草稿，不声称已发送。',
    tools:['knowledge.search','sku.read','ticket.read','ticket.create','ticket.update','file.read','file.write'],
    taskTitle:'售前回复与转售后判断',
    taskPlaceholder:'例如：顾客问折叠桌面手机支架明天能不能到、有没有赠品，写一条回复并判断是否转售后。',
    outputFields:['reply','facts_used','unknowns','transfer_after_sales','tone_check'],
  }),
  role({
    slug:'aftersales-service', key:'aftersales', name:'售后客服', short:'售后', avatar:'后', color:'#d05656',
    description:'售后分级、核证、处理方案与待审补偿动作。',
    mind:'你是拼多多售后客服，处理破损、质量、物流、少发错发、使用、维修、退换、退款、差价和发票。先安抚，再核订单、物流、SKU、图片或视频、处理规则和责任。方案要说明适用条件和需要的证据；涉及补偿先询问顾客期望，金额与承诺以已审核方案为准，不主动报金额、不虚假承诺、不诱导改评价。输出问题类型、严重程度、顾客情绪、责任依据、待补证据、处理选项、1-2 条安抚或核实回复、下一步和实际结果。涉及发信、补发、退款、发券时创建具体待审动作，并写回同一工单。',
    tools:['knowledge.search','ticket.read','ticket.update','action.create','file.read','file.write'],
    taskTitle:'售后分级与处理方案',
    taskPlaceholder:'例如：顾客收到支架底座开裂、情绪激动，只有外箱照，给出补证、安抚和待审补发方案。',
    outputFields:['issue_type','severity','emotion','responsibility','evidence_needed','options','reply','next_step','action'],
  }),
  role({
    slug:'data-analyst', key:'data', name:'数据分析员', short:'数据', avatar:'数', color:'#6c7a89',
    description:'数据质量、漏斗、推广指标、利润与复盘建议。',
    mind:'你是拼多多数据分析员。先确定分析目标、时间、数据来源和指标口径，再去重、处理空值、错误格式和异常。分析曝光→点击→下单→成交漏斗，支持渠道、商品、SKU、活动和计划对比；数据足够时做同比环比。指标必须显示分子、分母、日期和归因窗口；分母为零或缺数时说明原因，不生成错误指标。区分已观察到的问题、原因假设和验证所需证据。输出数据质量报告、指标字典、计算表、漏斗、盈亏平衡 ROAS，以及至少三条“数据→原因假设→动作”；数据不足时给当前可算结果和补数清单，并给 3-7 日复盘节点。',
    tools:['knowledge.search','pdd.report.read','calc.metrics','calc.unit_economics','report.import','mcp.call','file.write'],
    taskTitle:'数据体检与漏斗诊断',
    taskPlaceholder:'例如：分析近 7 日推广报表的质量、漏斗和 ROAS，指出需修复行并给三条动作。',
    outputFields:['quality','metrics','funnel','findings','actions','review_at','data_gaps'],
  }),
];

export const ROLE_BY_SLUG = Object.fromEntries(ROLES.map(r => [r.slug, r]));

// 83 条原始绑定，逐岗顺序与文档一致。
const BINDINGS = {
  'market-analyst': ['data-analyst','market-researcher','browser-use','china-shopping-oracle','complex-task-executor','data-cleaning-and-statistical-analysis-skill','mcp-installer','pinduoduo','skill-creator','webfetch','wechat-article-search'],
  'product-sourcing': ['1688-price-monitor','1688-product-find','1688-product-search','ecommerce-engine','ecommerce-search','competitive-analysis','complex-task-executor','data-analysis','ecommerce-analyzer','ecommerce-product-selector','mcp-installer','skill-creator','wechat-article-search'],
  'visual-designer': ['ai-image-enhancer','ai-intelligent-image-generation','complex-task-executor','ecommerce-image-suite','goods-images','image-edit','jimeng-image-gen','mcp-installer','skill-creator'],
  'copywriter': ['ai-humanizer','china-ecommerce-copywriter','complex-task-executor','digital-product-listing','marjorie-admapix','mcp-installer','pinduoduo-listing','skill-creator','taobao-listing','xiaohongshucreator'],
  'store-operator': ['marketing-psychology','automate-excel','business-roi-calculator','china-shopping-assistant','cn-ecommerce-search-v2','complex-task-executor','customer-service-reply','data-analysis','douyin-hot-trend-1','ecommerce-content-marketing','ecommerce-copy-humanizer','ecommerce-review-analyzer','effective-competitive-analysis','famou-data-analysis','mcp-installer','pinduoduo-listing','profit-margin-calculator','skill-creator','pdd-researcher','toby-seo-audit','word-docx'],
  'presales-service': ['china-ecommerce-customer-service','complex-task-executor','customer-service-reply','ecommerce-customer-service-pro','mcp-installer','skill-creator'],
  'aftersales-service': ['china-ecommerce-customer-service','complex-task-executor','customer-service-reply','ecommerce-customer-service-pro','mcp-installer','skill-creator'],
  'data-analyst': ['complex-task-executor','data','data-analyst-cn-zc','data-cleaning-and-statistical-analysis-skill','ecommerce-multi-analyzer','mcp-installer','skill-creator'],
};

export const SKILL_BINDINGS = [];
let bindingIndex = 0;
for (const employeeSlug of ROLE_SLUGS) {
  for (const skillSlug of BINDINGS[employeeSlug]) {
    bindingIndex += 1;
    SKILL_BINDINGS.push({
      index: bindingIndex,
      employeeSlug,
      skillSlug,
      originalName: skillSlug,
      origin: '《AI数字员工提示词+skill.docx》第六节初始绑定',
    });
  }
}

if (SKILL_BINDINGS.length !== 83) throw new Error('83 条原始绑定校验失败：' + SKILL_BINDINGS.length);

export const SUPPLEMENT_SKILLS = [
  { slug:'1688-ranking', name:'1688 榜单', version:'1.0.4', origin:'原站补充项（非 83 条初始绑定）', employeeSlug:'product-sourcing' },
];

export const SKILL_LABELS = {
  '1688-price-monitor':'1688 价格监控','1688-product-find':'1688 智能找货','1688-product-search':'1688 商品搜索',
  '1688-ranking':'1688 榜单','market-researcher':'市场研究','browser-use':'浏览器使用','china-shopping-oracle':'中国购物洞察',
  'complex-task-executor':'复杂任务执行器','data-cleaning-and-statistical-analysis-skill':'数据清洗与统计分析',
  'mcp-installer':'MCP 安装器','pinduoduo':'拼多多','skill-creator':'技能创建器','webfetch':'网页抓取',
  'wechat-article-search':'微信文章搜索','data-analyst':'数据分析','ecommerce-engine':'电商引擎','ecommerce-search':'电商搜索',
  'competitive-analysis':'竞品分析','data-analysis':'数据分析','ecommerce-analyzer':'电商分析','ecommerce-product-selector':'电商选品',
  'ai-image-enhancer':'AI 图片增强','ai-intelligent-image-generation':'AI 智能生图','ecommerce-image-suite':'电商图片套件',
  'goods-images':'商品图片','image-edit':'图片编辑','jimeng-image-gen':'即梦生图','ai-humanizer':'AI 去味',
  'china-ecommerce-copywriter':'中国电商文案','digital-product-listing':'数字商品上架','marjorie-admapix':'广告文案',
  'pinduoduo-listing':'拼多多上架','taobao-listing':'淘宝上架','xiaohongshucreator':'小红书创作','marketing-psychology':'营销心理学',
  'automate-excel':'Excel 自动化','business-roi-calculator':'ROI 计算器','china-shopping-assistant':'中国购物助手',
  'cn-ecommerce-search-v2':'中国电商搜索 v2','customer-service-reply':'客服回复','douyin-hot-trend-1':'抖音热点',
  'ecommerce-content-marketing':'电商内容营销','ecommerce-copy-humanizer':'电商文案去味','ecommerce-review-analyzer':'评价分析',
  'effective-competitive-analysis':'有效竞品分析','famou-data-analysis':'Famou 数据分析','profit-margin-calculator':'利润计算器',
  'pdd-researcher':'拼多多研究','toby-seo-audit':'SEO 审计','word-docx':'Word 文档','china-ecommerce-customer-service':'中国电商客服',
  'ecommerce-customer-service-pro':'电商客服专家','data':'数据','data-analyst-cn-zc':'中文数据分析','ecommerce-multi-analyzer':'电商多维分析'
};

export const TOOL_CATALOG = {
  'knowledge.search':{ label:'知识检索', description:'按项目/SKU 检索已核验知识、政策、FAQ 与平台规则。', kind:'read', defaultLevel:'L1' },
  'knowledge.read':{ label:'知识读取', description:'读取单条知识及其来源、适用时间和核验状态。', kind:'read', defaultLevel:'L1' },
  'project.read':{ label:'项目读取', description:'读取项目范围、店铺事实和目标。', kind:'read', defaultLevel:'L1' },
  'sku.read':{ label:'SKU 读取', description:'读取 SKU 规格、价格、成本与证据版本。', kind:'read', defaultLevel:'L1' },
  'pdd.search':{ label:'拼多多商品检索', description:'调用多多进宝推广商品检索，返回可复查商品标识。', kind:'external', defaultLevel:'L1' },
  'pdd.report.read':{ label:'店铺报表读取', description:'读取已导入或已授权的店铺/推广报表。', kind:'read', defaultLevel:'L1' },
  'ali1688.search':{ label:'1688 找货', description:'调用 1688 找货网关，按商品 ID 去重并保留报价规格。', kind:'external', defaultLevel:'L1' },
  'ali1688.detail':{ label:'1688 详情核验', description:'核对商品详情、SKU、阶梯价、起订量与供应商。', kind:'external', defaultLevel:'L1' },
  'market.search':{ label:'公开市场搜索', description:'调用 Tavily 公开搜索并保留 URL、时间和证据范围。', kind:'external', defaultLevel:'L1' },
  'calc.unit_economics':{ label:'单件利润核算', description:'后端确定性计算售价、费用、贡献和盈亏平衡 ROAS。', kind:'compute', defaultLevel:'L1' },
  'calc.metrics':{ label:'推广指标计算', description:'确定性计算 CTR、转化率、CPC、ROAS，处理零分母。', kind:'compute', defaultLevel:'L1' },
  'report.import':{ label:'报表导入', description:'CSV/Excel 预览、字段映射、异常行与去重。', kind:'write', defaultLevel:'L2' },
  'file.read':{ label:'文件读取', description:'读取本项目已授权附件或产物。', kind:'read', defaultLevel:'L1' },
  'file.write':{ label:'文件写入', description:'把可读产物写入本任务工作区并登记校验值。', kind:'write', defaultLevel:'L2' },
  'image.prompt':{ label:'出图提示词', description:'按逐图脚本生成可直接提交的生图提示词。', kind:'compute', defaultLevel:'L1' },
  'image.generate':{ label:'生图/合成图', description:'提交生图任务或使用本地合成器产出可打开图片。', kind:'external', defaultLevel:'L2' },
  'ticket.create':{ label:'创建售后工单', description:'把售前问题连同订单、SKU、证据转成工单。', kind:'write', defaultLevel:'L2' },
  'ticket.read':{ label:'工单读取', description:'读取工单状态、证据和已有回复。', kind:'read', defaultLevel:'L1' },
  'ticket.update':{ label:'工单更新', description:'写回分级、方案、证据和处理回执。', kind:'write', defaultLevel:'L2' },
  'action.create':{ label:'创建待审动作', description:'创建改价、预算、补发、退款、外发等待审动作。', kind:'write', defaultLevel:'L2' },
  'mcp.call':{ label:'MCP 工具调用', description:'经受信 MCP 服务调用已授权工具并回读结果。', kind:'external', defaultLevel:'L1' },
};

export const STATUS_LABELS = {
  draft:'草稿', needs_info:'待资料', awaiting_authorization:'等待授权', queued:'排队中', running:'运行中',
  pending_review:'待审核', success:'成功', failed:'失败', rejected:'已拒绝', unknown_result:'结果待确认',
  paused:'已暂停', approved:'已批准', executed:'已执行', cancelled:'已取消', skipped:'已跳过', blocked:'已阻断',
};

export const ACTION_KINDS = {
  publish_listing:'上架发布', change_price:'改价', change_budget:'调预算', change_stock:'改库存',
  join_campaign:'报活动', send_customer_message:'客服发送', refund:'退款', reship:'补发', coupon:'发券',
  contact_supplier:'联系供应商', sample_order:'下样单', write_file:'写入文件',
  approve_creative:'图稿审核', approve_listing:'上架资料审核'
};

export const KNOWLEDGE_KINDS = ['店铺政策','商品知识','FAQ','供应商报价','平台规则','检测材料','经营事实'];
export const VERIFICATION_LABELS = { verified:'已核验', pending:'待核验', historical:'历史回放', synthetic:'合成演示', extracted:'自动提取', rejected:'已驳回' };
