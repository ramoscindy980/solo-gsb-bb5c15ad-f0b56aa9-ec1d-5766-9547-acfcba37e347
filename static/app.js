/* Branch interview script editor — vanilla JS. */
"use strict";

const WORLD_W = 4000, WORLD_H = 3000;

const state = {
  scripts: [],
  currentId: null,
  doc: null,                  // {name, content:{start_node_id, nodes}}
  selectedNodeId: null,
  selectedEdge: null,         // {nodeId, optionId}
  dirty: false,
  markers: { cycles: [], orphans: [], uncovered: [], errors: [] },
  pan: { x: 60, y: 40 },
  connecting: null,           // {nodeId, optionId}
  dragNode: null,
  suppressClick: false,
  history: { stack: [], index: -1, mergeKey: null, mergeAt: 0 },
  savedSnapshot: null,        // JSON of {name, content} at last save / open
  coverage: null,             // branch coverage stats for the saved script, null = unknown
  i18n: {
    langCode: null,           // configured target language for the current script
    langLabel: "",
    view: null,               // GET translations response: {fields, counts}
    filter: "all",            // all | missing | pending | reviewed
  },
};

const HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 700;  // consecutive typing in the same field merges into one entry

const $ = (sel) => document.querySelector(sel);
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const getNode = (id) => state.doc?.content.nodes.find((n) => n.id === id);

// ---------------------------------------------------------------- graph check

function bfsReachable(start, adj) {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    for (const t of adj.get(q.shift()) || []) {
      if (t && !seen.has(t)) { seen.add(t); q.push(t); }
    }
  }
  return seen;
}

function tarjanCycles(ids, adj) {
  let counter = 0;
  const index = new Map(), low = new Map(), stack = [], on = new Set(), cyc = new Set();
  const connect = (v) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!w) continue;
      if (!index.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) comp.forEach((x) => cyc.add(x));
      else if ((adj.get(v) || []).includes(v)) cyc.add(v);
    }
  };
  ids.forEach((id) => { if (!index.has(id)) connect(id); });
  return cyc;
}

function validateLocal() {
  const content = state.doc.content;
  const nodes = content.nodes;
  const ids = nodes.map((n) => n.id);
  const map = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map(ids.map((id) => [id, []]));
  const dangling = [];
  nodes.forEach((n) => (n.options || []).forEach((o) => {
    if (o.target_id && map.has(o.target_id)) adj.get(n.id).push(o.target_id);
    else dangling.push({ node_id: n.id, option_id: o.id });
  }));

  const cycleSet = tarjanCycles(ids, adj);
  let orphans = [];
  if (map.has(content.start_node_id)) {
    const reach = bfsReachable(content.start_node_id, adj);
    orphans = ids.filter((id) => !reach.has(id));
  } else orphans = ids.slice();

  const uncovered = new Set(dangling.map((d) => d.node_id));
  nodes.forEach((n) => {
    if (!(n.options || []).length && !n.terminal) uncovered.add(n.id);
  });

  state.markers = {
    cycles: [...cycleSet],
    orphans,
    uncovered: [...uncovered],
    errors: dangling.map((d) => ({ type: "missing_target", ...d })),
  };
  renderStatus();
  renderNodeFlags();
  drawEdges();
}

// ---------------------------------------------------------------- branch coverage
// Coverage stats are derived from saved run records on the server and are
// completely independent of validateLocal(): they never affect the live
// structure badges (cycles / orphans / uncovered exits).

const covKey = (nodeId, optionId) => `${nodeId}::${optionId}`;

function coverageOption(nodeId, optionId) {
  const node = state.coverage?.nodes.find((n) => n.node_id === nodeId);
  return node ? node.options.find((o) => o.option_id === optionId) || null : null;
}

async function loadCoverage(quiet = true) {
  if (!state.currentId) { state.coverage = null; return null; }
  try {
    state.coverage = await api(`/api/scripts/${state.currentId}/coverage`);
  } catch (err) {
    state.coverage = null;
    if (!quiet) toast("分支覆盖统计加载失败：" + err.message, 3000);
  }
  return state.coverage;
}

// Badge shown next to an option inside the node inspector.
function coverageBadgeHtml(nodeId, optionId) {
  const c = state.coverage;
  if (!c) return "";
  const info = coverageOption(nodeId, optionId);
  if (!info) {
    return `<span class="cov new" title="该选项尚未保存，保存后新产生的运行记录才会纳入统计">新增 · 保存后统计</span>`;
  }
  if (!c.has_runs) {
    return `<span class="cov none" title="该脚本尚无已保存运行记录">— 无运行记录</span>`;
  }
  if (info.count > 0) {
    return `<span class="cov hit" title="已保存运行记录中该选项被选择的次数">✓ 已选 ${info.count} 次</span>`;
  }
  if (!info.selectable) {
    return `<span class="cov none" title="选项未连接到目标节点，运行中不可选择">— 未连接，不可选</span>`;
  }
  return `<span class="cov miss" title="已保存运行记录中从未有人选择过该选项">⚠ 从未走过 · 0 次</span>`;
}

function optionNeverCovered(nodeId, optionId) {
  const info = coverageOption(nodeId, optionId);
  return !!state.coverage?.has_runs && !!info && info.selectable && info.count === 0;
}

// Summary line under the option list of a selected node.
function renderCoverageNote(el, node) {
  if (!el) return;
  const c = state.coverage;
  if (!c) { el.innerHTML = ""; return; }
  if (!c.has_runs) {
    el.innerHTML = `<span class="cov-empty">📊 该脚本尚无运行记录，暂无分支覆盖统计；保存后通过「▶ 运行预览」或只读分享作答即可产生记录。</span>`;
    return;
  }
  const info = c.nodes.find((x) => x.node_id === node.id);
  const total = info?.options.filter((o) => o.selectable).length || 0;
  const hit = info?.options.filter((o) => o.selectable && o.count > 0).length || 0;
  const missed = total - hit;
  el.innerHTML =
    (state.dirty ? `<span class="cov-stale">统计基于上次保存的脚本，保存后刷新。</span><br>` : "") +
    `<span class="cov-summary">本节点可选分支 ${hit}/${total} 已走过` +
    (missed ? `，<b class="cov-miss-text">${missed} 个选项从未走过</b>` : (total ? "（全部覆盖 ✓）" : "")) +
    `　<span class="cov-open" id="covOpenLink">查看全部分支覆盖 →</span></span>`;
  const link = $("#covOpenLink");
  if (link) link.onclick = openCoverage;
}

// Overall coverage panel shown in the script-settings inspector view.
function renderCoverageBox(el) {
  if (!el) return;
  const c = state.coverage;
  if (!c) { el.innerHTML = ""; return; }
  const body = !c.has_runs
    ? `<div class="cov-empty">尚无运行记录。保存脚本后通过「▶ 运行预览」，或打开「🔗 只读分享」链接作答，即可在此查看各选项被选择的次数。</div>`
    : `<div class="cov-cards">
         <div><b>${c.run_count}</b><span>运行会话</span></div>
         <div><b>${c.covered_option_count}/${c.option_count}</b><span>已覆盖分支</span></div>
         <div><b>${Math.round(c.coverage_rate * 100)}%</b><span>分支覆盖率</span></div>
         <div><b>${c.total_choices}</b><span>累计选择次数</span></div>
       </div>
       <div class="cov-line">${c.preview_runs} 次编辑器预览 · ${c.share_runs} 次分享作答 · ${c.finished_runs} 次走到结束</div>
       <button id="covBoxOpen">📊 查看分支覆盖统计</button>`;
  el.innerHTML = `<h3 class="cov-h3">分支覆盖</h3>${body}`;
  const btn = $("#covBoxOpen");
  if (btn) btn.onclick = openCoverage;
}

// ---------------------------------------------------------------- coverage modal

async function openCoverage() {
  const c = await loadCoverage(false);
  renderCoverageModal(c);
  openModal("coverageModal");
}

function renderCoverageModal(c) {
  const sumEl = $("#coverageSummary");
  const listEl = $("#coverageList");
  if (!c) return;
  if (!c.has_runs) {
    sumEl.innerHTML = `<div class="cov-empty-big">📭 该脚本尚无已保存运行记录<br>
      <small>保存脚本后使用「▶ 运行预览」，或将「🔗 只读分享」链接发给受访者作答，这里就会汇总各选项被选择的次数。</small></div>`;
    listEl.innerHTML = "";
    return;
  }
  const missedCount = c.uncovered_options.length;
  sumEl.innerHTML =
    (state.dirty ? `<div class="cov-stale">⚠ 当前有未保存改动，以下统计基于上次保存的脚本；保存后可刷新。</div>` : "") +
    `<div class="cov-cards">
       <div><b>${c.run_count}</b><span>运行会话</span></div>
       <div><b>${c.covered_option_count}/${c.option_count}</b><span>已覆盖分支</span></div>
       <div><b>${Math.round(c.coverage_rate * 100)}%</b><span>分支覆盖率</span></div>
       <div><b>${c.total_choices}</b><span>累计选择次数</span></div>
       <div><b class="${missedCount ? "cov-miss-text" : ""}">${missedCount}</b><span>从未走过</span></div>
     </div>
     <div class="cov-line">编辑器预览 ${c.preview_runs} 次 · 分享作答 ${c.share_runs} 次 · 走到结束 ${c.finished_runs} 次</div>`;

  let maxCount = 0;
  c.nodes.forEach((n) => n.options.forEach((o) => { maxCount = Math.max(maxCount, o.count); }));
  const nodesWithOpts = c.nodes.filter((n) => n.options.length);
  if (!nodesWithOpts.length) {
    listEl.innerHTML = `<div class="cov-empty">当前脚本没有任何选项节点。</div>`;
    return;
  }
  listEl.innerHTML = nodesWithOpts.map((n) => `
    <div class="cov-node">
      <div class="cov-node-head">
        <span class="cov-node-title">${esc(n.title || "(未命名节点)")}</span>
        <span class="cov-node-id">${esc(n.node_id)} · ${n.type === "info" ? "告知" : "问题"}${n.terminal ? " · 终点" : ""}</span>
      </div>
      ${n.options.map((o) => {
        const w = maxCount ? Math.round((o.count / maxCount) * 100) : 0;
        const cls = !o.selectable ? "none" : (o.count > 0 ? "hit" : "miss");
        const status = !o.selectable ? "未连接，不可选"
          : (o.count > 0 ? `已选 ${o.count} 次` : "从未走过 · 0 次");
        return `<div class="cov-opt ${cls}" data-jump-node="${esc(n.node_id)}" data-jump-opt="${esc(o.option_id)}">
          <span class="cov-opt-label">${esc(o.label || "(未命名选项)")}</span>
          <span class="cov-bar"><span class="cov-bar-fill" style="width:${o.count ? w : 0}%"></span></span>
          <span class="cov-opt-stat">${status}</span>
        </div>`;
      }).join("")}
    </div>`).join("");
  listEl.querySelectorAll(".cov-opt").forEach((row) => {
    row.onclick = () => {
      const id = row.dataset.jumpNode;
      if (!getNode(id)) return;
      state.selectedNodeId = id;
      state.selectedEdge = null;
      drawNodes(); drawEdges(); renderInspector();
      closeModal("coverageModal");
    };
  });
}

// ---------------------------------------------------------------- revision impact analysis
// 改稿影响分析: the CURRENT canvas (unsaved edits included) is POSTed to the
// server, which replays every saved answer session of this script — both
// editor previews and read-only share answers — from the canvas start node,
// following the recorded choices and verifying each jump target. The first
// breakpoint (start changed / node or option vanished / redirect / premature
// end / finished answer no longer ending) is reported with its node. Unfinished
// answers are only checked over their answered part; an exact replay is
// "compatible". Read-only: nothing is saved, no run record changes, coverage
// stats are untouched.

const impactState = { result: null, contentSnap: null };

const IMPACT_REASONS = {
  start_changed: { label: "起点改变", cls: "redirected" },
  node_missing: { label: "节点消失", cls: "missing" },
  option_missing: { label: "选项消失", cls: "missing" },
  redirected: { label: "跳转改指", cls: "redirected" },
  early_terminal: { label: "提前终止", cls: "terminal" },
  ended_no_longer_terminal: { label: "已结束不再结束", cls: "terminal" },
  empty_record: { label: "记录为空", cls: "missing" },
};

async function openImpact() {
  if (!state.currentId || !state.doc) return;
  openModal("impactModal");
  $("#impactSummary").innerHTML = `<div class="cov-empty">正在以当前画布重放核对待测作答记录…</div>`;
  $("#impactList").innerHTML = "";
  await runImpact();
}

async function runImpact() {
  if (!state.currentId || !state.doc) return;
  const btn = $("#impactRefresh");
  btn.disabled = true;
  try {
    const r = await api(`/api/scripts/${state.currentId}/impact`, {
      method: "POST",
      body: { content: state.doc.content },
    });
    impactState.result = r;
    impactState.contentSnap = JSON.stringify(state.doc.content);
    renderImpact(r);
  } catch (err) {
    $("#impactSummary").innerHTML = `<div class="route-none">改稿影响分析失败：${esc(err.message)}</div>`;
    $("#impactList").innerHTML = "";
  }
  btn.disabled = false;
}

