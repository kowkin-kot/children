// Синхронизация с Firebase Firestore и авторизация по логину и паролю

import {
  firebaseConfig,
  FIREBASE_COLLECTION_PATH,
  LEGACY_FIREBASE_COLLECTION_PATH,
  FIREBASE_INVITES_COLLECTION_PATH
} from './config.js';
import {
  store,
  hooks,
  createDefaultState,
  mergeStateWithDefaults,
  mergeAccountStates,
  getStateRecordCount,
  readLocalAccounts,
  writeLocalAccount,
  writeLocalSession,
  writeCaregiverName,
  getCurrentCaregiverName,
  calculateBabyAge
} from './state.js';
import {
  hashPassword,
  fnvHash,
  normalizeLogin,
  sanitizeForFirestore,
  getTodayIso,
  closeModal,
  showToast
} from './utils.js';

const FIREBASE_CDN_BASE = 'https://www.gstatic.com/firebasejs/11.6.1';

let fbAppSdk = null;
let fbAuthSdk = null;
let fbFirestoreSdk = null;
let sdkLoadPromise = null;

let app = null;
let auth = null;
let db = null;
let firebaseUser = null;
let unsubAccountSnapshot = null;
let subscribedLogin = null;
let activeInitPromise = null;
let localMutationSeq = 0;
let activeSavePromise = null;
let queuedSaveNeeded = false;
let lastCloudRefreshAt = 0;

// Динамическая загрузка официального Firebase Modular SDK из CDN (работает и на GitHub Pages без сборщика, и в Vite, и не блокирует офлайн-запуск)
async function loadFirebaseSdk() {
  if (fbAppSdk && fbAuthSdk && fbFirestoreSdk) {
    return { appSdk: fbAppSdk, authSdk: fbAuthSdk, firestoreSdk: fbFirestoreSdk };
  }
  if (!sdkLoadPromise) {
    sdkLoadPromise = Promise.all([
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
        sdkLoadPromise = null;
        throw err;
      });
  }
  return sdkLoadPromise;
}

// Надёжная инициализация Firebase с повторным подключением при сбое
export function ensureFirebaseReady() {
  if (db && fbFirestoreSdk && firebaseUser) {
    return Promise.resolve(firebaseUser);
  }
  if (activeInitPromise) {
    return activeInitPromise;
  }

  activeInitPromise = (async () => {
    try {
      const { appSdk, authSdk, firestoreSdk } = await loadFirebaseSdk();
      if (!app) {
        const existingApps = appSdk.getApps();
        app = existingApps.length > 0 ? existingApps[0] : appSdk.initializeApp(firebaseConfig);
      }
      if (!auth) auth = authSdk.getAuth(app);
      if (!db) db = firestoreSdk.getFirestore(app);

      if (typeof auth.authStateReady === 'function') {
        try {
          await auth.authStateReady();
        } catch (_) {}
      }

      if (auth.currentUser) {
        firebaseUser = auth.currentUser;
        return firebaseUser;
      }

      try {
        const cred = await authSdk.signInAnonymously(auth);
        if (cred && cred.user) {
          firebaseUser = cred.user;
          return firebaseUser;
        }
      } catch (e) {
        console.warn('Anonymous sign-in warning:', e);
      }

      return await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          if (auth && auth.currentUser) {
            firebaseUser = auth.currentUser;
          }
          resolve(firebaseUser);
        }, 5000);
        const unsub = authSdk.onAuthStateChanged(auth, (user) => {
          if (user) {
            firebaseUser = user;
            clearTimeout(timeoutId);
            unsub();
            resolve(firebaseUser);
          }
        });
      });
    } catch (e) {
      console.warn('Firebase init offline fallback:', e);
      return null;
    } finally {
      if (!db || !fbFirestoreSdk || !firebaseUser) {
        activeInitPromise = null;
      }
    }
  })();

  return activeInitPromise;
}

// Запускаем прогрев Firebase в фоне при загрузке страницы
export const firebaseReadyPromise = ensureFirebaseReady();

async function verifyPasswordHash(storedHash, rawPassword, shaHash) {
  if (!storedHash) return true;
  if (storedHash === shaHash) return true;

  // Поддержка старых аккаунтов, зарегистрированных без crypto.subtle (fnv_)
  if (storedHash.startsWith('fnv_') && storedHash === fnvHash(rawPassword)) {
    return true;
  }

  // Защита от случайных пробелов по краям при автозаполнении/вставке на смартфоне
  const trimmed = String(rawPassword || '').trim();
  if (trimmed && trimmed !== rawPassword) {
    const trimmedSha = await hashPassword(trimmed);
    if (storedHash === trimmedSha) return true;
    if (storedHash.startsWith('fnv_') && storedHash === fnvHash(trimmed)) return true;
  }

  return false;
}

