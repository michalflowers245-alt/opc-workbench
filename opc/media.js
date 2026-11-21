import {mkdirSync, writeFileSync, existsSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {runPython} from './python.js';

const FONT = '/System/Library/Fonts/STHeiti Medium.ttc';
const FONT_FALLBACK = '/System/Library/Fonts/Supplemental/Songti.ttc';

const SCRIPT = String.raw`
import json, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

args = json.loads(sys.argv[1])
outdir = args['outdir']
os.makedirs(outdir, exist_ok=True)
font_path = args.get('font') or ''
fallback = args.get('fontFallback') or ''
def font(size):
    for path in (font_path, fallback):
        if path and os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=0)
            except Exception:
                try: return ImageFont.truetype(path, size)
                except Exception: pass
    return ImageFont.load_default()

def gradient(w, h, top, bottom):
    img = Image.new('RGB', (w, h), top)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        color = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=color)
    return img

def rounded(d, box, radius, fill, outline=None, width=2):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

def base_scene(w, h, title, subtitle, tag):
    img = gradient(w, h, (246, 243, 238), (226, 231, 236))
    d = ImageDraw.Draw(img)
    # 桌面
    d.rectangle([0, int(h*0.72), w, h], fill=(203, 188, 170))
    d.rectangle([0, int(h*0.72), w, int(h*0.72)+10], fill=(180, 164, 146))
    # 手机支架：底座 + 折臂 + 托架
    cx = int(w*0.52)
    base_y = int(h*0.72)
    rounded(d, [cx-150, base_y-46, cx+150, base_y], 22, (38, 40, 44))
    d.polygon([(cx-22, base_y-46), (cx+22, base_y-46), (cx+18, base_y-210), (cx-18, base_y-210)], fill=(58, 61, 66))
    # 折臂
    d.line([(cx, base_y-205), (cx+120, base_y-330)], fill=(70, 74, 80), width=34)
    d.ellipse([cx+104, base_y-352, cx+140, base_y-316], fill=(90, 95, 102))
    # 手机
    phone = [cx+30, base_y-500, cx+290, base_y-190]
    rounded(d, phone, 30, (24, 26, 30), outline=(12, 13, 15), width=4)
    rounded(d, [phone[0]+14, phone[1]+18, phone[2]-14, phone[3]-18], 22, (245, 247, 250))
    # 屏幕内容
    d.rectangle([phone[0]+30, phone[1]+60, phone[2]-30, phone[1]+120], fill=(76, 124, 255))
    d.rectangle([phone[0]+30, phone[1]+150, phone[2]-80, phone[1]+175], fill=(205, 212, 222))
    d.rectangle([phone[0]+30, phone[1]+195, phone[2]-60, phone[1]+220], fill=(205, 212, 222))
    d.rectangle([phone[0]+30, phone[1]+240, phone[2]-110, phone[1]+265], fill=(205, 212, 222))
    # 阴影
    d.ellipse([cx-210, base_y-16, cx+330, base_y+26], fill=(176, 164, 148))
    # 标题
    d.text((44, 42), title, font=font(46), fill=(30, 34, 40))
    d.text((46, 106), subtitle, font=font(24), fill=(83, 90, 99))
    # 角标
    tw = d.textlength(tag, font=font(20))
    rounded(d, [w-44-tw-28, 40, w-44, 84], 18, (255, 255, 255))
    d.text((w-44-tw-14, 50), tag, font=font(20), fill=(60, 66, 74))
    return img

def save(img, path):
    img.save(path, 'PNG', optimize=True)
    return {'path': path, 'width': img.width, 'height': img.height, 'bytes': os.path.getsize(path)}

results = []
for spec in args['images']:
    path = os.path.join(outdir, spec['filename'])
    if spec['kind'] == 'base':
        img = base_scene(spec.get('width', 800), spec.get('height', 800), spec.get('headline',''), spec.get('subline',''), spec.get('tag','合成演示'))
        results.append({'filename': spec['filename'], **save(img, path)})
    elif spec['kind'] == 'detail':
        w, h = spec.get('width', 750), spec.get('height', 1000)
        img = gradient(w, h, (250, 248, 244), (220, 228, 236))
        d = ImageDraw.Draw(img)
        d.text((48, 42), spec.get('headline',''), font=font(40), fill=(30,34,40))
        d.text((50, 102), spec.get('subline',''), font=font(22), fill=(83,90,99))
        y = 160
        for i, screen in enumerate(spec.get('screens', [])):
            rounded(d, [40, y, w-40, y+180], 22, (255,255,255), outline=(226,230,235), width=2)
            d.text((66, y+24), str(i+1) + '  ' + screen.get('title',''), font=font(26), fill=(36,40,46))
            d.text((66, y+70), screen.get('copy',''), font=font(20), fill=(96,104,114))
            d.text((66, y+112), screen.get('evidence',''), font=font(17), fill=(130,138,148))
            y += 200
        results.append({'filename': spec['filename'], **save(img, path)})
    elif spec['kind'] == 'overlay':
        base_path = spec['base']
        w, h = spec.get('width', 800), spec.get('height', 800)
        img = Image.open(base_path).convert('RGB')
        img = img.resize((w, h), Image.LANCZOS)
        d = ImageDraw.Draw(img, 'RGBA')
        # 顶部标题条
        d.rectangle([0, 0, w, 128], fill=(18, 22, 28, 190))
        d.text((40, 24), spec.get('headline',''), font=font(42), fill=(255,255,255,255))
        d.text((42, 84), spec.get('subline',''), font=font(22), fill=(226,232,240,255))
        # 底部卖点
        d.rectangle([0, h-112, w, h], fill=(18, 22, 28, 178))
        d.text((40, h-92), spec.get('badge',''), font=font(30), fill=(255,214,102,255))
        d.text((40, h-48), spec.get('footnote','合成演示素材 · 非真实商品图'), font=font(18), fill=(226,232,240,230))
        results.append({'filename': spec['filename'], **save(img, path)})
    else:
        raise ValueError('unknown kind ' + spec['kind'])

print(json.dumps({'images': results}, ensure_ascii=False))
`;

function sha256File(path) {
  const buffer = statSync(path).isFile() ? requireBuffer(path) : null;
  return buffer ? createHash('sha256').update(buffer).digest('hex') : null;
}
import {readFileSync} from 'node:fs';
function requireBuffer(path) { return readFileSync(path); }

export function runMediaScript({outDir, images}) {
  mkdirSync(outDir, {recursive: true});
  const result = runPython('PIL', SCRIPT, [JSON.stringify({
    outdir: outDir, font: FONT, fontFallback: FONT_FALLBACK, images,
  })], {timeout: 120000});
  if (!result.ok) return result;
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim().split('\n').pop()); }
  catch { return {ok: false, error: '生图脚本输出无法解析', stdout: result.stdout, stderr: result.stderr}; }
  return {ok: true, images: parsed.images.map(image => ({...image, sha256: sha256File(image.path)}))};
}

