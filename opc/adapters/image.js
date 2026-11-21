import {mkdirSync, writeFileSync, readFileSync, statSync} from 'node:fs';
import {resolve, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {runMediaScript} from '../media.js';
import {secret, missing} from '../secrets.js';

const now = () => new Date().toISOString();

export function imageInfo(path) {
  const buffer = readFileSync(path);
  let width = null, height = null, mime = null;
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    mime = 'image/png'; width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20);
  } else if (buffer.length > 4 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    mime = 'image/jpeg';
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xFF) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        height = buffer.readUInt16BE(offset + 5); width = buffer.readUInt16BE(offset + 7); break;
      }
      offset += 2 + length;
    }
  }
  return {mime, width, height, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex')};
}

export function generateLocalImages({baseImage, outDir, items}) {
  mkdirSync(outDir, {recursive:true});
  const images = items.map((item, index) => ({
    kind:'overlay', filename: item.filename || ('main-' + (index + 1) + '.png'), base: baseImage,
    width: item.width || 800, height: item.height || 800,
    headline: item.headline || '', subline: item.subline || '', badge: item.badge || '',
    footnote: item.footnote || '合成演示素材 · 非真实商品图',
  }));
  const result = runMediaScript({outDir, images});
  if (!result.ok) return {ok:false, status:'failed', environment:'local', provider:'local-compositor', error:result.error, images:[]};
  return {ok:true, status:'success', environment:'local', provider:'local-compositor', ai:false,
    receiptId:'IMG-LOCAL-' + Date.now(), generatedAt:now(),
    images: result.images.map(image => ({...image, ...imageInfo(image.path)}))};
}

export function imageProviderStatus() {
  const required = ['IMAGE_BASE_URL','IMAGE_API_KEY','IMAGE_MODEL'];
  const absent = missing(required);
  return {configured: absent.length === 0, absent, baseUrl: secret('IMAGE_BASE_URL') || null, model: secret('IMAGE_MODEL') || null};
}

export async function generateAiImages({prompt, outDir, filename = 'ai-image.png', size = '1024x1024', timeoutMs = 120000}) {
  const status = imageProviderStatus();
  if (!status.configured) {
    return {ok:false, status:'not_configured', environment:'real', provider:'ai-image', error:'AI 生图未配置，缺少参数：' + status.absent.join(', '), missing:status.absent, images:[]};
  }
  mkdirSync(outDir, {recursive:true});
  try {
    const response = await fetch((secret('IMAGE_BASE_URL')).replace(/\/$/, '') + '/images/generations', {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + secret('IMAGE_API_KEY')},
      body: JSON.stringify({model:secret('IMAGE_MODEL'), prompt, size, n:1, response_format:'b64_json'}),
      redirect:'error', signal:AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null; try { payload = JSON.parse(text); } catch {}
    if (!response.ok) return {ok:false, status: response.status === 401 || response.status === 403 ? 'permission_denied' : 'failed',
      environment:'real', provider:'ai-image', error:'生图服务 HTTP ' + response.status, upstream:{httpStatus:response.status, body:text.slice(0,500)}, images:[]};
    const item = payload?.data?.[0];
    if (!item) return {ok:false, status:'failed', environment:'real', provider:'ai-image', error:'生图服务未返回图片', upstream:{body:text.slice(0,300)}, images:[]};
    const path = resolve(outDir, basename(filename));
    if (item.b64_json) writeFileSync(path, Buffer.from(item.b64_json, 'base64'));
    else if (item.url) {
      const download = await fetch(item.url, {signal:AbortSignal.timeout(timeoutMs)});
      if (!download.ok) return {ok:false, status:'failed', environment:'real', provider:'ai-image', error:'生图结果下载失败 HTTP ' + download.status, images:[]};
      writeFileSync(path, Buffer.from(await download.arrayBuffer()));
    } else return {ok:false, status:'failed', environment:'real', provider:'ai-image', error:'生图结果缺少 b64_json 或 url', images:[]};
    const info = imageInfo(path);
    if (!info.mime || !info.width || !info.height) return {ok:false, status:'failed', environment:'real', provider:'ai-image', error:'生成文件不是可识别的 PNG/JPEG', images:[]};
    return {ok:true, status:'success', environment:'real', provider:'ai-image', ai:true, receiptId:'IMG-AI-' + Date.now(), generatedAt:now(),
      images:[{filename:basename(filename), path, ...info, width:info.width, height:info.height}], taskId:payload?.id || null};
  } catch (failure) {
    return {ok:false, status: failure?.name === 'TimeoutError' || failure?.name === 'AbortError' ? 'timeout' : 'failed',
      environment:'real', provider:'ai-image', error:'生图请求失败：' + (failure?.message || 'unknown'), images:[]};
  }
}
