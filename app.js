import { HydroTagDB } from "./firebase-config.js";

// ============================================================================
// CONSTANTES (basadas en la presentación "Hidratación en el Deporte")
// ============================================================================

const ARMSTRONG_SCALE = [
  { score: 1, color: "#F9FCE8", textDark: true, label: "Muy clara · bien hidratado" },
  { score: 2, color: "#F4F7BE", textDark: true, label: "Clara · bien hidratado" },
  { score: 3, color: "#EFE884", textDark: true, label: "Amarillo claro · normal" },
  { score: 4, color: "#E7D352", textDark: true, label: "Amarillo · límite" },
  { score: 5, color: "#DCB62F", textDark: true, label: "Amarillo oscuro · poca agua" },
  { score: 6, color: "#C9971C", textDark: false, label: "Ámbar · deshidratación" },
  { score: 7, color: "#AE7818", textDark: false, label: "Ámbar oscuro · deshidratación" },
  { score: 8, color: "#845514", textDark: false, label: "Marrón · deshidratación severa" }
];

const THIRST_LABELS = { baja: "Nada", moderada: "Un poco", alta: "Mucha" };

const NA_MG_PER_G_SALT = 393; // 1 g de sal de mesa = 393 mg de sodio
const PRE_ML_PER_KG_MIN = 6; // 6 a 8 mL/kg, 2 a 4 h antes
const PRE_ML_PER_KG_MAX = 8;
const DEFAULT_THERMO_ML = 750;
const DEFAULT_REMINDER_MIN = 10;
const DRAFT_PREFIX = "hydrotag_draft_v1_";
const LAST_SCAN_PREFIX = "hydrotag_last_scan_v1_";
const NFC_DEBOUNCE_MS = 4000;

// ============================================================================
// UTILIDADES
// ============================================================================

const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeAthleteId(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_-]/g, "");
}

function formatMl(val) {
  const num = Number(val) || 0;
  if (Math.abs(num - Math.round(num)) < 0.01) return Math.round(num).toLocaleString("es-MX");
  return Number(num.toFixed(1)).toLocaleString("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function buildNfcUrl(athleteId) {
  const cleanId = sanitizeAthleteId(athleteId) || "PX_01";
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("id", cleanId);
  return url.toString();
}

function formatStopwatch(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return [hrs, mins, secs].map((n) => String(n).padStart(2, "0")).join(":");
}

function formatMinSec(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(totalSec / 60)).padStart(2, "0")}:${String(totalSec % 60).padStart(2, "0")}`;
}

function createSessionId(athleteId) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SES_${athleteId}_${stamp}_${rand}`;
}

// Chips: seleccionado = oscuro, no seleccionado = blanco con borde sutil
function setChip(btn, active) {
  const on = ["border-slate-900", "bg-slate-900", "text-white", "shadow-sm"];
  const off = ["border-slate-200", "bg-white", "text-slate-700"];
  if (active) {
    btn.classList.remove(...off);
    btn.classList.add(...on);
  } else {
    btn.classList.remove(...on);
    btn.classList.add(...off);
  }
}

function replayAnimation(el, animClass) {
  if (!el) return;
  el.classList.remove(animClass);
  void el.offsetWidth;
  el.classList.add(animClass);
}

function setDrawerOpen(open) {
  const drawer = $("profile-edit-drawer");
  const chevron = $("profile-edit-chevron");
  const toggleBtn = $("btn-toggle-profile-edit");
  if (!drawer) return;
  drawer.classList.toggle("is-open", open);
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (chevron) chevron.classList.toggle("rotate-180", open);
}

function createDefaultDraft(athleteId) {
  return {
    sessionId: createSessionId(athleteId),
    activePhase: 1,
    pesoPreKg: "",
    orinaArmstrong: 2,
    nivelSed: "baja",
    duracionMin: "",
    consumoMl: 0,
    intakeLogs: [],
    pesoPostKg: "",
    orinaEvacuadaMl: 0,
    timerRunning: false,
    timerStartMs: null,
    timerAccumulatedMs: 0,
    lastBeepIdx: 0,
    isoFactor: 1.5,
    lastResult: null
  };
}

function loadDraft(athleteId) {
  try {
    const raw = localStorage.getItem(`${DRAFT_PREFIX}${athleteId}`);
    if (!raw) return createDefaultDraft(athleteId);
    const parsed = JSON.parse(raw);
    return {
      ...createDefaultDraft(athleteId),
      ...parsed,
      intakeLogs: Array.isArray(parsed.intakeLogs) ? parsed.intakeLogs : []
    };
  } catch {
    return createDefaultDraft(athleteId);
  }
}

function saveDraft(athleteId, draft) {
  if (!athleteId) return;
  try {
    localStorage.setItem(`${DRAFT_PREFIX}${athleteId}`, JSON.stringify(draft));
  } catch {
    // almacenamiento no disponible
  }
}

// ============================================================================
// ESTADO
// ============================================================================

const appState = {
  route: "onboarding",
  athleteId: null,
  athleteProfile: null,
  draft: null,
  timerIntervalId: null,
  adminUnsubscribe: null,
  adminAthletesUnsubscribe: null,
  adminSessions: [],
  adminLiveAthletes: [],
  lastAutoScanIndex: null,
  lastIntakeDisplayedMl: null,
  deferredInstallPrompt: null,
  thermoSaveTimeout: null,
  suggestion: null
};

// ============================================================================
// UI BASE
// ============================================================================

let toastTimeout = null;
function showToast(message) {
  const banner = $("toast-banner");
  banner.textContent = message;
  banner.classList.remove("opacity-0", "translate-y-2");
  banner.classList.add("opacity-100", "translate-y-0");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    banner.classList.remove("opacity-100", "translate-y-0");
    banner.classList.add("opacity-0", "translate-y-2");
  }, 2600);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // continuar al respaldo
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function updateDbStatusUI(info) {
  const dot = $("db-status-dot");
  const text = $("db-status-text");
  const adminSyncMode = $("admin-sync-mode");
  if (info.mode === "firebase") {
    dot.className = "mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle";
    text.textContent = "Guardado en la nube";
    adminSyncMode.textContent = "Datos en la nube (Firebase).";
  } else {
    dot.className = "mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-slate-400 align-middle";
    text.textContent = "Guardado en este dispositivo";
    adminSyncMode.textContent = "Datos guardados en este dispositivo.";
  }
}

// ============================================================================
// SONIDO (pitidos en primer y segundo plano), NOTIFICACIONES Y PANTALLA
// ============================================================================

let audioCtx = null;
let wakeLock = null;
let keepAliveAudio = null;
let chimeAudio = null;
let keepAliveUrl = null;
let chimeUrl = null;
let chimePrimed = false;
let chimePlaying = false;
let bgAudioActive = false;

function userHasInteracted() {
  if (navigator.userActivation) return navigator.userActivation.hasBeenActive;
  return true;
}

function writeWavString(view, offset, str) {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function createWavUrl(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeWavString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeWavString(view, 8, "WAVE");
  writeWavString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeWavString(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-32767, Math.min(32767, Math.round(samples[i])));
    view.setInt16(44 + i * 2, s, true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function buildKeepAliveSamples(sampleRate = 8000, seconds = 2) {
  const len = sampleRate * seconds;
  const samples = new Int16Array(len);
  for (let i = 0; i < len; i += 1) {
    samples[i] = i % 2 === 0 ? 1 : -1;
  }
  return samples;
}

function buildChimeSamples(sampleRate = 22050) {
  const durationSec = 0.96;
  const len = Math.round(sampleRate * durationSec);
  const samples = new Int16Array(len);
  const tones = [
    { start: 0.0, end: 0.18, freq: 880 },
    { start: 0.3, end: 0.48, freq: 880 },
    { start: 0.6, end: 0.9, freq: 1046.5 }
  ];

  for (const tone of tones) {
    const startIdx = Math.floor(tone.start * sampleRate);
    const endIdx = Math.min(len, Math.floor(tone.end * sampleRate));
    const fadeIn = Math.floor(0.015 * sampleRate);
    const fadeOut = Math.floor(0.035 * sampleRate);

    for (let i = startIdx; i < endIdx; i += 1) {
      const rel = i - startIdx;
      const rem = endIdx - i;
      let env = 1;
      if (rel < fadeIn) env = rel / Math.max(1, fadeIn);
      else if (rem < fadeOut) env = rem / Math.max(1, fadeOut);
      const t = rel / sampleRate;
      samples[i] = Math.round(Math.sin(2 * Math.PI * tone.freq * t) * env * 21000);
    }
  }
  return samples;
}

function initWavElements() {
  if (keepAliveAudio && chimeAudio) return;
  try {
    if (!keepAliveUrl) keepAliveUrl = createWavUrl(buildKeepAliveSamples(), 8000);
    if (!chimeUrl) chimeUrl = createWavUrl(buildChimeSamples(), 22050);

    if (!keepAliveAudio) {
      keepAliveAudio = new Audio(keepAliveUrl);
      keepAliveAudio.loop = true;
      keepAliveAudio.volume = 0.02;
      keepAliveAudio.preload = "auto";
      keepAliveAudio.playsInline = true;
    }

    if (!chimeAudio) {
      chimeAudio = new Audio(chimeUrl);
      chimeAudio.volume = 1;
      chimeAudio.preload = "auto";
      chimeAudio.playsInline = true;
      chimeAudio.addEventListener("ended", () => {
        chimePlaying = false;
      });
    }
  } catch {
    // fallback a Web Audio API
  }
}

function ensureAudio() {
  initWavElements();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) {
      if (!userHasInteracted()) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
}

function primeChimeElement() {
  initWavElements();
  if (!chimeAudio || chimePrimed || chimePlaying || !userHasInteracted()) return;
  chimeAudio.muted = true;
  chimeAudio
    .play()
    .then(() => {
      if (chimeAudio.muted && !chimePlaying) {
        chimeAudio.pause();
        chimeAudio.currentTime = 0;
        chimeAudio.muted = false;
      }
      chimePrimed = true;
    })
    .catch(() => {
      if (chimeAudio) chimeAudio.muted = false;
    });
}

function audioReady() {
  return bgAudioActive || chimePrimed || Boolean(audioCtx && audioCtx.state === "running");
}

function playBeeps(count = 3) {
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== "running") return false;
  const start = ctx.currentTime + 0.03;
  for (let i = 0; i < count; i += 1) {
    const t = start + i * 0.3;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = i === count - 1 ? 1046.5 : 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }
  return true;
}

function playChime() {
  initWavElements();
  if (chimeAudio) {
    try {
      chimePlaying = true;
      chimeAudio.muted = false;
      chimeAudio.currentTime = 0;
      const playPromise = chimeAudio.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise
          .then(() => {
            chimePrimed = true;
          })
          .catch(() => {
            chimePlaying = false;
            playBeeps(3);
          });
      }
      return true;
    } catch {
      chimePlaying = false;
    }
  }
  return playBeeps(3);
}

function updateMediaSession(playing) {
  try {
    if (!("mediaSession" in navigator)) return;
    if (playing) {
      const min = getReminderMin();
      if (typeof window.MediaMetadata === "function") {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: "Hidratación en entrenamiento",
          artist: `Aviso cada ${min} min — no cierres esta pestaña`,
          album: appState.athleteProfile?.nombre || appState.athleteId || "HydroTag"
        });
      }
      navigator.mediaSession.playbackState = "playing";
    } else {
      navigator.mediaSession.playbackState = "paused";
    }
  } catch {
    // mediaSession no disponible
  }
}

