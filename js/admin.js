// Логика страницы администратора: серверная авторизация, обзор БД (Firestore + localStorage), статистика данных и смена паролей

import {
  firebaseConfig,
  appId,
  LOCAL_ACCOUNTS_KEY,
  FIREBASE_COLLECTION_PATH,
  LEGACY_FIREBASE_COLLECTION_PATH,
  FIREBASE_ADMIN_CONFIG_PATH
} from './config.js';
import { mergeStateWithDefaults, mergeAccountStates } from './state.js';
import {
  escapeHtml,
  formatDateRu,
  formatDateTimeRu,
  hashPassword,
  sanitizeForFirestore,
  openModal,
  closeModal,
  showToast
} from './utils.js';
import { registerAppServiceWorker, showSystemNotification } from './pwa.js';

// Сессионный Bearer-токен администратора хранится строго в памяти JS (не в localStorage/sessionStorage)
let adminToken = null;
let adminAuthSource = 'unclaimed';
let adminAuthMode = 'server'; // 'server' (Node /api/admin) | 'firebase' (GitHub Pages + Firestore)
const FIREBASE_ADMIN_AUTH_DOC_ID = 'auth';
const ADMIN_PBKDF2_ITERATIONS = 150000;
const firebaseAuthRateLimit = { failures: 0, lockedUntil: 0 };

function computeRelativeAdminApiPrefix() {
  try {
    const pathname = window.location.pathname || '/';
    // Убираем /admin.html или /admin(/) в конце пути, сохраняя возможный подкаталог (например /children)
    const dir = pathname
      .replace(/\/admin\.html$/i, '')
      .replace(/\/admin\/?$/i, '')
      .replace(/\/+$/, '');
    return `${dir}/api/admin`;
  } catch (_) {
    return '/api/admin';
  }
}

let resolvedAdminApiPrefix = computeRelativeAdminApiPrefix();

function adminApiUrl(endpoint, prefix = resolvedAdminApiPrefix) {
  const cleanEndpoint = String(endpoint || '').replace(/^\/+/, '');
  const cleanPrefix = String(prefix || '/api/admin').replace(/\/+$/, '');
  return `${cleanPrefix}/${cleanEndpoint}`;
}

function adminFetch(endpoint, options = {}, prefix = resolvedAdminApiPrefix) {
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };
  return fetch(adminApiUrl(endpoint, prefix), {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers
  });
}

const FIREBASE_CDN_BASE = 'https://www.gstatic.com/firebasejs/11.6.1';

// Состояние Firebase для админ-панели
let fbAppSdk = null;
let fbAuthSdk = null;
let fbFirestoreSdk = null;
let fbSdkPromise = null;
let fbApp = null;
let fbAuth = null;
let fbDb = null;
let fbUser = null;
let cloudConnected = false;
let cloudErrorText = '';

// Объединённый список пользователей из облачной и локальной БД
let allUsers = [];
let activeDbFilter = 'all';
let selectedDetailsLogin = null;

