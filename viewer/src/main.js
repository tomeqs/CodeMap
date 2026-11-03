import './styles.css';
import { Stage } from './scene/stage.js';
import { LabelLayer } from './scene/labels.js';
import { CodeModel, LEVELS, defaultEdgeKinds } from './data/model.js';
import { EDGE_KINDS, kindColor } from './data/palette.js';
import { GalaxyView } from './views/galaxy.js';
import { CityView } from './views/city.js';
import { LayeredView } from './views/layered.js';
import { ZoomView } from './views/zoom.js';
import { MatrixView } from './views/matrix.js';
import { computeLayers } from './data/layering.js';
import { buildMatrix } from './data/matrix.js';
import { buildDiGraph } from './data/di.js';
import { buildCallFlow, findEntryPoints } from './data/flow.js';
import { DetailsPanel } from './ui/details.js';
import { Sidebar, renderLegend } from './ui/sidebar.js';
import { clear, debounce, fmt, h, shortName } from './ui/dom.js';
import { ServerClient } from './data/server.js';
import { ProjectsScreen } from './ui/projects.js';
import { SequencePanel } from './ui/sequence.js';
import { host } from './data/host.js';
import { perf } from './perf/stats.js';
import { GraphIndex } from './data/graph-index.js';
import { checkWorker } from './layout/worker-layout.js';
import { layoutKind } from './layout/engine.js';
import { GlassesSession } from './xr/glasses.js';

const params = new URLSearchParams(location.search);
/**
 * Above this many units the layout is too slow to be pleasant: more when it runs on the GPU or in a worker
 * (the map stays responsive while it settles). `?maxUnits=` overrides it for benchmarks.
 */
const maxUnits = () => {
  const stage = window.codemap?.stage ?? {};
  const kind = layoutKind(Infinity, stage);
  return Number(params.get('maxUnits')) || { gpu: 100000, worker: 15000 }[kind] || 7000;
};
const NEXT_LEVEL = { project: 'namespace', namespace: 'type', type: 'member' };
/** Views that show one level of detail at a time (the level buttons apply). */
const LEVEL_VIEWS = new Set(['galaxy', 'layers', 'matrix']);
/** Rows of the dependency matrix: beyond this the names can't be read (and the cells are N²). */
const MATRIX_MAX = 400;

class App {
  constructor() {
    this.stage = new Stage(document.getElementById('stage'));
    this.labels = new LabelLayer(document.getElementById('labels'), this.stage);
    this.details = new DetailsPanel(document.getElementById('right'), this);
    this.sidebar = new Sidebar(this);
    this.sequence = new SequencePanel(this);
    this.tooltip = document.getElementById('tooltip');
    this.hud = document.getElementById('hud');
    this.legend = document.getElementById('legend');
    this.selection = null;
    this.pathPending = false;
    this.statusLine = '';
    this.perf = perf;
    /** AR glasses (side-by-side stereo); only in a browser, not in the editor's webview. */
    this.ar = new GlassesSession(this);
    this.hostIsEditor = !!host;
    this.stage.onFrame((dt) => this.view?.update(dt));
    this.stage.controls.addEventListener('start', () => {
      if (this.view) this.view.userMoved = true;
    });
    this.bindUi();
  }

  // ------------------------------------------------------------------ loading

  /**
   * Shows a graph. With `preserve` (live / background refresh) the current view, filters, camera,
   * layout and selection are kept and only the data changes.
   */
  load(doc, { preserve = false } = {}) {
    if (preserve && this.model && this.state) return this.reload(doc);
    const model = perf.time('model', () => new CodeModel(doc));
    this.view?.deactivate();
    // A new graph gets new views: free the GPU memory of the old ones.
    for (const view of [this.galaxy, this.city, this.layers, this.diView, this.flowView, this.zoomView, this.matrix]) view?.dispose();
    this.sequence.hide();
    this.model = model;
    this.entryPoints = null;
    this.galaxy = new GalaxyView(this.stage, model, this.labels);
    this.city = new CityView(this.stage, model, this.labels);
    this.layers = new LayeredView(this.stage, model, this.labels);
    this.diView = new LayeredView(this.stage, model, this.labels);
    this.flowView = new LayeredView(this.stage, model, this.labels);
    this.flowView.labelText = shortName;
    this.flowView.radiusScale = 2.4;
    this.zoomView = new ZoomView(this.stage, model, this.labels);
    this.zoomView.onUnitsChanged = () => this.onZoomUnits();
    this.matrix = new MatrixView(this.stage, model, this.labels);
    this.applyModelWords(model);

    const typeCount = model.nodes.filter((n) => n.level === 'type' && !n.external).length;
    this.state = {
      view: 'galaxy',
      level: typeCount <= maxUnits() ? 'type' : 'namespace',
      scope: null,
      colorMode: 'project',
      sizeMetric: 'loc',
      heightMetric: model.nodes.some((n) => n.metrics.complexity) ? 'complexity' : 'loc',
      footprintMetric: 'loc',
      edgeKinds: defaultEdgeKinds(model),
      hiddenProjects: new Set(),
      showExternal: false,
      showTests: true,
      minWeight: 1,
      labels: true,
      flowAll: false,
      particles: 1,
      autoRotate: false,
      allArcs: false,
      flowRoots: [],
      flowDepth: 8,
      matrixHeight: 'log',
      semantic: false,
    };

    document.getElementById('source-name').textContent = doc.source?.name ?? '';
    document.title = `CodeMap · ${doc.source?.name ?? ''}`;
    document.getElementById('welcome').classList.add('hidden');
    this.selection = null;
    this.details.hide();
    this.activateView();
    this.sidebar.render();
    perf.time('rebuild', () => this.rebuild());
    // ?ar=full|half: straight into AR glasses mode (bookmarks, tests).
    const ar = params.get('ar');
    if (!this.arRequested && (ar === 'full' || ar === 'half')) {
      this.arRequested = true;
      this.ar.start({ fullscreen: false, sbs: ar });
    }
  }

  /** The level buttons in the language's words (Types / Files…), and the DI view only when there is DI data. */
  applyModelWords(model) {
    for (const level of LEVELS) {
      const button = document.querySelector(`#level-toggle [data-level="${level}"]`);
      if (button) button.textContent = model.labels[level][1];
    }

    document.querySelector('#view-toggle [data-view="di"]').disabled = !model.doc.analysis?.di;
  }

