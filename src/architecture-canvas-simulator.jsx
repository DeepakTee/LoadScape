import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import {
  Monitor, Shuffle, Server, Zap, Database as DatabaseIcon,
  Trash2, Plus, X, Copy, Info, AlertTriangle
} from "lucide-react";

// ============================== Constants ==============================

const NODE_W = 168;
const NODE_H = 68;
const CANVAS_W = 1160;
const CANVAS_H = 560;

const TYPE_META = {
  client: { label: "Client", icon: "monitor" },
  loadbalancer: { label: "Load Balancer", icon: "shuffle" },
  appserver: { label: "App Server", icon: "server" },
  cache: { label: "Cache", icon: "zap" },
  database: { label: "Database", icon: "database" },
};

const TYPE_DEFAULTS = {
  client: {},
  loadbalancer: { capacity: 200000, baseLatencyMs: 1 },
  appserver: { instances: 3, capacityPerInstance: 2000, baseLatencyMs: 8 },
  cache: { hitRatio: 0.85, capacityOps: 60000, baseLatencyMs: 1 },
  database: { capacityQPS: 5000, connectionLimit: 500, avgQueryMs: 2, baseLatencyMs: 5 },
};

const PARAM_DEFS = {
  client: [],
  loadbalancer: [
    { key: "capacity", label: "Capacity", step: 1000, suffix: "rps", desc: "Max throughput this component can forward before it queues requests." },
    { key: "baseLatencyMs", label: "Base latency", step: 0.5, suffix: "ms", desc: "Overhead added when routing through this component, unloaded." },
  ],
  appserver: [
    { key: "instances", label: "Instances", step: 1, min: 1, suffix: "", desc: "Number of parallel machines/processes running this tier." },
    { key: "capacityPerInstance", label: "Capacity / instance", step: 100, suffix: "rps", desc: "Max requests per second one instance can serve before queueing." },
    { key: "baseLatencyMs", label: "Base latency", step: 0.5, suffix: "ms", desc: "Processing time per request when not under load." },
  ],
  cache: [
    { key: "hitRatio", label: "Hit ratio", step: 0.01, min: 0, max: 0.999, suffix: "", desc: "Fraction of requests answered from cache without reaching the database." },
    { key: "capacityOps", label: "Capacity", step: 1000, suffix: "ops/s", desc: "Max operations per second the cache cluster can serve." },
    { key: "baseLatencyMs", label: "Base latency", step: 0.1, suffix: "ms", desc: "Round-trip time for a cache lookup, unloaded." },
  ],
  database: [
    { key: "capacityQPS", label: "QPS capacity", step: 500, suffix: "qps", desc: "Max queries per second the database can execute." },
    { key: "connectionLimit", label: "Connection limit", step: 50, suffix: "", desc: "Max simultaneous connections allowed." },
    { key: "avgQueryMs", label: "Avg query time", step: 0.5, suffix: "ms", desc: "Avg time a connection is held per query — sets how fast the pool cycles." },
    { key: "baseLatencyMs", label: "Base latency", step: 0.5, suffix: "ms", desc: "Query response time when not under load." },
  ],
};

const PALETTE = ["#3fd0c9", "#f0a24a", "#e5484d", "#7aa2f7", "#c792ea", "#82c99a"];

// ============================== Pure simulation engine ==============================

function passRatio(node) {
  if (node.type === "cache") return 1 - (node.params.hitRatio ?? 0);
  return 1;
}
function capacityOf(node) {
  switch (node.type) {
    case "appserver": return node.params.instances * node.params.capacityPerInstance;
    case "cache": return node.params.capacityOps;
    case "database": return Math.min(node.params.capacityQPS, node.params.connectionLimit / (node.params.avgQueryMs / 1000));
    case "loadbalancer": return node.params.capacity ?? Infinity;
    default: return Infinity;
  }
}
function baseLatencyOf(node) { return node.params.baseLatencyMs ?? 1; }

