/* Custom Cursor Autoscale — single-file build.
 * Everything lives in this one module (no sub-imports) on purpose: Foundry appends
 * ?v=<version> only to manifest-listed scripts, so sub-imports could be served stale
 * by edge caches (e.g. Cloudflare tunnels). Bumping the version busts this file. */

const MODULE_ID = "custom-cursor-autoscale";
const PACK_ROOT = `modules/${MODULE_ID}/cursors`;

/* Each entry drives one pair of CSS variables: --cursor-<key> and --cursor-<key>-down.
 * `frac` is the default hotspot as a fraction of the image size, so it survives downscaling. */
const CURSORS = [
  { key: "default", frac: { x: 0, y: 0 } },
  { key: "pointer", frac: { x: 0.5, y: 0 } },
  { key: "grab", frac: { x: 0.5, y: 0.5 } },
  /* Held/pressed state (clenched fist). Blank path = reuse the grab image. */
  { key: "grabDown", frac: { x: 0.5, y: 0.5 }, file: "grab-down", optional: true }
];

/* Bundled packs (folders under cursors/). Selecting one acts as a preset: it fills the
 * path settings, which remain the single source of truth for what gets loaded. */
const PACKS = ["knight-gpt", "knight-nano", "invincible", "invincible-brutal"];

function packPath(pack, key) {
  const file = CURSORS.find(c => c.key === key)?.file ?? key;
  return `${PACK_ROOT}/${pack}/${file}.png`;
}

function defaultHotspots() {
  return Object.fromEntries(CURSORS.map(c => [c.key, { ...c.frac }]));
}

function resolveCursorPath(key) {
  return game.settings.get(MODULE_ID, key);
}

function getHotspot(key) {
  const stored = game.settings.get(MODULE_ID, "hotspots")?.[key];
  const fallback = CURSORS.find(c => c.key === key).frac;
  return {
    x: Math.clamp(stored?.x ?? fallback.x, 0, 1),
    y: Math.clamp(stored?.y ?? fallback.y, 0, 1)
  };
}

const IDENTITY_TF = { rot: 0, flipX: false, flipY: false };

function getTransform(key) {
  const stored = game.settings.get(MODULE_ID, "transforms")?.[key];
  return { ...IDENTITY_TF, ...(stored ?? {}) };
}

function isIdentity(tf) {
  return !tf.rot && !tf.flipX && !tf.flipY;
}

/* key -> { up, down } CSS cursor value strings, rebuilt whenever settings change. */
const built = {};

/* True while the <html> cursor is armed with grab-down (pointerdown → pointerup). */
let rootArmed = false;

/* ---------------------------------------------------------------------------
 * Settings */

Hooks.once("init", () => {
  const fields = foundry.data.fields;
  const onChange = foundry.utils.debounce(rebuild, 100);

  game.settings.register(MODULE_ID, "pack", {
    name: "CCAS.Settings.Pack.Name",
    hint: "CCAS.Settings.Pack.Hint",
    scope: "world",
    config: true,
    type: new fields.StringField({
      initial: "knight-gpt",
      choices: {
        "knight-gpt": "CCAS.Pack.KnightGpt",
        "knight-nano": "CCAS.Pack.KnightNano",
        invincible: "CCAS.Pack.Invincible",
        "invincible-brutal": "CCAS.Pack.InvincibleBrutal",
        custom: "CCAS.Pack.Custom"
      }
    }),
    /* Selecting a bundled pack copies its paths into the path settings and resets
     * hotspots to the pack defaults. Only the GM writes, to avoid write races. */
    onChange: async pack => {
      if (PACKS.includes(pack) && game.user.isGM) {
        for (const c of CURSORS) await game.settings.set(MODULE_ID, c.key, packPath(pack, c.key));
        await game.settings.set(MODULE_ID, "hotspots", defaultHotspots());
      }
      onChange();
    }
  });

  game.settings.register(MODULE_ID, "maxSize", {
    name: "CCAS.Settings.MaxSize.Name",
    hint: "CCAS.Settings.MaxSize.Hint",
    scope: "world",
    config: true,
    type: new fields.NumberField({ integer: true, min: 16, max: 128, initial: 32 }),
    onChange
  });

  for (const c of CURSORS) {
    game.settings.register(MODULE_ID, c.key, {
      name: `CCAS.Settings.${c.key}.Name`,
      hint: `CCAS.Settings.${c.key}.Hint`,
      scope: "world",
      config: true,
      type: new fields.FilePathField({
        categories: ["IMAGE"],
        initial: packPath("knight-gpt", c.key),
        blank: true
      }),
      onChange
    });
  }

  game.settings.register(MODULE_ID, "hotspots", {
    scope: "world",
    config: false,
    type: new fields.ObjectField({ initial: defaultHotspots() }),
    onChange
  });

  /* Per-cursor image transform: rotation in degrees plus horizontal/vertical flips. */
  game.settings.register(MODULE_ID, "transforms", {
    scope: "world",
    config: false,
    type: new fields.ObjectField({ initial: {} }),
    onChange
  });

  game.settings.registerMenu(MODULE_ID, "hotspotEditor", {
    name: "CCAS.Menu.Hotspots.Name",
    label: "CCAS.Menu.Hotspots.Label",
    hint: "CCAS.Menu.Hotspots.Hint",
    icon: "fa-solid fa-crosshairs",
    type: HotspotEditor,
    restricted: true
  });
});