function initTheme() {
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', prefersDark);
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark');
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(2)} МБ`;
}

function toTimestampMs(val) {
  if (!val) return null;
  if (typeof val === 'number' && Number.isFinite(val) && val > 946684800000) {
    return val;
  }
  if (typeof val === 'object' && typeof val.toMillis === 'function') {
    return val.toMillis();
  }
  if (typeof val === 'object' && typeof val.seconds === 'number') {
    return val.seconds * 1000;
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed) && parsed > 946684800000) return parsed;
  }
  return null;
}

function getDocUpdatedTs(docItem) {
  if (!docItem) return 0;
  return Math.max(
    toTimestampMs(docItem.updatedAt) || 0,
    toTimestampMs(docItem.serverUpdateTime) || 0,
    toTimestampMs(docItem.createdAt) || 0,
    toTimestampMs(docItem.serverCreateTime) || 0
  );
}

function resolveCreationDate(cloudDocs, localDoc) {
  const allDocs = [...(Array.isArray(cloudDocs) ? cloudDocs : []), ...(localDoc ? [localDoc] : [])];
  const serverCreatedTimes = (Array.isArray(cloudDocs) ? cloudDocs : [])
    .map(d => toTimestampMs(d?.serverCreateTime))
    .filter(Boolean);

  const explicitCreatedCandidates = [];
  for (const d of allDocs) {
    const c1 = toTimestampMs(d?.createdAt);
    const c2 = toTimestampMs(d?.state?.accountCreatedAt);
    if (c1) explicitCreatedCandidates.push(c1);
    if (c2) explicitCreatedCandidates.push(c2);
  }

  const allExact = [...serverCreatedTimes, ...explicitCreatedCandidates];
  if (allExact.length > 0) {
    const earliest = Math.min(...allExact);
    const fromFirestore = serverCreatedTimes.includes(earliest);
    return {
      ts: earliest,
      exact: true,
      basis: fromFirestore ? 'создан в Firestore' : 'точная дата'
    };
  }

  // Для локальных аккаунтов без метаданных оцениваем по самой ранней записи
  const activityTs = [];
  for (const docItem of allDocs) {
    if (!docItem) continue;
    const normState = mergeStateWithDefaults(docItem.state || {});
    for (const l of normState.journalLogs || []) {
      const t = toTimestampMs(l?.startTime) || toTimestampMs(l?.endTime);
      if (t) activityTs.push(t);
    }
    for (const d of normState.diaryEntries || []) {
      const t = toTimestampMs(d?.createdAt) || toTimestampMs(d?.date);
      if (t) activityTs.push(t);
    }
    for (const g of normState.growthRecords || []) {
      const t = toTimestampMs(g?.date);
      if (t) activityTs.push(t);
    }
    for (const h of normState.notifications?.history || []) {
      const t = toTimestampMs(h?.ts);
      if (t) activityTs.push(t);
    }
  }

  if (activityTs.length > 0) {
    return { ts: Math.min(...activityTs), exact: false, basis: 'по первой записи' };
  }

  const updatedCandidates = allDocs
    .flatMap(d => [toTimestampMs(d?.serverUpdateTime), toTimestampMs(d?.updatedAt)])
    .filter(Boolean);

  if (updatedCandidates.length > 0) {
    return { ts: Math.min(...updatedCandidates), exact: false, basis: 'по обновлению' };
  }

  return { ts: null, exact: false, basis: 'нет данных' };
}

function buildCombinedUserState(cloudDocs, localDoc) {
  const candidates = [
    ...(Array.isArray(cloudDocs) ? cloudDocs : []),
    ...(localDoc ? [localDoc] : [])
  ].filter(Boolean);

  // Сортируем от старых к новым, чтобы свежие значения побеждали при конфликте ключей,
  // а записи из ранней коллекции accounts не терялись
  const ordered = [...candidates].sort((a, b) => getDocUpdatedTs(a) - getDocUpdatedTs(b));
  const rawStates = ordered.map(d => d.state).filter(s => s && typeof s === 'object');
  const { state: mergedState, hasExplicitName, hasExplicitDob } = mergeAccountStates(rawStates);

  return {
    mergedState,
    hasExplicitName,
    hasExplicitDob
  };
}

function computeUserStats(mergedState, docsForSize) {
  const state = mergedState || {};
  const journalCount = Array.isArray(state.journalLogs) ? state.journalLogs.length : 0;
  const diaryCount = Array.isArray(state.diaryEntries) ? state.diaryEntries.length : 0;
  const growthCount = Array.isArray(state.growthRecords) ? state.growthRecords.length : 0;

  const milestonesCount = state.completedMilestones && typeof state.completedMilestones === 'object'
    ? Object.values(state.completedMilestones).filter(Boolean).length
    : 0;

  const teethCount = state.teethMap && typeof state.teethMap === 'object'
    ? Object.values(state.teethMap).filter(t => t && (t.erupted || t.date)).length
    : 0;

  const vaccinesCount = state.vaccinesMap && typeof state.vaccinesMap === 'object'
    ? Object.values(state.vaccinesMap).filter(v => v && v.done).length
    : 0;

  const notifHistoryCount = Array.isArray(state.notifications?.history)
    ? state.notifications.history.length
    : 0;

  const totalRecords = journalCount + diaryCount + growthCount + milestonesCount + teethCount + vaccinesCount;

  let sizeBytes = 0;
  try {
    const target = Array.isArray(docsForSize) && docsForSize.length > 0 ? docsForSize : [state];
    sizeBytes = new TextEncoder().encode(JSON.stringify(target)).length;
  } catch (_) {
    sizeBytes = 0;
  }

  return {
    journalCount,
    diaryCount,
    growthCount,
    milestonesCount,
    teethCount,
    vaccinesCount,
    notifHistoryCount,
    totalRecords,
    sizeBytes
  };
}

function detectPassHashType(cloudDocs, localDoc) {
  const candidates = [...(Array.isArray(cloudDocs) ? cloudDocs : [])];
  // Приоритет текущей коллекции malysh_accounts, затем accounts
  candidates.sort((a, b) => {
    if (a?.collection === 'malysh_accounts' && b?.collection !== 'malysh_accounts') return -1;
    if (b?.collection === 'malysh_accounts' && a?.collection !== 'malysh_accounts') return 1;
    return 0;
  });

  for (const cd of candidates) {
    const kind = cd?.passHashKind;
    if (kind === 'sha256') return { code: 'sha256', label: 'SHA-256' };
    if (kind === 'fnv') return { code: 'fnv', label: 'Legacy FNV' };
    if (kind === 'custom') return { code: 'custom', label: 'Хэш' };
    const rawHash = cd?.passHash || cd?.passwordHash || '';
    if (rawHash && typeof rawHash === 'string') {
      if (rawHash.startsWith('fnv_')) return { code: 'fnv', label: 'Legacy FNV' };
      if (/^[a-f0-9]{64}$/i.test(rawHash)) return { code: 'sha256', label: 'SHA-256' };
      return { code: 'custom', label: 'Хэш' };
    }
    if (cd?.hasPassword) return { code: 'sha256', label: 'SHA-256' };
  }

  const localHash = localDoc?.passHash || localDoc?.passwordHash || '';
  if (localHash && typeof localHash === 'string') {
    if (localHash.startsWith('fnv_')) return { code: 'fnv', label: 'Legacy FNV' };
    if (/^[a-f0-9]{64}$/i.test(localHash)) return { code: 'sha256', label: 'SHA-256' };
    return { code: 'custom', label: 'Хэш' };
  }
  return { code: 'none', label: 'Не задан' };
}

function readLocalAccountsMap() {
  try {
    const raw = localStorage.getItem(LOCAL_ACCOUNTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function updateLocalAccountPassword(login, passHash, changedAt, fallbackDoc) {
  try {
    const all = readLocalAccountsMap();
    const existing = all[login];
    if (!existing && !fallbackDoc) return false;
    const base = existing || {
      login,
      state: fallbackDoc?.state || {},
      createdAt: fallbackDoc?.createdAt || Date.now()
    };
    all[login] = {
      ...base,
      login,
      passHash,
      passwordChangedAt: changedAt,
      updatedAt: changedAt
    };
    localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(all));
    return true;
  } catch (_) {
    return false;
  }
}

async function loadAdminFirebaseSdk() {
  if (fbAppSdk && fbAuthSdk && fbFirestoreSdk) {
    return { appSdk: fbAppSdk, authSdk: fbAuthSdk, firestoreSdk: fbFirestoreSdk };
  }
  if (!fbSdkPromise) {
    fbSdkPromise = Promise.all([
      import(/* @vite-ignore */ `${FIREBASE_CDN_BASE}/firebase-app.js`),
      import(/* @vite-ignore */ `${FIREBASE_CDN_BASE}/firebase-auth.js`),
      import(/* @vite-ignore */ `${FIREBASE_CDN_BASE}/firebase-firestore.js`)
    ])
      .then(([appMod, authMod, fsMod]) => {
        fbAppSdk = appMod;
        fbAuthSdk = authMod;
        fbFirestoreSdk = fsMod;
        return { appSdk: fbAppSdk, authSdk: fbAuthSdk, firestoreSdk: fbFirestoreSdk };
      })
      .catch((err) => {
        fbSdkPromise = null;
        throw err;
      });
  }
  return fbSdkPromise;
}

async function ensureAdminFirebase() {
  if (fbDb && fbFirestoreSdk && fbUser) {
    cloudConnected = true;
    return true;
  }
  try {
    const { appSdk, authSdk, firestoreSdk } = await loadAdminFirebaseSdk();
    if (!fbApp) {
      const existingApps = appSdk.getApps();
      fbApp = existingApps.length > 0 ? existingApps[0] : appSdk.initializeApp(firebaseConfig);
    }
    if (!fbAuth) fbAuth = authSdk.getAuth(fbApp);
    if (!fbDb) fbDb = firestoreSdk.getFirestore(fbApp);

    if (typeof fbAuth.authStateReady === 'function') {
      try {
        await fbAuth.authStateReady();
      } catch (_) {}
    }

    if (fbAuth.currentUser) {
      fbUser = fbAuth.currentUser;
    } else {
      const cred = await authSdk.signInAnonymously(fbAuth);
      fbUser = cred?.user || fbAuth.currentUser;
    }

    cloudConnected = Boolean(fbDb && fbFirestoreSdk && fbUser);
    cloudErrorText = cloudConnected ? '' : 'Не удалось выполнить авторизацию в Firebase.';
    return cloudConnected;
  } catch (err) {
    cloudConnected = false;
    cloudErrorText = err?.message || 'Нет подключения к облачной базе Firestore.';
    return false;
  }
}

async function fetchCloudAccountsFromServer() {
  if (!adminToken) return null;
  const resp = await adminFetch('cloud/users', {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  if (resp.status === 401) {
    lockAdminPanel('Сессия администратора истекла. Войдите снова.');
    return { unauthorized: true };
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !Array.isArray(data.users)) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return { unauthorized: false, users: data.users };
}

async function fetchAllDatabases() {
  const statusLine = document.getElementById('admin-db-status-line');
  const warningBox = document.getElementById('admin-cloud-warning');
  if (statusLine) statusLine.textContent = 'Загрузка пользователей из Firestore (children-b0573) и локальной БД...';

  const localMap = readLocalAccountsMap();
  const cloudDocsMap = {};
  let loadedViaServer = false;

  const pushCloudDoc = (item, fallbackCollection) => {
    const key = String(item.login || item.docId || '').trim();
    if (!key) return;
    const colName = item.collection || fallbackCollection || 'malysh_accounts';
    if (!cloudDocsMap[key]) cloudDocsMap[key] = [];
    const normalizedItem = { ...item, login: key, collection: colName };
    const existingIdx = cloudDocsMap[key].findIndex(d => d.collection === colName);
    if (existingIdx >= 0) {
      cloudDocsMap[key][existingIdx] = normalizedItem;
    } else {
      cloudDocsMap[key].push(normalizedItem);
    }
  };

  // 1. В серверном режиме сначала загружаем через серверный мост Firestore REST (читает и malysh_accounts, и раннюю accounts)
  if (adminAuthMode === 'server') {
    try {
      const serverResult = await fetchCloudAccountsFromServer();
      if (serverResult?.unauthorized) return;
      if (serverResult && Array.isArray(serverResult.users)) {
        for (const item of serverResult.users) {
          pushCloudDoc(item, item.collection || 'malysh_accounts');
        }
        cloudConnected = true;
        cloudErrorText = '';
        loadedViaServer = true;
      }
    } catch (serverErr) {
      cloudErrorText = serverErr?.message || 'Ошибка серверного запроса Firestore.';
    }
  }

  // 2. Прямое подключение через официальный Firebase Web SDK (основной режим на GitHub Pages и резервный при сбое REST-моста)
  if (!loadedViaServer) {
    const ok = await ensureAdminFirebase();
    if (ok && fbDb && fbFirestoreSdk) {
      try {
        const [primaryRes, legacyRes] = await Promise.allSettled([
          fbFirestoreSdk.getDocs(fbFirestoreSdk.collection(fbDb, ...FIREBASE_COLLECTION_PATH)),
          fbFirestoreSdk.getDocs(fbFirestoreSdk.collection(fbDb, ...LEGACY_FIREBASE_COLLECTION_PATH))
        ]);
        if (primaryRes.status === 'fulfilled') {
          primaryRes.value.forEach((docSnap) => {
            const data = docSnap.data() || {};
            pushCloudDoc({ ...data, docId: docSnap.id }, 'malysh_accounts');
          });
        }
        if (legacyRes.status === 'fulfilled') {
          legacyRes.value.forEach((docSnap) => {
            const data = docSnap.data() || {};
            pushCloudDoc({ ...data, docId: docSnap.id }, 'accounts');
          });
        }
        if (primaryRes.status === 'rejected' && legacyRes.status === 'rejected') {
          throw primaryRes.reason || legacyRes.reason;
        }
        cloudConnected = true;
        cloudErrorText = '';
      } catch (err) {
        cloudConnected = false;
        cloudErrorText = err?.message || cloudErrorText || 'Ошибка чтения коллекций Firestore.';
      }
    } else {
      cloudConnected = false;
    }
  }

  const allLogins = new Set([...Object.keys(cloudDocsMap), ...Object.keys(localMap)]);
  const merged = [];

  for (const login of allLogins) {
    const cloudDocs = cloudDocsMap[login] || [];
    const localDoc = localMap[login] || null;
    const cloudCollections = cloudDocs.map(d => d.collection).filter(Boolean);

    const sortedCloud = [...cloudDocs].sort((a, b) => getDocUpdatedTs(b) - getDocUpdatedTs(a));
    const cloudDoc = sortedCloud[0] || null;

    const cloudUpd = cloudDocs.reduce((mx, d) => Math.max(mx, getDocUpdatedTs(d)), 0);
    const localUpd = getDocUpdatedTs(localDoc);
    const primaryDoc = (cloudDoc && (!localDoc || cloudUpd >= localUpd)) ? cloudDoc : (localDoc || cloudDoc);

    const creation = resolveCreationDate(cloudDocs, localDoc);
    const updatedAt = Math.max(cloudUpd, localUpd) || null;
    const passwordChangedAt = Math.max(
      ...cloudDocs.map(d => toTimestampMs(d?.passwordChangedAt) || 0),
      toTimestampMs(localDoc?.passwordChangedAt) || 0
    ) || null;

    const { mergedState, hasExplicitName, hasExplicitDob } = buildCombinedUserState(cloudDocs, localDoc);
    const docsForSize = [...cloudDocs, ...(localDoc ? [localDoc] : [])];
    const stats = computeUserStats(mergedState, docsForSize);

    merged.push({
      login,
      babyName: hasExplicitName ? String(mergedState.babyName || 'Без имени') : 'Без имени',
      babyDob: hasExplicitDob ? String(mergedState.babyDob || '') : '',
      babyGender: mergedState.babyGender === 'boy' ? 'boy' : 'girl',
      hasCloud: cloudDocs.length > 0,
      hasLocal: Boolean(localDoc),
      cloudCollections,
      cloudDocs,
      cloudDoc,
      localDoc,
      primaryDoc,
      mergedState,
      createdAt: creation.ts,
      createdExact: creation.exact,
      createdBasis: creation.basis,
      updatedAt,
      passwordChangedAt,
      passHashType: detectPassHashType(cloudDocs, localDoc),
      stats
    });
  }

  allUsers = merged;

  if (statusLine) {
    statusLine.textContent = cloudConnected
      ? `Firestore (${appId}: malysh_accounts + accounts): подключено • Локальная БД: активна`
      : `Firestore: недоступен • Показана локальная БД`;
  }

  if (warningBox) {
    if (!cloudConnected && cloudErrorText) {
      warningBox.textContent = `Облачная база Firestore сейчас недоступна (${cloudErrorText}). Отображаются аккаунты из локальной БД браузера.`;
      warningBox.classList.remove('hidden');
    } else {
      warningBox.classList.add('hidden');
    }
  }

  renderDashboard();
}

function getFilteredAndSortedUsers() {
  const query = (document.getElementById('admin-search-input')?.value || '').trim().toLowerCase();
  const sortMode = document.getElementById('admin-sort-select')?.value || 'created_desc';

  let list = allUsers.filter((u) => {
    if (activeDbFilter === 'cloud' && !u.hasCloud) return false;
    if (activeDbFilter === 'malysh_accounts' && !u.cloudCollections.includes('malysh_accounts')) return false;
    if (activeDbFilter === 'accounts' && !u.cloudCollections.includes('accounts')) return false;
    if (activeDbFilter === 'local' && !u.hasLocal) return false;
    if (activeDbFilter === 'local_only' && (u.hasCloud || !u.hasLocal)) return false;

    if (query) {
      const hay = `@${u.login} ${u.babyName} ${u.babyDob} ${u.cloudCollections.join(' ')}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  list = [...list].sort((a, b) => {
    switch (sortMode) {
      case 'created_asc':
        return (a.createdAt || Number.MAX_SAFE_INTEGER) - (b.createdAt || Number.MAX_SAFE_INTEGER);
      case 'updated_desc':
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      case 'records_desc':
        return b.stats.totalRecords - a.stats.totalRecords;
      case 'size_desc':
        return b.stats.sizeBytes - a.stats.sizeBytes;
      case 'login_asc':
        return a.login.localeCompare(b.login, 'ru');
      case 'created_desc':
      default:
        return (b.createdAt || 0) - (a.createdAt || 0);
    }
  });

  return list;
}

