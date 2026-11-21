import {ROLE_BY_SLUG} from './constants.js';
import {validateShape} from './model.js';

const array = (minItems = 1) => ({type:'array', minItems});
const string = {type:'string', required:true};
const object = (required = true) => ({type:'object', required});

export const ROLE_SCHEMAS = {
  'market-analyst': {
    shape: {
      summary:string, market_size:string, cagr:{type:'string'}, penetration:{type:'string'},
      segments:array(1), competition:string, risks:array(1), rating:object(true),
      handoff:object(true), sources:array(1),
    },
    example: {
      summary:'一句话判断', market_size:'估算值与来源/算式，缺数据写待验证', cagr:'例如 8%（来源/算式）',
      penetration:'拼多多渠道渗透判断，标明估算', segments:[{name:'租房上班族', need:'桌面追剧/办公', price_band:'19.9-39.9 元'}],
      competition:'竞争格局与进入壁垒', risks:['需求风险：…','供应风险：…'],
      rating:{prospect:'7/10', potential:'6/10', timing:'观望，先小规模验证'},
      handoff:{audience:'…', price_band:'…', budget:'1000 元测款', product_directions:['折叠支架'], hypotheses:['…']},
      sources:[{title:'来源', url:'https://…', note:'采集时间与口径'}],
    },
  },
  'product-sourcing': {
    shape: {
      directions:array(1), queries:array(1), candidates:array(1),
      recommended:object(true), profit:object(true), sample_checklist:array(1), risks:array(1), data_gaps:array(1),
    },
    example: {
      directions:['折叠桌面手机支架·铝合金·一件代发'],
      queries:['折叠桌面手机支架','桌面手机支架 折叠 铝合金'],
      candidates:[{product_id:'真实商品 ID 或历史回放 ID', title:'标题', price:'11.00 元', moq:1, supplier:'供应商或缺失', source:'1688/历史回放/合成演示', note:'规格与运费口径'}],
      recommended:{sku_id:'sku-demo-standard', reason:'…', suggested_price:'29.90 元'},
      profit:{pre_ad:'12.01 元', post_ad:'7.01 元', rate:'40.17%', break_even_roas:'2.49'},
      sample_checklist:['核对材质','核对承重','核对包装'], risks:['…'], data_gaps:['1688 AK 过期，实时报价缺失'],
    },
  },
  'visual-designer': {
    shape: {
      strategies:array(2), selected:string, main_images:array(1), detail_screens:array(1),
      prompts:array(1), asset_checklist:array(1), quality_check:array(1), iteration:string,
    },
    example: {
      strategies:[{name:'A 版·极致清晰', concept:'浅色桌面+手机实拍', palette:'米白/黑', main_selling:'折叠不占地', metric:'点击率'},{name:'B 版·场景信任', concept:'办公桌场景', palette:'灰蓝', main_selling:'追剧办公两用', metric:'转化率'}],
      selected:'A 版', main_images:[{index:1, purpose:'点击理由', visual:'…', copy:'折叠不占地', evidence:'合成演示'}],
      detail_screens:[{index:1, purpose:'痛点', visual:'…', copy:'…', evidence:'待核'}],
      prompts:['主图 1：…'], asset_checklist:['原图 800x800'], quality_check:['尺寸 800x800','无极限词'], iteration:'CTR 低先改第 1 张',
    },
  },
  'copywriter': {
    shape: {
      selling_points:array(1), title:string, keywords:array(1), main_image_lines:array(1),
      detail_opening:array(3), short_video:string, compliance:array(1), test_plan:string,
    },
    example: {
      selling_points:[{point:'折叠收纳', benefit:'桌面不占地', evidence:'商品事实（待复核）'}],
      title:'折叠桌面手机支架 追剧办公通用 黑色', keywords:['折叠手机支架','桌面支架','追剧'],
      main_image_lines:[{a:'折叠不占地', b:'桌面更清爽'}],
      detail_opening:['桌面总是被支架占满？','折叠收起，展开即用。','两个规格，按手机尺寸选。'],
      short_video:'15 秒口播：桌面乱？…', compliance:['未使用极限词','材质待核'],
      test_plan:'主图 A/B 3-5 天，观察 CTR',
    },
  },
  'store-operator': {
    shape: {
      diagnosis:string, evidence:array(1), funnel:object(true), actions:array(1),
      budget:string, stop_conditions:array(1), review_at:string, risks:array(1),
    },
    example: {
      diagnosis:'点击率 3%，转化 5%，ROAS 3.00，接近盈亏平衡 2.49；问题在…',
      evidence:['报表 report-demo-promo 近 7 日'],
      funnel:{impressions:10000,clicks:300,orders:15,ctr:'3%',cvr:'5%'},
      actions:[{priority:'P0', object:'主图', parameter:'A/B 测试第 1 张', budget:'50 元/天', stop_condition:'3 天 CTR <2% 停', review_at:'3 日后'}],
      budget:'100 元/日上限', stop_conditions:['ROAS 低于 2.49 连续 2 日'], review_at:'3 日/7 日', risks:['数据为合成演示'],
    },
  },
  'presales-service': {
    shape: {
      reply:string, facts_used:array(1), unknowns:array(1), transfer_after_sales:object(true), tone_check:string,
    },
    example: {
      reply:'亲，这款 48 小时内发出，送达时间以物流为准；目前没有已核实赠品。',
      facts_used:['发货时效：48 小时内发出（合成演示）'], unknowns:['具体送达日期','赠品'],
      transfer_after_sales:{needed:false, reason:'未涉及已购/破损/退换'}, tone_check:'简短、无对抗性、未承诺未核实事项',
    },
  },
  'aftersales-service': {
    shape: {
      issue_type:string, severity:string, emotion:string, responsibility:string,
      evidence_needed:array(1), options:array(1), reply:string, next_step:string, action:object(true),
    },
    example: {
      issue_type:'破损', severity:'高', emotion:'高', responsibility:'倾向商家/物流，待近照核实',
      evidence_needed:['商品破损近照','外箱六面照'], options:['补发','退货退款','补偿券（待审核）'],
      reply:'亲，非常抱歉…请补一张破损近照，我们马上为您处理。', next_step:'收到证据后提交补发待审动作',
      action:{kind:'reship', amount_cents:0, reason:'待证据齐全后补发'},
    },
  },
  'data-analyst': {
    shape: {
      quality:object(true), metrics:object(true), funnel:object(true), findings:array(1),
      actions:array(1), review_at:string, data_gaps:array(1),
    },
    example: {
      quality:{valid_rows:7, invalid_rows:5, note:'5 行需修复'},
      metrics:{ctr:'3%', click_cvr:'5%', cpc:'0.50 元', roas:'3.00'},
      funnel:{impressions:10000,clicks:300,orders:15},
      findings:['点击率 3% 高于样本目标，但访客转化 1.5% 偏低'],
      actions:[{data:'ROAS 3.00', hypothesis:'素材相关', action:'A/B 主图'}],
      review_at:'3 日后', data_gaps:['缺少自然流量拆分'],
    },
  },
};