function hasLocalAdditionsOverCloud(mergedState, cloudState) {
  if (!cloudState || typeof cloudState !== 'object') return true;
  if (getStateRecordCount(mergedState) > getStateRecordCount(cloudState)) return true;

  const cloudNorm = mergeStateWithDefaults(cloudState);
  for (const tKey of ['feeding', 'sleep', 'walk', 'pumping']) {
    const mT = mergedState.timers?.[tKey];
    const cT = cloudNorm.timers?.[tKey];
    const mTs = Number(mT?.updatedAt) || (mT?.active ? Number(mT.startTime) || 0 : 0);
    const cTs = Number(cT?.updatedAt) || (cT?.active ? Number(cT.startTime) || 0 : 0);
    if (mTs > cTs) return true;
  }

  for (const cat of ['journal', 'diary', 'growth', 'milkBank']) {
    const mDel = mergedState.deletedIds?.[cat] || {};
    const cDel = cloudNorm.deletedIds?.[cat] || {};
    for (const [id, ts] of Object.entries(mDel)) {
      if ((Number(ts) || 0) > (Number(cDel[id]) || 0)) return true;
    }
  }
  return false;
}

export async function saveAppState() {
  if (!store.currentAccountLogin) return;
  const targetLogin = store.currentAccountLogin;
  localMutationSeq += 1;

  const localExisting = readLocalAccounts()[targetLogin];
  const resolvedCreatedAt = store.currentAccountCreatedAt
    || localExisting?.createdAt
    || store.appState?.accountCreatedAt
    || null;
  if (resolvedCreatedAt && !store.currentAccountCreatedAt) {
    store.currentAccountCreatedAt = resolvedCreatedAt;
  }

  store.pendingSyncState = true;
  writeLocalAccount(targetLogin, store.currentAccountPassHash, store.appState, {
    createdAt: resolvedCreatedAt || undefined,
    pendingSync: true
  });
  store.inMemoryAccountsCache.set(targetLogin, {
    login: targetLogin,
    passHash: store.currentAccountPassHash,
    state: store.appState,
    createdAt: resolvedCreatedAt || Date.now(),
    updatedAt: Date.now(),
    pendingSync: true
  });
  hooks.updateNetworkStatusUI();

  if (!navigator.onLine) {
    return;
  }

  queuedSaveNeeded = true;
  if (activeSavePromise) {
    return activeSavePromise;
  }

  activeSavePromise = (async () => {
    try {
      while (queuedSaveNeeded) {
        queuedSaveNeeded = false;
        if (!store.currentAccountLogin || store.currentAccountLogin !== targetLogin || !navigator.onLine) {
          break;
        }

        await ensureFirebaseReady();
        if (!db || !fbFirestoreSdk || !firebaseUser) {
          store.pendingSyncState = true;
          hooks.updateNetworkStatusUI();
          break;
        }

        const seqAtStart = localMutationSeq;
        const localSnapshot = sanitizeForFirestore(store.appState);
        const accRef = fbFirestoreSdk.doc(db, ...FIREBASE_COLLECTION_PATH, targetLogin);
        const passHashSnapshot = store.currentAccountPassHash;
        const createdAtSnapshot = store.currentAccountCreatedAt || resolvedCreatedAt || null;

        let committedState = null;

        if (typeof fbFirestoreSdk.runTransaction === 'function') {
          committedState = await fbFirestoreSdk.runTransaction(db, async (transaction) => {
            const snap = await transaction.get(accRef);
            const cloudData = snap.exists() ? snap.data() : null;
            const cloudState = cloudData?.state && typeof cloudData.state === 'object' ? cloudData.state : null;

            const mergedState = cloudState
              ? mergeAccountStates([cloudState, localSnapshot]).state
              : mergeStateWithDefaults(localSnapshot);

            const payload = {
              login: targetLogin,
              state: sanitizeForFirestore(mergedState),
              updatedAt: Date.now()
            };
            const effectiveCreatedAt = createdAtSnapshot || cloudData?.createdAt || mergedState.accountCreatedAt || null;
            if (effectiveCreatedAt) payload.createdAt = effectiveCreatedAt;
            // Никогда не затираем существующий passHash пустой строкой
            if (passHashSnapshot) payload.passHash = passHashSnapshot;

            transaction.set(accRef, payload, { merge: true });
            return payload.state;
          });
        } else {
          const snap = await fbFirestoreSdk.getDoc(accRef);
          const cloudData = snap.exists() ? snap.data() : null;
          const cloudState = cloudData?.state && typeof cloudData.state === 'object' ? cloudData.state : null;

          const mergedState = cloudState
            ? mergeAccountStates([cloudState, localSnapshot]).state
            : mergeStateWithDefaults(localSnapshot);

          const payload = {
            login: targetLogin,
            state: sanitizeForFirestore(mergedState),
            updatedAt: Date.now()
          };
          const effectiveCreatedAt = createdAtSnapshot || cloudData?.createdAt || mergedState.accountCreatedAt || null;
          if (effectiveCreatedAt) payload.createdAt = effectiveCreatedAt;
          if (passHashSnapshot) payload.passHash = passHashSnapshot;

          await fbFirestoreSdk.setDoc(accRef, payload, { merge: true });
          committedState = payload.state;
        }

        if (store.currentAccountLogin !== targetLogin) break;

        if (localMutationSeq === seqAtStart) {
          const prevJson = JSON.stringify(store.appState);
          const nextState = mergeStateWithDefaults(committedState);
          const nextJson = JSON.stringify(nextState);

          store.pendingSyncState = false;
          writeLocalAccount(targetLogin, passHashSnapshot, nextState, {
            createdAt: createdAtSnapshot || undefined,
            pendingSync: false
          });
          store.inMemoryAccountsCache.set(targetLogin, {
            login: targetLogin,
            passHash: passHashSnapshot,
            state: nextState,
            createdAt: createdAtSnapshot || Date.now(),
            updatedAt: Date.now(),
            pendingSync: false
          });

          if (prevJson !== nextJson) {
            store.isRemoteSyncApplying = true;
            store.appState = nextState;
            hooks.renderAll();
            store.isRemoteSyncApplying = false;
          }
          hooks.updateNetworkStatusUI();
        } else {
          // Пока транзакция выполнялась, пользователь внёс новые данные — объединяем и повторяем сохранение
          store.appState = mergeAccountStates([committedState, store.appState]).state;
          writeLocalAccount(targetLogin, passHashSnapshot, store.appState, {
            createdAt: createdAtSnapshot || undefined,
            pendingSync: true
          });
          queuedSaveNeeded = true;
        }
      }
    } catch (e) {
      console.warn('Firestore save queued offline:', e);
      store.pendingSyncState = true;
      writeLocalAccount(targetLogin, store.currentAccountPassHash, store.appState, {
        createdAt: resolvedCreatedAt || undefined,
        pendingSync: true
      });
      hooks.updateNetworkStatusUI();
    } finally {
      activeSavePromise = null;
    }
  })();

  return activeSavePromise;
}

