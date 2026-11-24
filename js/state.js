// Состояние приложения, работа с localStorage, расчёт возраста и возрастных норм сна/кормлений

import { LOCAL_ACCOUNTS_KEY, LOCAL_SESSION_KEY } from './config.js';
import { getTodayIso } from './utils.js';

export function createDefaultState(babyName = '', babyDob = '') {
  return {
    babyName: babyName || 'Малыш',
    babyDob: babyDob || getTodayIso(),
    babyGender: 'girl',
    themeMode: 'auto',
    selectedWeek: 1,
    weekRangeStart: 1,
    weekRangeEnd: 16,
    completedMilestones: {},
    timers: {
      feeding: { active: false, startTime: null, subtype: 'left' },
      sleep: { active: false, startTime: null, sleepType: 'day' },
      walk: { active: false, startTime: null }
    },
    journalLogs: [],
    rhythmDays: 7,
    teethMap: {},
    vaccinesMap: {},
    vaccineFilter: 'all',
    growthMetric: 'weight',
    growthRecords: [],
    diaryEntries: [],
    notifications: {
      feeding: true,
      sleep: true,
      diaper: true,
      sound: true,
      snoozedUntil: {},
      history: []
    }
  };
}

export function mergeStateWithDefaults(rawState) {
  const base = createDefaultState(rawState?.babyName || 'Малыш', rawState?.babyDob || getTodayIso());
  if (!rawState || typeof rawState !== 'object') return base;
  return {
    ...base,
    ...rawState,
    timers: {
      feeding: { ...base.timers.feeding, ...(rawState.timers?.feeding || {}) },
      sleep: { ...base.timers.sleep, ...(rawState.timers?.sleep || {}) },
      walk: { ...base.timers.walk, ...(rawState.timers?.walk || {}) }
    },
    notifications: {
      ...base.notifications,
      ...(rawState.notifications || {}),
      snoozedUntil: { ...(rawState.notifications?.snoozedUntil || {}) },
      history: Array.isArray(rawState.notifications?.history) ? rawState.notifications.history : []
    },
    completedMilestones: rawState.completedMilestones || {},
    journalLogs: Array.isArray(rawState.journalLogs) ? rawState.journalLogs : [],
    teethMap: rawState.teethMap || {},
    vaccinesMap: rawState.vaccinesMap || {},
    growthRecords: Array.isArray(rawState.growthRecords) ? rawState.growthRecords : [],
    diaryEntries: Array.isArray(rawState.diaryEntries) ? rawState.diaryEntries : []
  };
}

// Центральное реактивное хранилище сессии и UI-состояния
export const store = {
  appState: createDefaultState(),
  currentAccountLogin: null,
  currentAccountPassHash: null,
  authMode: 'register',
  isRemoteSyncApplying: false,
  pendingSyncState: false,
  tempGenderSelection: 'girl',
  tempToothSymptoms: [],
  activeTab: 'development',
  sleepDebtExpanded: false,
  selectedJournalDateIso: getTodayIso(),
  inMemoryAccountsCache: new Map()
};

// Реестр колбэков для связи между модулями без циклических импортов
export const hooks = {
  renderAll: () => {},
  renderHereAndNowWidget: () => {},
  evaluateSmartNotifications: () => {},
  updateNetworkStatusUI: () => {},
  renderPwaInstallUI: () => {},
  applyThemeMode: () => {},
  switchTab: () => {},
  toggleTimer: () => {},
  flushPendingSync: () => {},
  enterMainApp: () => {}
};