function utilLatency(incoming, capacity, baseLatencyMs) {
  const utilization = capacity > 0 && isFinite(capacity) ? incoming / capacity : 0;
  let latency;
  if (utilization < 0.7) latency = baseLatencyMs;
  else if (utilization < 0.95) latency = baseLatencyMs / (1 - utilization);
  else latency = baseLatencyMs * 40 * Math.min(utilization, 2);
  return { utilization, latency };
}

function simulate(nodes, edges, rps) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const outEdges = {}, inEdges = {};
  nodes.forEach((n) => { outEdges[n.id] = []; inEdges[n.id] = []; });
  edges.forEach((e) => { if (outEdges[e.from] && inEdges[e.to]) { outEdges[e.from].push(e); inEdges[e.to].push(e); } });

  const indeg = {}; nodes.forEach((n) => (indeg[n.id] = inEdges[n.id].length));
  const q = nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id);
  const order = []; const indegCopy = { ...indeg };
  while (q.length) {
    const id = q.shift();
    order.push(id);
    outEdges[id].forEach((e) => { indegCopy[e.to]--; if (indegCopy[e.to] === 0) q.push(e.to); });
  }
  nodes.forEach((n) => { if (!order.includes(n.id)) order.push(n.id); });

  const incoming = {}, forward = {};
  nodes.forEach((n) => { incoming[n.id] = 0; forward[n.id] = 0; });

  order.forEach((id) => {
    const node = byId[id];
    if (node.type === "client") {
      incoming[id] = rps;
      forward[id] = rps;
    } else {
      let sum = 0;
      inEdges[id].forEach((e) => {
        const srcOut = outEdges[e.from].length || 1;
        sum += (forward[e.from] || 0) / srcOut;
      });
      incoming[id] = sum;
      forward[id] = sum * passRatio(node);
    }
  });

  const edgeTraffic = {};
  edges.forEach((e) => {
    const srcOut = outEdges[e.from].length || 1;
    edgeTraffic[e.id] = (forward[e.from] || 0) / srcOut;
  });

  const results = {};
  let maxUtil = 0, bottleneckId = null;
  nodes.forEach((n) => {
    if (n.type === "client") { results[n.id] = { utilization: 0, latency: 0, incoming: incoming[n.id], capacity: Infinity }; return; }
    const cap = capacityOf(n);
    const { utilization, latency } = utilLatency(incoming[n.id], cap, baseLatencyOf(n));
    results[n.id] = { utilization, latency, incoming: incoming[n.id], capacity: cap };
    if (utilization > maxUtil) { maxUtil = utilization; bottleneckId = n.id; }
  });

  let totalLatency = 0;
  nodes.forEach((n) => {
    if (n.type === "client") return;
    const frac = rps > 0 ? Math.min(incoming[n.id] / rps, 1) : 0;
    totalLatency += results[n.id].latency * frac;
  });

  return { results, edgeTraffic, maxUtil, bottleneckId, totalLatency };
}

function maxSustainableRPS(nodes, edges) {
  let hi = 4000;
  for (let i = 0; i < 20; i++) {
    const { maxUtil } = simulate(nodes, edges, hi);
    if (maxUtil < 1) hi *= 2; else break;
  }
  let lo = 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const { maxUtil } = simulate(nodes, edges, mid);
    if (maxUtil <= 1) lo = mid; else hi = mid;
  }
  return lo;
}

function buildCurve(nodes, edges, maxRange, steps = 36) {
  const plotNodes = nodes.filter((n) => n.type !== "client");
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const rps = Math.round((maxRange / steps) * i);
    const { results } = simulate(nodes, edges, rps);
    const row = { rps };
    plotNodes.forEach((n) => { row[n.id] = Math.min((results[n.id]?.utilization || 0) * 100, 200); });
    pts.push(row);
  }
  return pts;
}

// ============================== Small helpers ==============================

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const fmt = (n) => Math.round(n).toLocaleString();
const statusColor = (u) => (u < 0.7 ? "#3fd0c9" : u < 0.95 ? "#f0a24a" : "#e5484d");
const statusLabel = (u) => (u < 0.7 ? "healthy" : u < 0.95 ? "under pressure" : "saturated");

