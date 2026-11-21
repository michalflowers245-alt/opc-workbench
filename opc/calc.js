// 确定性核算：金额一律用整数分，平台费四舍五入到分。
// 模型只负责分析与表达，不参与这些数字的生成。

export const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

export const toCents = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === 'string') {
    const cleaned = value.replace(/[\s,，¥￥元]/g, '');
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
  }
  return null;
};

export const cny = (cents) => (Number.isInteger(cents) ? (cents / 100).toFixed(2) : null);

const int = (value, fallback = 0) => (Number.isInteger(value) ? value : fallback);

export function unitEconomics(input = {}) {
  const priceCents = int(input.priceCents);
  const costCents = int(input.costCents);
  const shippingCents = int(input.shippingCents);
  const packagingCents = int(input.packagingCents);
  const refundCents = int(input.refundCents);
  const adCents = int(input.adCents);
  const taxCents = int(input.taxCents);
  const discountCents = int(input.discountCents);
  const feeBps = Number.isInteger(input.feeBps) ? input.feeBps : 600;
  const errors = [];
  if (!Number.isInteger(input.priceCents) || priceCents <= 0) errors.push('售价必须是大于 0 的定点金额');
  for (const [key, value] of Object.entries({ costCents, shippingCents, packagingCents, refundCents, adCents, taxCents, discountCents })) {
    if (value < 0) errors.push(key + ' 不能为负数');
  }
  if (discountCents >= priceCents && priceCents > 0) errors.push('优惠不能大于或等于售价');
  if (!Number.isInteger(input.feeBps) && input.feeBps !== undefined) errors.push('平台费率必须是整数基点');
  if (feeBps < 0 || feeBps > 10000) errors.push('平台费率必须在 0-10000 基点之间');

  const confirmedRevenueCents = priceCents - discountCents;
  const platformFeeCents = Math.round(confirmedRevenueCents * feeBps / 10000);
  const preAdCents = confirmedRevenueCents - costCents - shippingCents - packagingCents - platformFeeCents - refundCents - taxCents;
  const postAdCents = preAdCents - adCents;
  const preAdRate = confirmedRevenueCents > 0 ? preAdCents / confirmedRevenueCents : null;
  const postAdRate = confirmedRevenueCents > 0 ? postAdCents / confirmedRevenueCents : null;
  const breakEvenRoas = preAdRate !== null && preAdRate > 0 ? round(1 / preAdRate, 4) : null;

  return {
    ok: errors.length === 0,
    errors,
    currency: 'CNY',
    unit: '件',
    inputs: {
      priceCents, costCents, shippingCents, packagingCents, feeBps, refundCents, adCents, taxCents, discountCents,
      price: cny(priceCents), cost: cny(costCents), shipping: cny(shippingCents), packaging: cny(packagingCents),
      refund: cny(refundCents), ad: cny(adCents), tax: cny(taxCents), discount: cny(discountCents),
    },
    confirmedRevenueCents,
    platformFeeCents,
    preAdCents,
    postAdCents,
    preAdRatePct: preAdRate === null ? null : round(preAdRate * 100, 2),
    postAdRatePct: postAdRate === null ? null : round(postAdRate * 100, 2),
    breakEvenRoas: breakEvenRoas === null ? null : round(breakEvenRoas, 2),
    breakEvenAdCents: preAdCents,
    profitableAfterAd: postAdCents > 0,
    formulas: [
      '确认销售收入 = 售价 - 优惠 = ' + cny(priceCents) + ' - ' + cny(discountCents) + ' = ' + cny(confirmedRevenueCents) + ' 元',
      '平台费 = 四舍五入(确认销售收入 × 费率, 分) = 四舍五入(' + cny(confirmedRevenueCents) + ' × ' + (feeBps / 100).toFixed(2) + '%) = ' + cny(platformFeeCents) + ' 元',
      '广告前单件贡献 = 确认收入 - 进货 - 履约 - 包材 - 平台费 - 退款损耗 - 税 = ' + cny(confirmedRevenueCents) + ' - ' + cny(costCents) + ' - ' + cny(shippingCents) + ' - ' + cny(packagingCents) + ' - ' + cny(platformFeeCents) + ' - ' + cny(refundCents) + ' - ' + cny(taxCents) + ' = ' + cny(preAdCents) + ' 元',
      '广告后单件贡献 = 广告前贡献 - 单件广告费 = ' + cny(preAdCents) + ' - ' + cny(adCents) + ' = ' + cny(postAdCents) + ' 元',
      '广告前贡献率 = 广告前贡献 ÷ 确认收入 × 100% = ' + (preAdRate === null ? '分母为零' : round(preAdRate * 100, 2) + '%'),
      '盈亏平衡 ROAS = 1 ÷ 广告前贡献率 = ' + (breakEvenRoas === null ? '贡献率非正，无法估算' : round(breakEvenRoas, 2)),
    ],
    notes: [
      '平台费按经营者在 SKU 上确认的费率与取整规则计算，未包含平台活动补贴或临时费率。',
      '代发报价若已含运费，履约费用应填 0，避免重复计入。',
      '退款损耗按单件预计金额录入，不是退款率；若用退款率，应先换算为金额再录入。',
    ],
  };
}

