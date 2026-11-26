// ============================================================================
// HYDROTAG — CONFIGURACIÓN DE FIREBASE FIRESTORE + RESPALDO OFFLINE AUTOMÁTICO
// ============================================================================
// INSTRUCCIONES:
// 1. Crea un proyecto en https://console.firebase.google.com y habilita Cloud Firestore.
// 2. Registra una Web App y pega abajo tus credenciales reales.
// 3. Mientras no pegues tus llaves (o si estás sin conexión), HydroTag funcionará
//    automáticamente en Modo Offline / LocalStorage sin errores.
// ============================================================================

export const firebaseConfig = {
  apiKey: "PEGA_AQUI_TU_API_KEY",
  authDomain: "PEGA_AQUI_TU_PROYECTO.firebaseapp.com",
  projectId: "PEGA_AQUI_TU_PROJECT_ID",
  storageBucket: "PEGA_AQUI_TU_PROYECTO.firebasestorage.app",
  messagingSenderId: "PEGA_AQUI_TU_SENDER_ID",
  appId: "PEGA_AQUI_TU_APP_ID"
};

const COLLECTIONS = {
  athletes: "hydrotag_athletes",
  sessions: "hydrotag_sessions"
};

const STORAGE_KEYS = {
  athletes: "hydrotag_athletes_v1",
  sessions: "hydrotag_sessions_v1"
};

const CHANNEL_NAME = "hydrotag_sync_channel";

function isFirebaseConfigured(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  const required = ["apiKey", "projectId", "appId"];
  return required.every((field) => {
    const val = String(cfg[field] ?? "").trim();
    if (!val) return false;
    const upper = val.toUpperCase();
    return (
      !upper.includes("PEGA_AQUI") &&
      !upper.includes("TU_") &&
      !upper.includes("YOUR_") &&
      !upper.includes("REPLACE_")
    );
  });
}

function readLocalMap(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalMap(key, map) {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Silencioso si el navegador restringe almacenamiento
  }
}

function readLocalArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalArray(key, arr) {
  try {
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    // Silencioso si el navegador restringe almacenamiento
  }
}

function sortSessionsDesc(sessions) {
  return [...sessions].sort((a, b) => {
    const dateA = new Date(a.createdAt || a.fechaISO || 0).getTime();
    const dateB = new Date(b.createdAt || b.fechaISO || 0).getTime();
    return dateB - dateA;
  });
}

let state = {
  initialized: false,
  mode: "local", // "firebase" | "local"
  projectId: null,
  db: null,
  fs: null,
  channel: typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null
};

const localListeners = new Set();
const localAthleteListeners = new Set();

function sortAthletesDesc(athletesMap) {
  return Object.values(athletesMap || {}).sort((a, b) => {
    const ta = new Date(a.updatedAt || 0).getTime();
    const tb = new Date(b.updatedAt || 0).getTime();
    return tb - ta;
  });
}

function notifyLocalSubscribers() {
  const sessions = sortSessionsDesc(readLocalArray(STORAGE_KEYS.sessions));
  localListeners.forEach((cb) => {
    try {
      cb(sessions);
    } catch {
      // Ignorar errores de suscriptores individuales
    }
  });

  const athletes = sortAthletesDesc(readLocalMap(STORAGE_KEYS.athletes));
  localAthleteListeners.forEach((cb) => {
    try {
      cb(athletes);
    } catch {
      // Ignorar errores de suscriptores individuales
    }
  });
}

function broadcastChange(type) {
  notifyLocalSubscribers();
  if (state.channel) {
    try {
      state.channel.postMessage({ type, ts: Date.now() });
    } catch {
      // Ignorar si el canal está cerrado
    }
  }
}

if (state.channel) {
  state.channel.addEventListener("message", () => {
    notifyLocalSubscribers();
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.sessions || event.key === STORAGE_KEYS.athletes) {
      notifyLocalSubscribers();
    }
  });
}