export async function flushPendingSync() {
  if (!store.pendingSyncState || !store.currentAccountLogin || !navigator.onLine) return;
  await saveAppState();
}

function combineCloudAccountDocs(primaryData, legacyData) {
  if (!primaryData && !legacyData) return null;

  // Упорядочиваем от старого к новому: legacy -> primary, а если есть данные только в legacy, сохраняем всё
  const orderedStates = [];
  if (legacyData?.state && typeof legacyData.state === 'object') {
    orderedStates.push(legacyData.state);
  }
  if (primaryData?.state && typeof primaryData.state === 'object') {
    orderedStates.push(primaryData.state);
  }
  const { state: mergedState } = mergeAccountStates(orderedStates);

  const primaryHash = primaryData?.passHash || primaryData?.passwordHash || '';
  const legacyHash = legacyData?.passHash || legacyData?.passwordHash || '';
  const resolvedPassHash = primaryHash || legacyHash || '';

  const createdCandidates = [
    primaryData?.createdAt,
    legacyData?.createdAt,
    primaryData?.state?.accountCreatedAt,
    legacyData?.state?.accountCreatedAt
  ].filter(v => typeof v === 'number' && Number.isFinite(v) && v > 946684800000);
  const createdAt = createdCandidates.length > 0 ? Math.min(...createdCandidates) : null;

  const primaryScore = primaryData?.state ? getStateRecordCount(primaryData.state) : 0;
  const mergedScore = getStateRecordCount(mergedState);
  const needsPrimaryMigration = Boolean(
    legacyData && (!primaryData || mergedScore > primaryScore)
  );

  return {
    ...(legacyData || {}),
    ...(primaryData || {}),
    passHash: resolvedPassHash,
    legacyAltPassHash: legacyHash && legacyHash !== resolvedPassHash ? legacyHash : '',
    createdAt,
    state: mergedState,
    needsPrimaryMigration
  };
}

export function subscribeAccountRealtime(login) {
  if (unsubAccountSnapshot && subscribedLogin === login) {
    return;
  }
  if (unsubAccountSnapshot) {
    try { unsubAccountSnapshot(); } catch (_) {}
    unsubAccountSnapshot = null;
    subscribedLogin = null;
  }
  if (!db || !fbFirestoreSdk || !login) return;
  try {
    subscribedLogin = login;
    const accRef = fbFirestoreSdk.doc(db, ...FIREBASE_COLLECTION_PATH, login);
    unsubAccountSnapshot = fbFirestoreSdk.onSnapshot(accRef, (snap) => {
      if (!snap.exists()) return;
      if (snap.metadata?.hasPendingWrites) return;
      if (store.currentAccountLogin !== login) return;
      const data = snap.data();
      if (data && data.passHash) {
        store.currentAccountPassHash = data.passHash;
      }
      if (data && data.createdAt && !store.currentAccountCreatedAt) {
        store.currentAccountCreatedAt = data.createdAt;
      }
      if (data && data.state && typeof data.state === 'object') {
        const incomingCount = getStateRecordCount(data.state);
        const currentCount = getStateRecordCount(store.appState);
        // Защита от затирания: если в облаке пустой документ, а локально есть записи — отправляем актуальные данные
        if (incomingCount === 0 && currentCount > 0) {
          saveAppState();
          return;
        }

        // Всегда объединяем облачные и локальные данные, никогда не затирая вводные другого родителя
        const { state: merged } = store.pendingSyncState
          ? mergeAccountStates([data.state, store.appState])
          : mergeAccountStates([store.appState, data.state]);

        if (JSON.stringify(merged) === JSON.stringify(store.appState)) {
          return;
        }

        store.isRemoteSyncApplying = true;
        store.appState = merged;
        writeLocalAccount(login, data.passHash || store.currentAccountPassHash, store.appState, {
          createdAt: data.createdAt || store.currentAccountCreatedAt || undefined,
          passwordChangedAt: data.passwordChangedAt || undefined,
          pendingSync: store.pendingSyncState
        });
        hooks.renderAll();
        store.isRemoteSyncApplying = false;
      }
    }, (err) => {
      console.warn('Realtime sync listener warning:', err);
    });
  } catch (_) {}
}