function impactRedirectNote(d) {
  if (!d.current_connected) {
    return d.current_target_id
      ? `现在指向已消失节点 ${esc(d.current_target_id)}`
      : "现在该选项已改为未连接";
  }
  return `现在改指到「${esc(d.current_target_title || d.current_target_id)}」`;
}

function renderImpactSteps(s) {
  const bp = s.breakpoint;
  return s.steps.map((st, i) => {
    const exists = !!getNode(st.node_id);
    const isBp = bp && bp.step_index === i;
    const note = isBp && bp.reason === "redirected"
      ? `<span class="imp-bp-note">↳ ${impactRedirectNote(bp.detail)}</span>` : "";
    return `
      <div class="imp-step ${isBp ? "bp" : ""}">
        <span class="route-idx">${i === 0 ? "起" : i}</span>
        ${exists
          ? `<button class="route-node" data-imp-node="${esc(st.node_id)}">${esc(st.title || st.node_id)}</button>`
          : `<span class="imp-gone" title="该节点已从当前画布消失">${esc(st.title || st.node_id)}（已消失）</span>`}
        ${st.answer ? `<span class="imp-ans">—「${esc(st.answer)}」→</span>` : ""}
        ${isBp ? `<span class="imp-bp-tag">断点</span>` : ""}
        ${note}
      </div>`;
  }).join("");
}

function renderImpact(r) {
  const sumEl = $("#impactSummary");
  const listEl = $("#impactList");
  if (!r) { sumEl.innerHTML = ""; listEl.innerHTML = ""; return; }
  if (!r.has_runs) {
    sumEl.innerHTML = `<div class="cov-empty-big">📭 该脚本尚无可核对的作答记录<br>
      <small>保存脚本后使用「▶ 运行预览」，或将「🔗 只读分享」链接发给受访者作答，这里即会按历史选项顺序逐条重放核对。</small></div>`;
    listEl.innerHTML = "";
    return;
  }

  const stale = impactState.contentSnap !== JSON.stringify(state.doc.content);
  const reasonChips = Object.entries(r.reason_counts || {}).map(([reason, n]) => {
    const meta = IMPACT_REASONS[reason] || { label: reason, cls: "missing" };
    return `<span class="imp-reason-chip ${meta.cls}">${meta.label} × ${n}</span>`;
  }).join("");
  sumEl.innerHTML =
    `<div class="imp-notes">
       ${state.dirty ? '<span class="imp-chip dirty">分析基于当前画布，已含未保存修改</span>' : ""}
       ${stale ? '<span class="imp-chip stale">⚠ 分析后画布又被改动，结果可能已过期，请重新分析</span>' : ""}
     </div>
     <div class="cov-cards">
       <div><b>${r.total}</b><span>作答会话</span></div>
       <div class="imp-num-ok"><b>${r.compatible_count}</b><span>兼容</span></div>
       <div class="imp-num-bad"><b>${r.affected_count}</b><span>受影响</span></div>
       <div><b>${r.preview_runs}</b><span>编辑器预览</span></div>
       <div><b>${r.share_runs}</b><span>分享作答</span></div>
     </div>
     ${reasonChips ? `<div class="imp-reasons">${reasonChips}</div>` :
       '<div class="cov-line">全部会话与当前画布兼容 ✓（未完成答卷仅核对已答部分）</div>'}`;

  listEl.innerHTML = r.sessions.map((s) => {
    const affected = s.status === "affected";
    const meta = affected ? (IMPACT_REASONS[s.breakpoint.reason] || { label: "受影响", cls: "missing" }) : null;
    const locate = affected && s.breakpoint.locate_node_id;
    return `
    <details class="imp-sess ${affected ? "bad" : "ok"}" ${affected ? "open" : ""}>
      <summary>
        <span class="imp-status ${affected ? "bad" : "ok"}">${affected ? "⚠ 受影响" : "✓ 兼容"}</span>
        <span class="imp-meta">#${s.run_id} · ${s.mode === "share" ? "分享作答" : "编辑器预览"} ·
          ${s.finished ? "已结束" : "未完成"} · ${s.choice_count} 次选择</span>
        ${affected ? `<span class="imp-reason-tag ${meta.cls}">${meta.label}</span>` : ""}
        <span class="imp-date">${esc((s.created_at || "").replace("T", " ").slice(0, 16))}</span>
      </summary>
      <div class="imp-body">
        ${affected ? `
          <div class="imp-bp-box ${meta.cls}">
            <div><b>首个断点 · ${meta.label}</b>：${esc(s.breakpoint.message)}</div>
            ${locate ? `<button class="imp-locate" data-imp-node="${esc(locate)}">🎯 定位断点节点</button>`
                      : '<span class="imp-no-locate">（断点节点已不在画布上，无法定位）</span>'}
          </div>` :
          `<div class="imp-ok-box">✓ ${s.finished ? "整份答卷在当前画布上可完整重放。"
            : "已答部分在当前画布上可完整重放（未完成答卷不核对后续）。"}</div>`}
        <div class="imp-steps">${renderImpactSteps(s)}</div>
      </div>
    </details>`;
  }).join("");

  listEl.querySelectorAll("[data-imp-node]").forEach((b) => {
    b.onclick = () => locateNodeOnCanvas(b.dataset.impNode);
  });
}

// ---------------------------------------------------------------- route planning
// 指定选项路线规划: check 1–6 options that have connected targets on the
// CURRENT canvas (unsaved edits included); the server BFSes over
// (node, collected-options bitmask) states for the shortest choice sequence
// from the start node that traverses every checked option at least once and
// ends at a terminal node (terminal flag or no options). Planning is
// read-only: it never saves the script, never creates run records and never
// changes branch coverage statistics.

const ROUTE_MAX_PICKS = 6;
const routeState = {
  picked: new Map(),      // "nodeId::optionId" -> {node_id, option_id}
  lastResult: null,       // last /api/route-plan response
  resultSnap: null,       // JSON of the canvas content that response came from
};

const routeKey = (nodeId, optionId) => `${nodeId}::${optionId}`;

// Pickable options: connected to an existing target node, grouped by node.
function routeEligible() {
  const nodes = state.doc?.content.nodes || [];
  const ids = new Set(nodes.map((n) => n.id));
  return nodes
    .map((n) => ({ node: n, options: (n.options || []).filter((o) => o.target_id && ids.has(o.target_id)) }))
    .filter((g) => g.options.length);
}

function pruneRoutePicks() {
  const valid = new Set();
  routeEligible().forEach((g) => g.options.forEach((o) => valid.add(routeKey(g.node.id, o.id))));
  [...routeState.picked.keys()].forEach((k) => { if (!valid.has(k)) routeState.picked.delete(k); });
}

function openRoute() {
  if (!state.doc) return;
  pruneRoutePicks();
  // canvas edited since the last plan: the old result no longer applies
  if (routeState.resultSnap !== JSON.stringify(state.doc.content)) routeState.lastResult = null;
  renderRoutePicker();
  renderRouteResult();
  openModal("routeModal");
}

function updateRouteFooter() {
  const n = routeState.picked.size;
  $("#routePickCount").textContent = `已选 ${n}/${ROUTE_MAX_PICKS}`;
  $("#routeRun").disabled = n < 1;
}

function renderRoutePicker() {
  const box = $("#routePick");
  const groups = routeEligible();
  if (!groups.length) {
    box.innerHTML = `<div class="route-empty">当前画布没有已连接目标的选项可勾选，请先拖拽选项圆点连线。</div>`;
  } else {
    box.innerHTML = groups.map((g) => `
      <div class="route-group">
        <div class="route-group-head">${esc(g.node.title || "(未命名节点)")}
          ${g.node.id === state.doc.content.start_node_id ? '<span class="route-tag">起始</span>' : ""}
          ${g.node.terminal ? '<span class="route-tag end">终点</span>' : ""}
        </div>
        ${g.options.map((o) => {
          const tgt = getNode(o.target_id);
          const key = routeKey(g.node.id, o.id);
          return `<label class="route-opt">
            <input type="checkbox" data-rnode="${esc(g.node.id)}" data-ropt="${esc(o.id)}"
                   ${routeState.picked.has(key) ? "checked" : ""}>
            <span class="route-opt-label">${esc(o.label || "(未命名选项)")}</span>
            <span class="route-opt-target">→ ${esc(tgt?.title || o.target_id)}</span>
          </label>`;
        }).join("")}
      </div>`).join("");
    box.querySelectorAll("input[data-rnode]").forEach((cb) => {
      cb.onchange = () => {
        const key = routeKey(cb.dataset.rnode, cb.dataset.ropt);
        if (cb.checked) {
          if (routeState.picked.size >= ROUTE_MAX_PICKS) {
            cb.checked = false;
            toast(`最多勾选 ${ROUTE_MAX_PICKS} 个选项`);
            return;
          }
          routeState.picked.set(key, { node_id: cb.dataset.rnode, option_id: cb.dataset.ropt });
        } else {
          routeState.picked.delete(key);
        }
        routeState.lastResult = null;   // picks changed: previous result is stale
        updateRouteFooter();
        renderRouteResult();
      };
    });
  }
  updateRouteFooter();
}

async function runRoutePlan() {
  if (!state.doc) return;
  const options = [...routeState.picked.values()];
  if (!options.length) { toast("请先勾选 1～6 个已连接目标的选项"); return; }
  $("#routeRun").disabled = true;
  try {
    const r = await api("/api/route-plan", {
      method: "POST",
      body: { content: state.doc.content, options },
    });
    routeState.lastResult = r;
    routeState.resultSnap = JSON.stringify(state.doc.content);
  } catch (err) {
    toast("路线规划失败：" + err.message, 3500);
  }
  renderRouteResult();
  updateRouteFooter();
}

function renderRouteResult() {
  const el = $("#routeResult");
  const r = routeState.lastResult;
  if (!el) return;
  if (!r) { el.innerHTML = ""; return; }
  if (!r.solvable) {
    el.innerHTML = `<div class="route-none">✕ 无解：${esc(r.reason || "不存在满足条件的路线")}，不返回部分路径。</div>`;
    return;
  }
  const nodeBtn = (id, title) =>
    `<button class="route-node" data-rnode="${esc(id)}" title="定位到画布">${esc(title || id)}</button>`;
  el.innerHTML = `
    <div class="route-ok">
      <div class="route-summary">✓ 最短路线：共 <b>${r.choice_count}</b> 次选择（点击节点名可定位到画布）</div>
      <div class="route-step route-start">
        <span class="route-idx">起</span>${nodeBtn(r.start_node_id, r.start_title)}<span class="route-tag">起始节点</span>
      </div>
      ${r.steps.map((s, i) => `
        <div class="route-step">
          <span class="route-idx">${i + 1}</span>
          ${nodeBtn(s.node_id, s.title)}
          <span class="route-choice">—「${esc(s.option_label || "(未命名选项)")}」→</span>
          ${nodeBtn(s.target_id, s.target_title)}
          ${s.waypoint ? '<span class="route-tag hit">勾选选项 ✓</span>' : ""}
        </div>`).join("")}
      <div class="route-step route-end">
        <span class="route-idx">终</span>${nodeBtn(r.end_node_id, r.end_title)}
        <span class="route-tag end">${r.end_terminal ? "终止节点" : "无选项节点"}</span>
      </div>
    </div>`;
  el.querySelectorAll("[data-rnode]").forEach((b) => {
    b.onclick = () => locateNodeOnCanvas(b.dataset.rnode);
  });
}

// Center the node in the viewport and select it (canvas + inspector).
function locateNodeOnCanvas(id) {
  const n = getNode(id);
  if (!n) { toast("该节点已不在当前画布上，无法定位"); return; }
  state.selectedNodeId = id;
  state.selectedEdge = null;
  const rect = $("#canvasWrap").getBoundingClientRect();
  state.pan = {
    x: Math.round(rect.width / 2 - ((n.x || 0) + 115)),
    y: Math.round(rect.height / 2 - ((n.y || 0) + 60)),
  };
  document.querySelectorAll(".modal-mask.open").forEach((m) => m.classList.remove("open"));
  renderCanvas();
  renderInspector();
}

// ---------------------------------------------------------------- rendering

function renderStatus() {
  const el = $("#status");
  const m = state.markers;
  const label = (arr, cls, text) =>
    arr.length ? `<span class="badge ${cls}"><span class="dot ${cls}"></span>${text} ${arr.length}</span>` : "";
  el.innerHTML =
    (state.dirty ? `<span class="badge dirty">未保存</span>` : `<span class="badge ok">已保存</span>`) +
    label(m.cycles, "cycle", "环路") +
    label(m.orphans, "orphan", "孤立") +
    label(m.uncovered, "uncovered", "未覆盖出口") +
    (!m.cycles.length && !m.orphans.length && !m.uncovered.length
      ? `<span class="badge ok">流程校验通过</span>` : "");
}

function renderAll() {
  renderSidebar();
  renderCanvas();
  renderInspector();
  renderStatus();
}

function renderSidebar() {
  const el = $("#scriptList");
  if (!state.scripts.length) { el.innerHTML = `<div class="empty">暂无脚本</div>`; return; }
  el.innerHTML = state.scripts.map((s) =>
    `<div class="item ${s.id === state.currentId ? "active" : ""}" data-id="${s.id}">
       <span>${esc(s.name)}</span><span class="del" data-del="${s.id}" title="删除">✕</span>
     </div>`).join("");
}