export function readLocalAccounts() {
  try {
    const raw = localStorage.getItem(LOCAL_ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

export function writeLocalAccount(login, passHash, stateObj) {
  try {
    const all = readLocalAccounts();
    all[login] = { passHash, state: stateObj, updatedAt: Date.now() };
    localStorage.setItem(LOCAL_ACCOUNTS_KEY, JSON.stringify(all));
  } catch (_) {}
}

export function readLocalSession() {
  try {
    return localStorage.getItem(LOCAL_SESSION_KEY) || null;
  } catch (_) {
    return null;
  }
}

export function writeLocalSession(login) {
  try {
    if (login) localStorage.setItem(LOCAL_SESSION_KEY, login);
    else localStorage.removeItem(LOCAL_SESSION_KEY);
  } catch (_) {}
}

export function calculateBabyAge(dobIso) {
  const dob = new Date(dobIso || getTodayIso());
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - dob.getTime());
  const totalDays = Math.floor(diffMs / 86400000);
  const weeks = Math.max(1, Math.min(260, Math.floor(totalDays / 7) + 1));
  const monthsFloat = totalDays / 30.4375;
  const fullMonths = Math.floor(monthsFloat);
  const years = Math.floor(fullMonths / 12);
  const remMonths = fullMonths % 12;

  let humanText = '';
  if (fullMonths < 1) {
    humanText = `${weeks} нед. (${totalDays} дн.)`;
  } else if (years < 1) {
    humanText = `${weeks} нед. • ${fullMonths} мес.`;
  } else {
    humanText = remMonths > 0 ? `${years} г. ${remMonths} мес. (${weeks} нед.)` : `${years} год(а) (${weeks} нед.)`;
  }

  return { totalDays, weeks, monthsFloat, fullMonths, humanText };
}

export function getAgeSleepAndFeedNorms() {
  const age = calculateBabyAge(store.appState.babyDob);
  const m = age.monthsFloat;
  if (m < 1) {
    return {
      feedIntervalMin: 150,
      wakeWindowMin: 50,
      shortNapThresholdMin: 35,
      napShortenMin: 15,
      dailySleepTargetMin: 16.5 * 60,
      dailySleepLabel: '16–17 ч'
    };
  }
  if (m < 3) {
    return {
      feedIntervalMin: 180,
      wakeWindowMin: 75,
      shortNapThresholdMin: 40,
      napShortenMin: 15,
      dailySleepTargetMin: 15.5 * 60,
      dailySleepLabel: '15–16 ч'
    };
  }
  if (m < 6) {
    return {
      feedIntervalMin: 210,
      wakeWindowMin: 115,
      shortNapThresholdMin: 45,
      napShortenMin: 20,
      dailySleepTargetMin: 14.5 * 60,
      dailySleepLabel: '14–15 ч'
    };
  }
  if (m < 9) {
    return {
      feedIntervalMin: 240,
      wakeWindowMin: 165,
      shortNapThresholdMin: 45,
      napShortenMin: 20,
      dailySleepTargetMin: 14 * 60,
      dailySleepLabel: '13.5–14.5 ч'
    };
  }
  if (m < 14) {
    return {
      feedIntervalMin: 240,
      wakeWindowMin: 210,
      shortNapThresholdMin: 50,
      napShortenMin: 20,
      dailySleepTargetMin: 13.5 * 60,
      dailySleepLabel: '13–14 ч'
    };
  }
  if (m < 24) {
    return {
      feedIntervalMin: 270,
      wakeWindowMin: 300,
      shortNapThresholdMin: 60,
      napShortenMin: 20,
      dailySleepTargetMin: 12.8 * 60,
      dailySleepLabel: '12–13.5 ч'
    };
  }
  return {
    feedIntervalMin: 300,
    wakeWindowMin: 390,
    shortNapThresholdMin: 60,
    napShortenMin: 20,
    dailySleepTargetMin: 11.8 * 60,
    dailySleepLabel: '11–12.5 ч'
  };
}

export function computeHereAndNowMetrics() {
  const now = Date.now();
  const appState = store.appState;
  const norms = getAgeSleepAndFeedNorms();
  const sortedLogs = [...(appState.journalLogs || [])].sort(
    (a, b) => (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0)
  );

  // 1. Последнее кормление
  let sinceFeedMin = null;
  if (appState.timers?.feeding?.active && appState.timers.feeding.startTime) {
    sinceFeedMin = 0;
  } else {
    const lastFeed = sortedLogs.find(l => l.type === 'feeding' || l.type === 'feeding_solids');
    if (lastFeed) {
      const refTs = lastFeed.endTime || lastFeed.startTime;
      sinceFeedMin = Math.max(0, Math.round((now - refTs) / 60000));
    }
  }

  // 2. Текущий сон или окно бодрствования + прогноз сна с учётом короткого предыдущего сна
  const sleepActive = Boolean(appState.timers?.sleep?.active && appState.timers.sleep.startTime);
  let activeSleepMin = 0;
  let wakeMin = null;
  let adjustedWakeWindowMin = norms.wakeWindowMin;
  let shortNapAdjusted = false;
  let lastShortNapMin = 0;

  const lastSleep = sortedLogs.find(l => l.type === 'sleep');
  if (sleepActive) {
    activeSleepMin = Math.max(0, Math.round((now - appState.timers.sleep.startTime) / 60000));
  } else if (lastSleep) {
    const wakeStartTs = lastSleep.endTime || lastSleep.startTime;
    wakeMin = Math.max(0, Math.round((now - wakeStartTs) / 60000));

    const durMin = Number(lastSleep.durationMin) || Math.round(((lastSleep.endTime || wakeStartTs) - (lastSleep.startTime || wakeStartTs)) / 60000);
    const startHour = new Date(lastSleep.startTime || wakeStartTs).getHours();
    const isDayNap = lastSleep.sleepType === 'day' || (lastSleep.sleepType !== 'night' && startHour >= 7 && startHour < 19);

    if (isDayNap && durMin > 0 && durMin < norms.shortNapThresholdMin) {
      shortNapAdjusted = true;
      lastShortNapMin = durMin;
      adjustedWakeWindowMin = Math.max(30, norms.wakeWindowMin - norms.napShortenMin);
    }
  }

  let countdownMin = null;
  let recommendedBedtimeTs = null;
  if (!sleepActive && wakeMin !== null) {
    countdownMin = adjustedWakeWindowMin - wakeMin;
    recommendedBedtimeTs = now + countdownMin * 60000;
  }

  // 3. Трекер перегула и «долга сна» за 3–7 дней
  const daysBreakdown = [];
  let totalActualSleepMin = 0;
  let totalTargetSleepMin = 0;
  let activeDaysCount = 0;
  let overfatigueCount = 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  for (let i = 6; i >= 0; i--) {
    const dayStart = todayStart.getTime() - i * 86400000;
    const dayEnd = dayStart + 86400000;
    const dObj = new Date(dayStart);
    const dateLabel = `${String(dObj.getDate()).padStart(2, '0')}.${String(dObj.getMonth() + 1).padStart(2, '0')}`;

    let daySleepMin = 0;
    const daySleeps = [];
    (appState.journalLogs || []).forEach(log => {
      if (log.type !== 'sleep') return;
      const s = log.startTime || 0;
      const e = log.endTime || (s + (Number(log.durationMin) || 0) * 60000);
      const overlapStart = Math.max(s, dayStart);
      const overlapEnd = Math.min(e, dayEnd);
      if (overlapEnd > overlapStart) {
        daySleepMin += Math.round((overlapEnd - overlapStart) / 60000);
      }
      if (s >= dayStart && s < dayEnd) {
        daySleeps.push({ start: s, end: e });
      }
    });

    daySleeps.sort((a, b) => a.start - b.start);
    for (let j = 1; j < daySleeps.length; j++) {
      const gapMin = Math.round((daySleeps[j].start - daySleeps[j - 1].end) / 60000);
      if (gapMin > norms.wakeWindowMin + 25 && gapMin < 600) {
        overfatigueCount++;
      }
    }

    const hasLogsThatDay = (appState.journalLogs || []).some(l => {
      const t = l.startTime || 0;
      return t >= dayStart && t < dayEnd;
    });

    if (hasLogsThatDay && i > 0) {
      activeDaysCount++;
      totalActualSleepMin += daySleepMin;
      totalTargetSleepMin += norms.dailySleepTargetMin;
    }

    daysBreakdown.push({
      dateLabel,
      sleepMin: daySleepMin,
      targetMin: norms.dailySleepTargetMin,
      hasData: hasLogsThatDay
    });
  }

  const sleepDebtMin = activeDaysCount >= 2 ? Math.max(0, Math.round(totalTargetSleepMin - totalActualSleepMin)) : 0;

  return {
    norms,
    sinceFeedMin,
    sleepActive,
    activeSleepMin,
    wakeMin,
    adjustedWakeWindowMin,
    shortNapAdjusted,
    lastShortNapMin,
    countdownMin,
    recommendedBedtimeTs,
    activeDaysCount,
    sleepDebtMin,
    overfatigueCount,
    daysBreakdown
  };
}
