import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto';
import {secret, missing} from '../secrets.js';

export const ALI_GATEWAY = 'https://skills-gateway.1688.com';
export const ALI_SEARCH_PATH = '/api/find_product/1.0.0';
const REQUIRED = ['ALI_1688_AK'];
const now = () => new Date().toISOString();

function safeText(value, secrets = [], limit = 600) {
  let text = String(value ?? '');
  for (const value of secrets.filter(Boolean)) text = text.split(value).join('[redacted]');
  return text.slice(0, limit);
}

function upstreamFailure(parsed, response, credentials) {
  const businessCode = typeof parsed?.code === 'string' && !/^\d+$/.test(parsed.code) ? parsed.code : null;
  const code = safeText(businessCode || parsed?.msgCode || parsed?.code || ('HTTP_' + response.status), credentials, 120);
  const message = safeText(parsed?.message || parsed?.msgInfo || response.statusText || '接口拒绝请求', credentials);
  const expired = code === 'ACCESS_KEY_EXPIRED';
  return {
    status:expired || response.status === 401 || response.status === 403 ? 'permission_denied'
      : response.status === 429 ? 'rate_limited' : 'failed',
    error:'1688 网关 ' + code + '：' + message + (expired ? '；需要新的 ALI_1688_AK' : ''),
    missing:expired ? ['新的 ALI_1688_AK'] : [],
    upstream:{httpStatus:response.status, code, message, traceId:parsed?.traceId ? safeText(parsed.traceId, credentials, 160) : null,
      ...(parsed?.msgCode ? {msgCode:safeText(parsed.msgCode, credentials, 120)} : {})},
  };
}

function decodeAk(raw) {
  try {
    const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
    const decoded = Buffer.from(padded, 'base64url').toString('utf8');
    if (decoded.length >= 33) return {secret: decoded.slice(0, 32), accessKeyId: decoded.slice(32)};
  } catch {}
  if (raw.length > 32) return {secret: raw.slice(0, 32), accessKeyId: raw.slice(32)};
  return null;
}

function contentMd5(body) {
  return createHash('md5').update(body, 'utf8').digest('base64');
}

function signedHeaders(path, body, rawAk) {
  const credentials = decodeAk(rawAk);
  if (!credentials) return null;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const csk = {
    'x-csk-ak': credentials.accessKeyId,
    'x-csk-time': timestamp,
    'x-csk-nonce': randomBytes(4).toString('hex'),
    'x-csk-content-md5': contentMd5(body),
    'x-csk-version': '1.7.0',
  };
  const canonical = Object.keys(csk).sort().map(name => name + ':' + csk[name].trim() + '\n').join('');
  const stringToSign = 'POST\n' + csk['x-csk-content-md5'] + '\napplication/json\n' + timestamp + '\n' + canonical + path;
  const signature = createHmac('sha256', credentials.secret).update(stringToSign, 'utf8').digest('base64');
  return {'Content-Type':'application/json','User-Agent':'opc-workbench/1.0','x-csk-sign':signature, ...csk};
}

function normalize(item) {
  const productId = item.itemId ?? item.item_id ?? item.offerId ?? null;
  return {
    product_id: productId === null ? null : String(productId),
    title: item.title ?? null,
    image_url: item.imageUrl ?? item.image_url ?? null,
    detail_url: item.detailUrl ?? (productId ? 'https://detail.1688.com/offer/' + productId + '.html' : null),
    price_cny: typeof item.currentPrice === 'number' ? item.currentPrice : item.price ?? null,
    sku_id: item.skuId ?? null,
    sku_title: item.skuTitle ?? null,
    quantity_begin: item.quantityBegin ?? null,
    unit: item.unit ?? null,
    supplier: item.company ?? item.supplier ?? null,
    sold_30d: item.payOrd30d ?? item.soldOut ?? null,
    yx_index: item.yxIndex ?? null,
    stock: item.storeAmount ?? null,
    promotion_tags: item.promotionTags ?? null,
    service_infos: item.serviceInfos ?? null,
    selling_points: item.sellingPoints ?? null,
    raw_fields_available: Object.keys(item).sort(),
  };
}