function rectBorderPoint(cx, cy, halfW, halfH, dirX, dirY) {
  if (dirX === 0 && dirY === 0) return { x: cx, y: cy };
  const scaleX = dirX !== 0 ? halfW / Math.abs(dirX) : Infinity;
  const scaleY = dirY !== 0 ? halfH / Math.abs(dirY) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dirX * scale, y: cy + dirY * scale };
}

function IconFor({ type, size = 16, color }) {
  const props = { size, color, strokeWidth: 2 };
  if (type === "monitor") return <Monitor {...props} />;
  if (type === "shuffle") return <Shuffle {...props} />;
  if (type === "server") return <Server {...props} />;
  if (type === "zap") return <Zap {...props} />;
  if (type === "database") return <DatabaseIcon {...props} />;
  return null;
}

function NumberField({ label, value, onChange, step = 1, min, max, suffix, desc }) {
  return (
    <div className="pfield">
      <div className="pfield-row">
        <span className="pfield-label">{label}</span>
        <div className="pfield-input-wrap">
          <input
            type="number" className="pfield-input" value={value} step={step} min={min} max={max}
            onChange={(e) => {
              let v = parseFloat(e.target.value); if (isNaN(v)) v = 0;
              if (min !== undefined) v = Math.max(min, v);
              if (max !== undefined) v = Math.min(max, v);
              onChange(v);
            }}
          />
          {suffix ? <span className="pfield-suffix">{suffix}</span> : null}
        </div>
      </div>
      {desc && <div className="pfield-desc">{desc}</div>}
    </div>
  );
}

// ============================== Main component ==============================

