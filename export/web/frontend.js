/**
 * Frontend shell: the loading screen, title screen, and pause menu.
 *
 * The art comes from `zone/all/ui_mp.ff` via `.tools/export_ui.py`, layered in
 * the order the original `menu,main` linked it (backdrop, scrolling fog, glow,
 * logo plate). The layout is not the game's -- T6 menudefs do not dump -- so
 * the screens here are rebuilt around what this viewer actually has.
 *
 * The state machine is deliberately free of DOM access so it can be tested in
 * node; `elements` is optional and every write goes through `render()`.
 */

// Loader labels are internal asset names; the caption shows something a
// player can read. Unmapped labels fall through unchanged.
const CAPTIONS = {
  map: 'map geometry',
  textures: 'map textures',
  render: 'map scene',
  collision: 'collision',
  navigation: 'navigation mesh',
  shaders: 'compiling shaders',
  hands: 'viewhands',
  weapon: 'weapon',
  magazine: 'magazine',
  enemy: 'enemy body',
  'enemy weapon': 'enemy weapon',
};

export const SCREENS = ['loading', 'title', 'pause', 'error'];

export class Frontend {
  constructor({ elements = null, onPlay = null, onResume = null } = {}) {
    this.elements = elements;
    this.onPlay = onPlay;
    this.onResume = onResume;

    this.screen = 'loading';
    this.playing = false;
    this.loads = new Map();
    this.expected = new Map();
    this.finished = new Set();
    this.complete = false;
    this.peak = 0;
    this.message = '';
    this.controls = [];

    this.bindElements();
    this.render();
  }

  /** True while the shell covers the game. */
  get visible() {
    return !this.playing;
  }

  get ready() {
    return this.screen === 'title' || this.screen === 'pause';
  }

  /**
   * Declare the stages the load will run and their relative weight, keyed by
   * the same labels `progress()` receives.
   *
   * Byte totals alone cannot measure this load. GLTFLoader reports progress
   * for the .gltf JSON only -- neither the 44 MB buffer it references nor the
   * 59 MB of textures behind it reaches a callback -- so a pure byte bar fills
   * on a small fraction of the payload and then sits full. Fixed stage weights
   * give a denominator known from the first frame, and `stage()` is what
   * actually completes one.
   */
  expect(weights) {
    for (const [label, weight] of Object.entries(weights ?? {})) {
      if (Number(weight) > 0) this.expected.set(label, Number(weight));
    }
    this.render();
  }

  /** Mark a declared stage finished, whatever its bytes said. */
  stage(label) {
    if (!this.expected.has(label)) return false;
    this.finished.add(label);
    this.render();
    return true;
  }

  /** How far a stage's own byte reports have got it, 0..1. */
  stageBytes(label) {
    const entry = this.loads.get(label);
    if (!entry?.total) return 0;
    return Math.min(1, entry.loaded / entry.total);
  }

  /** Overall load fraction, 0..1. */
  get fraction() {
    if (this.complete) return 1;

    if (this.expected.size) {
      let value = 0;
      let total = 0;
      for (const [label, weight] of this.expected) {
        total += weight;
        // An unfinished stage is held short of its full weight however
        // encouraging its byte count looks, so the bar cannot claim a stage
        // whose unreported buffer is still in flight.
        value += weight * (this.finished.has(label) ? 1 : Math.min(0.9, this.stageBytes(label)));
      }
      return total ? value / total : 0;
    }

    // Undeclared fallback: loads register as they start, so the denominator
    // grows and a raw ratio can walk backwards. Hold the high-water mark.
    let loaded = 0;
    let total = 0;
    for (const entry of this.loads.values()) {
      if (!entry.total) continue;
      loaded += Math.min(entry.loaded, entry.total);
      total += entry.total;
    }
    if (total > 0) this.peak = Math.max(this.peak, loaded / total);
    return this.peak;
  }

  /**
   * True once something has reported a byte total to measure against. A host
   * serving chunked or gzipped responses sends no Content-Length, so there is
   * nothing to take a percentage of and the bar has to run indeterminate.
   */
  get determinate() {
    if (this.expected.size) return true;
    for (const entry of this.loads.values()) {
      if (entry.total) return true;
    }
    return false;
  }

  get loadedBytes() {
    let loaded = 0;
    for (const entry of this.loads.values()) loaded += entry.loaded;
    return loaded;
  }

