// Синхронизация с Firebase Firestore и авторизация по логину и паролю

import { firebaseConfig, appId } from './config.js';
import {
  store,
  hooks,
  createDefaultState,
  mergeStateWithDefaults,
  readLocalAccounts,
  writeLocalAccount,
  writeLocalSession,
  calculateBabyAge
} from './state.js';
import { hashPassword, normalizeLogin, getTodayIso, closeModal, showToast } from './utils.js';

let app = null;
let auth = null;
let db = null;
let fsDoc = null;
let fsGetDoc = null;
let fsSetDoc = null;
let fsOnSnapshot = null;
let firebaseUser = null;
let unsubAccountSnapshot = null;

export const firebaseReadyPromise = (async () => {
  try {
    const sdkLoad = Promise.all([
      import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js")
    ]);
    const timeoutSdk = new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase SDK timeout')), 4500));
    const [appMod, authMod, fsMod] = await Promise.race([sdkLoad, timeoutSdk]);

    fsDoc = fsMod.doc;
    fsGetDoc = fsMod.getDoc;
    fsSetDoc = fsMod.setDoc;
    fsOnSnapshot = fsMod.onSnapshot;

    app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    db = fsMod.getFirestore(app);

    await authMod.signInAnonymously(auth).catch((e) => {
      console.warn('Anonymous sign-in warning:', e);
    });

    return await new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve(auth.currentUser || null), 3500);
      const unsub = authMod.onAuthStateChanged(auth, (user) => {
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
  }
})();

export async function saveAppState() {
  if (!store.currentAccountLogin) return;
  writeLocalAccount(store.currentAccountLogin, store.currentAccountPassHash, store.appState);
  store.inMemoryAccountsCache.set(store.currentAccountLogin, {
    passHash: store.currentAccountPassHash,
    state: store.appState
  });

  if (!navigator.onLine || !db || !fsDoc || !fsSetDoc) {
    store.pendingSyncState = true;
    hooks.updateNetworkStatusUI();
    return;
  }

  try {
    await firebaseReadyPromise;
    if (!db || !firebaseUser) {
      store.pendingSyncState = true;
      hooks.updateNetworkStatusUI();
      return;
    }
    const accRef = fsDoc(db, 'artifacts', appId, 'public', 'data', 'malysh_accounts', store.currentAccountLogin);
    await fsSetDoc(accRef, {
      login: store.currentAccountLogin,
      passHash: store.currentAccountPassHash,
      state: store.appState,
      updatedAt: Date.now()
    }, { merge: true });
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

export function subscribeAccountRealtime(login) {
  if (unsubAccountSnapshot) {
    try { unsubAccountSnapshot(); } catch (_) {}
    unsubAccountSnapshot = null;
  }
  if (!db || !fsDoc || !fsOnSnapshot) return;
  try {
    const accRef = fsDoc(db, 'artifacts', appId, 'public', 'data', 'malysh_accounts', login);
    unsubAccountSnapshot = fsOnSnapshot(accRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data && data.state && !store.pendingSyncState) {
        store.isRemoteSyncApplying = true;
        store.appState = mergeStateWithDefaults(data.state);
        writeLocalAccount(login, data.passHash || store.currentAccountPassHash, store.appState);
        hooks.renderAll();
        store.isRemoteSyncApplying = false;
      }
    }, (err) => {
      console.warn('Realtime sync listener warning:', err);
    });
  } catch (_) {}
}

export async function syncSavedSessionFromCloud(savedLogin) {
  const user = await firebaseReadyPromise;
  if (!user || !db || !fsDoc || !fsGetDoc) return;
  try {
    const snap = await fsGetDoc(fsDoc(db, 'artifacts', appId, 'public', 'data', 'malysh_accounts', savedLogin));
    if (snap.exists() && !store.pendingSyncState) {
      const data = snap.data();
      if (data && data.state) {
        store.appState = mergeStateWithDefaults(data.state);
        writeLocalAccount(savedLogin, data.passHash || store.currentAccountPassHash, store.appState);
        hooks.renderAll();
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
        await firebaseReadyPromise;
        if (db && fsDoc && fsGetDoc && firebaseUser) {
          try {
            const snap = await fsGetDoc(fsDoc(db, 'artifacts', appId, 'public', 'data', 'malysh_accounts', login));
            if (snap.exists()) remoteExists = true;
          } catch (_) {}
        }
      }

      if (remoteExists || localAccounts[login]) {
        showAuthError('Такой логин уже занят. Выберите другой логин или войдите.');
        return;
      }

      const freshState = createDefaultState(babyName, babyDob);
      const curWeek = calculateBabyAge(babyDob).weeks;
      freshState.selectedWeek = curWeek;
      freshState.weekRangeStart = curWeek <= 16 ? 1 : curWeek <= 52 ? 17 : curWeek <= 104 ? 53 : curWeek <= 156 ? 105 : 157;
      freshState.weekRangeEnd = freshState.weekRangeStart === 1 ? 16 : freshState.weekRangeStart === 17 ? 52 : freshState.weekRangeStart === 53 ? 104 : freshState.weekRangeStart === 105 ? 156 : 260;

      store.currentAccountLogin = login;
      store.currentAccountPassHash = passHash;
      store.appState = freshState;
      writeLocalSession(login);
      await saveAppState();
      subscribeAccountRealtime(login);
      hooks.enterMainApp();
      showToast(`Добро пожаловать, ${babyName}!`);
    } else {
      let accountData = null;
      if (navigator.onLine) {
        await firebaseReadyPromise;
        if (db && fsDoc && fsGetDoc && firebaseUser) {
          try {
            const snap = await fsGetDoc(fsDoc(db, 'artifacts', appId, 'public', 'data', 'malysh_accounts', login));
            if (snap.exists()) accountData = snap.data();
          } catch (_) {}
        }
      }
      if (!accountData && localAccounts[login]) {
        accountData = localAccounts[login];
      }
      if (!accountData && store.inMemoryAccountsCache.has(login)) {
        accountData = store.inMemoryAccountsCache.get(login);
      }

      if (!accountData) {
        showAuthError('Аккаунт с таким логином не найден.');
        return;
      }
      if (accountData.passHash && accountData.passHash !== passHash) {
        showAuthError('Неверный пароль.');
        return;
      }

      store.currentAccountLogin = login;
      store.currentAccountPassHash = passHash;
      store.appState = mergeStateWithDefaults(accountData.state);
      writeLocalSession(login);
      writeLocalAccount(login, passHash, store.appState);
      subscribeAccountRealtime(login);
      hooks.enterMainApp();
      showToast(`С возвращением, @${login}!`);
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
  store.currentAccountLogin = null;
  store.currentAccountPassHash = null;
  writeLocalSession(null);
  closeModal('modal-profile');
  const gate = document.getElementById('auth-gate-screen');
  if (gate) gate.classList.remove('hidden');
  hooks.renderPwaInstallUI();
  showToast('Вы вышли из аккаунта');
}
