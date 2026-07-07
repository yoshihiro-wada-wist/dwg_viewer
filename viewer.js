/* ============================================================
   DWG Viewer - 単一DWG表示ビューア（メイン側）
   解析+図形化: sandbox(iframe) 側で実行し、描画用プリミティブのみ受信
   描画: Canvas2D / レイヤ別表示ON-OFF / パン・ズーム / ドラッグ&ドロップ
   ============================================================ */

// DWGを解析し、描画用アイテム配列を返す（毎回 専用sandbox を立てて委譲）
async function parseItems(arrayBuffer) {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = chrome.runtime.getURL('sandbox.html');
  const wasmBase = chrome.runtime.getURL('vendor/wasm');
  const copy = arrayBuffer.slice(0); // transferで元を壊さないため複製
  let onMsg;
  try {
    const res = await new Promise((resolve, reject) => {
      onMsg = (ev) => {
        if (ev.source !== iframe.contentWindow) return;
        const m = ev.data || {};
        if (m.type === 'ready') {
          iframe.contentWindow.postMessage({ type: 'parse', id: 1, buffer: copy }, '*', [copy]);
        } else if (m.type === 'fatal') {
          reject(new Error('sandbox初期化失敗: ' + (m.error || '') + (m.stack ? '\n' + m.stack : '')));
        } else if (m.type === 'result') {
          if (m.ok) resolve(m);
          else reject(new Error((m.error || 'parse失敗') + (m.stack ? '\n' + m.stack : '')));
        }
      };
      window.addEventListener('message', onMsg);
      iframe.addEventListener('load', () => {
        iframe.contentWindow.postMessage({ type: 'init', wasmBase }, '*');
      });
      document.body.appendChild(iframe);
    });
    return {
      items: res.items || [],
      unsupported: res.unsupported || 0,
      stats: res.stats || { unknownEntityCount: 0 },
      total: res.total || 0,
    };
  } finally {
    if (onMsg) window.removeEventListener('message', onMsg);
    iframe.remove(); // WASMモジュールごと破棄（次の解析はクリーンな状態で）
  }
}

// ============================================================
//  カメラ
// ============================================================
const cam = { scale: 1, ox: 0, oy: 0 };
function w2s(p) { return { x: p.x * cam.scale + cam.ox, y: -p.y * cam.scale + cam.oy }; }

function fitTo(bbox, W, H) {
  if (!bbox) return;
  const pad = 40;
  const dw = Math.max(bbox.maxx - bbox.minx, 1e-6);
  const dh = Math.max(bbox.maxy - bbox.miny, 1e-6);
  cam.scale = Math.min((W - 2 * pad) / dw, (H - 2 * pad) / dh);
  const cx = (bbox.minx + bbox.maxx) / 2;
  const cy = (bbox.miny + bbox.maxy) / 2;
  cam.ox = W / 2 - cx * cam.scale;
  cam.oy = H / 2 + cy * cam.scale;
}

// ============================================================
//  状態 & DOM
// ============================================================
const els = {
  file: document.getElementById('file'),
  name: document.getElementById('name'),
  invert: document.getElementById('invert'),
  fitBtn: document.getElementById('fitBtn'),
  layersBtn: document.getElementById('layersBtn'),
  printBtn: document.getElementById('printBtn'),
  layers: document.getElementById('layers'),
  layersList: document.getElementById('layersList'),
  layersAll: document.getElementById('layersAll'),
  layersNone: document.getElementById('layersNone'),
  canvas: document.getElementById('canvas'),
  overlay: document.getElementById('overlay'),
  drophint: document.getElementById('drophint'),
  status: document.getElementById('status'),
};
const ctx = els.canvas.getContext('2d');

let items = [];
let bbox = null;
let layerState = new Map(); // layer名 -> { visible, count }

function setStatus(msg, isErr = false) {
  els.status.textContent = msg || '';
  els.status.classList.toggle('err', !!isErr);
}

function defaultColor() {
  // 背景に対するデフォルト線色（色指定の無いエンティティ用）
  return els.invert.checked ? '#000000' : '#e6e8ec';
}
function itemColor(it) {
  if (it.color) return `rgb(${it.color[0]},${it.color[1]},${it.color[2]})`;
  return defaultColor();
}

