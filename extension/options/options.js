"use strict";

let settings = null;

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderIntervals() {
  const box = $("#intervals");
  box.innerHTML = "";
  settings.intervals.forEach((iv, idx) => {
    const row = document.createElement("div");
    row.className = "interval-row";
    row.innerHTML = `
      <label>С <input type="time" class="iv-start" value="${esc(iv.start)}"></label>
      <label>До <input type="time" class="iv-end" value="${esc(iv.end)}"></label>
      <label>Twitch, мин <input type="number" class="iv-twitch" min="0" step="5" value="${iv.twitchMin != null ? iv.twitchMin : ""}" placeholder="по умолч."></label>
      <label>YouTube, мин <input type="number" class="iv-youtube" min="0" step="5" value="${iv.youtubeMin != null ? iv.youtubeMin : ""}" placeholder="по умолч."></label>
      <button type="button" class="btn danger small iv-del" title="Удалить интервал">✕</button>
    `;
    row.querySelector(".iv-start").addEventListener("change", (e) => iv.start = e.target.value);
    row.querySelector(".iv-end").addEventListener("change", (e) => iv.end = e.target.value);
    row.querySelector(".iv-twitch").addEventListener("change", (e) => {
      iv.twitchMin = e.target.value === "" ? null : Math.max(0, parseInt(e.target.value, 10) || 0);
    });
    row.querySelector(".iv-youtube").addEventListener("change", (e) => {
      iv.youtubeMin = e.target.value === "" ? null : Math.max(0, parseInt(e.target.value, 10) || 0);
    });
    row.querySelector(".iv-del").addEventListener("click", () => {
      settings.intervals.splice(idx, 1);
      renderIntervals();
    });
    box.appendChild(row);
  });
  if (!settings.intervals.length) {
    box.innerHTML = `<p class="hint">Интервалов нет — Twitch будет заблокирован всегда, рекомендации YouTube отключены всегда.</p>`;
  }
}

function collect() {
  settings.enabled = $("#enabled").checked;
  settings.twitchLimitMin = Math.max(0, parseInt($("#twitchLimitMin").value, 10) || 0);
  settings.youtubeLimitMin = Math.max(0, parseInt($("#youtubeLimitMin").value, 10) || 0);
}

async function save() {
  collect();
  await browser.runtime.sendMessage({ type: "save-settings", settings });
  const msg = $("#savedMsg");
  msg.classList.remove("hidden");
  setTimeout(() => msg.classList.add("hidden"), 2000);
}

async function init() {
  const res = await browser.runtime.sendMessage({ type: "get-settings" });
  settings = JSON.parse(JSON.stringify(res.settings));

  $("#enabled").checked = settings.enabled;
  $("#twitchLimitMin").value = settings.twitchLimitMin;
  $("#youtubeLimitMin").value = settings.youtubeLimitMin;

  $("#addInterval").addEventListener("click", () => {
    settings.intervals.push({
      id: "i" + Date.now(),
      start: "12:00",
      end: "13:00",
      twitchMin: null,
      youtubeMin: null
    });
    renderIntervals();
  });

  $("#save").addEventListener("click", save);

  $("#resetUsage").addEventListener("click", async () => {
    if (confirm("Сбросить использованное время за сегодня?")) {
      await browser.runtime.sendMessage({ type: "reset-usage" });
    }
  });

  renderIntervals();
}

init();
