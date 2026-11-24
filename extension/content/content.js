/**
 * Focus Manager — content script (универсальный).
 * Работает на ЛЮБОМ сайте из перечня settings.sites.
 * Никакого разделения "youtube/twitch" — только режимы:
 *   allow   — всё можно (идёт интервал, общий лимит не исчерпан)
 *   limit   — общий лимит минут исчерпан → блокировка до сброса
 *   block   — вне интервала, сайт заблокирован
 *   no-recs — вне интервала, скрыты рекомендации (поиск работает)
 *   off/free — ничего не делаем
 */

"use strict";

(() => {
  const host = location.hostname.toLowerCase();
  let currentMode = null;
  let overlayEl = null;
  let recObserver = null;

  // ---------- Селекторы рекомендаций (расширяемый реестр) ----------
  const REC_SELECTORS = {
    "youtube.com": [
      "#related", "ytd-watch-next-secondary-results-renderer",
      "ytd-item-section-renderer", "ytd-rich-grid-renderer",
      "ytd-expanded-shelf-contents-view-model", "tp-yt-paper-dialog",
      "ytd-reel-shelf-renderer", "ytd-compact-autoplay-renderer",
      "ytd-partial-backed-grid-renderer",
    ],
    "twitch.tv": [
      "section[data-test-selector*='RECOMMENDED']",
      ".recommended-category",
      "div[class*='recommendation']",
    ],
  };

  const GENERIC_REC_SELECTORS = [
    "[data-testid*='recommend']", "[class*='recommend']",
    "[id*='recommend']", "[data-recommendations]",
    "section[aria-label*='екомендации' i]", "section[aria-label*='ecommendation' i]",
  ];

  function selectorsFor() {
    for (const key of Object.keys(REC_SELECTORS)) {
      if (host === key || host.endsWith("." + key)) {
        return REC_SELECTORS[key].concat(GENERIC_REC_SELECTORS);
      }
    }
    return GENERIC_REC_SELECTORS;
  }

  // ---------- Сообщения ----------
  function reportActive(active) {
    try {
      browser.runtime.sendMessage(
        active ? { type: "tab-active-host", host } : { type: "tab-inactive" }
      );
    } catch (e) {}
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
    pauseMedia();
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = "none";
  }

  function pauseMedia() {
    document.querySelectorAll("video, audio").forEach((v) => {
      try { v.pause(); } catch (e) {}
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Скрытие рекомендаций ----------
  function hideRecs() {
    const sel = selectorsFor().join(",");
    try {
      document.querySelectorAll(sel).forEach((el) => {
        el.setAttribute("fm-hide", "1");
        el.style.setProperty("display", "none", "important");
      });
    } catch (e) {}
    // главная лента = сплошные рекомендации → редирект на страницу поиска
    if ((host === "www.youtube.com" || host === "youtube.com") &&
        (location.pathname === "/" || location.pathname === "/feed/trending")) {
      location.replace("/results?search_query=");
    }
  }

  function startRecObserver() {
    if (recObserver) return;
    hideRecs();
    recObserver = new MutationObserver(() => hideRecs());
    recObserver.observe(document.documentElement, { childList: true, subtree: true });
    recObserver._timer = setInterval(hideRecs, 800);
  }

  function stopRecObserver() {
    if (!recObserver) return;
    recObserver.disconnect();
    clearInterval(recObserver._timer);
    recObserver = null;
    document.querySelectorAll("[fm-hide]").forEach((el) => {
      el.removeAttribute("fm-hide");
      el.style.removeProperty("display");
    });
  }

  // ---------- Защита от кликов под оверлеем/SPA-переходов ----------
  function guardClicks(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function startGuard() {
    document.addEventListener("click", guardClicks, true);
  }

  function stopGuard() {
    document.removeEventListener("click", guardClicks, true);
  }

  function nextIntervalText(status) {
    return status.nextStart ? `Ближайший интервал начнётся в ${escapeHtml(status.nextStart)}.` : "";
  }

  // ---------- Применение статуса ----------
  function applyStatus(status) {
    if (!status) return;
    const mode = status.mode;
    const label = escapeHtml(status.label || host);

    // лимитные статусы перерисовываем всегда (меняется текст остатка)
    if (mode === currentMode && mode !== "limit") return;
    currentMode = mode;

    switch (mode) {
      case "off":
      case "free":
        hideOverlay(); stopRecObserver(); stopGuard();
        break;

      case "allow":
        hideOverlay(); stopRecObserver(); stopGuard();
        reportActive(true);
        break;

      case "block":
        stopRecObserver();
        showOverlay(
          `<div class="fm-box">` +
          `<h1>⛔ ${label} сейчас недоступен</h1>` +
          `<p>Нет активного разрешённого интервала.<br>${nextIntervalText(status)}</p>` +
          `<p class="fm-hint">Интервалы и перечень сайтов настраиваются в расширении:<br>` +
          `иконка 🎯 → вкладка «Управление» → «Настройки» (нужен пароль)</p>` +
          `</div>`
        );
        startGuard();
        reportActive(false);
        break;

      case "limit":
        stopRecObserver();
        showOverlay(
          `<div class="fm-box">` +
          `<h1>⏳ Общее время по списку сайтов исчерпано</h1>` +
          `<p>Использовано ${status.used} из ${status.limit} мин общего лимита.<br>` +
          `${nextIntervalText(status)}<br>` +
          `Дождитесь следующего интервала или сбросьте счётчик в настройках.</p>` +
          `</div>`
        );
        startGuard();
        reportActive(false);
        break;

      case "no-recs":
        hideOverlay(); stopGuard();
        startRecObserver();
        reportActive(false); // вне интервала время не считаем
        break;
    }
  }

  // ---------- Жизненный цикл ----------
  async function refresh() {
    try {
      const res = await browser.runtime.sendMessage({ type: "get-status", host });
      if (res && res.status) {
        const st = res.status;
        if (res.settings && res.settings.sites) {
          for (const s of res.settings.sites) {
            const sh = String(s.host).toLowerCase();
            if (host === sh || host.endsWith("." + sh)) { st.label = s.label || s.host; break; }
          }
        }
        applyStatus(st);
      }
    } catch (e) {
      setTimeout(refresh, 1000); // background ещё не готов
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "status" && msg.status) applyStatus(msg.status);
  });

  document.addEventListener("visibilitychange", () => {
    if (currentMode !== "allow") return;
    reportActive(!document.hidden);
  });

  window.addEventListener("pagehide", () => {
    if (currentMode === "allow") reportActive(false);
  });

  // SPA-навигация (сайты меняют URL без перезагрузки страницы)
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (currentMode === "no-recs") hideRecs();
    }
  }, 400);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh);
  } else {
    refresh();
  }
})();