function renderKpis() {
  const cloudCount = allUsers.filter(u => u.hasCloud).length;
  const malyshCount = allUsers.filter(u => u.cloudCollections.includes('malysh_accounts')).length;
  const legacyCount = allUsers.filter(u => u.cloudCollections.includes('accounts')).length;
  const localCount = allUsers.filter(u => u.hasLocal).length;
  const bothCount = allUsers.filter(u => u.hasCloud && u.hasLocal).length;
  const totalRecords = allUsers.reduce((acc, u) => acc + u.stats.totalRecords, 0);
  const totalBytes = allUsers.reduce((acc, u) => acc + u.stats.sizeBytes, 0);

  const elTotal = document.getElementById('kpi-total-users');
  const elSub = document.getElementById('kpi-users-sub');
  const elCloud = document.getElementById('kpi-cloud-users');
  const elCloudSub = document.getElementById('kpi-cloud-sub');
  const elCloudDot = document.getElementById('kpi-cloud-dot');
  const elLocal = document.getElementById('kpi-local-users');
  const elRecs = document.getElementById('kpi-total-records');
  const elSize = document.getElementById('kpi-total-size');

  if (elTotal) elTotal.textContent = String(allUsers.length);
  if (elSub) elSub.textContent = `Синхронизировано: ${bothCount}`;
  if (elCloud) elCloud.textContent = String(cloudCount);
  if (elCloudSub) elCloudSub.textContent = `malysh_accounts: ${malyshCount} • accounts: ${legacyCount}`;
  if (elCloudDot) {
    elCloudDot.className = cloudConnected
      ? 'w-2 h-2 rounded-full bg-emerald-500'
      : 'w-2 h-2 rounded-full bg-amber-500';
  }
  if (elLocal) elLocal.textContent = String(localCount);
  if (elRecs) elRecs.textContent = String(totalRecords);
  if (elSize) elSize.textContent = `${formatBytes(totalBytes)} всего`;
}

function renderSourceBadges(u) {
  const parts = [];
  const hasPrimary = u.cloudCollections.includes('malysh_accounts');
  const hasLegacy = u.cloudCollections.includes('accounts');
  if (hasPrimary) {
    parts.push('<span class="px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200/70 dark:border-emerald-800/60 text-[10px] font-bold">malysh_accounts</span>');
  }
  if (hasLegacy) {
    parts.push('<span class="px-2 py-0.5 rounded-full bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 border border-teal-200/70 dark:border-teal-800/60 text-[10px] font-bold">accounts</span>');
  }
  if (hasPrimary && hasLegacy) {
    parts.push('<span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 border border-amber-300/80 dark:border-amber-800/70 text-[10px] font-bold">Дубликат</span>');
  }
  if (u.hasLocal) {
    parts.push('<span class="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/60 text-[10px] font-bold">Локально</span>');
  }
  return parts.join(' ');
}

function renderHashBadge(passHashType) {
  if (passHashType.code === 'sha256') {
    return '<span class="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[10px] font-bold">SHA-256</span>';
  }
  if (passHashType.code === 'fnv') {
    return '<span class="px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 text-[10px] font-bold">Legacy FNV</span>';
  }
  return '<span class="px-2 py-0.5 rounded-full bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 text-[10px] font-bold">Нет пароля</span>';
}

function renderMergeBanner() {
  const banner = document.getElementById('admin-merge-banner');
  const summaryEl = document.getElementById('admin-merge-summary');
  const mergeDupsBtn = document.getElementById('admin-merge-dups-btn');
  if (!banner || !summaryEl) return;

  const dups = allUsers.filter(
    u => u.cloudCollections.includes('malysh_accounts') && u.cloudCollections.includes('accounts')
  );
  const legacyOnly = allUsers.filter(
    u => !u.cloudCollections.includes('malysh_accounts') && u.cloudCollections.includes('accounts')
  );

  if (!cloudConnected || (dups.length === 0 && legacyOnly.length === 0)) {
    banner.classList.add('hidden');
    return;
  }

  const parts = [];
  if (dups.length > 0) {
    parts.push(`Дубликаты в обеих коллекциях (${dups.length}): ${dups.map(u => `@${u.login}`).join(', ')}.`);
  }
  if (legacyOnly.length > 0) {
    parts.push(`Только в старой коллекции accounts (${legacyOnly.length}): ${legacyOnly.map(u => `@${u.login}`).join(', ')}.`);
  }
  parts.push('Объединение переносит и сливает все записи журнала, замеров, дневника, зубов и прививок в malysh_accounts без потери данных.');

  summaryEl.textContent = parts.join(' ');
  if (mergeDupsBtn) {
    mergeDupsBtn.classList.toggle('hidden', dups.length === 0);
  }
  banner.classList.remove('hidden');
}