export async function syncSavedSessionFromCloud(savedLogin, options = {}) {
  const { skipResubscribe = false } = options;
  lastCloudRefreshAt = Date.now();
  try {
    const user = await ensureFirebaseReady();
    if (!user || !db || !fbFirestoreSdk || store.currentAccountLogin !== savedLogin) return;

    const [primarySnap, legacySnap] = await Promise.all([
      fbFirestoreSdk.getDoc(fbFirestoreSdk.doc(db, ...FIREBASE_COLLECTION_PATH, savedLogin)),
      fbFirestoreSdk.getDoc(fbFirestoreSdk.doc(db, ...LEGACY_FIREBASE_COLLECTION_PATH, savedLogin)).catch(() => null)
    ]);

    if (store.currentAccountLogin !== savedLogin) return;

    const primaryData = primarySnap.exists() ? primarySnap.data() : null;
    const legacyData = legacySnap && legacySnap.exists() ? legacySnap.data() : null;
    const combined = combineCloudAccountDocs(primaryData, legacyData);

    if (combined) {
      if (combined.passHash) {
        store.currentAccountPassHash = combined.passHash;
      }
      if (combined.createdAt) {
        store.currentAccountCreatedAt = combined.createdAt;
      }
      if (combined.state) {
        const { state: merged } = store.pendingSyncState
          ? mergeAccountStates([combined.state, store.appState])
          : mergeAccountStates([store.appState, combined.state]);

        const changedFromLocal = JSON.stringify(merged) !== JSON.stringify(store.appState);
        const shouldPushToCloud = Boolean(
          store.pendingSyncState
          || combined.needsPrimaryMigration
          || hasLocalAdditionsOverCloud(merged, combined.state)
        );

        store.isRemoteSyncApplying = true;
        store.appState = merged;
        writeLocalAccount(savedLogin, combined.passHash || store.currentAccountPassHash, store.appState, {
          createdAt: combined.createdAt || store.currentAccountCreatedAt || undefined,
          passwordChangedAt: combined.passwordChangedAt || undefined,
          pendingSync: shouldPushToCloud
        });
        if (changedFromLocal) {
          hooks.renderAll();
        }
        store.isRemoteSyncApplying = false;

        if (shouldPushToCloud) {
          await saveAppState();
        }
      }
    } else if (store.pendingSyncState) {
      await saveAppState();
    }

    if (!skipResubscribe) {
      subscribeAccountRealtime(savedLogin);
    }
  } catch (_) {
  } finally {
    store.initialCloudSyncDone = true;
    hooks.updateNetworkStatusUI();
  }
}

export async function refreshAccountFromCloud() {
  if (!store.currentAccountLogin || !navigator.onLine) return;
  if (store.pendingSyncState) {
    await flushPendingSync();
    return;
  }
  const now = Date.now();
  if (now - lastCloudRefreshAt < 8000) return;
  await syncSavedSessionFromCloud(store.currentAccountLogin);
}

const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const INVITE_TTL_OPTIONS = [
  {
    key: 'forever',
    label: 'Бессрочный',
    shortLabel: 'Бессрочно',
    badge: 'Для папы и семьи',
    description: 'Не сгорает со временем: папа или близкие смогут входить в любое время, пока вы не отзовёте код.',
    ttlMs: null,
    neverExpires: true,
    multiUse: true
  },
  {
    key: '30m',
    label: '30 мин',
    shortLabel: '30 мин',
    badge: 'Разовый вход',
    description: 'Короткий одноразовый код на 30 минут для быстрого подключения.',
    ttlMs: 30 * 60000,
    neverExpires: false,
    multiUse: false
  },
  {
    key: '12h',
    label: '12 часов',
    shortLabel: '12 ч',
    badge: 'Няня на смену',
    description: 'Подойдёт для временной няни на рабочий день: действует 12 часов.',
    ttlMs: 12 * 3600000,
    neverExpires: false,
    multiUse: true
  },
  {
    key: '24h',
    label: '24 часа',
    shortLabel: '24 ч',
    badge: 'Няня на сутки',
    description: 'Временный доступ для няни или бабушки ровно на 24 часа.',
    ttlMs: 24 * 3600000,
    neverExpires: false,
    multiUse: true
  },
  {
    key: '7d',
    label: '7 дней',
    shortLabel: '7 дней',
    badge: 'На неделю',
    description: 'Действует 7 дней — удобно на период отпуска или приезда родственников.',
    ttlMs: 7 * 86400000,
    neverExpires: false,
    multiUse: true
  }
];

export function getInviteTtlOption(ttlKey) {
  return INVITE_TTL_OPTIONS.find(opt => opt.key === ttlKey) || INVITE_TTL_OPTIONS[1];
}