const metric = (numerator, denominator, unit, formula, digits = 2) => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return { value: null, unit, numerator, denominator, formula, reason: '缺字段' };
  }
  if (denominator === 0) return { value: null, unit, numerator, denominator, formula, reason: '分母为零' };
  const ratio = unit === '%' ? numerator / denominator * 100 : numerator / denominator;
  return { value: round(ratio, digits), unit, numerator, denominator, formula, reason: null };
};

export function metrics(input = {}) {
  const impressions = Number.isFinite(input.impressions) ? input.impressions : null;
  const clicks = Number.isFinite(input.clicks) ? input.clicks : null;
  const orders = Number.isFinite(input.orders) ? input.orders : null;
  const visitors = Number.isFinite(input.visitors) ? input.visitors : null;
  const revenueCents = Number.isFinite(input.revenueCents) ? input.revenueCents : null;
  const adSpendCents = Number.isFinite(input.adSpendCents) ? input.adSpendCents : null;
  const errors = [];
  for (const [key, value] of Object.entries({ impressions, clicks, orders, visitors })) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) errors.push(key + ' 必须是非负整数');
  }
  for (const [key, value] of Object.entries({ revenueCents, adSpendCents })) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) errors.push(key + ' 必须是非负定点金额');
  }
  if (impressions !== null && clicks !== null && clicks > impressions) errors.push('点击量不能大于曝光量');
  if (clicks !== null && orders !== null && orders > clicks) errors.push('成交单量不能大于点击量');
  if (visitors !== null && orders !== null && orders > visitors) errors.push('成交单量不能大于访客数');

  const ctr = metric(clicks, impressions, '%', 'CTR = 点击 ÷ 曝光 × 100%');
  const clickCvr = metric(orders, clicks, '%', '点击成交转化率 = 成交 ÷ 点击 × 100%');
  const visitorCvr = metric(orders, visitors, '%', '访客成交转化率 = 成交 ÷ 访客 × 100%');
  const cpc = metric(adSpendCents, clicks, '分', 'CPC = 推广费用 ÷ 点击');
  const cpa = metric(adSpendCents, orders, '分', 'CPA = 推广费用 ÷ 成交单量');
  const roas = metric(revenueCents, adSpendCents, '倍', 'ROAS = 归因销售额 ÷ 推广费用');
  const aov = metric(revenueCents, orders, '分', '客单价 = 归因销售额 ÷ 成交单量');
  const cpm = metric(adSpendCents === null ? null : adSpendCents * 1000, impressions, '分', 'CPM = 推广费用 ÷ 曝光 × 1000');

  const asMoney = (entry) => ({ ...entry, value: entry.unit === '分' && entry.value !== null ? entry.value / 100 : entry.value });
  const money = { cpc: asMoney(cpc), cpa: asMoney(cpa), aov: asMoney(aov), cpm: asMoney(cpm) };

  return {
    ok: errors.length === 0,
    errors,
    period: input.period || null,
    channel: input.channel || null,
    definitions: {
      ctr: '点击 ÷ 曝光 × 100%',
      clickCvr: '成交 ÷ 点击 × 100%（点击成交转化率）',
      visitorCvr: '成交 ÷ 访客 × 100%（访客成交转化率）',
      cpc: '推广费用 ÷ 点击',
      cpa: '推广费用 ÷ 成交单量',
      roas: '归因销售额 ÷ 推广费用（归因窗口与收入口径须一致）',
      aov: '归因销售额 ÷ 成交单量',
    },
    metrics: { ctr, clickCvr, visitorCvr, cpc: money.cpc, cpa: money.cpa, roas, aov: money.aov, cpm: money.cpm },
    ctrPct: ctr.value,
    clickCvrPct: clickCvr.value,
    visitorCvrPct: visitorCvr.value,
    cpcCents: money.cpc.value === null ? null : Math.round(money.cpc.value * 100),
    cpaCents: money.cpa.value === null ? null : Math.round(money.cpa.value * 100),
    roas: roas.value,
    aovCents: money.aov.value === null ? null : Math.round(money.aov.value * 100),
    formulas: [
      'CTR = ' + (clicks ?? '缺') + ' ÷ ' + (impressions ?? '缺') + ' × 100% = ' + (ctr.value === null ? ctr.reason : ctr.value + '%'),
      '点击成交转化率 = ' + (orders ?? '缺') + ' ÷ ' + (clicks ?? '缺') + ' × 100% = ' + (clickCvr.value === null ? clickCvr.reason : clickCvr.value + '%'),
      'CPC = ' + (adSpendCents === null ? '缺' : cny(adSpendCents)) + ' ÷ ' + (clicks ?? '缺') + ' = ' + (money.cpc.value === null ? money.cpc.reason : money.cpc.value.toFixed(2) + ' 元'),
      'ROAS = ' + (revenueCents === null ? '缺' : cny(revenueCents)) + ' ÷ ' + (adSpendCents === null ? '缺' : cny(adSpendCents)) + ' = ' + (roas.value === null ? roas.reason : roas.value.toFixed(2)),
    ],
  };
}