function renderDashboard() {
  renderKpis();
  renderMergeBanner();

  const container = document.getElementById('admin-users-container');
  const countBadge = document.getElementById('admin-users-count-badge');
  if (!container) return;

  const list = getFilteredAndSortedUsers();
  if (countBadge) {
    countBadge.textContent = `${list.length} из ${allUsers.length}`;
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center space-y-1">
        <div class="font-display font-bold text-sm text-slate-700 dark:text-slate-200">Пользователи не найдены</div>
        <p class="text-xs text-slate-400">Измените фильтр базы данных или поисковый запрос.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = list.map((u) => {
    const createdText = u.createdAt
      ? `${u.createdExact ? '' : '~'}${formatDateTimeRu(u.createdAt)}`
      : 'Не указана';
    const updatedText = u.updatedAt ? formatDateTimeRu(u.updatedAt) : '—';
    const pwChangedHtml = u.passwordChangedAt
      ? `<div class="text-[10px] text-amber-600 dark:text-amber-400">Пароль изменён: ${escapeHtml(formatDateTimeRu(u.passwordChangedAt))}</div>`
      : '';
    const dobText = u.babyDob ? ` • ДР ${escapeHtml(formatDateRu(u.babyDob))}` : '';
    const genderLabel = u.babyGender === 'boy' ? 'Мальчик' : 'Девочка';

    return `
      <div class="p-4 sm:px-5 hover:bg-warmgray/40 dark:hover:bg-slate-800/40 transition">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <!-- Пользователь и профиль -->
          <div class="min-w-0 flex-1 space-y-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 break-all">@${escapeHtml(u.login)}</span>
              ${renderSourceBadges(u)}
              ${renderHashBadge(u.passHashType)}
            </div>
            <div class="text-xs text-slate-500 dark:text-slate-400">
              Ребёнок: <strong class="text-slate-700 dark:text-slate-200">${escapeHtml(u.babyName)}</strong> (${genderLabel}${dobText})
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400 pt-0.5">
              <span>Создан: <strong class="text-slate-700 dark:text-slate-200">${escapeHtml(createdText)}</strong> <span class="text-slate-400">(${escapeHtml(u.createdBasis)})</span></span>
              <span>Обновлён: <strong class="text-slate-700 dark:text-slate-200">${escapeHtml(updatedText)}</strong></span>
            </div>
            ${pwChangedHtml}
          </div>

          <!-- Количество данных и разбивка -->
          <div class="lg:w-72 shrink-0 space-y-1.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-bold text-slate-800 dark:text-slate-100">${u.stats.totalRecords} записей</span>
              <span class="font-mono text-[11px] font-semibold text-slate-500 dark:text-slate-400">${escapeHtml(formatBytes(u.stats.sizeBytes))}</span>
            </div>
            <div class="flex flex-wrap gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
              <span class="px-2 py-0.5 rounded-lg bg-warmgray dark:bg-slate-800">Журнал: ${u.stats.journalCount}</span>
              <span class="px-2 py-0.5 rounded-lg bg-warmgray dark:bg-slate-800">Дневник: ${u.stats.diaryCount}</span>
              <span class="px-2 py-0.5 rounded-lg bg-warmgray dark:bg-slate-800">Замеры: ${u.stats.growthCount}</span>
              <span class="px-2 py-0.5 rounded-lg bg-warmgray dark:bg-slate-800">Навыки: ${u.stats.milestonesCount}</span>
              <span class="px-2 py-0.5 rounded-lg bg-warmgray dark:bg-slate-800">Зубы: ${u.stats.teethCount}</span>
              <span class="px-2 py-0.5 rounded-lg bg-warmgray dark:bg-slate-800">Прививки: ${u.stats.vaccinesCount}</span>
            </div>
          </div>

          <!-- Действия -->
          <div class="flex flex-wrap items-center gap-2 shrink-0 pt-1 lg:pt-0">
            ${u.cloudCollections.includes('accounts')
              ? `<button type="button" data-action="merge-user" data-login="${escapeHtml(u.login)}" class="px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-2xs transition">
                   ${u.cloudCollections.includes('malysh_accounts') ? 'Объединить' : 'В malysh_accounts'}
                 </button>`
              : ''}
            <button type="button" data-action="change-password" data-login="${escapeHtml(u.login)}" class="px-3 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold shadow-2xs transition">
              Сменить пароль
            </button>
            <button type="button" data-action="inspect-user" data-login="${escapeHtml(u.login)}" class="px-3 py-2 rounded-xl bg-warmgray dark:bg-slate-800 hover:bg-stone-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold transition">
              Данные
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function generateSecurePassword(length = 10) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += charset[bytes[i] % charset.length];
  }
  return out;
}

function openChangePasswordModal(login) {
  const user = allUsers.find(u => u.login === login);
  if (!user) return;

  const loginLabel = document.getElementById('pw-modal-login');
  const babyLabel = document.getElementById('pw-modal-baby');
  const hiddenInput = document.getElementById('pw-modal-login-hidden');
  const targetsBox = document.getElementById('pw-modal-targets');
  const newInput = document.getElementById('pw-modal-new');
  const confirmInput = document.getElementById('pw-modal-confirm');
  const syncCheckbox = document.getElementById('pw-modal-sync-cloud');
  const errBox = document.getElementById('pw-modal-error');

  if (loginLabel) loginLabel.textContent = `@${user.login}`;
  if (babyLabel) babyLabel.textContent = user.babyName ? ` (${user.babyName})` : '';
  if (hiddenInput) hiddenInput.value = user.login;
  if (newInput) {
    newInput.value = '';
    newInput.type = 'password';
  }
  if (confirmInput) {
    confirmInput.value = '';
    confirmInput.type = 'password';
  }
  if (syncCheckbox) {
    syncCheckbox.checked = cloudConnected && user.hasCloud;
    syncCheckbox.disabled = !cloudConnected;
  }
  if (errBox) errBox.classList.add('hidden');
  if (targetsBox) {
    targetsBox.innerHTML = `<span class="text-slate-400 font-semibold">Базы аккаунта:</span> ${renderSourceBadges(user)}`;
  }

  openModal('modal-admin-password');
  setTimeout(() => newInput?.focus(), 50);
}

async function handleChangeUserPassword(e) {
  e.preventDefault();
  const errBox = document.getElementById('pw-modal-error');
  const submitBtn = document.getElementById('pw-modal-submit');
  if (errBox) errBox.classList.add('hidden');

  const login = document.getElementById('pw-modal-login-hidden')?.value || '';
  const newPassword = document.getElementById('pw-modal-new')?.value || '';
  const confirmPassword = document.getElementById('pw-modal-confirm')?.value || '';
  const syncToCloud = Boolean(document.getElementById('pw-modal-sync-cloud')?.checked);

  const showErr = (msg) => {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  };

  if (!login) {
    showErr('Не выбран пользователь.');
    return;
  }
  if (newPassword.length < 4) {
    showErr('Новый пароль должен содержать минимум 4 символа.');
    return;
  }
  if (newPassword !== confirmPassword) {
    showErr('Пароли не совпадают.');
    return;
  }
  if (!adminToken) {
    showErr('Сессия администратора истекла. Войдите снова.');
    lockAdminPanel();
    return;
  }

  const prevText = submitBtn?.textContent || 'Сохранить новый пароль';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохранение...';
  }

  try {
    const user = allUsers.find(u => u.login === login);
    const reqPayload = {
      login,
      newPassword,
      syncToCloud: syncToCloud && cloudConnected
    };
    if (syncToCloud && user && !user.hasCloud && user.localDoc) {
      reqPayload.fallbackState = sanitizeForFirestore(user.localDoc.state || {});
      reqPayload.fallbackCreatedAt = user.createdAt || Date.now();
    }

    let data = null;
    if (adminAuthMode === 'server') {
      // 1. Обновляем пароль на сервере и напрямую в Firestore через REST API
      const resp = await adminFetch('cloud/user-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify(reqPayload)
      });

      data = await resp.json().catch(() => ({}));
      if (resp.status === 401) {
        closeModal('modal-admin-password');
        lockAdminPanel('Сессия администратора истекла. Войдите снова.');
        return;
      }
      if (!resp.ok || !data.passHash) {
        showErr(data.error || 'Не удалось обновить пароль.');
        return;
      }
    } else {
      // Режим GitHub Pages (без Node-сервера): хэшируем пароль по формату входа и записываем напрямую в Firestore
      const passHash = await hashPassword(newPassword);
      data = {
        ok: true,
        login,
        passHash,
        changedAt: Date.now(),
        cloudUpdated: false,
        updatedCollections: []
      };
    }

    const updatedTargets = [];
    if (data.cloudUpdated) {
      const colsLabel = Array.isArray(data.updatedCollections) && data.updatedCollections.length > 0
        ? `Firestore: ${data.updatedCollections.join(', ')}`
        : 'Firestore';
      updatedTargets.push(colsLabel);
    } else if (syncToCloud && cloudConnected) {
      // Запись через клиентский Firebase SDK
      const sdkOk = await ensureAdminFirebase();
      if (sdkOk && fbDb && fbFirestoreSdk) {
        try {
          const sdkUpdatedCols = [];
          const hasPrimary = user?.cloudCollections?.includes('malysh_accounts');
          const hasLegacy = user?.cloudCollections?.includes('accounts');
          if (hasPrimary || (!hasLegacy && user?.localDoc)) {
            const accRef = fbFirestoreSdk.doc(fbDb, ...FIREBASE_COLLECTION_PATH, login);
            const payload = {
              login,
              passHash: data.passHash,
              passwordChangedAt: data.changedAt,
              updatedAt: data.changedAt
            };
            if (!hasPrimary && user?.localDoc) {
              payload.state = sanitizeForFirestore(user.mergedState || user.localDoc.state || {});
              payload.createdAt = user.createdAt || Date.now();
            }
            await fbFirestoreSdk.setDoc(accRef, payload, { merge: true });
            sdkUpdatedCols.push('malysh_accounts');
          }
          if (hasLegacy) {
            const legacyRef = fbFirestoreSdk.doc(fbDb, ...LEGACY_FIREBASE_COLLECTION_PATH, login);
            await fbFirestoreSdk.setDoc(legacyRef, {
              login,
              passHash: data.passHash,
              passwordHash: data.passHash,
              passwordChangedAt: data.changedAt,
              updatedAt: data.changedAt
            }, { merge: true });
            sdkUpdatedCols.push('accounts');
          }
          if (sdkUpdatedCols.length > 0) {
            updatedTargets.push(`Firestore: ${sdkUpdatedCols.join(', ')}`);
          }
        } catch (fsErr) {
          showErr(`Ошибка записи в Firestore: ${fsErr?.message || 'нет доступа'}`);
          return;
        }
      }
    }

    // 2. Обновляем пароль в локальной базе браузера (если аккаунт там присутствует или облако недоступно)
    if ((user && user.hasLocal) || updatedTargets.length === 0) {
      const localOk = updateLocalAccountPassword(login, data.passHash, data.changedAt, {
        ...user?.primaryDoc,
        state: user?.mergedState || user?.primaryDoc?.state || {}
      });
      if (localOk) updatedTargets.push('Локальная БД');
    }

    if (updatedTargets.length === 0) {
      showErr('Не удалось обновить пароль ни в одной из баз.');
      return;
    }

    closeModal('modal-admin-password');
    showToast(`Пароль для @${login} обновлён (${updatedTargets.join(' + ')})`);
    await fetchAllDatabases();
  } catch (err) {
    showErr(err?.message || 'Ошибка соединения при смене пароля.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevText;
    }
  }
}

function buildSanitizedExportDoc(user) {
  return {
    login: user.login,
    sources: {
      firestore: user.hasCloud,
      collections: user.cloudCollections,
      localStorage: user.hasLocal
    },
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
    createdExact: user.createdExact,
    updatedAt: user.updatedAt ? new Date(user.updatedAt).toISOString() : null,
    passwordChangedAt: user.passwordChangedAt ? new Date(user.passwordChangedAt).toISOString() : null,
    passwordHashType: user.passHashType.label,
    stats: user.stats,
    state: user.mergedState || user.primaryDoc?.state || {}
  };
}

function downloadJsonFile(filename, dataObj) {
  const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openUserDetailsModal(login) {
  const user = allUsers.find(u => u.login === login);
  if (!user) return;
  selectedDetailsLogin = login;

  const titleEl = document.getElementById('details-modal-title');
  const subtitleEl = document.getElementById('details-modal-subtitle');
  const metricsEl = document.getElementById('details-metrics-grid');
  const metaEl = document.getElementById('details-meta-box');
  const jsonEl = document.getElementById('details-json-preview');
  const syncBtn = document.getElementById('details-sync-cloud-btn');

  if (titleEl) titleEl.textContent = `@${user.login}`;
  if (subtitleEl) {
    const dob = user.babyDob ? ` • ДР ${formatDateRu(user.babyDob)}` : '';
    subtitleEl.textContent = `${user.babyName}${dob}`;
  }

  if (metricsEl) {
    const items = [
      { label: 'Журнал', value: user.stats.journalCount },
      { label: 'Дневник', value: user.stats.diaryCount },
      { label: 'Замеры ВОЗ', value: user.stats.growthCount },
      { label: 'Навыки', value: user.stats.milestonesCount },
      { label: 'Зубы', value: user.stats.teethCount },
      { label: 'Прививки', value: user.stats.vaccinesCount },
      { label: 'Уведомления', value: user.stats.notifHistoryCount },
      { label: 'Объём', value: formatBytes(user.stats.sizeBytes) }
    ];
    metricsEl.innerHTML = items.map(it => `
      <div class="p-2.5 rounded-2xl bg-warmgray/70 dark:bg-slate-800/80 border border-stone-200/60 dark:border-slate-700/80">
        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(it.label)}</div>
        <div class="mt-0.5 font-display font-extrabold text-sm text-slate-900 dark:text-slate-100">${escapeHtml(String(it.value))}</div>
      </div>
    `).join('');
  }

  if (metaEl) {
    const createdStr = user.createdAt
      ? `${user.createdExact ? '' : '~'}${formatDateTimeRu(user.createdAt)} (${user.createdBasis})`
      : 'Не указана';
    const updatedStr = user.updatedAt ? formatDateTimeRu(user.updatedAt) : '—';
    const pwStr = user.passwordChangedAt ? formatDateTimeRu(user.passwordChangedAt) : 'Не менялся через админку';

    metaEl.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-slate-500">Базы данных:</span>
        <span class="flex items-center gap-1">${renderSourceBadges(user)}</span>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-slate-500">Дата создания:</span>
        <strong class="text-slate-800 dark:text-slate-100">${escapeHtml(createdStr)}</strong>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-slate-500">Последнее обновление:</span>
        <strong class="text-slate-800 dark:text-slate-100">${escapeHtml(updatedStr)}</strong>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-slate-500">Смена пароля:</span>
        <strong class="text-slate-800 dark:text-slate-100">${escapeHtml(pwStr)}</strong>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-slate-500">Формат хэша пароля:</span>
        <span>${renderHashBadge(user.passHashType)}</span>
      </div>
    `;
  }

  if (syncBtn) {
    syncBtn.classList.toggle('hidden', !(user.hasLocal && !user.hasCloud && cloudConnected));
  }

  if (jsonEl) {
    // Используем textContent для полностью безопасного вывода JSON без XSS
    jsonEl.textContent = JSON.stringify(buildSanitizedExportDoc(user), null, 2);
  }

  openModal('modal-admin-user-details');
}

async function syncSelectedLocalUserToCloud() {
  const user = allUsers.find(u => u.login === selectedDetailsLogin);
  if (!user || !user.localDoc || !cloudConnected || !adminToken) return;
  if (/[/\\]/.test(user.login) || user.login === '.' || user.login === '..') {
    showToast('Некорректный логин для облачной записи');
    return;
  }

  try {
    if (adminAuthMode === 'server') {
      const resp = await adminFetch('cloud/sync-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          login: user.login,
          state: sanitizeForFirestore(user.localDoc.state || {}),
          passHash: user.localDoc.passHash || '',
          createdAt: user.createdAt || Date.now(),
          updatedAt: user.updatedAt || Date.now()
        })
      });
      if (resp.status === 401) {
        closeModal('modal-admin-user-details');
        lockAdminPanel('Сессия администратора истекла. Войдите снова.');
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Ошибка синхронизации');
      }
    } else {
      const sdkOk = await ensureAdminFirebase();
      if (!sdkOk || !fbDb || !fbFirestoreSdk) {
        throw new Error(cloudErrorText || 'Нет подключения к Firestore');
      }
      const accRef = fbFirestoreSdk.doc(fbDb, ...FIREBASE_COLLECTION_PATH, user.login);
      const payload = {
        login: user.login,
        state: sanitizeForFirestore(user.localDoc.state || {}),
        createdAt: user.createdAt || Date.now(),
        updatedAt: user.updatedAt || Date.now()
      };
      if (user.localDoc.passHash) payload.passHash = user.localDoc.passHash;
      await fbFirestoreSdk.setDoc(accRef, payload, { merge: true });
    }

    showToast(`Аккаунт @${user.login} синхронизирован в Firestore`);
    closeModal('modal-admin-user-details');
    await fetchAllDatabases();
  } catch (err) {
    showToast(`Ошибка синхронизации: ${err?.message || 'нет доступа'}`);
  }
}

