/**
 * Focus Manager — общие утилиты и модель данных.
 * Подключается в background, popup и options.
 * Все времена — 24-часовой формат "HH:MM".
 */

"use strict";

const FM = (() => {
  // ---------- Настройки по умолчанию ----------
  // sites — общий перечень сайтов. Таймер для ВСЕХ сайтов перечня — ОБЩИЙ.
  // mode: "block"   — вне интервала сайт полностью блокируется;
  //       "no-recs" — вне интервала сайт работает, но рекомендации скрыты
  //                   (поиск и прямые ссылки доступны).
  const DEFAULT_SETTINGS = {
    enabled: true,
    passwordHash: null,          // null => пароль не задан
    pwReveal: false,             // показывать пароль при вводе (кнопка 👁)
    resetRequestedAt: null,      // когда нажата кнопка сброса пароля (мс) или null
    dailyResetHour: 4,           // сброс счётчика в 04:00
    defaults: {                  // лимиты по умолчанию (применяются ко всем интервалам)
      limitMinutes: 60,          // общий лимит минут на все сайты внутри интервала
      outsideMode: "block",      // что делать с сайтами вне интервалов
    },
    intervals: [
      { id: "i1", start: "10:00", end: "13:00", limitMinutes: 60, outsideMode: "block" },
      { id: "i2", start: "16:00", end: "18:00", limitMinutes: 60, outsideMode: "block" },
      { id: "i3", start: "21:00", end: "23:00", limitMinutes: 60, outsideMode: "block" },
    ],
    sites: [
      { host: "twitch.tv",     label: "Twitch",  mode: "block"   },
      { host: "youtube.com",   label: "YouTube", mode: "no-recs" },
    ],
  };

  // Хосты, чьи поддомены тоже считаются (www.twitch.tv и т.п.)
  const SUBDOMAIN_RE = /^(www|m|m\.|music\.)$/i;

  // ---------- Время: только 24-часовой формат ----------
  function pad2(n) { return String(n).padStart(2, "0"); }

  function parseHHMM(str) {
    if (typeof str !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    return h * 60 + mi;
  }

  function toHHMM(minutesOfDay) {
    return pad2(Math.floor(minutesOfDay / 60) % 24) + ":" + pad2(minutesOfDay % 60);
  }

  function nowMinutes(d = new Date()) {
    return d.getHours() * 60 + d.getMinutes();
  }

  function fmtDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h} ч ${pad2(m)} мин` : `${m} мин`;
  }

  // Интервал может переходить через полночь: 23:00–01:00
  function inInterval(mins, iv) {
    const s = parseHHMM(iv.start), e = parseHHMM(iv.end);
    if (s === null || e === null) return false;
    if (s === e) return true;               // "одинаково" = весь день
    return s < e ? (mins >= s && mins < e) : (mins >= s || mins < e);
  }

  // ---------- Хосты ----------
  function normalizeHost(h) {
    return String(h || "").trim().toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
  }

  // Проверка корректности домена: "example.com", "sub.example.co.uk" и т.п.
  const DOMAIN_RE = /^(?=.{1,253}$)(?!-)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
  function isValidDomain(h) {
    return DOMAIN_RE.test(normalizeHost(h));
  }

  function hostMatchesSite(host, siteHost) {
    host = host.toLowerCase(); siteHost = siteHost.toLowerCase();
    if (host === siteHost) return true;
    if (host.endsWith("." + siteHost)) {
      const sub = host.slice(0, -(siteHost.length + 1));
      return !sub.includes(".") || SUBDOMAIN_RE.test(sub + ".");
    }
    return false;
  }

  function findSite(settings, host) {
    if (!host) return null;
    for (const s of settings.sites) {
      if (hostMatchesSite(host, s.host)) return s;
    }
    return null;
  }

  // ---------- Состояние счётчика ----------
  // Единый счётчик для ВСЕХ сайтов из перечня.
  function defaultState() {
    return { dayKey: "", usedSeconds: 0, lastTickTs: 0, activeTabId: null };
  }

  function dayKeyFor(d, resetHour) {
    const x = new Date(d.getTime());
    x.setHours(x.getHours() - resetHour);
    return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  }

  // ---------- Основная логика статуса ----------
  // Возвращает статус для конкретного хоста с учётом настроек и времени.
  // modes:
  //  "off"        — расширение выключено
  //  "allow"      — сейчас идёт интервал и общий лимит не исчерпан
  //  "limit"      — интервал идёт, но общий лимит минут исчерпан
  //  "block"      — вне интервала, сайт режимом "block" заблокирован
  //  "no-recs"    — вне интервала, рекомендации на сайте скрыты
  function getStatus(settings, state, host, d = new Date()) {
    const mins = nowMinutes(d);
    const current = settings.intervals.find((iv) => inInterval(mins, iv));
    const site = findSite(settings, host);
    const limitSec = (current ? current.limitMinutes : settings.defaults.limitMinutes) * 60;
    const usedMin = Math.floor(state.usedSeconds / 60);

    if (!settings.enabled) {
      return { mode: "off", host, site: !!site };
    }
    if (!site) {
      return { mode: "free", host, site: false }; // сайт не в перечне — не трогаем
    }

    if (current) {
      if (state.usedSeconds >= limitSec) {
        return { mode: "limit", host, site: site.mode, interval: current, used: usedMin, limit: current.limitMinutes };
      }
      return { mode: "allow", host, site: site.mode, interval: current, used: usedMin, limit: current.limitMinutes,
               remaining: Math.ceil((limitSec - state.usedSeconds) / 60) };
    }

    // Вне интервалов
    if (site.mode === "no-recs") {
      return { mode: "no-recs", host, site: site.mode };
    }
    return { mode: "block", host, site: site.mode };
  }

  // Ближайший интервал, который ещё не исчерпан сегодня (для текста блокировки)
  function nextIntervalInfo(settings, state, d = new Date()) {
    const mins = nowMinutes(d);
    const sorted = [...settings.intervals]
      .map((iv) => ({ iv, s: parseHHMM(iv.start) }))
      .sort((a, b) => a.s - b.s);
    for (const { iv } of sorted) {
      if (parseHHMM(iv.start) >= mins) return iv;
    }
    return sorted.length ? sorted[0].iv : null;
  }

  // ---------- Пароль (SHA-256) ----------
  async function hashPassword(pw) {
    const data = new TextEncoder().encode(String(pw));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---------- Сброс пароля: задержка 5 часов ----------
  // Нажимаем «Забыли пароль?» -> запускается таймер на 5 часов.
  // Таймер можно в любой момент остановить; при повторном запуске он начинается с нуля.
  const PW_RESET_DELAY_MS = 5 * 60 * 60 * 1000;

  // nowMs — текущее время (можно передать смоделированное; в UI считается «сколько осталось»).
  async function getResetInfo(nowMs = Date.now()) {
    const s = await loadSettings();
    if (!s.resetRequestedAt) return { active: false, ready: false, leftMs: 0 };
    const leftMs = Math.max(0, s.resetRequestedAt + PW_RESET_DELAY_MS - nowMs);
    return { active: true, ready: leftMs <= 0, leftMs };
  }

  async function startPasswordReset() {
    const s = await loadSettings();
    s.resetRequestedAt = Date.now(); // всегда с нуля
    await saveSettings(s);
    return getResetInfo();
  }

  async function cancelPasswordReset() {
    const s = await loadSettings();
    s.resetRequestedAt = null;
    await saveSettings(s);
    return { active: false, ready: false, leftMs: 0 };
  }

  // Применяется только если таймер реально истёк (проверяется по хранилищу, не по локальным данным).
  async function applyPasswordReset() {
    const info = await getResetInfo();
    if (!info.ready) return false;
    const s = await loadSettings();
    if (!s.resetRequestedAt) return false;
    s.passwordHash = null;
    s.resetRequestedAt = null;
    await saveSettings(s);
    return true;
  }

  // ---------- Хранилище ----------
  async function loadSettings() {
    const raw = await browser.storage.local.get("settings");
    const s = raw.settings;
    if (!s) return structuredClone(DEFAULT_SETTINGS);
    // мягкая миграция недостающих полей
    const merged = Object.assign(structuredClone(DEFAULT_SETTINGS), s);
    merged.defaults = Object.assign({}, DEFAULT_SETTINGS.defaults, s.defaults || {});
    return merged;
  }

  async function saveSettings(settings) {
    await browser.storage.local.set({ settings });
  }

  async function loadState() {
    const raw = await browser.storage.local.get("state");
    return raw.state || defaultState();
  }

  async function saveState(state) {
    await browser.storage.local.set({ state });
  }

  return {
    DEFAULT_SETTINGS, SUBDOMAIN_RE, PW_RESET_DELAY_MS,
    pad2, parseHHMM, toHHMM, nowMinutes, fmtDuration, inInterval,
    normalizeHost, isValidDomain, hostMatchesSite, findSite,
    defaultState, dayKeyFor, getStatus, nextIntervalInfo,
    hashPassword, loadSettings, saveSettings, loadState, saveState,
    getResetInfo, startPasswordReset, cancelPasswordReset, applyPasswordReset,
  };
})();

if (typeof module !== "undefined") module.exports = FM;