// ============================================================
//  読み込み
// ============================================================
async function loadFile(file) {
  if (!file) return;
  if (!/\.dwg$/i.test(file.name)) { setStatus('DWGファイルを選択してください: ' + file.name, true); return; }
  let stage = '開始';
  try {
    els.name.textContent = file.name;
    stage = 'ファイル読込';
    setStatus('① ' + stage + '中…');
    const buf = await file.arrayBuffer();

    stage = '解析';
    setStatus('② DWGを' + stage + '中…（初回はWASM読込で数秒かかります）');
    const r = await parseItems(buf);
    items = r.items;

    stage = '描画';
    setStatus('③ ' + stage + '中…');
    buildLayers();
    bbox = computeBbox(items);
    els.overlay.classList.add('hidden');
    resizeCanvas();
    // fitTo は CSS ピクセル基準（render は setTransform(dpr) で CSS 座標系に描画するため）。
    // canvas.width/height はデバイスpx（=CSS×dpr）なので高解像度環境でフィットがずれる。
    fitTo(bbox, els.canvas.clientWidth, els.canvas.clientHeight);
    render();

    const warn = [];
    // 同名ファイルの再読込が効いたか判別できるよう、サイズ・更新時刻も表示
    const kb = (file.size / 1024).toFixed(1);
    const mt = file.lastModified ? new Date(file.lastModified).toLocaleString() : '不明';
    warn.push(`${file.name}（${kb} KB / 更新 ${mt}）: 図形 ${items.length} / 全 ${r.total} 件, レイヤ ${layerState.size}`);
    if (r.unsupported) warn.push(`未対応エンティティ: ${r.unsupported} 件（除外）`);
    if (r.stats.unknownEntityCount) warn.push(`libredwg未知: ${r.stats.unknownEntityCount}`);
    setStatus(warn.join('\n'));
  } catch (err) {
    console.error('[DWG Viewer] stage=' + stage, err);
    const msg = (err && err.message) ? err.message : String(err);
    setStatus(`エラー（段階: ${stage}）\n${msg}`, true);
  }
}

function computeBbox(list) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const acc = (p) => { if (p.x < minx) minx = p.x; if (p.y < miny) miny = p.y; if (p.x > maxx) maxx = p.x; if (p.y > maxy) maxy = p.y; };
  for (const it of list) {
    for (const pl of it.polylines) for (const p of pl) acc(p);
    for (const l of it.labels) acc(l);
  }
  if (!isFinite(minx)) return null;
  return { minx, miny, maxx, maxy };
}

// ============================================================
//  レイヤパネル
// ============================================================
function buildLayers() {
  const prev = layerState;
  layerState = new Map();
  for (const it of items) {
    const ly = it.layer || '0';
    if (!layerState.has(ly)) layerState.set(ly, { visible: prev.get(ly)?.visible ?? true, count: 0, color: it.color });
    layerState.get(ly).count++;
  }
  renderLayers();
}

function renderLayers() {
  els.layersList.innerHTML = '';
  const names = [...layerState.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const ly of names) {
    const st = layerState.get(ly);
    const row = document.createElement('label');
    row.className = 'layer-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = st.visible;
    cb.addEventListener('change', () => { st.visible = cb.checked; render(); });
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = st.color ? `rgb(${st.color[0]},${st.color[1]},${st.color[2]})` : '#888';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = ly; nm.title = ly;
    const ct = document.createElement('span');
    ct.className = 'ct'; ct.textContent = st.count;
    row.append(cb, sw, nm, ct);
    els.layersList.appendChild(row);
  }
}

