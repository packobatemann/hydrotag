import { HydroTagDB } from "./firebase-config.js";

// ============================================================================
// CONSTANTES CLÍNICAS Y UTILIDADES
// ============================================================================

const ARMSTRONG_SCALE = [
  { score: 1, color: "#F9FCE8", textDark: true, label: "Muy pálida — Hidratación óptima" },
  { score: 2, color: "#F4F7BE", textDark: true, label: "Paja pálida — Bien hidratado" },
  { score: 3, color: "#EFE884", textDark: true, label: "Amarillo claro — Estado normal" },
  { score: 4, color: "#E7D352", textDark: true, label: "Amarillo medio — Leve déficit" },
  { score: 5, color: "#DCB62F", textDark: true, label: "Amarillo oscuro — Deshidratación leve" },
  { score: 6, color: "#C9971C", textDark: false, label: "Ámbar — Deshidratación moderada" },
  { score: 7, color: "#AE7818", textDark: false, label: "Ámbar oscuro — Deshidratación marcada" },
  { score: 8, color: "#845514", textDark: false, label: "Marrón ámbar — Deshidratación severa" }
];

const THIRST_LABELS = {
  baja: "Sin sed",
  moderada: "Sed leve",
  alta: "Mucha sed"
};

const NA_MG_PER_G_SALT = 393; // 1 g sal de mesa (NaCl) = 393 mg de sodio
const DEFAULT_THERMO_ML = 750;
const DRAFT_PREFIX = "hydrotag_draft_v1_";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeAthleteId(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_-]/g, "");
  return cleaned;
}