export function reportSummary(rows = []) {
  const valid = rows.filter(row => !(Array.isArray(row.errors) && row.errors.length));
  const totals = valid.reduce((sum, row) => ({
    impressions: sum.impressions + (row.impressions || 0),
    clicks: sum.clicks + (row.clicks || 0),
    orders: sum.orders + (row.orders || 0),
    revenueCents: sum.revenueCents + (row.revenueCents || 0),
    adSpendCents: sum.adSpendCents + (row.adSpendCents || 0),
    visitors: sum.visitors + (row.visitors || 0),
  }), { impressions: 0, clicks: 0, orders: 0, revenueCents: 0, adSpendCents: 0, visitors: 0 });
  const first = valid[0];
  const last = valid[valid.length - 1];
  return {
    ...totals,
    rowCount: rows.length,
    validRows: valid.length,
    invalidRows: rows.length - valid.length,
    period: first && last ? { start: first.date, end: last.date } : null,
    metrics: metrics(totals),
  };
}

export const BANNED_WORDS = ['全网第一','第一品牌','国家级','最高级','最佳','100%','百分百','永久','根治','绝对','顶级','唯一','万能','零风险','包治','史上最低','全网最低','最便宜','销量第一'];

export function complianceCheck(text = '') {
  const hits = BANNED_WORDS.filter(word => text.includes(word));
  return {
    ok: hits.length === 0,
    hits,
    note: hits.length ? '发现疑似极限词或无法证实表述，需改写后再提交审核。' : '未命中内置极限词表；仍须按广告法与平台规则人工复核。',
  };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(1) + ' s';
}