  /** "types", "files"… for counts. */
  levelWord(level, count = 2) {
    const words = this.model.labels[level];
    return (words ? words[count === 1 ? 0 : 1] : level + 's').toLowerCase();
  }

  reload(doc) {
    const model = new CodeModel(doc);
    const typeIds = (m) => new Set(m.nodes.filter((n) => n.level === 'type' && !n.external).map((n) => n.id));
    const before = typeIds(this.model);
    const after = typeIds(model);
    const added = [...after].filter((id) => !before.has(id)).length;
    const removed = [...before].filter((id) => !after.has(id)).length;

    this.model = model;
    this.entryPoints = null;
    for (const view of [this.galaxy, this.city, this.layers, this.diView, this.flowView, this.zoomView, this.matrix]) view.model = model;
    this.applyModelWords(model);
    const s = this.state;
    if (s.view === 'di' && !model.doc.analysis?.di) {
      s.view = 'galaxy';
      this.activateView();
    }

    if (s.scope && !model.get(s.scope)) s.scope = null;
    s.flowRoots = s.flowRoots.filter((id) => model.get(id));
    for (const id of [...s.hiddenProjects]) if (!model.get(id)) s.hiddenProjects.delete(id);
    if (this.selection && !model.get(this.selection.nodeId)) {
      this.selection = null;
      this.details.hide();
    }

    for (const view of [this.galaxy, this.layers, this.diView, this.flowView, this.zoomView]) view.userMoved = true; // keep the camera where the user left it
    this.city.keepCamera = true;
    this.matrix.keepCamera = true;
    this.sidebar.render();
    this.rebuild();
    this.city.keepCamera = false;
    this.matrix.keepCamera = false;
    if (this.selection) this.details.show(model.get(this.selection.nodeId), this.selection.unitId ? model.get(this.selection.unitId)?.level : undefined);

    const changes = [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(' / ');
    const plural = this.levelWord('type', added + removed);
    this.toast(changes ? `Map updated: ${changes} ${plural}` : 'Map updated', 'info');
  }

  // ------------------------------------------------------------------ VS Code extension

  /** Inside the VS Code webview: the extension analyzes the workspace and drives the map. */
  async enableHost(host) {
    this.host = host;
    const reanalyze = document.getElementById('btn-reanalyze');
    reanalyze.classList.remove('hidden');
    reanalyze.addEventListener('click', () => host.post('reanalyze'));
    document.getElementById('welcome').classList.add('hidden');
    this.setLiveStatus('Analyzing the workspace…');
    host.onMessage((message) => {
      switch (message.type) {
        case 'load':
          this.liveStatus = null;
          this.load(message.doc, { preserve: !!message.preserve && !!this.model });
          if (message.watching !== undefined) this.hostWatching = !!message.watching;
          this.updateHud();
          break;
        case 'status':
          this.setLiveStatus(message.text ?? null);
          break;
        case 'error':
          this.setLiveStatus(null);
          this.toast(message.message);
          break;
        case 'reveal':
          if (this.model?.get(message.id)) this.reveal(message.id);
          break;
        case 'flow':
          if (this.model) this.showFlow(message.ids, { sequence: !!message.sequence });
          break;
      }
    });
    // Tell the extension how the map runs (it logs it), once the layout worker has started or failed.
    await checkWorker();
    host.post('ready', { renderer: this.stage.backend ?? 'webgl', adapter: this.stage.adapter, layout: layoutKind(Infinity, this.stage) });
  }

  // ------------------------------------------------------------------ local app (codemap ui)

  enableServer(client) {
    this.server = client;
    this.projects = new ProjectsScreen(this, client);
    for (const id of ['btn-projects', 'btn-reanalyze', 'btn-live']) document.getElementById(id).classList.remove('hidden');
    document.getElementById('btn-projects').addEventListener('click', () => this.projects.open());
    document.getElementById('btn-reanalyze').addEventListener('click', () => this.projects.reanalyze());
    document.getElementById('btn-live').addEventListener('click', () => this.projects.toggleLive());
    client.connect((event) => this.projects.onEvent(event));
  }

  setServerProject(project) {
    this.serverProject = project;
    document.getElementById('btn-reanalyze').disabled = !project;
    document.getElementById('btn-live').disabled = !project;
    this.setWatching(this.watchedPath);
  }

  /** The server watches at most one project; it only counts as "live" when it is the one on screen. */
  get watching() {
    if (this.host) return this.hostWatching ? 'workspace' : null; // VS Code: live updates on save (extension setting)
    return this.watchedPath && this.serverProject && samePath(this.watchedPath, this.serverProject.path) ? this.watchedPath : null;
  }

  setWatching(path) {
    this.watchedPath = path ?? null;
    const button = document.getElementById('btn-live');
    button.classList.toggle('on', !!this.watching);
    button.setAttribute('aria-pressed', String(!!this.watching));
    button.title = this.watching ? 'Live updates are on: the map refreshes when you save a file. Click to stop.' : 'Refresh the map automatically when files change';
    this.updateHud();
  }

  setLiveStatus(text) {
    this.liveStatus = text;
    this.updateHud();
  }

  setConnection(connected) {
    if (this.connected === connected) return;
    const wasConnected = this.connected;
    this.connected = connected;
    if (!connected && wasConnected !== undefined) this.toast('Lost the connection to codemap. Is it still running?');
    this.updateHud();
  }

  activateView() {
    this.view?.deactivate();
    const galaxy = this.state.semantic ? this.zoomView : this.galaxy;
    this.view = { galaxy, city: this.city, layers: this.layers, di: this.diView, flow: this.flowView, matrix: this.matrix }[this.state.view] ?? galaxy;
    this.view.activate();
    this.applyOptions();
    document.querySelectorAll('#view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === this.state.view));
    document.querySelectorAll('#level-toggle button').forEach((b) => (b.disabled = !LEVEL_VIEWS.has(this.state.view) || (b.dataset.level === 'auto' && this.state.view !== 'galaxy')));
  }

  // ------------------------------------------------------------------ state

  setState(patch, mode = 'full') {
    Object.assign(this.state, patch);
    if (mode === 'recolor') {
      this.view.recolor();
      if (this.selection) this.applyHighlight();
      renderLegend(this.legend, this);
      this.sidebar.renderFilters();
      return;
    }

    if (mode === 'options') {
      this.applyOptions();
      return;
    }

    this.rebuild();
    this.sidebar.renderFilters();
  }

  /** Living / calm / off (remembered by the stage); views pick their decoration by it. */
  setMotion(motion) {
    this.stage.setMotion(motion);
    this.applyOptions();
  }

  applyOptions() {
    const s = this.state;
    for (const view of [this.galaxy, this.layers, this.diView, this.flowView, this.zoomView]) view.setOptions({ flowAll: s.flowAll, labels: s.labels, autoRotate: s.autoRotate, particles: s.particles });
    this.city.setOptions({ allArcs: s.allArcs, labels: s.labels, particles: s.particles });
    this.matrix.setOptions({ labels: s.labels });
  }

  setView(view) {
    if (view === this.state.view) return;
    if (view === 'di' && !this.model.doc.analysis?.di) return this.toast('No dependency-injection registrations were found in this code.');
    if (view === 'flow' && !this.state.flowRoots.length) {
      const entry = this.getEntryPoints()[0];
      if (!entry) return this.toast('No method calls were found to follow.');
      this.state.flowRoots = [entry.node.id];
    }

    if (view !== 'flow') this.sequence.hide();
    this.state.view = view;
    this.statusLine = '';
    this.activateView();
    this.sidebar.renderFilters();
    this.rebuild();
  }

  setLevel(level) {
    if (!LEVEL_VIEWS.has(this.state.view)) return;
    if (level === 'auto') return this.setSemantic(true);
    if (this.state.semantic && this.state.view === 'galaxy') {
      this.state.semantic = false;
      this.activateView();
    }

    const scope = this.state.scope ? this.model.get(this.state.scope) : null;
    // A scope deeper than (or equal to) the requested level makes no sense: widen it.
    const keepScope = scope && scope.levelIndex < LEVELS.indexOf(level);
    this.setState({ level, scope: keepScope ? scope.id : null });
  }

  /** Semantic zoom (the "Auto" level): one layout of every type, opened and closed by the camera distance. */
  setSemantic(on) {
    const s = this.state;
    if (s.semantic === on && s.view === 'galaxy') return;
    s.semantic = on;
    s.scope = null;
    if (s.view !== 'galaxy') s.view = 'galaxy';
    this.statusLine = '';
    this.sequence.hide();
    this.activateView();
    this.view.userMoved = false;
    this.rebuild();
    this.sidebar.renderFilters();
  }

  /** The semantic zoom opened or closed clusters: links, highlight and HUD follow the new set of nodes. */
  onZoomUnits() {
    if (this.view !== this.zoomView) return;
    this.indexLinks();
    if (this.selection && this.selection.mode !== 'cycle') {
      this.selection.unitId = this.unitFor(this.model.get(this.selection.nodeId));
      if (this.selection.mode === 'path' && !this.view.byId?.has(this.selection.pathTo)) this.selection.mode = 'neighbors';
    }

    if (this.selection) this.applyHighlight();
    this.updateHud();
  }

  rebuild() {
    const s = this.state;
    const model = this.model;
    const semantic = s.semantic && s.view === 'galaxy';
    document.querySelectorAll('#level-toggle button').forEach((b) => b.classList.toggle('active', semantic ? b.dataset.level === 'auto' : b.dataset.level === s.level));

    if (semantic) {
      const typeState = { ...s, level: 'type', scope: null };
      const units = model.units(typeState);
      if (units.length > maxUnits()) {
        this.toast(`${fmt(units.length)} types is too many for semantic zoom – pick a level instead.`);
        s.semantic = false;
        this.activateView();
        return this.rebuild();
      }

      const { links } = model.aggregate(units, typeState);
      this.zoomView.build(units, links, typeState);
    } else if (s.view === 'galaxy') {
      let units = model.units(s);
      if (units.length > maxUnits() && s.level !== 'project') {
        this.toast(`${fmt(units.length)} ${this.levelWord(s.level)} is too many to lay out smoothly – drill into a ${this.levelWord('project', 1)} or ${this.levelWord('namespace', 1)} first.`);
        s.level = LEVELS[Math.max(0, LEVELS.indexOf(s.level) - 1)];
        return this.rebuild();
      }

      const { links, ghosts } = perf.time('aggregate', () => model.aggregate(units, s, { ghosts: !!s.scope }));
      perf.time('build', () => this.galaxy.build(units, links, s, ghosts));
    } else if (s.view === 'layers') {
      const units = model.units(s);
      if (units.length > maxUnits() && s.level !== 'project') {
        this.toast(`${fmt(units.length)} ${this.levelWord(s.level)} is too many to lay out smoothly – drill into a ${this.levelWord('project', 1)} or ${this.levelWord('namespace', 1)} first.`);
        s.level = LEVELS[Math.max(0, LEVELS.indexOf(s.level) - 1)];
        return this.rebuild();
      }

      // Change coupling is not a dependency, it must not influence the layering.
      const dependencyKinds = new Set([...s.edgeKinds].filter((k) => k !== 'changesWith'));
      const { links } = model.aggregate(units, { ...s, edgeKinds: dependencyKinds });
      const result = computeLayers(units.map((u) => u.id), links);
      for (const link of links) link.violation = result.upward.has(link) ? 'error' : null;
      const counts = new Array(result.count).fill(0);
      for (const layer of result.layerOf.values()) counts[layer]++;
      const layers = counts.map((count, i) => ({
        title: `Layer ${i}${i === 0 && result.count > 1 ? ' (bottom)' : i === result.count - 1 && result.count > 1 ? ' (top)' : ''} · ${count}`,
        color: layerColor(i, result.count),
      }));
      this.layerStats = { layers: result.count, upward: result.upward.size };
      this.layers.build(units, links, s, { layerOf: result.layerOf, layers });
    } else if (s.view === 'matrix') {
      const units = model.units(s);
      if (units.length > MATRIX_MAX && s.level !== 'project') {
        this.toast(`${fmt(units.length)} ${this.levelWord(s.level)} are too many rows for a matrix – drill into a ${this.levelWord('project', 1)} or ${this.levelWord('namespace', 1)} first.`);
        s.level = LEVELS[Math.max(0, LEVELS.indexOf(s.level) - 1)];
        return this.rebuild();
      }

      // As for the layers: change coupling is not a dependency.
      const dependencyKinds = new Set([...s.edgeKinds].filter((k) => k !== 'changesWith'));
      const { links } = model.aggregate(units, { ...s, edgeKinds: dependencyKinds });
      const layout = buildMatrix(units, links, computeLayers(units.map((u) => u.id), links));
      this.matrixStats = { layers: layout.levels.length, upward: layout.cells.filter((c) => c.upward).length, cycles: layout.blocks.length };
      this.matrix.build(units, links, s, layout);
    } else if (s.view === 'di') {
      const graph = buildDiGraph(model, s);
      if (!graph) {
        this.toast('No dependency-injection registrations were found in this code.');
        s.view = 'galaxy';
        this.activateView();
        return this.rebuild();
      }

      this.diStats = graph.stats;
      this.diView.build(graph.units, graph.links, { ...s, level: 'type' }, graph.layering);
    } else if (s.view === 'flow') {
      const flow = buildCallFlow(model, s.flowRoots, { maxDepth: s.flowDepth, showTests: s.showTests || s.flowRoots.some((id) => model.get(id)?.isTest), hiddenProjects: s.hiddenProjects });
      this.flow = flow;
      // Entry methods on the top plane, every call one plane lower; calling back up the chain is recursion.
      const top = flow.stats.depth;
      const layerOf = new Map([...flow.depthOf].map(([id, depth]) => [id, top - depth]));
      const counts = new Array(top + 1).fill(0);
      for (const depth of flow.depthOf.values()) counts[depth]++;
      const layers = counts.map((_, i) => {
        const depth = top - i;
        return { title: `${depth === 0 ? 'Entry' : `Call depth ${depth}`} · ${counts[depth]}`, color: flowColor(depth, top + 1) };
      });
      for (const link of flow.links) link.violation = link.recursive ? 'warning' : null;
      this.flowView.build([...flow.nodes.values()], flow.links, { ...s, level: 'member' }, { layerOf, layers });
      this.sequence.update(flow);
    } else {
      const scope = s.scope ? model.get(s.scope) : null;
      const cityState = { ...s, level: 'type', scope: scope && scope.levelIndex <= 1 ? scope.id : null };
      const units = model.units(cityState);
      const { links } = model.aggregate(units, cityState);
      this.city.build(units, links, s);
    }

    this.indexLinks();
    this.updateBreadcrumb();
    renderLegend(this.legend, this);
    if (this.selection) {
      this.selection.unitId = this.unitFor(this.model.get(this.selection.nodeId));
      this.applyHighlight();
    }

    this.updateHud();
  }

  indexLinks() {
    this.graph = new GraphIndex(this.view.links);
  }

  // ------------------------------------------------------------------ selection & highlight

  /** The visible unit that represents a node in the current view (itself or its closest visible ancestor). */
  unitFor(node) {
    for (let n = node; n; n = n.parent ? this.model.get(n.parent) : null) if (this.view.byId?.has(n.id)) return n.id;
    return null;
  }

  select(id, { focus = false, mode = 'neighbors' } = {}) {
    this.pathPending = false;
    if (!id) {
      this.selection = null;
      this.statusLine = '';
      this.view.setHighlight(null);
      this.details.hide();
      this.updateHud();
      return;
    }

    const node = this.model.get(id);
    if (!node) return;
    this.selection = { nodeId: id, unitId: this.unitFor(node), mode };
    this.applyHighlight();
    this.details.show(node, this.selection.unitId ? this.model.get(this.selection.unitId).level : node.level);
    if (focus && this.selection.unitId) this.view.focus(this.selection.unitId);
    this.updateHud();
  }

  highlightMode(mode) {
    if (!this.selection) return;
    this.selection.mode = mode;
    this.applyHighlight();
    this.details.show(this.model.get(this.selection.nodeId), this.model.get(this.selection.unitId)?.level);
  }

  applyHighlight() {
    const sel = this.selection;
    if (!sel) return this.view.setHighlight(null);
    if (sel.mode === 'cycle') return this.view.setHighlight(this.cycleHighlight(sel.cycle));
    if (!sel.unitId) return this.view.setHighlight(null);

    const start = sel.unitId;
    const nodes = new Set([start]);
    const links = new Set();
    const secondary = new Set();
    let status = '';

    if (sel.mode === 'neighbors') {
      const add = (id, i) => (nodes.add(id), links.add(i));
      this.graph.forEach(start, 'out', add);
      this.graph.forEach(start, 'in', add);
      status = `${this.graph.degree(start, 'out')} outgoing · ${this.graph.degree(start, 'in')} incoming links (enabled kinds)`;
    } else if (sel.mode === 'dependencies' || sel.mode === 'dependents') {
      const reached = this.graph.reach(start, sel.mode === 'dependencies' ? 'out' : 'in');
      for (const id of reached.nodes) nodes.add(id);
      for (const i of reached.links) links.add(i);
      const n = nodes.size - 1;
      status = sel.mode === 'dependencies' ? `Depends on ${n} unit(s) transitively` : `Impact: ${n} unit(s) depend on this transitively`;
    } else if (sel.mode === 'path' && sel.pathTo) {
      const path = this.findPath(start, sel.pathTo) ?? this.findPath(sel.pathTo, start);
      if (path) {
        path.nodes.forEach((id) => (nodes.add(id), secondary.add(id)));
        path.links.forEach((i) => links.add(i));
        status = `Path: ${path.nodes.map((id) => shortName(this.model.get(id))).join(' → ')}`;
      } else {
        nodes.add(sel.pathTo);
        status = 'No dependency path between these (with the enabled relationship kinds).';
      }
    }

    this.statusLine = status;
    this.view.setHighlight({ primary: start, nodes, links, secondary });
    this.updateHud();
  }

  findPath(from, to) {
    return this.graph.path(from, to);
  }

  startPath() {
    if (!this.selection?.unitId) return;
    this.pathPending = true;
    this.updateHud();
  }

  showPath(from, to) {
    this.pathPending = false;
    const node = this.model.get(from);
    this.selection = { nodeId: from, unitId: from, mode: 'path', pathTo: to };
    this.applyHighlight();
    this.details.show(node, node.level);
  }

  cycleHighlight(cycle) {
    const ids = new Set(cycle.nodes.map((id) => this.unitFor(this.model.get(id))).filter(Boolean));
    const links = new Set();
    this.view.links.forEach((l, i) => {
      if (ids.has(l.source) && ids.has(l.target)) links.add(i);
    });
    return { primary: null, nodes: ids, links, secondary: ids };
  }

  showCycle(cycle) {
    const level = cycle.level === 'project' ? 'project' : cycle.level === 'namespace' ? 'namespace' : 'type';
    let rebuild = false;
    if (this.state.semantic) {
      this.state.semantic = false;
      this.activateView();
      rebuild = true;
    }

    if (!LEVEL_VIEWS.has(this.state.view)) {
      this.state.view = 'galaxy';
      this.activateView();
      rebuild = true;
    }

    if (this.state.level !== level || this.state.scope) {
      this.state.level = level;
      this.state.scope = null;
      rebuild = true;
    }

    if (rebuild) {
      this.rebuild();
      this.sidebar.renderFilters();
    }

    this.selection = { nodeId: cycle.nodes[0], unitId: null, mode: 'cycle', cycle };
    this.statusLine = `Cycle between ${cycle.nodes.length} ${cycle.level}s`;
    this.applyHighlight();
    this.details.show(this.model.get(cycle.nodes[0]), level);
    const first = this.unitFor(this.model.get(cycle.nodes[0]));
    if (first) this.view.focus(first);
    this.updateHud();
  }

  showDiIssue(issue) {
    if (this.state.view !== 'di') this.setView('di');
    if (this.diView.byId?.has(issue.consumer)) {
      this.select(issue.consumer, { focus: true });
      this.statusLine = issue.message;
      this.updateHud();
    } else {
      this.reveal(issue.consumer);
    }
  }

  /** Switches to the layers view at the given level (whole solution). */
  showLayers(level) {
    const s = this.state;
    if (s.view !== 'layers') {
      s.view = 'layers';
      this.activateView();
    }

    s.level = level;
    s.scope = null;
    this.layers.userMoved = false;
    this.rebuild();
    this.sidebar.renderFilters();
  }

  showUpward(level, source, target) {
    this.showLayers(level);
    if (this.view.byId?.has(source) && this.view.byId?.has(target)) {
      this.showPath(source, target);
      this.view.focus(source);
    } else {
      this.reveal(source);
    }
  }

  /** Shows two types that change together (git) with the change-coupling link switched on. */
  showCoupling(pair) {
    const s = this.state;
    if (!s.edgeKinds.has('changesWith')) s.edgeKinds = new Set([...s.edgeKinds, 'changesWith']);
    s.semantic = false;
    if (s.view !== 'galaxy' || this.view === this.zoomView) {
      s.view = 'galaxy';
      this.activateView();
    }

    s.level = 'type';
    s.scope = null;
    this.rebuild();
    this.sidebar.renderFilters();
    if (this.view.byId?.has(pair.source) && this.view.byId?.has(pair.target)) {
      this.showPath(pair.source, pair.target);
      this.view.focus(pair.source);
      this.statusLine = `Changed together in ${pair.sharedCommits} commits (${Math.round(pair.strength * 100)}%)${pair.hidden ? ', with no code dependency' : ''}`;
      this.updateHud();
    } else {
      this.reveal(pair.source);
    }
  }

  /** Likely entry points (controllers, handlers, background services, Main…), computed once per model. */
  getEntryPoints() {
    this.entryPoints ??= findEntryPoints(this.model);
    return this.entryPoints;
  }

  /** Call flow starting at the given methods (a type stands for its entry methods: controller actions…). */
  showFlow(rootIds, { sequence = false } = {}) {
    const s = this.state;
    s.flowRoots = rootIds.filter((id) => this.model.get(id));
    if (!s.flowRoots.length) return;
    this.statusLine = '';
    if (s.view !== 'flow') {
      s.view = 'flow';
      this.activateView();
    }

    this.flowView.userMoved = false;
    this.rebuild();
    this.sidebar.renderFilters();
    if (!this.flow.links.length) this.toast('This method calls nothing in the analyzed code.', 'info');
    if (sequence) this.sequence.show(this.flow);
  }

  /** From the sequence diagram: select a method in the 3D flow (or wherever it is visible). */
  selectInFlow(id) {
    // Created types are not methods of the flow: show their details without leaving it.
    if (this.state.view === 'flow') this.select(id, { focus: this.flowView.byId?.has(id) });
    else this.reveal(id);
  }

  /** Makes a node visible (switching level / scope / filters if needed), selects and focuses it. */
  reveal(id) {
    const node = this.model.get(id);
    if (!node) return;
    const s = this.state;
    let changed = false;
    if (node.projectNode && s.hiddenProjects.has(node.projectNode.id)) {
      s.hiddenProjects.delete(node.projectNode.id);
      changed = true;
    }

    if (node.isTest && !s.showTests) (s.showTests = true), (changed = true);
    if (node.external && !s.showExternal) (s.showExternal = true), (changed = true);

    if (this.view === this.zoomView) {
      if (changed) {
        this.rebuild();
        this.sidebar.renderFilters();
        // the layout restarts: fly there once it has settled
        return setTimeout(() => this.reveal(id), 600);
      }

      if (!this.zoomView.semantic) return setTimeout(() => this.reveal(id), 300);
      this.zoomView.reveal(id);
      return this.select(id);
    }

    if ((s.view === 'di' || s.view === 'flow') && !this.view.byId?.has(id)) {
      // Not part of the container graph / the call flow: show it in the galaxy instead.
      s.view = 'galaxy';
      this.activateView();
      changed = true;
    }

    if (s.view === 'di' || s.view === 'flow') {
      // nothing to adjust: these views show a fixed set of nodes
    } else if (LEVEL_VIEWS.has(s.view)) {
      const visible = this.view.byId?.has(id) && !changed;
      if (!visible) {
        let level = node.external ? 'type' : node.level;
        let scope = s.scope && this.model.isDescendant(node, s.scope) && this.model.get(s.scope).levelIndex < LEVELS.indexOf(level) ? s.scope : null;
        if (level === 'member' && !scope) scope = node.typeNode?.id ?? null;
        s.level = level;
        s.scope = scope;
        changed = true;
      }
    } else if (node.levelIndex <= 1 && !node.external) {
      s.scope = node.id;
      changed = true;
    } else if (s.scope && !this.model.isDescendant(node, s.scope)) {
      s.scope = null;
      changed = true;
    }

    if (changed) {
      this.rebuild();
      this.sidebar.renderFilters();
    }

    this.select(id, { focus: true });
  }

  drill(id) {
    const node = this.model.get(id);
    if (!node) return;
    // In VS Code a double click on a method (or anything in the call flow) opens its code.
    if (host && node.location && (node.level === 'member' || this.state.view === 'flow')) return host.openFile(node.location.file, node.location.line);
    if (this.state.view === 'city') {
      if (node.levelIndex <= 1) {
        this.state.scope = node.id;
        this.rebuild();
        this.city.fit(true);
      } else this.view.focus(this.unitFor(node));
      return;
    }

    if (this.view === this.zoomView) return this.zoomView.zoomInto(id);
    const next = NEXT_LEVEL[node.level];
    if (!next || node.external) return;
    if (this.state.view === 'di' || this.state.view === 'flow') return this.view.focus(id);
    this.state.level = next;
    this.state.scope = node.id;
    this.view.userMoved = false;
    this.rebuild();
    this.sidebar.renderFilters();
    this.selection = { nodeId: id, unitId: null, mode: 'neighbors' };
    this.details.show(node, node.level);
    setTimeout(() => this.view.fit(true), 50);
  }

  goUp() {
    const s = this.state;
    if (this.view === this.zoomView) return this.view.fit(true);
    if (!s.scope) {
      if (LEVEL_VIEWS.has(s.view) && s.level !== 'project') this.setLevel(LEVELS[LEVELS.indexOf(s.level) - 1]);
      return;
    }

    const scope = this.model.get(s.scope);
    const parent = scope.parent ? this.model.get(scope.parent) : null;
    this.navigateScope(parent && parent.kind !== 'assembly' ? parent.id : null, scope.level);
  }

  /** Breadcrumb navigation: show the contents of a container (or everything). */
  navigateScope(id, levelHint) {
    const s = this.state;
    if (!id) {
      s.scope = null;
      if (LEVEL_VIEWS.has(s.view)) s.level = levelHint ?? (s.level === 'member' ? 'type' : s.level);
    } else {
      const node = this.model.get(id);
      s.scope = id;
      if (LEVEL_VIEWS.has(s.view)) s.level = NEXT_LEVEL[node.level] ?? s.level;
    }

    this.view.userMoved = false;
    this.rebuild();
    this.sidebar.renderFilters();
    setTimeout(() => this.view.fit(true), 50);
  }

  updateBreadcrumb() {
    const el = document.getElementById('breadcrumb');
    clear(el);
    const s = this.state;
    if (!s.scope) return el.classList.add('hidden');
    el.classList.remove('hidden');
    const chain = [];
    for (let n = this.model.get(s.scope); n; n = n.parent ? this.model.get(n.parent) : null) chain.unshift(n);
    el.append(h('button', { onClick: () => this.navigateScope(null) }, 'All'));
    for (const n of chain) {
      el.append(h('span', { class: 'sep' }, '›'));
      el.append(h('button', { onClick: () => this.navigateScope(n.id), title: n.fullName ?? n.name }, n.kind === 'namespace' ? n.name : shortName(n)));
    }
  }

  updateHud() {
    if (!this.view) {
      // nothing loaded yet (VS Code: the first analysis is running)
      this.hud.replaceChildren(...(this.liveStatus ? [h('div', {}, '⟳ ' + this.liveStatus)] : []));
      return;
    }

    const units = this.view.units?.length ?? 0;
    const links = this.view.links?.length ?? 0;
    const view = this.state.view;
    const semantic = this.view === this.zoomView;
    const lines = [`${fmt(units)} ${view === 'city' ? 'buildings' : view === 'di' ? 'services' : semantic ? 'nodes' : this.levelWord(this.state.level, units)} · ${fmt(links)} links`];
    if (semantic) {
      const open = this.zoomView.semantic ? this.zoomView.open.size : 0;
      lines.unshift(open ? `Semantic zoom · ${open} cluster${open === 1 ? '' : 's'} open` : 'Semantic zoom: fly into a cluster to open it');
    }

    if (view === 'layers' && this.layerStats) {
      const { layers, upward } = this.layerStats;
      lines.unshift(`${layers} layers · ${upward ? `${upward} upward dependenc${upward === 1 ? 'y' : 'ies'} (red)` : 'no upward dependencies'}`);
    }

    if (view === 'matrix' && this.matrixStats) {
      const { layers, upward, cycles } = this.matrixStats;
      const against = upward ? `${upward} against the layers (red)` : 'nothing against the layers';
      lines.unshift(`${layers} layer${layers === 1 ? '' : 's'} · ${against} · ${cycles ? `${cycles} cycle${cycles === 1 ? '' : 's'}` : 'no cycles'}`);
    }

    if (view === 'di' && this.diStats) {
      const { errors, warnings, notes } = this.diStats;
      const problems = errors || warnings ? `${errors} lifetime error(s) · ${warnings} warning(s)` : 'No DI problems found';
      lines.unshift(notes ? `${problems} · ${notes} note(s)` : problems);
    }

    if (view === 'flow' && this.flow) {
      const { methods, types, depth, truncated, maxDepth } = this.flow.stats;
      const roots = this.flow.roots;
      const from = roots.length === 1 ? shortName(roots[0]) : `${(roots[0]?.ownerNode ?? roots[0]?.typeNode)?.name ?? ''} (${roots.length} entry methods)`;
      lines[lines.length - 1] = `${fmt(methods)} methods in ${fmt(types)} ${this.levelWord('type', types)} · depth ${depth}${truncated ? ` (cut at ${maxDepth})` : ''}`;
      lines.unshift(`Call flow from ${from}`);
    }

    if (this.pathPending) lines.unshift('Click the target node to find a dependency path…');
    else if (this.statusLine) lines.unshift(this.statusLine);
    if (this.liveStatus) lines.unshift('⟳ ' + this.liveStatus);
    else if (this.watching) lines.push('● live: watching for changes');
    this.hud.replaceChildren(...lines.map((l) => h('div', {}, l)));
    if (this.ar.active) this.ar.update();
  }

  /** The GPU went away (driver reset, GPU switched, too much memory): the map cannot draw any more. */
  onDeviceLost(info) {
    console.error('CodeMap: GPU device lost', info);
    const card = h('div', { class: 'welcome-card' },
      h('div', { class: 'logo big' }),
      h('h1', {}, 'The graphics device was reset'),
      h('p', {}, `The map stopped drawing (${info?.message ?? 'device lost'}). Reload to continue.`),
      h('button', { class: 'primary', onClick: () => location.reload() }, 'Reload'),
    );
    const welcome = document.getElementById('welcome');
    welcome.replaceChildren(card);
    welcome.classList.remove('hidden');
    host?.post('fatal', { message: 'The graphics device was reset; reopen the map.', webgl: false });
  }

  toast(message, kind = 'warn') {
    if (this.ar.active) return this.ar.message(message);
    const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
    document.getElementById('app').append(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ------------------------------------------------------------------ DOM wiring

  bindUi() {
    const canvas = this.stage.canvas;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
      this.handleClick(e);
    });
    canvas.addEventListener('dblclick', (e) => {
      if (this.ar.active) return this.ar.drillAtReticle();
      const id = this.view?.pick(e);
      if (id) this.drill(id);
    });
    document.getElementById('btn-ar').addEventListener('click', () => this.model && this.ar.openPanel());

    let scheduled = false;
    let last = null;
    canvas.addEventListener('pointermove', (e) => {
      last = e;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        this.updateHover(last);
      });
    });
    canvas.addEventListener('pointerleave', () => {
      this.tooltip.classList.add('hidden');
      this.view?.setHovered(null);
    });

    document.querySelectorAll('#view-toggle button').forEach((b) => b.addEventListener('click', () => this.model && this.setView(b.dataset.view)));
    document.querySelectorAll('#level-toggle button').forEach((b) => b.addEventListener('click', () => this.model && this.setLevel(b.dataset.level)));
    document.getElementById('btn-fit').addEventListener('click', () => this.view?.fit(true));

    const fileInput = document.getElementById('file-input');
    const openFile = () => fileInput.click();
    document.getElementById('btn-open').addEventListener('click', openFile);
    document.getElementById('welcome-open').addEventListener('click', openFile);
    fileInput.addEventListener('change', () => fileInput.files[0] && this.loadFile(fileInput.files[0]));

    const overlay = document.getElementById('drop-overlay');
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      overlay.classList.remove('hidden');
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) overlay.classList.add('hidden');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      overlay.classList.add('hidden');
      const file = e.dataTransfer?.files?.[0];
      if (file) this.loadFile(file);
    });

    const left = document.getElementById('left');
    const leftToggle = document.getElementById('left-toggle');
    const setCollapsed = (collapsed) => {
      left.classList.toggle('collapsed', collapsed);
      leftToggle.classList.toggle('collapsed', collapsed);
      leftToggle.textContent = collapsed ? '⟩' : '⟨';
      this.legend.classList.toggle('wide', collapsed);
    };
    leftToggle.addEventListener('click', () => setCollapsed(!left.classList.contains('collapsed')));
    // On small screens the map comes first; filters open on demand.
    if (window.innerWidth < 900) setCollapsed(true);

    this.bindSearch();

    window.addEventListener('keydown', (e) => {
      if (this.projects?.visible) {
        if (e.key === 'Escape') this.projects.close();
        return;
      }

      if (!this.model) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('search').focus();
      } else if (e.key >= '1' && e.key <= '4') this.setLevel(LEVELS[Number(e.key) - 1]);
      else if (e.key === 'g' || e.key === 'G') this.setView('galaxy');
      else if (e.key === 'c' || e.key === 'C') this.setView('city');
      else if (e.key === 'l' || e.key === 'L') this.setView('layers');
      else if (e.key === 'd' || e.key === 'D') this.setView('di');
      else if (e.key === 'e' || e.key === 'E') this.setView('flow');
      else if (e.key === 'm' || e.key === 'M') this.setView('matrix');
      else if (e.key === 'z' || e.key === 'Z') this.setLevel(this.state.semantic && this.state.view === 'galaxy' ? 'type' : 'auto');
      else if (e.key === 'f' || e.key === 'F') this.view.fit(true);
      else if (e.key === 'Escape') {
        if (this.sequence.visible) this.sequence.hide();
        else if (this.pathPending) {
          this.pathPending = false;
          this.updateHud();
        } else if (this.selection) this.select(null);
        else this.goUp();
      }
    });
  }

  handleClick(e) {
    if (!this.view) return;
    // AR glasses: the mouse pointer is hidden; the reticle in the middle of the view picks.
    if (this.ar.active) return this.ar.selectAtReticle();
    // Matrix: a click on a dependency's column selects that dependency.
    if (this.view.pickAt) {
      const hit = this.view.pickAt(e);
      if (hit?.cell) return this.selectCell(hit.cell);
      return this.handleClickOn(hit?.unit?.id ?? null, e);
    }

    this.handleClickOn(this.view.pick(e), e);
  }

  /** Matrix: both ends of a dependency and the link between them, with what the dependency is made of. */
  selectCell(cell) {
    this.showPath(cell.source, cell.target);
    this.statusLine = `${this.cellTitle(cell)}: ${this.cellKinds(cell)}${cell.upward ? ' · against the layers' : ''}`;
    this.updateHud();
  }

  cellTitle(cell) {
    return `${shortName(this.model.get(cell.source))} → ${shortName(this.model.get(cell.target))}`;
  }

  /** "7 calls · 3 injects", strongest first. */
  cellKinds(cell) {
    return Object.entries(cell.link.kinds ?? { [cell.kind]: cell.weight })
      .sort((a, b) => b[1] - a[1])
      .map(([kind, weight]) => `${fmt(weight)} ${EDGE_KINDS[kind]?.label ?? kind}`)
      .join(' · ');
  }

  /** A click on the unit `id` (null: on nothing): select it, or (Shift / path pending) show the path to it. */
  handleClickOn(id, e = {}) {
    if (!id) {
      if (!this.pathPending) this.select(null);
      return;
    }

    if ((e.shiftKey || this.pathPending) && this.selection?.unitId && this.selection.unitId !== id) {
      this.showPath(this.selection.unitId, id);
      return;
    }

    this.select(id);
  }

  updateHover(e) {
    if (this.ar.active) return; // the reticle hovers
    if (!this.view || e.buttons) {
      this.tooltip.classList.add('hidden');
      return;
    }

    let id;
    if (this.view.pickAt) {
      const hit = this.view.pickAt(e);
      this.view.setHoveredCell(hit?.cell ?? null);
      if (hit?.cell) {
        this.stage.canvas.style.cursor = 'pointer';
        return this.showCellTooltip(hit.cell, e);
      }

      id = hit?.unit?.id ?? null;
    } else id = this.view.pick(e);

    this.view.setHovered(id);
    this.stage.canvas.style.cursor = id ? 'pointer' : '';
    if (!id) {
      this.tooltip.classList.add('hidden');
      return;
    }

    const node = this.model.get(id);
    const m = node.metrics;
    const parts = [];
    if (m.loc !== undefined) parts.push(`${fmt(m.loc)} LOC`);
    if (m.complexity !== undefined) parts.push(`cx ${fmt(m.complexity)}`);
    if (m.types !== undefined) parts.push(`${fmt(m.types)} types`);
    if (m.ca !== undefined) parts.push(`used by ${fmt(m.ca)} · uses ${fmt(m.ce)}`);
    if (m.commits) parts.push(`${fmt(m.commits)} commits`);
    // DOM append() would print "null" for the missing rows.
    clear(this.tooltip).append(...[
      h('div', { class: 't-kind', style: { color: kindColor(node.kind) } }, node.kind + (node.external ? ' · external' : '')),
      h('div', { class: 't-name' }, shortName(node)),
      node.fullName && node.fullName !== node.name ? h('div', { class: 't-full' }, node.fullName) : null,
      parts.length ? h('div', { class: 't-metrics' }, parts.join(' · ')) : null,
      node.tags.length ? h('div', { class: 't-metrics' }, node.tags.slice(0, 4).join(' · ')) : null,
    ].filter(Boolean));
    this.placeTooltip(e);
  }

  /** Matrix: the dependency under the pointer. */
  showCellTooltip(cell, e) {
    const kindColorOf = cell.upward ? '#ff6b6b' : EDGE_KINDS[cell.kind]?.color ?? '#9fb3c8';
    clear(this.tooltip).append(
      h('div', { class: 't-kind', style: { color: kindColorOf } }, cell.upward ? 'dependency · against the layers' : 'dependency'),
      h('div', { class: 't-name' }, this.cellTitle(cell)),
      h('div', { class: 't-metrics' }, this.cellKinds(cell)),
    );
    this.placeTooltip(e);
  }

  placeTooltip(e) {
    this.tooltip.classList.remove('hidden');
    const x = Math.min(e.clientX + 16, window.innerWidth - this.tooltip.offsetWidth - 8);
    const y = Math.min(e.clientY + 16, window.innerHeight - this.tooltip.offsetHeight - 8);
    this.tooltip.style.left = x + 'px';
    this.tooltip.style.top = y + 'px';
  }

  bindSearch() {
    const input = document.getElementById('search');
    const list = document.getElementById('search-results');
    let results = [];
    let active = 0;

    const render = () => {
      clear(list);
      if (!results.length) return list.classList.add('hidden');
      list.classList.remove('hidden');
      results.forEach((node, i) =>
        list.append(
          h('div', { class: 'item' + (i === active ? ' active' : ''), onMousedown: (e) => (e.preventDefault(), choose(node)) },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none', background: kindColor(node.kind) } }),
            h('div', { style: { minWidth: 0 } },
              h('div', { class: 'name' }, shortName(node), h('span', { class: 'faint small' }, '  ' + node.kind)),
              h('div', { class: 'full' }, node.fullName ?? node.location?.file ?? ''),
            ),
          ),
        ),
      );
    };

    const choose = (node) => {
      input.value = '';
      results = [];
      render();
      input.blur();
      this.reveal(node.id);
    };

    input.addEventListener('input', debounce(() => {
      if (!this.model) return;
      results = this.model.search(input.value, 25);
      active = 0;
      render();
    }, 60));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') (active = Math.min(results.length - 1, active + 1)), render(), e.preventDefault();
      else if (e.key === 'ArrowUp') (active = Math.max(0, active - 1)), render(), e.preventDefault();
      else if (e.key === 'Enter' && results[active]) choose(results[active]);
      else if (e.key === 'Escape') (input.value = ''), (results = []), render(), input.blur();
    });
    input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
    input.addEventListener('focus', () => results.length && list.classList.remove('hidden'));
  }

  async loadFile(file) {
    try {
      this.load(JSON.parse(await file.text()));
    } catch (error) {
      this.toast(`Could not load ${file.name}: ${error.message}`);
    }
  }
}

