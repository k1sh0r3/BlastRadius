'use strict';
/* BlastRadius UI: upload -> graph -> inspector. All local, no network. */

const engine = BlastLineage.createEngine(Parser);
const state = {
  project: null, lineage: null, dialect: 'bigquery', projectLabel: '',
  selModel: null, selColumn: null,
  upNodes: new Set(), blastNodes: new Set(),
};

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shortName(node) { return node.alias || node.name || node.id; }
function keyOf(nodeId, col) { return engine.outKey(nodeId, col); }
function dispOf(nodeId, col) {
  return (state.lineage.displayName.get(keyOf(nodeId, col))) || col;
}
function nodeLabel(nodeId) {
  const n = state.project.nodes.get(nodeId);
  return n ? shortName(n) : nodeId;
}

/* ---------- loading ---------- */
function showError(msg) {
  const el = $('uploadError');
  el.textContent = msg;
  el.hidden = false;
}
function analyze(label) {
  try {
    state.lineage = engine.buildColumnLineage(state.project, state.dialect);
  } catch (e) {
    showError('Analysis failed: ' + (e && e.message || e));
    return;
  }
  state.projectLabel = label;
  state.selModel = null; state.selColumn = null;
  state.upNodes = new Set(); state.blastNodes = new Set();
  $('view-upload').hidden = true;
  $('view-app').hidden = false;
  $('projectName').textContent = label;
  $('dialectBadge').textContent = state.dialect;
  renderAll();
  if (state.lineage.parseErrors.length) {
    $('graphHint').textContent =
      state.lineage.parseErrors.length + ' model(s) had SQL that could not be parsed — shown without column detail.';
  }
}
function loadManifestFile(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const manifest = JSON.parse(rd.result);
      state.project = engine.parseManifest(manifest);
      if (!state.project.nodes.size) { showError('No models or sources found in that manifest.'); return; }
      analyze(file.name.replace(/\.json$/, ''));
    } catch (e) {
      showError('Could not parse manifest.json: ' + (e && e.message || e));
    }
  };
  rd.readAsText(file);
}
function loadSqlFiles(files) {
  const readers = [...files].map((f) => new Promise((res, rej) => {
    const rd = new FileReader();
    rd.onload = () => res({ name: f.name, sql: String(rd.result) });
    rd.onerror = rej;
    rd.readAsText(f);
  }));
  Promise.all(readers).then((arr) => {
    state.project = engine.buildFromSqlFiles(arr, state.dialect);
    if (!state.project.nodes.size) { showError('No .sql files with content found.'); return; }
    analyze(arr.length + ' sql file' + (arr.length === 1 ? '' : 's'));
  }).catch(() => showError('Could not read the selected files.'));
}
function handleFiles(fileList) {
  $('uploadError').hidden = true;
  const files = [...fileList];
  if (!files.length) return;
  state.dialect = $('dialect').value;
  const json = files.find((f) => /\.json$/i.test(f.name));
  if (json) { loadManifestFile(json); return; }
  const sql = files.filter((f) => /\.sql$/i.test(f.name));
  if (sql.length) { loadSqlFiles(sql); return; }
  showError('Please drop a dbt manifest.json or one or more .sql files.');
}

/* ---------- selection ---------- */
function selectModel(id) {
  state.selModel = id; state.selColumn = null;
  state.upNodes = new Set(); state.blastNodes = new Set();
  renderAll();
}
function selectColumn(nodeId, colDisplay) {
  state.selModel = nodeId; state.selColumn = colDisplay;
  const up = engine.upstreamChain(state.lineage, nodeId, colDisplay);
  const br = engine.blastRadius(state.lineage, nodeId, colDisplay);
  state.upNodes = new Set(up.chain.map((c) => c.nodeId));
  state.blastNodes = new Set(br.affected.map((a) => a.nodeId));
  state._lastUp = up; state._lastBlast = br;
  renderAll();
}