function renderCanvas() {
  const world = $("#world");
  world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px)`;
  drawNodes();
  drawEdges();
}

function renderNodeFlags() {
  state.doc.content.nodes.forEach((n) => {
    const el = document.getElementById(`node-${n.id}`);
    if (!el) return;
    el.classList.toggle("flag-cycle", state.markers.cycles.includes(n.id));
    el.classList.toggle("flag-orphan", state.markers.orphans.includes(n.id));
    el.classList.toggle("start", n.id === state.doc.content.start_node_id);
    el.classList.toggle("selected", n.id === state.selectedNodeId);
    const mark = el.querySelector(".mark");
    mark.innerHTML =
      (state.markers.cycles.includes(n.id) ? `<span class="dot cycle" title="位于环路中"></span>` : "") +
      (state.markers.orphans.includes(n.id) ? `<span class="dot orphan" title="孤立节点"></span>` : "") +
      (state.markers.uncovered.includes(n.id) ? `<span class="dot uncovered" title="存在未覆盖出口"></span>` : "");
    (n.options || []).forEach((o) => {
      const p = document.getElementById(`port-${n.id}-${o.id}`);
      if (p) p.classList.toggle("dangle", !o.target_id);
    });
  });
}

function drawNodes() {
  const world = $("#world");
  [...world.querySelectorAll(".node")].forEach((e) => e.remove());
  const nodes = state.doc.content.nodes;
  nodes.forEach((n) => {
    if (n.x === undefined || n.x === null) { n.x = 0; n.y = 0; }
    const div = document.createElement("div");
    div.className = "node";
    div.id = `node-${n.id}`;
    div.dataset.id = n.id;
    div.style.left = `${n.x}px`;
    div.style.top = `${n.y}px`;
    const kind = n.type === "info" ? "告知" : "问题";
    div.innerHTML = `
      <div class="node-head" data-drag="${n.id}">
        <span class="kind">${kind}${n.terminal ? " · 终点" : ""}</span>
        <span class="ttl">${esc(n.title || "(未命名问题)")}</span>
        <span class="mark"></span>
      </div>
      <div class="node-body body-txt">${esc(n.text || "（无问题描述）")}</div>
      <div class="opts">
        ${(n.options || []).map((o) => `
          <div class="opt-row ${o.target_id ? "" : "uncovered"}">
            <span class="opt-label">${esc(o.label || "(未命名选项)")}</span>
            <span class="port" id="port-${n.id}-${o.id}"
                  data-node="${n.id}" data-opt="${o.id}" title="拖拽连接到目标节点"></span>
          </div>`).join("")}
      </div>`;
    world.appendChild(div);
  });
  renderNodeFlags();
}

function portPoint(nodeId, optId) {
  const p = document.getElementById(`port-${nodeId}-${optId}`);
  if (!p) return null;
  return { x: p.offsetLeft + 6 + (getNode(nodeId)?.x || 0),
           y: p.offsetTop + 6 + (getNode(nodeId)?.y || 0) };
}

function drawEdges() {
  const svg = $("#edges");
  svg.querySelectorAll("path.edge:not(#tempEdge), polygon.arrow").forEach((e) => e.remove());
  const NS = "http://www.w3.org/2000/svg";
  state.doc.content.nodes.forEach((n) => {
    (n.options || []).forEach((o) => {
      const from = portPoint(n.id, o.id);
      if (!from) return;
      let to, dangling = false;
      const tgt = getNode(o.target_id);
      if (tgt) to = { x: tgt.x + 115, y: tgt.y };
      else { to = { x: from.x + 46, y: from.y }; dangling = true; }

      const mx = (from.x + to.x) / 2;
      const d = `M ${from.x} ${from.y} C ${mx} ${from.y}, ${mx} ${to.y}, ${to.x} ${to.y}`;
      const inCycle = state.markers.cycles.includes(n.id) && state.markers.cycles.includes(o.target_id);
      const sel = state.selectedEdge &&
        state.selectedEdge.nodeId === n.id && state.selectedEdge.optionId === o.id;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class",
        `edge ${dangling ? "dangle" : ""} ${inCycle ? "cycle" : ""} ${sel ? "selected" : ""}`);
      path.setAttribute("pointer-events", "stroke");
      path.dataset.node = n.id;
      path.dataset.opt = o.id;
      svg.appendChild(path);

      // arrow head
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      const a = dangling ? ang : -Math.PI / 2; // entering target from top
      const size = 9;
      const tip = dangling ? to : { x: to.x, y: to.y + 2 };
      const pts = [
        [tip.x, tip.y],
        [tip.x - size * Math.cos(a - 0.45), tip.y - size * Math.sin(a - 0.45)],
        [tip.x - size * Math.cos(a + 0.45), tip.y - size * Math.sin(a + 0.45)],
      ].map((p) => p.join(",")).join(" ");
      const tri = document.createElementNS(NS, "polygon");
      tri.setAttribute("points", pts);
      tri.setAttribute("class", `arrow ${dangling ? "dangle" : ""} ${inCycle ? "cycle" : ""} ${sel ? "selected" : ""}`);
      svg.appendChild(tri);
    });
  });
}

// ---------------------------------------------------------------- inspector

function renderInspector() {
  const el = $("#inspector");
  const n = getNode(state.selectedNodeId);

  if (state.selectedEdge) {
    const src = getNode(state.selectedEdge.nodeId);
    const opt = src?.options.find((o) => o.id === state.selectedEdge.optionId);
    if (!opt) { state.selectedEdge = null; return renderInspector(); }
    const nodes = state.doc.content.nodes;
    el.innerHTML = `
      <h3>条件连线</h3>
      <div class="field"><label>来源节点</label><div>${esc(src.title || src.id)}</div></div>
      <div class="field"><label>触发选项</label><div>${esc(opt.label || "(未命名)")}</div></div>
      <div class="field"><label>跳转目标</label>
        <select id="edgeTarget">
          <option value="">— 未连接（未覆盖出口）—</option>
          ${nodes.map((x) => `<option value="${x.id}" ${x.id === opt.target_id ? "selected" : ""}>${esc(x.title || x.id)}</option>`).join("")}
        </select>
      </div>
      <button class="danger" id="edgeDel">删除连线</button>`;
    $("#edgeTarget").onchange = (e) => { opt.target_id = e.target.value || null; changed(); };
    $("#edgeDel").onclick = () => { opt.target_id = null; state.selectedEdge = null; changed(); };
    return;
  }

  if (!n) {
    const nodes = state.doc.content.nodes;
    el.innerHTML = `
      <h3>脚本设置</h3>
      <div class="field"><label>起始节点（访谈入口）</label>
        <select id="startNode">
          <option value="">— 请选择 —</option>
          ${nodes.map((x) => `<option value="${x.id}" ${x.id === state.doc.content.start_node_id ? "selected" : ""}>${esc(x.title || x.id)}</option>`).join("")}
        </select>
      </div>
      <div class="empty">在画布空白处拖动可平移；拖拽节点标题移动节点；拖拽选项右侧圆点连接到目标节点；点击连线可修改/删除。</div>
      <div class="cov-box" id="covBox"></div>`;
    $("#startNode").onchange = (e) => { state.doc.content.start_node_id = e.target.value || null; changed(); };
    renderCoverageBox($("#covBox"));
    return;
  }

  el.innerHTML = `
    <h3>节点属性</h3>
    <div class="field checks">
      <label><input type="radio" name="ntype" ${n.type !== "info" ? "checked" : ""}> 问题</label>
      <label><input type="radio" name="ntype" ${n.type === "info" ? "checked" : ""}> 告知</label>
    </div>
    <div class="field"><label>标题</label><input type="text" id="fTitle" value="${esc(n.title)}"></div>
    <div class="field"><label>问题描述 / 文案</label><textarea id="fText">${esc(n.text)}</textarea></div>
    <div class="field checks">
      <label><input type="checkbox" id="fTerminal" ${n.terminal ? "checked" : ""}> 标记为终止节点</label>
      <button id="fSetStart">设为起始</button>
    </div>
    <div class="field">
      <label>条件选项（受访者可选回答）</label>
      <div id="optEdits"></div>
      <button id="addOpt">＋ 添加选项</button>
      <div class="cov-note" id="covNote"></div>
    </div>
    <div class="danger-zone">
      <button class="danger" id="delNode">删除此节点</button>
    </div>`;

  const renderOptEdits = () => {
    const box = $("#optEdits");
    const nodes = state.doc.content.nodes;
    box.innerHTML = n.options.map((o) => `
      <div class="opt-edit ${optionNeverCovered(n.id, o.id) ? "cov-miss" : ""}" data-oid="${o.id}">
        <div class="row">
          <input type="text" class="opt-label-in" value="${esc(o.label)}" placeholder="选项文案">
          ${coverageBadgeHtml(n.id, o.id)}
          <button class="opt-del danger" title="删除选项">✕</button>
        </div>
        <div class="row" style="margin-top:6px">
          <select class="opt-target">
            <option value="">— 未连接 —</option>
            ${nodes.filter((x) => x.id !== n.id).map((x) =>
              `<option value="${x.id}" ${x.id === o.target_id ? "selected" : ""}>${esc(x.title || x.id)}</option>`).join("")}
          </select>
        </div>
      </div>`).join("");
    box.querySelectorAll(".opt-edit").forEach((row) => {
      const oid = row.dataset.oid;
      const o = n.options.find((x) => x.id === oid);
      row.querySelector(".opt-label-in").oninput = (e) => {
        o.label = e.target.value;
        commitTyped(`opt:${n.id}:${oid}`);
        const card = document.querySelector(`#node-${n.id} .opt-row #port-${n.id}-${oid}`);
        const lbl = card?.parentElement.querySelector(".opt-label");
        if (lbl) lbl.textContent = o.label || "(未命名选项)";
      };
      row.querySelector(".opt-target").onchange = (e) => { o.target_id = e.target.value || null; changed(); };
      row.querySelector(".opt-del").onclick = () => {
        n.options = n.options.filter((x) => x.id !== oid); changed();
      };
    });
  };
  renderOptEdits();
  renderCoverageNote($("#covNote"), n);

  $("#fTitle").oninput = (e) => {
    n.title = e.target.value;
    commitTyped(`title:${n.id}`);
    const t = document.querySelector(`#node-${n.id} .ttl`);
    if (t) t.textContent = n.title || "(未命名问题)";
  };
  $("#fText").oninput = (e) => {
    n.text = e.target.value;
    commitTyped(`text:${n.id}`);
    const b = document.querySelector(`#node-${n.id} .body-txt`);
    if (b) b.textContent = n.text || "（无问题描述）";
  };
  $("#fTitle").onchange = $("#fText").onchange = () => renderOptEdits();
  document.querySelectorAll("input[name=ntype]").forEach((r) => r.onchange = () => {
    n.type = document.querySelectorAll("input[name=ntype]")[0].checked ? "question" : "info";
    changed();
  });
  $("#fTerminal").onchange = (e) => { n.terminal = e.target.checked; changed(); };
  $("#fSetStart").onclick = () => { state.doc.content.start_node_id = n.id; changed(); };
  $("#addOpt").onclick = () => {
    n.options.push({ id: uid("o"), label: `选项 ${n.options.length + 1}`, target_id: null });
    changed();
  };
  $("#delNode").onclick = () => {
    if (!confirm("确认删除该节点？相关连线将一并清除。")) return;
    state.doc.content.nodes = state.doc.content.nodes.filter((x) => x.id !== n.id);
    state.doc.content.nodes.forEach((x) => (x.options || []).forEach((o) => {
      if (o.target_id === n.id) o.target_id = null;
    }));
    if (state.doc.content.start_node_id === n.id) state.doc.content.start_node_id = null;
    state.selectedNodeId = null;
    changed();
  };

  // Multilingual status mini-badges (title / text / each option) when a
  // target language is configured.
  annotateInspectorI18n();
}

// ---------------------------------------------------------------- history (undo / redo)

const clone = (v) => JSON.parse(JSON.stringify(v));
const docSnapshot = () => JSON.stringify({ name: state.doc?.name ?? "", content: state.doc?.content ?? null });

function renderHistoryButtons() {
  const undo = $("#btnUndo"), redo = $("#btnRedo");
  if (undo) undo.disabled = state.history.index <= 0;
  if (redo) redo.disabled = state.history.index >= state.history.stack.length - 1;
}

function resetHistory() {
  state.history = { stack: [], index: -1, mergeKey: null, mergeAt: 0 };
  state.savedSnapshot = state.doc ? docSnapshot() : null;
  if (state.doc) pushHistory();
  syncDirty();
  renderHistoryButtons();
}

function pushHistory(mergeKey = null) {
  const h = state.history;
  const snap = clone(state.doc.content);
  const now = Date.now();
  if (mergeKey && h.mergeKey === mergeKey &&
      h.index >= 0 && h.index === h.stack.length - 1 &&
      now - h.mergeAt <= MERGE_WINDOW_MS) {
    // same field typed into continuously: collapse into the current entry
    h.stack[h.index] = snap;
    h.mergeAt = now;
  } else {
    // drop any redo branch before recording a new change
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(snap);
    if (h.stack.length > HISTORY_LIMIT) h.stack.shift();
    h.index = h.stack.length - 1;
    // a discrete change must never merge with a later typing burst
    h.mergeKey = mergeKey;
    h.mergeAt = mergeKey ? now : 0;
  }
  syncDirty();
  renderHistoryButtons();
}