function syncBackgroundAudio() {
  const shouldKeepAlive =
    appState.route === "athlete" && Boolean(appState.draft?.timerRunning) && isReminderOn();

  if (shouldKeepAlive) {
    if (!userHasInteracted()) {
      bgAudioActive = false;
      return;
    }
    initWavElements();
    if (keepAliveAudio) {
      if (keepAliveAudio.paused) {
        keepAliveAudio
          .play()
          .then(() => {
            bgAudioActive = true;
            updateMediaSession(true);
            renderReminderUI();
          })
          .catch(() => {
            bgAudioActive = false;
          });
      } else {
        bgAudioActive = true;
        updateMediaSession(true);
      }
    }
  } else {
    bgAudioActive = false;
    if (keepAliveAudio && !keepAliveAudio.paused) {
      try {
        keepAliveAudio.pause();
      } catch {
        // ignorar
      }
    }
    updateMediaSession(false);
  }
}

async function sendSystemNotification(title, body) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const options = {
      body,
      tag: "hydrotag-reminder",
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: window.location.href }
    };
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, options);
        return;
      }
    }
    new window.Notification(title, { body, tag: "hydrotag-reminder" });
  } catch {
    // notificaciones no soportadas en este contexto
  }
}

function vibrateSafely() {
  try {
    if (navigator.vibrate && userHasInteracted()) navigator.vibrate([200, 100, 200, 100, 200]);
  } catch {
    // no disponible
  }
}

function unlockAudio() {
  ensureAudio();
  primeChimeElement();
  syncBackgroundAudio();
  renderReminderUI();
}

function setupAudioUnlock() {
  ["pointerdown", "touchstart", "keydown"].forEach((evt) =>
    document.addEventListener(evt, unlockAudio, { passive: true })
  );
}

async function syncWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    const shouldHold = appState.route === "athlete" && appState.draft?.timerRunning && document.visibilityState === "visible";
    if (shouldHold && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } else if (!shouldHold && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

// ============================================================================
// RUTEO POR URL (?id=..., ?admin=true)
// ============================================================================

function navigateToParams(paramsObj) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  Object.entries(paramsObj).forEach(([k, v]) => {
    if (v !== null && v !== undefined && String(v).trim() !== "") url.searchParams.set(k, String(v).trim());
  });
  window.history.pushState({}, "", url.toString());
  resolveRoute();
}

async function resolveRoute() {
  stopTimerLoop();
  if (appState.adminUnsubscribe) {
    appState.adminUnsubscribe();
    appState.adminUnsubscribe = null;
  }
  if (appState.adminAthletesUnsubscribe) {
    appState.adminAthletesUnsubscribe();
    appState.adminAthletesUnsubscribe = null;
  }

  const params = new URLSearchParams(window.location.search);
  const isAdmin = params.get("admin") === "true";
  const rawId = params.get("id");
  const cleanId = rawId ? sanitizeAthleteId(rawId) : "";
  const isManualView = params.get("view") === "1";
  const nfcParam = params.get("nfc");

  $("view-onboarding").classList.add("hidden");
  $("view-athlete").classList.add("hidden");
  $("view-admin").classList.add("hidden");

  if (isAdmin) {
    appState.route = "admin";
    const viewAdmin = $("view-admin");
    viewAdmin.classList.remove("hidden");
    replayAnimation(viewAdmin, "view-animate");
    await initAdminView();
    return;
  }

  if (cleanId) {
    appState.route = "athlete";
    appState.athleteId = cleanId;
    const viewAth = $("view-athlete");
    viewAth.classList.remove("hidden");
    replayAnimation(viewAth, "view-animate");
    await initAthleteView(cleanId, { isNfcEntry: !isManualView, nfcParam });
    return;
  }

  appState.route = "onboarding";
  appState.athleteId = null;
  const viewOnb = $("view-onboarding");
  viewOnb.classList.remove("hidden");
  replayAnimation(viewOnb, "view-animate");
  await initOnboardingView();
}

// ============================================================================
// INICIO: REGISTRAR PACIENTE
// ============================================================================

function updateOnboardingPreview() {
  const cleanId = sanitizeAthleteId($("onb-athlete-id").value) || "PX_01";
  $("onb-nfc-url").textContent = buildNfcUrl(cleanId);
}

function highlightOnboardingThermoPreset(ml) {
  document.querySelectorAll(".onb-thermo-preset").forEach((btn) => setChip(btn, Number(btn.dataset.ml) === Number(ml)));
}

async function renderSavedAthletesList() {
  const container = $("onb-saved-athletes");
  const athletes = await HydroTagDB.listAthletes();
  $("onb-athletes-count").textContent = String(athletes.length);

  if (athletes.length === 0) {
    container.innerHTML = `<p class="py-3 text-sm text-slate-400">Todavía no hay pacientes guardados.</p>`;
    return;
  }

  container.innerHTML = athletes
    .map((ath) => {
      const safeId = escapeHtml(ath.id);
      const rawName = (ath.nombre || "").trim();
      const safeName = escapeHtml(rawName || ath.id);
      const initials = escapeHtml((rawName || ath.id).slice(0, 2).toUpperCase());
      const sportPart = ath.deporte ? ` · ${escapeHtml(ath.deporte)}` : "";
      return `
        <button type="button" data-open-athlete="${safeId}" class="group tap-action flex w-full items-center justify-between gap-3 py-3 text-left">
          <span class="flex min-w-0 items-center gap-3">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-700">${initials}</span>
            <span class="min-w-0">
              <span class="block truncate text-sm font-semibold text-slate-900">${safeName}</span>
              <span class="block truncate text-xs text-slate-500">${safeId}${sportPart} · ${formatMl(ath.capacidadTermoMl || DEFAULT_THERMO_ML)} mL</span>
            </span>
          </span>
          <span class="inline-flex items-center gap-1 text-xs font-semibold text-slate-400 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-slate-900">
            Abrir
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </button>`;
    })
    .join("");

  container.querySelectorAll("[data-open-athlete]").forEach((btn) => {
    btn.addEventListener("click", () => navigateToParams({ id: btn.dataset.openAthlete, view: "1" }));
  });
}

async function initOnboardingView() {
  const athletes = await HydroTagDB.listAthletes();
  if (!$("onb-athlete-id").value.trim()) {
    $("onb-athlete-id").value = `PX_${String(athletes.length + 1).padStart(2, "0")}`;
  }
  highlightOnboardingThermoPreset($("onb-thermo-ml").value);
  updateOnboardingPreview();
  await renderSavedAthletesList();
}

// ============================================================================
// PACIENTE: FASE 1 (ANTES)
// ============================================================================

function renderArmstrongScale() {
  const grid = $("armstrong-scale-grid");
  const selected = Number(appState.draft?.orinaArmstrong) || 2;
  const meta = ARMSTRONG_SCALE.find((item) => item.score === selected) || ARMSTRONG_SCALE[1];
  $("armstrong-selected-label").textContent = `${meta.score} · ${meta.label}`;

  grid.innerHTML = ARMSTRONG_SCALE.map((item) => {
    const active = item.score === selected;
    const textClass = item.textDark ? "text-slate-900" : "text-white";
    const ring = active ? "ring-2 ring-slate-900 ring-offset-2 scale-[1.03] shadow-sm" : "opacity-90 hover:opacity-100";
    const check = active
      ? `<span class="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-white"><svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></span>`
      : "";
    return `<button type="button" data-armstrong="${item.score}" aria-label="Color ${item.score}: ${escapeHtml(item.label)}"
      style="background-color:${item.color}"
      class="tap-action relative min-h-[54px] rounded-xl border border-black/10 text-base font-bold ${textClass} ${ring}">${check}${item.score}</button>`;
  }).join("");

  grid.querySelectorAll("[data-armstrong]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.draft.orinaArmstrong = Number(btn.dataset.armstrong);
      saveDraft(appState.athleteId, appState.draft);
      renderArmstrongScale();
      updatePreHydrationAlert();
    });
  });
}

