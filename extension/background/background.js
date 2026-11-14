/**
 * Focus Manager — background script.
 *
 * Логика:
 * - Пользователь задаёт временные интервалы вида "10:00-13:00" и лимиты
 *   времени (в минутах) для Twitch и YouTube на каждый интервал.
 * - Внутри интервала: Twitch и YouTube доступны, пока не исчерпан лимит минут.
 * - Снаружи всех интервалов: Twitch полностью заблокирован,
 *   на YouTube отключены рекомендации (работает только поиск).
 */

"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  twitchLimitMin: 60,   // лимит минут на Twitch внутри интервала (если у интервала нет своего)
  youtubeLimitMin: 0,   // 0 = без лимита на YouTube внутри интервала
  intervals: [
    { id: "i1", start: "10:00", end: "13:00", twitchMin: 60, youtubeMin: 0 },
    { id: "i2", start: "16:00", end: "18:00", twitchMin: 30, youtubeMin: 0 },
    { id: "i3", start: "21:00", end: "23:00", twitchMin: 60, youtubeMin: 0 }
  ]
};

let settings = null;

// ---- Загрузка/сохранение настроек -------------------------------------

function loadSettings() {
  return new Promise((resolve) => {
    browser.storage.local.get(["fm_settings"]).then((res) => {
      if (res && res.fm_settings) {
        settings = Object.assign({}, DEFAULT_SETTINGS, res.fm_settings);
      } else {
        settings = Object.assign({}, DEFAULT_SETTINGS);
        browser.storage.local.set({ fm_settings: settings });
      }
      resolve(settings);
    });
  });
}

function saveSettings() {
  return browser.storage.local.set({ fm_settings: settings });
}

// ---- Работа со временем ------------------------------------------------

function pad(n) { return String(n).padStart(2, "0"); }

// Ключ дня "YYYY-MM-DD"
function dayKey(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// Минуты от начала суток для строки "HH:MM"
function toMin(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((str || "").trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Интервал может "переходить" через полночь (например 23:00-01:00)
function inInterval(nowMin, iv) {
  const s = toMin(iv.start), e = toMin(iv.end);
  if (s === null || e === null) return false;
  if (s < e) return nowMin >= s && nowMin < e;
  if (s > e) return nowMin >= s || nowMin < e; // через полночь
  return false; // s == e — пустой интервал
}

function getCurrentInterval(now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const iv of settings.intervals) {
    if (inInterval(nowMin, iv)) return iv;
  }
  return null;
}

// ---- Учёт потраченного времени -----------------------------------------

async function getUsage() {
  const res = await browser.storage.local.get(["fm_usage"]);
  const today = dayKey(new Date());
  let usage = res && res.fm_usage;
  if (!usage || usage.day !== today) {
    // новый день — сброс счётчиков
    usage = { day: today, byInterval: {} };
  }
  return usage;
}

async function setUsage(usage) {
  await browser.storage.local.set({ fm_usage: usage });
}

// Сколько минут уже потрачено в данном интервале сегодня
async function minutesUsedIn(intervalId, site) {
  const usage = await getUsage();
  const rec = usage.byInterval[intervalId];
  if (!rec) return 0;
  return (site === "twitch" ? rec.twitchMin : rec.youtubeMin) || 0;
}

// ---- Статус для контента/popup ------------------------------------------

async function getStatus(site) {
  if (!settings.enabled) {
    return { mode: "off" }; // расширение выключено — ничего не блокируем
  }
  const now = new Date();
  const iv = getCurrentInterval(now);

  if (!iv) {
    // Вне интервалов
    if (site === "twitch") return { mode: "blocked-twitch" };
    return { mode: "yt-no-recs" }; // YouTube: без рекомендаций
  }

  // Внутри интервала — проверяем лимиты
  const twitchLimit = (iv.twitchMin != null ? iv.twitchMin : settings.twitchLimitMin);
  const ytLimit = (iv.youtubeMin != null ? iv.youtubeMin : settings.youtubeLimitMin);

  if (site === "twitch") {
    if (twitchLimit > 0) {
      const used = await minutesUsedIn(iv.id, "twitch");
      if (used >= twitchLimit) {
        return { mode: "limit-twitch", limit: twitchLimit, used: used };
      }
    }
    return { mode: "allow", remaining: twitchLimit > 0 ? twitchLimit - await minutesUsedIn(iv.id, "twitch") : null };
  }

  if (site === "youtube") {
    if (ytLimit > 0) {
      const used = await minutesUsedIn(iv.id, "youtube");
      if (used >= ytLimit) {
        return { mode: "limit-youtube", limit: ytLimit, used: used };
      }
    }
    return { mode: "allow-yt" };
  }
  return { mode: "allow" };
}

// ---- Активный таймер: сколько вкладок открыто по сайтам ------------------

const activeTabs = { twitch: 0, youtube: 0 };
let tickTimer = null;

function startTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(async () => {
    // засчитываем секунды только если есть активные вкладки
    if (activeTabs.twitch > 0 || activeTabs.youtube > 0) {
      // упрощённо: засчитываем по 1 секунде каждому активному сайту
      await addUsageTick();
    }
    // уведомляем вкладки об изменении статуса (каждые 15 секунд)
    broadcastStatus();
  }, 1000);
}

async function addUsageTick() {
  const now = new Date();
  const iv = getCurrentInterval(now);
  if (!iv) return;
  const usage = await getUsage();
  if (!usage.byInterval[iv.id]) usage.byInterval[iv.id] = { twitchMin: 0, youtubeMin: 0 };
  const rec = usage.byInterval[iv.id];
  rec._twitchSec = (rec._twitchSec || 0) + (activeTabs.twitch > 0 ? 1 : 0);
  rec.twitchMin = Math.floor(rec._twitchSec / 60);
  await setUsage(usage);
}

async function broadcastStatus() {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && (/twitch\.tv/.test(tab.url) || /youtube\.com/.test(tab.url))) {
      try {
        const site = /twitch\.tv/.test(tab.url) ? "twitch" : "youtube";
        const status = await getStatus(site);
        await browser.tabs.sendMessage(tab.id, { type: "status-update", status });
      } catch (e) { /* вкладка может не содержать content script */ }
    }
  }
}