  /**
   * What to name in the status line: the first stage still outstanding, or --
   * with no stages declared -- whichever source has the most work left.
   */
  get caption() {
    // Declared stages are named in declaration order rather than by bytes
    // outstanding: the map reports its .gltf complete long before its buffer
    // arrives, so byte counts would move the caption on while the biggest
    // download is still running.
    if (this.expected.size) {
      for (const label of this.expected.keys()) {
        if (!this.finished.has(label)) return CAPTIONS[label] ?? label;
      }
      return 'finishing up';
    }

    const determinate = this.determinate;
    let worst = null;
    let score = 0;
    for (const [label, entry] of this.loads) {
      // Once anything reports a total, sources that do not report one would
      // otherwise win on raw bytes and mislabel the bar.
      if (determinate && !entry.total) continue;
      const value = entry.total
        ? entry.total - Math.min(entry.loaded, entry.total)
        : entry.loaded;
      if (value > score) {
        score = value;
        worst = label;
      }
    }
    if (!worst) return this.loads.size ? 'finishing up' : 'connecting';
    return CAPTIONS[worst] ?? worst;
  }

  progress(label, event = {}) {
    if (this.screen !== 'loading') return;
    const loaded = Number(event.loaded) || 0;
    const total = Number(event.total) || 0;
    const entry = this.loads.get(label) ?? { loaded: 0, total: 0 };
    entry.loaded = Math.max(entry.loaded, loaded);
    entry.total = Math.max(entry.total, total);
    this.loads.set(label, entry);
    this.render();
  }

  /** Loading finished; show the title screen and wait for a key or a click. */
  setReady(controls = []) {
    if (this.screen === 'error') return;
    this.controls = controls.filter(Boolean);
    this.complete = true;
    this.screen = 'title';
    this.render();
  }

  fail(message) {
    this.screen = 'error';
    this.playing = false;
    this.message = String(message ?? 'Unable to start');
    this.render();
  }

  /**
   * Ask to start or resume. The shell deliberately stays up until the game
   * confirms with `enter()`: a pointer lock request can be refused, and a
   * hidden shell with no lock would leave nothing on screen to click.
   */
  play() {
    if (!this.ready) return false;
    if (this.screen === 'pause') this.onResume?.();
    else this.onPlay?.();
    return true;
  }

  /** Pointer lock was acquired, or automation took over. Drop the shell. */
  enter() {
    this.playing = true;
    this.render();
    return true;
  }

  /** Called when the game gives up pointer lock, by Esc or otherwise. */
  suspend() {
    if (!this.ready || !this.playing) return false;
    this.playing = false;
    this.screen = 'pause';
    this.render();
    return true;
  }

  /** Compact, serializable view for the debug API and smoke tests. */
  getState() {
    return {
      screen: this.screen,
      visible: this.visible,
      percent: Math.round(this.fraction * 100),
      caption: this.screen === 'loading' ? this.caption : '',
    };
  }

  // ---------- DOM ----------

  bindElements() {
    const el = this.elements;
    if (!el) return;
    // A click anywhere on the shell starts or resumes, matching the title
    // prompt. Buttons stop the event so they do not also trigger it.
    el.root?.addEventListener('click', () => this.play());
    for (const button of el.buttons ?? []) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.action(button.dataset.action);
      });
    }
  }

  /** Pause-menu buttons. `resume` is the only one the shell handles itself. */
  action(name) {
    if (name === 'resume') this.play();
    else this.elements?.onAction?.(name);
  }

  render() {
    const el = this.elements;
    if (!el) return;
    const loading = this.screen === 'loading';
    const determinate = !loading || this.determinate;

    if (el.root) {
      el.root.dataset.screen = this.screen;
      el.root.dataset.determinate = String(determinate);
      el.root.style.display = this.visible ? 'flex' : 'none';
      el.root.classList.toggle('ready', this.ready);
    }
    // An indeterminate bar is left to the stylesheet to sweep, so clear the
    // inline width rather than pinning it to a percentage that means nothing.
    if (el.bar) el.bar.style.width = determinate ? `${(this.fraction * 100).toFixed(1)}%` : '';
    if (el.percent) {
      el.percent.textContent = !loading ? ''
        : determinate ? `${Math.round(this.fraction * 100)}%`
        : `${(this.loadedBytes / 1048576).toFixed(1)} MB`;
    }
    if (el.caption) el.caption.textContent = loading ? `${this.caption}…` : '';
    if (el.message) el.message.textContent = this.message;
    if (el.controls && this.controls.length) el.controls.textContent = this.controls.join('\n');
  }
}