async function boot() {
  let app;
  try {
    app = new App();
    await app.stage.ready;
  } catch (error) {
    return showStartupError(error);
  }

  window.codemap = app;
  app.stage.onDeviceLost = (info) => app.onDeviceLost(info);
  if (params.has('bench')) window.codemapLayout = await import('./layout/testing.js');
  if (host) return app.enableHost(host);
  const embedded = document.getElementById('codemap-data')?.textContent?.trim();
  const server = ServerClient.detect();
  try {
    if (embedded && embedded !== 'null') return app.load(JSON.parse(embedded));
    if (server) {
      // Local app: pick up a running analysis (codemap ui <path>) or show the project picker.
      Object.assign(server.config, await server.get('/api/config'));
      app.enableServer(server);
      app.setServerProject(null);
      if (server.config.current?.status === 'running') {
        await app.projects.open();
        app.projects.showJob(server.config.current);
      } else if (server.config.current?.status === 'done' && server.config.current.key) {
        const job = server.config.current;
        app.load(await server.get(`/api/jobs/${job.id}/graph`));
        app.setServerProject({ path: job.path, settings: job.settings, key: job.key });
        if (server.config.watching) app.setWatching(server.config.watching);
      } else {
        await app.projects.open();
      }

      return;
    }

    const url = params.get('data');
    if (url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const text = await response.text();
      return app.load(perf.time('parse', () => JSON.parse(text)));
    }
  } catch (error) {
    app.toast(`Could not load data: ${error.message}`);
  }

  document.getElementById('welcome').classList.remove('hidden');
}