export function evaluateInviteAccess(invite, now = Date.now()) {
  if (!invite || typeof invite !== 'object') {
    return { valid: false, reason: 'Некорректный код приглашения.' };
  }
  if (invite.revoked) {
    return { valid: false, reason: 'Этот код приглашения был отозван. Попросите создать новый код.' };
  }
  const neverExpires = Boolean(invite.neverExpires || invite.expiresAt === null);
  const multiUse = Boolean(invite.multiUse || neverExpires);
  if (!neverExpires) {
    const exp = Number(invite.expiresAt);
    if (!Number.isFinite(exp) || now > exp) {
      const ttlHint = invite.ttlLabel ? ` (${invite.ttlLabel})` : '';
      return { valid: false, reason: `Срок действия кода истёк${ttlHint}. Попросите создать новый код в Профиле.` };
    }
  }
  if (!multiUse && invite.used) {
    return { valid: false, reason: 'Этот одноразовый код уже был использован. Попросите создать новый.' };
  }
  return { valid: true, neverExpires, multiUse };
}

export function generateInviteCodeString(length = 6) {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    out += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  }
  return out;
}

export async function createFamilyInviteCode(ttlKey = '30m') {
  if (!store.currentAccountLogin) {
    throw new Error('Сначала войдите в аккаунт.');
  }
  if (!navigator.onLine) {
    throw new Error('Для создания кода-приглашения нужен интернет.');
  }
  const user = await ensureFirebaseReady();
  if (!user || !db || !fbFirestoreSdk) {
    throw new Error('Не удалось подключиться к облачной базе. Попробуйте через пару секунд.');
  }

  const preset = getInviteTtlOption(ttlKey);
  const code = generateInviteCodeString(6);
  const now = Date.now();
  const expiresAt = preset.neverExpires ? null : (now + preset.ttlMs);
  const createdBy = getCurrentCaregiverName();

  const localInviteRecord = {
    code,
    createdBy,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    neverExpires: preset.neverExpires,
    multiUse: preset.multiUse,
    ttlKey: preset.key,
    ttlLabel: preset.label,
    useCount: 0,
    used: false,
    lastUsedAt: null,
    lastUsedBy: '',
    revoked: false,
    revokedAt: null
  };

  if (!Array.isArray(store.appState.familyInvites)) {
    store.appState.familyInvites = [];
  }
  store.appState.familyInvites = [
    localInviteRecord,
    ...store.appState.familyInvites.filter(item => item && item.code !== code)
  ].slice(0, 20);

  // Сохраняем текущие данные перед приглашением, чтобы второй родитель сразу увидел актуальный журнал и список кодов
  await saveAppState();

  const inviteRef = fbFirestoreSdk.doc(db, ...FIREBASE_INVITES_COLLECTION_PATH, code);
  await fbFirestoreSdk.setDoc(inviteRef, {
    code,
    targetLogin: store.currentAccountLogin,
    babyName: store.appState?.babyName || 'Малыш',
    createdBy,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    neverExpires: preset.neverExpires,
    multiUse: preset.multiUse,
    ttlKey: preset.key,
    ttlLabel: preset.label,
    useCount: 0,
    used: false,
    revoked: false
  });

  return localInviteRecord;
}

export async function revokeFamilyInviteCode(code) {
  const cleanCode = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleanCode) {
    throw new Error('Некорректный код приглашения.');
  }
  if (!store.currentAccountLogin) {
    throw new Error('Сначала войдите в аккаунт.');
  }
  if (!navigator.onLine) {
    throw new Error('Для отзыва кода нужен интернет.');
  }
  const user = await ensureFirebaseReady();
  if (!user || !db || !fbFirestoreSdk) {
    throw new Error('Не удалось подключиться к облачной базе.');
  }

  const now = Date.now();
  const inviteRef = fbFirestoreSdk.doc(db, ...FIREBASE_INVITES_COLLECTION_PATH, cleanCode);
  await fbFirestoreSdk.setDoc(inviteRef, {
    revoked: true,
    revokedAt: now,
    updatedAt: now
  }, { merge: true });

  const list = Array.isArray(store.appState.familyInvites) ? store.appState.familyInvites : [];
  store.appState.familyInvites = list.map(item => (
    item && item.code === cleanCode
      ? { ...item, revoked: true, revokedAt: now, updatedAt: now }
      : item
  ));
  await saveAppState();
  return cleanCode;
}

export function selectAuthInviteRole(role) {
  const inp = document.getElementById('auth-invite-role-input');
  if (inp) inp.value = role;
  document.querySelectorAll('.auth-invite-role-btn').forEach(btn => {
    const active = btn.getAttribute('data-role') === role;
    btn.className = active
      ? 'auth-invite-role-btn py-1.5 px-2.5 rounded-xl border border-rose-400 bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 text-xs font-bold transition'
      : 'auth-invite-role-btn py-1.5 px-2.5 rounded-xl border border-stone-200 dark:border-slate-700 bg-warmgray/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold transition';
  });
}