function syncDirty() {
  state.dirty = !!state.doc && docSnapshot() !== state.savedSnapshot;
  renderStatus();
  updateI18nBadge();
}

function applyHistory(step) {
  const h = state.history;
  const next = h.index + step;
  if (next < 0 || next >= h.stack.length) return;
  h.index = next;
  // typing after undo/redo must start a fresh, non-merged entry
  h.mergeKey = null; h.mergeAt = 0;
  state.doc.content = clone(h.stack[next]);
  const ids = new Set((state.doc.content.nodes || []).map((n) => n.id));
  if (!ids.has(state.selectedNodeId)) state.selectedNodeId = null;
  if (state.selectedEdge) {
    const n = getNode(state.selectedEdge.nodeId);
    if (!n || !(n.options || []).some((o) => o.id === state.selectedEdge.optionId)) {
      state.selectedEdge = null;
    }
  }
  state.connecting = null;
  state.dragNode = null;
  syncDirty();
  validateLocal();
  renderAll();
  renderHistoryButtons();
}

const undo = () => applyHistory(-1);
const redo = () => applyHistory(1);

// ---------------------------------------------------------------- mutations

let validateTimer;
function changed() {
  pushHistory();
  drawNodes();
  drawEdges();
  renderInspector();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateLocal, 150);
  renderSidebar();
}

// Continuous typing (title / text / option label): merged into one history entry.
function commitTyped(mergeKey) {
  pushHistory(mergeKey);
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateLocal, 150);
  annotateInspectorI18n();   // original edits flip translations to 待复核 live
}

// ---------------------------------------------------------------- persistence

async function loadList(selectId) {
  state.scripts = await api("/api/scripts");
  renderSidebar();
  if (selectId) await openScript(selectId);
  else if (state.scripts.length) await openScript(state.scripts[0].id);
  else {
    state.doc = null;
    state.dirty = false;
    state.coverage = null;
    state.i18n.langCode = null;
    state.i18n.langLabel = "";
    state.i18n.view = null;
    state.markers = { cycles: [], orphans: [], uncovered: [], errors: [] };
    updateI18nBadge();
    resetHistory();
    renderStatus();
  }
}

async function openScript(id) {
  const s = await api(`/api/scripts/${id}`);
  state.currentId = id;
  state.doc = { name: s.name, content: s.content,
                lang_code: s.lang_code || null, lang_label: s.lang_label || "" };
  state.selectedNodeId = null;
  state.selectedEdge = null;
  state.dirty = false;
  $("#scriptName").value = s.name;
  state.pan = { x: 60, y: 40 };
  await loadCoverage();
  await loadI18n(id);
  validateLocal();
  renderAll();
  resetHistory();
}

async function newScript(sample = false) {
  const content = sample
    ? {
        start_node_id: "n_welcome",
        nodes: [
          { id: "n_welcome", type: "question", title: "开场", text: "您好，请问本次访谈方便开始吗？", terminal: false, x: 80, y: 60,
            options: [
              { id: "o_yes", label: "方便，开始", target_id: "n_topic" },
              { id: "o_no", label: "现在不方便", target_id: "n_later" }] },
          { id: "n_topic", type: "question", title: "主题问题", text: "您对新功能的整体满意度如何？", terminal: false, x: 420, y: 40,
            options: [
              { id: "o_good", label: "满意", target_id: "n_detail" },
              { id: "o_bad", label: "不满意", target_id: "n_complaint" }] },
          { id: "n_detail", type: "question", title: "追问细节", text: "最满意的是哪一点？", terminal: false, x: 760, y: -20,
            options: [{ id: "o_back", label: "返回主题", target_id: "n_topic" }] },
          { id: "n_complaint", type: "question", title: "收集不满", text: "请描述具体问题。", terminal: true, x: 760, y: 140, options: [] },
          { id: "n_later", type: "info", title: "改约时间", text: "好的，我们稍后再联系您，感谢！", terminal: true, x: 420, y: 280, options: [] },
        ],
      }
    : { start_node_id: null, nodes: [] };
  const s = await api("/api/scripts", { method: "POST", body: { name: "未命名访谈脚本", content } });
  state.scripts = await api("/api/scripts");
  await openScript(s.id);
  toast(sample ? "已创建示例脚本（含一条演示环路）" : "已创建新脚本");
}

async function saveScript() {
  if (!state.currentId) return;
  state.doc.name = $("#scriptName").value || "未命名访谈脚本";
  await api(`/api/scripts/${state.currentId}`, {
    method: "PUT",
    body: { name: state.doc.name, content: state.doc.content },
  });
  const fresh = await api(`/api/scripts/${state.currentId}/validate`).catch(() => null);
  if (fresh) { state.markers = fresh; }
  state.scripts = await api("/api/scripts");
  await loadCoverage();
  await loadI18n(state.currentId);   // server reconciled pending/missing on save
  validateLocal();
  renderAll();
  // saved: unsaved marker clears and undo/redo history restarts from this point
  resetHistory();
  toast("已保存");
}

// ---------------------------------------------------------------- toolbar UI

function bindToolbar() {
  $("#btnNew").onclick = () => newScript(false);
  $("#btnSample").onclick = () => newScript(true);
  $("#btnSave").onclick = saveScript;
  $("#btnPreview").onclick = openPreview;
  $("#btnCoverage").onclick = openCoverage;
  $("#btnImpact").onclick = openImpact;
  $("#impactRefresh").onclick = runImpact;
  $("#btnRoute").onclick = openRoute;
  $("#routeRun").onclick = runRoutePlan;
  $("#btnI18n").onclick = openI18n;
  $("#i18nSaveLang").onclick = saveI18nLanguage;
  $("#btnFunnel").onclick = openFunnel;
  $("#funnelRefresh").onclick = async () => { await loadFunnel(); toast("路径漏斗已刷新"); };
  $("#funnelSnapshot").onchange = (e) => { funnelState.token = e.target.value || null; loadFunnel(); };
  $("#i18nFilters").addEventListener("click", (e) => {
    const b = e.target.closest(".i18n-filter");
    if (!b) return;
    state.i18n.filter = b.dataset.filter;
    renderI18nModal();
  });
  $("#btnShare").onclick = openShare;
  $("#shareCreate").onclick = createShareSnapshot;
  $("#sharePick").onchange = onSharePickChange;
  $("#ruleSave").onclick = saveShareRules;
  $("#ruleClear").onclick = clearShareRules;
  $("#ruleRefresh").onclick = onRuleRefresh;
  $("#inviteGen").onclick = generateInvites;
  $("#inviteRefresh").onclick = () => loadInvites();
  $("#btnExport").onclick = exportJson;
  $("#btnImport").onclick = () => $("#importFile").click();
  $("#importFile").onchange = importJson;
  $("#btnPort").onclick = openPort;
  $("#portScript").onchange = onPortScriptChange;
  $("#portEntry").onchange = updatePortSummary;
  $("#portConfirm").onclick = confirmPort;
  $("#btnAddNode").onclick = addNode;
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  $("#coverageRefresh").onclick = async () => {
    const c = await loadCoverage(false);
    renderCoverageModal(c);
    renderInspector();
    toast("分支覆盖统计已刷新");
  };
  $("#scriptName").oninput = () => {
    if (!state.doc) return;
    state.doc.name = $("#scriptName").value;
    syncDirty();
  };
  $("#scriptName").onchange = () => { if (state.currentId) saveScript(); };

  $("#scriptList").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      const id = Number(del.dataset.del);
      if (!confirm("确认删除该脚本？")) return;
      await api(`/api/scripts/${id}`, { method: "DELETE" });
      if (state.currentId === id) { state.currentId = null; state.doc = null; state.coverage = null; }
      await loadList();
      return;
    }
    const item = e.target.closest("[data-id]");
    if (item && state.doc) {
      if (state.dirty && !confirm("当前改动未保存，确定切换？")) return;
      await openScript(Number(item.dataset.id));
    }
  });

  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (document.querySelector(".modal-mask.open")) return;
    const key = e.key.toLowerCase();
    if (key === "s") { e.preventDefault(); saveScript(); }
    else if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (key === "y") {
      e.preventDefault();
      redo();
    }
  });
}

function addNode() {
  if (!state.doc) return;
  const count = state.doc.content.nodes.length + 1;
  const node = {
    id: uid("n"), type: "question", title: `问题 ${count}`, text: "", terminal: false,
    x: 140 + ((count - 1) % 4) * 300, y: 120 + Math.floor((count - 1) / 4) * 180,
    options: [
      { id: uid("o"), label: "是", target_id: null },
      { id: uid("o"), label: "否", target_id: null },
    ],
  };
  state.doc.content.nodes.push(node);
  if (!state.doc.content.start_node_id) state.doc.content.start_node_id = node.id;
  state.selectedNodeId = node.id;
  changed();
}

async function exportJson() {
  if (!state.currentId) return;
  const data = await api(`/api/scripts/${state.currentId}/export`);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${state.doc.name || "script"}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("已导出 JSON");
}

async function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const s = await api("/api/import", { method: "POST", body: payload });
    state.scripts = await api("/api/scripts");
    await openScript(s.id);
    toast("导入成功");
  } catch (err) {
    toast("导入失败：" + err.message, 3500);
  }
  e.target.value = "";
}

// ---------------------------------------------------------------- cross-script porting
// Copies the branch reachable from a chosen entry node of ANOTHER saved script
// into the current canvas. Pure client-side: reuses GET /api/scripts and
// GET /api/scripts/{id}, no extra endpoints. Every node/option gets a fresh
// unique id and internal targets are rewritten in one pass; cycles and merging
// paths are de-duplicated by a visited set (BFS); targets that were missing or
// dangling (or point outside the copied subgraph) stay unconnected.

const portState = { docs: new Map() };   // source script id -> fetched script

// Nodes reachable from entryId, in first-visit BFS order; each node appears
// exactly once even with cycles or several paths converging on it.
function reachableSubgraph(content, entryId) {
  const map = new Map((content.nodes || []).map((n) => [n.id, n]));
  const seen = new Set([entryId]);
  const order = [];
  const queue = [entryId];
  while (queue.length) {
    const n = map.get(queue.shift());
    if (!n) continue;
    order.push(n);
    for (const o of n.options || []) {
      const t = o.target_id;
      if (t && map.has(t) && !seen.has(t)) { seen.add(t); queue.push(t); }
    }
  }
  return order;
}

function portSubgraphSummary(nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  let internal = 0, dangling = 0;
  nodes.forEach((n) => (n.options || []).forEach((o) => {
    if (o.target_id && ids.has(o.target_id)) internal++;
    else dangling++;
  }));
  return { nodes: nodes.length, internal, dangling };
}

async function openPort() {
  if (!state.doc) return;
  try {
    state.scripts = await api("/api/scripts");
  } catch (err) {
    toast("脚本列表加载失败：" + err.message, 3000);
    return;
  }
  portState.docs = new Map();
  renderPortScriptOptions();
  await onPortScriptChange();
  openModal("portModal");
}

function renderPortScriptOptions() {
  const sel = $("#portScript");
  const others = state.scripts.filter((s) => s.id !== state.currentId);
  if (!others.length) {
    sel.innerHTML = `<option value="">（除当前脚本外没有已保存脚本，请先保存或新建其他脚本）</option>`;
    sel.disabled = true;
    $("#portEntry").innerHTML = "";
    $("#portEntry").disabled = true;
    $("#portSummary").innerHTML = "";
    $("#portConfirm").disabled = true;
    return;
  }
  sel.disabled = false;
  $("#portConfirm").disabled = false;
  sel.innerHTML = others.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
}

async function onPortScriptChange() {
  const sid = Number($("#portScript").value);
  const entrySel = $("#portEntry");
  if (!sid) { entrySel.innerHTML = ""; $("#portSummary").innerHTML = ""; return; }
  let src = portState.docs.get(sid);
  if (!src) {
    try {
      src = await api(`/api/scripts/${sid}`);
    } catch (err) {
      toast("来源脚本加载失败：" + err.message, 3000);
      return;
    }
    portState.docs.set(sid, src);
  }
  if (!(src.content?.nodes || []).length) {
    entrySel.disabled = true;
    entrySel.innerHTML = `<option value="">（来源脚本没有节点）</option>`;
    $("#portConfirm").disabled = true;
    $("#portSummary").innerHTML = "";
    return;
  }
  entrySel.disabled = false;
  $("#portConfirm").disabled = false;
  entrySel.innerHTML = src.content.nodes.map((n) =>
    `<option value="${esc(n.id)}">${esc(n.title || "(未命名节点)")}（${esc(n.id)}）${
      n.id === src.content.start_node_id ? " · 起始" : ""}</option>`).join("");
  const start = src.content.start_node_id;
  if (start && src.content.nodes.some((n) => n.id === start)) entrySel.value = start;
  updatePortSummary();
}