async function runMergeAccountsViaFirebase(mode, singleLogin, deleteLegacyAfterMerge) {
  const sdkOk = await ensureAdminFirebase();
  if (!sdkOk || !fbDb || !fbFirestoreSdk) {
    throw new Error(cloudErrorText || 'Нет подключения к Firestore');
  }

  const [primarySnap, legacySnap] = await Promise.all([
    fbFirestoreSdk.getDocs(fbFirestoreSdk.collection(fbDb, ...FIREBASE_COLLECTION_PATH)),
    fbFirestoreSdk.getDocs(fbFirestoreSdk.collection(fbDb, ...LEGACY_FIREBASE_COLLECTION_PATH))
  ]);

  const primaryByLogin = new Map();
  primarySnap.forEach((docSnap) => {
    const d = { ...(docSnap.data() || {}), docId: docSnap.id };
    const key = String(d.login || d.docId || '').trim();
    if (key) primaryByLogin.set(key, d);
  });

  const legacyByLogin = new Map();
  legacySnap.forEach((docSnap) => {
    const d = { ...(docSnap.data() || {}), docId: docSnap.id };
    const key = String(d.login || d.docId || '').trim();
    if (key) legacyByLogin.set(key, d);
  });

  let targetLogins = [];
  if (singleLogin) {
    if (!legacyByLogin.has(singleLogin)) {
      throw new Error(`Аккаунт @${singleLogin} отсутствует в коллекции accounts.`);
    }
    targetLogins = [singleLogin];
  } else if (mode === 'all_legacy') {
    targetLogins = Array.from(legacyByLogin.keys());
  } else {
    targetLogins = Array.from(legacyByLogin.keys()).filter((k) => primaryByLogin.has(k));
  }

  const mergedLogins = [];
  let deletedLegacyCount = 0;
  const errors = [];

  for (const targetLogin of targetLogins) {
    try {
      const legacyDoc = legacyByLogin.get(targetLogin);
      const primaryDoc = primaryByLogin.get(targetLogin);
      if (!legacyDoc) continue;

      const orderedStates = [];
      if (legacyDoc.state && typeof legacyDoc.state === 'object') orderedStates.push(legacyDoc.state);
      if (primaryDoc?.state && typeof primaryDoc.state === 'object') orderedStates.push(primaryDoc.state);

      const { state: unifiedState } = mergeAccountStates(orderedStates);
      const primaryHash = (typeof primaryDoc?.passHash === 'string' && primaryDoc.passHash)
        ? primaryDoc.passHash
        : (typeof primaryDoc?.passwordHash === 'string' ? primaryDoc.passwordHash : '');
      const legacyHash = (typeof legacyDoc.passHash === 'string' && legacyDoc.passHash)
        ? legacyDoc.passHash
        : (typeof legacyDoc.passwordHash === 'string' ? legacyDoc.passwordHash : '');

      const pChanged = toTimestampMs(primaryDoc?.passwordChangedAt) || 0;
      const lChanged = toTimestampMs(legacyDoc.passwordChangedAt) || 0;
      const resolvedHash = (lChanged > pChanged && legacyHash) ? legacyHash : (primaryHash || legacyHash || '');

      const createdCandidates = [
        toTimestampMs(primaryDoc?.createdAt),
        toTimestampMs(legacyDoc.createdAt),
        toTimestampMs(legacyDoc.state?.accountCreatedAt),
        toTimestampMs(primaryDoc?.state?.accountCreatedAt)
      ].filter(Boolean);
      const resolvedCreatedAt = createdCandidates.length > 0 ? Math.min(...createdCandidates) : Date.now();
      const nowMs = Date.now();

      const payload = {
        login: targetLogin,
        state: sanitizeForFirestore(unifiedState),
        createdAt: resolvedCreatedAt,
        updatedAt: nowMs
      };
      if (resolvedHash) payload.passHash = resolvedHash;
      const maxPwChanged = Math.max(pChanged, lChanged);
      if (maxPwChanged > 0) payload.passwordChangedAt = maxPwChanged;

      const targetDocId = primaryDoc?.docId || targetLogin;
      const targetRef = fbFirestoreSdk.doc(fbDb, ...FIREBASE_COLLECTION_PATH, targetDocId);
      await fbFirestoreSdk.setDoc(targetRef, payload, { merge: true });
      mergedLogins.push(targetLogin);

      if (deleteLegacyAfterMerge && typeof fbFirestoreSdk.deleteDoc === 'function') {
        const legacyDocId = legacyDoc.docId || targetLogin;
        const legacyRef = fbFirestoreSdk.doc(fbDb, ...LEGACY_FIREBASE_COLLECTION_PATH, legacyDocId);
        await fbFirestoreSdk.deleteDoc(legacyRef);
        deletedLegacyCount += 1;
      }
    } catch (err) {
      errors.push({ login: targetLogin, error: err?.message || 'Ошибка объединения' });
    }
  }

  return {
    mergedCount: mergedLogins.length,
    deletedLegacyCount,
    errors
  };
}