/* ---------------------------------------------------------------------------
 * Cursor building & application */

Hooks.once("ready", async () => {
  /* Self-heal: a bundled pack is selected but some path settings are blank (e.g. saved
   * by an older version of this module) — fill them from the pack. */
  if (game.user.isGM) {
    const pack = game.settings.get(MODULE_ID, "pack");
    if (PACKS.includes(pack)) {
      for (const c of CURSORS) {
        /* An optional cursor left blank means "reuse the base image" — don't refill it. */
        if (c.optional) continue;
        if (!game.settings.get(MODULE_ID, c.key)) {
          await game.settings.set(MODULE_ID, c.key, packPath(pack, c.key));
        }
      }
    }
  }

  /* Foundry writes cursors as --cursor-* CSS variables in Game#configureCursors, wiping
   * them on every theme/UI change. Data URLs cannot go through CONFIG.cursors (they fail
   * ImageHelper.hasImageExtension), so we re-apply our variables after every wipe. */
  if (typeof game.configureCursors === "function") {
    const original = game.configureCursors.bind(game);
    game.configureCursors = () => {
      original();
      applyVars();
    };
  }

  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  /* Dice So Nice grabs dice via document.documentElement.setPointerCapture(); during
   * pointer capture the browser shows the CAPTURING element's cursor, and <html> has
   * none (auto → system arrow). Priming <html> already on pointerdown removes the
   * few-frame flicker before gotpointercapture lands: the cursor of <html> is invisible
   * until something actually captures to it, so the priming itself has no side effect. */
  const root = document.documentElement;
  const armRootCursor = () => {
    rootArmed = true;
    root.style.cursor = "var(--cursor-grab-down)";
  };
  const disarmRootCursor = () => {
    rootArmed = false;
    root.style.cursor = built.default ? "var(--cursor-default)" : "";
  };
  /* These listeners sit on WINDOW capture, not document: on a successful die grab
   * Dice So Nice calls stopPropagation() in its own window-capture pointerdown
   * handler, so document-level listeners never see the event. Ours are registered
   * earlier (at ready, DSN registers when dice are shown), so they run first. */
  window.addEventListener("pointerdown", armRootCursor, true);
  window.addEventListener("pointerup", disarmRootCursor, true);
  window.addEventListener("pointercancel", disarmRootCursor, true);
  root.addEventListener("gotpointercapture", armRootCursor);
  root.addEventListener("lostpointercapture", disarmRootCursor);

  /* DSN raycasts the die under the pointer on every move (inputHandler.hoveredDie),
   * but confirms an actual grab only after an async physics-worker roundtrip — hence
   * the delayed cursor change. When the click happens over a hovered die, show the
   * grab cursor immediately instead of waiting for the confirmation. */
  for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
    window.addEventListener(type, onDieAffordance, true);
  }
  /* Browser zoom / moving the window to another display changes devicePixelRatio;
   * rebuild so the DPR clamp stays correct. Zoom also fires "resize". */
  window.addEventListener("resize", foundry.utils.debounce(rebuild, 300));
  rebuild();
});