function updatePortSummary() {
  const el = $("#portSummary");
  const sid = Number($("#portScript").value);
  const entryId = $("#portEntry").value;
  const src = portState.docs.get(sid);
  if (!src) { el.innerHTML = ""; return; }
  if (!entryId) {
    el.innerHTML = `<span class="port-warn">来源脚本没有任何节点，无法移植。</span>`;
    return;
  }
  const s = portSubgraphSummary(reachableSubgraph(src.content, entryId));
  el.innerHTML =
    `将复制 <b>${s.nodes}</b> 个节点、<b>${s.internal}</b> 条内部选项连接` +
    (s.dangling ? `，<b class="port-warn">${s.dangling}</b> 个选项无内部目标（仍保持未连接）` : "") +
    `。<br>节点与选项都会重新生成 ID，内部跳转引用统一重写；按原相对坐标放在当前视野附近，当前起始节点不变。`;
}

async function confirmPort() {
  const sid = Number($("#portScript").value);
  const entryId = $("#portEntry").value;
  if (!sid || !entryId) return;
  let src = portState.docs.get(sid);
  if (!src) {
    try { src = await api(`/api/scripts/${sid}`); }
    catch (err) { toast("来源脚本加载失败：" + err.message, 3000); return; }
  }
  const order = reachableSubgraph(src.content, entryId);
  if (!order.length) { toast("入口节点不存在，无法移植", 3000); return; }

  // Fresh ids must avoid both existing canvas ids and each other.
  const taken = new Set(state.doc.content.nodes.map((n) => n.id));
  const mint = (prefix) => {
    let id;
    do { id = uid(prefix); } while (taken.has(id));
    taken.add(id);
    return id;
  };
  const nodeIdMap = new Map();
  order.forEach((n) => nodeIdMap.set(n.id, mint("n")));

  // Translate the copied group so its bbox is centered at the current
  // viewport center (world coords), keeping original relative coordinates.
  const rect = $("#canvasWrap").getBoundingClientRect();
  const viewCx = rect.width / 2 - state.pan.x;
  const viewCy = rect.height / 2 - state.pan.y;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  order.forEach((n) => {
    const x = Number(n.x) || 0, y = Number(n.y) || 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  });
  const NODE_W = 230, NODE_H_EST = 150, MARGIN = 20;
  let offX = viewCx - ((minX + maxX) / 2 + NODE_W / 2);
  let offY = viewCy - ((minY + maxY) / 2 + 40);
  // keep the translated group inside the world bounds
  const loX = MARGIN - minX, hiX = WORLD_W - MARGIN - NODE_W - maxX;
  const loY = MARGIN - minY, hiY = WORLD_H - MARGIN - NODE_H_EST - maxY;
  offX = loX <= hiX ? Math.min(Math.max(offX, loX), hiX) : loX;
  offY = loY <= hiY ? Math.min(Math.max(offY, loY), hiY) : loY;

  const newNodes = order.map((n) => ({
    id: nodeIdMap.get(n.id),
    type: n.type === "info" ? "info" : "question",
    title: n.title || "",
    text: n.text || "",
    terminal: !!n.terminal,
    x: (Number(n.x) || 0) + offX,
    y: (Number(n.y) || 0) + offY,
    options: (n.options || []).map((o) => ({
      id: mint("o"),
      label: o.label || "",
      // only internal targets inside the copied subgraph are rewritten;
      // empty/missing/outside targets stay unconnected
      target_id: o.target_id && nodeIdMap.has(o.target_id) ? nodeIdMap.get(o.target_id) : null,
    })),
  }));

  state.doc.content.nodes.push(...newNodes);
  state.selectedNodeId = nodeIdMap.get(entryId);
  state.selectedEdge = null;
  closeModal("portModal");
  changed();            // one history entry => the whole port is a single undo
  validateLocal();      // refresh structure markers immediately
  toast(`已移植 ${newNodes.length} 个节点、${
    portSubgraphSummary(order).internal} 条内部连接`);
}

// ---------------------------------------------------------------- multilingual translations
// One target language per script; translations are keyed by node/option ids.
// The server is the source of truth: it flips rows to 待复核 (pending) when the
// original field changes and deletes rows of deleted nodes/options on save.
// The editor view below additionally recomputes status LIVE against the
// current (possibly unsaved) canvas, so editing a title immediately marks its
// translation pending without a round trip.

const i18nFieldName = { title: "标题", text: "正文", option_label: "选项文案" };
const i18nStatusMeta = {
  reviewed: { label: "已复核", cls: "reviewed" },
  pending: { label: "待复核", cls: "pending" },
  missing: { label: "缺失", cls: "missing" },
};

async function loadI18n(scriptId) {
  try {
    const v = await api(`/api/scripts/${scriptId}/translations`);
    state.i18n.langCode = v.lang_code || null;
    state.i18n.view = v;
  } catch (err) {
    state.i18n.langCode = null;
    state.i18n.view = null;
  }
  state.doc && (state.doc.lang_code = state.i18n.langCode);
  updateI18nBadge();
  annotateInspectorI18n();
  return state.i18n.view;
}

// Server status reflects the last save (f.status + f.source = saved current
// text); recompute against the live canvas so unsaved original edits flip a
// reviewed field to pending right away. A field already pending stays pending;
// when the canvas matches the saved source, the server status is authoritative.
function liveFieldStatus(f) {
  if (!f.translation) return "missing";
  const node = getNode(f.node_id);
  if (!node) return f.status;   // deleted locally: row disappears after save
  let source = null;
  if (f.field === "option_label") {
    const o = (node.options || []).find((x) => x.id === f.option_id);
    source = o ? (o.label || "") : null;
  } else source = node[f.field] || "";
  if (source === null) return f.status;
  if (source !== f.source) return "pending";  // unsaved local original edit
  return f.status;
}

function i18nLiveCounts() {
  const counts = { total: 0, reviewed: 0, pending: 0, missing: 0 };
  const view = state.i18n.view;
  if (!view) return counts;
  view.fields.forEach((f) => {
    const node = getNode(f.node_id);
    if (!node) return;  // deleted locally: row disappears on save
    if (f.field === "option_label" && !(node.options || []).some((o) => o.id === f.option_id)) return;
    counts.total += 1;
    counts[liveFieldStatus(f)] += 1;
  });
  return counts;
}

function updateI18nBadge() {
  const badge = $("#i18nBadge");
  if (!badge) return;
  if (!state.i18n.langCode || !state.i18n.view) { badge.style.display = "none"; return; }
  const c = i18nLiveCounts();   // live canvas view; equals server counts when saved
  if (!c.pending && !c.missing) { badge.style.display = "none"; return; }
  badge.style.display = "";
  badge.textContent = `缺 ${c.missing} · 待复核 ${c.pending}`;
  badge.title = `译文缺失 ${c.missing} 个字段，待复核 ${c.pending} 个字段（点击打开多语言译文面板定位）`;
}

async function openI18n() {
  if (!state.currentId || !state.doc) return;
  if (state.dirty) {
    await saveScript();   // status is always judged against saved content
    if (!state.currentId) return;
  }
  await loadI18n(state.currentId);
  state.i18n.filter = "all";
  $("#i18nCode").value = state.i18n.langCode || "";
  $("#i18nLabel").value = state.doc.lang_label || "";
  openModal("i18nModal");
  renderI18nModal();
}

function renderI18nLangHeader() {
  const hint = $("#i18nLangHint");
  const code = state.i18n.langCode;
  if (code) {
    hint.innerHTML = `当前目标语言：<b>${esc(state.doc.lang_label || code)}</b>
      <code class="i18n-lang-code">${esc(code)}</code>
      <span class="i18n-hint-note">（更换语言代码会清空该脚本已有的全部译文；仅改名称则保留）</span>`;
  } else {
    hint.innerHTML = `<span class="i18n-hint-note">尚未设置目标语言：填入语言代码与名称并点击「保存语言」后即可逐字段维护译文。</span>`;
  }
  $("#i18nSummary").style.display = code ? "" : "none";
  $("#i18nList").style.display = code ? "" : "none";
}

function renderI18nModal() {
  renderI18nLangHeader();
  const code = state.i18n.langCode;
  if (!code || !state.i18n.view) { $("#i18nList").innerHTML = ""; return; }

  const live = new Map();
  state.i18n.view.fields.forEach((f) => live.set(f, liveFieldStatus(f)));
  const counts = { total: 0, reviewed: 0, pending: 0, missing: 0 };
  live.forEach((st) => { counts.total += 1; counts[st] += 1; });
  $("#i18nTotal").textContent = counts.total;
  $("#i18nReviewed").textContent = counts.reviewed;
  $("#i18nPending").textContent = counts.pending;
  $("#i18nMissing").textContent = counts.missing;
  $("#i18nFilters").querySelectorAll(".i18n-filter").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === state.i18n.filter);
    const base = b.dataset.filter === "all" ? "全部"
      : (b.dataset.filter === "missing" ? "仅缺失"
        : b.dataset.filter === "pending" ? "仅待复核" : "仅已复核");
    b.textContent = b.dataset.filter === "all" ? base : `${base}（${counts[b.dataset.filter]}）`;
  });

  // Group fields by node in canvas order.
  const groups = state.doc.content.nodes.map((node) => ({
    node,
    rows: state.i18n.view.fields
      .filter((f) => f.node_id === node.id)
      .filter((f) => {
        if (f.field === "option_label") {
          return (node.options || []).some((o) => o.id === f.option_id);
        }
        return true;
      })
      .filter((f) => state.i18n.filter === "all" || live.get(f) === state.i18n.filter),
  })).filter((g) => g.rows.length);

  const list = $("#i18nList");
  if (!groups.length) {
    list.innerHTML = `<div class="cov-empty">当前筛选条件下没有字段。</div>`;
    return;
  }
  list.innerHTML = groups.map((g) => `
    <div class="i18n-group">
      <div class="i18n-group-head">
        ${esc(g.node.title || "(未命名节点)")}
        <code class="i18n-node-id">${esc(g.node.id)}</code>
        ${g.node.id === state.doc.content.start_node_id ? '<span class="route-tag">起始</span>' : ""}
        ${g.node.terminal ? '<span class="route-tag end">终点</span>' : ""}
      </div>
      ${g.rows.map((f) => {
        const st = live.get(f);
        const meta = i18nStatusMeta[st];
        const optId = f.option_id ? f.option_id : "";
        return `
        <div class="i18n-row ${meta.cls}" data-node="${esc(f.node_id)}" data-field="${esc(f.field)}"
             data-opt="${esc(optId)}" data-saved="${esc(f.translation)}">
          <div class="i18n-row-head">
            <span class="i18n-field-name">${i18nFieldName[f.field] || f.field}
              ${f.option_id ? `<code>${esc(f.option_id)}</code>` : ""}</span>
            <span class="i18n-status ${meta.cls}">${meta.label}</span>
            <button class="i18n-locate" data-locate-node="${esc(f.node_id)}"
                    ${f.option_id ? `data-locate-opt="${esc(f.option_id)}"` : ""}
                    data-locate-field="${esc(f.field)}">🎯 定位字段</button>
          </div>
          <div class="i18n-source" title="脚本原文（只读）">${esc(f.source || "（空）")}</div>
          <textarea class="i18n-input" rows="2"
                    placeholder="输入${esc(state.doc.lang_label || "目标语言")}译文（留空保存即删除该译文）">${esc(f.translation)}</textarea>
          ${st === "pending" ? '<div class="i18n-pending-note">⚠ 原文已改动：核对译文后在此失焦即自动保存为已复核；不再需要时清空即可。</div>' : ""}
        </div>`;
      }).join("")}
    </div>`).join("");

  list.querySelectorAll(".i18n-input").forEach((ta) => {
    ta.addEventListener("blur", (e) => saveI18nField(e.target));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.target.blur(); }
    });
  });
  list.querySelectorAll("[data-locate-node]").forEach((b) => {
    b.onclick = () => {
      closeModal("i18nModal");
      locateI18nField(b.dataset.locateNode, b.dataset.locateOpt || null, b.dataset.locateField);
    };
  });
}

async function saveI18nLanguage() {
  if (!state.currentId) return;
  const code = $("#i18nCode").value.trim();
  const label = $("#i18nLabel").value.trim();
  if (!code || !label) { toast("请填写语言代码与语言名称"); return; }
  const existing = state.i18n.view?.counts;
  if (state.i18n.langCode && code !== state.i18n.langCode && existing &&
      existing.reviewed + existing.pending > 0 &&
      !confirm(`更换目标语言为「${code}」将清空当前语言的全部译文，确认？`)) return;
  const btn = $("#i18nSaveLang");
  btn.disabled = true;
  try {
    const r = await api(`/api/scripts/${state.currentId}/language`,
      { method: "PUT", body: { lang_code: code, lang_label: label } });
    state.i18n.langCode = r.lang_code;
    state.doc.lang_code = r.lang_code;
    state.doc.lang_label = r.lang_label;
    await loadI18n(state.currentId);
    renderI18nModal();
    toast(`目标语言已保存：${r.lang_label}（${r.lang_code}）`);
  } catch (err) {
    toast("保存语言失败：" + err.message, 3500);
  }
  btn.disabled = false;
}

