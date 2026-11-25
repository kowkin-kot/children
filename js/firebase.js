// Синхронизация с Firebase Firestore и авторизация по логину и паролю

import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore,
  doc as fsDoc,
  getDoc as fsGetDoc,
  setDoc as fsSetDoc,
  onSnapshot as fsOnSnapshot
} from 'firebase/firestore';
import {
  firebaseConfig,
  appId,
  FIREBASE_COLLECTION_PATH,
  LEGACY_FIREBASE_COLLECTION_PATH
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

let app = null;
let auth = null;
let db = null;
let firebaseUser = null;
let unsubAccountSnapshot = null;
let activeInitPromise = null;

// Надёжная инициализация Firebase с использованием локального SDK и повторным подключением при сбое
export function ensureFirebaseReady() {
  if (db && firebaseUser) {
    return Promise.resolve(firebaseUser);
  }
  if (activeInitPromise) {
    return activeInitPromise;
  }

  activeInitPromise = (async () => {
    try {
      if (!app) {
        const existingApps = getApps();
        app = existingApps.length > 0 ? existingApps[0] : initializeApp(firebaseConfig);
      }
      if (!auth) auth = getAuth(app);
      if (!db) db = getFirestore(app);

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
        const cred = await signInAnonymously(auth);
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
        const unsub = onAuthStateChanged(auth, (user) => {
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
      if (!db || !firebaseUser) {
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

export async function saveAppState() {
  if (!store.currentAccountLogin) return;
  const localExisting = readLocalAccounts()[store.currentAccountLogin];
  const resolvedCreatedAt = store.currentAccountCreatedAt
    || localExisting?.createdAt
    || store.appState?.accountCreatedAt
    || null;
  if (resolvedCreatedAt && !store.currentAccountCreatedAt) {
    store.currentAccountCreatedAt = resolvedCreatedAt;
  }

  writeLocalAccount(store.currentAccountLogin, store.currentAccountPassHash, store.appState, {
    createdAt: resolvedCreatedAt || undefined
  });
  store.inMemoryAccountsCache.set(store.currentAccountLogin, {
    login: store.currentAccountLogin,
    passHash: store.currentAccountPassHash,
    state: store.appState,
    createdAt: resolvedCreatedAt || Date.now(),
    updatedAt: Date.now()
  });

  if (!navigator.onLine) {
    store.pendingSyncState = true;
    hooks.updateNetworkStatusUI();
    return;
  }

  try {
    await ensureFirebaseReady();
    if (!db || !fsDoc || !fsSetDoc || !firebaseUser) {
      store.pendingSyncState = true;
      hooks.updateNetworkStatusUI();
      return;
    }
    const accRef = fsDoc(db, 'artifacts', appId, 'public', 'data', 'malysh_accounts', store.currentAccountLogin);
    const payload = {
      login: store.currentAccountLogin,
      state: sanitizeForFirestore(store.appState),
      updatedAt: Date.now()
    };
    if (resolvedCreatedAt) {
      payload.createdAt = resolvedCreatedAt;
    }
    // Никогда не затираем существующий passHash пустой строкой
    if (store.currentAccountPassHash) {
      payload.passHash = store.currentAccountPassHash;
    }
    await fsSetDoc(accRef, payload, { merge: true });
    store.pendingSyncState = false;
    hooks.updateNetworkStatusUI();
  } catch (e) {
    console.warn('Firestore save queued offline:', e);
    store.pendingSyncState = true;
    hooks.updateNetworkStatusUI();
  }
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
  if (unsubAccountSnapshot) {
    try { unsubAccountSnapshot(); } catch (_) {}
    unsubAccountSnapshot = null;
  }
  if (!db || !fsDoc || !fsOnSnapshot) return;
  try {
    const accRef = fsDoc(db, ...FIREBASE_COLLECTION_PATH, login);
    unsubAccountSnapshot = fsOnSnapshot(accRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data && data.passHash) {
        store.currentAccountPassHash = data.passHash;
      }
      if (data && data.createdAt && !store.currentAccountCreatedAt) {
        store.currentAccountCreatedAt = data.createdAt;
      }
      if (data && data.state && !store.pendingSyncState) {
        const incomingCount = getStateRecordCount(data.state);
        const currentCount = getStateRecordCount(store.appState);
        // Защита от затирания: если в malysh_accounts пришёл пустой документ,
        // а у пользователя уже загружены записи (например, из legacy-коллекции accounts),
        // не перезаписываем их пустотой, а отправляем актуальные данные в облако.
        if (incomingCount === 0 && currentCount > 0) {
          saveAppState();
          return;
        }
        store.isRemoteSyncApplying = true;
        store.appState = mergeStateWithDefaults(data.state);
        writeLocalAccount(login, data.passHash || store.currentAccountPassHash, store.appState, {
          createdAt: data.createdAt || store.currentAccountCreatedAt || undefined,
          passwordChangedAt: data.passwordChangedAt || undefined
        });
        hooks.renderAll();
        store.isRemoteSyncApplying = false;
      }
    }, (err) => {
      console.warn('Realtime sync listener warning:', err);
    });
  } catch (_) {}
}

export async function syncSavedSessionFromCloud(savedLogin) {
  const user = await ensureFirebaseReady();
  if (!user || !db || !fsDoc || !fsGetDoc) return;
  try {
    const [primarySnap, legacySnap] = await Promise.all([
      fsGetDoc(fsDoc(db, ...FIREBASE_COLLECTION_PATH, savedLogin)),
      fsGetDoc(fsDoc(db, ...LEGACY_FIREBASE_COLLECTION_PATH, savedLogin)).catch(() => null)
    ]);

    const primaryData = primarySnap.exists() ? primarySnap.data() : null;
    const legacyData = legacySnap && legacySnap.exists() ? legacySnap.data() : null;
    const combined = combineCloudAccountDocs(primaryData, legacyData);

    if (combined && !store.pendingSyncState) {
      if (combined.passHash) {
        store.currentAccountPassHash = combined.passHash;
      }
      if (combined.createdAt) {
        store.currentAccountCreatedAt = combined.createdAt;
      }
      if (combined.state) {
        const localCount = getStateRecordCount(store.appState);
        const cloudCount = getStateRecordCount(combined.state);
        // Если локально есть несинхронизированные записи, объединяем их с облаком
        if (localCount > 0 && cloudCount > 0) {
          store.appState = mergeAccountStates([combined.state, store.appState]).state;
        } else if (cloudCount >= localCount) {
          store.appState = combined.state;
        }
        writeLocalAccount(savedLogin, combined.passHash || store.currentAccountPassHash, store.appState, {
          createdAt: combined.createdAt || store.currentAccountCreatedAt || undefined,
          passwordChangedAt: combined.passwordChangedAt || undefined
        });
        hooks.renderAll();
        if (combined.needsPrimaryMigration) {
          await saveAppState();
        }
      }
    }
    subscribeAccountRealtime(savedLogin);
  } catch (_) {}
}

export function switchAuthMode(mode) {
  store.authMode = mode === 'login' ? 'login' : 'register';
  const tabReg = document.getElementById('auth-tab-register');
  const tabLog = document.getElementById('auth-tab-login');
  const regFields = document.getElementById('auth-register-fields');
  const submitBtn = document.getElementById('auth-submit-btn');
  const loginLabel = document.getElementById('auth-login-label');
  const passLabel = document.getElementById('auth-pass-label');
  const errBox = document.getElementById('auth-error-box');

  if (errBox) errBox.classList.add('hidden');

  if (store.authMode === 'register') {
    if (tabReg) tabReg.className = 'py-2 px-3 rounded-xl text-xs sm:text-sm font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs transition';
    if (tabLog) tabLog.className = 'py-2 px-3 rounded-xl text-xs sm:text-sm font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition';
    if (regFields) regFields.classList.remove('hidden');
    if (submitBtn) submitBtn.textContent = 'Создать аккаунт и войти';
    if (loginLabel) loginLabel.innerHTML = 'Придумайте логин <span class="text-slate-400 font-normal">(мин. 3 символа)</span>';
    if (passLabel) passLabel.innerHTML = 'Пароль <span class="text-slate-400 font-normal">(мин. 4 символа)</span>';
  } else {
    if (tabLog) tabLog.className = 'py-2 px-3 rounded-xl text-xs sm:text-sm font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs transition';
    if (tabReg) tabReg.className = 'py-2 px-3 rounded-xl text-xs sm:text-sm font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition';
    if (regFields) regFields.classList.add('hidden');
    if (submitBtn) submitBtn.textContent = 'Войти в аккаунт';
    if (loginLabel) loginLabel.textContent = 'Логин';
    if (passLabel) passLabel.textContent = 'Пароль';
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
    if (db && firebaseUser) {
      remoteReachable = true;
      for (const candidate of loginCandidates) {
        try {
          const [primarySnap, legacySnap] = await Promise.all([
            fsGetDoc(fsDoc(db, ...FIREBASE_COLLECTION_PATH, candidate)),
            fsGetDoc(fsDoc(db, ...LEGACY_FIREBASE_COLLECTION_PATH, candidate)).catch(() => null)
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

  const submitBtn = document.getElementById('auth-submit-btn');
  const prevBtnText = submitBtn ? submitBtn.textContent : '';
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
        if (db && firebaseUser) {
          try {
            const [snap, legacySnap] = await Promise.all([
              fsGetDoc(fsDoc(db, 'artifacts', appId, 'public', 'data', 'malysh_accounts', login)),
              fsGetDoc(fsDoc(db, 'artifacts', appId, 'public', 'data', 'accounts', login)).catch(() => null)
            ]);
            if (snap.exists() || (legacySnap && legacySnap.exists())) remoteExists = true;
          } catch (_) {}
        }
      }

      if (remoteExists || localAccounts[login]) {
        showAuthError('Такой логин уже занят. Выберите другой логин или переключитесь на «Войти по логину».');
        return;
      }

      const createdNow = Date.now();
      const freshState = createDefaultState(babyName, babyDob);
      freshState.accountCreatedAt = createdNow;
      const curWeek = calculateBabyAge(babyDob).weeks;
      freshState.selectedWeek = curWeek;
      freshState.weekRangeStart = curWeek <= 16 ? 1 : curWeek <= 52 ? 17 : curWeek <= 104 ? 53 : curWeek <= 156 ? 105 : 157;
      freshState.weekRangeEnd = freshState.weekRangeStart === 1 ? 16 : freshState.weekRangeStart === 17 ? 52 : freshState.weekRangeStart === 53 ? 104 : freshState.weekRangeStart === 105 ? 156 : 260;

      store.currentAccountLogin = login;
      store.currentAccountPassHash = passHash;
      store.currentAccountCreatedAt = createdNow;
      store.appState = freshState;
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
  const previousLogin = store.currentAccountLogin || '';
  store.currentAccountLogin = null;
  store.currentAccountPassHash = null;
  store.currentAccountCreatedAt = null;
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