/* ---------- sidebar ---------- */
function renderModelList() {
  const q = $('modelSearch').value.trim().toLowerCase();
  const groups = { Models: [], Sources: [], Unknown: [] };
  for (const [id, n] of state.project.nodes) {
    if (q && !shortName(n).toLowerCase().includes(q) && !id.toLowerCase().includes(q)) continue;
    const cols = state.lineage.columnsByNode.get(id) || [];
    const item = { id, name: shortName(n), cnt: cols.length, unknown: n.kind === 'unknown' };
    if (n.kind === 'source') groups.Sources.push(item);
    else if (n.kind === 'unknown') groups.Unknown.push(item);
    else groups.Models.push(item);
  }
  $('modelList').innerHTML = Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([g, items]) => `<div class="model-group"><div class="glabel">${g} (${items.length})</div>` +
      items.sort((a, b) => a.name.localeCompare(b.name)).map((it) =>
        `<button class="model-item${it.unknown ? ' unknown' : ''}${it.id === state.selModel ? ' active' : ''}" data-model="${esc(it.id)}">
           <span>${esc(it.name)}</span><span class="cnt">${it.cnt} col</span>
         </button>`).join('') + '</div>').join('');
  $('modelList').querySelectorAll('[data-model]').forEach((b) =>
    b.addEventListener('click', () => selectModel(b.dataset.model)));
}

