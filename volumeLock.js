// NAME: Volume Lock
// DESCRIPTION: Caps Spotify's maximum volume behind a password. Lock button sits next to the volume control; password lives in Settings.
// VERSION: 1.3.0

(function () {
  const VERSION = "1.3.0";
  const REPO = "raidevss/Lock-Spotify";
  const UPDATE_KEY = "volume-lock:update"; // { version, code } downloaded by "Check for updates"

  const newer = (a, b) => {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };

  // Boot: if a newer version was downloaded in-app, run that instead of this installed file.
  if (window.__volumeLockStarted) return;
  if (!window.__volumeLockFromCache) {
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(UPDATE_KEY) || "null");
    } catch {}
    if (cached?.code && newer(cached.version, VERSION)) {
      window.__volumeLockFromCache = true;
      try {
        new Function(cached.code)();
      } catch (e) {
        console.error("[Volume Lock] downloaded update failed, using installed version", e);
      }
      window.__volumeLockFromCache = false;
      if (window.__volumeLockStarted) return;
    } else if (cached) {
      localStorage.removeItem(UPDATE_KEY); // installed file is same or newer
    }
  }
  window.__volumeLockStarted = VERSION;

  async function fetchLatest() {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/volumeLock.js?ref=main`, {
      headers: { Accept: "application/vnd.github.raw" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const code = await res.text();
    const version = code.match(/^\/\/ VERSION:\s*([\d.]+)/m)?.[1];
    if (!version) throw new Error("No version found in downloaded file");
    return { version, code };
  }

  volumeLock();

function volumeLock() {
  const S = window.Spicetify;
  if (!S?.Player?.getVolume || !S.Platform?.PlaybackAPI?.setVolume || !S.LocalStorage || !document.body) {
    setTimeout(volumeLock, 300);
    return;
  }

  const KEY = "volume-lock:v1";
  const EPS = 0.005;
  const STEP = 0.1;
  const MAX_TRIES = 5;
  const LOCKOUT_MS = 30_000;
  const MIN_PW = 4;
  // Hidden reset code (for a forgotten password), stored only as a hash.
  const MASTER = "b80891e3595eb9a059614cd39d86d10ad57660344c88ef7b0b544603cd3f82c3";

  // ---------- state ----------
  const state = load();

  function load() {
    const fresh = { locked: false, max: 1, hash: null, salt: null, fails: 0, until: 0 };
    try {
      const s = JSON.parse(S.LocalStorage.get(KEY) || "{}");
      return { ...fresh, ...s, locked: !!s.locked && typeof s.max === "number" && !!s.hash };
    } catch {
      return fresh;
    }
  }
  const save = () => S.LocalStorage.set(KEY, JSON.stringify(state));
  const pct = (v) => `${Math.round(v * 100)}%`;

  async function sha(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const checkPassword = async (pw) => !!state.hash && (await sha(`${state.salt}:${pw}`)) === state.hash;
  const checkMaster = async (pw) => (await sha(`volume-lock-master:${pw}`)) === MASTER;

  // Shared brute-force throttle for every password prompt.
  const lockedOutFor = () => Math.max(0, state.until - Date.now());
  function recordFailure() {
    state.fails += 1;
    if (state.fails >= MAX_TRIES) {
      state.fails = 0;
      state.until = Date.now() + LOCKOUT_MS;
    }
    save();
  }
  function recordSuccess() {
    state.fails = 0;
    state.until = 0;
  }
  const tooManyMsg = () => `Too many attempts. Try again in ${Math.ceil(lockedOutFor() / 1000)}s.`;

  // ---------- volume enforcement ----------
  // Every volume change in Spotify (slider, scroll, mute, Ctrl+Up/Down, other extensions)
  // goes PlaybackAPI -> _playbackService. We clamp at both layers, correct anything external
  // (Connect devices, OS media volume) on the "volume" event, and clamp the slider's pointer
  // input so its knob can't be dragged past the cap.
  const api = S.Platform.PlaybackAPI;
  const svc = api._playbackService;

  const getVol = () => {
    const v = typeof api._volume === "number" ? api._volume : S.Player.getVolume();
    return typeof v === "number" && v >= 0 ? v : 0;
  };
  const capped = (v) => (state.locked && v > state.max ? state.max : v);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // Layer 1: the native playback service.
  if (svc?.setVolume) {
    const orig = svc.setVolume.bind(svc);
    svc.setVolume = (req, ...rest) => {
      if (state.locked && typeof req?.volume === "number" && req.volume > state.max) {
        req = { ...req, volume: state.max };
      }
      return orig(req, ...rest);
    };
  }
  if (svc?.raiseVolume && svc?.setVolume) {
    const orig = svc.raiseVolume.bind(svc);
    svc.raiseVolume = (req, ...rest) =>
      state.locked ? svc.setVolume({ ...req, volume: Math.min(getVol() + STEP, state.max) }) : orig(req, ...rest);
  }

  // Layer 2: the public PlaybackAPI.
  const apiSet = api.setVolume.bind(api);
  api.setVolume = (v, ...rest) => apiSet(typeof v === "number" ? capped(v) : v, ...rest);
  if (api.raiseVolume) {
    const orig = api.raiseVolume.bind(api);
    api.raiseVolume = (...a) => (state.locked ? api.setVolume(Math.min(getVol() + STEP, state.max)) : orig(...a));
  }
  const setVol = (v) => api.setVolume(clamp01(capped(v)));

  // Layer 3: instant correction for changes that come from outside the app.
  function enforce() {
    if (state.locked && getVol() > state.max + EPS) setVol(state.max);
  }
  try {
    (api.getEvents?.() ?? api._events)?.addListener?.("volume", enforce);
  } catch {}
  setInterval(enforce, 250); // backstop only

  // Layer 4: clamp pointer coordinates on the slider before Spotify reads them.
  // The track is measured once per drag (on press) so moves never force an extra layout.
  // Spotify renames these between versions, so try several and fall back to geometry.
  const BAR = '[data-testid="volume-bar"], .volume-bar';
  const TRACK_SELECTORS = [
    '[data-testid="progress-bar-background"]',
    '.x-progressBar-progressBarBg',
    '[data-testid="progress-bar"]',
    '.progress-bar',
  ];
  const forwarded = new WeakSet();
  let dragRect = null;
  let dragBar = null;

  const closest = (e, sel) => (e.target instanceof Element ? e.target.closest(sel) : null);
  const findBar = () => document.querySelector(BAR);

  function findTrack(bar) {
    for (const sel of TRACK_SELECTORS) {
      const t = bar.querySelector(sel);
      if (t && t.getBoundingClientRect().width) return t;
    }
    // Fallback: the longest thin element in the volume bar that isn't a button.
    let best = null;
    let bestLen = 0;
    for (const d of bar.querySelectorAll("div")) {
      if (d.closest("button")) continue;
      const r = d.getBoundingClientRect();
      const len = Math.max(r.width, r.height);
      if (len > bestLen && Math.min(r.width, r.height) <= 24) {
        best = d;
        bestLen = len;
      }
    }
    return best;
  }
  // The slider part of the volume bar (not the mute button, not our lock button).
  function sliderBar(e) {
    const bar = closest(e, BAR);
    if (!bar || closest(e, "button") || closest(e, ".vl-btn")) return null;
    return bar;
  }

  // If the knob is drawn above the cap but the volume didn't change, Spotify never
  // re-renders it. Nudge the volume so the slider snaps back to the real level.
  function snapSlider(bar, onlyIfKnown = false) {
    if (!state.locked) return;
    const input = bar?.querySelector('input[type="range"]');
    if (!input && onlyIfKnown) return;
    if (input) {
      const max = Number(input.max) || 1;
      if (Number(input.value) / max <= state.max + EPS) return;
    }
    const target = Math.min(getVol(), state.max);
    apiSet(Math.max(0, target - 0.01));
    setTimeout(() => apiSet(target), 60);
  }

  function clampPointer(e, r) {
    if (!r.width || !r.height) return;
    const vertical = r.height > r.width; // mini player rotates the slider
    const f = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    if (f <= state.max) return;
    e.stopImmediatePropagation();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: e.view,
      button: e.button,
      buttons: e.buttons,
      screenX: e.screenX,
      screenY: e.screenY,
      clientX: vertical ? e.clientX : r.left + state.max * r.width,
      clientY: vertical ? r.bottom - state.max * r.height : e.clientY,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      isPrimary: e.isPrimary,
    };
    const clone = e instanceof PointerEvent ? new PointerEvent(e.type, init) : new MouseEvent(e.type, init);
    forwarded.add(clone);
    (e.target instanceof Node && e.target.isConnected ? e.target : document).dispatchEvent(clone);
  }

  function onDown(e) {
    if (forwarded.has(e) || !state.locked) return;
    const bar = sliderBar(e);
    const track = bar && findTrack(bar);
    if (!track) return;
    if (e.type === "pointerdown" || !dragRect) {
      dragRect = track.getBoundingClientRect();
      dragBar = bar;
    }
    clampPointer(e, dragRect);
  }
  function onMove(e) {
    if (forwarded.has(e) || !dragRect || !state.locked) return;
    clampPointer(e, dragRect);
  }
  function onUp(e) {
    if (forwarded.has(e) || !dragRect) return;
    if (state.locked) clampPointer(e, dragRect);
    const bar = dragBar;
    dragRect = null;
    dragBar = null;
    setTimeout(() => snapSlider(bar), 50);
  }
  for (const t of ["pointerdown", "mousedown"]) window.addEventListener(t, onDown, true);
  for (const t of ["pointermove", "mousemove"]) window.addEventListener(t, onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("pointercancel", () => (dragRect = dragBar = null), true);
  // Mouse wheel over the slider: Spotify can move the knob before the clamp applies.
  window.addEventListener("wheel", (e) => {
    const bar = state.locked && closest(e, BAR);
    if (bar) setTimeout(() => snapSlider(bar), 80);
  }, true);
  // Backstop for anything else that leaves the knob above the cap.
  setInterval(() => {
    if (state.locked && !dragRect) snapSlider(findBar(), true);
  }, 1000);

  // Keyboard on the focused slider (arrow keys / PageUp / End).
  window.addEventListener(
    "keydown",
    (e) => {
      if (!state.locked || !sliderBar(e)) return;
      const up = { ArrowUp: STEP, ArrowRight: STEP, PageUp: STEP, End: 1 }[e.key];
      if (up === undefined) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setVol(e.key === "End" ? 1 : getVol() + up);
    },
    true,
  );

  function lock() {
    if (getVol() <= 0) {
      S.showNotification?.("Turn the volume up to the level you want, then lock", true);
      return;
    }
    state.max = Math.round(getVol() * 100) / 100;
    state.locked = true;
    save();
    render();
    S.showNotification?.(`Volume locked at ${pct(state.max)}`);
  }
  function unlock(silent) {
    state.locked = false;
    save();
    render();
    if (!silent) S.showNotification?.("Volume unlocked");
  }

  // ---------- styles ----------
  // Dialogs reuse Spotify's own "Edit details" modal classes, so they follow the active theme.
  const style = document.createElement("style");
  style.id = "volume-lock-style";
  style.textContent = `
.vl-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;
  width:32px;height:32px;padding:0;margin-right:4px;border:0;border-radius:50%;background:transparent;
  color:var(--text-subdued,#b3b3b3);cursor:pointer;transition:color .1s,transform .1s}
.vl-btn:hover{color:var(--text-base,#fff);transform:scale(1.04)}
.vl-btn:active{transform:scale(1)}
.vl-btn:focus-visible{outline:2px solid #fff;outline-offset:-2px}
.vl-btn svg{width:16px;height:16px;display:block}
.vl-btn.vl-active{color:var(--text-bright-accent,#1ed760)}
.vl-btn.vl-active:hover{color:#3be477}
.vl-btn.vl-active::after{content:"";position:absolute;left:50%;bottom:1px;width:4px;height:4px;
  border-radius:50%;background:currentColor;transform:translateX(-50%)}

.vl-secret{cursor:default;user-select:none;-webkit-user-select:none}
.x-settings-row[hidden]{display:none!important}
.vl-root{position:fixed;inset:0;z-index:1000}
.vl-root .main-playlistEditDetailsModal-container{width:400px;max-width:calc(100vw - 32px);min-height:0}
.vl-form{display:flex;flex-direction:column;gap:12px;margin:0;padding:0 24px 24px}
.vl-note{margin:0;color:var(--spice-subtext)}
.vl-form input::placeholder{color:var(--spice-subtext)}
.vl-error{margin:0;color:#f3727f}
.vl-error:empty{display:none}
.vl-actions{display:flex;justify-content:flex-end;margin-top:4px}
.vl-primary{min-height:48px;padding:8px 32px;border:0;border-radius:9999px;background:var(--spice-text,#fff);
  color:var(--spice-main,#000);cursor:pointer;transition:transform .1s}
.vl-primary:hover{transform:scale(1.04)}
.vl-primary:active{transform:scale(1)}
.vl-primary:disabled{opacity:.6;cursor:default;transform:none}
`;
  document.head.appendChild(style);

  // ---------- icons ----------
  const ICON_LOCKED = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
    <path d="M5 7V4.75a3 3 0 0 1 6 0V7"/><rect x="2.75" y="7" width="10.5" height="7.25" rx="1.5" fill="currentColor"/></svg>`;
  const ICON_UNLOCKED = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
    <path d="M5 7V4.75a3 3 0 0 1 5.8-1.1"/><rect x="2.75" y="7" width="10.5" height="7.25" rx="1.5"/></svg>`;
  const ICON_CLOSE = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z"/></svg>`;

  // ---------- DOM helpers ----------
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  // ---------- modal (Spotify's Edit-details look) ----------
  let modal = null;
  function closeModal() {
    modal?.remove();
    modal = null;
    document.removeEventListener("keydown", onModalKey, true);
  }
  function onModalKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeModal();
    }
  }
  function openModal(title, form, focus) {
    closeModal();
    const closeBtn = el("button", { type: "button", className: "main-playlistEditDetailsModal-closeBtn", innerHTML: ICON_CLOSE, onclick: closeModal });
    closeBtn.setAttribute("aria-label", "Close");
    const card = el(
      "div",
      { className: "main-playlistEditDetailsModal-container" },
      el("div", { className: "main-playlistEditDetailsModal-header" }, el("h1", { className: "encore-text-title-small", textContent: title }), closeBtn),
      form,
    );
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", title);
    const overlay = el("div", { className: "GenericModal__overlay" }, card);
    overlay.addEventListener("mousedown", (e) => e.target === overlay && closeModal());
    modal = el("div", { className: "vl-root" }, overlay);
    document.body.appendChild(modal);
    document.addEventListener("keydown", onModalKey, true);
    requestAnimationFrame(() => focus?.focus());
  }

  function pwInput(placeholder, autocomplete) {
    const input = el("input", {
      type: "password",
      className: "main-playlistEditDetailsModal-titleInput main-playlistEditDetailsModal-textElement",
      placeholder,
      autocomplete,
      spellcheck: false,
    });
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("input", () => input.classList.remove("main-playlistEditDetailsModal-textElementError"));
    return input;
  }
  const markBad = (input) => {
    input?.classList.add("main-playlistEditDetailsModal-textElementError");
    input?.focus();
  };

  // Builds a password form: note line, inputs, inline error, one primary button.
  function passwordForm({ note, inputs, button, onSubmit }) {
    const err = el("p", { className: "vl-error encore-text-body-small" });
    err.setAttribute("role", "alert");
    const submit = el("button", { type: "submit", className: "vl-primary encore-text-body-medium-bold", textContent: button });
    const form = el(
      "form",
      { className: "vl-form" },
      note ? el("p", { className: "vl-note encore-text-body-small", textContent: note }) : null,
      ...inputs,
      err,
      el("div", { className: "vl-actions" }, submit),
    );
    const fail = (msg, input) => {
      err.textContent = msg;
      if (input) {
        input.value = "";
        markBad(input);
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      submit.disabled = true;
      try {
        await onSubmit(fail);
      } finally {
        submit.disabled = false;
      }
    };
    return form;
  }

  // ---------- flows ----------
  function openUnlock() {
    const pw = pwInput("Password", "current-password");
    const form = passwordForm({
      note: `Volume is capped at ${pct(state.max)}.`,
      inputs: [pw],
      button: "Unlock",
      onSubmit: async (fail) => {
        if (lockedOutFor()) return fail(tooManyMsg());
        if (!(await checkPassword(pw.value))) {
          recordFailure();
          return fail(lockedOutFor() ? tooManyMsg() : "Wrong password.", pw);
        }
        recordSuccess();
        closeModal();
        unlock();
      },
    });
    openModal("Unlock volume", form, pw);
  }

  function openSetPassword({ lockAfter = false } = {}) {
    const hasPw = !!state.hash;
    const cur = hasPw ? pwInput("Current password", "current-password") : null;
    const next = pwInput(hasPw ? "New password" : "Password", "new-password");
    const confirm = pwInput("Confirm password", "new-password");
    const form = passwordForm({
      note: lockAfter ? "Set a password to unlock with." : null,
      inputs: [cur, next, confirm].filter(Boolean),
      button: lockAfter ? "Lock" : "Save",
      onSubmit: async (fail) => {
        if (cur) {
          if (lockedOutFor()) return fail(tooManyMsg());
          if (!(await checkPassword(cur.value))) {
            recordFailure();
            return fail(lockedOutFor() ? tooManyMsg() : "Current password is wrong.", cur);
          }
        }
        if (next.value.length < MIN_PW) return fail(`Use at least ${MIN_PW} characters.`, next);
        if (next.value !== confirm.value) return fail("Passwords don't match.", confirm);
        state.salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
        state.hash = await sha(`${state.salt}:${next.value}`);
        recordSuccess();
        save();
        closeModal();
        refreshSettings();
        if (lockAfter) lock();
        else S.showNotification?.("Password saved");
      },
    });
    openModal(hasPw ? "Change password" : "Set password", form, cur ?? next);
  }

  function openReset() {
    const cur = pwInput("Current password", "current-password");
    const form = passwordForm({
      note: "Removes the password and unlocks the volume.",
      inputs: [cur],
      button: "Reset",
      onSubmit: async (fail) => {
        if (lockedOutFor()) return fail(tooManyMsg());
        const ok = (await checkPassword(cur.value)) || (await checkMaster(cur.value));
        if (!ok) {
          recordFailure();
          return fail(lockedOutFor() ? tooManyMsg() : "Wrong password.", cur);
        }
        recordSuccess();
        state.hash = null;
        state.salt = null;
        closeModal();
        unlock(true);
        refreshSettings();
        S.showNotification?.("Password reset. Volume unlocked");
      },
    });
    openModal("Reset password", form, cur);
  }

  // ---------- updates ----------
  async function checkForUpdates(e) {
    const button = e.currentTarget;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const latest = await fetchLatest();
      const running = window.__volumeLockStarted || VERSION;
      if (!newer(latest.version, running)) {
        S.showNotification?.(`Volume Lock is up to date (v${running})`);
        return;
      }
      // Sanity-check the download before keeping it.
      new Function(latest.code);
      localStorage.setItem(UPDATE_KEY, JSON.stringify(latest));
      S.showNotification?.(`Updated to v${latest.version}. Reloading…`);
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      console.error("[Volume Lock] update check failed", err);
      S.showNotification?.("Couldn't check for updates. Check the internet connection.", true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  // ---------- Settings page section ----------
  // Class names are copied from Spotify's own Settings rows at runtime (they're hashed per version).
  let settingsSection = null;
  function settingsClasses(container) {
    const h2 = container.querySelector(".x-settings-section h2");
    const label = container.querySelector(".x-settings-firstColumn label");
    const marginal = container.querySelector(".x-settings-firstColumn span.encore-text-marginal");
    const button = [...container.querySelectorAll(".x-settings-secondColumn button")].find((b) => /secondary/.test(b.className));
    return {
      h2: h2?.className || "encore-text-body-medium-bold",
      label: label?.className || "encore-text-body-small",
      marginal: marginal?.className || "encore-text-marginal",
      button: (button?.className || "vl-primary encore-text-body-small-bold").replace(/\s?e-\d+-button--trailing/, ""),
    };
  }
  function settingsRow(cls, labelText, desc, btnText, onClick) {
    return el(
      "div",
      { className: "x-settings-row" },
      el(
        "div",
        { className: "x-settings-firstColumn x-settings-firstColumnFlexCol" },
        el("label", { className: cls.label, textContent: labelText }),
        el("span", { className: cls.marginal, textContent: desc }),
      ),
      el("div", { className: "x-settings-secondColumn" }, el("button", { type: "button", className: cls.button, textContent: btnText, onclick: onClick })),
    );
  }
  function buildSettings(container) {
    const cls = settingsClasses(container);
    const section = el("div", { className: "x-settings-section vl-settings" }, el("h2", { className: cls.h2, textContent: "Volume lock" }));
    if (state.hash) {
      const changeRow = settingsRow(cls, "Change password", "The password used to unlock the volume.", "Change", () => openSetPassword());
      const resetRow = settingsRow(cls, "Reset password", "Removes the password and unlocks the volume.", "Reset", openReset);
      resetRow.hidden = true;
      // Hidden shortcuts on the "Change password" label (no cursor or selection hint):
      //   triple-click        -> reveal "Reset password"
      //   Shift + triple-click -> toggle the lock (unlock if locked, lock at current volume if not)
      const label = changeRow.querySelector("label");
      label.classList.add("vl-secret");
      label.addEventListener("click", (e) => {
        if (e.detail !== 3) return;
        if (!e.shiftKey) resetRow.hidden = false;
        else if (state.locked) unlock();
        else lock();
      });
      section.append(changeRow, resetRow);
    } else {
      section.append(settingsRow(cls, "Password", "Set a password to lock the volume with.", "Set password", () => openSetPassword()));
    }
    const running = window.__volumeLockStarted || VERSION;
    const updatesRow = settingsRow(cls, "Updates", `Version ${running}`, "Check for updates", checkForUpdates);
    section.append(updatesRow);
    return section;
  }
  // Spotify's Settings markup changes between versions,
  // so look for the container several ways.
  function findSettingsContainer() {
    const direct = document.querySelector(".x-settings-container, [data-testid='settings-page']");
    if (direct) return direct;
    const path = S.Platform?.History?.location?.pathname || location.pathname || "";
    if (!/preferences|settings/i.test(path)) return null;
    const section = document.querySelector(".x-settings-section");
    if (section?.parentElement) return section.parentElement;
    // Fallback: the nearest element that holds the first few section headings.
    const heads = [...document.querySelectorAll("main h2, .main-view-container h2")].filter((h) => !h.closest(".vl-settings"));
    if (heads.length < 3) return null;
    let node = heads[0].parentElement;
    while (node && !(node.contains(heads[1]) && node.contains(heads[2]))) node = node.parentElement;
    return node;
  }
  function mountSettings() {
    const container = findSettingsContainer();
    if (!container) {
      settingsSection = null;
      return;
    }
    if (settingsSection?.isConnected && settingsSection.parentElement === container) return;
    settingsSection = buildSettings(container);
    const sections = [...container.children].filter((s) => s !== settingsSection && s.querySelector("h2"));
    const anchor = sections.find((s) => /^playback$/i.test(s.querySelector("h2")?.textContent.trim() ?? ""));
    if (anchor) anchor.after(settingsSection);
    else container.append(settingsSection);
  }
  function refreshSettings() {
    settingsSection?.remove();
    settingsSection = null;
    mountSettings();
  }

  // ---------- playbar button ----------
  const btn = el("button", { type: "button", className: "vl-btn" });
  const tip = S.Tippy && S.TippyProps ? S.Tippy(btn, { ...S.TippyProps, content: "" }) : null;

  btn.addEventListener("click", () => {
    if (state.locked) openUnlock();
    else if (!state.hash) openSetPassword({ lockAfter: true });
    else lock();
  });

  function render() {
    btn.innerHTML = state.locked ? ICON_LOCKED : ICON_UNLOCKED;
    btn.classList.toggle("vl-active", state.locked);
    const label = state.locked ? `Volume locked at ${pct(state.max)}` : "Lock volume at current level";
    btn.setAttribute("aria-label", label);
    if (tip) tip.setContent(label);
    else btn.title = label;
  }

  function mountButton() {
    const vb = document.querySelector(BAR) || document.querySelector(".volume-bar");
    if (vb?.parentElement && btn.nextElementSibling !== vb) vb.parentElement.insertBefore(btn, vb);
  }

  // Spotify re-renders the playbar and settings page; keep our nodes attached.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      mountButton();
      mountSettings();
    });
  }).observe(document.body, { childList: true, subtree: true });

  render();
  mountButton();
  mountSettings();
  enforce();
}
})();
