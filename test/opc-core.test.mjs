import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync, rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {unitEconomics, metrics, reportSummary, complianceCheck} from '../opc/calc.js';
import {ROLES, SKILL_BINDINGS} from '../opc/constants.js';
import {previewReport} from '../opc/import.js';
import {createZip} from '../opc/zip.js';

test('八岗与 83 条原始绑定完整且顺序稳定', () => {
  assert.equal(ROLES.length, 8);
  assert.equal(SKILL_BINDINGS.length, 83);
  assert.equal(new Set(ROLES.map(role => role.slug)).size, 8);
  assert.equal(SKILL_BINDINGS[0].employeeSlug, 'market-analyst');
  assert.equal(SKILL_BINDINGS[0].skillSlug, 'data-analyst');
  assert.equal(SKILL_BINDINGS[82].employeeSlug, 'data-analyst');
  assert.equal(SKILL_BINDINGS[82].skillSlug, 'skill-creator');
  assert.equal(SKILL_BINDINGS.filter(item => item.employeeSlug === 'product-sourcing').length, 13);
  assert.equal(SKILL_BINDINGS.filter(item => item.employeeSlug === 'store-operator').length, 21);
});

test('选品核算：12.01 / 7.01 与平台费四舍五入到分', () => {
  const result = unitEconomics({priceCents:2990, costCents:1100, shippingCents:400, packagingCents:50, feeBps:600, refundCents:60, adCents:500});
  assert.equal(result.platformFeeCents, 179);
  assert.equal(result.preAdCents, 1201);
  assert.equal(result.postAdCents, 701);
  assert.equal(result.preAdRatePct, 40.17);
  assert.equal(result.breakEvenRoas, 2.49);
  assert.match(result.formulas.join('\n'), /平台费 = 四舍五入/);
  assert.match(result.formulas.join('\n'), /12\.01/);
  assert.match(result.formulas.join('\n'), /7\.01/);
});

test('选品核算：代发已含运费时避免重复计入', () => {
  const result = unitEconomics({priceCents:2990, costCents:1250, shippingCents:0, packagingCents:0, feeBps:600, refundCents:60, adCents:500});
  assert.equal(result.preAdCents, 2990 - 1250 - 179 - 60);
  assert.equal(result.formulas.length, 6);
});

test('推广指标：CTR 3%、点击成交 5%、CPC 0.50、ROAS 3.00', () => {
  const result = metrics({impressions:10000, clicks:300, orders:15, revenueCents:45000, adSpendCents:15000, visitors:1000});
  assert.equal(result.ctrPct, 3);
  assert.equal(result.clickCvrPct, 5);
  assert.equal(result.visitorCvrPct, 1.5);
  assert.equal(result.cpcCents, 50);
  assert.equal(result.roas, 3);
  assert.equal(result.metrics.ctr.numerator, 300);
  assert.equal(result.metrics.ctr.denominator, 10000);
});

test('零分母返回空值并说明原因，不生成错误指标', () => {
  const result = metrics({impressions:100, clicks:0, orders:0, revenueCents:0, adSpendCents:0, visitors:0});
  assert.equal(result.ctrPct, 0);
  assert.equal(result.metrics.clickCvr.value, null);
  assert.equal(result.metrics.clickCvr.reason, '分母为零');
  assert.equal(result.metrics.roas.value, null);
  assert.equal(result.metrics.roas.reason, '分母为零');
  assert.equal(result.metrics.cpc.value, null);
});

test('报表汇总只合计有效行', () => {
  const rows = [
    {date:'2026-11-10',impressions:10000,clicks:300,orders:15,revenueCents:45000,adSpendCents:15000,visitors:1000,errors:[]},
    {date:'2026-13-40',impressions:100,clicks:10,orders:1,revenueCents:1000,adSpendCents:500,visitors:10,errors:['日期无效']},
  ];
  const summary = reportSummary(rows);
  assert.equal(summary.validRows, 1);
  assert.equal(summary.invalidRows, 1);
  assert.equal(summary.impressions, 10000);
  assert.equal(summary.metrics.ctrPct, 3);
  assert.equal(summary.metrics.roas, 3);
});

test('CSV 预览识别零分母、日期错误、非数字和重复行', () => {
  const csv = ['日期,曝光,点击,成交单量,归因销售额,推广费用,访客数',
    '2026-11-10,10000,300,15,450,150,1000',
    '2026-13-40,100,10,1,10,5,10',
    '2026-11-11,100,abc,1,10,5,10',
    '2026-11-12,100,0,3,10,5,10',
    '2026-11-13,100,500,3,10,5,10',
    '2026-11-14,100,10,1,-10,5,10',
    '2026-11-10,10000,300,15,450,150,1000',
  ].join('\n');
  const preview = previewReport({text:csv, filename:'preview.csv', dataDir:'/tmp'});
  assert.equal(preview.ok, true);
  assert.equal(preview.totals.rows, 7);
  assert.equal(preview.totals.valid, 1);
  assert.equal(preview.totals.invalid, 5);
  assert.equal(preview.totals.duplicates, 1);
  assert.equal(preview.totals.impressions, 10000);
  assert.equal(preview.totals.revenueCents, 45000);
});

test('极限词检查命中并给出改写提示', () => {
  const hit = complianceCheck('全网第一，百分百有效');
  assert.equal(hit.ok, false);
  assert.ok(hit.hits.includes('全网第一'));
  const clean = complianceCheck('折叠收纳，桌面不占地');
  assert.equal(clean.ok, true);
});

test('ZIP 导出包可被系统解压并保留文件名', () => {
  const path = '/tmp/opc-test-export.zip';
  rmSync(path, {force:true});
  writeFileSync(path, createZip([{name:'manifest.json', data:'{"ok":true}'}, {name:'skus.csv', data:'SKU,售价\n标准款,29.90'}]));
  const listing = execFileSync('unzip', ['-l', path], {encoding:'utf8'});
  assert.match(listing, /manifest\.json/);
  assert.match(listing, /skus\.csv/);
  rmSync(path, {force:true});
});