function renderThirstButtons() {
  const current = appState.draft?.nivelSed || "baja";
  document.querySelectorAll(".thirst-btn").forEach((btn) => setChip(btn, btn.dataset.thirst === current));
}

function updatePreHydrationAlert() {
  const draft = appState.draft;
  const profile = appState.athleteProfile;
  if (!draft || !profile) return;

  const pesoPre = Number(draft.pesoPreKg);
  $("p3-preview-pre").textContent = pesoPre > 0 ? `${pesoPre.toFixed(1)} kg` : "-- kg";

  const highUrine = Number(draft.orinaArmstrong) >= 5;
  const highThirst = draft.nivelSed === "alta";
  const alertBox = $("prehydration-alert");

  if (!highUrine && !highThirst) {
    alertBox.classList.add("hidden");
    return;
  }
  alertBox.classList.remove("hidden");

  const reasons = [];
  if (highUrine) reasons.push(`tu orina está en el nivel ${draft.orinaArmstrong}`);
  if (highThirst) reasons.push("tienes mucha sed");
  $("prehydration-reason").textContent = `Empiezas con poca agua: ${reasons.join(" y ")}.`;

  if (pesoPre > 0) {
    const minMl = Math.round(pesoPre * PRE_ML_PER_KG_MIN);
    const maxMl = Math.round(pesoPre * PRE_ML_PER_KG_MAX);
    const thermoMl = Number(profile.capacidadTermoMl) || DEFAULT_THERMO_ML;
    $("prehydration-dose-box").textContent =
      `Toma ${minMl.toLocaleString("es-MX")} a ${maxMl.toLocaleString("es-MX")} mL de agua (6 a 8 mL por kg), ` +
      `de 2 a 4 horas antes. Son ${(minMl / thermoMl).toFixed(2)} a ${(maxMl / thermoMl).toFixed(2)} termos.`;
  } else {
    $("prehydration-dose-box").textContent = "Escribe tu peso para calcular cuánto tomar (6 a 8 mL por kg, 2 a 4 horas antes).";
  }
}

// ============================================================================
// PACIENTE: TERMO Y CONSUMO
// ============================================================================

function getThermoMl() {
  return Number(appState.athleteProfile?.capacidadTermoMl) || DEFAULT_THERMO_ML;
}

function updateDynamicThermoUI() {
  const thermoMl = getThermoMl();
  $("ath-thermo-badge").textContent = `${formatMl(thermoMl)} mL`;

  const inputEl = $("ath-thermo-input");
  if (document.activeElement !== inputEl) inputEl.value = thermoMl;
  document.querySelectorAll(".ath-thermo-preset").forEach((btn) => setChip(btn, Number(btn.dataset.ml) === thermoMl));

  $("label-full-ml").textContent = formatMl(thermoMl);
  $("label-half-ml").textContent = formatMl(thermoMl / 2);
  $("label-quarter-ml").textContent = formatMl(thermoMl / 4);

  updateIntakeUI();
  if (appState.draft?.lastResult) renderPhase3Results();
}

function updateIntakeUI() {
  const draft = appState.draft;
  if (!draft) return;
  const thermoMl = getThermoMl();
  const totalMl = Number(draft.consumoMl) || 0;

  const totalEl = $("intake-total-ml");
  totalEl.textContent = formatMl(totalMl);
  if (appState.lastIntakeDisplayedMl !== null && appState.lastIntakeDisplayedMl !== totalMl) {
    replayAnimation(totalEl, "value-bump");
  }
  appState.lastIntakeDisplayedMl = totalMl;

  $("intake-total-liters").textContent = `${(totalMl / 1000).toFixed(2)} L`;
  $("intake-thermos-count").textContent = `${(thermoMl > 0 ? totalMl / thermoMl : 0).toFixed(2)} termos`;
  $("p3-preview-intake").textContent = `${formatMl(totalMl)} mL`;

  const fillPct =
    totalMl <= 0 ? 0 : Math.abs(totalMl % thermoMl) < 0.01 ? 100 : ((totalMl % thermoMl) / thermoMl) * 100;
  $("intake-progress-bar").style.width = `${Math.min(100, Math.max(0, fillPct)).toFixed(1)}%`;

  const logs = draft.intakeLogs || [];
  const undoBtn = $("btn-drink-undo");
  if (logs.length === 0) {
    undoBtn.disabled = true;
    $("btn-drink-undo-text").textContent = "Deshacer último registro";
  } else {
    undoBtn.disabled = false;
    $("btn-drink-undo-text").textContent = `Deshacer último registro (−${formatMl(logs[logs.length - 1].ml)} mL)`;
  }

  $("intake-logs-list").innerHTML = logs
    .map(
      (entry, idx) =>
        `<span class="inline-flex items-center rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">${idx + 1}. +${formatMl(entry.ml)} mL</span>`
    )
    .join("");
}

function setActivePhase(phaseNum) {
  const phase = Number(phaseNum) || 1;
  const prevPhase = Number(appState.draft.activePhase);
  appState.draft.activePhase = phase;
  saveDraft(appState.athleteId, appState.draft);

  const indicator = $("phase-pill-indicator");
  if (indicator) {
    indicator.style.transform = `translateX(${(phase - 1) * 100}%)`;
  }

  [1, 2, 3].forEach((p) => {
    const tab = $(`tab-phase-${p}`);
    const panel = $(`panel-phase-${p}`);
    if (p === phase) {
      tab.classList.remove("text-slate-500", "hover:text-slate-700");
      tab.classList.add("text-slate-900");
      const wasHidden = panel.classList.contains("hidden");
      panel.classList.remove("hidden");
      if (wasHidden || prevPhase !== phase) replayAnimation(panel, "phase-enter");
    } else {
      tab.classList.add("text-slate-500", "hover:text-slate-700");
      tab.classList.remove("text-slate-900");
      panel.classList.add("hidden");
    }
  });
}

// ============================================================================
// CRONÓMETRO + RECORDATORIO CON PITIDO
// ============================================================================

function getElapsedStopwatchMs() {
  const draft = appState.draft;
  if (!draft) return 0;
  const acc = Number(draft.timerAccumulatedMs) || 0;
  if (draft.timerRunning && draft.timerStartMs) return acc + (Date.now() - Number(draft.timerStartMs));
  return acc;
}

function getReminderMin() {
  return Math.min(60, Math.max(1, Number(appState.athleteProfile?.recordatorioMin) || DEFAULT_REMINDER_MIN));
}

function isReminderOn() {
  return appState.athleteProfile?.recordatorioOn !== false;
}

function renderStopwatch() {
  const draft = appState.draft;
  if (!draft) return;
  const elapsed = getElapsedStopwatchMs();
  $("stopwatch-display").textContent = formatStopwatch(elapsed);

  const liveDot = $("timer-live-dot");
  if (liveDot) {
    liveDot.className = draft.timerRunning
      ? "h-2 w-2 rounded-full bg-emerald-500 animate-pulse transition-colors"
      : "h-2 w-2 rounded-full bg-slate-300 transition-colors";
  }

  const btn = $("btn-timer-toggle");
  const base = "tap-action min-h-[50px] rounded-xl text-sm font-semibold ";
  if (draft.timerRunning) {
    btn.textContent = "Pausar";
    btn.className = base + "border border-slate-900 bg-white text-slate-900 hover:bg-slate-50";
  } else {
    btn.textContent = elapsed > 0 ? "Continuar" : "Iniciar";
    btn.className = base + "bg-slate-900 text-white shadow-sm hover:bg-slate-800";
  }
}