export function switchAuthMode(mode) {
  store.authMode = mode === 'login' ? 'login' : mode === 'invite' ? 'invite' : 'register';
  const tabReg = document.getElementById('auth-tab-register');
  const tabLog = document.getElementById('auth-tab-login');
  const tabInv = document.getElementById('auth-tab-invite');
  const credFields = document.getElementById('auth-credentials-fields');
  const regFields = document.getElementById('auth-register-fields');
  const invFields = document.getElementById('auth-invite-fields');
  const loginInp = document.getElementById('auth-login-input');
  const passInp = document.getElementById('auth-pass-input');
  const invCodeInp = document.getElementById('auth-invite-code');
  const submitBtn = document.getElementById('auth-submit-btn');
  const loginLabel = document.getElementById('auth-login-label');
  const passLabel = document.getElementById('auth-pass-label');
  const errBox = document.getElementById('auth-error-box');

  if (errBox) errBox.classList.add('hidden');

  const activeCls = 'py-2 px-2 rounded-xl text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs transition';
  const idleCls = 'py-2 px-2 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition';

  if (tabReg) tabReg.className = store.authMode === 'register' ? activeCls : idleCls;
  if (tabLog) tabLog.className = store.authMode === 'login' ? activeCls : idleCls;
  if (tabInv) tabInv.className = store.authMode === 'invite' ? activeCls : idleCls;

  const isInvite = store.authMode === 'invite';
  if (credFields) credFields.classList.toggle('hidden', isInvite);
  if (regFields) regFields.classList.toggle('hidden', store.authMode !== 'register');
  if (invFields) invFields.classList.toggle('hidden', !isInvite);

  if (loginInp) loginInp.required = !isInvite;
  if (passInp) passInp.required = !isInvite;
  if (invCodeInp) invCodeInp.required = isInvite;

  if (store.authMode === 'register') {
    if (submitBtn) submitBtn.textContent = 'Создать аккаунт и войти';
    if (loginLabel) loginLabel.innerHTML = 'Придумайте логин <span class="text-slate-400 font-normal">(мин. 3 символа)</span>';
    if (passLabel) passLabel.innerHTML = 'Пароль <span class="text-slate-400 font-normal">(мин. 4 символа)</span>';
  } else if (store.authMode === 'login') {
    if (submitBtn) submitBtn.textContent = 'Войти в аккаунт';
    if (loginLabel) loginLabel.textContent = 'Логин';
    if (passLabel) passLabel.textContent = 'Пароль';
  } else {
    if (submitBtn) submitBtn.textContent = 'Присоединиться к семье';
    const roleInp = document.getElementById('auth-invite-role-input');
    if (roleInp && !roleInp.value.trim()) {
      selectAuthInviteRole('Папа');
    }
  }
}

