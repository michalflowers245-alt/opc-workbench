import {createHash, randomUUID} from 'node:crypto';
import {secret, missing} from '../secrets.js';

export const PDD_GATEWAY = 'https://gw-api.pinduoduo.com/api/router';
const REQUIRED = ['ECOMMERCE_PDD_CLIENT_ID', 'ECOMMERCE_PDD_CLIENT_SECRET'];

const now = () => new Date().toISOString();

const AUTH_CHECKS = {
  'conn-pdd-store': [{capability:'store_report', label:'只读店铺报表', permissions:['店铺授权','自有店铺报表读取权限']}],
  'conn-pdd-orders': [
    {capability:'order_query', label:'订单查询', permissions:['店铺授权','订单与物流读取权限']},
    {capability:'customer_receive', label:'客服接收', permissions:['店铺授权','客服接收授权']},
    {capability:'customer_send', label:'客服发送', permissions:['店铺授权','客服发送授权'], writes:true},
  ],
  'conn-pdd-write': [{capability:'store_write', label:'测试店铺写入', permissions:['生产应用权限','店铺操作授权','测试店铺授权'], writes:true}],
};

// These scopes need merchant authorization and a matching adapter before a live probe.
// An application secret alone proves neither store access nor permission to send or write.
export function pddAuthorizationChecks(connectionId, capability = null, lookup = secret) {
  const checks = AUTH_CHECKS[connectionId];
  if (!checks || capability && !checks.some(item => item.capability === capability)) return null;
  return checks.filter(item => !capability || item.capability === capability).map(item => ({
    ...item, ok:false, status:'not_configured', environment:'real', externalExecuted:false,
    receiptId:'PDD-AUTH-' + randomUUID(), testedAt:now(), testMode:'configuration_only',
    missing:[...REQUIRED, 'ECOMMERCE_PDD_ACCESS_TOKEN'].filter(name => !lookup(name)).concat(item.permissions),
    detail:item.label + '尚未完成店铺授权及对应适配器核验',
    next:'在接入设置补齐授权后，使用该能力的只读接口或已授权测试店铺复测',
  }));
}

function safeText(value, credentials, limit = 600) {
  let text = String(value ?? '');
  for (const value of credentials.filter(Boolean)) text = text.split(value).join('[redacted]');
  return text.slice(0, limit);
}

function sign(params, clientSecret) {
  const canonical = clientSecret + Object.keys(params).sort()
    .filter(key => key !== 'sign')
    .map(key => key + params[key]).join('') + clientSecret;
  return createHash('md5').update(canonical, 'utf8').digest('hex').toUpperCase();
}

function priceYuan(fen) {
  return typeof fen === 'number' && Number.isFinite(fen) ? Math.round(fen) / 100 : null;
}

function normalize(goods) {
  return {
    product_id: goods.goods_id === undefined ? null : String(goods.goods_id),
    title: typeof goods.goods_name === 'string' ? goods.goods_name.slice(0, 200) : null,
    category: goods.cat_name || goods.cat_id || null,
    group_price_cny: priceYuan(goods.min_group_price),
    coupon_discount_cny: priceYuan(goods.coupon_discount),
    sales_hint: goods.sales_tip ?? null,
    shop: goods.mall_name || null,
    image_url: goods.goods_thumbnail_url || goods.goods_image_url || null,
    promotion_rate_per_mille: goods.promotion_rate ?? null,
    service_signals: { desc: goods.desc_txt ?? null, logistics: goods.lgst_txt ?? null, service: goods.serv_txt ?? null },
    raw_fields_available: Object.keys(goods).sort(),
  };
}