export function ensureDemoMedia({filesRoot, projectId}) {
  const outDir = resolve(filesRoot, projectId, 'demo-media');
  const expected = ['product-original-main.png', 'product-original-angle.png', 'product-detail-750x1000.png', 'product-sku-pro.png'];
  if (expected.every(name => existsSync(resolve(outDir, name)))) {
    return {ok: true, files: expected.map(name => resolve(outDir, name)), cached: true};
  }
  const images = [
    {kind:'base', filename:'product-original-main.png', width:800, height:800, headline:'折叠桌面手机支架', subline:'合成演示素材 · 标准款黑色', tag:'合成演示'},
    {kind:'base', filename:'product-original-angle.png', width:800, height:800, headline:'折叠 · 收纳 · 桌面', subline:'材质、承重与尺寸待供应商复核', tag:'待核项'},
    {kind:'detail', filename:'product-detail-750x1000.png', width:750, height:1000, headline:'详情演示 · 750 宽', subline:'逐屏目的、画面、文案与证据', screens:[
      {title:'桌面不占地', copy:'折叠后收起，展开即用', evidence:'合成演示脚本，非真实卖点证据'},
      {title:'追剧与办公', copy:'手机横竖都稳，桌面更清爽', evidence:'待实物样品验证'},
      {title:'规格与售后', copy:'两个 SKU，参数以商品事实表为准', evidence:'退换政策见店铺知识'},
    ]},
    {kind:'base', filename:'product-sku-pro.png', width:800, height:800, headline:'加强款 · 深灰', subline:'带伸缩臂（合成演示）', tag:'SKU 2'},
  ];
  const result = runMediaScript({outDir, images});
  if (!result.ok) return result;
  return {ok: true, files: result.images.map(image => image.path), images: result.images, cached: false};
}