function formatMl(val) {
  const num = Number(val) || 0;
  if (Math.abs(num - Math.round(num)) < 0.01) {
    return Math.round(num).toLocaleString("es-MX");
  }
  return Number(num.toFixed(1)).toLocaleString("es-MX", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}

function formatNumber(val, decimals = 2) {
  const num = Number(val);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(decimals);
}

function buildNfcUrl(athleteId) {
  const cleanId = sanitizeAthleteId(athleteId) || "ATLETA_01";
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

function createSessionId(athleteId) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SES_${athleteId}_${stamp}_${rand}`;
}

function createDefaultDraft(athleteId) {
  return {
    sessionId: createSessionId(athleteId),
    activePhase: 1,
    pesoPreKg: "",
    orinaArmstrong: 2,
    nivelSed: "baja",
    duracionMin: 60,
    consumoMl: 0,
    intakeLogs: [],
    pesoPostKg: "",
    orinaEvacuadaMl: 0,
    timerRunning: false,
    timerStartMs: null,
    timerAccumulatedMs: 0,
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
    // Ignorar error de almacenamiento
  }
}

// ============================================================================
// ESTADO GLOBAL DE LA APLICACIÓN
// ============================================================================

const appState = {
  route: "onboarding", // "onboarding" | "athlete" | "admin"
  athleteId: null,
  athleteProfile: null,
  draft: null,
  timerIntervalId: null,
  adminUnsubscribe: null,
  adminSessions: [],
  deferredInstallPrompt: null,
  thermoSaveTimeout: null
};

// ============================================================================
// ELEMENTOS DEL DOM & UTILIDADES UI
// ============================================================================

const $ = (id) => document.getElementById(id);

let toastTimeout = null;
function showToast(message, variant = "info") {
  const banner = $("toast-banner");
  if (!banner) return;

  banner.textContent = message;
  banner.classList.remove(
    "hidden",
    "border-cyan-400/50",
    "text-cyan-100",
    "border-emerald-400/50",
    "text-emerald-100",
    "border-amber-400/50",
    "text-amber-100",
    "border-rose-400/60",
    "text-rose-100"
  );

  if (variant === "success") {
    banner.classList.add("border-emerald-400/50", "text-emerald-100");
  } else if (variant === "warning") {
    banner.classList.add("border-amber-400/50", "text-amber-100");
  } else if (variant === "error") {
    banner.classList.add("border-rose-400/60", "text-rose-100");
  } else {
    banner.classList.add("border-cyan-400/50", "text-cyan-100");
  }

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    banner.classList.add("hidden");
  }, 3200);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Continuar al fallback
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
  if (!dot || !text) return;

  if (info.mode === "firebase") {
    dot.className = "h-2 w-2 rounded-full bg-emerald-400";
    text.textContent = `Firebase Cloud (${info.projectId})`;
    if (adminSyncMode) adminSyncMode.textContent = `Firestore Cloud • ${info.projectId}`;
  } else {
    dot.className = "h-2 w-2 rounded-full bg-amber-400";
    text.textContent = "Modo Offline / LocalStorage";
    if (adminSyncMode) adminSyncMode.textContent = "Respaldo LocalStorage (Multi-pestaña en vivo)";
  }
}

// ============================================================================
// RUTEADOR POR PARÁMETROS URL (?id=..., ?admin=true)
// ============================================================================

function navigateToParams(paramsObj) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  Object.entries(paramsObj).forEach(([k, v]) => {
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      url.searchParams.set(k, String(v).trim());
    }
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

  const params = new URLSearchParams(window.location.search);
  const isAdmin = params.get("admin") === "true";
  const rawId = params.get("id");
  const cleanId = rawId ? sanitizeAthleteId(rawId) : "";

  const viewOnb = $("view-onboarding");
  const viewAth = $("view-athlete");
  const viewAdmin = $("view-admin");
  const headerBadge = $("header-athlete-badge");
  const headerIdSpan = $("header-athlete-id");
  const adminBtnLabel = $("btn-go-admin-label");

  viewOnb.classList.add("hidden");
  viewAth.classList.add("hidden");
  viewAdmin.classList.add("hidden");
  headerBadge.classList.add("hidden");

  if (isAdmin) {
    appState.route = "admin";
    viewAdmin.classList.remove("hidden");
    adminBtnLabel.textContent = "Ir a Atletas";
    await initAdminView();
    return;
  }

  adminBtnLabel.textContent = "Panel Admin";

  if (cleanId) {
    appState.route = "athlete";
    appState.athleteId = cleanId;
    viewAth.classList.remove("hidden");
    headerBadge.classList.remove("hidden");
    headerBadge.classList.add("flex");
    headerIdSpan.textContent = cleanId;
    await initAthleteView(cleanId);
    return;
  }

  appState.route = "onboarding";
  appState.athleteId = null;
  viewOnb.classList.remove("hidden");
  await initOnboardingView();
}

// ============================================================================
// VISTA 1: ONBOARDING / GENERADOR NFC
// ============================================================================

function updateOnboardingPreview() {
  const idInput = $("onb-athlete-id");
  const cleanId = sanitizeAthleteId(idInput.value) || "ATLETA_01";
  $("onb-nfc-url").textContent = buildNfcUrl(cleanId);
}

function highlightOnboardingThermoPreset(ml) {
  document.querySelectorAll(".onb-thermo-preset").forEach((btn) => {
    const btnMl = Number(btn.dataset.ml);
    if (btnMl === Number(ml)) {
      btn.classList.remove("border-slate-700", "bg-slate-900/90", "text-slate-200");
      btn.classList.add("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    } else {
      btn.classList.add("border-slate-700", "bg-slate-900/90", "text-slate-200");
      btn.classList.remove("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    }
  });
}

async function renderSavedAthletesList() {
  const container = $("onb-saved-athletes");
  const countBadge = $("onb-athletes-count");
  const athletes = await HydroTagDB.listAthletes();
  countBadge.textContent = String(athletes.length);

  if (athletes.length === 0) {
    container.innerHTML = `
      <div class="sm:col-span-2 rounded-2xl border border-dashed border-slate-700 bg-slate-950/50 p-5 text-center text-xs text-slate-400">
        Aún no hay atletas guardados. Crea el primero arriba (ej. <strong class="text-cyan-300">ATLETA_01</strong>).
      </div>
    `;
    return;
  }

  container.innerHTML = athletes
    .map((ath) => {
      const safeId = escapeHtml(ath.id);
      const safeName = escapeHtml(ath.nombre || "Atleta registrado");
      const safeSport = escapeHtml(ath.deporte || "Sin disciplina");
      const thermo = formatMl(ath.capacidadTermoMl || DEFAULT_THERMO_ML);
      return `
        <button type="button" data-open-athlete="${safeId}"
          class="tap-btn flex items-center justify-between gap-3 rounded-2xl border border-slate-700/80 bg-slate-950/80 p-4 text-left transition hover:border-cyan-400/60 hover:bg-slate-900">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="rounded-md bg-[#0066FF]/20 px-2 py-0.5 font-mono text-xs font-black text-cyan-300">${safeId}</span>
              <span class="tabular-nums text-[11px] font-bold text-slate-400">${thermo} mL</span>
            </div>
            <p class="mt-1 truncate text-sm font-extrabold text-white">${safeName}</p>
            <p class="truncate text-xs text-slate-400">${safeSport}</p>
          </div>
          <span class="shrink-0 rounded-xl bg-cyan-500/15 px-3 py-2 text-xs font-black text-cyan-300">Abrir &rarr;</span>
        </button>
      `;
    })
    .join("");

  container.querySelectorAll("[data-open-athlete]").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigateToParams({ id: btn.dataset.openAthlete });
    });
  });
}

async function initOnboardingView() {
  const athletes = await HydroTagDB.listAthletes();
  if (!$("onb-athlete-id").value.trim()) {
    const nextNum = String(athletes.length + 1).padStart(2, "0");
    $("onb-athlete-id").value = `ATLETA_${nextNum}`;
  }
  highlightOnboardingThermoPreset($("onb-thermo-ml").value);
  updateOnboardingPreview();
  await renderSavedAthletesList();
}

// ============================================================================
// VISTA 2: PERFIL ATLETA, TERMO EDITABLE Y FLUJO DE 3 FASES
// ============================================================================

function renderArmstrongScale() {
  const grid = $("armstrong-scale-grid");
  const selected = Number(appState.draft?.orinaArmstrong) || 2;
  const selectedMeta = ARMSTRONG_SCALE.find((item) => item.score === selected) || ARMSTRONG_SCALE[1];

  $("armstrong-selected-label").textContent = `Nivel ${selectedMeta.score} — ${selectedMeta.label}`;
  $("wut-urine-val").textContent = `Nivel ${selectedMeta.score}`;
  $("p3-preview-armstrong").textContent = `Nivel ${selectedMeta.score}`;

  grid.innerHTML = ARMSTRONG_SCALE.map((item) => {
    const isActive = item.score === selected;
    const textClass = item.textDark ? "text-slate-950" : "text-white";
    const ringClass = isActive
      ? "ring-4 ring-[#00E5FF] ring-offset-2 ring-offset-[#060B14] scale-105"
      : "opacity-85 hover:opacity-100";

    return `
      <button type="button" data-armstrong="${item.score}" aria-label="Color de orina nivel ${item.score}: ${escapeHtml(item.label)}"
        style="background-color: ${item.color};"
        class="tap-btn flex min-h-[56px] flex-col items-center justify-center rounded-2xl border border-black/25 font-black transition ${textClass} ${ringClass}">
        <span class="text-lg leading-none">${item.score}</span>
        <span class="mt-0.5 text-[9px] font-extrabold uppercase tracking-tight opacity-80">${item.score >= 5 ? "Alerta" : "OK"}</span>
      </button>
    `;
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
  $("wut-thirst-val").textContent = THIRST_LABELS[current] || "Sin sed";

  document.querySelectorAll(".thirst-btn").forEach((btn) => {
    const val = btn.dataset.thirst;
    if (val === current) {
      btn.classList.remove("border-slate-700", "bg-slate-900", "text-slate-200");
      if (val === "alta") {
        btn.classList.add("border-amber-400", "bg-amber-500/20", "text-amber-200");
      } else {
        btn.classList.add("border-[#00E5FF]", "bg-cyan-500/20", "text-cyan-100");
      }
    } else {
      btn.classList.remove(
        "border-[#00E5FF]",
        "bg-cyan-500/20",
        "text-cyan-100",
        "border-amber-400",
        "bg-amber-500/20",
        "text-amber-200"
      );
      btn.classList.add("border-slate-700", "bg-slate-900", "text-slate-200");
    }
  });
}

function updatePreHydrationAlert() {
  const draft = appState.draft;
  const profile = appState.athleteProfile;
  if (!draft || !profile) return;

  const pesoPre = Number(draft.pesoPreKg);
  $("wut-weight-val").textContent = pesoPre > 0 ? `${pesoPre.toFixed(1)} kg` : "-- kg";
  $("p3-preview-pre").textContent = pesoPre > 0 ? `${pesoPre.toFixed(1)} kg` : "-- kg";

  const alertBox = $("prehydration-alert");
  const reasonEl = $("prehydration-reason");
  const doseBox = $("prehydration-dose-box");

  const highUrine = Number(draft.orinaArmstrong) >= 5;
  const highThirst = draft.nivelSed === "alta";

  if (!highUrine && !highThirst) {
    alertBox.classList.add("hidden");
    return;
  }

  alertBox.classList.remove("hidden");

  const reasons = [];
  if (highUrine) reasons.push(`Orina Armstrong nivel ${draft.orinaArmstrong} (≥ 5)`);
  if (highThirst) reasons.push("Mucha sed reportada (modelo WUT)");
  reasonEl.textContent = `Criterio activado: ${reasons.join(" + ")}. Protocolo recomendado antes de entrenar: 5–7 mL/kg.`;

  if (pesoPre > 0) {
    const minMl = Math.round(pesoPre * 5);
    const maxMl = Math.round(pesoPre * 7);
    const thermoMl = Number(profile.capacidadTermoMl) || DEFAULT_THERMO_ML;
    const minTermos = (minMl / thermoMl).toFixed(2);
    const maxTermos = (maxMl / thermoMl).toFixed(2);

    doseBox.innerHTML = `
      Ingerir <span class="text-amber-300 font-black">${minMl.toLocaleString("es-MX")} – ${maxMl.toLocaleString("es-MX")} mL</span>
      <span class="block text-xs font-semibold text-slate-300 mt-0.5">
        Equivale a ${minTermos} – ${maxTermos} termos de ${formatMl(thermoMl)} mL (2–4 h o previo al inicio).
      </span>
    `;
  } else {
    doseBox.textContent = "Ingresa el Peso Corporal Inicial (kg) arriba para calcular la dosis exacta (5–7 mL/kg).";
  }
}

function updateDynamicThermoUI() {
  const thermoMl = Number(appState.athleteProfile?.capacidadTermoMl) || DEFAULT_THERMO_ML;
  $("ath-thermo-badge").textContent = `${formatMl(thermoMl)} mL`;

  const inputEl = $("ath-thermo-input");
  if (document.activeElement !== inputEl) {
    inputEl.value = thermoMl;
  }

  document.querySelectorAll(".ath-thermo-preset").forEach((btn) => {
    const val = Number(btn.dataset.ml);
    if (val === thermoMl) {
      btn.classList.remove("border-slate-700", "bg-slate-900", "text-slate-200");
      btn.classList.add("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    } else {
      btn.classList.add("border-slate-700", "bg-slate-900", "text-slate-200");
      btn.classList.remove("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    }
  });

  $("label-full-ml").textContent = formatMl(thermoMl);
  $("label-half-ml").textContent = formatMl(thermoMl / 2);
  $("label-quarter-ml").textContent = formatMl(thermoMl / 4);

  updateIntakeUI();

  if (appState.draft?.lastResult) {
    renderPhase3Results();
  }
}

function updateIntakeUI() {
  const draft = appState.draft;
  const thermoMl = Number(appState.athleteProfile?.capacidadTermoMl) || DEFAULT_THERMO_ML;
  if (!draft) return;

  const totalMl = Number(draft.consumoMl) || 0;
  const totalL = totalMl / 1000;
  const termos = thermoMl > 0 ? totalMl / thermoMl : 0;

  $("intake-total-ml").textContent = formatMl(totalMl);
  $("intake-total-liters").textContent = `${totalL.toFixed(2)} L`;
  $("intake-thermos-count").textContent = `${termos.toFixed(2)} termos`;
  $("p3-preview-intake").textContent = `${formatMl(totalMl)} mL`;

  const undoBtn = $("btn-drink-undo");
  const undoText = $("btn-drink-undo-text");
  const logs = draft.intakeLogs || [];

  if (logs.length === 0) {
    undoBtn.disabled = true;
    undoText.textContent = "Deshacer último registro";
  } else {
    undoBtn.disabled = false;
    const last = logs[logs.length - 1];
    undoText.textContent = `Deshacer último registro (-${formatMl(last.ml)} mL)`;
  }

  const listEl = $("intake-logs-list");
  if (logs.length === 0) {
    listEl.innerHTML = `<span class="text-slate-500">Sin registros aún. Usa los botones de termo arriba.</span>`;
  } else {
    listEl.innerHTML = logs
      .map(
        (entry, idx) => `
          <span class="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-bold text-cyan-200">
            <span class="text-slate-400">#${idx + 1}</span>
            <span>+${formatMl(entry.ml)} mL</span>
            <span class="text-[10px] text-slate-400">(${escapeHtml(entry.fractionLabel)})</span>
          </span>
        `
      )
      .join("");
  }
}

function highlightDurationPreset(minutes) {
  $("p3-preview-dur").textContent = `${minutes} min`;
  document.querySelectorAll(".duration-preset").forEach((btn) => {
    const val = Number(btn.dataset.min);
    if (val === Number(minutes)) {
      btn.classList.remove("border-slate-700", "bg-slate-900", "text-slate-300");
      btn.classList.add("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    } else {
      btn.classList.add("border-slate-700", "bg-slate-900", "text-slate-300");
      btn.classList.remove("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    }
  });
}

function highlightUrineVolPreset(ml) {
  document.querySelectorAll(".urine-vol-preset").forEach((btn) => {
    const val = Number(btn.dataset.urine);
    if (val === Number(ml)) {
      btn.classList.remove("border-slate-700", "bg-slate-900", "text-slate-300");
      btn.classList.add("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    } else {
      btn.classList.add("border-slate-700", "bg-slate-900", "text-slate-300");
      btn.classList.remove("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    }
  });
}

function setActivePhase(phaseNum) {
  const phase = Number(phaseNum) || 1;
  appState.draft.activePhase = phase;
  saveDraft(appState.athleteId, appState.draft);

  [1, 2, 3].forEach((p) => {
    const tab = $(`tab-phase-${p}`);
    const panel = $(`panel-phase-${p}`);
    if (p === phase) {
      tab.classList.add("bg-gradient-to-r", "from-[#0066FF]", "to-[#00B8FF]", "text-slate-950", "shadow-lg");
      tab.classList.remove("text-slate-400", "hover:bg-white/5");
      panel.classList.remove("hidden");
    } else {
      tab.classList.remove("bg-gradient-to-r", "from-[#0066FF]", "to-[#00B8FF]", "text-slate-950", "shadow-lg");
      tab.classList.add("text-slate-400", "hover:bg-white/5");
      panel.classList.add("hidden");
    }
  });
}

// ============================================================================
// CRONÓMETRO DE SESIÓN
// ============================================================================

function getElapsedStopwatchMs() {
  const draft = appState.draft;
  if (!draft) return 0;
  const acc = Number(draft.timerAccumulatedMs) || 0;
  if (draft.timerRunning && draft.timerStartMs) {
    return acc + (Date.now() - Number(draft.timerStartMs));
  }
  return acc;
}

function renderStopwatch() {
  const draft = appState.draft;
  if (!draft) return;
  const elapsed = getElapsedStopwatchMs();
  $("stopwatch-display").textContent = formatStopwatch(elapsed);

  const toggleBtn = $("btn-timer-toggle");
  if (draft.timerRunning) {
    toggleBtn.textContent = "Pausar";
    toggleBtn.classList.remove("bg-[#0066FF]", "hover:bg-blue-500");
    toggleBtn.classList.add("bg-amber-500", "text-slate-950", "hover:bg-amber-400");
  } else {
    toggleBtn.textContent = elapsed > 0 ? "Reanudar" : "Iniciar";
    toggleBtn.classList.add("bg-[#0066FF]", "hover:bg-blue-500");
    toggleBtn.classList.remove("bg-amber-500", "text-slate-950", "hover:bg-amber-400");
  }
}

function startTimerLoop() {
  stopTimerLoop();
  if (appState.draft?.timerRunning) {
    appState.timerIntervalId = setInterval(renderStopwatch, 250);
  }
  renderStopwatch();
}

function stopTimerLoop() {
  if (appState.timerIntervalId) {
    clearInterval(appState.timerIntervalId);
    appState.timerIntervalId = null;
  }
}

// ============================================================================
// CÁLCULOS CLÍNICO-DEPORTIVOS (FASE 3)
// ============================================================================

function computeHydroMetrics({
  pesoPreKg,
  pesoPostKg,
  consumoMl,
  orinaEvacuadaMl,
  duracionMin
}) {
  const horas = duracionMin / 60;
  const pesoPerdidoKg = pesoPreKg - pesoPostKg;
  const consumoL = consumoMl / 1000;
  const orinaL = orinaEvacuadaMl / 1000;

  // Tasa de Sudoración Real (L/h) = ((Peso_pre - Peso_post) + Líquido_ingerido - Orina) / Horas
  const sudorTotalL = pesoPerdidoKg + consumoL - orinaL;
  const tasaSudoracionLh = sudorTotalL / horas;

  // Porcentaje de Deshidratación Aguda (% cambio de masa corporal)
  const deshidratacionPct = ((pesoPreKg - pesoPostKg) / pesoPreKg) * 100;

  // Déficit hídrico perdido y Meta de Rehidratación (125% a 150%)
  const deficitMl = Math.max(0, pesoPerdidoKg * 1000);
  const metaMinMl = Math.round(deficitMl * 1.25);
  const metaMaxMl = Math.round(deficitMl * 1.5);

  return {
    horas,
    pesoPerdidoKg,
    sudorTotalL,
    tasaSudoracionLh,
    deshidratacionPct,
    deficitMl,
    metaMinMl,
    metaMaxMl
  };
}

function computeIsotonicRecipe(targetVolumeMl) {
  const liters = targetVolumeMl / 1000;
  // Sal de mesa: 1 g = 393 mg Na -> objetivo 500 a 700 mg/L (punto óptimo 600 mg/L)
  const salMinG = (500 * liters) / NA_MG_PER_G_SALT;
  const salMaxG = (700 * liters) / NA_MG_PER_G_SALT;
  const salOptG = (600 * liters) / NA_MG_PER_G_SALT;
  // Carbohidratos al 6% = 60 g/L
  const carboG = 60 * liters;

  return { targetVolumeMl, liters, salMinG, salMaxG, salOptG, carboG };
}

function renderPhase3Results() {
  const res = appState.draft?.lastResult;
  if (!res) {
    $("phase3-results").classList.add("hidden");
    return;
  }

  $("phase3-results").classList.remove("hidden");

  // 1. Semáforo de deshidratación aguda
  const pct = Number(res.deshidratacionPct);
  const diffKg = Number(res.pesoPreKg) - Number(res.pesoPostKg);
  const card = $("res-semaforo-card");
  const badge = $("res-semaforo-badge");
  const msg = $("res-dehydration-msg");

  card.classList.remove(
    "border-emerald-400/70",
    "bg-emerald-950/45",
    "text-emerald-100",
    "border-amber-400/70",
    "bg-amber-950/45",
    "text-amber-100",
    "border-rose-500/80",
    "bg-rose-950/60",
    "text-rose-100"
  );
  badge.classList.remove(
    "bg-emerald-400",
    "text-slate-950",
    "bg-amber-400",
    "bg-rose-500",
    "text-white"
  );

  if (pct > 2) {
    card.classList.add("border-rose-500/80", "bg-rose-950/60", "text-rose-100");
    badge.classList.add("bg-rose-500", "text-white");
    badge.textContent = "ROJO • CRÍTICO >2%";
    msg.textContent =
      "Umbral de caída de rendimiento físico y cognitivo superado (>2%). Prioriza reposición hídrica y electrolítica inmediata antes de la próxima sesión.";
  } else if (pct >= 1) {
    card.classList.add("border-amber-400/70", "bg-amber-950/45", "text-amber-100");
    badge.classList.add("bg-amber-400", "text-slate-950");
    badge.textContent = "AMARILLO • PRECAUCIÓN 1–2%";
    msg.textContent =
      "Deshidratación leve a moderada (1–2%). Aumenta la pauta de ingesta intra-entreno en próximas sesiones.";
  } else {
    card.classList.add("border-emerald-400/70", "bg-emerald-950/45", "text-emerald-100");
    badge.classList.add("bg-emerald-400", "text-slate-950");
    badge.textContent = "VERDE • ÓPTIMO <1%";
    msg.textContent =
      pct < 0
        ? "Ganancia neta de peso post-sesión (<0%). Hidratación cubierta; evita exceder el consumo para prevenir hiponatremia asociada al ejercicio."
        : "Estado de euhidratación preservado (<1%). La estrategia de hidratación durante la sesión fue adecuada.";
  }

  $("res-dehydration-pct").textContent = `${pct.toFixed(2)}%`;
  $("res-weight-diff").textContent =
    diffKg >= 0 ? `(-${diffKg.toFixed(2)} kg perdidos)` : `(+${Math.abs(diffKg).toFixed(2)} kg ganados)`;

  // 2. Tasa de sudoración real
  const lh = Number(res.tasaSudoracionLh);
  $("res-sweat-lh").textContent = lh.toFixed(2);
  $("res-sweat-mlh").textContent = `${Math.round(lh * 1000).toLocaleString("es-MX")} mL/hora`;
  $("res-sweat-formula").textContent = `((${res.pesoPreKg.toFixed(1)} − ${res.pesoPostKg.toFixed(
    1
  )}) + ${(res.consumoMl / 1000).toFixed(2)} L − ${(res.orinaEvacuadaMl / 1000).toFixed(2)} L) / ${(
    res.duracionMin / 60
  ).toFixed(2)} h`;

  // 3. Meta de rehidratación 125%-150%
  const thermoMl = Number(appState.athleteProfile?.capacidadTermoMl) || DEFAULT_THERMO_ML;
  const deficitMl = Math.max(0, Math.round((res.pesoPreKg - res.pesoPostKg) * 1000));
  $("res-rehydration-range").textContent = `${res.metaMinMl.toLocaleString("es-MX")} – ${res.metaMaxMl.toLocaleString(
    "es-MX"
  )} mL`;
  $("res-deficit-ml").textContent = `Déficit hídrico neto: ${deficitMl.toLocaleString("es-MX")} mL`;

  if (deficitMl > 0) {
    const minT = (res.metaMinMl / thermoMl).toFixed(2);
    const maxT = (res.metaMaxMl / thermoMl).toFixed(2);
    $("res-rehydration-thermos").textContent = `Equivale a ${minT} – ${maxT} termos de ${formatMl(thermoMl)} mL (en las próximas 2–4 h).`;
  } else {
    $("res-rehydration-thermos").textContent = "Sin déficit hídrico neto: mantén hidratación habitual a libre demanda.";
  }

  // 4. Calculadora de bebida isotónica casera
  const isoFactor = Number(appState.draft.isoFactor) || 1.5;
  document.querySelectorAll(".iso-pct-btn").forEach((btn) => {
    const f = Number(btn.dataset.factor);
    if (Math.abs(f - isoFactor) < 0.001) {
      btn.classList.remove("border-slate-700", "bg-slate-900", "text-slate-300");
      btn.classList.add("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    } else {
      btn.classList.add("border-slate-700", "bg-slate-900", "text-slate-300");
      btn.classList.remove("border-cyan-400", "bg-cyan-500/20", "text-cyan-200");
    }
  });

  const targetMl = deficitMl > 0 ? Math.round(deficitMl * isoFactor) : 1000;
  const recipe = computeIsotonicRecipe(targetMl);
  const perThermo = computeIsotonicRecipe(thermoMl);

  $("iso-target-ml").textContent =
    deficitMl > 0
      ? `Meta ${(isoFactor * 100).toFixed(1).replace(".0", "")}%: ${targetMl.toLocaleString("es-MX")} mL`
      : "Referencia 1,000 mL (déficit 0)";

  $("iso-salt-range").textContent = `${recipe.salMinG.toFixed(2)} – ${recipe.salMaxG.toFixed(2)} g`;
  $("iso-salt-opt").textContent = `Dosis óptima central (600 mg Na/L): ${recipe.salOptG.toFixed(2)} g de sal`;
  $("iso-carb-grams").textContent = `${recipe.carboG.toFixed(1)} g`;
  $("iso-carb-note").textContent = `Para ${recipe.liters.toFixed(2)} L al 6% (60 g/L)`;

  $("iso-per-thermo-note").innerHTML = `
    <span class="font-extrabold text-cyan-300">Preparación práctica por cada 1 Termo (${formatMl(thermoMl)} mL):</span>
    Disuelve <strong class="text-white">${perThermo.salMinG.toFixed(2)} – ${perThermo.salMaxG.toFixed(
      2
    )} g de sal</strong> (óptimo ${perThermo.salOptG.toFixed(2)} g) y <strong class="text-white">${perThermo.carboG.toFixed(
      1
    )} g de azúcar o maltodextrina</strong> en agua fría.
  `;
}

async function initAthleteView(athleteId) {
  let profile = await HydroTagDB.getAthlete(athleteId);
  if (!profile) {
    profile = await HydroTagDB.saveAthlete({
      id: athleteId,
      nombre: "",
      deporte: "",
      capacidadTermoMl: DEFAULT_THERMO_ML
    });
  }

  appState.athleteProfile = profile;
  appState.draft = loadDraft(athleteId);

  $("ath-id-label").textContent = profile.id;
  $("ath-name-display").textContent = profile.nombre || `Atleta ${profile.id}`;
  $("ath-sport-display").textContent = profile.deporte
    ? `${profile.deporte} • Perfil NFC activo`
    : "Perfil NFC activo • Toca 'Editar Datos' para personalizar";
  $("ath-name-input").value = profile.nombre || "";
  $("ath-sport-input").value = profile.deporte || "";
  $("profile-edit-drawer").classList.add("hidden");

  // Cargar valores del borrador en los inputs
  $("input-peso-pre").value = appState.draft.pesoPreKg || "";
  $("input-duracion-min").value = appState.draft.duracionMin || 60;
  $("input-peso-post").value = appState.draft.pesoPostKg || "";
  $("input-orina-ml").value = appState.draft.orinaEvacuadaMl ?? 0;

  updateDynamicThermoUI();
  renderArmstrongScale();
  renderThirstButtons();
  updatePreHydrationAlert();
  highlightDurationPreset(appState.draft.duracionMin || 60);
  highlightUrineVolPreset(appState.draft.orinaEvacuadaMl ?? 0);
  startTimerLoop();
  renderPhase3Results();
  setActivePhase(appState.draft.activePhase || 1);
}

async function updateThermoCapacity(newMl, showFeedback = false) {
  const val = Number(newMl);
  if (!Number.isFinite(val) || val < 50 || val > 5000) return;

  appState.athleteProfile.capacidadTermoMl = val;
  updateDynamicThermoUI();

  await HydroTagDB.saveAthlete(appState.athleteProfile);
  if (showFeedback) {
    showToast(`Termo actualizado a ${formatMl(val)} mL`, "success");
  }
}

// ============================================================================
// VISTA 3: PANEL DEL INVESTIGADOR / NUTRIÓLOGO (?admin=true)
// ============================================================================

function populateAdminAthleteFilter(sessions) {
  const select = $("admin-filter-athlete");
  const prevValue = select.value || "ALL";
  const ids = [...new Set(sessions.map((s) => s.athleteId).filter(Boolean))].sort();

  select.innerHTML =
    `<option value="ALL">Todos los atletas (${ids.length})</option>` +
    ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");

  if (ids.includes(prevValue)) {
    select.value = prevValue;
  } else {
    select.value = "ALL";
  }
}

function getFilteredAdminSessions() {
  const athleteFilter = $("admin-filter-athlete").value;
  const search = ($("admin-filter-search").value || "").trim().toLowerCase();
  const redOnly = $("admin-filter-red-only").checked;

  return appState.adminSessions.filter((s) => {
    if (athleteFilter && athleteFilter !== "ALL" && s.athleteId !== athleteFilter) {
      return false;
    }
    if (redOnly && !(Number(s.deshidratacionPct) > 2)) {
      return false;
    }
    if (search) {
      const haystack = `${s.athleteId || ""} ${s.athleteName || ""} ${s.deporte || ""} ${s.createdAt || ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function renderAdminDashboard() {
  const all = appState.adminSessions;
  const filtered = getFilteredAdminSessions();

  // KPIs globales sobre toda la base de datos
  const uniqueAthletes = new Set(all.map((s) => s.athleteId).filter(Boolean)).size;
  const redAlerts = all.filter((s) => Number(s.deshidratacionPct) > 2).length;
  const avgSweat =
    all.length > 0
      ? all.reduce((acc, s) => acc + (Number(s.tasaSudoracionLh) || 0), 0) / all.length
      : 0;

  $("kpi-total-sessions").textContent = String(all.length);
  $("kpi-unique-athletes").textContent = String(uniqueAthletes);
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

      const rowStyle = isRed
        ? "bg-rose-950/60 hover:bg-rose-950/80 border-l-4 border-l-rose-500"
        : "hover:bg-slate-900/70";

      let pctBadge = `<span class="inline-flex rounded-full bg-emerald-500/20 px-2.5 py-0.5 font-extrabold text-emerald-300">${pct.toFixed(2)}%</span>`;
      if (isRed) {
        pctBadge = `<span class="inline-flex items-center gap-1 rounded-full bg-rose-500 px-2.5 py-0.5 font-black text-white shadow">${pct.toFixed(2)}% • &gt;2%</span>`;
      } else if (isYellow) {
        pctBadge = `<span class="inline-flex rounded-full bg-amber-500/25 px-2.5 py-0.5 font-extrabold text-amber-300">${pct.toFixed(2)}%</span>`;
      }

      const armstrongInfo =
        ARMSTRONG_SCALE.find((a) => a.score === Number(s.orinaArmstrong)) || ARMSTRONG_SCALE[1];

      const dateStr = s.createdAt
        ? new Date(s.createdAt).toLocaleString("es-MX", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          })
        : "--";

      const safeId = escapeHtml(s.athleteId);
      const safeName = escapeHtml(s.athleteName || "");
      const safeSessionId = escapeHtml(s.sessionId);

      return `
        <tr class="${rowStyle} transition">
          <td class="px-4 py-3 whitespace-nowrap">
            <button type="button" data-open-id="${safeId}" class="font-mono text-xs font-black text-cyan-300 hover:underline">
              ${safeId}
            </button>
            ${safeName ? `<div class="text-[11px] text-slate-400">${safeName}</div>` : ""}
          </td>
          <td class="px-3 py-3 whitespace-nowrap text-slate-300">${escapeHtml(dateStr)}</td>
          <td class="px-3 py-3 whitespace-nowrap tabular-nums text-slate-300">${formatMl(s.capacidadTermoMl)} mL</td>
          <td class="px-3 py-3 whitespace-nowrap tabular-nums font-semibold text-white">
            ${Number(s.pesoPreKg).toFixed(1)} &rarr; ${Number(s.pesoPostKg).toFixed(1)} kg
          </td>
          <td class="px-3 py-3 whitespace-nowrap tabular-nums text-cyan-300 font-bold">${formatMl(s.consumoMl)} mL</td>
          <td class="px-3 py-3 whitespace-nowrap tabular-nums text-slate-300">${Number(s.duracionMin)} min</td>
          <td class="px-3 py-3 whitespace-nowrap tabular-nums font-black text-white">${Number(s.tasaSudoracionLh).toFixed(2)} L/h</td>
          <td class="px-3 py-3 whitespace-nowrap tabular-nums">${pctBadge}</td>
          <td class="px-3 py-3 whitespace-nowrap">
            <span class="inline-flex items-center gap-1.5 font-bold text-slate-200">
              <span class="h-3 w-3 rounded-full border border-white/25" style="background-color:${armstrongInfo.color}"></span>
              ${Number(s.orinaArmstrong)}/8
            </span>
          </td>
          <td class="px-3 py-3 whitespace-nowrap tabular-nums font-bold text-cyan-200">
            ${Number(s.metaMinMl).toLocaleString("es-MX")}–${Number(s.metaMaxMl).toLocaleString("es-MX")} mL
          </td>
          <td class="px-3 py-3 whitespace-nowrap text-right">
            <button type="button" data-delete-session="${safeSessionId}" title="Eliminar registro"
              class="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-slate-400 hover:border-rose-500/60 hover:text-rose-300">
              Borrar
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-open-id]").forEach((btn) => {
    btn.addEventListener("click", () => navigateToParams({ id: btn.dataset.openId }));
  });

  tbody.querySelectorAll("[data-delete-session]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await HydroTagDB.deleteSession(btn.dataset.deleteSession);
      showToast("Registro eliminado de la base de datos", "info");
    });
  });
}

function csvCell(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportSessionsToCsv() {
  const rowsToExport = getFilteredAdminSessions();
  if (rowsToExport.length === 0) {
    showToast("No hay registros para exportar", "warning");
    return;
  }

  const headers = [
    "ID",
    "Fecha",
    "Capacidad_Termo_mL",
    "Peso_Pre",
    "Peso_Post",
    "Consumo_mL",
    "Duracion_min",
    "Tasa_Sudoracion_Lh",
    "Deshidratacion_Pct",
    "Orina_Armstrong",
    "Meta_Reposicion_mL",
    "Meta_Reposicion_125_mL",
    "Meta_Reposicion_150_mL",
    "Orina_Evacuada_mL",
    "Nivel_Sed"
  ];

  const lines = [headers.join(",")];

  rowsToExport.forEach((s) => {
    const fechaIso = s.createdAt || new Date().toISOString();
    const metaRange = `${Math.round(Number(s.metaMinMl) || 0)}-${Math.round(Number(s.metaMaxMl) || 0)}`;
    const row = [
      csvCell(s.athleteId),
      csvCell(fechaIso),
      csvCell(Number(s.capacidadTermoMl || 0)),
      csvCell(Number(s.pesoPreKg || 0).toFixed(2)),
      csvCell(Number(s.pesoPostKg || 0).toFixed(2)),
      csvCell(Number(s.consumoMl || 0)),
      csvCell(Number(s.duracionMin || 0)),
      csvCell(Number(s.tasaSudoracionLh || 0).toFixed(2)),
      csvCell(Number(s.deshidratacionPct || 0).toFixed(2)),
      csvCell(Number(s.orinaArmstrong || 0)),
      csvCell(metaRange),
      csvCell(Math.round(Number(s.metaMinMl) || 0)),
      csvCell(Math.round(Number(s.metaMaxMl) || 0)),
      csvCell(Math.round(Number(s.orinaEvacuadaMl) || 0)),
      csvCell(s.nivelSed || "baja")
    ];
    lines.push(row.join(","));
  });

  const csvContent = "\uFEFF" + lines.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.setAttribute("download", `HydroTag_BaseDatos_${today}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast(`CSV exportado (${rowsToExport.length} registros)`, "success");
}

async function initAdminView() {
  appState.adminUnsubscribe = await HydroTagDB.subscribeSessions((sessions) => {
    appState.adminSessions = sessions;
    populateAdminAthleteFilter(sessions);
    renderAdminDashboard();
  });
}

// ============================================================================
// REGISTRO DE EVENTOS E INICIALIZACIÓN
// ============================================================================

function bindEvents() {
  // Header navegación
  $("btn-go-home").addEventListener("click", () => navigateToParams({}));
  $("btn-go-admin").addEventListener("click", () => {
    if (appState.route === "admin") {
      navigateToParams(appState.athleteId ? { id: appState.athleteId } : {});
    } else {
      navigateToParams({ admin: "true" });
    }
  });

  // PWA Install Prompt
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    appState.deferredInstallPrompt = event;
    const btn = $("btn-install-pwa");
    btn.classList.remove("hidden");
    btn.classList.add("flex");
  });

  $("btn-install-pwa").addEventListener("click", async () => {
    if (!appState.deferredInstallPrompt) return;
    appState.deferredInstallPrompt.prompt();
    await appState.deferredInstallPrompt.userChoice;
    appState.deferredInstallPrompt = null;
    $("btn-install-pwa").classList.add("hidden");
  });

  // Onboarding eventos
  $("onb-athlete-id").addEventListener("input", updateOnboardingPreview);

  $("btn-generate-id").addEventListener("click", async () => {
    const athletes = await HydroTagDB.listAthletes();
    const num = String(athletes.length + 1 + Math.floor(Math.random() * 9)).padStart(2, "0");
    $("onb-athlete-id").value = `ATLETA_${num}`;
    updateOnboardingPreview();
  });

  document.querySelectorAll(".onb-thermo-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ml = Number(btn.dataset.ml);
      $("onb-thermo-ml").value = ml;
      highlightOnboardingThermoPreset(ml);
    });
  });

  $("onb-thermo-ml").addEventListener("input", () => {
    highlightOnboardingThermoPreset($("onb-thermo-ml").value);
  });

  $("btn-onb-copy-nfc").addEventListener("click", async () => {
    const cleanId = sanitizeAthleteId($("onb-athlete-id").value) || "ATLETA_01";
    $("onb-athlete-id").value = cleanId;
    const url = buildNfcUrl(cleanId);
    const ok = await copyTextToClipboard(url);
    showToast(ok ? `URL NFC copiada: ?id=${cleanId}` : "No se pudo copiar automáticamente", ok ? "success" : "warning");
  });

  $("btn-onb-write-nfc").addEventListener("click", async () => {
    const cleanId = sanitizeAthleteId($("onb-athlete-id").value) || "ATLETA_01";
    const url = buildNfcUrl(cleanId);
    if (!("NDEFReader" in window)) {
      showToast("Web NFC requiere Chrome en Android con HTTPS. Usa 'Copiar URL para NFC' con NFC Tools.", "warning");
      return;
    }
    try {
      const ndef = new window.NDEFReader();
      showToast("Acerca el chip NFC al teléfono para grabar...", "info");
      await ndef.write({ records: [{ recordType: "url", data: url }] });
      showToast(`Chip NFC grabado con éxito (${cleanId})`, "success");
    } catch {
      showToast("No se pudo grabar el chip NFC (verifica permisos o usa NFC Tools).", "warning");
    }
  });

  $("form-onboarding").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cleanId = sanitizeAthleteId($("onb-athlete-id").value);
    if (!cleanId) {
      showToast("Ingresa un ID válido para el atleta", "error");
      $("onb-athlete-id").focus();
      return;
    }
    const thermoMl = Number($("onb-thermo-ml").value) || DEFAULT_THERMO_ML;
    if (thermoMl < 50 || thermoMl > 5000) {
      showToast("La capacidad del termo debe estar entre 50 y 5000 mL", "error");
      return;
    }

    await HydroTagDB.saveAthlete({
      id: cleanId,
      nombre: $("onb-athlete-name").value.trim(),
      deporte: $("onb-athlete-sport").value.trim(),
      capacidadTermoMl: thermoMl
    });

    navigateToParams({ id: cleanId });
  });

  // Vista Atleta: perfil & termo
  $("btn-toggle-profile-edit").addEventListener("click", () => {
    $("profile-edit-drawer").classList.toggle("hidden");
  });

  $("btn-save-profile-meta").addEventListener("click", async () => {
    if (!appState.athleteProfile) return;
    appState.athleteProfile.nombre = $("ath-name-input").value.trim();
    appState.athleteProfile.deporte = $("ath-sport-input").value.trim();
    await HydroTagDB.saveAthlete(appState.athleteProfile);
    $("ath-name-display").textContent = appState.athleteProfile.nombre || `Atleta ${appState.athleteProfile.id}`;
    $("ath-sport-display").textContent = appState.athleteProfile.deporte
      ? `${appState.athleteProfile.deporte} • Perfil NFC activo`
      : "Perfil NFC activo";
    $("profile-edit-drawer").classList.add("hidden");
    showToast("Datos del atleta actualizados", "success");
  });

  $("btn-ath-copy-nfc").addEventListener("click", async () => {
    const url = buildNfcUrl(appState.athleteId);
    const ok = await copyTextToClipboard(url);
    showToast(ok ? "URL lista para grabar en chip NFC copiada" : "No se pudo copiar al portapapeles", ok ? "success" : "warning");
  });

  document.querySelectorAll(".ath-thermo-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ml = Number(btn.dataset.ml);
      $("ath-thermo-input").value = ml;
      updateThermoCapacity(ml, true);
    });
  });

  $("ath-thermo-input").addEventListener("input", () => {
    const val = Number($("ath-thermo-input").value);
    if (!Number.isFinite(val) || val < 50 || val > 5000) return;
    clearTimeout(appState.thermoSaveTimeout);
    appState.athleteProfile.capacidadTermoMl = val;
    updateDynamicThermoUI();
    appState.thermoSaveTimeout = setTimeout(() => {
      updateThermoCapacity(val, false);
    }, 350);
  });

  // Stepper fases
  document.querySelectorAll(".phase-tab").forEach((btn) => {
    btn.addEventListener("click", () => setActivePhase(Number(btn.dataset.phase)));
  });

  $("btn-to-phase-2").addEventListener("click", () => setActivePhase(2));
  $("btn-to-phase-3").addEventListener("click", () => setActivePhase(3));

  // Fase 1 inputs
  $("input-peso-pre").addEventListener("input", () => {
    appState.draft.pesoPreKg = $("input-peso-pre").value;
    saveDraft(appState.athleteId, appState.draft);
    updatePreHydrationAlert();
  });

  document.querySelectorAll(".thirst-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.draft.nivelSed = btn.dataset.thirst;
      saveDraft(appState.athleteId, appState.draft);
      renderThirstButtons();
      updatePreHydrationAlert();
    });
  });

  // Fase 2 cronómetro & duración
  $("btn-timer-toggle").addEventListener("click", () => {
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
    saveDraft(appState.athleteId, appState.draft);
    startTimerLoop();
  });

  $("btn-timer-sync").addEventListener("click", () => {
    const elapsedMs = getElapsedStopwatchMs();
    if (elapsedMs < 1000) {
      showToast("Inicia el cronómetro primero para aplicar minutos", "warning");
      return;
    }
    const mins = Math.max(1, Math.round(elapsedMs / 60000));
    appState.draft.duracionMin = mins;
    $("input-duracion-min").value = mins;
    highlightDurationPreset(mins);
    saveDraft(appState.athleteId, appState.draft);
    showToast(`Duración actualizada a ${mins} min desde el cronómetro`, "success");
  });

  $("input-duracion-min").addEventListener("input", () => {
    const mins = Math.max(1, Number($("input-duracion-min").value) || 0);
    appState.draft.duracionMin = mins;
    highlightDurationPreset(mins);
    saveDraft(appState.athleteId, appState.draft);
  });

  document.querySelectorAll(".duration-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mins = Number(btn.dataset.min);
      $("input-duracion-min").value = mins;
      appState.draft.duracionMin = mins;
      highlightDurationPreset(mins);
      saveDraft(appState.athleteId, appState.draft);
    });
  });

  $("btn-dur-minus5").addEventListener("click", () => {
    const next = Math.max(5, (Number($("input-duracion-min").value) || 60) - 5);
    $("input-duracion-min").value = next;
    appState.draft.duracionMin = next;
    highlightDurationPreset(next);
    saveDraft(appState.athleteId, appState.draft);
  });

  $("btn-dur-plus5").addEventListener("click", () => {
    const next = Math.min(720, (Number($("input-duracion-min").value) || 60) + 5);
    $("input-duracion-min").value = next;
    appState.draft.duracionMin = next;
    highlightDurationPreset(next);
    saveDraft(appState.athleteId, appState.draft);
  });

  // Fase 2 botones dinámicos del termo
  function addIntake(fraction, label) {
    const thermoMl = Number(appState.athleteProfile?.capacidadTermoMl) || DEFAULT_THERMO_ML;
    const addedMl = Number((thermoMl * fraction).toFixed(1));
    appState.draft.intakeLogs.push({
      id: Date.now(),
      fractionLabel: label,
      ml: addedMl
    });
    appState.draft.consumoMl = Number(
      appState.draft.intakeLogs.reduce((sum, item) => sum + item.ml, 0).toFixed(1)
    );
    saveDraft(appState.athleteId, appState.draft);
    updateIntakeUI();
    showToast(`+${formatMl(addedMl)} mL registrados`, "success");
  }

  $("btn-drink-full").addEventListener("click", () => addIntake(1, "1 Termo"));
  $("btn-drink-half").addEventListener("click", () => addIntake(0.5, "1/2 Termo"));
  $("btn-drink-quarter").addEventListener("click", () => addIntake(0.25, "1/4 Termo"));

  $("btn-drink-undo").addEventListener("click", () => {
    const logs = appState.draft.intakeLogs;
    if (!logs || logs.length === 0) return;
    const removed = logs.pop();
    appState.draft.consumoMl = Number(logs.reduce((sum, item) => sum + item.ml, 0).toFixed(1));
    saveDraft(appState.athleteId, appState.draft);
    updateIntakeUI();
    showToast(`Registro deshecho (-${formatMl(removed.ml)} mL)`, "info");
  });

  // Fase 3 inputs & cálculo
  $("input-peso-post").addEventListener("input", () => {
    appState.draft.pesoPostKg = $("input-peso-post").value;
    saveDraft(appState.athleteId, appState.draft);
  });

  $("input-orina-ml").addEventListener("input", () => {
    appState.draft.orinaEvacuadaMl = Math.max(0, Number($("input-orina-ml").value) || 0);
    highlightUrineVolPreset(appState.draft.orinaEvacuadaMl);
    saveDraft(appState.athleteId, appState.draft);
  });

  document.querySelectorAll(".urine-vol-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ml = Number(btn.dataset.urine);
      $("input-orina-ml").value = ml;
      appState.draft.orinaEvacuadaMl = ml;
      highlightUrineVolPreset(ml);
      saveDraft(appState.athleteId, appState.draft);
    });
  });

  document.querySelectorAll(".iso-pct-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.draft.isoFactor = Number(btn.dataset.factor);
      saveDraft(appState.athleteId, appState.draft);
      renderPhase3Results();
    });
  });

  $("btn-calculate-save").addEventListener("click", async () => {
    const errBox = $("phase3-validation-error");
    errBox.classList.add("hidden");

    const pesoPreKg = Number(appState.draft.pesoPreKg);
    const pesoPostKg = Number(appState.draft.pesoPostKg);
    const duracionMin = Number(appState.draft.duracionMin);
    const consumoMl = Number(appState.draft.consumoMl) || 0;
    const orinaEvacuadaMl = Math.max(0, Number(appState.draft.orinaEvacuadaMl) || 0);

    const errors = [];
    if (!Number.isFinite(pesoPreKg) || pesoPreKg < 20 || pesoPreKg > 250) {
      errors.push("Ingresa un Peso Corporal Inicial (Fase 1) válido entre 20 y 250 kg.");
    }
    if (!Number.isFinite(pesoPostKg) || pesoPostKg < 20 || pesoPostKg > 250) {
      errors.push("Ingresa un Peso Corporal Final (Fase 3) válido entre 20 y 250 kg.");
    }
    if (!Number.isFinite(duracionMin) || duracionMin <= 0) {
      errors.push("La duración de la sesión (Fase 2) debe ser mayor a 0 minutos.");
    }

    if (errors.length > 0) {
      errBox.textContent = errors.join(" ");
      errBox.classList.remove("hidden");
      return;
    }

    const metrics = computeHydroMetrics({
      pesoPreKg,
      pesoPostKg,
      consumoMl,
      orinaEvacuadaMl,
      duracionMin
    });

    const targetIsoMl = metrics.deficitMl > 0 ? Math.round(metrics.deficitMl * (appState.draft.isoFactor || 1.5)) : 1000;
    const iso = computeIsotonicRecipe(targetIsoMl);

    const sessionRecord = {
      sessionId: appState.draft.sessionId || createSessionId(appState.athleteId),
      athleteId: appState.athleteId,
      athleteName: appState.athleteProfile?.nombre || "",
      deporte: appState.athleteProfile?.deporte || "",
      createdAt: new Date().toISOString(),
      capacidadTermoMl: Number(appState.athleteProfile?.capacidadTermoMl) || DEFAULT_THERMO_ML,
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
    appState.draft.lastResult = sessionRecord;
    saveDraft(appState.athleteId, appState.draft);

    renderPhase3Results();
    const dbMode = HydroTagDB.getMode();
    $("res-save-status").textContent =
      dbMode.mode === "firebase"
        ? `Evaluación guardada en Firebase Firestore (${sessionRecord.athleteId}).`
        : `Evaluación guardada en LocalStorage Offline (${sessionRecord.athleteId}).`;

    showToast("Evaluación calculada y guardada", "success");
    $("phase3-results").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("btn-new-session").addEventListener("click", () => {
    appState.draft = createDefaultDraft(appState.athleteId);
    saveDraft(appState.athleteId, appState.draft);
    initAthleteView(appState.athleteId);
    showToast("Nueva sesión iniciada", "info");
  });

  // Panel Admin eventos
  $("admin-filter-athlete").addEventListener("change", renderAdminDashboard);
  $("admin-filter-search").addEventListener("input", renderAdminDashboard);
  $("admin-filter-red-only").addEventListener("change", renderAdminDashboard);
  $("btn-admin-export-csv").addEventListener("click", exportSessionsToCsv);
  $("btn-admin-back").addEventListener("click", () => navigateToParams({}));

  $("btn-admin-seed").addEventListener("click", async () => {
    const count = await HydroTagDB.seedDemoSessions();
    showToast(`${count} evaluaciones clínicas demo cargadas`, "success");
  });

  window.addEventListener("popstate", resolveRoute);
}

function registerServiceWorkerSafely() {
  if (!("serviceWorker" in navigator)) return;
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol !== "https:" && !isLocal) return;

  navigator.serviceWorker.register("./sw.js").catch(() => {
    // Silencioso si el navegador bloquea registro local
  });
}

async function bootstrap() {
  const dbInfo = await HydroTagDB.init();
  updateDbStatusUI(dbInfo);
  bindEvents();
  registerServiceWorkerSafely();
  await resolveRoute();
}

bootstrap();
