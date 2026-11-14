/**
 * Focus Manager — content script для twitch.tv и youtube.com
 *
 * Режимы (приходят из background):
 *  - "off"            : расширение выключено — ничего не делаем
 *  - "allow"/"allow-yt": разрешено, следим за активностью вкладки
 *  - "blocked-twitch" : вне интервала — Twitch полностью заблокирован
 *  - "limit-twitch"   : лимит минут на Twitch исчерпан — заблокирован до конца интервала/дня
 *  - "yt-no-recs"     : вне интервала — YouTube работает, но рекомендации скрыты
 *  - "limit-youtube"  : лимит минут на YouTube исчерпан — только поиск
 */

"use strict";

(function () {
  const host = location.hostname;
  const isTwitch = /(^|\.)twitch\.tv$/.test(host);
  const isYoutube = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host);
  if (!isTwitch && !isYoutube) return;

  const site = isTwitch ? "twitch" : "youtube";
  let currentMode = null;
  let overlayEl = null;
  let ytObserver = null;

  // ---------- Сообщения в background ----------

  function askStatus() {
    return browser.runtime.sendMessage({ type: "get-status", site }).then((res) => res && res.status);
  }

  function reportActive(active) {
    try { browser.runtime.sendMessage({ type: "tab-active", site, active }); } catch (e) {}
  }

  // ---------- Оверлей блокировки ----------

  function showOverlay(html) {
    if (!overlayEl) {
      overlayEl = document.createElement("div");
      overlayEl.id = "fm-overlay";
      document.documentElement.appendChild(overlayEl);
    }
    overlayEl.innerHTML = html;
    overlayEl.style.display = "flex";
    // не даём играть видео под оверлеем
    pauseMedia();
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = "none";
  }

  function pauseMedia() {
    document.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch (e) {} });
  }

  function fmtLimit(status) {
    return `Лимит времени исчерпан (${status.used} из ${status.limit} мин использовано).<br>` +
           `Дождитесь следующего разрешённого интервала или сбросьте счётчик в настройках расширения.`;
  }

  // ---------- Обработка статусов ----------

  function applyStatus(status) {
    if (!status) return;
    const mode = status.mode;

    if (mode === currentMode && mode !== "limit-twitch" && mode !== "limit-youtube") {
      // лимитные статусы обновляем всегда (меняется кол-во использованных минут)
      if (mode !== "yt-no-recs") return;
    }
    currentMode = mode;

    if (site === "twitch") {
      if (mode === "blocked-twitch") {
        showOverlay(
          `<div class="fm-box">` +
          `<h1>⛔ Twitch заблокирован</h1>` +
          `<p>Сейчас нет разрешённого временного интервала.<br>` +
          `Открыть настройки расширения →</p>` +
          `<a class="fm-btn" href="#" data-fm-options>Настроить интервалы</a>` +
          `</div>`
        );
        startTwitchGuard();
      } else if (mode === "limit-twitch") {
        showOverlay(
          `<div class="fm-box"><h1>⏳ Время на Twitch закончилось</h1><p>${fmtLimit(status)}</p>` +
          `<a class="fm-btn" href="#" data-fm-options>Настройки</a></div>`
        );
        startTwitchGuard();
      } else {
        hideOverlay();
        stopTwitchGuard();
        reportActive(true);
      }
      return;
    }

    // YouTube
    if (mode === "yt-no-recs" || mode === "limit-youtube") {
      startYtNoRecs();
      if (mode === "limit-youtube") {
        showOverlayBanner(`⏳ Лимит YouTube исчерпан (${status.used} из ${status.limit} мин). Доступен только поиск.`);
      } else {
        showOverlayBanner(`ℹ️ Рекомендации YouTube отключены — сейчас нет разрешённого интервала. Поиск работает.`);
      }
    } else {
      stopYtNoRecs();
      hideBanner();
      if (mode === "allow-yt" || mode === "off") reportActive(true);
    }
  }

  // Баннер сверху вместо полноэкранного оверлея (YouTube остаётся usable)
  let bannerEl = null;
  function showOverlayBanner(html) {
    hideOverlay();
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.id = "fm-banner";
      (document.body || document.documentElement).appendChild(bannerEl);
    }
    bannerEl.innerHTML = html;
    bannerEl.style.display = "block";
  }
  function hideBanner() { if (bannerEl) bannerEl.style.display = "none"; }

  // ---------- Twitch: защита от обхода ----------

  let twitchGuardTimer = null;
  function startTwitchGuard() {
    pauseMedia();
    if (!twitchGuardTimer) {
      twitchGuardTimer = setInterval(() => {
        if (currentMode === "blocked-twitch" || currentMode === "limit-twitch") {
          pauseMedia();
          // перекрытие заново, если страница дорисовалась
          if (overlayEl && overlayEl.style.display !== "none") {
            overlayEl.style.zIndex = "2147483647";
          }
        }
      }, 500);
    }
    reportActive(false);
  }
  function stopTwitchGuard() {
    if (twitchGuardTimer) { clearInterval(twitchGuardTimer); twitchGuardTimer = null; }
  }

  // ---------- YouTube: скрытие рекомендаций ----------

  // Селекторы блоков рекомендаций на главной, в сайдбаре страницы просмотра,
  // на sidepanel ("Вам может понравиться", Shorts-полка и т.п.)
  const YT_HIDE_SELECTORS = [
    'ytd-rich-grid-row',                       // сетка рекомендаций на главной
    'ytd-rich-item-renderer',
    'ytd-browse[id="search"] ytd-rich-grid-renderer',
    'ytd-watch-next-secondary-results-renderer', // сайдбар "Далее" на странице просмотра
    'ytd-compact-video-renderer',
    'ytd-item-section-renderer',
    'ytd-shelf-renderer',                      // полки ("Рекомендуем", Shorts)
    'ytd-reel-shelf-renderer',                 // Shorts
    'tp-yt-paper-dialog ytd-engagement-panel-section-list-renderer', // боковая панель
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-search-related-videoshub"]',
    'ytd-mini-guide-renderer a[aria-label="Главная"]', // чтобы не вели на ленту (визуально скрываем только саму ленту ниже)
    'ytd-popup-container'                      // всплывающие подсказки ленты
  ].join(", ");

  function cleanYt() {
    // 1) Если пользователь на главной / ленте — показываем заглушку вместо ленты
    const path = location.pathname;
    const onFeed = path === "/" || path === "" || /^\/feed\/(trending|subscriptions|you)/.test(path);
    if (onFeed && (currentMode === "yt-no-recs" || currentMode === "limit-youtube")) {
      blockFeedPage();
    }
    // 2) Скрываем рекомендации/сайдбар на странице просмотра
    document.querySelectorAll(YT_HIDE_SELECTORS).forEach((el) => {
      if (el.closest("#search-input, ytd-searchbox, c-wiz")) return;
      el.style.setProperty("display", "none", "important");
    });
    // 3) Страница поиска: скрываем всё кроме результатов
    const results = document.querySelector("ytd-item-section-renderer#sections, ytd-search-results-renderer, #results");
    if (results && /\/results/.test(path)) {
      // оставляем результаты как есть
    }
  }

  function blockFeedPage() {
    const primary = document.querySelector("ytd-app ytd-browse #primary, ytd-browse[id='search'] #primary");
    const richGrid = document.querySelector("ytd-rich-grid-renderer, ytd-two-column-browse-results-renderer");
    if (richGrid && !richGrid.dataset.fmBlocked) {
      richGrid.dataset.fmBlocked = "1";
      richGrid.style.setProperty("display", "none", "important");
      let msg = document.getElementById("fm-feed-msg");
      if (!msg) {
        msg = document.createElement("div");
        msg.id = "fm-feed-msg";
        msg.className = "fm-feed-msg";
        msg.innerHTML = "🔎 Лента рекомендаций отключена вне разрешённого времени.<br>Пользуйтесь поиском.";
        (primary || document.body).prepend(msg);
      }
    }
  }

  let ytCleanupTimer = null;
  function startYtNoRecs() {
    reportActive(false); // время YouTube вне интервала не засчитываем в лимиты
    cleanYt();
    if (!ytObserver) {
      ytObserver = new MutationObserver(() => cleanYt());
      ytObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (!ytCleanupTimer) {
      ytCleanupTimer = setInterval(cleanYt, 1000);
    }
    window.addEventListener("yt-navigate-finish", cleanYt, true);
    window.addEventListener("popstate", cleanYt, true);
  }

  function stopYtNoRecs() {
    if (ytObserver) { ytObserver.disconnect(); ytObserver = null; }
    if (ytCleanupTimer) { clearInterval(ytCleanupTimer); ytCleanupTimer = null; }
    window.removeEventListener("yt-navigate-finish", cleanYt, true);
    window.removeEventListener("popstate", cleanYt, true);
    // восстановить скрытое
    document.querySelectorAll(YT_HIDE_SELECTORS).forEach((el) => el.style.removeProperty("display"));
    document.querySelectorAll("[data-fm-blocked]").forEach((el) => {
      el.style.removeProperty("display"); delete el.dataset.fmBlocked;
    });
    const msg = document.getElementById("fm-feed-msg");
    if (msg) msg.remove();
  }

  // ---------- Активность вкладки (для засчёта времени) ----------

  function updateActivity() {
    const visible = !document.hidden;
    const allowed = currentMode === "allow" || currentMode === "allow-yt" || currentMode === "off";
    reportActive(visible && allowed);
  }
  document.addEventListener("visibilitychange", updateActivity);

  // ---------- Клик по кнопке "Настройки" в оверлее ----------

  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-fm-options]");
    if (a) {
      e.preventDefault();
      browser.runtime.sendMessage({ type: "open-options" }).catch(() => {});
      // запасной вариант — открыть через новую вкладку невозможно из content,
      // поэтому просто просим background (он обработает, см. ниже)
    }
  }, true);

  // ---------- Жизненный цикл ----------

  function refresh() {
    askStatus().then(applyStatus).catch(() => {});
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "status-update") applyStatus(msg.status);
  });

  // YouTube — SPA, реагируем на смену URL
  if (isYoutube) {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; refresh(); }
    }, 500);
  }

  function init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", refresh);
    } else {
      refresh();
    }
  }
  init();
})();