function renderReminderUI() {
  if (!appState.athleteProfile || !appState.draft) return;
  const on = isReminderOn();
  const min = getReminderMin();

  $("reminder-toggle").checked = on;
  document.querySelectorAll(".reminder-preset").forEach((btn) => setChip(btn, Number(btn.dataset.min) === min));
  const input = $("reminder-input");
  if (document.activeElement !== input) input.value = min;

  const nextEl = $("reminder-next");
  const bar = $("reminder-progress-bar");
  const intervalMs = min * 60000;
  const elapsed = getElapsedStopwatchMs();

  if (!on) {
    nextEl.textContent = "Pitido desactivado";
    if (bar) bar.style.width = "0%";
  } else if (!appState.draft.timerRunning) {
    nextEl.textContent = `Sonará cada ${min} min cuando inicies el cronómetro`;
    if (bar) bar.style.width = elapsed > 0 ? `${(((elapsed % intervalMs) / intervalMs) * 100).toFixed(1)}%` : "0%";
  } else {
    nextEl.textContent = `Próximo pitido en ${formatMinSec(intervalMs - (elapsed % intervalMs))}`;
    if (bar) bar.style.width = `${(((elapsed % intervalMs) / intervalMs) * 100).toFixed(1)}%`;
  }

  $("reminder-audio-hint").classList.toggle("hidden", !(on && appState.draft.timerRunning && !audioReady()));

  const bgDot = $("reminder-bg-dot");
  const bgStatus = $("reminder-bg-status");
  const notifBtn = $("btn-enable-notifications");
  if (bgDot && bgStatus && notifBtn) {
    const hasNotifApi = "Notification" in window;
    const notifPerm = hasNotifApi ? Notification.permission : "unsupported";
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent || "");
    const isStandalone = Boolean(
      window.navigator.standalone ||
        (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
    );

    if (!on) {
      bgDot.className = "mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-300 transition-colors";
      bgStatus.textContent = "Pitido desactivado.";
    } else if (appState.draft.timerRunning) {
      if (bgAudioActive || audioReady()) {
        bgDot.className = "mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500 transition-colors";
        bgStatus.textContent =
          notifPerm === "granted"
            ? "Activo en segundo plano con avisos en pantalla bloqueada. No cierres esta pestaña."
            : "Activo en segundo plano: puedes bloquear la pantalla o cambiar de app sin cerrar esta pestaña.";
      } else {
        bgDot.className = "mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-500 transition-colors";
        bgStatus.textContent = "Toca Iniciar o Probar sonido para activar el segundo plano.";
      }
    } else {
      bgDot.className = "mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-300 transition-colors";
      bgStatus.textContent =
        isIos && !isStandalone && !hasNotifApi
          ? "Al pulsar Iniciar sonará con la pantalla bloqueada si dejas esta pestaña abierta (en iPhone agrégala a Inicio para notificaciones)."
          : "Se activará en segundo plano al pulsar Iniciar (no cierres esta pestaña).";
    }

    if (hasNotifApi && notifPerm === "default" && on) {
      notifBtn.classList.remove("hidden");
    } else {
      notifBtn.classList.add("hidden");
    }
  }
}

function showReminderAlert() {
  const s = appState.suggestion;
  const ml = s ? s.tomaMl : Math.round(getThermoMl() / 4);
  $("reminder-alert-text").textContent = `Toma un poco de agua (unos ${formatMl(ml)} mL) y regístralo abajo.`;
  $("reminder-alert").classList.remove("hidden");
}

function triggerReminder() {
  const s = appState.suggestion;
  const ml = s ? s.tomaMl : Math.round(getThermoMl() / 4);
  playChime();
  vibrateSafely();
  showReminderAlert();
  sendSystemNotification("Hora de tomar agua", `Toma unos ${formatMl(ml)} mL y regístralo en tu termo.`);
}

function checkReminder() {
  const draft = appState.draft;
  if (!draft || !draft.timerRunning || !isReminderOn()) return;
  const intervalMs = getReminderMin() * 60000;
  const idx = Math.floor(getElapsedStopwatchMs() / intervalMs);
  if (idx > (Number(draft.lastBeepIdx) || 0)) {
    draft.lastBeepIdx = idx;
    saveDraft(appState.athleteId, draft);
    triggerReminder();
  }
}

function resyncBeepIndex() {
  const intervalMs = getReminderMin() * 60000;
  appState.draft.lastBeepIdx = Math.floor(getElapsedStopwatchMs() / intervalMs);
  saveDraft(appState.athleteId, appState.draft);
}

function tick() {
  renderStopwatch();
  checkReminder();
  renderReminderUI();
}

function startTimerLoop() {
  stopTimerLoop();
  if (appState.draft?.timerRunning) appState.timerIntervalId = setInterval(tick, 500);
  tick();
  syncWakeLock();
  syncBackgroundAudio();
}

function stopTimerLoop() {
  if (appState.timerIntervalId) {
    clearInterval(appState.timerIntervalId);
    appState.timerIntervalId = null;
  }
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  syncBackgroundAudio();
}

async function saveReminderSettings(patch) {
  Object.assign(appState.athleteProfile, patch);
  resyncBeepIndex();
  syncBackgroundAudio();
  renderReminderUI();
  await HydroTagDB.saveAthlete(appState.athleteProfile);
}

async function loadSweatSuggestion() {
  appState.suggestion = null;
  $("reminder-suggestion-box").classList.add("hidden");
  try {
    const sessions = await HydroTagDB.listSessions();
    const last = sessions.find((s) => s.athleteId === appState.athleteId && Number(s.tasaSudoracionLh) > 0);
    if (!last) return;
    const mlPerMin = (Number(last.tasaSudoracionLh) * 1000) / 60;
    const intervalMin = Math.min(20, Math.max(5, Math.round(250 / mlPerMin)));
    const tomaMl = Math.round((mlPerMin * intervalMin) / 10) * 10;
    appState.suggestion = { intervalMin, tomaMl, ts: Number(last.tasaSudoracionLh) };
    $("reminder-suggestion").textContent =
      `En tu último entrenamiento sudaste ${appState.suggestion.ts.toFixed(2)} L/h. ` +
      `Sugerido: cada ${intervalMin} min, tomando unos ${formatMl(tomaMl)} mL.`;
    $("reminder-suggestion-box").classList.remove("hidden");
  } catch {
    // sin sugerencia
  }
}

// ============================================================================
// CÁLCULOS (Fase 3) — fórmulas de la presentación
// ============================================================================

function computeHydroMetrics({ pesoPreKg, pesoPostKg, consumoMl, orinaEvacuadaMl, duracionMin }) {
  const horas = duracionMin / 60;
  const pesoPerdidoKg = pesoPreKg - pesoPostKg;
  // Pérdida de sudor (L) = Peso_pre − (Peso_post − líquido ingerido + orina)
  const sudorTotalL = pesoPerdidoKg + consumoMl / 1000 - orinaEvacuadaMl / 1000;
  const tasaSudoracionLh = sudorTotalL / horas;
  const deshidratacionPct = ((pesoPreKg - pesoPostKg) / pesoPreKg) * 100;
  const deficitMl = Math.max(0, pesoPerdidoKg * 1000);
  return {
    pesoPerdidoKg,
    sudorTotalL,
    tasaSudoracionLh,
    deshidratacionPct,
    deficitMl,
    metaMinMl: Math.round(deficitMl * 1.25),
    metaMaxMl: Math.round(deficitMl * 1.5)
  };
}

function computeIsotonicRecipe(targetVolumeMl) {
  const liters = targetVolumeMl / 1000;
  return {
    liters,
    salMinG: (500 * liters) / NA_MG_PER_G_SALT,
    salMaxG: (700 * liters) / NA_MG_PER_G_SALT,
    salOptG: (600 * liters) / NA_MG_PER_G_SALT,
    carboG: 60 * liters
  };
}

function renderPhase3Results() {
  const res = appState.draft?.lastResult;
  if (!res) {
    $("phase3-results").classList.add("hidden");
    return;
  }
  $("phase3-results").classList.remove("hidden");

  const pct = Number(res.deshidratacionPct);
  const diffKg = Number(res.pesoPreKg) - Number(res.pesoPostKg);
  const card = $("res-semaforo-card");
  const badge = $("res-semaforo-badge");

  let cardCls;
  let badgeCls;
  let badgeText;
  let msg;
  if (pct > 2) {
    cardCls = "border-rose-200 bg-rose-50/90 text-rose-950";
    badgeCls = "bg-rose-600 text-white";
    badgeText = "Rojo · más de 2%";
    msg = "Perdiste más del 2% de tu peso. A partir de aquí baja el rendimiento físico y mental. Repón líquidos cuanto antes.";
  } else if (pct >= 1) {
    cardCls = "border-amber-200 bg-amber-50/90 text-amber-950";
    badgeCls = "bg-amber-500 text-slate-900";
    badgeText = "Amarillo · 1% a 2%";
    msg = "Deshidratación leve. Toma un poco más de agua durante el próximo entrenamiento.";
  } else {
    cardCls = "border-emerald-200 bg-emerald-50/90 text-emerald-950";
    badgeCls = "bg-emerald-600 text-white";
    badgeText = "Verde · menos de 1%";
    msg =
      pct < 0
        ? "Subiste de peso: tomaste más de lo que sudaste. No bebas de más."
        : "Muy bien, te mantuviste hidratado durante el entrenamiento.";
  }
  card.className = `stagger-1 rounded-2xl border p-5 shadow-sm ${cardCls}`;
  badge.className = `rounded-full px-3 py-1 text-xs font-semibold ${badgeCls}`;
  badge.textContent = badgeText;
  $("res-dehydration-msg").textContent = msg;
  $("res-dehydration-pct").textContent = `${pct.toFixed(2)}%`;
  $("res-weight-diff").textContent =
    diffKg >= 0 ? `(−${diffKg.toFixed(2)} kg)` : `(+${Math.abs(diffKg).toFixed(2)} kg)`;

  const pinEl = $("res-dehydration-pin");
  if (pinEl) {
    const pinPos = Math.min(97, Math.max(3, (pct / 3) * 100));
    pinEl.style.left = `${pinPos.toFixed(1)}%`;
  }

  const lh = Number(res.tasaSudoracionLh);
  $("res-sweat-lh").textContent = lh.toFixed(2);
  $("res-sweat-mlh").textContent = `${Math.round(lh * 1000).toLocaleString("es-MX")} mL por hora · ${Math.round((lh * 1000) / 60)} mL por minuto`;
  $("res-sweat-formula").textContent =
    `((${res.pesoPreKg.toFixed(1)} − ${res.pesoPostKg.toFixed(1)}) + ${(res.consumoMl / 1000).toFixed(2)} L ` +
    `− ${(res.orinaEvacuadaMl / 1000).toFixed(2)} L) ÷ ${(res.duracionMin / 60).toFixed(2)} h`;

  const thermoMl = getThermoMl();
  const deficitMl = Math.max(0, Math.round((res.pesoPreKg - res.pesoPostKg) * 1000));
  $("res-rehydration-range").textContent = `${res.metaMinMl.toLocaleString("es-MX")} – ${res.metaMaxMl.toLocaleString("es-MX")} mL`;
  $("res-deficit-ml").textContent = `Perdiste ${deficitMl.toLocaleString("es-MX")} mL de líquido`;
  $("res-rehydration-thermos").textContent =
    deficitMl > 0
      ? `Son ${(res.metaMinMl / thermoMl).toFixed(2)} a ${(res.metaMaxMl / thermoMl).toFixed(2)} termos de ${formatMl(thermoMl)} mL.`
      : "No perdiste líquido neto: toma agua a libre demanda.";

  const isoFactor = Number(appState.draft.isoFactor) || 1.5;
  document.querySelectorAll(".iso-pct-btn").forEach((btn) => setChip(btn, Math.abs(Number(btn.dataset.factor) - isoFactor) < 0.001));

  const targetMl = deficitMl > 0 ? Math.round(deficitMl * isoFactor) : 1000;
  const recipe = computeIsotonicRecipe(targetMl);
  const perThermo = computeIsotonicRecipe(thermoMl);

  $("iso-target-ml").textContent = deficitMl > 0 ? `para ${targetMl.toLocaleString("es-MX")} mL` : "referencia: 1,000 mL";
  $("iso-salt-range").textContent = `${recipe.salMinG.toFixed(2)} – ${recipe.salMaxG.toFixed(2)} g`;
  $("iso-salt-opt").textContent = `Ideal: ${recipe.salOptG.toFixed(2)} g (500 a 700 mg de sodio por litro)`;
  $("iso-carb-grams").textContent = `${recipe.carboG.toFixed(1)} g`;
  $("iso-carb-note").textContent = `60 g por litro (6%) · ${recipe.liters.toFixed(2)} L`;
  $("iso-per-thermo-note").textContent =
    `Por cada termo de ${formatMl(thermoMl)} mL: ${perThermo.salMinG.toFixed(2)} a ${perThermo.salMaxG.toFixed(2)} g de sal ` +
    `y ${perThermo.carboG.toFixed(1)} g de azúcar o maltodextrina, disueltos en agua fría.`;
}