const SKELETONS = {
  'market-analyst': {summary:'',market_size:'',cagr:'',penetration:'',segments:[{name:'',need:'',price_band:''}],competition:'',risks:[],rating:{prospect:'',potential:'',timing:''},handoff:{audience:'',price_band:'',budget:'',product_directions:[],hypotheses:[]},sources:[{title:'',url:'',note:''}]},
  'product-sourcing': {directions:[],queries:[],candidates:[{product_id:'',title:'',price:'',moq:0,supplier:'',source:'',note:''}],recommended:{sku_id:'',reason:'',suggested_price:''},profit:{pre_ad:'',post_ad:'',rate:'',break_even_roas:''},sample_checklist:[],risks:[],data_gaps:[]},
  'visual-designer': {strategies:[{name:'',concept:'',palette:'',main_selling:'',metric:''}],selected:'',main_images:[{index:1,purpose:'',visual:'',copy:'',evidence:''}],detail_screens:[{index:1,purpose:'',visual:'',copy:'',evidence:''}],prompts:[],asset_checklist:[],quality_check:[],iteration:''},
  'copywriter': {selling_points:[{point:'',benefit:'',evidence:''}],title:'',keywords:[],main_image_lines:[{a:'',b:''}],detail_opening:[],short_video:'',compliance:[],test_plan:''},
  'store-operator': {diagnosis:'',evidence:[],funnel:{impressions:0,clicks:0,orders:0,ctr:'',cvr:''},actions:[{priority:'',object:'',parameter:'',budget:'',stop_condition:'',review_at:''}],budget:'',stop_conditions:[],review_at:'',risks:[]},
  'presales-service': {reply:'',facts_used:[],unknowns:[],transfer_after_sales:{needed:false,reason:''},tone_check:''},
  'aftersales-service': {issue_type:'',severity:'',emotion:'',responsibility:'',evidence_needed:[],options:[],reply:'',next_step:'',action:{kind:'',amount_cents:0,reason:''}},
  'data-analyst': {quality:{valid_rows:0,invalid_rows:0,note:''},metrics:{ctr:'',click_cvr:'',cpc:'',roas:''},funnel:{impressions:0,clicks:0,orders:0},findings:[],actions:[{data:'',hypothesis:'',action:''}],review_at:'',data_gaps:[]},
};

