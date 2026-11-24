/**
 * Focus Manager — MV3 background service worker.
 * Считает ОБЩЕЕ время по всем сайтам перечня (один таймер),
 * управляет alarms, обновляет иконку, рассылает статусы во вкладки.
 */

"use strict";

importScripts("../shared/utils.js");

const TICK_ALARM = "fm-tick";
const PW_RESET_ALARM = "fm-pw-reset"; // срабатывает через 5 часов после запроса сброса пароля
let badgeTimer = null;

// ---------- Активность вкладок: единый счётчик на все сайты ----------
let activeHost = null; // хост активной вкладки, если он в перечне сайтов

function hostFromUrl(u) {
  try { return new URL(u).hostname; } catch (e) { return ""; }
}

async function markActivityStart() {
  const state = await FM.loadState();
  if (!state.lastTickTs) {
    state.lastTickTs = Date.now();
    await FM.saveState(state);
  }
}

async function markActivityStop() {
  // дописываем неполную минуту при уходе с сайта
  const state = await FM.loadState();
  if (state.lastTickTs) {
    const delta = Math.floor((Date.now() - state.lastTickTs) / 1000);
    if (delta > 0) state.usedSeconds += delta;
    state.lastTickTs = 0;
    await FM.saveState(state);
  }
}

// ---------- Тик раз в минуту ----------
async function tick() {
  const settings = await FM.loadSettings();
  let state = await FM.loadState();

  // дневной сброс
  const dk = FM.dayKeyFor(new Date(), settings.dailyResetHour || 4);
  if (state.dayKey !== dk) {
    state = Object.assign(FM.defaultState(), { dayKey: dk });
  }

  const tracking = settings.enabled && activeHost && !!FM.findSite(settings, activeHost);

  if (tracking) {
    if (!state.lastTickTs) state.lastTickTs = Date.now();
    state.usedSeconds += 60; // засчитываем минуту активности
  } else {
    state.lastTickTs = 0;
  }
  state.dayKey = dk;
  await FM.saveState(state);

  await updateBadge();
  await broadcastStatus();
}

// ---------- Иконка / badge ----------
async function updateBadge() {
  const settings = await FM.loadSettings();
  const state = await FM.loadState();
  let text = "", color = "#555";

  if (!settings.enabled) {
    text = "off"; color = "#777";
  } else {
    const mins = FM.nowMinutes();
    const iv = settings.intervals.find((x) => FM.inInterval(mins, x));
    if (iv) {
      const limitSec = iv.limitMinutes * 60;
      const left = Math.max(0, Math.ceil((limitSec - state.usedSeconds) / 60));
      text = String(Math.min(999, left));
      color = left <= 5 ? "#d33" : "#2a9d3f";
    } else {
      text = "⏸"; color = "#c77";
    }
  }

  try {
    await browser.action.setBadgeText({ text });
    await browser.action.setBadgeBackgroundColor({ color });
  } catch (e) {}
}

// live-обновление остатка каждые ~20 секунд (пока popup/вкладки открыты)
function startLiveBadge() {
  if (badgeTimer) clearInterval(badgeTimer);
  badgeTimer = setInterval(async () => {
    const settings = await FM.loadSettings();
    const state = await FM.loadState();
    const dk = FM.dayKeyFor(new Date(), settings.dailyResetHour || 4);
    if (state.dayKey !== dk) return; // полный сброс сделает tick
    // пересчёт "на лету": если трек идёт, показываем уточнённый остаток
    await updateBadge();
  }, 20000);
}

// ---------- Рассылка статуса во все вкладки ----------
async function broadcastStatus() {
  const settings = await FM.loadSettings();
  const state = await FM.loadState();
  // подсказка: ближайший интервал (для текста блокировки)
  const nowM = FM.nowMinutes();
  const upcoming = settings.intervals
    .map((iv) => ({ iv, s: FM.parseHHMM(iv.start) }))
    .filter((x) => x.s !== null && x.s > nowM)
    .sort((a, b) => a.s - b.s)[0];
  const nextStart = upcoming ? upcoming.iv.start : null;

  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    const host = hostFromUrl(tab.url || "");
    if (!host) continue;
    const status = FM.getStatus(settings, state, host);
    if (status.mode === "free") continue; // не наш сайт — не дёргаем
    const site = FM.findSite(settings, host);
    if (site) status.label = site.label || site.host;
    status.nextStart = nextStart;
    browser.tabs.sendMessage(tab.id, { type: "status", status, settings }).catch(() => {});
  }
}

