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

// ===== テキスト整形ユーティリティ =====
// MTEXT の書式制御コードを除去し、段落区切り \P を改行に変換する。
function stripMText(s) {
  return String(s)
    .replace(/\\P/g, '\n')                       // 段落区切り → 改行
    .replace(/\\~/g, ' ')                         // ノーブレークスペース
    .replace(/\\S([^;]*?)\^([^;]*?);/g, '$1/$2')  // 分数/上下付き a^b → a/b（近似）
    .replace(/\\S([^;]*?);/g, '$1')               // 積み上げ（近似で中身のみ）
    .replace(/\\[A-Za-z][^\\;{}]*;/g, '')         // \H..; \W..; \A..; \C..; \F..; \Q..; \T..; \p..; など
    .replace(/\\[Ll]/g, '').replace(/\\[Oo]/g, '').replace(/\\[Kk]/g, '') // 下線/上線/取消線トグル
    .replace(/[{}]/g, '')                         // グループ化ブレース
    .replace(/\\\\/g, '\\')                       // エスケープされた \
    .replace(/[ \t]+\n/g, '\n');                  // 行末空白
}

// TEXT の halign(72)/valign(73) → Canvas の textAlign/textBaseline
function textAlignFromTEXT(halign, valign) {
  const align = (halign === 1 || halign === 4) ? 'center' : halign === 2 ? 'right' : 'left';
  // halign=4(Middle)は水平・垂直とも中央
  const baseline = halign === 4 ? 'middle'
    : valign === 3 ? 'top' : valign === 2 ? 'middle' : valign === 1 ? 'bottom' : 'alphabetic';
  return { align, baseline };
}
// MTEXT attachmentPoint(71) 1..9 (TL,TC,TR,ML,MC,MR,BL,BC,BR) → textAlign/textBaseline
function textAlignFromMTEXT(ap) {
  const col = (ap - 1) % 3;            // 0:left 1:center 2:right
  const row = Math.floor((ap - 1) / 3); // 0:top 1:middle 2:bottom
  return {
    align: col === 0 ? 'left' : col === 1 ? 'center' : 'right',
    baseline: row === 0 ? 'top' : row === 1 ? 'middle' : 'bottom',
  };
}

