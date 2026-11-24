// Главная точка входа: связывание модулей, навигация по вкладкам, регистрация обработчиков и запуск приложения

import {
  store,
  hooks,
  mergeStateWithDefaults,
  readLocalAccounts,
  readLocalSession
} from './state.js';
import { getTodayIso, bindRuDateInputs, closeModal } from './utils.js';
import {
  setupPwaManifestAndIcons,
  downloadAppIconPng,
  warmOfflineCache,
  updateNetworkStatusUI,
  showNetworkStatusToast,
  renderPwaInstallUI,
  triggerPwaInstall,
  dismissPwaBanner,
  initPwaListeners
} from './pwa.js';
import {
  flushPendingSync,
  syncSavedSessionFromCloud,
  switchAuthMode,
  handleAuthSubmit,
  toggleAuthPasswordVisibility,
  logoutAccount
} from './firebase.js';
import {
  renderHeaderBabyInfo,
  toggleSleepDebtDetails,
  renderHereAndNowWidget,
  evaluateSmartNotifications,
  handleSmartNotifAction,
  snoozeSmartNotif,
  openNotificationsModal,
  toggleNotifSetting,
  requestBrowserPushPermission,
  clearNotifHistory,
  applyThemeMode,
  setThemeMode,
  cycleThemeMode,
  openProfileModal,
  selectProfileGender,
  saveProfileSettings
} from './ui-shell.js';
import {
  filterWeekRange,
  jumpToWeekNumber,
  jumpToCurrentBabyWeek,
  selectWeek,
  toggleMilestone,
  renderDevelopmentTab
} from './tabs/development.js';
import {
  setFeedingSubtype,
  setSolidsCategory,
  pickSolidsQuickProduct,
  saveSolidsFeedingNow,
  toggleActiveSleepType,
  toggleTimer,
  addQuickCareLog,
  openManualLogModal,
  openEditJournalLogModal,
  onManualLogTypeChange,
  onManualLogLiveToggle,
  syncManualLogEndFromStartOrDuration,
  syncManualLogDurationFromEnd,
  saveManualLog,
  deleteJournalLog,
  shiftJournalDate,
  resetJournalDateToToday,
  setRhythmDays,
  updateLiveTimersClock,
  renderJournalTab
} from './tabs/journal.js';
import {
  renderTeethChart,
  openToothModal,
  toggleTempToothSymptom,
  saveToothRecord,
  setVaccineFilter,
  renderVaccinesList,
  openVaccineModal,
  saveVaccineRecord
} from './tabs/health.js';
import {
  setGrowthMetric,
  addGrowthRecord,
  deleteGrowthRecord,
  renderGrowthTab
} from './tabs/growth.js';
import { renderSymptoms } from './tabs/symptoms.js';
import { addDiaryEntry, deleteDiaryEntry, renderDiaryTab } from './tabs/diary.js';

function switchTab(tabName) {
  store.activeTab = tabName;
  document.querySelectorAll('.tab-section').forEach(sec => {
    sec.classList.toggle('hidden', sec.id !== `tab-${tabName}`);
  });

  document.querySelectorAll('.desktop-nav-btn').forEach(btn => {
    const isCurrent = btn.getAttribute('data-tab') === tabName;
    btn.className = isCurrent
      ? 'desktop-nav-btn px-3 py-1.5 rounded-xl text-xs font-bold bg-white dark:bg-slate-800 text-rose-500 shadow-2xs transition'
      : 'desktop-nav-btn px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition';
  });

  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    const isCurrent = btn.getAttribute('data-tab') === tabName;
    btn.className = isCurrent
      ? 'mobile-nav-btn min-h-[60px] min-w-[60px] flex-1 shrink-0 flex flex-col items-center justify-center px-2 py-2 rounded-2xl text-[11px] leading-tight font-extrabold bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 transition'
      : 'mobile-nav-btn min-h-[60px] min-w-[60px] flex-1 shrink-0 flex flex-col items-center justify-center px-2 py-2 rounded-2xl text-[11px] leading-tight font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition';
  });

  if (tabName === 'development') renderDevelopmentTab();
  if (tabName === 'journal') renderJournalTab();
  if (tabName === 'health') {
    renderTeethChart();
    renderVaccinesList();
  }
  if (tabName === 'growth') renderGrowthTab();
  if (tabName === 'symptoms') renderSymptoms();
  if (tabName === 'diary') renderDiaryTab();
}