export function toggleAuthPasswordVisibility() {
  const inp = document.getElementById('auth-pass-input');
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function showAuthError(msg) {
  const errBox = document.getElementById('auth-error-box');
  if (!errBox) return;
  errBox.textContent = msg;
  errBox.classList.remove('hidden');
}

async function fetchAccountByLogin(loginCandidates) {
  const localAccounts = readLocalAccounts();
  let remoteReachable = false;

  if (navigator.onLine) {
    await ensureFirebaseReady();
    if (db && fbFirestoreSdk && firebaseUser) {
      remoteReachable = true;
      for (const candidate of loginCandidates) {
        try {
          const [primarySnap, legacySnap] = await Promise.all([
            fbFirestoreSdk.getDoc(fbFirestoreSdk.doc(db, ...FIREBASE_COLLECTION_PATH, candidate)),
            fbFirestoreSdk.getDoc(fbFirestoreSdk.doc(db, ...LEGACY_FIREBASE_COLLECTION_PATH, candidate)).catch(() => null)
          ]);

          const primaryData = primarySnap.exists() ? primarySnap.data() : null;
          const legacyData = legacySnap && legacySnap.exists() ? legacySnap.data() : null;

          if (primaryData || legacyData) {
            const combined = combineCloudAccountDocs(primaryData, legacyData);
            return { accountData: combined, resolvedLogin: candidate, source: 'cloud', remoteReachable };
          }
        } catch (err) {
          console.warn('Firestore account lookup error:', err);
          remoteReachable = false;
        }
      }
    }
  }

  for (const candidate of loginCandidates) {
    if (localAccounts[candidate]) {
      return { accountData: localAccounts[candidate], resolvedLogin: candidate, source: 'local', remoteReachable };
    }
    if (store.inMemoryAccountsCache.has(candidate)) {
      return { accountData: store.inMemoryAccountsCache.get(candidate), resolvedLogin: candidate, source: 'memory', remoteReachable };
    }
  }

  return { accountData: null, resolvedLogin: loginCandidates[0], source: 'none', remoteReachable };
}

export async function handleAuthSubmit(e) {
  if (e) e.preventDefault();
  const errBox = document.getElementById('auth-error-box');
  if (errBox) errBox.classList.add('hidden');

  const submitBtn = document.getElementById('auth-submit-btn');
  const prevBtnText = submitBtn ? submitBtn.textContent : '';

  // Вход второго родителя / няни по одноразовому коду-приглашению
  if (store.authMode === 'invite') {
    const rawCode = String(document.getElementById('auth-invite-code')?.value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    const rawRole = String(document.getElementById('auth-invite-role-input')?.value || '').trim() || 'Папа';
    const cleanRole = rawRole.slice(0, 32);

    if (rawCode.length < 6) {
      showAuthError('Введите 6-значный код приглашения.');
      return;
    }
    if (!navigator.onLine) {
      showAuthError('Для входа по коду-приглашению нужен доступ к интернету.');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Проверяем код...';
    }

    try {
      const user = await ensureFirebaseReady();
      if (!user || !db || !fbFirestoreSdk) {
        showAuthError('Не удалось подключиться к облачной базе. Проверьте интернет и попробуйте снова.');
        return;
      }

      const inviteRef = fbFirestoreSdk.doc(db, ...FIREBASE_INVITES_COLLECTION_PATH, rawCode);
      const inviteSnap = await fbFirestoreSdk.getDoc(inviteRef);
      if (!inviteSnap.exists()) {
        showAuthError('Код не найден. Проверьте символы или попросите создать новый код.');
        return;
      }

      const invite = inviteSnap.data() || {};
      const now = Date.now();
      const access = evaluateInviteAccess(invite, now);
      if (!access.valid) {
        showAuthError(access.reason);
        return;
      }

      const targetLogin = normalizeLogin(invite.targetLogin || '');
      if (!targetLogin) {
        showAuthError('Некорректный код приглашения.');
        return;
      }

      const { accountData, resolvedLogin } = await fetchAccountByLogin([targetLogin]);
      if (!accountData) {
        showAuthError('Семейный аккаунт не найден в облаке.');
        return;
      }

      const nextUseCount = (Number(invite.useCount) || 0) + 1;
      const inviteUpdate = access.multiUse
        ? {
            useCount: nextUseCount,
            lastUsedAt: now,
            lastUsedBy: cleanRole,
            updatedAt: now
          }
        : {
            used: true,
            usedAt: now,
            lastUsedAt: now,
            usedBy: cleanRole,
            lastUsedBy: cleanRole,
            useCount: nextUseCount,
            updatedAt: now
          };

      await fbFirestoreSdk.setDoc(inviteRef, inviteUpdate, { merge: true }).catch(() => {});

      const mergedState = mergeStateWithDefaults(accountData.state);
      const members = Array.isArray(mergedState.familyMembers) ? [...mergedState.familyMembers] : [];
      if (invite.createdBy && !members.includes(invite.createdBy)) members.push(invite.createdBy);
      if (!members.includes(cleanRole)) members.push(cleanRole);
      mergedState.familyMembers = members;
      if (Array.isArray(mergedState.familyInvites)) {
        mergedState.familyInvites = mergedState.familyInvites.map(item => (
          item && item.code === rawCode
            ? {
                ...item,
                useCount: nextUseCount,
                used: access.multiUse ? item.used : true,
                lastUsedAt: now,
                lastUsedBy: cleanRole,
                updatedAt: now
              }
            : item
        ));
      }

      store.currentAccountLogin = resolvedLogin;
      // Не храним чужой passHash — saveAppState() никогда не затирает passHash пустой строкой
      store.currentAccountPassHash = '';
      store.currentAccountCreatedAt = accountData.createdAt || mergedState.accountCreatedAt || null;
      store.appState = mergedState;

      writeCaregiverName(resolvedLogin, cleanRole);
      writeLocalSession(resolvedLogin);
      writeLocalAccount(resolvedLogin, '', store.appState, {
        createdAt: store.currentAccountCreatedAt || undefined
      });
      await saveAppState();
      subscribeAccountRealtime(resolvedLogin);
      hooks.enterMainApp();
      showToast(`Вы присоединились к журналу (${cleanRole})`);
    } catch (err) {
      console.warn('Invite redeem error:', err);
      showAuthError('Не удалось активировать код. Попробуйте ещё раз.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevBtnText;
      }
    }
    return;
  }

  const loginRaw = document.getElementById('auth-login-input')?.value || '';
  const passRaw = document.getElementById('auth-pass-input')?.value || '';
  const login = normalizeLogin(loginRaw);

  if (login.length < 3) {
    showAuthError('Логин должен содержать минимум 3 символа.');
    return;
  }
  if (passRaw.length < 4) {
    showAuthError('Пароль должен содержать минимум 4 символа.');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Подождите...';
  }

  try {
    const passHash = await hashPassword(passRaw);
    const localAccounts = readLocalAccounts();

    if (store.authMode === 'register') {
      const confirmPass = document.getElementById('auth-pass-confirm')?.value || '';
      const babyName = (document.getElementById('auth-baby-name')?.value || '').trim();
      const babyDob = document.getElementById('auth-baby-dob')?.value || getTodayIso();

      if (passRaw !== confirmPass) {
        showAuthError('Пароли не совпадают.');
        return;
      }
      if (!babyName) {
        showAuthError('Укажите имя малыша.');
        return;
      }

      let remoteExists = false;
      if (navigator.onLine) {
        await ensureFirebaseReady();
        if (db && fbFirestoreSdk && firebaseUser) {
          try {
            const [snap, legacySnap] = await Promise.all([
              fbFirestoreSdk.getDoc(fbFirestoreSdk.doc(db, ...FIREBASE_COLLECTION_PATH, login)),
              fbFirestoreSdk.getDoc(fbFirestoreSdk.doc(db, ...LEGACY_FIREBASE_COLLECTION_PATH, login)).catch(() => null)
            ]);
            if (snap.exists() || (legacySnap && legacySnap.exists())) remoteExists = true;
          } catch (_) {}
        }
      }

      if (remoteExists || localAccounts[login]) {
        showAuthError('Такой логин уже занят. Выберите другой логин или переключитесь на «Войти».');
        return;
      }

      const createdNow = Date.now();
      const freshState = createDefaultState(babyName, babyDob);
      freshState.accountCreatedAt = createdNow;
      freshState.familyMembers = ['Мама'];
      const curWeek = calculateBabyAge(babyDob).weeks;
      freshState.selectedWeek = curWeek;
      freshState.weekRangeStart = curWeek <= 16 ? 1 : curWeek <= 52 ? 17 : curWeek <= 104 ? 53 : curWeek <= 156 ? 105 : 157;
      freshState.weekRangeEnd = freshState.weekRangeStart === 1 ? 16 : freshState.weekRangeStart === 17 ? 52 : freshState.weekRangeStart === 53 ? 104 : freshState.weekRangeStart === 105 ? 156 : 260;

      store.currentAccountLogin = login;
      store.currentAccountPassHash = passHash;
      store.currentAccountCreatedAt = createdNow;
      store.appState = freshState;
      writeCaregiverName(login, 'Мама');
      writeLocalSession(login);
      await saveAppState();
      subscribeAccountRealtime(login);
      hooks.enterMainApp();
      showToast(`Добро пожаловать, ${babyName}!`);
    } else {
      // Кандидаты логина: основной (без @) и старый вариант (если ранее @ заменялось на _)
      const legacyLogin = String(loginRaw || '').trim().toLowerCase().replace(/[^a-z0-9а-яё._-]/gi, '_');
      const loginCandidates = legacyLogin && legacyLogin !== login ? [login, legacyLogin] : [login];

      const { accountData, resolvedLogin, remoteReachable } = await fetchAccountByLogin(loginCandidates);

      if (!accountData) {
        if (navigator.onLine && !remoteReachable) {
          showAuthError('Не удалось подключиться к облачной базе. Проверьте интернет и попробуйте ещё раз.');
        } else {
          showAuthError('Аккаунт с таким логином не найден.');
        }
        return;
      }

      const storedHash = accountData.passHash || accountData.passwordHash || '';
      let isPasswordValid = await verifyPasswordHash(storedHash, passRaw, passHash);
      if (!isPasswordValid && accountData.legacyAltPassHash) {
        isPasswordValid = await verifyPasswordHash(accountData.legacyAltPassHash, passRaw, passHash);
      }
      if (!isPasswordValid) {
        showAuthError('Неверный пароль.');
        return;
      }

      // Если у аккаунта был старый fnv_-хэш, прозрачно обновляем его до SHA-256
      const effectivePassHash = (storedHash && !storedHash.startsWith('fnv_'))
        ? storedHash
        : passHash;

      store.currentAccountLogin = resolvedLogin;
      store.currentAccountPassHash = effectivePassHash;
      store.currentAccountCreatedAt = accountData.createdAt || accountData.state?.accountCreatedAt || null;
      store.appState = mergeStateWithDefaults(accountData.state);
      writeLocalSession(resolvedLogin);
      writeLocalAccount(resolvedLogin, effectivePassHash, store.appState, {
        createdAt: store.currentAccountCreatedAt || undefined,
        passwordChangedAt: accountData.passwordChangedAt || undefined
      });

      const needsShaUpgrade = Boolean(accountData.passHash && accountData.passHash.startsWith('fnv_'));
      if (needsShaUpgrade || accountData.needsPrimaryMigration) {
        await saveAppState();
      }

      subscribeAccountRealtime(resolvedLogin);
      hooks.enterMainApp();
      showToast(`С возвращением, @${resolvedLogin}!`);
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevBtnText;
    }
  }
}

export function logoutAccount() {
  if (unsubAccountSnapshot) {
    try { unsubAccountSnapshot(); } catch (_) {}
    unsubAccountSnapshot = null;
  }
  subscribedLogin = null;
  queuedSaveNeeded = false;
  activeSavePromise = null;
  const previousLogin = store.currentAccountLogin || '';
  store.currentAccountLogin = null;
  store.currentAccountPassHash = null;
  store.currentAccountCreatedAt = null;
  store.pendingSyncState = false;
  store.initialCloudSyncDone = true;
  writeLocalSession(null);
  closeModal('modal-profile');

  // При выходе сразу переключаем форму на «Войти по логину» и очищаем поля пароля
  switchAuthMode('login');
  const loginInp = document.getElementById('auth-login-input');
  const passInp = document.getElementById('auth-pass-input');
  const confirmInp = document.getElementById('auth-pass-confirm');
  if (loginInp && previousLogin) loginInp.value = previousLogin;
  if (passInp) passInp.value = '';
  if (confirmInp) confirmInp.value = '';

  const gate = document.getElementById('auth-gate-screen');
  if (gate) gate.classList.remove('hidden');
  hooks.renderPwaInstallUI();
  showToast('Вы вышли из аккаунта');
}
