import {runPython} from './python.js';
import {writeFileSync, unlinkSync, mkdirSync} from 'node:fs';
import {resolve, basename} from 'node:path';

export const FIELD_ALIASES = {
  date:['日期','统计日期','date','日期范围开始'],
  impressions:['曝光','曝光量','展现量','impressions'],
  clicks:['点击','点击量','clicks'],
  orders:['成交','成交单量','订单','订单数','orders'],
  revenue:['归因销售额','成交金额','销售额','交易额','revenue','gmv'],
  ad_spend:['推广费用','花费','广告费','推广花费','ad_spend','spend'],
  visitors:['访客','访客数','uv','visitors'],
  plan:['计划','推广计划','plan','计划名称'],
  channel:['渠道','channel','流量来源'],
};

const cleanHeader = (value) => String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase();

export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(item => item.some(cell => String(cell).trim() !== ''));
}

export function readXlsx(buffer, filename, dataDir) {
  const python = runPython('openpyxl', String.raw`
import json, sys
from openpyxl import load_workbook
path, out = sys.argv[1], sys.argv[2]
wb = load_workbook(path, data_only=True, read_only=True)
result = {}
for sheet in wb.sheetnames[:5]:
    ws = wb[sheet]
    rows = []
    for row in ws.iter_rows(values_only=True):
        rows.append(['' if v is None else str(v) for v in row])
        if len(rows) > 2000: break
    result[sheet] = rows
print(json.dumps({'sheets': result}, ensure_ascii=False))
`, [filename, '']);
  return python;
}

export function suggestMapping(headers) {
  const normalized = headers.map(cleanHeader);
  const mapping = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const index = normalized.findIndex(header => aliases.some(alias => header === cleanHeader(alias) || header.includes(cleanHeader(alias))));
    if (index >= 0) mapping[field] = index;
  }
  return mapping;
}

export function parseDateStrict(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

const numberValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value ?? '').replace(/[\s,，¥￥元%]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const cents = (value) => {
  const number = numberValue(value);
  return number === null ? null : Math.round(number * 100);
};

export function normalizeRows(rawRows, mapping) {
  const rows = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    const raw = rawRows[index];
    const errors = [];
    const warnings = [];
    const get = (field) => mapping[field] === undefined ? null : raw[mapping[field]];
    const date = parseDateStrict(get('date'));
    if (!date) errors.push('日期无效或缺失，需要 YYYY-MM-DD');
    const impressions = numberValue(get('impressions'));
    const clicks = numberValue(get('clicks'));
    const orders = numberValue(get('orders'));
    const visitors = numberValue(get('visitors'));
    const revenueCents = cents(get('revenue'));
    const adSpendCents = cents(get('ad_spend'));
    for (const [label, value] of [['曝光量', impressions], ['点击量', clicks], ['成交单量', orders], ['访客数', visitors]]) {
      if (value === null) errors.push(label + '不是数字');
      else if (!Number.isInteger(value) || value < 0) errors.push(label + '必须是非负整数');
    }
    for (const [label, value] of [['归因销售额', revenueCents], ['推广费用', adSpendCents]]) {
      if (value === null) errors.push(label + '不是数字');
      else if (value < 0) errors.push(label + '不能为负数');
    }
    if (Number.isInteger(impressions) && Number.isInteger(clicks) && clicks > impressions) errors.push('点击量不能大于曝光量');
    if (Number.isInteger(clicks) && Number.isInteger(orders) && orders > clicks) errors.push('成交单量不能大于点击量');
    if (Number.isInteger(visitors) && Number.isInteger(orders) && orders > visitors && visitors > 0) errors.push('成交单量不能大于访客数');
    const row = {
      rowNo:index + 2, date, impressions:Number.isInteger(impressions) ? impressions : null, clicks:Number.isInteger(clicks) ? clicks : null,
      orders:Number.isInteger(orders) ? orders : null, visitors:Number.isInteger(visitors) ? visitors : null,
      revenueCents, adSpendCents, plan:String(get('plan') ?? '').trim() || null, channel:String(get('channel') ?? '').trim() || null,
      errors, warnings, status:errors.length ? 'invalid' : 'valid',
    };
    rows.push(row);
  }
  // 归并重复行：同日期、同计划、同指标；保留第一条，后续标为 duplicate。
  const seen = new Map();
  for (const row of rows) {
    const key = [row.date, row.plan, row.impressions, row.clicks, row.orders, row.revenueCents, row.adSpendCents, row.visitors].join('|');
    if (seen.has(key)) { row.status = 'duplicate'; row.warnings.push('重复行，已归并到第 ' + seen.get(key) + ' 行'); }
    else seen.set(key, row.rowNo);
  }
  return rows;
}

export function previewReport({text, xlsxBuffer, filename, dataDir}) {
  let matrix;
  if (xlsxBuffer) {
    const dir = resolve(dataDir, 'opc-imports');
    mkdirSync(dir, {recursive:true});
    const path = resolve(dir, basename(filename || 'import.xlsx'));
    writeFileSync(path, xlsxBuffer);
    const result = runPython('openpyxl', String.raw`
import json, sys
from openpyxl import load_workbook
path = sys.argv[1]
wb = load_workbook(path, data_only=True, read_only=True)
out = {}
for sheet in wb.sheetnames[:5]:
    ws = wb[sheet]
    rows = []
    for row in ws.iter_rows(values_only=True):
        rows.append(['' if v is None else str(v) for v in row])
        if len(rows) > 2000: break
    out[sheet] = rows
print(json.dumps({'sheets': out}, ensure_ascii=False))
`, [path], {timeout:60000});
    try { unlinkSync(path); } catch {}
    if (!result.ok) return {ok:false, error:'Excel 读取失败：' + result.error};
    const sheets = JSON.parse(result.stdout).sheets || {};
    matrix = sheets[Object.keys(sheets)[0]] || [];
  } else {
    matrix = parseCsv(text);
  }
  if (!matrix.length) return {ok:false, error:'文件没有可读取的行'};
  const headers = matrix[0].map(value => String(value ?? '').trim());
  const mapping = suggestMapping(headers);
  if (mapping.date === undefined) return {ok:false, error:'未找到日期列；请提供列名或手动映射', headers, mapping};
  const rows = normalizeRows(matrix.slice(1), mapping);
  const valid = rows.filter(row => row.status === 'valid');
  const invalid = rows.filter(row => row.status === 'invalid');
  const duplicates = rows.filter(row => row.status === 'duplicate');
  return {ok:true, headers, mapping, rows, valid, invalid, duplicates,
    totals:{rows:rows.length, valid:valid.length, invalid:invalid.length, duplicates:duplicates.length,
      impressions:valid.reduce((n, r) => n + (r.impressions || 0), 0), clicks:valid.reduce((n, r) => n + (r.clicks || 0), 0),
      orders:valid.reduce((n, r) => n + (r.orders || 0), 0), revenueCents:valid.reduce((n, r) => n + (r.revenueCents || 0), 0),
      adSpendCents:valid.reduce((n, r) => n + (r.adSpendCents || 0), 0), visitors:valid.reduce((n, r) => n + (r.visitors || 0), 0)}};
}