function renderAll() {
  renderHeaderBabyInfo();
  renderHereAndNowWidget();
  evaluateSmartNotifications();
  switchTab(store.activeTab);
}

function enterMainApp() {
  const gate = document.getElementById('auth-gate-screen');
  if (gate) gate.classList.add('hidden');
  applyThemeMode(store.appState.themeMode || 'auto');
  renderPwaInstallUI();
  renderAll();
}

// Привязываем кросс-модульные хуки
Object.assign(hooks, {
  renderAll,
  renderHereAndNowWidget,
  evaluateSmartNotifications,
  updateNetworkStatusUI,
  renderPwaInstallUI,
  applyThemeMode,
  switchTab,
  toggleTimer,
  flushPendingSync,
  enterMainApp
});

// Регистрируем обработчики для inline-атрибутов HTML
Object.assign(window, {
  switchAuthMode,
  handleAuthSubmit,
  toggleAuthPasswordVisibility,
  switchTab,
  showNetworkStatusToast,
  openNotificationsModal,
  cycleThemeMode,
  openProfileModal,
  filterWeekRange,
  jumpToWeekNumber,
  jumpToCurrentBabyWeek,
  selectWeek,
  toggleMilestone,
  setFeedingSubtype,
  setSolidsCategory,
  pickSolidsQuickProduct,
  saveSolidsFeedingNow,
  toggleActiveSleepType,
  toggleTimer,
  addQuickCareLog,
  openManualLogModal,
  openEditJournalLogModal,
  onManualLogTypeChange,
  onManualLogLiveToggle,
  syncManualLogEndFromStartOrDuration,
  syncManualLogDurationFromEnd,
  saveManualLog,
  deleteJournalLog,
  shiftJournalDate,
  resetJournalDateToToday,
  setRhythmDays,
  setVaccineFilter,
  openToothModal,
  toggleTempToothSymptom,
  saveToothRecord,
  openVaccineModal,
  saveVaccineRecord,
  setGrowthMetric,
  addGrowthRecord,
  deleteGrowthRecord,
  renderSymptoms,
  addDiaryEntry,
  deleteDiaryEntry,
  closeModal,
  saveProfileSettings,
  selectProfileGender,
  setThemeMode,
  triggerPwaInstall,
  dismissPwaBanner,
  downloadAppIconPng,
  logoutAccount,
  toggleNotifSetting,
  requestBrowserPushPermission,
  clearNotifHistory,
  handleSmartNotifAction,
  snoozeSmartNotif,
  toggleSleepDebtDetails
});

async function initApp() {
  const todayIso = getTodayIso();
  const authDob = document.getElementById('auth-baby-dob');
  const growthDate = document.getElementById('growth-date-input');
  const diaryDate = document.getElementById('diary-date-input');
  if (authDob && !authDob.value) authDob.value = todayIso;
  if (growthDate && !growthDate.value) growthDate.value = todayIso;
  if (diaryDate && !diaryDate.value) diaryDate.value = todayIso;

  bindRuDateInputs();
  initPwaListeners();
  setupPwaManifestAndIcons();
  warmOfflineCache();
  updateNetworkStatusUI();
  applyThemeMode('auto');

  const savedLogin = readLocalSession();
  const localAccounts = readLocalAccounts();
  if (savedLogin && localAccounts[savedLogin]) {
    store.currentAccountLogin = savedLogin;
    store.currentAccountPassHash = localAccounts[savedLogin].passHash || '';
    store.appState = mergeStateWithDefaults(localAccounts[savedLogin].state);
    enterMainApp();
    syncSavedSessionFromCloud(savedLogin);
  } else if (Object.keys(localAccounts).length > 0) {
    switchAuthMode('login');
  }

  setInterval(() => {
    if (!store.currentAccountLogin) return;
    updateLiveTimersClock();
  }, 1000);

  setInterval(() => {
    if (!store.currentAccountLogin) return;
    renderHereAndNowWidget();
    evaluateSmartNotifications();
  }, 30000);
}

initApp();