/* ---------- graph ---------- */
const NW = 190, NH = 56, XGAP = 110, YGAP = 26, PAD = 30;
function layoutGraph() {
  const nodes = [...state.project.nodes.values()];
  const memo = new Map();
  function depth(id, seen) {
    if (memo.has(id)) return memo.get(id);
    seen = seen || new Set();
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = state.project.nodes.get(id);
    let d = 0;
    for (const dep of (n.dependsOn || [])) {
      if (state.project.nodes.has(dep)) d = Math.max(d, depth(dep, seen) + 1);
    }
    seen.delete(id);
    memo.set(id, d);
    return d;
  }
  const levels = new Map();
  for (const n of nodes) {
    const d = depth(n.id);
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d).push(n);
  }
  const pos = new Map();
  let maxX = 0, maxY = 0;
  for (const [d, arr] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
    arr.sort((a, b) => shortName(a).localeCompare(shortName(b)));
    arr.forEach((n, i) => {
      const x = PAD + d * (NW + XGAP);
      const y = PAD + i * (NH + YGAP);
      pos.set(n.id, { x, y });
      maxX = Math.max(maxX, x + NW); maxY = Math.max(maxY, y + NH);
    });
  }
  return { pos, W: maxX + PAD, H: maxY + PAD };
}
function renderGraph() {
  const { pos, W, H } = layoutGraph();
  const svg = $('graph');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', Math.max(W, 600));
  svg.setAttribute('height', Math.max(H, 480));
  let s = '';
  const start = state.selModel;
  const inUp = (id) => id === start || state.upNodes.has(id);
  const inBlast = (id) => id === start || state.blastNodes.has(id);
  for (const [id, n] of state.project.nodes) {
    for (const dep of (n.dependsOn || [])) {
      if (!pos.has(dep) || !pos.has(id)) continue;
      const a = pos.get(dep), b = pos.get(id);
      const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      let cls = 'gedge';
      if (inUp(dep) && inUp(id)) cls += ' up';
      else if (inBlast(dep) && inBlast(id)) cls += ' blast';
      s += `<path class="${cls}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    }
  }
  for (const [id, n] of state.project.nodes) {
    const p = pos.get(id);
    if (!p) continue;
    let cls = 'gnode';
    if (id === state.selModel) cls += ' selected';
    if (state.upNodes.has(id)) cls += ' up';
    if (state.blastNodes.has(id)) cls += ' blast';
    if (n.kind === 'unknown') cls += ' unknown';
    const name = shortName(n);
    const label = esc(name.length > 24 ? name.slice(0, 23) + '…' : name);
    const cols = (state.lineage.columnsByNode.get(id) || []).length;
    s += `<g class="${cls}" data-node="${esc(id)}">
      <rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="10"/>
      <text x="${p.x + 14}" y="${p.y + 24}">${label}</text>
      <text class="kind" x="${p.x + 14}" y="${p.y + 42}">${esc(n.kind)} · ${cols} col${cols === 1 ? '' : 's'}</text>
    </g>`;
  }
  svg.innerHTML = s;
  svg.querySelectorAll('[data-node]').forEach((g) =>
    g.addEventListener('click', () => selectModel(g.dataset.node)));
}

/* ---------- inspector panel ---------- */
function flagsFor(nodeId, colDisplay) {
  const info = state.lineage.upstream.get(keyOf(nodeId, colDisplay));
  const flags = [];
  if (info) {
    if (info.viaStar) flags.push('<span class="flag star">via *</span>');
    if (info.ambiguous) flags.push('<span class="flag amb">ambiguous</span>');
    if (info.inputs.some((r) => r.unknown)) flags.push('<span class="flag unk">unknown</span>');
    if (!info.inputs.length) flags.push('<span class="flag">derived</span>');
  }
  return flags.join('');
}
function inputButton(r) {
  if (!r.nodeId) {
    const label = (r.tableLabel ? r.tableLabel + '.' : '') + (r.column || '?');
    return `<li><span class="unk">${esc(label)} — unknown source</span></li>`;
  }
  const disp = dispOf(r.nodeId, r.column);
  const star = r.viaStar ? '<span class="viastar">via *</span>' : '';
  const unk = r.unknown ? ' <span class="unk">(unknown cols)</span>' : '';
  return `<li><button data-jump="${esc(r.nodeId)}" data-col="${esc(disp)}">${esc(nodeLabel(r.nodeId))}.${esc(disp)}</button>${star}${unk}</li>`;
}
function renderPanel() {
  const body = $('panelBody');
  if (state.selColumn && state.selModel) {
    const nodeId = state.selModel, col = state.selColumn;
    const up = state._lastUp, br = state._lastBlast;
    const info = state.lineage.upstream.get(keyOf(nodeId, col));
    const byModel = new Map();
    for (const a of br.affected) {
      if (!byModel.has(a.nodeId)) byModel.set(a.nodeId, []);
      byModel.get(a.nodeId).push(a);
    }
    body.innerHTML = `
      <button class="backlink" id="backToModel">← ${esc(nodeLabel(nodeId))}</button>
      <h3 style="font-size:16px;text-transform:none;letter-spacing:0;color:var(--text)">${esc(col)} ${flagsFor(nodeId, col)}</h3>
      <div class="panel-sec"><h4>Direct inputs</h4>
        ${info && info.inputs.length
          ? `<ul class="link-list">${info.inputs.map(inputButton).join('')}</ul>`
          : '<p class="muted">No column inputs — computed or constant.</p>'}
      </div>
      <div class="panel-sec"><h4><span class="teal">Upstream</span> · ${up.chain.length} column${up.chain.length === 1 ? '' : 's'}</h4>
        ${up.chain.length
          ? `<ul class="link-list">${up.chain.map((c) => inputButton({ nodeId: c.nodeId, column: c.column, viaStar: c.viaStar, unknown: c.unknown })).join('')}</ul>`
          : '<p class="muted">This is a root — nothing upstream.</p>'}
      </div>
      <div class="panel-sec"><h4><span class="red">Blast radius</span></h4>
        <div class="counts">
          <div class="count-box models"><div class="n">${br.modelCount}</div><div class="l">models</div></div>
          <div class="count-box cols"><div class="n">${br.columnCount}</div><div class="l">columns</div></div>
        </div>
        ${br.affected.length
          ? [...byModel.entries()].map(([mid, cols]) =>
              `<p class="muted" style="margin:10px 0 4px"><strong style="color:var(--text)">${esc(nodeLabel(mid))}</strong></p>
               <ul class="link-list">${cols.map((c) => inputButton({ nodeId: c.nodeId, column: c.column, viaStar: c.viaStar })).join('')}</ul>`).join('')
          : '<p class="muted">Nothing downstream — safe to change.</p>'}
      </div>`;
    $('backToModel').addEventListener('click', () => selectModel(nodeId));
  } else if (state.selModel) {
    const n = state.project.nodes.get(state.selModel);
    const cols = state.lineage.columnsByNode.get(state.selModel) || [];
    const perr = state.lineage.parseErrors.find((e) => e.nodeId === state.selModel);
    body.innerHTML = `
      <h3 style="font-size:16px;text-transform:none;letter-spacing:0;color:var(--text)">${esc(shortName(n))}</h3>
      <p class="muted">${esc(n.kind)}${n.relation ? ' · ' + esc(n.relation) : ''}</p>
      ${perr ? `<p class="error" style="font-size:13px">SQL could not be parsed: ${esc(perr.error)}</p>` : ''}
      <div class="panel-sec"><h4>Columns (${cols.length})</h4>
        ${cols.length ? cols.map((c) => {
          const info = state.lineage.upstream.get(keyOf(state.selModel, c));
          const nIn = info ? info.inputs.length : 0;
          const sub = !info ? 'root' : (nIn ? `← ${nIn} input${nIn === 1 ? '' : 's'}` : 'derived');
          return `<button class="col-row" data-col="${esc(c)}"><span>${esc(c)}</span>
            <span class="flags">${flagsFor(state.selModel, c)}<span class="flag">${esc(sub)}</span></span></button>`;
        }).join('') : '<p class="muted">No columns recorded for this node.</p>'}
      </div>
      <p class="muted" style="margin-top:12px">Click a column to trace its upstream and blast radius.</p>`;
    body.querySelectorAll('[data-col]').forEach((b) =>
      b.addEventListener('click', () => selectColumn(state.selModel, b.dataset.col)));
  } else {
    body.innerHTML = '<p class="muted">Select a model to see its columns.</p>';
  }
  body.querySelectorAll('[data-jump]').forEach((b) =>
    b.addEventListener('click', () => selectColumn(b.dataset.jump, b.dataset.col)));
}

function renderStats() {
  const n = state.project.nodes.size;
  let cols = 0;
  for (const c of state.lineage.columnsByNode.values()) cols += c.length;
  $('statBadge').textContent = `${n} nodes · ${cols} columns · ${state.lineage.upstream.size} edges`;
}

function renderAll() {
  renderModelList();
  renderGraph();
  renderPanel();
  renderStats();
}

/* ---------- export / reset ---------- */
function exportJson() {
  const nodes = [...state.project.nodes.values()].map((n) => ({
    id: n.id, kind: n.kind, name: shortName(n), database: n.database,
    schema: n.schema, relation: n.relation, dependsOn: n.dependsOn,
    columns: state.lineage.columnsByNode.get(n.id) || [],
  }));
  const columnLineage = {};
  for (const [k, info] of state.lineage.upstream) columnLineage[k] = info;
  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(), project: state.projectLabel,
    dialect: state.dialect, nodes, columnLineage,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'blastradius-lineage.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- init ---------- */
function init() {
  const dz = $('dropzone'), fi = $('fileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fi.click(); });
  fi.addEventListener('change', () => handleFiles(fi.files));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  $('demoBtn').addEventListener('click', async () => {
    $('uploadError').hidden = true;
    state.dialect = $('dialect').value;
    try {
      const res = await fetch('assets/demo/manifest.json');
      const manifest = await res.json();
      state.project = engine.parseManifest(manifest);
      analyze('demo project');
    } catch (e) {
      showError('Could not load the demo project: ' + (e && e.message || e));
    }
  });
  $('modelSearch').addEventListener('input', renderModelList);
  $('exportBtn').addEventListener('click', exportJson);
  $('resetBtn').addEventListener('click', () => {
    state.project = null; state.lineage = null;
    state.selModel = null; state.selColumn = null;
    $('view-app').hidden = true;
    $('view-upload').hidden = false;
    fi.value = '';
  });
}
document.addEventListener('DOMContentLoaded', init);