export const HydroTagDB = {
  async init() {
    if (state.initialized) {
      return { mode: state.mode, projectId: state.projectId };
    }

    if (isFirebaseConfigured(firebaseConfig)) {
      try {
        const [{ initializeApp, getApps }, firestoreMod] = await Promise.all([
          import("https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js"),
          import("https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js")
        ]);

        const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
        const db = firestoreMod.getFirestore(app);

        state.db = db;
        state.fs = firestoreMod;
        state.mode = "firebase";
        state.projectId = firebaseConfig.projectId;
        state.initialized = true;

        return { mode: state.mode, projectId: state.projectId };
      } catch {
        // Respaldo automático a modo local si no hay red o falla SDK
        state.mode = "local";
        state.projectId = null;
        state.initialized = true;
        return { mode: state.mode, projectId: null };
      }
    }

    state.mode = "local";
    state.projectId = null;
    state.initialized = true;
    return { mode: state.mode, projectId: null };
  },

  getMode() {
    return { mode: state.mode, projectId: state.projectId };
  },

  async getAthlete(athleteId) {
    await this.init();
    const id = String(athleteId || "").trim();
    if (!id) return null;

    const localAthletes = readLocalMap(STORAGE_KEYS.athletes);
    const localMatch = localAthletes[id] || null;

    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const ref = state.fs.doc(state.db, COLLECTIONS.athletes, id);
        const snap = await state.fs.getDoc(ref);
        if (snap.exists()) {
          const data = { id, ...snap.data() };
          localAthletes[id] = data;
          writeLocalMap(STORAGE_KEYS.athletes, localAthletes);
          return data;
        }
      } catch {
        // Fallback silencioso a caché local
      }
    }

    return localMatch;
  },

  async saveAthlete(profile) {
    await this.init();
    const id = String(profile?.id || "").trim();
    if (!id) throw new Error("ID de atleta requerido");

    const localAthletes = readLocalMap(STORAGE_KEYS.athletes);
    const prev = localAthletes[id] || {};

    const hasAutoScan = profile.autoScanFraction !== undefined && profile.autoScanFraction !== null;
    const autoScanVal = hasAutoScan
      ? Number(profile.autoScanFraction)
      : prev.autoScanFraction !== undefined
        ? Number(prev.autoScanFraction)
        : 1;

    const record = {
      id,
      nombre: profile.nombre !== undefined ? String(profile.nombre || "").trim() : String(prev.nombre || "").trim(),
      deporte: profile.deporte !== undefined ? String(profile.deporte || "").trim() : String(prev.deporte || "").trim(),
      capacidadTermoMl: Number(profile.capacidadTermoMl ?? prev.capacidadTermoMl) || 750,
      autoScanFraction: Number.isFinite(autoScanVal) ? autoScanVal : 1,
      consumoEnCursoMl: Number(profile.consumoEnCursoMl ?? prev.consumoEnCursoMl) || 0,
      tomasEnCurso: Number(profile.tomasEnCurso ?? prev.tomasEnCurso) || 0,
      ultimoEscaneoAt: profile.ultimoEscaneoAt !== undefined ? profile.ultimoEscaneoAt : (prev.ultimoEscaneoAt || null),
      updatedAt: new Date().toISOString()
    };

    localAthletes[id] = { ...prev, ...record };
    writeLocalMap(STORAGE_KEYS.athletes, localAthletes);

    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const ref = state.fs.doc(state.db, COLLECTIONS.athletes, id);
        await state.fs.setDoc(ref, localAthletes[id], { merge: true });
      } catch {
        // Mantiene guardado local si hay interrupción de red
      }
    }

    broadcastChange("athlete_saved");
    return localAthletes[id];
  },

  async listAthletes() {
    await this.init();
    const localAthletes = readLocalMap(STORAGE_KEYS.athletes);

    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const snap = await state.fs.getDocs(state.fs.collection(state.db, COLLECTIONS.athletes));
        snap.forEach((docSnap) => {
          localAthletes[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
        });
        writeLocalMap(STORAGE_KEYS.athletes, localAthletes);
      } catch {
        // Usar local
      }
    }

    return Object.values(localAthletes).sort((a, b) => {
      const ta = new Date(a.updatedAt || 0).getTime();
      const tb = new Date(b.updatedAt || 0).getTime();
      return tb - ta;
    });
  },

  async saveSession(sessionData) {
    await this.init();
    if (!sessionData || !sessionData.sessionId) {
      throw new Error("sessionId requerido para guardar evaluación");
    }

    const record = {
      ...sessionData,
      updatedAt: new Date().toISOString()
    };

    const current = readLocalArray(STORAGE_KEYS.sessions);
    const idx = current.findIndex((item) => item.sessionId === record.sessionId);
    if (idx >= 0) {
      current[idx] = record;
    } else {
      current.unshift(record);
    }
    writeLocalArray(STORAGE_KEYS.sessions, sortSessionsDesc(current));

    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const ref = state.fs.doc(state.db, COLLECTIONS.sessions, record.sessionId);
        await state.fs.setDoc(ref, record, { merge: true });
      } catch {
        // Respaldado localmente
      }
    }

    broadcastChange("session_saved");
    return record;
  },

  async deleteSession(sessionId) {
    await this.init();
    const current = readLocalArray(STORAGE_KEYS.sessions).filter(
      (item) => item.sessionId !== sessionId
    );
    writeLocalArray(STORAGE_KEYS.sessions, current);

    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const ref = state.fs.doc(state.db, COLLECTIONS.sessions, sessionId);
        await state.fs.deleteDoc(ref);
      } catch {
        // Ignorar error de red
      }
    }

    broadcastChange("session_deleted");
  },

  async listSessions() {
    await this.init();
    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const snap = await state.fs.getDocs(state.fs.collection(state.db, COLLECTIONS.sessions));
        const remote = [];
        snap.forEach((docSnap) => {
          remote.push({ sessionId: docSnap.id, ...docSnap.data() });
        });
        const sorted = sortSessionsDesc(remote);
        writeLocalArray(STORAGE_KEYS.sessions, sorted);
        return sorted;
      } catch {
        // Fallback local
      }
    }
    return sortSessionsDesc(readLocalArray(STORAGE_KEYS.sessions));
  },

  async subscribeSessions(callback) {
    await this.init();

    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const colRef = state.fs.collection(state.db, COLLECTIONS.sessions);
        const unsub = state.fs.onSnapshot(
          colRef,
          (snapshot) => {
            const list = [];
            snapshot.forEach((docSnap) => {
              list.push({ sessionId: docSnap.id, ...docSnap.data() });
            });
            const sorted = sortSessionsDesc(list);
            writeLocalArray(STORAGE_KEYS.sessions, sorted);
            callback(sorted);
          },
          () => {
            // Si Firestore falla permisos o red, servir caché local
            callback(sortSessionsDesc(readLocalArray(STORAGE_KEYS.sessions)));
          }
        );
        return unsub;
      } catch {
        // Caer a modo local
      }
    }

    localListeners.add(callback);
    callback(sortSessionsDesc(readLocalArray(STORAGE_KEYS.sessions)));

    return () => {
      localListeners.delete(callback);
    };
  },

  async subscribeAthletes(callback) {
    await this.init();

    if (state.mode === "firebase" && state.db && state.fs) {
      try {
        const colRef = state.fs.collection(state.db, COLLECTIONS.athletes);
        const unsub = state.fs.onSnapshot(
          colRef,
          (snapshot) => {
            const map = {};
            snapshot.forEach((docSnap) => {
              map[docSnap.id] = { id: docSnap.id, ...docSnap.data() };
            });
            writeLocalMap(STORAGE_KEYS.athletes, map);
            callback(sortAthletesDesc(map));
          },
          () => {
            callback(sortAthletesDesc(readLocalMap(STORAGE_KEYS.athletes)));
          }
        );
        return unsub;
      } catch {
        // Caer a modo local
      }
    }

    localAthleteListeners.add(callback);
    callback(sortAthletesDesc(readLocalMap(STORAGE_KEYS.athletes)));

    return () => {
      localAthleteListeners.delete(callback);
    };
  },

  async seedDemoSessions() {
    const now = Date.now();
    const demoAthletes = [
      { id: "ATLETA_01", nombre: "Carlos Méndez", deporte: "Fútbol", capacidadTermoMl: 750 },
      { id: "ATLETA_02", nombre: "Sofía Ramírez", deporte: "Atletismo 10K", capacidadTermoMl: 600 },
      { id: "ATLETA_03", nombre: "Mateo Silva", deporte: "Ciclismo Ruta", capacidadTermoMl: 1000 }
    ];

    for (const a of demoAthletes) {
      await this.saveAthlete(a);
    }

    const demoSessions = [
      {
        sessionId: "DEMO_SES_01",
        athleteId: "ATLETA_01",
        athleteName: "Carlos Méndez",
        deporte: "Fútbol",
        createdAt: new Date(now - 3600 * 1000 * 2).toISOString(),
        capacidadTermoMl: 750,
        pesoPreKg: 75.0,
        pesoPostKg: 73.2,
        orinaArmstrong: 5,
        nivelSed: "alta",
        alertaPreHidratacion: true,
        consumoMl: 750,
        orinaEvacuadaMl: 0,
        duracionMin: 60,
        tasaSudoracionLh: 2.55,
        deshidratacionPct: 2.4,
        metaMinMl: 2250,
        metaMaxMl: 2700,
        salMinG: 3.44,
        salMaxG: 4.81,
        carboG: 162.0
      },
      {
        sessionId: "DEMO_SES_02",
        athleteId: "ATLETA_02",
        athleteName: "Sofía Ramírez",
        deporte: "Atletismo 10K",
        createdAt: new Date(now - 3600 * 1000 * 5).toISOString(),
        capacidadTermoMl: 600,
        pesoPreKg: 58.0,
        pesoPostKg: 57.1,
        orinaArmstrong: 3,
        nivelSed: "moderada",
        alertaPreHidratacion: false,
        consumoMl: 450,
        orinaEvacuadaMl: 0,
        duracionMin: 50,
        tasaSudoracionLh: 1.62,
        deshidratacionPct: 1.55,
        metaMinMl: 1125,
        metaMaxMl: 1350,
        salMinG: 1.72,
        salMaxG: 2.4,
        carboG: 81.0
      },
      {
        sessionId: "DEMO_SES_03",
        athleteId: "ATLETA_03",
        athleteName: "Mateo Silva",
        deporte: "Ciclismo Ruta",
        createdAt: new Date(now - 3600 * 1000 * 24).toISOString(),
        capacidadTermoMl: 1000,
        pesoPreKg: 70.0,
        pesoPostKg: 69.5,
        orinaArmstrong: 2,
        nivelSed: "baja",
        alertaPreHidratacion: false,
        consumoMl: 1500,
        orinaEvacuadaMl: 150,
        duracionMin: 90,
        tasaSudoracionLh: 1.23,
        deshidratacionPct: 0.71,
        metaMinMl: 625,
        metaMaxMl: 750,
        salMinG: 0.95,
        salMaxG: 1.34,
        carboG: 45.0
      }
    ];

    for (const s of demoSessions) {
      await this.saveSession(s);
    }

    return demoSessions.length;
  }
};

if (typeof window !== "undefined") {
  window.HydroTagDB = HydroTagDB;
}