export async function ali1688Search({query, limit = 10, sort, scoreLevel = 'high', purchaseAmount = 1, tags = '4306497', timeoutMs = 20000,
  baseUrl = ALI_GATEWAY, path = ALI_SEARCH_PATH} = {}) {
  const started = Date.now();
  const startedAt = now();
  const receiptId = 'ALI-' + started + '-' + randomUUID().slice(0, 8);
  if (String(baseUrl).replace(/\/$/, '') !== ALI_GATEWAY || path !== ALI_SEARCH_PATH) {
    return {ok:false, status:'not_configured', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      error:'1688 找货地址必须为 ' + ALI_GATEWAY + ALI_SEARCH_PATH, missing:['官方找货地址'], request:{query}, data:null};
  }
  const missingParams = missing(REQUIRED);
  if (missingParams.length) {
    return {ok:false, status:'not_configured', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      error:'缺少参数：' + missingParams.join(', '), missing:missingParams, request:{query}, data:null};
  }
  const rawAk = secret('ALI_1688_AK');
  const payload = {query:String(query || '').slice(0,200), pageSize:Math.max(1, Math.min(20, limit)), purchaseAmount, scoreLevel};
  if (sort) payload.sortType = sort;
  if (tags) payload.tags = tags;
  const body = JSON.stringify(payload);
  const headers = signedHeaders(ALI_SEARCH_PATH, body, rawAk);
  if (!headers) {
    return {ok:false, status:'not_configured', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      error:'ALI_1688_AK 格式无效', request:{query}, data:null};
  }
  const credentials = [rawAk, decodeAk(rawAk)?.secret, decodeAk(rawAk)?.accessKeyId];
  try {
    const response = await fetch(ALI_GATEWAY + ALI_SEARCH_PATH, {
      method:'POST', headers, body, redirect:'error', signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!response.ok || parsed?.success === false) {
      return {ok:false, ...upstreamFailure(parsed, response, credentials), environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
        request:{query:payload.query, pageSize:payload.pageSize, purchaseAmount, scoreLevel}, data:null};
    }
    const model = parsed?.model ?? parsed?.data;
    const list = Array.isArray(model?.data) ? model.data : Array.isArray(model) ? model : null;
    if (!Array.isArray(list)) {
      return {ok:false, status:'failed', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
        error:'1688 API 返回结构异常', upstream:{httpStatus:response.status}, request:{query:payload.query}, data:null};
    }
    return {ok:true, status:'success', environment:'real', receiptId, startedAt, durationMs:Date.now()-started,
      data:{platform:'1688', provider:'1688 skills gateway', query:payload.query, retrievedAt:startedAt,
        items:list.filter(Boolean).map(normalize), dataScope:'1688 找货网关返回的商品列表；报价为返回规格的当前价，运费、供应商资质和代发条件缺失时保留为空。'},
      request:{query:payload.query, pageSize:payload.pageSize, purchaseAmount, scoreLevel}};
  } catch (failure) {
    const timeout = failure?.name === 'TimeoutError' || failure?.name === 'AbortError';
    return {ok:false, status: timeout ? 'timeout' : 'failed', environment:'real', receiptId, startedAt,
      durationMs:Date.now()-started, error: timeout ? '1688 网关请求超时' : '1688 网关请求失败：' + safeText(failure?.message || 'unknown', credentials),
      request:{query:payload.query}, data:null};
  }
}

export async function ali1688Detail({itemId, title, limit = 10} = {}) {
  const query = String(itemId || title || '').trim();
  if (!query) return {ok:false, status:'needs_info', environment:'real', error:'缺少商品 ID 或标题', data:null};
  const result = await ali1688Search({query, limit});
  if (!result.ok) return {...result, detailFor:itemId || null};
  const match = result.data.items.find(item => item.product_id === String(itemId)) || null;
  return {...result, detailFor:itemId || null, match:'exact_or_none', data:{...result.data, match}};
}