async function saveI18nField(ta) {
  const row = ta.closest(".i18n-row");
  if (!row || !state.currentId || !state.i18n.langCode) return;
  if (ta.value === row.dataset.saved) return;  // unchanged
  const body = {
    node_id: row.dataset.node,
    field: row.dataset.field,
    option_id: row.dataset.opt || null,
    translation: ta.value,
  };
  ta.disabled = true;
  try {
    const v = await api(`/api/scripts/${state.currentId}/translations`, { method: "PUT", body });
    state.i18n.view = v;
    renderI18nModal();
    updateI18nBadge();
    annotateInspectorI18n();
  } catch (err) {
    ta.disabled = false;
    toast("译文保存失败：" + err.message, 3500);
  }
}

// Close the modal, select the node and briefly highlight the matching
// inspector field (title / text input / option label input).
function locateI18nField(nodeId, optionId, field) {
  const node = getNode(nodeId);
  if (!node) { toast("该节点已不在当前画布上，无法定位"); return; }
  state.selectedNodeId = nodeId;
  state.selectedEdge = null;
  drawNodes(); drawEdges(); renderInspector();
  requestAnimationFrame(() => {
    let target = null;
    if (optionId) {
      target = document.querySelector(`.opt-edit[data-oid="${CSS.escape(optionId)}"] .opt-label-in`);
    } else if (field === "title") target = $("#fTitle");
    else if (field === "text") target = $("#fText");
    if (target) {
      target.focus();
      target.classList.add("i18n-flash");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => target.classList.remove("i18n-flash"), 1600);
    }
  });
}

// Small status markers next to inspector fields (only when a language is set).
function annotateInspectorI18n() {
  document.querySelectorAll(".i18n-mini").forEach((e) => e.remove());
  if (!state.i18n.langCode || !state.i18n.view || !state.selectedNodeId) return;
  const nodeId = state.selectedNodeId;
  const mark = (el, status) => {
    if (!el) return;
    const meta = i18nStatusMeta[status];
    const span = document.createElement("span");
    span.className = `i18n-mini ${meta.cls}`;
    span.textContent = `🌐 ${meta.label}`;
    span.title = "目标语言译文状态（多语言译文面板可编辑）";
    el.appendChild(span);
  };
  const find = (field, optionId) =>
    state.i18n.view.fields.find((f) => f.node_id === nodeId && f.field === field &&
      ((f.option_id || null) === (optionId || null)));
  const fTitle = find("title"), fText = find("text");
  if (fTitle) mark($("#fTitle")?.closest(".field"), liveFieldStatus(fTitle));
  if (fText) mark($("#fText")?.closest(".field"), liveFieldStatus(fText));
  document.querySelectorAll(".opt-edit").forEach((row) => {
    const f = find("option_label", row.dataset.oid);
    if (f) mark(row.querySelector(".row"), liveFieldStatus(f));
  });
}

// ---------------------------------------------------------------- share answer path funnel
// 分享作答路径漏斗: pick one already-created read-only share snapshot; the
// server reads ONLY that snapshot's share answer sessions and builds a prefix
// tree over the ordered (snapshot-original node id, option id) choices. A
// repeated choice in a cycle stays at a different depth (no node merge). Each
// prefix shows reached / stopped-unfinished / completed counts plus the reach
// ratio vs its parent; clicking a row lists the run ids behind the prefix.
// Labels come from the frozen snapshot content, never the live canvas.

const funnelState = { shares: [], token: null, data: null };

async function openFunnel() {
  if (!state.currentId) return;
  funnelState.shares = [];
  funnelState.token = null;
  funnelState.data = null;
  $("#funnelMeta").innerHTML = "";
  $("#funnelBody").innerHTML = `<div class="cov-empty">正在加载该脚本的分享快照…</div>`;
  openModal("funnelModal");
  try {
    funnelState.shares = await api(`/api/scripts/${state.currentId}/shares`);
  } catch (err) {
    $("#funnelBody").innerHTML =
      `<div class="route-none">分享快照列表加载失败：${esc(err.message)}</div>`;
    renderFunnelSnapshotOptions();
    return;
  }
  renderFunnelSnapshotOptions();
  await loadFunnel();
}

function renderFunnelSnapshotOptions() {
  const sel = $("#funnelSnapshot");
  if (!funnelState.shares.length) {
    sel.innerHTML = `<option value="">（该脚本还没有创建任何分享快照，请先到「🔗 只读分享」生成）</option>`;
    sel.disabled = true;
    $("#funnelMeta").innerHTML = "";
    return;
  }
  sel.disabled = false;
  sel.innerHTML = funnelState.shares.map((s) => {
    const dt = (s.created_at || "").replace("T", " ").slice(0, 16);
    const gate = { open: "", not_started: " · ⏳未开放", closed: " · ⛔已截止", full: " · 👥已满" }[s.open_status] || "";
    return `<option value="${esc(s.token)}">${esc(s.name)} · ${dt} · 会话 ${s.run_count}（完成 ${s.finished_count}）${gate}${
      s.invite_only ? " · 🎫邀请制" : ""}${s.lang_code ? ` · 🌐${esc(s.lang_code)}` : " · 原文"}</option>`;
  }).join("");
  if (!funnelState.token || !funnelState.shares.some((s) => s.token === funnelState.token)) {
    funnelState.token = funnelState.shares[0].token;
  }
  sel.value = funnelState.token;
}

async function loadFunnel() {
  if (!funnelState.token) {
    $("#funnelMeta").innerHTML = "";
    $("#funnelBody").innerHTML =
      `<div class="cov-empty-big">📭 还没有可查看的分享快照<br>
        <small>先到工具栏「🔗 只读分享」生成一个分享快照，受访者作答后再回到这里查看作答路径漏斗。</small></div>`;
    return;
  }
  $("#funnelBody").innerHTML = `<div class="cov-empty">正在构建作答路径前缀树…</div>`;
  try {
    funnelState.data = await api(
      `/api/share/${encodeURIComponent(funnelState.token)}/funnel`);
  } catch (err) {
    $("#funnelMeta").innerHTML = "";
    $("#funnelBody").innerHTML =
      `<div class="route-none">路径漏斗加载失败：${esc(err.message)}</div>`;
    funnelState.data = null;
    return;
  }
  renderFunnel();
}

function pct(v) {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v * 1000) / 10}%`;
}

function renderFunnel() {
  const d = funnelState.data;
  if (!d) { $("#funnelMeta").innerHTML = ""; $("#funnelBody").innerHTML = ""; return; }
  const dt = (d.created_at || "").replace("T", " ").slice(0, 16);
  $("#funnelMeta").innerHTML =
    `<div class="funnel-meta">
       <span class="funnel-snap">快照 <code>${esc(d.token)}</code> · ${esc(dt)}</span>
       <span class="route-tag">${d.invite_only ? "🎫 邀请制" : "公开快照"}</span>
       <span class="route-tag ${d.lang_code ? "hit" : "end"}">${
         d.lang_code ? `🌐 ${esc(d.lang_label || d.lang_code)}（${esc(d.lang_code)}）` : "原文快照"}</span>
     </div>`;

  if (!d.session_count) {
    $("#funnelBody").innerHTML =
      `<div class="cov-empty-big">📭 该快照还没有作答会话<br>
        <small>把该快照的只读链接发给受访者（邀请制快照需凭邀请码开始）；产生作答后点「↻ 刷新漏斗」即可看到按节点+选项顺序聚合的路径前缀树。</small></div>`;
    return;
  }

  const cards =
    `<div class="cov-cards">
       <div><b>${d.session_count}</b><span>作答会话</span></div>
       <div><b style="color:var(--start)">${d.completed_count}</b><span>在此完成</span></div>
       <div><b style="color:var(--orphan)">${d.unfinished_count}</b><span>未完成</span></div>
       <div><b>${d.total_choices}</b><span>累计选择次数</span></div>
     </div>
     <div class="cov-line">每个前缀：<b>到达</b> = 走到该前缀的会话数；
       <b style="color:var(--orphan)">停止</b> = 在此中断的未完成数；
       <b style="color:var(--start)">完成</b> = 在此走到结束数；
       <b>占父</b> = 到达数 / 父前缀到达数。点击任一行列出到达该前缀的会话 ID。</div>`;
  $("#funnelBody").innerHTML = cards + `<div class="funnel-tree" id="funnelTree"></div>`;
  $("#funnelTree").appendChild(renderFunnelNode(d.tree, true));
}

// Delegated click handler (bound once at boot): caret expands/collapses,
// anywhere else on the row toggles its session-id drawer.
function onFunnelRowClick(e) {
  if (!document.getElementById("funnelModal").classList.contains("open")) return;
  const row = e.target.closest(".funnel-row");
  if (!row) return;
  e.stopPropagation();
  const kids = row.parentElement.querySelector(":scope > .funnel-children");
  if (e.target.closest(".funnel-caret") && kids) {
    const open = kids.style.display === "none";
    kids.style.display = open ? "block" : "none";
    row.classList.toggle("open", open);
    row.querySelector(".funnel-caret").textContent = open ? "▾" : "▸";
    return;
  }
  const drawer = row.parentElement.querySelector(":scope > .funnel-sessions");
  if (!drawer) return;
  const show = drawer.style.display !== "block";
  drawer.style.display = show ? "block" : "none";
  row.classList.toggle("sessions-open", show);
}

function renderFunnelNode(node, isRoot) {
  const wrap = document.createElement("div");
  wrap.className = isRoot ? "funnel-node root" : "funnel-node";
  const hasChildren = node.children && node.children.length;
  const row = document.createElement("div");
  row.className = "funnel-row";
  row.dataset.depth = node.depth;

  const counts = `
    <span class="funnel-count reached" title="到达该前缀的会话数">到达 <b>${node.reached}</b></span>
    <span class="funnel-count stopped" title="在此停止的未完成会话数">停止 <b>${node.stopped_unfinished}</b></span>
    <span class="funnel-count done" title="在此完成（走到结束）的会话数">完成 <b>${node.completed}</b></span>
    <span class="funnel-count ratio" title="到达数占父前缀到达数的比例（根前缀无父级）">占父 <b>${isRoot ? "—" : pct(node.ratio)}</b></span>`;

  if (isRoot) {
    row.innerHTML = `
      <span class="funnel-caret">${hasChildren ? "▾" : "•"}</span>
      <span class="funnel-path-label"><b>起始（全部会话）</b></span>
      ${counts}`;
  } else {
    const loop = node.repeated_in_path
      ? '<span class="funnel-loop" title="环路中再次选择同一选项，保留在更深一层，不按节点合并">🔁 环路重复</span>' : "";
    row.innerHTML = `
      <span class="funnel-caret">${hasChildren ? "▸" : "•"}</span>
      <span class="funnel-path-label">
        <span class="funnel-edge">
          <span class="funnel-node-name" title="原脚本节点 ID：${esc(node.node_id)}">${esc(node.node_title)}</span>
          <span class="funnel-arrow">—「</span>
          <span class="funnel-opt-name" title="原脚本选项 ID：${esc(node.option_id)}">${esc(node.option_label)}</span>
          <span class="funnel-arrow">」→</span>
          <span class="funnel-target" title="目标节点 ID：${esc(node.target_id ?? "")}">${esc(node.target_title)}</span>
        </span>
        <code class="funnel-ids">${esc(node.node_id)} :: ${esc(node.option_id)}</code>
        ${loop}
      </span>
      ${counts}`;
  }
  wrap.appendChild(row);

  // Session-id drawer for this exact prefix.
  const drawer = document.createElement("div");
  drawer.className = "funnel-sessions";
  drawer.style.display = "none";
  const ids = node.sessions || [];
  drawer.innerHTML =
    `<div class="funnel-sess-head">到达该前缀的会话 ID（${ids.length}）
       <span class="funnel-sess-hint">点击行可收起</span></div>
     <div class="funnel-sess-ids">${
       ids.map((s) => `<span class="funnel-sess-id ${s.finished ? "done" : "open"}" title="${
         s.finished ? "已完成" : "未完成"} · ${s.choice_count} 次选择 · ${esc(s.created_at || "")}">
         #${s.run_id}${s.finished ? " ✓" : " ⏸"}</span>`).join("") ||
       '<span class="cov-empty">（无）</span>'}</div>`;
  wrap.appendChild(drawer);

  if (hasChildren) {
    const kids = document.createElement("div");
    kids.className = "funnel-children";
    kids.style.display = "none";
    node.children.forEach((ch) => kids.appendChild(renderFunnelNode(ch, false)));
    // Root starts expanded so the first choices are immediately visible.
    if (isRoot) { kids.style.display = "block"; row.classList.add("open"); }
    wrap.appendChild(kids);
  }
  return wrap;
}

// ---------------------------------------------------------------- share / preview

// loadSeq is a monotonically increasing epoch bumped on every snapshot
// selection. Every detail / open-status / invites response (and every save
// follow-up) is bound to the epoch + token captured at request time; a response
// whose epoch is no longer current comes from an abandoned selection (or an
// in-flight save after switching) and must never touch the panel.
const shareState = { token: null, url: "", shares: [], detail: null, loadSeq: 0, loaded: false };

// Snapshot the token/epoch an async share-panel request belongs to.
function shareRequestCtx() {
  return { token: shareState.token, seq: shareState.loadSeq };
}
// True only while the panel still shows the snapshot that started the request.
function isCurrentShareCtx(ctx) {
  return !!ctx && ctx.seq === shareState.loadSeq && ctx.token === shareState.token;
}

// While a selected snapshot's detail is loading (or a rule save is in flight)
// the rule form and save/clear/invite actions stay disabled, so a late response
// can never be edited or re-saved into another snapshot. The refresh button is
// intentionally kept enabled so a failed load can be retried.
function setShareRulesLocked(locked) {
  for (const id of ["ruleStarted", "ruleDeadline", "ruleMaxRuns",
    "ruleSave", "ruleClear", "inviteGen", "inviteRefresh", "inviteCount"]) {
    const el = $(`#${id}`);
    if (el) el.disabled = locked;
  }
}

