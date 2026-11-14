"use strict";

function fmtMin(m) {
  if (m == null) return "";
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h} ч ${mm} мин` : `${mm} мин`;
}

async function refresh() {
  const res = await browser.runtime.sendMessage({ type: "get-all-status" });
  if (!res) return;

  const nowEl = document.getElementById("now");
  const tEl = document.getElementById("twitchStatus");
  const yEl = document.getElementById("ytStatus");
  const iEl = document.getElementById("intervals");

  if (!res.enabled) {
    nowEl.textContent = "Расширение выключено";
    tEl.textContent = "выключено"; tEl.className = "warn";
    yEl.textContent = "выключено"; yEl.className = "warn";
  } else if (res.currentInterval) {
    nowEl.textContent = `Сейчас идёт интервал ${res.currentInterval.start}–${res.currentInterval.end}`;
  } else {
    nowEl.textContent = "Сейчас нет разрешённого интервала";
  }

  const tw = res.twitch.mode;
  if (tw === "allow") {
    tEl.textContent = res.twitch.remaining != null ? `доступно, осталось ${fmtMin(res.twitch.remaining)}` : "доступно";
    tEl.className = "ok";
  } else if (tw === "limit-twitch") {
    tEl.textContent = `лимит исчерпан (${res.twitch.used}/${res.twitch.limit} мин)`;
    tEl.className = "bad";
  } else if (tw === "blocked-twitch") {
    tEl.textContent = "заблокирован";
    tEl.className = "bad";
  } else {
    tEl.textContent = "—"; tEl.className = "";
  }

  const yt = res.youtube.mode;
  if (yt === "allow-yt") {
    yEl.textContent = "полный доступ";
    yEl.className = "ok";
  } else if (yt === "yt-no-recs") {
    yEl.textContent = "поиск ✓, рекомендации ✗";
    yEl.className = "warn";
  } else if (yt === "limit-youtube") {
    yEl.textContent = `лимит исчерпан (${res.youtube.used}/${res.youtube.limit} мин), только поиск`;
    yEl.className = "bad";
  } else {
    yEl.textContent = "—"; yEl.className = "";
  }

  if (res.intervals && res.intervals.length) {
    iEl.innerHTML = "Интервалы:<br>" + res.intervals.map((iv) =>
      `• ${iv.start}–${iv.end}${iv.twitchMin != null ? ` (Twitch ${iv.twitchMin} мин)` : ""}`
    ).join("<br>");
  } else {
    iEl.textContent = "Интервалы не заданы";
  }
}

document.getElementById("openOptions").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 5000);