boot();

/** The map could not start (no WebGPU and no WebGL 2): say why instead of leaving an empty page. */
function showStartupError(error) {
  const webgl = /webgl|webgpu|gpu|context/i.test(String(error?.message ?? error));
  const message = webgl
    ? 'The 3D map needs WebGPU or WebGL 2, and neither is available here (graphics acceleration is turned off or the GPU is blocklisted).'
    : `CodeMap could not start: ${error?.message ?? error}`;
  console.error(error);
  host?.post('fatal', { message, webgl });
  const hint = host
    ? 'Use “Open in Browser” to see the map in your web browser instead.'
    : 'Try another browser, or turn on hardware acceleration in the browser settings.';
  const card = document.querySelector('#welcome .welcome-card');
  card.replaceChildren(h('div', { class: 'logo big' }), h('h1', {}, 'CodeMap'), h('p', {}, message), h('p', { class: 'muted small' }, hint));
  document.getElementById('welcome').classList.remove('hidden');
}

function samePath(a, b) {
  const norm = (p) => (p ?? '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Call-depth tints: warm at the entry point, cooling down the call chain. */
function flowColor(depth, count) {
  const t = count <= 1 ? 0 : depth / (count - 1);
  return `hsl(${38 + t * 172}, 80%, 62%)`;
}

/** Layer tints from teal (foundation) to violet (top). */
function layerColor(index, count) {
  const t = count <= 1 ? 0 : index / (count - 1);
  const hue = 172 + t * 100;
  return `hsl(${hue}, 70%, 62%)`;
}
