import { clear, fmt, h } from './dom.js';

const SETTINGS_KEY = 'codemap.settings';
const DEFAULT_SETTINGS = { tests: true, external: false, git: true, typesOnly: false, watch: false };

const OPTION_LABELS = [
  ['tests', 'Include test projects', 'Analyze *.Tests projects too'],
  ['git', 'Git history', 'Commits and churn per file: needed for hotspots'],
  ['external', 'Framework & NuGet types', 'Show the BCL / package types your code depends on'],
  ['typesOnly', 'Types only', 'Skip methods and fields: smaller and faster for very large solutions'],
  ['watch', 'Live updates', 'Re-analyze and refresh the map whenever you save a file'],
];

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage blocked: settings just won't be remembered
  }
}

function ago(date) {
  const seconds = (Date.now() - new Date(date).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

const ICONS = { solution: '◆', project: '●', folder: '▸', place: '⌂' };

/**
 * Start screen of the local app: browse the disk, clone a repository, reopen recent projects,
 * and follow the analysis while it runs.
 */
export class ProjectsScreen {
  constructor(app, client) {
    this.app = app;
    this.client = client;
    this.el = document.getElementById('projects');
    this.settings = loadSettings();
    this.listing = null;
    this.recent = [];
    this.job = null;
    this.render();
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  async open() {
    this.el.classList.remove('hidden');
    this.app.stage.setPaused(true);
    this.renderHead();
    this.refreshRecent();
    if (!this.listing) await this.navigate(this.client.config.startDirectory);
    this.pathInput.focus();
  }

  close() {
    if (!this.app.model) return;
    this.hide();
  }

  hide() {
    this.el.classList.add('hidden');
    this.app.stage.setPaused(false);
  }

  // ------------------------------------------------------------------ layout

  render() {
    clear(this.el);
    this.headEl = h('header', { class: 'p-head' });
    this.pathInput = h('input', {
      id: 'p-path',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'Path to a .sln, .slnx, .csproj or a folder',
      onKeydown: (e) => {
        if (e.key === 'Enter') this.analyzeOrOpen(this.pathInput.value);
      },
    });
    this.gitInput = h('input', {
      id: 'p-git',
      type: 'url',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: 'https://github.com/owner/repository',
      onKeydown: (e) => {
        if (e.key === 'Enter') this.clone();
      },
    });
    this.placesEl = h('div', { class: 'p-places' });
    this.crumbEl = h('div', { class: 'p-crumb' });
    this.listEl = h('div', { class: 'p-list', role: 'listbox', 'aria-label': 'Folder contents' });
    this.recentEl = h('div', { class: 'p-recent-list' });
    this.jobEl = h('div', { class: 'p-job hidden', role: 'status', 'aria-live': 'polite' });

    const options = h('div', { class: 'p-options' },
      OPTION_LABELS.map(([key, label, hint]) =>
        h('label', { class: 'check', title: hint },
          h('input', {
            id: 'opt-' + key,
            type: 'checkbox',
            checked: this.settings[key],
            onChange: (e) => {
              this.settings[key] = e.target.checked;
              saveSettings(this.settings);
            },
          }),
          h('span', { class: 'name' }, label),
          h('span', { class: 'hint' }, hint),
        ),
      ),
    );

    this.el.append(
      h('div', { class: 'p-card' },
        this.headEl,
        h('div', { class: 'p-grid' },
          h('section', { class: 'p-open' },
            h('h3', {}, 'On this computer'),
            h('div', { class: 'p-bar' }, this.pathInput, h('button', { class: 'primary', onClick: () => this.analyze(this.pathInput.value) }, 'Analyze')),
            this.placesEl,
            h('div', { class: 'p-browser' }, this.crumbEl, this.listEl),
            h('h3', {}, 'From a Git repository'),
            h('div', { class: 'p-bar' }, this.gitInput, h('button', { onClick: () => this.clone() }, 'Clone & analyze')),
            h('h3', {}, 'Options'),
            options,
          ),
          h('section', { class: 'p-recent' }, h('h3', {}, 'Recent'), this.recentEl),
        ),
        this.jobEl,
      ),
    );
    this.renderHead();
  }

  renderHead() {
    clear(this.headEl).append(...[
      h('div', { class: 'logo big' }),
      h('div', { class: 'p-title' },
        h('h1', {}, 'Open a C# codebase'),
        h('p', { class: 'muted' }, 'Pick a solution, project or folder on this computer, or clone a repository. Nothing needs to be built first.'),
      ),
      this.app.model && h('button', { class: 'p-close', onClick: () => this.close(), title: 'Back to the map (Esc)' }, '← Back to map'),
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------ folder browser

  async navigate(path) {
    try {
      this.listing = await this.client.browse(path);
    } catch (error) {
      this.app.toast(error.message);
      return;
    }

    const listing = this.listing;
    this.pathInput.value = listing.path;
    clear(this.placesEl).append(...listing.places.map((p) =>
      h('button', { class: 'chip-button' + (p.path === listing.path ? ' active' : ''), title: p.path, onClick: () => this.navigate(p.path) }, p.name)));

    clear(this.crumbEl).append(
      h('button', { class: 'small', disabled: !listing.parent, title: 'Up one folder', onClick: () => listing.parent && this.navigate(listing.parent) }, '↑'),
      h('code', { title: listing.path }, h('span', { dir: 'ltr' }, listing.path)),
    );

    clear(this.listEl);
    if (!listing.entries.length) this.listEl.append(h('div', { class: 'p-empty' }, 'No folders, solutions or projects here.'));
    for (const entry of listing.entries) {
      const isCode = entry.kind !== 'folder';
      const row = h('div', {
        class: `p-row k-${entry.kind}` + (entry.hasCode ? ' has-code' : ''),
        role: 'option',
        tabindex: 0,
        title: isCode ? 'Double-click to analyze' : 'Open folder',
        onClick: () => (isCode ? this.select(entry.path, row) : this.navigate(entry.path)),
        onDblclick: () => isCode && this.analyze(entry.path),
        onKeydown: (e) => {
          if (e.key === 'Enter') isCode ? this.analyze(entry.path) : this.navigate(entry.path);
        },
      },
        h('span', { class: 'p-icon' }, ICONS[entry.kind] ?? '•'),
        h('span', { class: 'p-name' }, entry.name),
        entry.kind === 'folder' && entry.hasCode ? h('span', { class: 'p-tag' }, 'C#') : null,
        isCode || entry.hasCode
          ? h('button', { class: 'small', onClick: (e) => (e.stopPropagation(), this.analyze(entry.path)) }, 'Analyze')
          : null,
      );
      this.listEl.append(row);
    }
  }

  select(path, row) {
    this.pathInput.value = path;
    this.listEl.querySelectorAll('.p-row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
  }

  analyzeOrOpen(path) {
    if (/\.(sln|slnx|slnf|csproj|cs)$/i.test(path.trim())) this.analyze(path);
    else this.navigate(path);
  }

  // ------------------------------------------------------------------ actions

  async analyze(path, settings = this.settings, { background = false } = {}) {
    if (!path?.trim()) return this.app.toast('Choose a solution, project or folder first.');
    try {
      await this.client.post('/api/analyze', { path, settings, background });
    } catch (error) {
      this.app.toast(error.message);
    }
  }

  async clone() {
    const url = this.gitInput.value.trim();
    if (!url) return this.gitInput.focus();
    try {
      await this.client.post('/api/clone', { url, settings: this.settings });
    } catch (error) {
      this.app.toast(error.message);
    }
  }

  async cancel() {
    try {
      await this.client.post('/api/cancel');
    } catch (error) {
      this.app.toast(error.message);
    }
  }

  /** Reruns the analysis of the project on screen and refreshes the map in place. */
  reanalyze() {
    const project = this.app.serverProject;
    if (!project) return this.open();
    return this.analyze(project.path, project.settings, { background: true });
  }

  async toggleLive() {
    const project = this.app.serverProject;
    if (!project) return this.app.toast('Open a project first.');
    const enabled = !this.app.watching;
    try {
      await this.client.post('/api/watch', { enabled, path: project.path, settings: project.settings });
    } catch (error) {
      this.app.toast(error.message);
    }
  }

  async openRecent(entry) {
    try {
      const doc = await this.client.get('/api/cache/' + entry.key);
      this.app.load(doc);
      this.app.setServerProject({ path: entry.path, settings: entry.settings, key: entry.key });
      this.hide();
      if (entry.settings.watch) await this.client.post('/api/watch', { enabled: true, path: entry.path, settings: entry.settings });
    } catch (error) {
      this.app.toast(error.message + ' Analyzing it again.');
      this.analyze(entry.path, entry.settings);
    }
  }

  async removeRecent(entry) {
    try {
      await this.client.delete('/api/recent?path=' + encodeURIComponent(entry.path));
    } catch (error) {
      this.app.toast(error.message);
    }

    this.refreshRecent();
  }

  async refreshRecent() {
    try {
      this.recent = await this.client.get('/api/recent');
    } catch (error) {
      this.recent = [];
      this.app.toast(error.message);
    }

    clear(this.recentEl);
    if (!this.recent.length) {
      this.recentEl.append(h('div', { class: 'p-empty' }, 'Projects you analyze show up here and reopen instantly next time.'));
      return;
    }

    for (const entry of this.recent) {
      const s = entry.stats ?? {};
      const flags = [];
      if (!entry.settings.tests) flags.push('no tests');
      if (entry.settings.external) flags.push('external');
      if (entry.settings.typesOnly) flags.push('types only');
      if (entry.settings.watch) flags.push('live');
      this.recentEl.append(
        h('div', { class: 'p-recent-item' },
          h('div', { class: 'r-top' },
            h('span', { class: 'r-icon' }, ICONS[entry.kind === 'solution' ? 'solution' : entry.kind === 'project' ? 'project' : 'folder']),
            h('button', { class: 'r-name', title: 'Open the saved map', onClick: () => this.openRecent(entry) }, entry.name),
            h('span', { class: 'r-when' }, ago(entry.analyzedAt)),
          ),
          h('code', { class: 'r-path', title: entry.origin ?? entry.path }, h('span', { dir: 'ltr' }, entry.origin ?? entry.path)),
          h('div', { class: 'r-meta' },
            `${fmt(s.projects)} projects · ${fmt(s.types)} types · ${fmt(s.lines)} lines`,
            flags.length ? h('span', { class: 'r-flags' }, flags.join(' · ')) : null,
          ),
          h('div', { class: 'r-actions' },
            h('button', { class: 'small', onClick: () => this.openRecent(entry) }, 'Open'),
            h('button', { class: 'small', onClick: () => this.analyze(entry.path, { ...entry.settings }) }, 'Analyze again'),
            h('button', { class: 'small ghost', title: 'Remove from the list', onClick: () => this.removeRecent(entry) }, 'Remove'),
          ),
        ),
      );
    }
  }

  // ------------------------------------------------------------------ job progress

  showJob(job) {
    this.job = { ...job, log: job.log ? [...job.log] : [] };
    this.renderJob();
  }

  renderJob() {
    const job = this.job;
    if (!job) return this.jobEl.classList.add('hidden');
    this.jobEl.classList.remove('hidden');
    const running = job.status === 'running';
    const title = running ? `Analyzing ${shortPath(job.path)}…` : job.status === 'error' ? 'Analysis failed' : job.status === 'cancelled' ? 'Cancelled' : 'Done';
    this.logEl = h('pre', { class: 'j-log' }, job.log.slice(-300).join('\n'));
    clear(this.jobEl).append(
      h('div', { class: 'j-head' },
        running ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
        h('b', {}, title),
        h('span', { class: 'j-spacer' }),
        running
          ? h('button', { class: 'small', onClick: () => this.cancel() }, 'Cancel')
          : h('button', { class: 'small', onClick: () => ((this.job = null), this.renderJob()) }, 'Close'),
      ),
      job.error ? h('div', { class: 'j-error' }, job.error) : null,
      this.logEl,
    );
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  appendLog(line) {
    if (!this.job) return;
    this.job.log.push(line);
    if (this.job.log.length > 2000) this.job.log.splice(0, 1000);
    if (this.logEl) {
      this.logEl.textContent += (this.logEl.textContent ? '\n' : '') + line;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  /** Handles events streamed by the server. */
  async onEvent(event) {
    const app = this.app;
    switch (event.type) {
      case 'started':
        if (event.live) {
          app.setLiveStatus('Updating the map…');
        } else {
          if (!this.visible) await this.open();
          this.showJob({ id: event.jobId, path: event.path, status: 'running', log: [] });
        }

        break;
      case 'log':
        if (this.job?.id === event.jobId) this.appendLog(event.message);
        break;
      case 'done': {
        let doc;
        try {
          doc = await this.client.get(`/api/jobs/${event.jobId}/graph`);
        } catch (error) {
          app.toast(error.message);
          break;
        }

        const project = { path: event.path, settings: event.settings, key: event.key };
        if (event.live && app.model) {
          app.load(doc, { preserve: true });
          app.setLiveStatus(null);
        } else {
          app.load(doc);
          this.job = null;
          this.renderJob();
          this.hide();
        }

        app.setServerProject(project);
        this.refreshRecent();
        break;
      }
      case 'error':
        if (this.job?.id === event.jobId) {
          this.job.status = 'error';
          this.job.error = event.message;
          this.renderJob();
        } else {
          app.setLiveStatus(null);
          app.toast(`Analysis failed: ${event.message}`);
        }

        break;
      case 'cancelled':
        if (this.job?.id === event.jobId) {
          this.job.status = 'cancelled';
          this.renderJob();
        }

        app.setLiveStatus(null);
        break;
      case 'watch':
        app.setWatching(event.enabled ? event.path : null);
        break;
      case 'changed':
        app.setLiveStatus('Change detected, re-analyzing…');
        break;
      case 'watch-error':
        app.toast(`Live updates stopped: ${event.message}`);
        break;
      case 'disconnected':
        app.setConnection(false);
        break;
      case 'connected':
        app.setConnection(true);
        break;
    }
  }
}

function shortPath(path) {
  const parts = (path ?? '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || path;
}