export async function pddGoodsSearch({keyword, pageSize = 10, page = 1, timeoutMs = 15000, baseUrl = PDD_GATEWAY} = {}) {
  const started = Date.now();
  const startedAt = now();
  const receiptId = 'PDD-' + started + '-' + randomUUID().slice(0, 8);
  if (baseUrl !== PDD_GATEWAY || !Number.isInteger(pageSize) || pageSize < 10 || pageSize > 100 || !Number.isInteger(page) || page < 1) {
    return {ok:false, status:'not_configured', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      error:'请使用拼多多官方网关，pageSize 为 10–100，page 为正整数', request:{keyword, pageSize, page}, data:null};
  }
  const missingParams = missing(REQUIRED);
  if (missingParams.length) {
    return {ok:false, status:'not_configured', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      error:'缺少参数：' + missingParams.join(', '), missing:missingParams,
      request:{keyword, pageSize, page}, data:null};
  }
  const clientId = secret('ECOMMERCE_PDD_CLIENT_ID');
  const clientSecret = secret('ECOMMERCE_PDD_CLIENT_SECRET');
  const pid = secret('ECOMMERCE_PDD_PID');
  const custom = secret('ECOMMERCE_PDD_CUSTOM_PARAMETERS');
  const credentials = [clientId, clientSecret, pid, custom];
  const params = {
    type: 'pdd.ddk.goods.search', client_id: clientId, timestamp: Math.floor(Date.now()/1000),
    data_type: 'JSON', version: 'V1', keyword: String(keyword || '').slice(0, 100), page_size: pageSize, page,
  };
  if (pid) params.pid = pid;
  if (custom) params.custom_parameters = custom;
  params.sign = sign(params, clientSecret);
  try {
    const response = await fetch(PDD_GATEWAY, {
      method:'POST', headers:{'Content-Type':'application/json','User-Agent':'opc-workbench/1.0'},
      body: JSON.stringify(params), redirect:'error', signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    if (!response.ok) {
      return {ok:false, status: response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'permission_denied' : 'failed',
        environment:'real', receiptId, startedAt, durationMs:Date.now()-started, error:'拼多多网关 HTTP ' + response.status,
        upstream:{httpStatus:response.status}, request:{keyword, pageSize, page}, data:null};
    }
    if (payload?.error_response) {
      const error = payload.error_response;
      const code = error.error_code ?? error.sub_code ?? 'unknown';
      return {ok:false, status: code === 50001 || code === 50000 ? 'permission_denied' : 'failed', environment:'real',
        receiptId, startedAt, durationMs:Date.now()-started,
        error:'拼多多 API ' + safeText(code, credentials, 100) + '：' + safeText(error.error_msg || error.sub_msg || '请求失败', credentials),
        upstream:{httpStatus:response.status, code:safeText(code, credentials, 100), subCode:error.sub_code ?? null, message:safeText(error.error_msg || error.sub_msg || '', credentials)},
        request:{keyword, pageSize, page}, data:null};
    }
    const list = payload?.goods_search_response?.goods_list;
    if (!Array.isArray(list)) {
      return {ok:false, status:'failed', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
        error:'拼多多接口未返回商品列表', upstream:{httpStatus:response.status}, request:{keyword, pageSize, page}, data:null};
    }
    return {ok:true, status:'success', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      data:{platform:'拼多多多多进宝', api:'pdd.ddk.goods.search', keyword, page, pageSize,
        totalCount: payload.goods_search_response.total_count ?? null,
        items:list.filter(Boolean).slice(0, pageSize).map(normalize),
        dataScope:'多多进宝推广商品；拼团价和优惠券由分转换为元；销量提示保留平台原值，统计周期未提供。'},
      request:{keyword, pageSize, page}};
  } catch (failure) {
    const timeout = failure?.name === 'TimeoutError' || failure?.name === 'AbortError';
    return {ok:false, status: timeout ? 'timeout' : 'failed', environment:'real', receiptId, startedAt,
      durationMs:Date.now()-started, error: timeout ? '拼多多网关请求超时' : '拼多多网关请求失败：' + safeText(failure?.message || 'unknown', credentials),
      request:{keyword, pageSize, page}, data:null};
  }
}