export function schemaPrompt(roleSlug) {
  const schema = ROLE_SCHEMAS[roleSlug];
  if (!schema) return '输出 JSON。';
  return [
    '只输出一个 JSON 对象，不要 markdown，不要解释，不要长篇思考。',
    '结构（空字符串、0、空数组必须替换为本次内容）：' + JSON.stringify(SKELETONS[roleSlug] || schema.example),
    '要求：字段简短；数组最多 3 项；设计岗主图/详情各给 1 条即可，后端会补足 5 图/7 屏；所有数字来自输入或工具，缺数据写“待核”；不得照抄空值或说明文字。',
  ].join('\n');
}

export function validateRoleOutput(roleSlug, output) {
  const schema = ROLE_SCHEMAS[roleSlug];
  if (!schema) return [{path:'$', message:'未知岗位'}];
  return validateShape(output, schema.shape);
}

const text = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('；');
  return JSON.stringify(value, null, 2);
};

export function renderMarkdown({role, project, sku, output, computed, run, artifacts = [], toolReceipts = []}) {
  const roleInfo = ROLE_BY_SLUG[role];
  const block = '~~~~json';
  const lines = [];
  lines.push('# ' + (roleInfo?.name || role) + ' · ' + project.name + (sku ? ' · ' + sku.name : ''));
  lines.push('');
  lines.push('- 运行：' + run.id + '（' + run.status + '）');
  lines.push('- 员工心智版本：' + (run.mind_version || '1.0.0'));
  lines.push('- 模型：' + (run.provider_model || run.model_id || '未记录'));
  lines.push('- 生成时间：' + (run.finished_at || run.created_at));
  lines.push('- 数据性质：合成演示 / 历史回放 / 真实调用以各节标记为准；不可当作真实销量或承诺。');
  lines.push('');
  if (role === 'market-analyst') {
    lines.push('## 结论', text(output.summary), '');
    lines.push('## 市场与竞争', '- 规模：' + text(output.market_size), '- CAGR：' + text(output.cagr), '- 渗透：' + text(output.penetration), '- 竞争：' + text(output.competition), '');
    lines.push('## 细分与交接', block, JSON.stringify({segments:output.segments, handoff:output.handoff}, null, 2), '~~~~', '');
    lines.push('## 风险', ...(output.risks || []).map(item => '- ' + text(item)), '');
    lines.push('## 评级', block, JSON.stringify(output.rating, null, 2), '~~~~', '');
  } else if (role === 'product-sourcing') {
    lines.push('## 方向与搜索词', (output.directions || []).map(item => '- ' + text(item)).join('\n'), '', (output.queries || []).map(item => '「' + text(item) + '」').join(' '), '');
    lines.push('## 候选与报价', block, JSON.stringify(output.candidates, null, 2), '~~~~', '');
    lines.push('## 推荐与利润', block, JSON.stringify({recommended:output.recommended, profit:output.profit}, null, 2), '~~~~', '');
    lines.push('## 拿样与风险', ...(output.sample_checklist || []).map(item => '- [ ] ' + text(item)), ...(output.risks || []).map(item => '- ⚠️ ' + text(item)), '');
    lines.push('## 数据缺口', ...(output.data_gaps || []).map(item => '- ' + text(item)), '');
  } else if (role === 'visual-designer') {
    lines.push('## 两套策略', ...(output.strategies || []).map(item => '- ' + text(item)), '', '选定：' + text(output.selected), '');
    lines.push('## 五张主图脚本', ...(output.main_images || []).map(item => '- 第 ' + (item.index || '?') + ' 张｜' + text(item.purpose) + '｜文案：' + text(item.copy) + '｜画面：' + text(item.visual) + '｜证据：' + text(item.evidence)), '');
    lines.push('## 详情逐屏', ...(output.detail_screens || []).map(item => '- 第 ' + (item.index || '?') + ' 屏｜' + text(item.purpose) + '｜' + text(item.copy) + '｜证据：' + text(item.evidence)), '');
    lines.push('## 出图提示词', ...(output.prompts || []).map(item => '- ' + text(item)), '');
    lines.push('## 质检与迭代', ...(output.quality_check || []).map(item => '- ' + text(item)), '- 复盘：' + text(output.iteration), '');
  } else if (role === 'copywriter') {
    lines.push('## 卖点', ...(output.selling_points || []).map(item => '- ' + text(item.point) + ' → ' + text(item.benefit) + '（证据：' + text(item.evidence) + '）'), '');
    lines.push('## 标题与关键词', text(output.title), '', (output.keywords || []).map(item => '「' + text(item) + '」').join(' '), '');
    lines.push('## 主图短句', ...(output.main_image_lines || []).map(item => '- A：' + text(item.a) + '／B：' + text(item.b)), '');
    lines.push('## 详情首屏', ...(output.detail_opening || []).map(item => '> ' + text(item)), '');
    lines.push('## 15 秒口播', text(output.short_video), '');
    lines.push('## 合规检查', ...(output.compliance || []).map(item => '- ' + text(item)), '- 测试：' + text(output.test_plan), '');
  } else if (role === 'store-operator') {
    lines.push('## 诊断', text(output.diagnosis), '');
    lines.push('## 证据与漏斗', ...(output.evidence || []).map(item => '- ' + text(item)), block, JSON.stringify(output.funnel, null, 2), '~~~~', '');
    lines.push('## 动作表', '| 优先级 | 对象 | 参数 | 预算上限 | 停止条件 | 复盘 |', '| --- | --- | --- | --- | --- | --- |',
      ...(output.actions || []).map(item => '| ' + [text(item.priority), text(item.object), text(item.parameter), text(item.budget), text(item.stop_condition || item.stop_conditions), text(item.review_at)].join(' | ') + ' |'), '');
    lines.push('## 预算与止损', text(output.budget), ...(output.stop_conditions || []).map(item => '- ' + text(item)), '- 复盘节点：' + text(output.review_at), '');
  } else if (role === 'presales-service') {
    lines.push('## 回复草稿', '> ' + text(output.reply), '');
    lines.push('## 使用事实', ...(output.facts_used || []).map(item => '- ' + text(item)), '');
    lines.push('## 待确认', ...(output.unknowns || []).map(item => '- ' + text(item)), '');
    lines.push('## 转售后', block, JSON.stringify(output.transfer_after_sales, null, 2), '~~~~', '');
  } else if (role === 'aftersales-service') {
    lines.push('## 诊断', '- 类型：' + text(output.issue_type), '- 严重度：' + text(output.severity), '- 情绪：' + text(output.emotion), '- 责任：' + text(output.responsibility), '');
    lines.push('## 待补证据', ...(output.evidence_needed || []).map(item => '- [ ] ' + text(item)), '');
    lines.push('## 处理选项', ...(output.options || []).map(item => '- ' + text(item)), '');
    lines.push('## 回复草稿', '> ' + text(output.reply), '', '下一步：' + text(output.next_step), '');
    lines.push('## 待审动作', block, JSON.stringify(output.action, null, 2), '~~~~', '');
  } else if (role === 'data-analyst') {
    lines.push('## 数据质量', block, JSON.stringify(output.quality, null, 2), '~~~~', '');
    lines.push('## 指标与漏斗', block, JSON.stringify({metrics:output.metrics, funnel:output.funnel}, null, 2), '~~~~', '');
    lines.push('## 发现', ...(output.findings || []).map(item => '- ' + text(item)), '');
    lines.push('## 数据 → 原因假设 → 动作', ...(output.actions || []).map(item => '- ' + text(item.data) + ' → ' + text(item.hypothesis) + ' → ' + text(item.action)), '');
    lines.push('## 复盘与补数', '- 复盘：' + text(output.review_at), ...(output.data_gaps || []).map(item => '- 缺：' + text(item)), '');
  }
  if (computed?.unitEconomics) {
    lines.push('', '## 确定性利润核算（后端计算）', block, JSON.stringify(computed.unitEconomics, null, 2), '~~~~', '');
  }
  if (computed?.metrics) {
    lines.push('', '## 确定性指标（后端计算）', block, JSON.stringify(computed.metrics, null, 2), '~~~~', '');
  }
  if (toolReceipts.length) {
    lines.push('', '## 工具回执', '| 工具 | 状态 | 环境 | 回执编号 | 耗时 |', '| --- | --- | --- | --- | --- |',
      ...toolReceipts.map(item => '| ' + item.tool_key + ' | ' + item.status + ' | ' + item.environment + ' | ' + (item.receipt_id || '-') + ' | ' + (item.duration_ms ?? '-') + ' ms |'), '');
  }
  if (artifacts.length) {
    lines.push('', '## 产物文件', ...artifacts.map(item => '- ' + item.title + '：' + item.id + (item.file_id ? '（文件 ' + item.file_id + '）' : '')), '');
  }
  lines.push('', '---', '本产物由 OPC 工作台生成，数据性质以文中标记为准；外部写入需经审批并取得第三方回执。');
  return lines.join('\n');
}