// ============================================================================
// NFC: SUMA AUTOMÁTICA AL ESCANEAR
// ============================================================================

function getScanFractionLabel(fraction) {
  if (Math.abs(fraction - 1) < 0.001) return "1 termo";
  if (Math.abs(fraction - 0.5) < 0.001) return "1/2 termo";
  if (Math.abs(fraction - 0.25) < 0.001) return "1/4 de termo";
  return `${fraction} termo`;
}

function renderAutoScanButtons() {
  const current = appState.athleteProfile?.autoScanFraction !== undefined ? Number(appState.athleteProfile.autoScanFraction) : 1;
  document.querySelectorAll(".ath-autoscan-btn").forEach((btn) => setChip(btn, Math.abs(Number(btn.dataset.scan) - current) < 0.001));
}

async function syncAthleteLiveProgress(profile, draft) {
  if (!profile || !profile.id || !draft) return;
  try {
    await HydroTagDB.saveAthlete({
      ...profile,
      consumoEnCursoMl: Number(draft.consumoMl) || 0,
      tomasEnCurso: Array.isArray(draft.intakeLogs) ? draft.intakeLogs.length : 0,
      ultimoEscaneoAt: new Date().toISOString()
    });
  } catch {
    // sin conexión
  }
}

function showNfcScanBanner({ addedMl, label, totalMl, debounced = false }) {
  const termos = (totalMl / getThermoMl()).toFixed(2);
  $("nfc-scan-title").textContent = debounced
    ? "Ya se registró hace un momento"
    : `Chip leído: +${formatMl(addedMl)} mL (${label})`;
  $("nfc-scan-subtitle").textContent = `Total de esta sesión: ${formatMl(totalMl)} mL (${termos} termos)`;
  $("nfc-scan-banner").classList.remove("hidden");
}

async function applyNfcAutoScan(athleteId, scanFraction, { bypassDebounce = false } = {}) {
  const profile = appState.athleteProfile;
  const draft = appState.draft;
  if (!profile || !draft || !(scanFraction > 0)) return false;

  const now = Date.now();
  let lastScanMs = 0;
  try {
    lastScanMs = Number(localStorage.getItem(`${LAST_SCAN_PREFIX}${athleteId}`) || 0);
  } catch {
    lastScanMs = 0;
  }

  if (!bypassDebounce && now - lastScanMs < NFC_DEBOUNCE_MS) {
    showNfcScanBanner({ addedMl: 0, label: "", totalMl: Number(draft.consumoMl) || 0, debounced: true });
    return false;
  }

  try {
    localStorage.setItem(`${LAST_SCAN_PREFIX}${athleteId}`, String(now));
  } catch {
    // ignorar
  }

  const label = getScanFractionLabel(scanFraction);
  const addedMl = Number((getThermoMl() * scanFraction).toFixed(1));
  draft.intakeLogs.push({ id: now, fractionLabel: label, ml: addedMl, viaNfc: true });
  draft.consumoMl = Number(draft.intakeLogs.reduce((sum, item) => sum + item.ml, 0).toFixed(1));
  appState.lastAutoScanIndex = draft.intakeLogs.length - 1;

  if (!draft.timerRunning && !(Number(draft.timerAccumulatedMs) > 0)) {
    draft.timerStartMs = now;
    draft.timerRunning = true;
  }
  draft.activePhase = 2;
  saveDraft(athleteId, draft);

  await syncAthleteLiveProgress(profile, draft);
  showNfcScanBanner({ addedMl, label, totalMl: draft.consumoMl });
  return true;
}

// ============================================================================
// VISTA PACIENTE: INICIALIZACIÓN
// ============================================================================

async function initAthleteView(athleteId, { isNfcEntry = false, nfcParam = null } = {}) {
  let profile = await HydroTagDB.getAthlete(athleteId);
  if (!profile) {
    profile = await HydroTagDB.saveAthlete({
      id: athleteId,
      nombre: "",
      deporte: "",
      capacidadTermoMl: DEFAULT_THERMO_ML,
      autoScanFraction: 1,
      recordatorioOn: true,
      recordatorioMin: DEFAULT_REMINDER_MIN
    });
  }

  appState.athleteProfile = profile;
  appState.draft = loadDraft(athleteId);
  appState.lastAutoScanIndex = null;
  appState.lastIntakeDisplayedMl = Number(appState.draft.consumoMl) || 0;
  $("nfc-scan-banner").classList.add("hidden");
  $("reminder-alert").classList.add("hidden");

  if (isNfcEntry) {
    // view=1 evita sumar de nuevo si se recarga la página
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = "";
    cleanUrl.hash = "";
    cleanUrl.searchParams.set("id", athleteId);
    cleanUrl.searchParams.set("view", "1");
    window.history.replaceState({}, "", cleanUrl.toString());

    const paramFraction = nfcParam !== null && nfcParam !== "" && Number.isFinite(Number(nfcParam)) ? Number(nfcParam) : null;
    const defaultFraction = profile.autoScanFraction !== undefined ? Number(profile.autoScanFraction) : 1;
    const fractionToApply = paramFraction !== null ? paramFraction : defaultFraction;
    if (fractionToApply > 0) await applyNfcAutoScan(athleteId, fractionToApply);
  }

  $("ath-id-label").textContent = profile.id;
  $("ath-name-display").textContent = profile.nombre || "Paciente";
  $("ath-sport-display").textContent = profile.deporte || "";
  $("ath-name-input").value = profile.nombre || "";
  $("ath-sport-input").value = profile.deporte || "";
  setDrawerOpen(false);

  $("input-peso-pre").value = appState.draft.pesoPreKg || "";
  $("input-duracion-min").value = appState.draft.duracionMin || "";
  $("input-peso-post").value = appState.draft.pesoPostKg || "";
  $("input-orina-ml").value = appState.draft.orinaEvacuadaMl ?? 0;
  $("p3-preview-dur").textContent = appState.draft.duracionMin ? `${appState.draft.duracionMin} min` : "-- min";

  updateDynamicThermoUI();
  renderAutoScanButtons();
  renderArmstrongScale();
  renderThirstButtons();
  updatePreHydrationAlert();
  renderReminderUI();
  startTimerLoop();
  renderPhase3Results();
  setActivePhase(appState.draft.activePhase || 1);
  loadSweatSuggestion();
}

async function updateThermoCapacity(newMl, showFeedback = false) {
  const val = Number(newMl);
  if (!Number.isFinite(val) || val < 50 || val > 5000) return;
  appState.athleteProfile.capacidadTermoMl = val;
  updateDynamicThermoUI();
  await HydroTagDB.saveAthlete(appState.athleteProfile);
  if (showFeedback) showToast(`Termo: ${formatMl(val)} mL`);
}

// ============================================================================
// PANEL DEL INVESTIGADOR (?admin=true)
// ============================================================================

function populateAdminAthleteFilter(sessions) {
  const select = $("admin-filter-athlete");
  const prev = select.value || "ALL";
  const ids = [...new Set(sessions.map((s) => s.athleteId).filter(Boolean))].sort();
  select.innerHTML =
    `<option value="ALL">Todos (${ids.length})</option>` +
    ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
  select.value = ids.includes(prev) ? prev : "ALL";
}