// ============================================================
//  描画
// ============================================================
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = els.canvas.getBoundingClientRect();
  els.canvas.width = Math.round(r.width * dpr);
  els.canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  els.canvas.classList.toggle('dark', !els.invert.checked);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const it of items) {
    const st = layerState.get(it.layer || '0');
    if (st && !st.visible) continue;
    const col = itemColor(it);
    ctx.strokeStyle = col;
    ctx.beginPath();
    for (const pl of it.polylines) {
      for (let i = 0; i < pl.length; i++) {
        const s = w2s(pl[i]);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      }
    }
    ctx.stroke();
    for (const l of it.labels) {
      const s = w2s(l);
      const fs = Math.max(0, l.h * cam.scale);
      if (fs < 5) continue;
      ctx.save();
      ctx.translate(s.x, s.y);
      if (l.rot) ctx.rotate(-l.rot);
      if (l.wf && l.wf !== 1) ctx.scale(l.wf, 1); // 幅係数(xScale)
      ctx.fillStyle = col;
      // DWGのtextHeightをそのままemに（CJKはグリフがほぼem全体を埋めるため一致が良い）
      ctx.font = `${fs}px sans-serif`;
      ctx.textAlign = l.align || 'left';
      ctx.textBaseline = l.baseline || 'alphabetic';
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

// ============================================================
//  印刷（表示中の図面を高解像度で白背景レンダリングして印刷）
// ============================================================
function printDrawing() {
  if (!bbox || !items.length) { setStatus('印刷する図面がありません。先にDWGを開いてください。', true); return; }
  // A4横 相当の高解像度キャンバスへ全体フィット描画（白背景・色なしは黒）
  const W = 2480, H = 1754, pad = 60; // 約300dpi A4 landscape
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const c = off.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);

  const dw = Math.max(bbox.maxx - bbox.minx, 1e-6);
  const dh = Math.max(bbox.maxy - bbox.miny, 1e-6);
  const scale = Math.min((W - 2 * pad) / dw, (H - 2 * pad) / dh);
  const cx = (bbox.minx + bbox.maxx) / 2, cy = (bbox.miny + bbox.maxy) / 2;
  const ox = W / 2 - cx * scale, oy = H / 2 + cy * scale;
  const tp = (p) => ({ x: p.x * scale + ox, y: -p.y * scale + oy });

  c.lineWidth = 1; c.lineJoin = 'round'; c.lineCap = 'round';
  for (const it of items) {
    const st = layerState.get(it.layer || '0');
    if (st && !st.visible) continue;
    const col = it.color ? `rgb(${it.color[0]},${it.color[1]},${it.color[2]})` : '#000000';
    c.strokeStyle = col;
    c.beginPath();
    for (const pl of it.polylines) {
      for (let i = 0; i < pl.length; i++) {
        const s = tp(pl[i]);
        if (i === 0) c.moveTo(s.x, s.y); else c.lineTo(s.x, s.y);
      }
    }
    c.stroke();
    for (const l of it.labels) {
      const s = tp(l);
      const fs = l.h * scale;
      if (fs < 4) continue;
      c.save();
      c.translate(s.x, s.y);
      if (l.rot) c.rotate(-l.rot);
      if (l.wf && l.wf !== 1) c.scale(l.wf, 1);
      c.fillStyle = col;
      c.font = `${fs}px sans-serif`;
      c.textAlign = l.align || 'left';
      c.textBaseline = l.baseline || 'alphabetic';
      c.fillText(l.text, 0, 0);
      c.restore();
    }
  }

  const url = off.toDataURL('image/png');
  const win = window.open('', '_blank');
  if (!win) { setStatus('ポップアップがブロックされました。印刷を許可してください。', true); return; }
  const title = els.name.textContent || 'DWG';
  const doc = win.document;
  // 注: 拡張CSP(script-src 'self')はインライン onload を禁止する。
  // about:blank ポップアップは拡張オリジンのCSPを継承するため、印刷トリガは
  // 親('self'スクリプト)から img.onload をプロパティ設定して呼ぶ。
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>@page{size:A4 landscape;margin:8mm}
    html,body{margin:0;height:100%}
    img{width:100%;height:100%;object-fit:contain;display:block}</style></head>
    <body></body></html>`);
  doc.close();
  const img = doc.createElement('img');
  img.onload = () => { try { win.focus(); win.print(); } catch (_) {} };
  img.src = url;
  doc.body.appendChild(img);
}

// ============================================================
//  UIイベント
// ============================================================
els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0];
  els.file.value = ''; // 同じファイルの再選択でも change を発火させる
  loadFile(f);
});
els.fitBtn.addEventListener('click', () => { if (bbox) { resizeCanvas(); fitTo(bbox, els.canvas.clientWidth, els.canvas.clientHeight); render(); } });
els.invert.addEventListener('change', render);
els.layersBtn.addEventListener('click', () => els.layers.classList.toggle('hidden'));
els.printBtn.addEventListener('click', printDrawing);
els.layersAll.addEventListener('click', () => { for (const st of layerState.values()) st.visible = true; renderLayers(); render(); });
els.layersNone.addEventListener('click', () => { for (const st of layerState.values()) st.visible = false; renderLayers(); render(); });

// ---- パン / ズーム ----
let dragging = false, lastX = 0, lastY = 0;
els.canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  els.canvas.classList.add('dragging');
  els.canvas.setPointerCapture(e.pointerId);
});
els.canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.ox += (e.clientX - lastX); cam.oy += (e.clientY - lastY);
  lastX = e.clientX; lastY = e.clientY; render();
});
els.canvas.addEventListener('pointerup', (e) => {
  dragging = false; els.canvas.classList.remove('dragging');
  els.canvas.releasePointerCapture(e.pointerId);
});
els.canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = els.canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const f = Math.exp(-e.deltaY * 0.0015);
  const wx = (mx - cam.ox) / cam.scale;
  const wy = -(my - cam.oy) / cam.scale;
  cam.scale *= f;
  cam.ox = mx - wx * cam.scale;
  cam.oy = my + wy * cam.scale;
  render();
}, { passive: false });

window.addEventListener('resize', () => { if (bbox) { resizeCanvas(); render(); } });

// ============================================================
//  ドラッグ & ドロップ
// ============================================================
let dragDepth = 0;
function showDrop(on) { els.drophint.classList.toggle('hidden', !on); }

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; showDrop(true); }
});
window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDrop(false);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; showDrop(false);
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
