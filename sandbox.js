// サンドボックス（unsafe-eval 許可）内で WASM 解析 + 図形化まで実行する。
// 親へは「数値・文字列だけの描画プリミティブ」を返す（entitiesのクローン不可問題を排除）。
import { LibreDwg, Dwg_File_Type } from './vendor/dist/libredwg-web.js';

let wasmBase = null;
let libReady = null;

function getLib() {
  if (!libReady) {
    if (!wasmBase) throw new Error('wasmBase 未設定');
    libReady = LibreDwg.create(wasmBase);
  }
  return libReady;
}

// ===== 幾何ユーティリティ =====
const TAU = Math.PI * 2;

function bulgePoints(p1, p2, bulge, segs = 24) {
  if (!bulge) return [p1, p2];
  const theta = 4 * Math.atan(Math.abs(bulge));
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (chord === 0) return [p1, p2];
  const radius = chord / (2 * Math.sin(theta / 2));
  const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const gamma = (Math.PI - theta) / 2;
  const cAng = bulge > 0 ? ang + gamma : ang - gamma;
  const cx = p1.x + radius * Math.cos(cAng);
  const cy = p1.y + radius * Math.sin(cAng);
  let a0 = Math.atan2(p1.y - cy, p1.x - cx);
  let a1 = Math.atan2(p2.y - cy, p2.x - cx);
  if (bulge > 0 && a1 < a0) a1 += TAU;
  if (bulge < 0 && a1 > a0) a1 -= TAU;
  const n = Math.max(2, Math.ceil(segs * theta / TAU));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (a1 - a0) * (i / n);
    out.push({ x: cx + radius * Math.cos(t), y: cy + radius * Math.sin(t) });
  }
  return out;
}

function arcPoints(cx, cy, r, a0, a1, ccw = true, segs = 64) {
  let s = a0, e = a1;
  if (ccw && e < s) e += TAU;
  if (!ccw && e > s) e -= TAU;
  const n = Math.max(6, Math.ceil(segs * Math.abs(e - s) / TAU));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = s + (e - s) * (i / n);
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return out;
}