export default function ArchitectureCanvasSimulator() {
  const idCounter = useRef(100);
  const genId = (prefix) => `${prefix}${++idCounter.current}`;

  const [nodes, setNodes] = useState(() => ([
    { id: "n1", type: "client", label: "Client", x: 30, y: 260, params: { ...TYPE_DEFAULTS.client } },
    { id: "n2", type: "appserver", label: "App Server", x: 290, y: 260, params: { ...TYPE_DEFAULTS.appserver } },
    { id: "n3", type: "cache", label: "Cache", x: 560, y: 260, params: { ...TYPE_DEFAULTS.cache } },
    { id: "n4", type: "database", label: "Database", x: 830, y: 260, params: { ...TYPE_DEFAULTS.database } },
  ]));
  const [edges, setEdges] = useState(() => ([
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n3" },
    { id: "e3", from: "n3", to: "n4" },
  ]));

  const [rps, setRps] = useState(20000);
  const [maxRange, setMaxRange] = useState(80000);
  const [selectedId, setSelectedId] = useState(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [tempLine, setTempLine] = useState(null);

  const containerRef = useRef(null);
  const dragRef = useRef(null);

  const sim = useMemo(() => simulate(nodes, edges, rps), [nodes, edges, rps]);
  const maxSustain = useMemo(() => maxSustainableRPS(nodes, edges), [nodes, edges]);
  const curve = useMemo(() => buildCurve(nodes, edges, maxRange), [nodes, edges, maxRange]);

  const selectedNode = nodes.find((n) => n.id === selectedId) || null;
  const overallColor = sim.bottleneckId ? statusColor(sim.results[sim.bottleneckId].utilization) : "#3fd0c9";

  // ---- drag / connect handling ----
  useEffect(() => {
    function onMove(e) {
      const ds = dragRef.current;
      if (!ds || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (ds.mode === "node") {
        setNodes((prev) => prev.map((n) => (n.id === ds.id ? { ...n, x: clamp(x - ds.offsetX, 0, CANVAS_W - NODE_W), y: clamp(y - ds.offsetY, 0, CANVAS_H - NODE_H) } : n)));
      } else if (ds.mode === "connect") {
        setTempLine({ x1: ds.startX, y1: ds.startY, x2: x, y2: y });
      }
    }
    function onUp(e) {
      const ds = dragRef.current;
      if (ds && ds.mode === "connect" && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const target = nodes.find((n) => n.id !== ds.sourceId && x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H);
        if (target) {
          setEdges((prev) => (prev.some((ed) => ed.from === ds.sourceId && ed.to === target.id) ? prev : [...prev, { id: genId("e"), from: ds.sourceId, to: target.id }]));
        }
      }
      setTempLine(null);
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [nodes]);

  function startNodeDrag(e, node) {
    e.stopPropagation();
    setSelectedId(node.id);
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    dragRef.current = { mode: "node", id: node.id, offsetX: x - node.x, offsetY: y - node.y };
  }

  function startConnect(e, node, side) {
    e.stopPropagation();
    const anchors = {
      top: { x: node.x + NODE_W / 2, y: node.y },
      bottom: { x: node.x + NODE_W / 2, y: node.y + NODE_H },
      left: { x: node.x, y: node.y + NODE_H / 2 },
      right: { x: node.x + NODE_W, y: node.y + NODE_H / 2 },
    };
    const a = anchors[side];
    dragRef.current = { mode: "connect", sourceId: node.id, startX: a.x, startY: a.y };
    setTempLine({ x1: a.x, y1: a.y, x2: a.x, y2: a.y });
  }

  function addComponent(type) {
    const count = nodes.length;
    const id = genId("n");
    const x = 40 + (count % 5) * 200;
    const y = 40 + Math.floor(count / 5) * 150;
    setNodes((prev) => [...prev, { id, type, label: TYPE_META[type].label, x, y, params: { ...TYPE_DEFAULTS[type] } }]);
    setSelectedId(id);
  }

  function addReplica(nodeId) {
    const orig = nodes.find((n) => n.id === nodeId);
    if (!orig) return;
    const newId = genId("n");
    setNodes((prev) => [...prev, { ...orig, id: newId, x: clamp(orig.x + 24, 0, CANVAS_W - NODE_W), y: clamp(orig.y + 96, 0, CANVAS_H - NODE_H), label: orig.label + " (replica)", params: { ...orig.params } }]);
    setEdges((prev) => {
      const added = [];
      prev.forEach((e) => {
        if (e.to === nodeId) added.push({ id: genId("e"), from: e.from, to: newId });
        if (e.from === nodeId) added.push({ id: genId("e"), from: newId, to: e.to });
      });
      return [...prev, ...added];
    });
    setSelectedId(newId);
  }

  function deleteNode(nodeId) {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) => prev.filter((e) => e.from !== nodeId && e.to !== nodeId));
    setSelectedId(null);
  }

  function updateParam(nodeId, key, value) {
    setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n)));
  }

  return (
    <div className="sim-root" onPointerDown={() => setSelectedId(null)}>
      <style>{`
        .sim-root {
          --bg:#0a0d12; --panel:#12161d; --panel-2:#161b23; --border:#232a35;
          --text:#e7eaee; --text-dim:#8b94a3; --text-faint:#565f6e;
          --ok:#3fd0c9; --warn:#f0a24a; --crit:#e5484d;
          --mono:'IBM Plex Mono','SF Mono',Menlo,Consolas,monospace;
          --sans:'Inter',-apple-system,system-ui,sans-serif;
          background:var(--bg); color:var(--text); font-family:var(--sans);
          border-radius:16px; padding:24px; box-sizing:border-box;
        }
        .sim-root * { box-sizing:border-box; }
        .header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
        .header h1 { font-family:var(--mono); font-size:14px; font-weight:600; letter-spacing:0.03em; margin:0; text-transform:uppercase; }
        .btn {
          display:inline-flex; align-items:center; gap:6px; background:var(--panel-2); border:1px solid var(--border);
          color:var(--text); font-family:var(--mono); font-size:11.5px; padding:6px 10px; border-radius:7px; cursor:pointer;
        }
        .btn:hover { border-color:var(--ok); }
        .btn.ghost { background:transparent; }
        .toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
        .toolbar-label { font-size:10.5px; color:var(--text-faint); font-family:var(--mono); text-transform:uppercase; letter-spacing:0.05em; margin-right:4px; }
        .summary-bar { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--border); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:14px; }
        .summary-cell { background:var(--panel); padding:12px 16px; }
        .summary-label { font-size:10px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.05em; font-family:var(--mono); margin-bottom:4px; }
        .summary-value { font-family:var(--mono); font-size:18px; font-weight:600; }
        .rps-control { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:12px 16px; margin-bottom:14px; }
        .rps-top { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; }
        .rps-label { font-size:10.5px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.05em; font-family:var(--mono); }
        .rps-value { font-family:var(--mono); font-size:19px; font-weight:700; }
        input[type=range] { width:100%; accent-color:var(--ok); height:4px; }
        .canvas-wrap {
          position:relative; width:100%; height:${CANVAS_H}px; overflow:auto; border:1px solid var(--border);
          border-radius:10px; background:
            radial-gradient(circle, #1b212b 1px, transparent 1px) 0 0/20px 20px, var(--panel);
        }
        .canvas-inner { position:relative; width:${CANVAS_W}px; height:${CANVAS_H}px; }
        .canvas-node {
          position:absolute; width:${NODE_W}px; height:${NODE_H}px; background:var(--panel-2);
          border:1.5px solid var(--node-color, var(--border)); border-radius:10px; cursor:grab; user-select:none;
          padding:9px 10px; touch-action:none;
        }
        .canvas-node.selected { box-shadow:0 0 0 2px var(--ok); }
        .canvas-node:active { cursor:grabbing; }
        .cn-top { display:flex; align-items:center; gap:7px; margin-bottom:4px; }
        .cn-icon { width:22px; height:22px; border-radius:6px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .cn-label { font-size:12.5px; font-weight:600; line-height:1.2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .cn-sub { font-size:9.5px; color:var(--text-dim); text-transform:capitalize; font-family:var(--mono); }
        .cn-pct { position:absolute; top:8px; right:9px; font-family:var(--mono); font-size:12px; font-weight:700; color:var(--node-color); }
        .cn-bar-track { position:absolute; left:10px; right:10px; bottom:8px; height:3px; background:var(--border); border-radius:2px; overflow:hidden; }
        .cn-bar-fill { height:100%; background:var(--node-color); }
        .handle { position:absolute; width:10px; height:10px; border-radius:50%; background:var(--panel); border:2px solid var(--text-faint); opacity:0; transition:opacity .12s; cursor:crosshair; }
        .canvas-node:hover .handle { opacity:1; }
        .handle:hover { border-color:var(--ok); background:var(--ok); }
        .handle.top { top:-6px; left:${NODE_W / 2 - 5}px; }
        .handle.bottom { bottom:-6px; left:${NODE_W / 2 - 5}px; }
        .handle.left { left:-6px; top:${NODE_H / 2 - 5}px; }
        .handle.right { right:-6px; top:${NODE_H / 2 - 5}px; }
        .quick-add {
          position:absolute; top:-9px; right:-9px; width:20px; height:20px; border-radius:50%;
          background:var(--crit); border:2px solid var(--bg); color:#fff; display:flex; align-items:center; justify-content:center;
          cursor:pointer; animation:pulse 1.6s ease-in-out infinite;
        }
        @keyframes pulse { 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.15); } }
        .edges-layer { position:absolute; top:0; left:0; pointer-events:none; }
        .edge-label { font-family:var(--mono); font-size:9.5px; fill:var(--text-dim); paint-order:stroke; stroke:var(--panel); stroke-width:3px; }
        .lower-grid { display:grid; grid-template-columns:1fr 300px; gap:16px; margin-top:16px; align-items:start; }
        @media (max-width:820px) { .lower-grid { grid-template-columns:1fr; } }
        .chart-card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
        .chart-title { font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-dim); margin-bottom:8px; display:flex; justify-content:space-between; }
        .range-input { width:80px; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--mono); font-size:11px; padding:3px 6px; text-align:right; }
        .inspector { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
        .inspector-empty { color:var(--text-faint); font-size:12px; text-align:center; padding:30px 10px; }
        .inspector-head { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
        .name-input { background:var(--panel-2); border:1px solid var(--border); border-radius:6px; color:var(--text); font-size:13px; font-weight:600; padding:6px 8px; width:100%; }
        .status-pill { display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11px; padding:3px 8px; border-radius:12px; margin-top:8px; }
        .pfield { margin-top:12px; }
        .pfield-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        .pfield-label { font-size:11.5px; color:var(--text-dim); }
        .pfield-input-wrap { display:flex; align-items:center; gap:4px; }
        .pfield-input { width:76px; background:var(--panel-2); border:1px solid var(--border); border-radius:6px; color:var(--text); font-family:var(--mono); font-size:12px; padding:5px 6px; text-align:right; }
        .pfield-suffix { font-size:10px; color:var(--text-faint); width:26px; }
        .pfield-desc { font-size:10.5px; color:var(--text-faint); margin-top:3px; line-height:1.4; }
        .inspector-actions { display:flex; gap:8px; margin-top:16px; }
        .legend-overlay { position:absolute; inset:0; background:rgba(6,8,11,0.72); display:flex; align-items:center; justify-content:center; z-index:10; border-radius:16px; }
        .legend-panel { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:22px 24px; max-width:560px; width:90%; max-height:80%; overflow:auto; }
        .legend-panel h2 { font-family:var(--mono); font-size:13px; text-transform:uppercase; letter-spacing:0.04em; margin:0 0 14px; display:flex; justify-content:space-between; align-items:center; }
        .legend-section { margin-bottom:18px; }
        .legend-section h3 { font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.05em; font-family:var(--mono); margin:0 0 8px; }
        .legend-row2 { display:flex; align-items:center; gap:10px; margin-bottom:7px; font-size:12.5px; }
        .legend-dot2 { width:10px; height:10px; border-radius:3px; flex-shrink:0; }
        .legend-glossary-group { margin-bottom:12px; }
        .legend-glossary-group b { font-size:12px; }
        .legend-glossary-item { font-size:11.5px; color:var(--text-dim); margin:3px 0 3px 4px; line-height:1.4; }
        .legend-glossary-item strong { color:var(--text); }
      `}</style>

      <div className="header">
        <h1>Architecture Capacity Simulator</h1>
        <button className="btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => setLegendOpen(true)}><Info size={13} /> Legend</button>
      </div>

      <div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="toolbar-label">Add component</span>
        {Object.entries(TYPE_META).map(([type, meta]) => (
          <button key={type} className="btn" onClick={() => addComponent(type)}>
            <IconFor type={meta.icon} size={12} color="#8b94a3" /> {meta.label}
          </button>
        ))}
      </div>

      <div className="summary-bar">
        <div className="summary-cell">
          <div className="summary-label">Max Sustainable Throughput</div>
          <div className="summary-value">{fmt(maxSustain)} rps</div>
        </div>
        <div className="summary-cell">
          <div className="summary-label">Bottleneck at {fmt(rps)} rps</div>
          <div className="summary-value" style={{ color: overallColor }}>
            {sim.bottleneckId ? nodes.find((n) => n.id === sim.bottleneckId)?.label : "—"}
          </div>
        </div>
        <div className="summary-cell">
          <div className="summary-label">Estimated P99 Latency</div>
          <div className="summary-value" style={{ color: overallColor }}>
            {sim.totalLatency < 1000 ? `${sim.totalLatency.toFixed(1)}ms` : `${(sim.totalLatency / 1000).toFixed(2)}s`}
          </div>
        </div>
      </div>

      <div className="rps-control" onPointerDown={(e) => e.stopPropagation()}>
        <div className="rps-top">
          <span className="rps-label">Incoming traffic (from Client)</span>
          <span className="rps-value">{fmt(rps)} <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 400 }}>rps</span></span>
        </div>
        <input type="range" min={0} max={maxRange} step={Math.max(1, Math.round(maxRange / 500))} value={rps} onChange={(e) => setRps(parseInt(e.target.value))} />
      </div>

      <div className="canvas-wrap" ref={containerRef} style={{ position: "relative" }}>
        <div className="canvas-inner">
          <svg className="edges-layer" width={CANVAS_W} height={CANVAS_H}>
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#4b5568" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const src = nodes.find((n) => n.id === edge.from);
              const tgt = nodes.find((n) => n.id === edge.to);
              if (!src || !tgt) return null;
              const scx = src.x + NODE_W / 2, scy = src.y + NODE_H / 2;
              const tcx = tgt.x + NODE_W / 2, tcy = tgt.y + NODE_H / 2;
              const dx = tcx - scx, dy = tcy - scy;
              const len = Math.hypot(dx, dy) || 1;
              const start = rectBorderPoint(scx, scy, NODE_W / 2, NODE_H / 2, dx / len, dy / len);
              const end = rectBorderPoint(tcx, tcy, NODE_W / 2, NODE_H / 2, -dx / len, -dy / len);
              const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
              const traffic = sim.edgeTraffic[edge.id] || 0;
              return (
                <g key={edge.id}>
                  <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#4b5568" strokeWidth={1.5} markerEnd="url(#arrowhead)" />
                  <text x={mx} y={my - 6} textAnchor="middle" className="edge-label">{fmt(traffic)} rps</text>
                </g>
              );
            })}
            {tempLine && <line x1={tempLine.x1} y1={tempLine.y1} x2={tempLine.x2} y2={tempLine.y2} stroke="#3fd0c9" strokeWidth={1.5} strokeDasharray="4 3" />}
          </svg>

          {nodes.map((node) => {
            const r = sim.results[node.id] || { utilization: 0, latency: 0 };
            const color = node.type === "client" ? "#565f6e" : statusColor(r.utilization);
            const isSelected = selectedId === node.id;
            return (
              <div
                key={node.id}
                className={`canvas-node${isSelected ? " selected" : ""}`}
                style={{ left: node.x, top: node.y, "--node-color": color }}
                onPointerDown={(e) => startNodeDrag(e, node)}
              >
                <div className="cn-top">
                  <span className="cn-icon" style={{ background: color + "22" }}>
                    <IconFor type={TYPE_META[node.type].icon} size={13} color={color} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="cn-label">{node.label}</div>
                    {node.type !== "client" && <div className="cn-sub">{statusLabel(r.utilization)}</div>}
                  </div>
                </div>
                {node.type !== "client" && (
                  <>
                    <span className="cn-pct">{Math.round(Math.min(r.utilization, 9.99) * 100)}%</span>
                    <div className="cn-bar-track"><div className="cn-bar-fill" style={{ width: `${Math.min(r.utilization * 100, 100)}%` }} /></div>
                  </>
                )}
                <div className="handle top" onPointerDown={(e) => startConnect(e, node, "top")} />
                <div className="handle bottom" onPointerDown={(e) => startConnect(e, node, "bottom")} />
                <div className="handle left" onPointerDown={(e) => startConnect(e, node, "left")} />
                <div className="handle right" onPointerDown={(e) => startConnect(e, node, "right")} />
                {r.utilization >= 0.95 && (
                  <div className="quick-add" title="Add replica to relieve pressure" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); addReplica(node.id); }}>
                    <Plus size={12} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {legendOpen && (
          <div className="legend-overlay" onPointerDown={(e) => e.stopPropagation()}>
            <div className="legend-panel">
              <h2>Legend <button className="btn ghost" onClick={() => setLegendOpen(false)}><X size={14} /></button></h2>

              <div className="legend-section">
                <h3>Status colors</h3>
                <div className="legend-row2"><span className="legend-dot2" style={{ background: "#3fd0c9" }} /> Healthy — under 70% utilized</div>
                <div className="legend-row2"><span className="legend-dot2" style={{ background: "#f0a24a" }} /> Under pressure — 70–95% utilized, latency climbing</div>
                <div className="legend-row2"><span className="legend-dot2" style={{ background: "#e5484d" }} /> Saturated — over 95%, a red "+" appears to add a replica/instance</div>
              </div>

              <div className="legend-section">
                <h3>Graph</h3>
                <div className="legend-glossary-item">Arrows show request direction. The number on each arrow is the live requests/sec flowing along that connection at the current traffic level.</div>
                <div className="legend-glossary-item">Drag from the small dot on any node's edge to another node to connect them. Drag a node's body to reposition it.</div>
                <div className="legend-glossary-item">Click a node to edit its parameters, rename it, delete it, or duplicate it as a parallel replica.</div>
              </div>

              <div className="legend-section">
                <h3>Parameter glossary</h3>
                {Object.entries(PARAM_DEFS).filter(([t, defs]) => defs.length).map(([type, defs]) => (
                  <div className="legend-glossary-group" key={type}>
                    <b>{TYPE_META[type].label}</b>
                    {defs.map((d) => (
                      <div className="legend-glossary-item" key={d.key}><strong>{d.label}:</strong> {d.desc}</div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="lower-grid">
        <div className="chart-card">
          <div className="chart-title">
            <span>Utilization vs Traffic</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-faint)" }}>range max</span>
              <input className="range-input" type="number" step={5000} value={maxRange} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setMaxRange(Math.max(1000, parseInt(e.target.value) || 1000))} />
            </span>
          </div>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={curve} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="#1b212b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="rps" tick={{ fill: "#565f6e", fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v) => `${Math.round(v / 1000)}k`} axisLine={{ stroke: "#232a35" }} tickLine={false} />
              <YAxis tick={{ fill: "#565f6e", fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v) => `${v}%`} axisLine={false} tickLine={false} width={38} />
              <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                <div style={{ background: "#0e1218", border: "1px solid #232a35", borderRadius: 8, padding: "8px 10px", fontFamily: "monospace", fontSize: 11 }}>
                  <div style={{ color: "#8b94a3", marginBottom: 4 }}>{fmt(label)} rps</div>
                  {payload.map((p) => <div key={p.dataKey} style={{ color: p.color }}>{nodes.find((n) => n.id === p.dataKey)?.label}: {p.value.toFixed(0)}%</div>)}
                </div>
              ) : null} />
              <ReferenceLine y={100} stroke="#e5484d" strokeDasharray="4 4" strokeOpacity={0.5} />
              <ReferenceLine x={rps} stroke="#e7eaee" strokeOpacity={0.2} />
              {nodes.filter((n) => n.type !== "client").map((n, i) => (
                <Line key={n.id} type="monotone" dataKey={n.id} name={n.label} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="inspector" onPointerDown={(e) => e.stopPropagation()}>
          {!selectedNode ? (
            <div className="inspector-empty">Click a component to edit its parameters.</div>
          ) : (
            <>
              <div className="inspector-head">
                <span className="cn-icon" style={{ background: statusColor(sim.results[selectedNode.id]?.utilization || 0) + "22", width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <IconFor type={TYPE_META[selectedNode.type].icon} size={14} color={statusColor(sim.results[selectedNode.id]?.utilization || 0)} />
                </span>
                <input className="name-input" value={selectedNode.label} onChange={(e) => setNodes((prev) => prev.map((n) => (n.id === selectedNode.id ? { ...n, label: e.target.value } : n)))} />
              </div>

              {selectedNode.type !== "client" && (
                <span className="status-pill" style={{ background: statusColor(sim.results[selectedNode.id].utilization) + "22", color: statusColor(sim.results[selectedNode.id].utilization) }}>
                  {sim.results[selectedNode.id].utilization >= 0.95 && <AlertTriangle size={11} />}
                  {Math.round(sim.results[selectedNode.id].utilization * 100)}% utilized · {sim.results[selectedNode.id].latency.toFixed(1)}ms
                </span>
              )}

              {PARAM_DEFS[selectedNode.type].map((def) => (
                <NumberField
                  key={def.key} label={def.label} suffix={def.suffix} step={def.step} min={def.min} max={def.max} desc={def.desc}
                  value={selectedNode.params[def.key]}
                  onChange={(v) => updateParam(selectedNode.id, def.key, v)}
                />
              ))}

              <div className="inspector-actions">
                {selectedNode.type !== "client" && (
                  <button className="btn" onClick={() => addReplica(selectedNode.id)}><Copy size={12} /> Add replica</button>
                )}
                <button className="btn" style={{ color: "var(--crit)" }} onClick={() => deleteNode(selectedNode.id)}><Trash2 size={12} /> Delete</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