// ---- Отслеживание вкладок -------------------------------------------------

function siteOfUrl(url) {
  if (!url) return null;
  if (/\/\/(www\.)?twitch\.tv/.test(url) || /\/\/twitch\.tv/.test(url)) return "twitch";
  if (/youtube\.com/.test(url)) return "youtube";
  return null;
}

browser.tabs.onCreated.addListener(() => {});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    // статус перешлёт content script сам при загрузке
  }
});

// ---- Сообщения от content script и popup ----------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  if (msg.type === "get-status") {
    return getStatus(msg.site).then((status) => ({ type: "status", status }));
  }

  if (msg.type === "tab-active") {
    // content script сообщил: страница сайта активна (видима)
    const site = msg.site;
    if (site === "twitch" || site === "youtube") {
      const tabId = sender.tab ? sender.tab.id : null;
      if (tabId != null) {
        if (!globalThis._tracked) globalThis._tracked = {};
        if (!globalThis._tracked[site]) globalThis._tracked[site] = new Set();
        if (msg.active) globalThis._tracked[site].add(tabId);
        else globalThis._tracked[site].delete(tabId);
        activeTabs[site] = globalThis._tracked[site].size;
      }
    }
    return Promise.resolve({ ok: true });
  }

  if (msg.type === "get-all-status") {
    return Promise.all([getStatus("twitch"), getStatus("youtube")]).then(([twitch, youtube]) => {
      const now = new Date();
      const iv = getCurrentInterval(now);
      return {
        type: "all-status",
        twitch, youtube,
        enabled: settings.enabled,
        currentInterval: iv ? iv : null,
        intervals: settings.intervals
      };
    });
  }

  if (msg.type === "get-settings") {
    return Promise.resolve({ type: "settings", settings });
  }

  if (msg.type === "save-settings") {
    settings = msg.settings;
    return saveSettings().then(() => {
      broadcastStatus();
      return { type: "settings-saved", ok: true };
    });
  }

  if (msg.type === "reset-usage") {
    return setUsage({ day: dayKey(new Date()), byInterval: {} }).then(() => {
      broadcastStatus();
      return { ok: true };
    });
  }
});

// ---- Инициализация -----------------------------------------------------------

loadSettings().then(() => {
  startTicker();
});

// Открыть страницу настроек по запросу из content script
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "open-options") {
    browser.runtime.openOptionsPage();
  }
});