// ---------- Сообщения от popup/content/options ----------
// В MV3 ответ — Promise, возвращённый синхронно из слушателя.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case "get-status":
      return (async () => {
        const settings = await FM.loadSettings();
        const state = await FM.loadState();
        const host = msg.host || (sender.tab ? hostFromUrl(sender.tab.url) : "");
        return { status: FM.getStatus(settings, state, host), settings, state };
      })();
    case "get-overview":
      return (async () => {
        const settings = await FM.loadSettings();
        const state = await FM.loadState();
        return { settings, state };
      })();
    case "tab-active-host":
      return (async () => {
        // content-скрипт сообщил: пользователь активно смотрит этот хост
        activeHost = msg.host || null;
        await markActivityStart();
        await broadcastStatus();
        return { ok: true };
      })();
    case "tab-inactive":
      return (async () => {
        activeHost = null;
        await markActivityStop();
        await updateBadge();
        return { ok: true };
      })();
    case "settings-changed":
      return (async () => {
        await updateBadge();
        await broadcastStatus();
        return { ok: true };
      })();
    case "reset-counter":
      return (async () => {
        const settings = await FM.loadSettings();
        const state = FM.defaultState();
        state.dayKey = FM.dayKeyFor(new Date(), settings.dailyResetHour || 4);
        await FM.saveState(state);
        await updateBadge();
        await broadcastStatus();
        return { ok: true };
      })();
    // ---------- Сброс пароля (таймер 5 часов) ----------
    case "pw-reset-start":
      return (async () => {
        const info = await FM.startPasswordReset();
        schedulePwResetAlarm(info.leftMs);
        return { ok: true, ...info };
      })();
    case "pw-reset-cancel":
      return (async () => {
        const res = await FM.cancelPasswordReset();
        await browser.alarms.clear(PW_RESET_ALARM);
        return { ok: true, ...res };
      })();
    case "pw-reset-status":
      return (async () => ({ ok: true, ...(await FM.getResetInfo()) }));
    case "pw-reset-apply":
      return (async () => {
        const done = await FM.applyPasswordReset();
        if (done) {
          await browser.alarms.clear(PW_RESET_ALARM);
          await broadcastStatus();
        }
        return { ok: done, ...(await FM.getResetInfo()) };
      })();
  }
  return undefined;
});

// ---------- Alarm сброса пароля ----------
function schedulePwResetAlarm(leftMs) {
  browser.alarms.create(PW_RESET_ALARM, { delayInMinutes: Math.max(0.1, leftMs / 60000) });
}

async function restorePwResetAlarm() {
  const info = await FM.getResetInfo();
  if (!info.active) return;
  if (info.ready) {
    // таймер истёк, пока браузер/воркер был выключен
    if (await FM.applyPasswordReset()) await broadcastStatus();
  } else {
    schedulePwResetAlarm(info.leftMs);
  }
}

// ---------- Вкладки: следим за переключением ----------
async function syncActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    const host = hostFromUrl(tabs[0].url || "");
    const settings = await FM.loadSettings();
    const managed = !!FM.findSite(settings, host);
    if (managed && settings.enabled) {
      if (activeHost !== host) { activeHost = host; }
      await markActivityStart();
    } else if (activeHost) {
      activeHost = null;
      await markActivityStop();
    }
    await updateBadge();
  } catch (e) {}
}

browser.tabs.onActivated.addListener(syncActiveTab);
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) await syncActiveTab();
  await broadcastStatus();
});

// окно потеряло фокус → пауза учёта (видео на вкладке без нас не смотрят)
browser.windows.onFocusChanged.addListener((winId) => {
  if (winId === browser.windows.WINDOW_ID_NONE) {
    if (activeHost) { activeHost = null; markActivityStop(); }
  } else {
    syncActiveTab();
  }
});

// ---------- Alarm + boot ----------
browser.runtime.onInstalled.addListener(boot);
browser.runtime.onStartup.addListener(boot);
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK_ALARM) return tick();
  if (a.name === PW_RESET_ALARM) return onPwResetAlarm();
});

async function onPwResetAlarm() {
  // страховка: применяем только если 5 часов реально прошло
  if (await FM.applyPasswordReset()) await broadcastStatus();
}

async function boot() {
  browser.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  startLiveBadge();
  await restorePwResetAlarm();
  await tick();
}
boot();