function getFilteredAdminSessions() {
  const athleteFilter = $("admin-filter-athlete").value;
  const search = ($("admin-filter-search").value || "").trim().toLowerCase();
  const redOnly = $("admin-filter-red-only").checked;

  return appState.adminSessions.filter((s) => {
    if (athleteFilter && athleteFilter !== "ALL" && s.athleteId !== athleteFilter) return false;
    if (redOnly && !(Number(s.deshidratacionPct) > 2)) return false;
    if (search) {
      const haystack = `${s.athleteId || ""} ${s.athleteName || ""} ${s.deporte || ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function renderAdminDashboard() {
  const all = appState.adminSessions;
  const filtered = getFilteredAdminSessions();

  const redAlerts = all.filter((s) => Number(s.deshidratacionPct) > 2).length;
  const avgSweat = all.length > 0 ? all.reduce((acc, s) => acc + (Number(s.tasaSudoracionLh) || 0), 0) / all.length : 0;

  $("kpi-total-sessions").textContent = String(all.length);
  $("kpi-unique-athletes").textContent = String(new Set(all.map((s) => s.athleteId).filter(Boolean)).size);
  $("kpi-red-alerts").textContent = String(redAlerts);
  $("kpi-avg-sweat").textContent = `${avgSweat.toFixed(2)} L/h`;
  $("admin-filter-count").textContent = `Mostrando ${filtered.length} de ${all.length} registros`;

  const tbody = $("admin-table-body");
  const emptyState = $("admin-empty-state");
  if (filtered.length === 0) {
    tbody.innerHTML = "";
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  tbody.innerHTML = filtered
    .map((s) => {
      const pct = Number(s.deshidratacionPct) || 0;
      const isRed = pct > 2;
      const isYellow = pct >= 1 && pct <= 2;
      const rowCls = isRed ? "bg-rose-50/75 hover:bg-rose-50 transition-colors" : "hover:bg-slate-50/80 transition-colors";
      let pctBadge = `<span class="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">${pct.toFixed(2)}%</span>`;
      if (isRed) pctBadge = `<span class="rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-semibold text-white">${pct.toFixed(2)}% · &gt;2%</span>`;
      else if (isYellow) pctBadge = `<span class="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">${pct.toFixed(2)}%</span>`;

      const armstrong = ARMSTRONG_SCALE.find((a) => a.score === Number(s.orinaArmstrong)) || ARMSTRONG_SCALE[1];
      const dateStr = s.createdAt
        ? new Date(s.createdAt).toLocaleString("es-MX", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "--";
      const safeId = escapeHtml(s.athleteId);
      const safeName = escapeHtml(s.athleteName || "");

      return `
        <tr class="${rowCls}">
          <td class="whitespace-nowrap px-4 py-3">
            <button type="button" data-open-id="${safeId}" class="font-semibold text-slate-900 underline">${safeId}</button>
            ${safeName ? `<div class="text-xs text-slate-500">${safeName}</div>` : ""}
          </td>
          <td class="whitespace-nowrap px-3 py-3 text-slate-600">${escapeHtml(dateStr)}</td>
          <td class="whitespace-nowrap px-3 py-3 tabular-nums text-slate-700">${formatMl(s.capacidadTermoMl)} mL</td>
          <td class="whitespace-nowrap px-3 py-3 tabular-nums text-slate-700">${Number(s.pesoPreKg).toFixed(1)} → ${Number(s.pesoPostKg).toFixed(1)} kg</td>
          <td class="whitespace-nowrap px-3 py-3 tabular-nums text-slate-700">${formatMl(s.consumoMl)} mL</td>
          <td class="whitespace-nowrap px-3 py-3 tabular-nums text-slate-700">${Number(s.duracionMin)} min</td>
          <td class="whitespace-nowrap px-3 py-3 tabular-nums font-semibold text-slate-900">${Number(s.tasaSudoracionLh).toFixed(2)} L/h</td>
          <td class="whitespace-nowrap px-3 py-3">${pctBadge}</td>
          <td class="whitespace-nowrap px-3 py-3 text-slate-700">
            <span class="mr-1.5 inline-block h-3 w-3 rounded-full border border-black/10 align-middle" style="background-color:${armstrong.color}"></span>${Number(s.orinaArmstrong)}/8
          </td>
          <td class="whitespace-nowrap px-3 py-3 tabular-nums text-slate-700">${Number(s.metaMinMl).toLocaleString("es-MX")}–${Number(s.metaMaxMl).toLocaleString("es-MX")} mL</td>
          <td class="whitespace-nowrap px-3 py-3 text-right">
            <button type="button" data-delete-session="${escapeHtml(s.sessionId)}" class="text-xs font-medium text-slate-400 underline hover:text-rose-600">Borrar</button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-open-id]").forEach((btn) =>
    btn.addEventListener("click", () => navigateToParams({ id: btn.dataset.openId, view: "1" }))
  );
  tbody.querySelectorAll("[data-delete-session]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await HydroTagDB.deleteSession(btn.dataset.deleteSession);
      showToast("Registro eliminado");
    })
  );
}