// Reset the manage panel to its "switching snapshots" state: blank inputs,
// action buttons locked, explicit loading placeholders.
function showSharePanelLoading() {
  setShareRulesLocked(true);
  shareState.loaded = false;
  $("#ruleStarted").value = "";
  $("#ruleDeadline").value = "";
  $("#ruleMaxRuns").value = "";
  $("#ruleStatus").innerHTML = `<span class="rule-loading">⏳ 正在加载快照详情与开放规则…</span>`;
  $("#inviteStatus").innerHTML = `<span class="invite-loading">⏳ 正在加载邀请码…</span>`;
  $("#inviteCodes").innerHTML = "";
  $("#shareLangNote").innerHTML = "";
}

async function openShare() {
  if (!state.currentId) return;
  if (state.dirty) await saveScript();
  await loadI18n(state.currentId);

  // Language options: original text (default) or the script's target language.
  const sel = $("#shareLang");
  if (state.i18n.langCode) {
    sel.innerHTML =
      `<option value="">原文（不附带译文）</option>
       <option value="${esc(state.i18n.langCode)}">${esc(state.doc.lang_label || state.i18n.langCode)}（${esc(state.i18n.langCode)}）— 冻结已复核译文</option>`;
    const c = state.i18n.view?.counts;
    sel.value = c && c.reviewed > 0 ? state.i18n.langCode : "";
  } else {
    sel.innerHTML = `<option value="">原文（脚本尚未设置目标语言）</option>`;
  }
  shareState.token = null;
  shareState.detail = null;
  shareState.loaded = false;
  // New modal session: invalidate any detail/status/save responses still in
  // flight from a previous open of this modal.
  shareState.loadSeq++;
  $("#shareLangNote").innerHTML = "";
  openModal("shareModal");
  await refreshSharePick(state.currentId, true);
  // Jump straight into the newest existing snapshot; with none, show the form.
  if (shareState.token) await loadExistingShare();
}

// Load the script's snapshot list and populate the "manage snapshot" picker.
// Returns the token now selected (or null); when the selection changes here
// the caller is responsible for bumping the request epoch.
async function refreshSharePick(scriptId, selectFirst = false) {
  const sel = $("#sharePick");
  try {
    shareState.shares = await api(`/api/scripts/${scriptId}/shares`);
  } catch (err) {
    shareState.shares = [];
  }
  if (!shareState.shares.length) {
    sel.innerHTML = `<option value="">（暂无已创建快照，请先生成一个）</option>`;
    sel.disabled = true;
    showShareCreateBox();
    return null;
  }
  sel.disabled = false;
  sel.innerHTML = shareState.shares.map((s) => {
    const dt = (s.created_at || "").replace("T", " ").slice(0, 16);
    const statusText = {
      open: "🟢 开放中", not_started: "⏳ 未开放", closed: "⛔ 已截止", full: "👥 已满",
    }[s.open_status] || s.open_status;
    return `<option value="${esc(s.token)}">${dt} · ${esc(statusText)} · 会话 ${s.run_count}${
      s.invite_only ? " · 🎫邀请制" : ""}${s.lang_code ? ` · 🌐${esc(s.lang_code)}` : ""}</option>`;
  }).join("");
  const keep = shareState.shares.some((s) => s.token === shareState.token);
  if (selectFirst || !keep) {
    shareState.token = shareState.shares[0].token;
  }
  sel.value = shareState.token;
  return shareState.token;
}

function showShareCreateBox() {
  $("#shareCreateBox").style.display = "";
  $("#shareResult").style.display = "none";
}

async function onSharePickChange() {
  const token = $("#sharePick").value || null;
  if (!token) {
    // No snapshot to manage: invalidate the previous selection's responses.
    shareState.token = null;
    shareState.detail = null;
    shareState.loaded = false;
    shareState.loadSeq++;
    showShareCreateBox();
    return;
  }
  // A new selection supersedes the previous one: bump the epoch and lock the
  // rule form until THIS snapshot's detail arrives.
  shareState.token = token;
  shareState.loadSeq++;
  await loadExistingShare();
}

// Load one created snapshot: link/language note, answer-open rules and invites.
async function loadExistingShare() {
  const ctx = shareRequestCtx();
  if (!ctx.token) return;
  $("#shareCreateBox").style.display = "none";
  $("#shareResult").style.display = "";
  shareState.url = `${location.origin}/share.html?token=${encodeURIComponent(ctx.token)}`;
  $("#shareLink").value = shareState.url;
  $("#shareOpen").onclick = () => window.open(shareState.url, "_blank");
  $("#shareCopy").onclick = () => {
    copyText(shareState.url).then((ok) => toast(ok ? "链接已复制" : "复制失败，请手动选择复制"));
  };
  // Lock the rule form for the duration of this selection's load. Detail and
  // invites are fetched together, but each rejects independently so one failed
  // request cannot leave a stale response from the other snapshot on screen.
  showSharePanelLoading();
  const [detailResult, invitesResult] = await Promise.allSettled([
    api(`/api/share/${encodeURIComponent(ctx.token)}`),
    api(`/api/share/${encodeURIComponent(ctx.token)}/invites`),
  ]);

  // Switched away (to another snapshot, to create-mode, or closed/reopened)
  // while requests were in flight: their results belong to an abandoned
  // selection and must not fill the current panel.
  if (!isCurrentShareCtx(ctx)) return;

  if (detailResult.status === "fulfilled") {
    const detail = detailResult.value;
    shareState.detail = detail;
    shareState.loaded = true;
    renderShareLangNote(detail);
    fillRuleFields(detail);
    // Detail is authoritative for the selected snapshot: editing is allowed
    // only now that the form actually holds this snapshot's rules.
    setShareRulesLocked(false);
  } else {
    // Keep the form locked (empty inputs) on failure — an unlocked form would
    // let empty/half-loaded values be saved. ruleRefresh stays available to
    // retry, and renderRuleStatus() below already shows the error state.
    shareState.detail = null;
    shareState.loaded = false;
    $("#shareLangNote").innerHTML =
      `<span class="invite-err">快照详情加载失败：${esc(detailResult.reason?.message || "请重试")}</span>`;
    toast("快照信息加载失败：" + (detailResult.reason?.message || ""), 3500);
  }
  if (invitesResult.status === "fulfilled") {
    renderInvites(invitesResult.value, $("#inviteStatus"), $("#inviteCodes"));
  } else {
    $("#inviteStatus").innerHTML =
      `<span class="invite-err">邀请码状态加载失败：${esc(invitesResult.reason?.message || "")}</span>`;
    $("#inviteCodes").innerHTML = "";
  }
  // Open-status pill (independent request); stale responses are filtered inside.
  await renderRuleStatus(ctx);
}

function renderShareLangNote(detail) {
  const note = $("#shareLangNote");
  if (detail.lang_code) {
    let frozen = 0;
    const nodes = detail.translations?.nodes || {};
    for (const n of Object.values(nodes)) {
      if (n.title) frozen++;
      if (n.text) frozen++;
      frozen += Object.keys(n.options || {}).length;
    }
    note.innerHTML = `🌐 该快照冻结了 <b>${esc(detail.lang_label || detail.lang_code)}</b> 语言下
      生成时刻的<b>已复核译文（${frozen} 个字段）</b>；作答页逐字段展示译文，
      缺失 / 待复核字段回退原文。译文已随快照固定，之后继续翻译或修改原文都不影响此链接。`;
  } else {
    note.innerHTML = "该快照为<b>纯原文</b>，作答页展示脚本原文。";
  }
}

async function createShareSnapshot() {
  if (!state.currentId) return;
  const langCode = $("#shareLang").value || null;
  const btn = $("#shareCreate");
  btn.disabled = true;
  try {
    const r = await api(`/api/scripts/${state.currentId}/share`, {
      method: "POST",
      body: langCode ? { lang_code: langCode } : {},
    });
    // The new snapshot is a brand-new selection: supersede anything in flight.
    shareState.token = r.token;
    shareState.detail = null;
    shareState.loaded = false;
    shareState.loadSeq++;
    toast("分享快照已创建");
    // Refresh the picker (keeping the new snapshot selected), then open it.
    await refreshSharePick(state.currentId, false);
    await loadExistingShare();
  } catch (err) {
    toast("创建分享失败：" + err.message, 3500);
  }
  btn.disabled = false;
}

// ---- answer-open rules (UTC start inclusive / deadline exclusive / cap) ----

// Server ISO (with offset) -> datetime-local value ('YYYY-MM-DDTHH:mm' UTC).
function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Build the UTC components explicitly: the editor edits UTC wall-clock time.
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fillRuleFields(detail) {
  $("#ruleStarted").value = isoToLocalInput(detail.open_started_at);
  $("#ruleDeadline").value = isoToLocalInput(detail.open_deadline_at);
  $("#ruleMaxRuns").value = detail.max_new_runs ?? "";
}

// Render the open-status pill. `ctx` binds the request to the snapshot
// selection that initiated it; an omitted ctx captures the current selection.
async function renderRuleStatus(ctx = shareRequestCtx()) {
  const el = $("#ruleStatus");
  if (!ctx || !ctx.token) {
    el.innerHTML = "";
    return;
  }
  try {
    const r = await api(`/api/share/${encodeURIComponent(ctx.token)}/rules`);
    // Late status response for a snapshot no longer shown: drop it entirely.
    if (!isCurrentShareCtx(ctx)) return;
    const labels = {
      open: ["open", "🟢 当前开放：可新建作答"],
      not_started: ["not_started", "⏳ 未开放：到达开始时间后才可新建作答"],
      closed: ["closed", "⛔ 已截止：不能再新建作答"],
      full: ["full", "👥 已满：已创建会话数达到上限"],
    };
    const [cls, text] = labels[r.open_status] || ["open", r.open_status];
    const meta = [];
    meta.push(`已创建会话 <b>${r.run_count}</b>` +
      (r.max_new_runs != null ? ` / 上限 <b>${r.max_new_runs}</b>` : " / 上限不限"));
    meta.push(r.open_started_at
      ? `开始 ${esc(r.open_started_at.replace("T", " ").slice(0, 16))} UTC（含）`
      : "不设开始时间");
    meta.push(r.open_deadline_at
      ? `截止 ${esc(r.open_deadline_at.replace("T", " ").slice(0, 16))} UTC（不含）`
      : "不设截止时间");
    el.innerHTML = `<span class="rule-pill ${cls}">${text}</span>
      <span class="rule-meta">${meta.join(" · ")}</span>`;
  } catch (err) {
    if (!isCurrentShareCtx(ctx)) return;
    el.innerHTML = `<span class="invite-err">开放状态加载失败：${esc(err.message)}</span>`;
  }
}

// "↻ 刷新状态": if the snapshot detail never arrived (failed load keeps the
// form locked), retry the whole load; otherwise just re-fetch the status pill.
async function onRuleRefresh() {
  if (!shareState.token) return;
  if (!shareState.loaded) await loadExistingShare();
  else await renderRuleStatus();
}

function collectRulePayload() {
  const started = $("#ruleStarted").value;
  const deadline = $("#ruleDeadline").value;
  const maxRaw = $("#ruleMaxRuns").value.trim();
  let max_new_runs = null;
  if (maxRaw !== "") {
    if (!/^\d+$/.test(maxRaw)) throw new Error("新建会话上限必须是正整数");
    max_new_runs = Number(maxRaw);
    if (max_new_runs < 1) throw new Error("新建会话上限必须是正整数（≥ 1）");
  }
  // datetime-local gives UTC wall-clock 'YYYY-MM-DDTHH:mm'; send with explicit offset.
  if (started && deadline && started >= deadline) {
    throw new Error("开始时间必须早于截止时间（开始含、截止不含）");
  }
  return {
    open_started_at: started ? `${started}:00+00:00` : null,
    open_deadline_at: deadline ? `${deadline}:00+00:00` : null,
    max_new_runs,
  };
}