async function runMergeAccounts(mode, singleLogin = '') {
  if (!adminToken) {
    lockAdminPanel('Сессия администратора истекла. Войдите снова.');
    return;
  }
  const deleteLegacyAfterMerge = Boolean(document.getElementById('admin-merge-delete-legacy')?.checked);
  const dupsBtn = document.getElementById('admin-merge-dups-btn');
  const allBtn = document.getElementById('admin-migrate-all-btn');
  if (dupsBtn) dupsBtn.disabled = true;
  if (allBtn) allBtn.disabled = true;

  try {
    let data;
    if (adminAuthMode === 'server') {
      const resp = await adminFetch('cloud/merge-duplicates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          mode,
          login: singleLogin || undefined,
          deleteLegacyAfterMerge
        })
      });
      if (resp.status === 401) {
        lockAdminPanel('Сессия администратора истекла. Войдите снова.');
        return;
      }
      data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Не удалось выполнить объединение');
      }
    } else {
      data = await runMergeAccountsViaFirebase(mode, singleLogin, deleteLegacyAfterMerge);
    }

    const delNote = data.deletedLegacyCount > 0 ? `, удалено копий из accounts: ${data.deletedLegacyCount}` : '';
    const errNote = Array.isArray(data.errors) && data.errors.length > 0 ? ` (ошибок: ${data.errors.length})` : '';
    showToast(`Объединено в malysh_accounts: ${data.mergedCount}${delNote}${errNote}`);
    await fetchAllDatabases();
  } catch (err) {
    showToast(`Ошибка объединения: ${err?.message || 'сбой запроса'}`);
  } finally {
    if (dupsBtn) dupsBtn.disabled = false;
    if (allBtn) allBtn.disabled = false;
  }
}

// ==================== АВТОРИЗАЦИЯ АДМИНИСТРАТОРА ====================

function showAdminAuthError(msg) {
  const box = document.getElementById('admin-auth-error');
  if (!box) return;
  if (!msg) {
    box.classList.add('hidden');
    return;
  }
  box.textContent = msg;
  box.classList.remove('hidden');
}

function unlockAdminPanel() {
  document.getElementById('admin-auth-gate')?.classList.add('hidden');
  document.getElementById('admin-dashboard')?.classList.remove('hidden');
  fetchAllDatabases();
}

function lockAdminPanel(message = '') {
  adminToken = null;
  document.getElementById('admin-dashboard')?.classList.add('hidden');
  document.getElementById('admin-auth-gate')?.classList.remove('hidden');
  const loginPass = document.getElementById('admin-login-pass');
  if (loginPass) loginPass.value = '';
  showAdminAuthError(message);
  checkAdminAuthStatus();
}

function setAdminRetryVisible(visible) {
  document.getElementById('admin-auth-retry-wrap')?.classList.toggle('hidden', !visible);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeAdminStatusOnce() {
  const candidates = [];
  const relativePrefix = computeRelativeAdminApiPrefix();
  candidates.push(relativePrefix);
  if (relativePrefix !== '/api/admin') {
    candidates.push('/api/admin');
  }

  let lastFailure = { kind: 'network', status: 0, message: 'Сервер авторизации недоступен' };

  for (const prefix of candidates) {
    try {
      const resp = await adminFetch('status', {}, prefix);
      const contentType = (resp.headers.get('content-type') || '').toLowerCase();

      if (resp.ok) {
        if (!contentType.includes('application/json')) {
          lastFailure = { kind: 'non_json', status: resp.status };
          continue;
        }
        const data = await resp.json().catch(() => null);
        if (!data || typeof data.source !== 'string') {
          lastFailure = { kind: 'non_json', status: resp.status };
          continue;
        }
        resolvedAdminApiPrefix = prefix;
        return { ok: true, data };
      }

      if (resp.status === 404) {
        lastFailure = { kind: 'not_found', status: 404 };
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        lastFailure = { kind: 'proxy_auth', status: resp.status };
        return { ok: false, failure: lastFailure, retryable: false };
      }

      if (resp.status === 502 || resp.status === 503 || resp.status === 504 || resp.status === 429) {
        lastFailure = { kind: 'transient', status: resp.status };
        return { ok: false, failure: lastFailure, retryable: true };
      }

      lastFailure = { kind: 'http', status: resp.status };
      return { ok: false, failure: lastFailure, retryable: resp.status >= 500 };
    } catch (_) {
      lastFailure = { kind: 'network', status: 0 };
      return { ok: false, failure: lastFailure, retryable: true };
    }
  }

  return { ok: false, failure: lastFailure, retryable: false };
}

function formatAdminStatusFailure(failure) {
  if (!failure) {
    return 'Сервер авторизации недоступен. Попробуйте повторить проверку через несколько секунд.';
  }
  if (failure.kind === 'not_found' || failure.kind === 'non_json') {
    return 'Сервер авторизации (/api/admin/status) не запущен на этом домене. Админ-панель работает только при открытии приложения через его Node.js-сервер (например, в превью или на Cloud Run), а не на статическом хостинге (например, GitHub Pages).';
  }
  if (failure.kind === 'proxy_auth') {
    return `Доступ к серверу авторизации отклонён (HTTP ${failure.status}). Если приложение открыто во встроенном окне, попробуйте открыть его в отдельной вкладке браузера.`;
  }
  if (failure.kind === 'transient') {
    return `Сервер авторизации сейчас запускается или временно недоступен (HTTP ${failure.status}). Подождите пару секунд и нажмите «Повторить проверку».`;
  }
  if (failure.kind === 'network') {
    return 'Не удалось подключиться к серверу авторизации (ошибка сети). Проверьте интернет-соединение и нажмите «Повторить проверку».';
  }
  return `Сервер авторизации вернул ошибку (HTTP ${failure.status || '?'}). Попробуйте повторить проверку.`;
}

function generateRandomHex(byteLen = 16) {
  const bytes = new Uint8Array(byteLen);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    throw new Error('Браузер не поддерживает криптографически стойкий генератор случайных чисел.');
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const clean = String(hex || '').trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function deriveAdminPbkdf2Hex(password, saltHex, iterations = ADMIN_PBKDF2_ITERATIONS) {
  if (!window.crypto?.subtle) {
    throw new Error('Для входа в админ-панель на статическом хостинге требуется защищённое HTTPS-соединение (Web Crypto API).');
  }
  const enc = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(String(password || '')),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const safeIterations = Math.max(100000, Math.min(500000, Number(iterations) || ADMIN_PBKDF2_ITERATIONS));
  const derived = await window.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations: safeIterations,
      hash: 'SHA-256'
    },
    baseKey,
    256
  );
  return Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, '0')).join('');
}

function checkFirebaseRateLimitError() {
  const now = Date.now();
  if (firebaseAuthRateLimit.lockedUntil > now) {
    const waitSec = Math.ceil((firebaseAuthRateLimit.lockedUntil - now) / 1000);
    return `Слишком много неверных попыток. Повторите через ${waitSec} сек.`;
  }
  return '';
}

function recordFirebaseAuthFailure() {
  firebaseAuthRateLimit.failures += 1;
  if (firebaseAuthRateLimit.failures >= 5) {
    const penaltySec = Math.min(300, 60 * (firebaseAuthRateLimit.failures - 4));
    firebaseAuthRateLimit.lockedUntil = Date.now() + penaltySec * 1000;
  }
}

function resetFirebaseAuthFailures() {
  firebaseAuthRateLimit.failures = 0;
  firebaseAuthRateLimit.lockedUntil = 0;
}

async function readFirebaseAdminAuthDoc() {
  const ok = await ensureAdminFirebase();
  if (!ok || !fbDb || !fbFirestoreSdk) {
    throw new Error(cloudErrorText || 'Не удалось подключиться к облачной базе Firestore.');
  }
  const authRef = fbFirestoreSdk.doc(fbDb, ...FIREBASE_ADMIN_CONFIG_PATH, FIREBASE_ADMIN_AUTH_DOC_ID);
  const snap = await fbFirestoreSdk.getDoc(authRef);
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  if (typeof data.saltHex !== 'string' || typeof data.hashHex !== 'string' || !data.saltHex || !data.hashHex) {
    return null;
  }
  return data;
}

async function writeFirebaseAdminAuthDoc(record) {
  const ok = await ensureAdminFirebase();
  if (!ok || !fbDb || !fbFirestoreSdk) {
    throw new Error(cloudErrorText || 'Не удалось подключиться к облачной базе Firestore.');
  }
  const authRef = fbFirestoreSdk.doc(fbDb, ...FIREBASE_ADMIN_CONFIG_PATH, FIREBASE_ADMIN_AUTH_DOC_ID);
  await fbFirestoreSdk.setDoc(authRef, record, { merge: true });
}