// ===== AutoCAD カラーインデックス(ACI) -> RGB =====
// 基本色(1-9) + 標準パレットの近似生成(10-249) + グレースケール(250-255)
const ACI_BASE = {
  1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255],
  5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128],
  9: [192, 192, 192],
};
function aciToRgb(idx) {
  if (idx == null) return null;
  idx = idx | 0;
  if (idx <= 0 || idx === 256) return null;     // 0=ByBlock / 256=ByLayer → 既定色
  if (ACI_BASE[idx]) return ACI_BASE[idx];
  if (idx >= 250 && idx <= 255) {               // グレースケール
    const g = Math.round(((idx - 250) / 5) * 255);
    return [g, g, g];
  }
  // 10-249: 24色相 x 5明度 x 2彩度 の標準パレット近似
  const i = idx - 10;
  const hue = (Math.floor(i / 10) * 15) % 360;
  const lvl = i % 10;
  const light = [1.0, 0.65][lvl % 2];
  const sat = [1.0, 0.5][Math.floor(lvl / 2) % 2] || 1.0;
  return hslToRgb(hue / 360, sat, 0.5 * light + 0.0);
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function entityColor(e) {
  // trueColor(RGB)優先 → ACI。無ければ null(=背景に応じた既定色)
  const tc = e.trueColor ?? e.rgb ?? e.color?.rgb;
  if (typeof tc === 'number' && tc > 0) {
    return [(tc >> 16) & 255, (tc >> 8) & 255, tc & 255];
  }
  const aci = e.colorIndex ?? e.color_index ?? (typeof e.color === 'number' ? e.color : e.color?.index);
  // ACI 7 は「前景色」（白背景=黒/黒背景=白）。固定白だと白背景で消えるため null を返す。
  if ((aci | 0) === 7) return null;
  return aciToRgb(aci);
}

// ===== エンティティ -> 描画プリミティブ =====
function entityToShapes(e) {
  const polylines = [];
  const labels = [];
  let supported = false;
  const t = e.type;
  try {
    if (t === 'LINE') {
      const a = e.startPoint, b = e.endPoint;
      polylines.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
      supported = true;
    } else if (t === 'CIRCLE') {
      polylines.push(arcPoints(e.center.x, e.center.y, e.radius, 0, TAU));
      supported = true;
    } else if (t === 'ARC') {
      polylines.push(arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle, true));
      supported = true;
    } else if (t === 'ELLIPSE') {
      const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y;
      const major = Math.hypot(mx, my);
      const minor = major * e.axisRatio;
      const rot = Math.atan2(my, mx);
      const a0 = e.startAngle ?? 0, a1 = e.endAngle ?? TAU;
      const n = 96; const pts = [];
      let s = a0, en = a1; if (en <= s) en += TAU;
      for (let i = 0; i <= n; i++) {
        const tt = s + (en - s) * (i / n);
        const lx = major * Math.cos(tt), ly = minor * Math.sin(tt);
        pts.push({ x: e.center.x + lx * Math.cos(rot) - ly * Math.sin(rot),
                   y: e.center.y + lx * Math.sin(rot) + ly * Math.cos(rot) });
      }
      polylines.push(pts);
      supported = true;
    } else if (t === 'LWPOLYLINE' || t === 'POLYLINE') {
      const verts = e.vertices || [];
      const closed = !!((e.flag || 0) & 1);
      const pts = [];
      for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        const nv = verts[(i + 1) % verts.length];
        if (i < verts.length - 1 || closed) {
          const seg = bulgePoints({ x: v.x, y: v.y }, { x: nv.x, y: nv.y }, v.bulge || 0);
          if (pts.length) seg.shift();
          pts.push(...seg);
        } else {
          pts.push({ x: v.x, y: v.y });
        }
      }
      if (pts.length) polylines.push(pts);
      supported = true;
    } else if (t === 'POINT') {
      const p = e.position; const d = 0.6;
      polylines.push([{ x: p.x - d, y: p.y }, { x: p.x + d, y: p.y }]);
      polylines.push([{ x: p.x, y: p.y - d }, { x: p.x, y: p.y + d }]);
      supported = true;
    } else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB' || t === 'ATTDEF') {
      const p = e.startPoint || e.insertionPoint || e.position || { x: 0, y: 0 };
      const h = e.textHeight || e.height || e.rectHeight || 1;
      const str = (e.text || '').toString();
      if (str) labels.push({ x: p.x, y: p.y, text: str, h, rot: e.rotation || 0 });
      supported = true;
    } else if (t === 'INSERT') {
      const p = e.insertionPoint; const m = 2;
      polylines.push([{ x: p.x - m, y: p.y - m }, { x: p.x + m, y: p.y - m },
                      { x: p.x + m, y: p.y + m }, { x: p.x - m, y: p.y + m },
                      { x: p.x - m, y: p.y - m }]);
      labels.push({ x: p.x, y: p.y, text: e.name || '(block)', h: 2, rot: e.rotation || 0 });
      supported = true;
    } else if (t === 'SPLINE') {
      const cp = (e.fitPoints && e.fitPoints.length ? e.fitPoints : e.controlPoints) || [];
      if (cp.length) polylines.push(cp.map(p => ({ x: p.x, y: p.y })));
      supported = true;
    } else if (t === 'SOLID' || t === '3DFACE') {
      const c = [e.corner1, e.corner2, e.corner4, e.corner3].filter(Boolean);
      if (c.length >= 3) { const pts = c.map(p => ({ x: p.x, y: p.y })); pts.push(pts[0]); polylines.push(pts); }
      supported = true;
    }
  } catch (err) { /* 1エンティティの失敗で全体を止めない */ }
  if (!supported) return null;
  return {
    polylines, labels, type: t,
    layer: (e.layer != null ? String(e.layer) : '0'),
    color: entityColor(e),
  };
}

function buildItems(entities) {
  const items = [];
  let unsupported = 0;
  for (const e of entities) {
    if (e.isInPaperSpace) continue;
    const s = entityToShapes(e);
    if (!s) { unsupported++; continue; }
    items.push(s);
  }
  return { items, unsupported };
}

// ===== 解析パイプライン =====
async function parseToItems(buffer) {
  const lib = await getLib();
  let ptr;
  try {
    ptr = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
  } catch (e) { libReady = null; throw new Error('dwg_read_data: ' + (e.message || e)); }
  if (ptr === undefined || ptr === null || ptr === 0) {
    throw new Error('libredwg がこのDWGを開けませんでした（未対応バージョン/独自オブジェクトの可能性）');
  }
  let entities, stats;
  try {
    const r = lib.convertEx(ptr);
    entities = (r.database && r.database.entities) || [];
    stats = r.stats || { unknownEntityCount: 0 };
  } catch (e) {
    try { lib.dwg_free(ptr); } catch (_) {}
    libReady = null;
    throw new Error('convert: ' + (e.message || e));
  }
  try { lib.dwg_free(ptr); } catch (_) {}
  const { items, unsupported } = buildItems(entities);
  return { items, unsupported, stats, total: entities.length };
}

window.addEventListener('message', async (ev) => {
  const msg = ev.data || {};
  const post = (m) => ev.source.postMessage(m, '*');
  try {
    if (msg.type === 'init') {
      wasmBase = msg.wasmBase;
      await getLib();
      post({ type: 'ready' });
    } else if (msg.type === 'parse') {
      const res = await parseToItems(msg.buffer);
      post({ type: 'result', id: msg.id, ok: true, items: res.items,
             unsupported: res.unsupported, stats: res.stats, total: res.total });
    }
  } catch (err) {
    const error = (err && (err.name ? err.name + ': ' : '') + (err.message || String(err))) || 'unknown';
    const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
    if (msg.type === 'init') post({ type: 'fatal', error, stack });
    else post({ type: 'result', id: msg.id, ok: false, error, stack });
  }
});