async function saveShareRules() {
  // Pin the form to the snapshot selected at click time. Switching snapshots
  // during the request can never redirect this PUT or backfill the new panel.
  const ctx = shareRequestCtx();
  if (!ctx || !ctx.token) return;
  if (!shareState.loaded) { toast("快照详情尚未加载完成，请稍候再保存"); return; }
  let payload;
  try {
    payload = collectRulePayload();
  } catch (err) {
    toast(err.message);
    return;
  }
  const btn = $("#ruleSave");
  btn.disabled = true;
  $("#ruleClear").disabled = true;
  $("#ruleStatus").innerHTML = `<span class="rule-loading">💾 正在保存开放规则…</span>`;
  try {
    const r = await api(`/api/share/${encodeURIComponent(ctx.token)}/rules`, {
      method: "PUT", body: payload,
    });
    const stale = !isCurrentShareCtx(ctx);
    // The save succeeded on the form's own snapshot even if the user has since
    // switched to another one; say so but never touch the newly shown panel.
    if (stale) {
      toast(`已保存到提交时所选快照（${ctx.token.slice(0, 6)}…），当前面板为另一个快照`);
    } else {
      fillRuleFields(r);
      toast("作答开放规则已保存");
    }
    // Refresh follow-ups are bound to the save's context: the status pill
    // ignores stale responses, and the picker re-list keeps the newly selected
    // snapshot (its token is preserved by refreshSharePick).
    await Promise.all([
      renderRuleStatus(ctx),
      refreshSharePick(state.currentId, false),
    ]);
  } catch (err) {
    if (isCurrentShareCtx(ctx)) {
      toast("保存失败：" + err.message, 3500);
      await renderRuleStatus(ctx);
    } else {
      toast("原快照规则保存失败：" + err.message, 3500);
    }
  } finally {
    // Only restore the buttons for the panel this save belongs to, and only
    // once its own load has finished. A newer selection (same panel locked
    // while ITS detail loads) must stay locked regardless of this save.
    if (isCurrentShareCtx(ctx) && shareState.loaded) setShareRulesLocked(false);
  }
}

async function clearShareRules() {
  // Capture the form-owned snapshot before the confirm dialog and the request:
  // switching snapshots mid-flight cannot clear rules on the wrong snapshot.
  const ctx = shareRequestCtx();
  if (!ctx || !ctx.token) return;
  if (!shareState.loaded) { toast("快照详情尚未加载完成，请稍候再操作"); return; }
  if (!confirm("清除该快照的全部作答开放规则（开始时间、截止时间、新建会话上限）？清除后将不限制新建作答。")) return;
  const btn = $("#ruleClear");
  btn.disabled = true;
  $("#ruleSave").disabled = true;
  $("#ruleStatus").innerHTML = `<span class="rule-loading">正在清除开放规则…</span>`;
  try {
    const r = await api(`/api/share/${encodeURIComponent(ctx.token)}/rules`, {
      method: "PUT",
      body: { open_started_at: null, open_deadline_at: null, max_new_runs: null },
    });
    if (isCurrentShareCtx(ctx)) {
      fillRuleFields(r);
      toast("已清除全部开放规则，当前不限制新建作答");
    } else {
      toast(`已清除提交时所选快照（${ctx.token.slice(0, 6)}…）的开放规则`);
    }
    await Promise.all([
      renderRuleStatus(ctx),
      refreshSharePick(state.currentId, false),
    ]);
  } catch (err) {
    if (isCurrentShareCtx(ctx)) {
      toast("清除失败：" + err.message, 3500);
      await renderRuleStatus(ctx);
    } else {
      toast("原快照规则清除失败：" + err.message, 3500);
    }
  } finally {
    if (isCurrentShareCtx(ctx) && shareState.loaded) setShareRulesLocked(false);
  }
}

async function loadInvites(ctx = shareRequestCtx()) {
  const statusEl = $("#inviteStatus"), codesEl = $("#inviteCodes");
  if (!ctx || !ctx.token) return;
  try {
    const r = await api(`/api/share/${encodeURIComponent(ctx.token)}/invites`);
    // Late response from a previously selected snapshot: never render it.
    if (!isCurrentShareCtx(ctx)) return;
    renderInvites(r, statusEl, codesEl);
  } catch (err) {
    if (!isCurrentShareCtx(ctx)) return;
    statusEl.innerHTML = `<span class="invite-err">邀请码状态加载失败：${esc(err.message)}</span>`;
    codesEl.innerHTML = "";
  }
}

function renderInvites(r, statusEl, codesEl) {
  $("#inviteGen").textContent = r.invite_only ? "再生成一批" : "开启邀请制并生成";
  if (!r.invite_only) {
    statusEl.innerHTML = `<span class="invite-off">当前为<b>公开分享</b>，受访者打开链接即可直接开始；尚未生成邀请码。</span>`;
    codesEl.innerHTML = "";
    return;
  }
  statusEl.innerHTML =
    `<span class="invite-on">🎫 邀请制已开启</span>
     <span class="invite-counts">共 <b>${r.total}</b> 个 ·
       <b class="invite-used">已用 ${r.used_count}</b> ·
       <b class="invite-unused">未用 ${r.unused_count}</b></span>`;
  if (!r.codes.length) { codesEl.innerHTML = ""; return; }
  codesEl.innerHTML = r.codes.map((c) => `
    <div class="invite-code ${c.used ? "used" : ""}" title="${c.used ? "已使用" + (c.used_at ? " · " + c.used_at.replace("T", " ").slice(0, 16) : "") : "未使用，点击可复制"}">
      <code>${esc(c.code)}</code>
      <span class="invite-state">${c.used ? "已用" : "未用"}</span>
    </div>`).join("");
  codesEl.querySelectorAll(".invite-code:not(.used)").forEach((el) => {
    el.onclick = () => copyText(el.querySelector("code").textContent)
      .then((ok) => toast(ok ? "邀请码已复制" : "复制失败，请手动选择复制"));
  });
}

async function generateInvites() {
  // Bind generation to the snapshot shown when the button was clicked; the
  // response must not be rendered after switching to another snapshot.
  const ctx = shareRequestCtx();
  if (!ctx || !ctx.token) return;
  if (!shareState.loaded) { toast("快照详情尚未加载完成，请稍候再操作"); return; }
  const count = Math.max(1, Math.min(500, Number($("#inviteCount").value) || 0));
  if (count < 1) { toast("请输入 1～500 的数量"); return; }
  if (isCurrentShareCtx(ctx)) $("#inviteCount").value = count;
  const btn = $("#inviteGen");
  btn.disabled = true;
  try {
    const r = await api(`/api/share/${encodeURIComponent(ctx.token)}/invites`,
      { method: "POST", body: { count } });
    if (isCurrentShareCtx(ctx)) {
      renderInvites(r, $("#inviteStatus"), $("#inviteCodes"));
      toast(`已生成 ${r.created.length} 个邀请码（未用 ${r.unused_count} / 共 ${r.total}）`);
    } else {
      toast(`已为提交时所选快照（${ctx.token.slice(0, 6)}…）生成邀请码`);
    }
  } catch (err) {
    if (isCurrentShareCtx(ctx)) toast("生成失败：" + err.message, 3500);
    else toast("原快照邀请码生成失败：" + err.message, 3500);
  } finally {
    if (isCurrentShareCtx(ctx)) btn.disabled = false;
  }
}

let runId = null;
async function openPreview() {
  if (!state.currentId) return;
  if (state.dirty) await saveScript();
  const r = await api("/api/runs", { method: "POST", body: { script_id: state.currentId } });
  runId = r.run_id;
  renderRun(r);
  openModal("previewModal");
}

function renderRun(r) {
  const node = r.current_node;
  const card = $("#previewCard");
  if (r.finished || node.terminal || !(node.options || []).length) {
    card.innerHTML = `
      <div class="q-card">
        <div class="q-title">${esc(node.title)}</div>
        <div class="q-text">${esc(node.text)}</div>
        <div class="end">— 访谈结束 —</div>
      </div>`;
  } else {
    card.innerHTML = `
      <div class="q-card">
        <div class="q-title">${esc(node.title)}</div>
        <div class="q-text">${esc(node.text)}</div>
        <div class="choices">
          ${node.options.map((o) =>
            `<button data-oid="${o.id}" ${o.target_id ? "" : "disabled"}>
               ${esc(o.label)}${o.target_id ? "" : "（未连接，不可选）"}
             </button>`).join("")}
        </div>
      </div>`;
    card.querySelectorAll("button[data-oid]").forEach((b) => {
      b.onclick = async () => {
        const nr = await api(`/api/runs/${runId}/choice`, {
          method: "POST", body: { option_id: b.dataset.oid } });
        renderRun(nr);
      };
    });
  }
  $("#runPath").innerHTML = r.steps.map((s, i) => `
    <div class="path-step">
      ${i + 1}. ${esc(s.title || s.node_id)}
      ${s.answer ? `<div class="ans">↳ 回答：${esc(s.answer)}</div>` : ""}
    </div>`).join("");
}

$("#runRestart").onclick = async () => {
  if (!runId) return;
  const r = await api(`/api/runs/${runId}/restart`, { method: "POST" });
  renderRun(r);
};

// Closing the preview modal (✕ button, "关闭", ESC or mask click) refreshes the
// branch coverage stats so newly recorded choices are reflected immediately.
function bindCoverageAutoRefresh() {
  new MutationObserver(async () => {
    if (document.getElementById("previewModal").classList.contains("open")) return;
    if (!state.currentId) return;
    await loadCoverage();
    renderInspector();
  }).observe(document.getElementById("previewModal"), { attributes: true, attributeFilter: ["class"] });
}

// ---------------------------------------------------------------- canvas interaction

function toWorld(clientX, clientY) {
  const rect = $("#canvasWrap").getBoundingClientRect();
  return { x: clientX - rect.left - state.pan.x, y: clientY - rect.top - state.pan.y };
}

function bindCanvas() {
  const wrap = $("#canvasWrap");

  // pan
  let panning = null;
  wrap.addEventListener("mousedown", (e) => {
    if (e.target.closest(".node") || e.target.closest("path.edge")) return;
    panning = { x: e.clientX - state.pan.x, y: e.clientY - state.pan.y };
    e.preventDefault();
  });

  // node selection + edge selection
  wrap.addEventListener("click", (e) => {
    if (state.suppressClick) { state.suppressClick = false; return; }
    const edge = e.target.closest("path.edge");
    if (edge) {
      state.selectedEdge = { nodeId: edge.dataset.node, optionId: edge.dataset.opt };
      state.selectedNodeId = null;
      drawEdges(); renderInspector();
      return;
    }
    const nodeEl = e.target.closest(".node");
    if (nodeEl) {
      state.selectedNodeId = nodeEl.dataset.id;
      state.selectedEdge = null;
      drawNodes(); drawEdges(); renderInspector();
    } else if (!state.connecting) {
      state.selectedNodeId = null;
      state.selectedEdge = null;
      drawEdges(); renderInspector();
    }
  });

  document.addEventListener("mousemove", (e) => {
    if (panning) {
      state.pan = { x: e.clientX - panning.x, y: e.clientY - panning.y };
      $("#world").style.transform = `translate(${state.pan.x}px, ${state.pan.y}px)`;
    }
    if (state.dragNode) {
      const n = getNode(state.dragNode.id);
      n.x = state.dragNode.x + e.clientX - state.dragNode.startX;
      n.y = state.dragNode.y + e.clientY - state.dragNode.startY;
      const el = document.getElementById(`node-${n.id}`);
      el.style.left = `${n.x}px`; el.style.top = `${n.y}px`;
      drawEdges(); syncDirty();
      state.dragNode.moved = true;
    }
    if (state.connecting) {
      const w = toWorld(e.clientX, e.clientY);
      const c = state.connecting;
      const from = portPoint(c.nodeId, c.optionId);
      const temp = $("#tempEdge");
      temp.style.display = "block";
      temp.setAttribute("d", `M ${from.x} ${from.y} L ${w.x} ${w.y}`);
    }
  });

  document.addEventListener("mouseup", (e) => {
    panning = null;
    if (state.dragNode) {
      const wasMoved = state.dragNode.moved;
      if (wasMoved) state.suppressClick = true;
      // a whole drag counts as a single undo step; skip it if position is unchanged
      const n = getNode(state.dragNode.id);
      if (wasMoved && n && (n.x !== state.dragNode.x || n.y !== state.dragNode.y)) {
        pushHistory();
        clearTimeout(validateTimer);
        validateTimer = setTimeout(validateLocal, 150);
      } else {
        // click without movement (or dragged back to origin): reconcile dirty badge
        syncDirty();
      }
      state.dragNode = null;
    }
    if (state.connecting) {
      const temp = $("#tempEdge");
      temp.style.display = "none";
      temp.removeAttribute("d");
      const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest(".node");
      if (targetEl) {
        const n = getNode(state.connecting.nodeId);
        const o = n.options.find((x) => x.id === state.connecting.optionId);
        o.target_id = targetEl.dataset.id;
        changed();
      }
      state.connecting = null;
      $("#connectingTip").style.display = "none";
    }
  });

  // node drag (header) + port connect (delegated)
  wrap.addEventListener("mousedown", (e) => {
    const head = e.target.closest("[data-drag]");
    if (head) {
      const id = head.dataset.drag;
      const n = getNode(id);
      state.dragNode = { id, x: n.x, y: n.y, startX: e.clientX, startY: e.clientY, moved: false };
      e.preventDefault();
      return;
    }
    const port = e.target.closest(".port");
    if (port) {
      state.connecting = { nodeId: port.dataset.node, optionId: port.dataset.opt };
      $("#connectingTip").style.display = "block";
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

// ---------------------------------------------------------------- boot

(async function init() {
  bindToolbar();
  bindCanvas();
  bindCoverageAutoRefresh();
  $("#funnelBody").addEventListener("click", onFunnelRowClick);
  await loadList();
  if (!state.scripts.length) await newScript(true);
})();