async function rebuild() {
  /* Two Chromium safeguards silently swap large custom cursors for system ones:
   * - physical size (CSS px × devicePixelRatio) above 128 px is never rendered;
   * - anti-spoofing: cursors larger than 32×32 CSS px are HIDDEN whenever their
   *   rectangle would stick out past the window edge — which is exactly where
   *   Foundry puts the hotbar, player list and FPS meter (bottom of the screen).
   * So on Chromium the effective ceiling is 32 px; Firefox may go larger. */
  const isChromium = !!window.chrome;
  const dprLimit = Math.max(16, Math.floor(128 / (window.devicePixelRatio || 1)));
  const edgeSafe = isChromium ? 32 : dprLimit;
  const maxSize = Math.min(game.settings.get(MODULE_ID, "maxSize") || 32, edgeSafe, dprLimit);
  for (const c of CURSORS) {
    delete built[c.key];
    const path = resolveCursorPath(c.key);
    if (!path) continue;
    try {
      built[c.key] = await buildCursorValue(c.key, path, maxSize, getHotspot(c.key), getTransform(c.key));
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to load cursor image "${path}"`, err);
    }
  }
  if (typeof game.configureCursors === "function") game.configureCursors();
  else applyVars();
}

function applyVars() {
  const root = document.documentElement.style;
  /* grab-down prefers its own image (open hand vs clenched fist); the other
   * "-down" states reuse their base image. */
  const vars = {
    "default": built.default?.up,
    "default-down": built.default?.down,
    "pointer": built.pointer?.up,
    "pointer-down": built.pointer?.down,
    "grab": built.grab?.up,
    "grab-down": (built.grabDown ?? built.grab)?.down
  };
  for (const [name, value] of Object.entries(vars)) {
    if (value) root.setProperty(`--cursor-${name}`, value);
  }
  /* <html> must never expose a bare `auto`: during pointer-capture handoffs (PIXI board
   * capture → DSN's documentElement capture) Chromium can flash the capture target's
   * cursor for a frame, and html's default `auto` renders as the system arrow. */
  if (built.default && !rootArmed) root.cursor = "var(--cursor-default)";
}

async function buildCursorValue(key, path, maxSize, frac, tf = IDENTITY_TF) {
  const src = foundry.utils.getRoute(path);
  let img = await loadImage(src);
  let url = src;
  let w = img.width;
  let h = img.height;
  if (!isIdentity(tf)) {
    img = transformImage(img, tf);
    w = img.width;
    h = img.height;
    url = img.toDataURL("image/png");
  }
  if (Math.max(w, h) > maxSize) ({ url, w, h } = downscale(img, maxSize));
  const x = Math.round(frac.x * (w - 1));
  const y = Math.round(frac.y * (h - 1));
  const upKeyword = key === "grabDown" ? "grabbing" : key;
  const downKeyword = key === "grab" || key === "grabDown" ? "grabbing" : key;
  return {
    up: `url("${url}") ${x} ${y}, ${upKeyword}`,
    down: `url("${url}") ${x} ${y}, ${downKeyword}`
  };
}

/* Rotate (any angle, canvas grows to the rotated bounding box) and mirror the image. */
function transformImage(img, tf) {
  const rad = (tf.rot ?? 0) * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = Math.max(1, Math.round(img.width * cos + img.height * sin));
  const h = Math.max(1, Math.round(img.width * sin + img.height * cos));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.scale(tf.flipX ? -1 : 1, tf.flipY ? -1 : 1);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return canvas;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

/* Stepped halving before the final resize keeps small cursors crisp when the
 * source is much larger (e.g. 1024px art scaled to 32px). */
function downscale(img, maxSize) {
  const scale = maxSize / Math.max(img.width, img.height);
  const tw = Math.max(1, Math.round(img.width * scale));
  const th = Math.max(1, Math.round(img.height * scale));
  let cur = img;
  let cw = img.width;
  let ch = img.height;
  while (cw >= tw * 4 && ch >= th * 4) {
    cur = drawTo(cur, Math.floor(cw / 2), Math.floor(ch / 2));
    cw = cur.width;
    ch = cur.height;
  }
  const canvas = drawTo(cur, tw, th);
  return { url: canvas.toDataURL("image/png"), w: tw, h: th };
}

function drawTo(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/* ---------------------------------------------------------------------------
 * Hover remapper. Many stylesheets (systems, modules, the browser's own UA sheet)
 * set bare keywords like `cursor: pointer` that beat the inherited --cursor-*
 * variables. On hover we remap such elements to the matching variable and restore
 * their inline style on pointerout. `auto` gets remapped to the default cursor only
 * for non-selectable elements, so text keeps its I-beam. */

const KEYWORD_VARS = { default: "default", pointer: "pointer", grab: "grab", grabbing: "grab-down" };
const inlineBackup = new WeakMap();

function onPointerOver(event) {
  const el = event.composedPath()[0] ?? event.target;
  if (!(el instanceof HTMLElement) || el === canvas?.app?.view) return;
  const style = getComputedStyle(el);
  let keyword = style.cursor;
  if (keyword === "auto" && style.userSelect === "none") keyword = "default";
  const varName = KEYWORD_VARS[keyword];
  if (!varName) return;
  if (!built[keyword === "grabbing" ? "grab" : keyword]) return;
  if (!inlineBackup.has(el)) inlineBackup.set(el, el.style.cursor);
  el.style.cursor = `var(--cursor-${varName})`;
}

function onPointerOut(event) {
  const el = event.composedPath()[0] ?? event.target;
  if (!(el instanceof HTMLElement) || !inlineBackup.has(el)) return;
  el.style.cursor = inlineBackup.get(el);
  inlineBackup.delete(el);
}

/* --- grab affordance over Dice So Nice dice -------------------------------
 * The stamp is an attribute + a stylesheet rule with !important (see module.css):
 * inline writes lose to it, so PIXI re-setting the board's inline cursor during
 * the press cannot undo the stamp. No property patching involved. */
function onDieAffordance(event) {
  if (!built.grab) return;
  if (event.type === "pointerdown") {
    if (!game.dice3d?.box?.inputHandler?.hoveredDie) return;
    const el = event.composedPath()[0];
    if (!(el instanceof HTMLElement) || el === document.documentElement) return;
    el.setAttribute("data-ccas-grab", "");
  } else {
    for (const el of document.querySelectorAll("[data-ccas-grab]")) el.removeAttribute("data-ccas-grab");
  }
}

/* ---------------------------------------------------------------------------
 * Diagnostics: press Ctrl+Alt+D (or run ccasDebug() in the console) to toggle a
 * badge that follows the mouse and reports which cursor the hovered element
 * resolves to. (A chat command won't do: the v13+ parser rejects unknown
 * /commands before any hook can intercept them.) */

let debugEl = null;

Hooks.once("init", () => {
  game.keybindings.register(MODULE_ID, "debug", {
    name: "CCAS.Keybind.Debug.Name",
    hint: "CCAS.Keybind.Debug.Hint",
    editable: [{ key: "KeyD", modifiers: ["Control", "Alt"] }],
    onDown: () => {
      toggleCursorDebug();
      return true;
    }
  });
});

window.ccasDebug = () => toggleCursorDebug();

function toggleCursorDebug() {
  if (debugEl) {
    debugEl.remove();
    debugEl = null;
    document.removeEventListener("pointermove", onDebugMove, true);
    document.removeEventListener("keydown", onDebugKey, true);
    cancelAnimationFrame(debugRaf);
    return;
  }
  debugEl = document.createElement("div");
  Object.assign(debugEl.style, {
    position: "fixed", zIndex: 99999, pointerEvents: "none", padding: "2px 6px",
    font: "12px monospace", color: "#fff", borderRadius: "4px", whiteSpace: "nowrap"
  });
  document.body.append(debugEl);
  debugFull.length = 0;
  debugHistory.length = 0;
  debugLast = null;
  document.addEventListener("pointermove", onDebugMove, true);
  document.addEventListener("keydown", onDebugKey, true);
  debugRaf = requestAnimationFrame(debugSample);
  const v = game.modules.get(MODULE_ID)?.version;
  ui.notifications.info(`${MODULE_ID} v${v} | debug on (dpr ${window.devicePixelRatio})`);
}

const debugHistory = [];
const debugFull = [];
let debugLast = null;
let debugPos = { x: 0, y: 0 };
let debugRaf = 0;
let debugCaptured = false;

/* True only while something actually holds pointer capture on <html> (the DSN case). */
document.documentElement.addEventListener("gotpointercapture", () => { debugCaptured = true; });
document.documentElement.addEventListener("lostpointercapture", () => { debugCaptured = false; });

/* Sample every frame via elementFromPoint: catches cursor changes caused by hit-test
 * churn (pointer-events toggles, elements appearing under a stationary pointer) that
 * pointermove-driven sampling misses. */
function debugSample() {
  if (!debugEl) return;
  const root = document.documentElement;
  let el = document.elementFromPoint(debugPos.x, debugPos.y);
  let effective;
  if (debugCaptured) {
    effective = `CAPTURE ${root.style.cursor || getComputedStyle(root).cursor}`;
    el = root;
  } else if (el) {
    effective = getComputedStyle(el).cursor;
  }
  if (el && effective) recordDebug(effective, el);
  debugRaf = requestAnimationFrame(debugSample);
}

function recordDebug(effective, el) {
  const ours = effective.includes(`url("data:`) || effective.startsWith("CAPTURE var(");
  const short = effective.startsWith("CAPTURE") ? "CHWYT" :
    ours ? `MODUŁ(${effective.split(", ").pop()})` : effective.slice(0, 25);
  const elTag = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") +
    (el.classList?.length ? `.${el.classList[0]}` : "");
  const entry = `${short} @ ${elTag}`;
  if (entry === debugLast) return;
  debugLast = entry;
  debugHistory.push(`${Math.round(performance.now()) % 100000}ms ${short}`);
  if (debugHistory.length > 8) debugHistory.shift();
  debugFull.push(`${Math.round(performance.now())}ms ${short} @ ${elTag} [raw: ${effective.replace(/url\("data:[^"]+"\)\s*/g, "IMG ").slice(0, 60)}]`);
  console.debug(`${MODULE_ID} | cursor -> ${short} @ ${elTag}`);
  updateDebugBadge(short, elTag, ours);
}

function updateDebugBadge(short, elTag, ours) {
  if (!debugEl) return;
  debugEl.innerHTML = `${elTag} → ${short}`
    + `<br><span style="opacity:.75">${debugHistory.join(" · ")}</span>`;
  debugEl.style.background = ours ? "#075c2ccc" : "#8a1f1fcc";
}

/* With the badge active, pressing "c" copies the full cursor history to the clipboard
 * (and logs it), so it can be pasted instead of retyped. */
function onDebugKey(event) {
  if (event.key !== "c" || event.ctrlKey || event.altKey || event.metaKey) return;
  const t = event.target;
  if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName))) return;
  const text = debugFull.join("\n") || "(pusta historia)";
  console.log(`${MODULE_ID} | cursor history:\n${text}`);
  navigator.clipboard?.writeText(text)
    .then(() => ui.notifications.info(`${MODULE_ID} | historia kursora skopiowana do schowka (${debugFull.length} wpisów)`))
    .catch(() => ui.notifications.warn(`${MODULE_ID} | nie udało się skopiować — historia jest w konsoli`));
}

function onDebugMove(event) {
  if (!debugEl) return;
  debugPos = { x: event.clientX, y: event.clientY };
  debugEl.style.left = `${event.clientX + 18}px`;
  debugEl.style.top = `${event.clientY + 18}px`;
}

/* ---------------------------------------------------------------------------
 * Hotspot editor */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* Visual hotspot editor: click anywhere on a cursor image to place its active point. */
class HotspotEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ccas-hotspot-editor",
    tag: "div",
    classes: ["ccas-hotspot-editor"],
    window: {
      title: "CCAS.Editor.Title",
      icon: "fa-solid fa-crosshairs",
      contentClasses: ["standard-form"]
    },
    position: { width: 920, height: "auto" },
    actions: {
      reset: HotspotEditor.#onReset,
      save: HotspotEditor.#onSave,
      transform: HotspotEditor.#onTransform
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/hotspot-editor.hbs` }
  };

  /* Working copies; persisted only on Save. */
  #hotspots;
  #transforms;

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this.#hotspots ??= Object.fromEntries(CURSORS.map(c => [c.key, getHotspot(c.key)]));
    this.#transforms ??= Object.fromEntries(CURSORS.map(c => [c.key, getTransform(c.key)]));
    context.cursors = CURSORS.map(c => {
      const path = resolveCursorPath(c.key);
      const frac = this.#hotspots[c.key];
      return {
        key: c.key,
        label: game.i18n.localize(`CCAS.Cursor.${c.key}`),
        src: path ? foundry.utils.getRoute(path) : null,
        left: frac.x * 100,
        top: frac.y * 100,
        coords: this.#coordsText(frac),
        rot: this.#transforms[c.key].rot,
        angle: this.#angleText(this.#transforms[c.key])
      };
    });
    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const stage of this.element.querySelectorAll(".ccas-stage")) {
      stage.addEventListener("pointerdown", event => this.#onPick(event, stage));
    }
    for (const panel of this.element.querySelectorAll(".ccas-panel")) {
      panel.querySelector(".ccas-rot")?.addEventListener("change", event => {
        const tf = this.#transforms[panel.dataset.key];
        tf.rot = ((Math.round(Number(event.target.value) || 0) % 360) + 360) % 360;
        this.#updateStage(panel);
        this.#updatePreview(panel);
      });
      this.#updateStage(panel);
      this.#updatePreview(panel);
    }
  }

  /* Re-render the stage image with the working transform applied, so clicks and the
   * hotspot marker always refer to the image exactly as it will be used. */
  async #updateStage(panel) {
    const key = panel.dataset.key;
    const path = resolveCursorPath(key);
    const imgEl = panel.querySelector(".ccas-stage img");
    if (!path || !imgEl) return;
    const tf = this.#transforms[key];
    try {
      const img = await loadImage(foundry.utils.getRoute(path));
      imgEl.src = isIdentity(tf) ? img.src : transformImage(img, tf).toDataURL("image/png");
      const label = panel.querySelector(".ccas-angle");
      if (label) label.textContent = this.#angleText(tf);
      const input = panel.querySelector(".ccas-rot");
      if (input) input.value = tf.rot;
    } catch (err) {
      console.error(`${MODULE_ID} | Stage preview failed for "${path}"`, err);
    }
  }

  #angleText(tf) {
    return `${tf.flipX ? "↔" : ""}${tf.flipY ? "↕" : ""}` || "—";
  }

  #onPick(event, stage) {
    const img = stage.querySelector("img");
    const rect = img.getBoundingClientRect();
    const frac = {
      x: Math.clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: Math.clamp((event.clientY - rect.top) / rect.height, 0, 1)
    };
    const panel = stage.closest(".ccas-panel");
    this.#hotspots[panel.dataset.key] = frac;
    this.#refreshPanel(panel, frac);
  }

  #refreshPanel(panel, frac) {
    const marker = panel.querySelector(".ccas-marker");
    marker.style.left = `${frac.x * 100}%`;
    marker.style.top = `${frac.y * 100}%`;
    panel.querySelector(".ccas-coords").textContent = this.#coordsText(frac);
    this.#updatePreview(panel);
  }

  #coordsText(frac) {
    return `x: ${Math.round(frac.x * 100)}%  y: ${Math.round(frac.y * 100)}%`;
  }

  /* Apply the real downscaled cursor to the test strip so the hotspot can be felt live. */
  async #updatePreview(panel) {
    const key = panel.dataset.key;
    const path = resolveCursorPath(key);
    const preview = panel.querySelector(".ccas-preview");
    if (!path || !preview) return;
    try {
      const maxSize = game.settings.get(MODULE_ID, "maxSize") || 32;
      const value = await buildCursorValue(key, path, maxSize, this.#hotspots[key], this.#transforms[key]);
      preview.style.cursor = value.up;
    } catch (err) {
      console.error(`${MODULE_ID} | Preview failed for "${path}"`, err);
    }
  }

  static #onTransform(event, target) {
    const panel = target.closest(".ccas-panel");
    const key = panel.dataset.key;
    const tf = this.#transforms[key];
    const op = target.dataset.op;
    if (op === "flipx") tf.flipX = !tf.flipX;
    else if (op === "flipy") tf.flipY = !tf.flipY;
    else tf.rot = ((tf.rot + Number(op)) % 360 + 360) % 360;
    this.#updateStage(panel);
    this.#updatePreview(panel);
  }

  static #onReset(event, target) {
    const panel = target.closest(".ccas-panel");
    const key = panel.dataset.key;
    this.#hotspots[key] = { ...CURSORS.find(c => c.key === key).frac };
    this.#transforms[key] = { ...IDENTITY_TF };
    this.#refreshPanel(panel, this.#hotspots[key]);
    this.#updateStage(panel);
  }

  static async #onSave() {
    await game.settings.set(MODULE_ID, "hotspots", this.#hotspots);
    await game.settings.set(MODULE_ID, "transforms", this.#transforms);
    this.close();
  }
}