async function checkAdminAuthStatus() {
  const subtitle = document.getElementById('admin-auth-subtitle');
  const claimForm = document.getElementById('admin-claim-form');
  const claimHint = document.getElementById('admin-claim-hint');
  const loginForm = document.getElementById('admin-login-form');
  const sourceTag = document.getElementById('admin-auth-source-tag');
  const retryBtn = document.getElementById('admin-auth-retry-btn');

  if (subtitle) subtitle.textContent = 'Проверка статуса панели администратора...';
  showAdminAuthError('');
  setAdminRetryVisible(false);
  if (retryBtn) retryBtn.disabled = true;

  const retryDelays = [0, 800, 1600];
  let result = null;

  for (let i = 0; i < retryDelays.length; i += 1) {
    if (retryDelays[i] > 0) {
      if (subtitle) subtitle.textContent = 'Подключение к серверу авторизации...';
      await waitMs(retryDelays[i]);
    }
    result = await probeAdminStatusOnce();
    if (result.ok || !result.retryable) break;
  }

  // 1. Серверный режим (Node.js / Express)
  if (result && result.ok) {
    if (retryBtn) retryBtn.disabled = false;
    adminAuthMode = 'server';
    const data = result.data;
    adminAuthSource = data.source || 'unclaimed';

    if (adminAuthSource === 'unclaimed') {
      if (subtitle) subtitle.textContent = 'Первичная настройка доступа к управлению БД';
      if (sourceTag) sourceTag.textContent = 'Первичная настройка';
      if (claimHint) {
        claimHint.textContent = 'Пароль администратора ещё не задан. Придумайте пароль сейчас, чтобы защитить доступ к базам данных (или задайте ADMIN_PASSWORD в секретах проекта).';
      }
      claimForm?.classList.remove('hidden');
      loginForm?.classList.add('hidden');
    } else {
      if (subtitle) subtitle.textContent = 'Вход в панель управления базами данных';
      if (sourceTag) sourceTag.textContent = adminAuthSource === 'env' ? 'Защищено секретом ENV' : 'Пароль активирован';
      claimForm?.classList.add('hidden');
      loginForm?.classList.remove('hidden');
      setTimeout(() => document.getElementById('admin-login-pass')?.focus(), 50);
    }
    return;
  }

  // 2. Статический хостинг (GitHub Pages и т.п.): /api/admin/status возвращает 404 или HTML — переключаемся на Firestore
  const isStaticHost = result?.failure?.kind === 'not_found' || result?.failure?.kind === 'non_json';
  if (isStaticHost) {
    if (subtitle) subtitle.textContent = 'Подключение к облачной базе Firestore...';
    try {
      const authDoc = await readFirebaseAdminAuthDoc();
      if (retryBtn) retryBtn.disabled = false;
      adminAuthMode = 'firebase';

      if (!authDoc) {
        adminAuthSource = 'unclaimed';
        if (subtitle) subtitle.textContent = 'Первичная настройка доступа к управлению БД';
        if (sourceTag) sourceTag.textContent = 'Firestore • Настройка';
        if (claimHint) {
          claimHint.textContent = 'Сайт работает на статическом хостинге (GitHub Pages). Придумайте пароль администратора — его защищённый хэш (PBKDF2) сохранится в Firestore.';
        }
        claimForm?.classList.remove('hidden');
        loginForm?.classList.add('hidden');
      } else {
        adminAuthSource = 'firebase';
        if (subtitle) subtitle.textContent = 'Вход в панель управления базами данных';
        if (sourceTag) sourceTag.textContent = 'Firestore (GitHub Pages)';
        claimForm?.classList.add('hidden');
        loginForm?.classList.remove('hidden');
        setTimeout(() => document.getElementById('admin-login-pass')?.focus(), 50);
      }
      return;
    } catch (fbErr) {
      if (retryBtn) retryBtn.disabled = false;
      claimForm?.classList.add('hidden');
      loginForm?.classList.add('hidden');
      if (subtitle) subtitle.textContent = 'Не удалось подключиться к Firestore';
      if (sourceTag) sourceTag.textContent = 'Ошибка Firestore';
      showAdminAuthError(fbErr?.message || 'Проверьте интернет-соединение и доступ к Firebase Firestore.');
      setAdminRetryVisible(true);
      return;
    }
  }

  if (retryBtn) retryBtn.disabled = false;
  claimForm?.classList.add('hidden');
  loginForm?.classList.add('hidden');
  if (subtitle) subtitle.textContent = 'Не удалось связаться с сервером авторизации';
  if (sourceTag) sourceTag.textContent = result?.failure?.status ? `HTTP ${result.failure.status}` : 'Нет связи';
  showAdminAuthError(formatAdminStatusFailure(result?.failure));
  setAdminRetryVisible(true);
}