// ===== エンティティ -> 描画プリミティブ =====
function entityToShapes(e, styleMap = {}) {
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
      const h = e.textHeight || e.height || e.rectHeight || 1;
      const wf = (typeof e.xScale === 'number' && e.xScale > 0) ? e.xScale : 1; // 幅係数
      const rot = e.rotation || 0;
      if (t === 'MTEXT') {
        // MTEXT: insertionPoint 基準、attachmentPoint で整列、\P で複数行
        const p = e.insertionPoint || e.startPoint || e.position || { x: 0, y: 0 };
        // MTEXTの角度は direction(X軸方向ベクトル group11) が優先。無ければ rotation。
        // （直径/角度寸法などは rotation=0 でも direction に寸法線の傾きが入る）
        const dir = e.direction;
        const mrot = (dir && (dir.x || dir.y)) ? Math.atan2(dir.y, dir.x) : rot;
        const { align, baseline } = textAlignFromMTEXT((e.attachmentPoint | 0) || 1);
        const lines = stripMText(e.text || '').split('\n');
        const lh = h * 1.4; // 行間（近似）
        // baseline が top/middle/bottom のどれでも、1行目を上端起点に順に下げる
        const n = lines.length;
        for (let i = 0; i < n; i++) {
          const str = lines[i];
          if (!str) continue;
          // 行方向はローカルY(下向き)。回転を考慮して各行をずらす
          const dy = -(i) * lh; // 上→下（world Y は上向きなので減算）
          const lx = p.x + dy * Math.sin(mrot);
          const ly = p.y + dy * Math.cos(mrot);
          labels.push({ x: lx, y: ly, text: str, h, rot: mrot, wf, align, baseline });
        }
      } else {
        const halign = e.halign | 0, valign = e.valign | 0;
        const str = (e.text || '').toString();
        const p1 = e.startPoint || e.insertionPoint || e.position || { x: 0, y: 0 };
        const p2 = (e.endPoint && (e.endPoint.x || e.endPoint.y)) ? e.endPoint : p1;
        const vertical = !!(styleMap[e.styleName] && styleMap[e.styleName].vertical);
        if (vertical && str) {
          // 縦書き（テキストスタイルの縦フラグ）: 1文字ずつ上→下に積む。
          // 整列点の中点を列の中心に、送り＝文字高で上下対称に配置（重なり防止）。
          const chars = Array.from(str);
          const n = chars.length;
          const cx = (p1.x + p2.x) / 2;
          const cy0 = (p1.y + p2.y) / 2;
          const step = h; // 1文字あたりの送り
          for (let i = 0; i < n; i++) {
            const cy = cy0 + ((n - 1) / 2 - i) * step; // i=0が上端
            labels.push({ x: cx, y: cy, text: chars[i], h, rot, wf, align: 'center', baseline: 'middle' });
          }
        } else if (str) {
          // 横書き: 整列テキストは第2整列点(endPoint=group11)が基準
          const aligned = halign !== 0 || valign !== 0;
          const p = aligned ? p2 : p1;
          const { align, baseline } = textAlignFromTEXT(halign, valign);
          labels.push({ x: p.x, y: p.y, text: str, h, rot, wf, align, baseline });
        }
      }
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

function buildItems(entities, styleMap = {}, blockMap = {}) {
  const items = [];
  let unsupported = 0;
  for (const e of entities) {
    if (e.isInPaperSpace) continue;
    if (e.type === 'DIMENSION') {
      // 寸法は計算済み幾何を匿名ブロック(*D#)に持つ。そのブロックを展開して描く。
      const blk = e.name && blockMap[e.name];
      if (blk && blk.length) {
        for (const be of blk) {
          const s = entityToShapes(be, styleMap);
          if (s) items.push(s);
        }
      } else {
        unsupported++;
      }
      continue;
    }
    const s = entityToShapes(e, styleMap);
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
  let entities, stats, db;
  try {
    const r = lib.convertEx(ptr);
    db = r.database || {};
    entities = db.entities || [];
    stats = r.stats || { unknownEntityCount: 0 };
  } catch (e) {
    try { lib.dwg_free(ptr); } catch (_) {}
    libReady = null;
    throw new Error('convert: ' + (e.message || e));
  }
  try { lib.dwg_free(ptr); } catch (_) {}
  const styleMap = buildStyleMap(db);
  const blockMap = buildBlockMap(db);
  const { items, unsupported } = buildItems(entities, styleMap, blockMap);
  return { items, unsupported, stats, total: entities.length };
}

// BLOCK_RECORD から「ブロック名 → 内包エンティティ配列」を作る（寸法の匿名ブロック展開用）
function buildBlockMap(db) {
  const map = {};
  try {
    const br = db && db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries;
    const arr = Array.isArray(br) ? br : (br && typeof br === 'object' ? Object.values(br) : []);
    for (const b of arr) {
      if (b && b.name && Array.isArray(b.entities)) map[String(b.name)] = b.entities;
    }
  } catch (_) { /* 取得失敗時は空マップ */ }
  return map;
}

// STYLEテーブルから「スタイル名 → 縦書きか」を作る（standardFlag のビット4=縦書き）
function buildStyleMap(db) {
  const map = {};
  try {
    const ent = db && db.tables && db.tables.STYLE && db.tables.STYLE.entries;
    const arr = Array.isArray(ent) ? ent : (ent && typeof ent === 'object' ? Object.values(ent) : []);
    for (const s of arr) {
      if (s && s.name != null) map[String(s.name)] = { vertical: !!((s.standardFlag | 0) & 4) };
    }
  } catch (_) { /* スタイル取得失敗時は空マップ（全て横書き扱い） */ }
  return map;
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