export function expandDesignOutput(output, context) {
  const notes = [];
  const main = Array.isArray(output.main_images) ? output.main_images.slice(0, 5) : [];
  const purposes = ['商品全貌','结构细节','实物特写','场景构图','选购信息'];
  while (main.length < 5) {
    const index = main.length + 1;
    main.push({index, purpose:purposes[index-1], visual:'根据已核验的商品参考图设计构图', copy:purposes[index-1], evidence:'后端构图模板；商品事实待核'});
    notes.push('补足主图 ' + index + '（后端构图模板）');
  }
  const detail = Array.isArray(output.detail_screens) ? output.detail_screens.slice(0, 10) : [];
  const detailPurposes = ['商品全貌','结构细节','外观视角','使用场景构图','选购信息','规格信息区','售后信息区','参考图细节','商品组合构图','信息总结'];
  while (detail.length < 7) {
    const index = detail.length + 1;
    detail.push({index, purpose:detailPurposes[index-1], visual:'根据核验后的参考图制作，未核验信息留空', copy:detailPurposes[index-1], evidence:'后端构图模板；商品事实待核'});
    notes.push('补足详情屏 ' + index + '（后端构图模板）');
  }
  const prompts = main.map((item, index) => '主图 ' + (index + 1) + '，800x800，根据核验后的商品参考图设计构图，文字区留白，保持产品结构。');
  return {output:{...output, main_images:main, detail_screens:detail, prompts}, notes};
}