async function handleClaimSubmit(e) {
  e.preventDefault();
  showAdminAuthError('');

  const pass = document.getElementById('admin-claim-pass')?.value || '';
  const confirm = document.getElementById('admin-claim-confirm')?.value || '';
  const btn = document.getElementById('admin-claim-btn');

  if (pass.length < 6 || pass.length > 128) {
    showAdminAuthError('Пароль администратора должен содержать от 6 до 128 символов.');
    return;
  }
  if (pass !== confirm) {
    showAdminAuthError('Пароли не совпадают.');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    if (adminAuthMode === 'firebase') {
      const existing = await readFirebaseAdminAuthDoc();
      if (existing) {
        showAdminAuthError('Пароль администратора уже настроен. Войдите с текущим паролем.');
        checkAdminAuthStatus();
        return;
      }
      const saltHex = generateRandomHex(16);
      const hashHex = await deriveAdminPbkdf2Hex(pass, saltHex, ADMIN_PBKDF2_ITERATIONS);
      const now = Date.now();
      await writeFirebaseAdminAuthDoc({
        algo: 'pbkdf2-sha256',
        iterations: ADMIN_PBKDF2_ITERATIONS,
        saltHex,
        hashHex,
        createdAt: now,
        updatedAt: now
      });
      adminAuthSource = 'firebase';
      adminToken = `fb_${generateRandomHex(24)}`;
      resetFirebaseAuthFailures();
      showToast('Пароль администратора установлен');
      unlockAdminPanel();
      return;
    }

    const resp = await adminFetch('claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.token) {
      showAdminAuthError(data.error || 'Не удалось установить пароль администратора.');
      if (resp.status === 409) checkAdminAuthStatus();
      return;
    }
    adminAuthSource = data.source || 'claimed';
    adminToken = data.token;
    showToast('Пароль администратора установлен');
    unlockAdminPanel();
  } catch (err) {
    showAdminAuthError(err?.message || 'Ошибка сети.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  showAdminAuthError('');

  const pass = document.getElementById('admin-login-pass')?.value || '';
  const btn = document.getElementById('admin-login-btn');

  if (!pass) {
    showAdminAuthError('Введите пароль администратора.');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    if (adminAuthMode === 'firebase') {
      const rateErr = checkFirebaseRateLimitError();
      if (rateErr) {
        showAdminAuthError(rateErr);
        return;
      }
      const authDoc = await readFirebaseAdminAuthDoc();
      if (!authDoc) {
        showAdminAuthError('Пароль администратора ещё не настроен.');
        checkAdminAuthStatus();
        return;
      }
      const candidateHex = await deriveAdminPbkdf2Hex(pass, authDoc.saltHex, authDoc.iterations);
      if (!constantTimeEqualHex(candidateHex, authDoc.hashHex)) {
        recordFirebaseAuthFailure();
        showAdminAuthError(checkFirebaseRateLimitError() || 'Неверный пароль администратора.');
        return;
      }
      resetFirebaseAuthFailures();
      adminAuthSource = 'firebase';
      adminToken = `fb_${generateRandomHex(24)}`;
      showToast('Добро пожаловать в панель администратора');
      unlockAdminPanel();
      return;
    }

    const resp = await adminFetch('login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.token) {
      showAdminAuthError(data.error || 'Неверный пароль администратора.');
      return;
    }
    adminAuthSource = data.source || adminAuthSource;
    adminToken = data.token;
    showToast('Добро пожаловать в панель администратора');
    unlockAdminPanel();
  } catch (err) {
    showAdminAuthError(err?.message || 'Ошибка сети.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleAdminLogout() {
  if (adminToken && adminAuthMode === 'server') {
    try {
      await adminFetch('logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
    } catch (_) {}
  }
  showToast('Вы вышли из админ-панели');
  lockAdminPanel();
}

function openAdminSelfPasswordModal() {
  const envNotice = document.getElementById('admin-self-pw-env-notice');
  const form = document.getElementById('admin-self-pw-form');
  const currentInp = document.getElementById('admin-self-pw-current');
  const newInp = document.getElementById('admin-self-pw-new');
  const confirmInp = document.getElementById('admin-self-pw-confirm');
  const toggleBtn = document.getElementById('admin-self-pw-toggle-vis');
  const errBox = document.getElementById('admin-self-pw-error');

  if (currentInp) {
    currentInp.value = '';
    currentInp.type = 'password';
  }
  if (newInp) {
    newInp.value = '';
    newInp.type = 'password';
  }
  if (confirmInp) {
    confirmInp.value = '';
    confirmInp.type = 'password';
  }
  if (toggleBtn) toggleBtn.textContent = 'Показать';
  if (errBox) errBox.classList.add('hidden');

  const isEnvManaged = adminAuthSource === 'env';
  if (envNotice) envNotice.classList.toggle('hidden', !isEnvManaged);
  if (form) form.classList.toggle('hidden', isEnvManaged);

  openModal('modal-admin-self-password');
  if (!isEnvManaged) {
    setTimeout(() => currentInp?.focus(), 50);
  }
}

async function handleChangeAdminSelfPassword(e) {
  e.preventDefault();
  const errBox = document.getElementById('admin-self-pw-error');
  const submitBtn = document.getElementById('admin-self-pw-submit');
  if (errBox) errBox.classList.add('hidden');

  const showErr = (msg) => {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  };

  const currentPassword = document.getElementById('admin-self-pw-current')?.value || '';
  const newPassword = document.getElementById('admin-self-pw-new')?.value || '';
  const confirmPassword = document.getElementById('admin-self-pw-confirm')?.value || '';

  if (!currentPassword) {
    showErr('Введите текущий пароль администратора.');
    return;
  }
  if (newPassword.length < 6 || newPassword.length > 128) {
    showErr('Новый пароль должен содержать от 6 до 128 символов.');
    return;
  }
  if (newPassword !== confirmPassword) {
    showErr('Новые пароли не совпадают.');
    return;
  }
  if (newPassword === currentPassword) {
    showErr('Новый пароль должен отличаться от текущего.');
    return;
  }
  if (!adminToken) {
    showErr('Сессия администратора истекла. Войдите снова.');
    lockAdminPanel();
    return;
  }

  const prevText = submitBtn?.textContent || 'Сохранить пароль';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохранение...';
  }

  try {
    if (adminAuthMode === 'firebase') {
      const rateErr = checkFirebaseRateLimitError();
      if (rateErr) {
        showErr(rateErr);
        return;
      }
      const authDoc = await readFirebaseAdminAuthDoc();
      if (!authDoc) {
        showErr('Запись пароля администратора не найдена в Firestore.');
        return;
      }
      const currentHex = await deriveAdminPbkdf2Hex(currentPassword, authDoc.saltHex, authDoc.iterations);
      if (!constantTimeEqualHex(currentHex, authDoc.hashHex)) {
        recordFirebaseAuthFailure();
        showErr(checkFirebaseRateLimitError() || 'Неверный текущий пароль администратора.');
        return;
      }
      resetFirebaseAuthFailures();
      const newSaltHex = generateRandomHex(16);
      const newHashHex = await deriveAdminPbkdf2Hex(newPassword, newSaltHex, ADMIN_PBKDF2_ITERATIONS);
      await writeFirebaseAdminAuthDoc({
        algo: 'pbkdf2-sha256',
        iterations: ADMIN_PBKDF2_ITERATIONS,
        saltHex: newSaltHex,
        hashHex: newHashHex,
        updatedAt: Date.now()
      });
      adminToken = `fb_${generateRandomHex(24)}`;
      closeModal('modal-admin-self-password');
      showToast('Пароль администратора изменён');
      return;
    }

    const resp = await adminFetch('change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401 && data.error && !data.error.includes('текущий')) {
      closeModal('modal-admin-self-password');
      lockAdminPanel('Сессия истекла. Войдите снова.');
      return;
    }
    if (!resp.ok || !data.token) {
      showErr(data.error || 'Не удалось изменить пароль администратора.');
      return;
    }

    adminToken = data.token;
    closeModal('modal-admin-self-password');
    showToast('Пароль администратора изменён');
  } catch (err) {
    showErr(err?.message || 'Ошибка сети при сохранении пароля.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevText;
    }
  }
}

// ==================== ПРИВЯЗКА СОБЫТИЙ ====================

function bindEvents() {
  document.getElementById('admin-claim-form')?.addEventListener('submit', handleClaimSubmit);
  document.getElementById('admin-login-form')?.addEventListener('submit', handleLoginSubmit);
  document.getElementById('admin-change-pw-form')?.addEventListener('submit', handleChangeUserPassword);
  document.getElementById('admin-self-pw-form')?.addEventListener('submit', handleChangeAdminSelfPassword);
  document.getElementById('admin-auth-retry-btn')?.addEventListener('click', () => {
    checkAdminAuthStatus();
  });

  document.getElementById('admin-toggle-login-vis')?.addEventListener('click', () => {
    const inp = document.getElementById('admin-login-pass');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('admin-self-pw-toggle-vis')?.addEventListener('click', () => {
    const curInp = document.getElementById('admin-self-pw-current');
    const newInp = document.getElementById('admin-self-pw-new');
    const confInp = document.getElementById('admin-self-pw-confirm');
    const toggleBtn = document.getElementById('admin-self-pw-toggle-vis');
    const nextType = newInp && newInp.type === 'password' ? 'text' : 'password';
    if (curInp) curInp.type = nextType;
    if (newInp) newInp.type = nextType;
    if (confInp) confInp.type = nextType;
    if (toggleBtn) toggleBtn.textContent = nextType === 'text' ? 'Скрыть' : 'Показать';
  });

  document.getElementById('admin-theme-btn')?.addEventListener('click', toggleTheme);
  document.getElementById('admin-refresh-btn')?.addEventListener('click', () => {
    fetchAllDatabases();
    showToast('Базы данных обновлены');
  });
  document.getElementById('admin-change-admin-pw-btn')?.addEventListener('click', openAdminSelfPasswordModal);
  document.getElementById('admin-logout-btn')?.addEventListener('click', handleAdminLogout);

  document.getElementById('admin-search-input')?.addEventListener('input', renderDashboard);
  document.getElementById('admin-sort-select')?.addEventListener('change', renderDashboard);

  document.querySelectorAll('.db-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeDbFilter = btn.getAttribute('data-db-filter') || 'all';
      document.querySelectorAll('.db-filter-btn').forEach((b) => {
        const isCurrent = b.getAttribute('data-db-filter') === activeDbFilter;
        b.className = isCurrent
          ? 'db-filter-btn px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-900 dark:bg-rose-500 text-white transition shrink-0'
          : 'db-filter-btn px-3 py-1.5 rounded-xl text-xs font-bold bg-warmgray dark:bg-slate-800 text-slate-600 dark:text-slate-300 transition shrink-0';
      });
      renderDashboard();
    });
  });

  document.getElementById('admin-merge-dups-btn')?.addEventListener('click', () => {
    runMergeAccounts('duplicates');
  });
  document.getElementById('admin-migrate-all-btn')?.addEventListener('click', () => {
    runMergeAccounts('all_legacy');
  });

  // Делегирование кликов по кнопкам в списке пользователей (исключает инъекции в inline onclick)
  document.getElementById('admin-users-container')?.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('button[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    const login = target.getAttribute('data-login');
    if (!login) return;
    if (action === 'merge-user') runMergeAccounts('duplicates', login);
    if (action === 'change-password') openChangePasswordModal(login);
    if (action === 'inspect-user') openUserDetailsModal(login);
  });

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close-modal');
      if (id) closeModal(id);
    });
  });

  document.getElementById('pw-generate-btn')?.addEventListener('click', () => {
    const generated = generateSecurePassword(10);
    const newInp = document.getElementById('pw-modal-new');
    const confirmInp = document.getElementById('pw-modal-confirm');
    if (newInp) {
      newInp.value = generated;
      newInp.type = 'text';
    }
    if (confirmInp) {
      confirmInp.value = generated;
      confirmInp.type = 'text';
    }
    showToast('Сгенерирован новый пароль');
  });

  document.getElementById('pw-toggle-vis-btn')?.addEventListener('click', () => {
    const newInp = document.getElementById('pw-modal-new');
    const confirmInp = document.getElementById('pw-modal-confirm');
    const nextType = newInp && newInp.type === 'password' ? 'text' : 'password';
    if (newInp) newInp.type = nextType;
    if (confirmInp) confirmInp.type = nextType;
  });

  document.getElementById('pw-copy-btn')?.addEventListener('click', async () => {
    const val = document.getElementById('pw-modal-new')?.value || '';
    if (!val) {
      showToast('Сначала введите или сгенерируйте пароль');
      return;
    }
    try {
      await navigator.clipboard.writeText(val);
      showToast('Пароль скопирован в буфер обмена');
    } catch (_) {
      showToast('Скопируйте пароль вручную из поля');
    }
  });

  document.getElementById('admin-export-all-btn')?.addEventListener('click', () => {
    const snapshot = {
      exportedAt: new Date().toISOString(),
      appId,
      totalUsers: allUsers.length,
      users: allUsers.map(buildSanitizedExportDoc)
    };
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJsonFile(`malysh_db_export_${stamp}.json`, snapshot);
    showToast('Резервная копия БД скачана');
  });

  document.getElementById('details-export-user-btn')?.addEventListener('click', () => {
    const user = allUsers.find(u => u.login === selectedDetailsLogin);
    if (!user) return;
    downloadJsonFile(`malysh_user_${user.login}.json`, buildSanitizedExportDoc(user));
    showToast(`Данные @${user.login} скачаны`);
  });

  document.getElementById('details-sync-cloud-btn')?.addEventListener('click', syncSelectedLocalUserToCloud);

  document.getElementById('admin-test-push-btn')?.addEventListener('click', async () => {
    if (!('Notification' in window)) {
      showToast('Браузер не поддерживает системные уведомления');
      return;
    }
    try {
      registerAppServiceWorker().catch(() => {});
      let perm = Notification.permission;
      if (perm === 'default') {
        perm = await Notification.requestPermission();
      }
      if (perm !== 'granted') {
        showToast(perm === 'denied'
          ? 'Уведомления заблокированы — разрешите их в настройках сайта'
          : 'Разрешение на уведомления не выдано');
        return;
      }
      await registerAppServiceWorker();
      const res = await showSystemNotification({
        title: 'Малыш+ Admin — тест уведомлений',
        body: 'Системные уведомления и Service Worker работают корректно.',
        tag: 'malysh-admin-test-' + Date.now(),
        key: 'admin_test',
        tab: 'journal'
      });
      if (res.ok) {
        showToast(`Тестовое уведомление отправлено (${res.via === 'sw' ? 'через Service Worker' : 'через браузер'})`);
      } else {
        showToast('Не удалось отправить тестовое уведомление');
      }
    } catch (_) {
      showToast('Ошибка при проверке уведомлений');
    }
  });
}

initTheme();
bindEvents();
checkAdminAuthStatus();