function csvCell(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function exportSessionsToCsv() {
  const rows = getFilteredAdminSessions();
  if (rows.length === 0) {
    showToast("No hay registros para exportar");
    return;
  }

  const headers = [
    "ID", "Fecha", "Capacidad_Termo_mL", "Peso_Pre", "Peso_Post", "Consumo_mL", "Duracion_min",
    "Tasa_Sudoracion_Lh", "Deshidratacion_Pct", "Orina_Armstrong", "Meta_Reposicion_mL",
    "Meta_Reposicion_125_mL", "Meta_Reposicion_150_mL", "Orina_Evacuada_mL", "Nivel_Sed"
  ];
  const lines = [headers.join(",")];

  rows.forEach((s) => {
    const minMl = Math.round(Number(s.metaMinMl) || 0);
    const maxMl = Math.round(Number(s.metaMaxMl) || 0);
    lines.push(
      [
        csvCell(s.athleteId),
        csvCell(s.createdAt || new Date().toISOString()),
        csvCell(Number(s.capacidadTermoMl || 0)),
        csvCell(Number(s.pesoPreKg || 0).toFixed(2)),
        csvCell(Number(s.pesoPostKg || 0).toFixed(2)),
        csvCell(Number(s.consumoMl || 0)),
        csvCell(Number(s.duracionMin || 0)),
        csvCell(Number(s.tasaSudoracionLh || 0).toFixed(2)),
        csvCell(Number(s.deshidratacionPct || 0).toFixed(2)),
        csvCell(Number(s.orinaArmstrong || 0)),
        csvCell(`${minMl}-${maxMl}`),
        csvCell(minMl),
        csvCell(maxMl),
        csvCell(Math.round(Number(s.orinaEvacuadaMl) || 0)),
        csvCell(s.nivelSed || "baja")
      ].join(",")
    );
  });

  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", `HydroTag_BaseDatos_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast(`CSV exportado (${rows.length} registros)`);
}

function renderAdminLiveAthletes() {
  const wrapper = $("admin-live-wrapper");
  const grid = $("admin-live-grid");
  const active = (appState.adminLiveAthletes || []).filter((ath) => (Number(ath.consumoEnCursoMl) || 0) > 0);

  if (active.length === 0) {
    wrapper.classList.add("hidden");
    grid.innerHTML = "";
    return;
  }
  wrapper.classList.remove("hidden");
  grid.innerHTML = active
    .map((ath) => {
      const tomas = Number(ath.tomasEnCurso) || 0;
      return `
        <button type="button" data-live-open-id="${escapeHtml(ath.id)}" class="tap-action flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-left hover:border-slate-300 hover:bg-white">
          <span class="min-w-0">
            <span class="block truncate text-sm font-semibold text-slate-900">${escapeHtml(ath.nombre || ath.id)}</span>
            <span class="block text-xs text-slate-500">${escapeHtml(ath.id)} · ${tomas} toma${tomas === 1 ? "" : "s"}</span>
          </span>
          <span class="tabular-nums text-sm font-bold text-slate-900">${formatMl(ath.consumoEnCursoMl)} mL</span>
        </button>`;
    })
    .join("");

  grid.querySelectorAll("[data-live-open-id]").forEach((btn) =>
    btn.addEventListener("click", () => navigateToParams({ id: btn.dataset.liveOpenId, view: "1" }))
  );
}

async function initAdminView() {
  appState.adminUnsubscribe = await HydroTagDB.subscribeSessions((sessions) => {
    appState.adminSessions = sessions;
    populateAdminAthleteFilter(sessions);
    renderAdminDashboard();
  });
  appState.adminAthletesUnsubscribe = await HydroTagDB.subscribeAthletes((athletes) => {
    appState.adminLiveAthletes = athletes;
    renderAdminLiveAthletes();
  });
}

// ============================================================================
// EVENTOS
// ============================================================================

function bindEvents() {
  // Instalación PWA
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    appState.deferredInstallPrompt = event;
    $("btn-install-pwa").classList.remove("hidden");
  });
  $("btn-install-pwa").addEventListener("click", async () => {
    if (!appState.deferredInstallPrompt) return;
    appState.deferredInstallPrompt.prompt();
    await appState.deferredInstallPrompt.userChoice;
    appState.deferredInstallPrompt = null;
    $("btn-install-pwa").classList.add("hidden");
  });

  // Inicio / registrar paciente
  $("onb-athlete-id").addEventListener("input", updateOnboardingPreview);

  $("btn-generate-id").addEventListener("click", async () => {
    const athletes = await HydroTagDB.listAthletes();
    let n = athletes.length + 1;
    const used = new Set(athletes.map((a) => a.id));
    while (used.has(`PX_${String(n).padStart(2, "0")}`)) n += 1;
    $("onb-athlete-id").value = `PX_${String(n).padStart(2, "0")}`;
    updateOnboardingPreview();
  });

  document.querySelectorAll(".onb-thermo-preset").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("onb-thermo-ml").value = btn.dataset.ml;
      highlightOnboardingThermoPreset(btn.dataset.ml);
    })
  );
  $("onb-thermo-ml").addEventListener("input", () => highlightOnboardingThermoPreset($("onb-thermo-ml").value));

  $("btn-onb-copy-nfc").addEventListener("click", async () => {
    const cleanId = sanitizeAthleteId($("onb-athlete-id").value) || "PX_01";
    $("onb-athlete-id").value = cleanId;
    updateOnboardingPreview();
    const ok = await copyTextToClipboard(buildNfcUrl(cleanId));
    showToast(ok ? `URL copiada (${cleanId})` : "No se pudo copiar. Selecciona el enlace y cópialo.");
  });

  $("btn-onb-write-nfc").addEventListener("click", async () => {
    const cleanId = sanitizeAthleteId($("onb-athlete-id").value) || "PX_01";
    if (!("NDEFReader" in window)) {
      showToast("Solo funciona en Chrome para Android. Usa 'Copiar URL' con la app NFC Tools.");
      return;
    }
    try {
      const ndef = new window.NDEFReader();
      showToast("Acerca el chip al teléfono...");
      await ndef.write({ records: [{ recordType: "url", data: buildNfcUrl(cleanId) }] });
      showToast(`Chip grabado (${cleanId})`);
    } catch {
      showToast("No se pudo grabar. Revisa los permisos de NFC o usa NFC Tools.");
    }
  });

  $("form-onboarding").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cleanId = sanitizeAthleteId($("onb-athlete-id").value);
    if (!cleanId) {
      showToast("Escribe un ID para el paciente");
      $("onb-athlete-id").focus();
      return;
    }
    const thermoMl = Number($("onb-thermo-ml").value) || DEFAULT_THERMO_ML;
    if (thermoMl < 50 || thermoMl > 5000) {
      showToast("El termo debe estar entre 50 y 5000 mL");
      return;
    }
    await HydroTagDB.saveAthlete({
      id: cleanId,
      nombre: $("onb-athlete-name").value.trim(),
      deporte: $("onb-athlete-sport").value.trim(),
      capacidadTermoMl: thermoMl
    });
    navigateToParams({ id: cleanId, view: "1" });
  });

  // Paciente: ajustes
  $("btn-toggle-profile-edit").addEventListener("click", () => {
    const isOpen = $("profile-edit-drawer").classList.contains("is-open");
    setDrawerOpen(!isOpen);
  });

  $("btn-save-profile-meta").addEventListener("click", async () => {
    if (!appState.athleteProfile) return;
    appState.athleteProfile.nombre = $("ath-name-input").value.trim();
    appState.athleteProfile.deporte = $("ath-sport-input").value.trim();
    await HydroTagDB.saveAthlete(appState.athleteProfile);
    $("ath-name-display").textContent = appState.athleteProfile.nombre || "Paciente";
    $("ath-sport-display").textContent = appState.athleteProfile.deporte || "";
    showToast("Datos guardados");
  });

  $("btn-ath-copy-nfc").addEventListener("click", async () => {
    const ok = await copyTextToClipboard(buildNfcUrl(appState.athleteId));
    showToast(ok ? "URL copiada" : "No se pudo copiar");
  });

  document.querySelectorAll(".ath-thermo-preset").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("ath-thermo-input").value = btn.dataset.ml;
      updateThermoCapacity(Number(btn.dataset.ml), true);
    })
  );

  $("ath-thermo-input").addEventListener("input", () => {
    const val = Number($("ath-thermo-input").value);
    if (!Number.isFinite(val) || val < 50 || val > 5000) return;
    clearTimeout(appState.thermoSaveTimeout);
    appState.athleteProfile.capacidadTermoMl = val;
    updateDynamicThermoUI();
    appState.thermoSaveTimeout = setTimeout(() => updateThermoCapacity(val, false), 350);
  });

  document.querySelectorAll(".ath-autoscan-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!appState.athleteProfile) return;
      const val = Number(btn.dataset.scan);
      appState.athleteProfile.autoScanFraction = Number.isFinite(val) ? val : 1;
      renderAutoScanButtons();
      await HydroTagDB.saveAthlete(appState.athleteProfile);
      showToast(val > 0 ? `Al escanear: +${getScanFractionLabel(val)}` : "Al escanear: solo abrir");
    })
  );

  $("btn-simulate-nfc").addEventListener("click", async () => {
    if (!appState.athleteProfile) return;
    const f = Number(appState.athleteProfile.autoScanFraction ?? 1);
    await applyNfcAutoScan(appState.athleteId, f > 0 ? f : 1, { bypassDebounce: true });
    updateIntakeUI();
    startTimerLoop();
    setActivePhase(2);
  });

  // Aviso NFC
  function adjustLastNfcIntake(newFraction, newLabel) {
    const logs = appState.draft?.intakeLogs;
    if (!logs || logs.length === 0) return;
    const idx = appState.lastAutoScanIndex !== null && logs[appState.lastAutoScanIndex] ? appState.lastAutoScanIndex : logs.length - 1;
    const newMl = Number((getThermoMl() * newFraction).toFixed(1));
    logs[idx] = { ...logs[idx], fractionLabel: newLabel, ml: newMl };
    appState.draft.consumoMl = Number(logs.reduce((sum, item) => sum + item.ml, 0).toFixed(1));
    saveDraft(appState.athleteId, appState.draft);
    updateIntakeUI();
    syncAthleteLiveProgress(appState.athleteProfile, appState.draft);
    showNfcScanBanner({ addedMl: newMl, label: newLabel, totalMl: appState.draft.consumoMl });
  }
  $("btn-nfc-adj-half").addEventListener("click", () => adjustLastNfcIntake(0.5, "1/2 termo"));
  $("btn-nfc-adj-quarter").addEventListener("click", () => adjustLastNfcIntake(0.25, "1/4 de termo"));

  $("btn-nfc-undo-goto-p1").addEventListener("click", async () => {
    const logs = appState.draft?.intakeLogs;
    if (logs && logs.length > 0) {
      const idx = appState.lastAutoScanIndex !== null && logs[appState.lastAutoScanIndex] ? appState.lastAutoScanIndex : logs.length - 1;
      logs.splice(idx, 1);
      appState.lastAutoScanIndex = null;
      appState.draft.consumoMl = Number(logs.reduce((sum, item) => sum + item.ml, 0).toFixed(1));
      saveDraft(appState.athleteId, appState.draft);
      updateIntakeUI();
      await syncAthleteLiveProgress(appState.athleteProfile, appState.draft);
    }
    $("nfc-scan-banner").classList.add("hidden");
    setActivePhase(1);
    $("input-peso-pre").focus();
  });
  $("btn-nfc-dismiss").addEventListener("click", () => $("nfc-scan-banner").classList.add("hidden"));

  // Pasos
  document.querySelectorAll(".phase-tab").forEach((btn) => btn.addEventListener("click", () => setActivePhase(Number(btn.dataset.phase))));
  $("btn-to-phase-2").addEventListener("click", () => setActivePhase(2));

  // Fase 1
  $("input-peso-pre").addEventListener("input", () => {
    appState.draft.pesoPreKg = $("input-peso-pre").value;
    saveDraft(appState.athleteId, appState.draft);
    updatePreHydrationAlert();
  });
  document.querySelectorAll(".thirst-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      appState.draft.nivelSed = btn.dataset.thirst;
      saveDraft(appState.athleteId, appState.draft);
      renderThirstButtons();
      updatePreHydrationAlert();
    })
  );

  // Fase 2: cronómetro
  $("btn-timer-toggle").addEventListener("click", () => {
    unlockAudio();
    const draft = appState.draft;
    if (draft.timerRunning) {
      draft.timerAccumulatedMs = getElapsedStopwatchMs();
      draft.timerRunning = false;
      draft.timerStartMs = null;
    } else {
      draft.timerStartMs = Date.now();
      draft.timerRunning = true;
    }
    saveDraft(appState.athleteId, draft);
    startTimerLoop();
  });

  $("btn-timer-reset").addEventListener("click", () => {
    appState.draft.timerRunning = false;
    appState.draft.timerStartMs = null;
    appState.draft.timerAccumulatedMs = 0;
    appState.draft.lastBeepIdx = 0;
    saveDraft(appState.athleteId, appState.draft);
    $("reminder-alert").classList.add("hidden");
    startTimerLoop();
  });

  $("input-duracion-min").addEventListener("input", () => {
    const mins = Number($("input-duracion-min").value);
    appState.draft.duracionMin = mins > 0 ? mins : "";
    $("p3-preview-dur").textContent = mins > 0 ? `${mins} min` : "-- min";
    saveDraft(appState.athleteId, appState.draft);
  });

  // Fase 2: recordatorio con pitido
  $("reminder-toggle").addEventListener("change", () => {
    unlockAudio();
    saveReminderSettings({ recordatorioOn: $("reminder-toggle").checked });
  });
  document.querySelectorAll(".reminder-preset").forEach((btn) =>
    btn.addEventListener("click", () => {
      unlockAudio();
      $("reminder-input").value = btn.dataset.min;
      saveReminderSettings({ recordatorioMin: Number(btn.dataset.min) });
    })
  );
  $("reminder-input").addEventListener("input", () => {
    const val = Number($("reminder-input").value);
    if (!Number.isFinite(val) || val < 1 || val > 60) return;
    saveReminderSettings({ recordatorioMin: Math.round(val) });
  });
  $("btn-reminder-use-suggestion").addEventListener("click", () => {
    if (!appState.suggestion) return;
    $("reminder-input").value = appState.suggestion.intervalMin;
    saveReminderSettings({ recordatorioMin: appState.suggestion.intervalMin, recordatorioOn: true });
    showToast(`Pitido cada ${appState.suggestion.intervalMin} min`);
  });
  $("btn-test-beep").addEventListener("click", () => {
    ensureAudio();
    const ok = playChime();
    vibrateSafely();
    syncBackgroundAudio();
    showToast(ok ? "Si escuchaste el pitido, está listo" : "Sin sonido: sube el volumen o desactiva el modo silencio");
    renderReminderUI();
  });
  $("btn-enable-notifications").addEventListener("click", async () => {
    if (!("Notification" in window)) {
      showToast("Este navegador no admite notificaciones");
      return;
    }
    try {
      const perm = await window.Notification.requestPermission();
      renderReminderUI();
      if (perm === "granted") {
        await sendSystemNotification("Avisos activados", "Te avisaremos cuando toque hidratarte.");
        showToast("Avisos en pantalla bloqueada activados");
      } else {
        showToast("Permiso no concedido; el pitido seguirá funcionando con la pestaña abierta");
      }
    } catch {
      showToast("No se pudo pedir permiso de notificaciones");
    }
  });
  $("btn-reminder-dismiss").addEventListener("click", () => $("reminder-alert").classList.add("hidden"));

  // Fase 2: consumo
  function addIntake(fraction, label) {
    unlockAudio();
    const addedMl = Number((getThermoMl() * fraction).toFixed(1));
    appState.draft.intakeLogs.push({ id: Date.now(), fractionLabel: label, ml: addedMl });
    appState.draft.consumoMl = Number(appState.draft.intakeLogs.reduce((sum, item) => sum + item.ml, 0).toFixed(1));
    saveDraft(appState.athleteId, appState.draft);
    updateIntakeUI();
    syncAthleteLiveProgress(appState.athleteProfile, appState.draft);
    $("reminder-alert").classList.add("hidden");
    showToast(`+${formatMl(addedMl)} mL`);
  }
  $("btn-drink-full").addEventListener("click", () => addIntake(1, "1 termo"));
  $("btn-drink-half").addEventListener("click", () => addIntake(0.5, "1/2 termo"));
  $("btn-drink-quarter").addEventListener("click", () => addIntake(0.25, "1/4 de termo"));

  $("btn-drink-undo").addEventListener("click", () => {
    const logs = appState.draft.intakeLogs;
    if (!logs || logs.length === 0) return;
    const removed = logs.pop();
    appState.lastAutoScanIndex = null;
    appState.draft.consumoMl = Number(logs.reduce((sum, item) => sum + item.ml, 0).toFixed(1));
    saveDraft(appState.athleteId, appState.draft);
    updateIntakeUI();
    syncAthleteLiveProgress(appState.athleteProfile, appState.draft);
    showToast(`Quitado: −${formatMl(removed.ml)} mL`);
  });

  // Terminar entrenamiento → pasa a Fase 3 con la duración del cronómetro
  $("btn-to-phase-3").addEventListener("click", () => {
    const draft = appState.draft;
    if (draft.timerRunning) {
      draft.timerAccumulatedMs = getElapsedStopwatchMs();
      draft.timerRunning = false;
      draft.timerStartMs = null;
    }
    const elapsed = Number(draft.timerAccumulatedMs) || 0;
    if (elapsed >= 30000) {
      draft.duracionMin = Math.max(1, Math.round(elapsed / 60000));
      $("input-duracion-min").value = draft.duracionMin;
    }
    $("p3-preview-dur").textContent = draft.duracionMin ? `${draft.duracionMin} min` : "-- min";
    saveDraft(appState.athleteId, draft);
    $("reminder-alert").classList.add("hidden");
    startTimerLoop();
    setActivePhase(3);
  });

  // Fase 3
  $("input-peso-post").addEventListener("input", () => {
    appState.draft.pesoPostKg = $("input-peso-post").value;
    saveDraft(appState.athleteId, appState.draft);
  });
  $("input-orina-ml").addEventListener("input", () => {
    appState.draft.orinaEvacuadaMl = Math.max(0, Number($("input-orina-ml").value) || 0);
    saveDraft(appState.athleteId, appState.draft);
  });
  document.querySelectorAll(".iso-pct-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      appState.draft.isoFactor = Number(btn.dataset.factor);
      saveDraft(appState.athleteId, appState.draft);
      renderPhase3Results();
    })
  );

  $("btn-calculate-save").addEventListener("click", async () => {
    const errBox = $("phase3-validation-error");
    errBox.classList.add("hidden");

    const pesoPreKg = Number(appState.draft.pesoPreKg);
    const pesoPostKg = Number(appState.draft.pesoPostKg);
    const duracionMin = Number(appState.draft.duracionMin);
    const consumoMl = Number(appState.draft.consumoMl) || 0;
    const orinaEvacuadaMl = Math.max(0, Number(appState.draft.orinaEvacuadaMl) || 0);

    const errors = [];
    if (!Number.isFinite(pesoPreKg) || pesoPreKg < 20 || pesoPreKg > 250) errors.push("Falta tu peso inicial (paso 1).");
    if (!Number.isFinite(pesoPostKg) || pesoPostKg < 20 || pesoPostKg > 250) errors.push("Escribe tu peso actual.");
    if (!Number.isFinite(duracionMin) || duracionMin <= 0) errors.push("Falta la duración del entrenamiento (paso 2).");
    if (errors.length > 0) {
      errBox.textContent = errors.join(" ");
      errBox.classList.remove("hidden");
      return;
    }

    const metrics = computeHydroMetrics({ pesoPreKg, pesoPostKg, consumoMl, orinaEvacuadaMl, duracionMin });
    const targetIsoMl = metrics.deficitMl > 0 ? Math.round(metrics.deficitMl * (appState.draft.isoFactor || 1.5)) : 1000;
    const iso = computeIsotonicRecipe(targetIsoMl);

    const sessionRecord = {
      sessionId: appState.draft.sessionId || createSessionId(appState.athleteId),
      athleteId: appState.athleteId,
      athleteName: appState.athleteProfile?.nombre || "",
      deporte: appState.athleteProfile?.deporte || "",
      createdAt: new Date().toISOString(),
      capacidadTermoMl: getThermoMl(),
      pesoPreKg,
      pesoPostKg,
      orinaArmstrong: Number(appState.draft.orinaArmstrong) || 2,
      nivelSed: appState.draft.nivelSed || "baja",
      alertaPreHidratacion: Number(appState.draft.orinaArmstrong) >= 5 || appState.draft.nivelSed === "alta",
      consumoMl,
      orinaEvacuadaMl,
      duracionMin,
      tasaSudoracionLh: Number(metrics.tasaSudoracionLh.toFixed(3)),
      deshidratacionPct: Number(metrics.deshidratacionPct.toFixed(3)),
      metaMinMl: metrics.metaMinMl,
      metaMaxMl: metrics.metaMaxMl,
      salMinG: Number(iso.salMinG.toFixed(2)),
      salMaxG: Number(iso.salMaxG.toFixed(2)),
      carboG: Number(iso.carboG.toFixed(1))
    };

    await HydroTagDB.saveSession(sessionRecord);
    if (appState.athleteProfile) {
      await HydroTagDB.saveAthlete({ ...appState.athleteProfile, consumoEnCursoMl: 0, tomasEnCurso: 0 });
    }
    appState.draft.lastResult = sessionRecord;
    saveDraft(appState.athleteId, appState.draft);

    renderPhase3Results();
    replayAnimation($("phase3-results"), "phase-enter");
    $("res-save-status").textContent =
      HydroTagDB.getMode().mode === "firebase" ? "Guardado en la nube." : "Guardado en este dispositivo.";
    $("phase3-results").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("btn-new-session").addEventListener("click", async () => {
    appState.draft = createDefaultDraft(appState.athleteId);
    saveDraft(appState.athleteId, appState.draft);
    await syncAthleteLiveProgress(appState.athleteProfile, appState.draft);
    await initAthleteView(appState.athleteId, { isNfcEntry: false });
    window.scrollTo({ top: 0 });
  });

  // Admin
  $("admin-filter-athlete").addEventListener("change", renderAdminDashboard);
  $("admin-filter-search").addEventListener("input", renderAdminDashboard);
  $("admin-filter-red-only").addEventListener("change", renderAdminDashboard);
  $("btn-admin-export-csv").addEventListener("click", exportSessionsToCsv);
  $("btn-admin-back").addEventListener("click", () => navigateToParams({}));
  $("btn-admin-seed").addEventListener("click", async () => {
    const count = await HydroTagDB.seedDemoSessions();
    showToast(`${count} registros de ejemplo cargados`);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      syncWakeLock();
      if (appState.route === "athlete") tick();
    }
  });
  window.addEventListener("popstate", resolveRoute);
}

function registerServiceWorkerSafely() {
  if (!("serviceWorker" in navigator)) return;
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !isLocal) return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

async function bootstrap() {
  const dbInfo = await HydroTagDB.init();
  updateDbStatusUI(dbInfo);
  setupAudioUnlock();
  bindEvents();
  registerServiceWorkerSafely();
  await resolveRoute();
}

bootstrap();