export function designPromptPackage(output, context, toolResults = {}) {
  const skuId = context.sku?.id || null;
  const skuName = context.sku?.name || '待选择 SKU';
  const productName = context.project?.name || '当前商品';
  const verified = (toolResults.knowledge?.items || []).filter(item => item.verification === 'verified' && item.kind === '商品知识');
  const facts = verified.map(item => ({id:item.id, body:item.body, source:item.source}));
  const factText = facts.length
    ? facts.map(item => item.body + '（来源 ' + item.id + '）').join('；')
    : '尚无已核验商品资料。先补齐与当前 SKU 对应的实物参考图及商品事实，再提交外部生图。';
  const negative = '不生成文字、水印、品牌 logo、检测报告、认证标志、赠品、具体价格、次日达、夸张承重；不改变产品结构。不凭空补充材质、尺寸、适配范围、包装或配送承诺。';
  const mainPlans = [
    ['商品全貌','完整商品参考图，干净浅色背景，主体占画面约 60%，四周留白，柔和光照。'],
    ['结构细节','基于参考图中确实可见的结构做局部特写，保留真实连接方式与各部件比例。'],
    ['实物特写','选取参考图中清晰可见的外观细节，真实摄影风格，柔光背景，不额外添加材质纹理。'],
    ['场景构图','围绕商品安排简洁桌面背景，背景物件不接触商品，不演示未经核验的用途或功能。'],
    ['选购信息','展示同一 SKU 的参考外观，留出后期添加核实信息的区域，主体清晰完整。'],
  ];
  const detailPlans = [
    ['商品全貌','竖幅展示商品完整外观，上下留出后期排版区域。'],
    ['结构细节','围绕实物参考图中可见的结构设计放大细节，不新增部件或功能。'],
    ['外观视角','使用已提供的实物角度；缺少的视角保持待补，不推测背面或内部结构。'],
    ['使用场景构图','商品旁配置简洁生活场景，背景不暗示未经核验的尺寸、承重、适配或功能。'],
    ['选购信息','商品与空白信息卡片位置构图，卡片保持空白，供后期填入已核验卖点。'],
    ['规格信息区','商品参考图与空白规格区排版，不绘制任何未经核验的尺寸线或参数数值。'],
    ['售后信息区','商品参考图配干净留白区，供经营者后期填写已确认的售后条款。'],
    ['参考图细节','从实物参考图选取另一处清晰细节，保持形状、颜色与可见结构一致。'],
    ['商品组合构图','同一 SKU 在原图支持的角度下进行组合排版，不增加配件、包装或赠品。'],
    ['信息总结','主体商品配整洁留白区域，供后期整理已核验信息。'],
  ];
  const item = (type, plan, index) => {
    const width = type === 'main' ? 800 : 750;
    const height = type === 'main' ? 800 : 1000;
    return {type, index:index + 1, filename:type + '-' + (index + 1) + '.png', width, height,
      headline:plan[0], subline:facts.length ? '商品信息按已核验资料排版' : '商品事实与参考图待核验',
      prompt:'为「' + productName + '」的 SKU「' + skuName + '」（' + (skuId || '待补') + '）制作电商商品图，画布 ' + width + 'x' + height + '。'
        + '以对应 SKU 的已核验实物参考图为外观依据，保持颜色、比例、结构一致。' + plan[1]
        + '已核验事实：' + factText + '主文案和辅助文案供后期排版，画面内文字区保持留白。负面约束：' + negative,
      negative, sku_id:skuId, sku_name:skuName, status:'prompt_only', source:'后端构图模板及已核验商品知识',
      fact_status:facts.length ? 'verified' : 'pending', evidence:facts.map(fact => fact.id)};
  };
  const detailCount = Math.max(7, Math.min(10, output.detail_screens?.length || 7));
  return {main:mainPlans.map((plan,index) => item('main',plan,index)),
    detail:detailPlans.slice(0,detailCount).map((plan,index) => item('detail',plan,index)), facts};
}

const str = {type:'string'};
const strArray = {type:'array', items:{type:'string'}};
const obj = (properties, required) => ({type:'object', properties, required});

export const ROLE_SECTIONS = {
  'market-analyst': [
    { key:'judgement', label:'市场判断', maxTokens:1400,
      prompt:'summary（一句话判断）、market_size（金额与来源/算式，缺数据写待核）、cagr、penetration、competition、risks（最多3条字符串）、rating{prospect,potential,timing}。',
      schema: obj({summary:str,market_size:str,cagr:str,penetration:str,competition:str,risks:strArray,rating:obj({prospect:str,potential:str,timing:str},['prospect','potential','timing'])},['summary','market_size','competition','risks','rating']) },
    { key:'handoff', label:'客群与选品交接', maxTokens:1200,
      prompt:'segments（最多3个{name,need,price_band}）、handoff{audience,price_band,budget,product_directions（最多3条）,hypotheses（最多3条）}、sources（最多3个{title,url,note}）。',
      schema: obj({segments:{type:'array',items:obj({name:str,need:str,price_band:str},['name','need','price_band'])},handoff:obj({audience:str,price_band:str,budget:str,product_directions:strArray,hypotheses:strArray},['audience','price_band','budget','product_directions','hypotheses']),sources:{type:'array',items:obj({title:str,url:str,note:str},['title','url','note'])}},['segments','handoff','sources']) },
  ],
  'product-sourcing': [
    { key:'search', label:'搜索方向与候选', maxTokens:1500,
      prompt:'directions（最多3条）、queries（最多5条）、candidates（最多5个{product_id,title,price,moq,supplier,source,note}）。真实 1688 失败时，历史回放和拼多多对照要分别标 source；不要编造商品 ID。',
      schema: obj({directions:strArray,queries:strArray,candidates:{type:'array',items:obj({product_id:str,title:str,price:str,moq:{type:'number'},supplier:str,source:str,note:str},['product_id','title','price','source'])}},['directions','queries','candidates']) },
    { key:'decision', label:'核价、主推与风险', maxTokens:1200,
      prompt:'recommended{sku_id,reason,suggested_price}、profit{pre_ad,post_ad,rate,break_even_roas}（必须引用后端核算）、sample_checklist（最多4条）、risks（最多3条）、data_gaps（最多3条）。',
      schema: obj({recommended:obj({sku_id:str,reason:str,suggested_price:str},['sku_id','reason','suggested_price']),profit:obj({pre_ad:str,post_ad:str,rate:str,break_even_roas:str},['pre_ad','post_ad','rate','break_even_roas']),sample_checklist:strArray,risks:strArray,data_gaps:strArray},['recommended','profit','sample_checklist','risks','data_gaps']) },
  ],
  'visual-designer': [
    { key:'strategy', label:'两套视觉策略', maxTokens:1300,
      prompt:'strategies（恰好2个，每个{name,concept,palette,main_selling,metric}）、selected（A 或 B 的 name）。只使用已核实卖点。',
      schema: obj({strategies:{type:'array',minItems:2,items:obj({name:str,concept:str,palette:str,main_selling:str,metric:str},['name','concept','palette','main_selling','metric'])},selected:str},['strategies','selected']) },
    { key:'assets', label:'五图与详情脚本', maxTokens:1600,
      prompt:'main_images（1条{index,purpose,visual,copy,evidence}）、detail_screens（1条{index,purpose,visual,copy,evidence}）、prompts（最多3条图像构图提示词）、asset_checklist（最多3条）、quality_check（最多3条）、iteration（一句话）。后端输出5张800x800主图和7-10屏750x1000详情提示词。只输出提示词，不生成图片。未经核验的材质、承重、尺寸、赠品、价格和时效不得作为事实；画面不生成文字、品牌logo或认证。',
      schema: obj({main_images:{type:'array',items:obj({index:{type:'number'},purpose:str,visual:str,copy:str,evidence:str},['index','purpose','visual','copy','evidence'])},detail_screens:{type:'array',items:obj({index:{type:'number'},purpose:str,visual:str,copy:str,evidence:str},['index','purpose','visual','copy','evidence'])},prompts:strArray,asset_checklist:strArray,quality_check:strArray,iteration:str},['main_images','detail_screens','prompts','quality_check']) },
  ],
  'copywriter': [
    { key:'core', label:'卖点、标题与主图短句', maxTokens:1300,
      prompt:'selling_points（最多3个{point,benefit,evidence}）、title（拼多多标题）、keywords（最多8个）、main_image_lines（最多3个{a,b}，每条不超过10字）。',
      schema: obj({selling_points:{type:'array',items:obj({point:str,benefit:str,evidence:str},['point','benefit','evidence'])},title:str,keywords:strArray,main_image_lines:{type:'array',items:obj({a:str,b:str},['a','b'])}},['selling_points','title','keywords','main_image_lines']) },
    { key:'detail', label:'详情、口播与合规', maxTokens:1200,
      prompt:'detail_opening（3-5句字符串数组）、short_video（约15秒口播）、compliance（最多4条检查结果）、test_plan（A/B 测试变量与指标）。',
      schema: obj({detail_opening:strArray,short_video:str,compliance:strArray,test_plan:str},['detail_opening','short_video','compliance','test_plan']) },
  ],
  'store-operator': [
    { key:'diagnosis', label:'诊断与证据', maxTokens:1300,
      prompt:'diagnosis（一句话根因）、evidence（最多3条，引用报表/阶段）、funnel{impressions,clicks,orders,ctr,cvr}、risks（最多3条）。数值必须与后端核算一致。',
      schema: obj({diagnosis:str,evidence:strArray,funnel:obj({impressions:{type:'number'},clicks:{type:'number'},orders:{type:'number'},ctr:str,cvr:str},['impressions','clicks','orders']),risks:strArray},['diagnosis','evidence','funnel','risks']) },
    { key:'actions', label:'今日/本周/本月动作', maxTokens:1500,
      prompt:'actions（3条{priority,object,parameter,budget,stop_condition,review_at}）、budget（预算上限）、stop_conditions（最多3条）、review_at（复盘节点）。改价/预算/库存/活动只写建议，后端创建待审动作。',
      schema: obj({actions:{type:'array',minItems:1,items:obj({priority:str,object:str,parameter:str,budget:str,stop_condition:str,review_at:str},['priority','object','parameter','budget','stop_condition','review_at'])},budget:str,stop_conditions:strArray,review_at:str},['actions','budget','stop_conditions','review_at']) },
  ],
  'presales-service': [
    { key:'reply', label:'售前回复与转售后', maxTokens:1400,
      prompt:'reply（不超过3行，直接回答）、facts_used（最多3条已核实事实）、unknowns（最多3条待确认）、transfer_after_sales{needed（布尔）,reason}、tone_check（一句话）。不得承诺送达日期、赠品、库存或优惠。',
      schema: obj({reply:str,facts_used:strArray,unknowns:strArray,transfer_after_sales:obj({needed:{type:'boolean'},reason:str},['needed','reason']),tone_check:str},['reply','facts_used','unknowns','transfer_after_sales','tone_check']) },
  ],
  'aftersales-service': [
    { key:'diagnosis', label:'售后分级与证据', maxTokens:1300,
      prompt:'issue_type、severity（高/中/低）、emotion（高/中/低）、responsibility（责任判断）、evidence_needed（最多3条）、options（最多3条处理选项）。',
      schema: obj({issue_type:str,severity:str,emotion:str,responsibility:str,evidence_needed:strArray,options:strArray},['issue_type','severity','emotion','responsibility','evidence_needed','options']) },
    { key:'response', label:'安抚回复与待审动作', maxTokens:1200,
      prompt:'reply（1-2条安抚+核实）、next_step、action{kind（refund/reship/coupon 或空字符串）,amount_cents（整数分，可为0）,reason}。不主动报金额、不承诺未审核补偿。',
      schema: obj({reply:str,next_step:str,action:obj({kind:str,amount_cents:{type:'number'},reason:str},['kind','amount_cents','reason'])},['reply','next_step','action']) },
  ],
  'data-analyst': [
    { key:'analysis', label:'质量、指标与发现', maxTokens:1400,
      prompt:'quality{valid_rows,invalid_rows,note}、metrics{ctr,click_cvr,cpc,roas}、funnel{impressions,clicks,orders}、findings（最多3条，区分观察/假设）。数值必须与后端核算一致。',
      schema: obj({quality:obj({valid_rows:{type:'number'},invalid_rows:{type:'number'},note:str},['valid_rows','invalid_rows']),metrics:obj({ctr:str,click_cvr:str,cpc:str,roas:str},['ctr','click_cvr','cpc','roas']),funnel:obj({impressions:{type:'number'},clicks:{type:'number'},orders:{type:'number'}},['impressions','clicks','orders']),findings:strArray},['quality','metrics','funnel','findings']) },
    { key:'actions', label:'数据动作与复盘', maxTokens:1200,
      prompt:'actions（3条{data,hypothesis,action}）、review_at（3-7日）、data_gaps（最多3条补数清单）。',
      schema: obj({actions:{type:'array',minItems:1,items:obj({data:str,hypothesis:str,action:str},['data','hypothesis','action'])},review_at:str,data_gaps:strArray},['actions','review_at','data_gaps']) },
  ],
};

export function sectionShape(section) {
  const shape = {};
  for (const [key, rule] of Object.entries(section.schema.properties || {})) {
    shape[key] = {type:rule.type, required:(section.schema.required || []).includes(key)};
  }
  return shape;
}
