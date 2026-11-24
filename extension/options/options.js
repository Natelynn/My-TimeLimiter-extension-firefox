/**
 * Focus Manager — страница настроек.
 * Открывается ТОЛЬКО после ввода пароля (экран-гейт).
 * Все времена — 24-часовой формат (<input type="time"> в русской локали = HH:MM).
 */

"use strict";

const $ = (id) => document.getElementById(id);

let settings = null;
let sessionUnlocked = false; // пароль вводился в этой вкладке?

// ---------- Инициализация ----------
(async function init() {
  settings = await FM.loadSettings();

  if (!settings.passwordHash) {
    // пароль ещё не задан — сначала заставим задать
    $("gate").querySelector("p").textContent =
      "Пароль ещё не задан. Придумайте пароль — он будет запрашиваться для входа в настройки и вкладку «Управление».";
    $("gateBtn").textContent = "Задать пароль";
  }

  $("gateBtn").addEventListener("click", gateSubmit);
  $("gatePw").addEventListener("keydown", (e) => { if (e.key === "Enter") gateSubmit(); });

  $("addIntervalBtn").addEventListener("click", () => {
    settings.intervals.push({
      id: "iv" + Date.now(),
      start: "10:00", end: "13:00",
      limitMinutes: settings.defaults.limitMinutes,
    });
    renderIntervals();
  });

  $("addSiteBtn").addEventListener("click", addSite);

  $("applyDefaultsBtn").addEventListener("click", () => {
    const v = clampInt($("defLimit").value, 1, 1440);
    settings.defaults.limitMinutes = v;
    for (const iv of settings.intervals) iv.limitMinutes = v;
    renderIntervals();
    $("applyMsg").textContent = `Лимит ${v} мин применён ко всем интервалам (${settings.intervals.length}). Не забудьте нажать «Сохранить».`;
  });

  $("saveBtn").addEventListener("click", saveAll);

  $("changePwBtn2").addEventListener("click", () => $("pwForm2").classList.toggle("hidden"));
  $("savePwBtn2").addEventListener("click", changePassword);

  $("gatePw").focus();
})();

// ---------- Гейт пароля ----------
async function gateSubmit() {
  const pw = $("gatePw").value;
  if (!settings.passwordHash) {
    // первый запуск: задаём пароль
    if (pw.length < 4) { gateError("Пароль должен быть не короче 4 символов."); return; }
    settings.passwordHash = await FM.hashPassword(pw);
    await FM.saveSettings(settings);
    enterMain();
    return;
  }
  const h = await FM.hashPassword(pw);
  if (h !== settings.passwordHash) { gateError("Неверный пароль."); return; }
  sessionUnlocked = true;
  enterMain();
}

function gateError(msg) {
  $("gateErr").textContent = msg;
  $("gateErr").classList.remove("hidden");
}

function enterMain() {
  $("gate").classList.add("hidden");
  $("main").classList.remove("hidden");
  renderAll();
}

// ---------- Рендер ----------
function renderAll() {
  $("defLimit").value = settings.defaults.limitMinutes;
  $("resetHour").value = settings.dailyResetHour;
  renderIntervals();
  renderSites();
}

function renderIntervals() {
  const box = $("intervals");
  box.innerHTML = "";
  settings.intervals.forEach((iv, idx) => {
    const card = document.createElement("div");
    card.className = "iv-card";

    card.appendChild(field("С начала (с)", timeInput(iv.start, (v) => (iv.start = v))));
    card.appendChild(field("По (по)", timeInput(iv.end, (v) => (iv.end = v))));
    card.appendChild(field("Общий лимит (мин)", numberInput(iv.limitMinutes, 1, 1440, (v) => (iv.limitMinutes = v))));

    const del = document.createElement("button");
    del.className = "btn danger small";
    del.textContent = "✕ Удалить";
    del.addEventListener("click", () => {
      settings.intervals.splice(idx, 1);
      renderIntervals();
    });
    card.appendChild(del);

    box.appendChild(card);
  });
  if (!settings.intervals.length) {
    box.innerHTML = '<div class="hint">Интервалов нет — сайты будут заблокированы/без рекомендаций круглосуточно.</div>';
  }
}

function renderSites() {
  const box = $("sites");
  box.innerHTML = "";
  settings.sites.forEach((s, idx) => {
    const card = document.createElement("div");
    card.className = "site-card";

    card.appendChild(field("Домен", textInput(s.host, (v) => (s.host = FM.normalizeHost(v)) )));
    card.appendChild(field("Название", textInput(s.label || "", (v) => (s.label = v))));

    const sel = document.createElement("select");
    for (const [val, txt] of [["block", "вне интервала: блокировать"],
                              ["no-recs", "вне интервала: скрывать рекомендации"]]) {
      const o = document.createElement("option");
      o.value = val; o.textContent = txt;
      if (s.mode === val) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => (s.mode = sel.value));
    const modeWrap = document.createElement("label");
    modeWrap.textContent = "Режим вне интервала: ";
    modeWrap.appendChild(sel);
    card.appendChild(modeWrap);

    const del = document.createElement("button");
    del.className = "btn danger small";
    del.textContent = "✕ Убрать";
    del.addEventListener("click", () => {
      settings.sites.splice(idx, 1);
      renderSites();
    });
    card.appendChild(del);

    box.appendChild(card);
  });
  if (!settings.sites.length) {
    box.innerHTML = '<div class="hint">Перечень пуст — расширение ни на каких сайтах не действует.</div>';
  }
}

// ---------- Конструкторы полей ----------
function field(labelText, inputEl) {
  const l = document.createElement("label");
  l.appendChild(document.createTextNode(labelText));
  l.appendChild(inputEl);
  return l;
}

function timeInput(value, onChange) {
  const i = document.createElement("input");
  i.type = "time";
  i.value = value;              // "HH:MM" — 24-часовой формат
  i.step = 60;                  // без минутных стрелок AM/PM
  i.addEventListener("change", () => {
    const v = FM.parseHHMM(i.value);
    if (v === null) { i.value = value; return; }
    value = i.value.slice(0, 5);
    onChange(value);
  });
  return i;
}

function numberInput(value, min, max, onChange) {
  const i = document.createElement("input");
  i.type = "number"; i.min = min; i.max = max; i.step = 5; i.value = value;
  i.addEventListener("change", () => {
    const v = clampInt(i.value, min, max);
    i.value = v; onChange(v);
  });
  return i;
}

function textInput(value, onChange) {
  const i = document.createElement("input");
  i.type = "text"; i.value = value;
  i.addEventListener("change", () => onChange(i.value));
  return i;
}

function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (isNaN(v)) v = min;
  return Math.min(max, Math.max(min, v));
}

// ---------- Добавление сайта ----------
function addSite() {
  const host = FM.normalizeHost($("newSiteHost").value);
  if (!host || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) {
    alert("Введите корректный домен, например vk.com");
    return;
  }
  if (settings.sites.some((s) => s.host === host)) {
    alert("Такой сайт уже в перечне.");
    return;
  }
  settings.sites.push({
    host,
    label: $("newSiteLabel").value.trim() || host,
    mode: $("newSiteMode").value,
  });
  $("newSiteHost").value = ""; $("newSiteLabel").value = "";
  renderSites();
}

// ---------- Смена пароля ----------
async function changePassword() {
  const msg = $("pwMsg2");
  const oldH = await FM.hashPassword($("oldPw2").value);
  if (settings.passwordHash && oldH !== settings.passwordHash) {
    msg.textContent = "Текущий пароль неверен."; return;
  }
  const a = $("newPwA").value, b = $("newPwB").value;
  if (a.length < 4) { msg.textContent = "Новый пароль слишком короткий."; return; }
  if (a !== b) { msg.textContent = "Новые пароли не совпадают."; return; }
  settings.passwordHash = await FM.hashPassword(a);
  ["oldPw2", "newPwA", "newPwB"].forEach((id) => ($(id).value = ""));
  msg.textContent = "Пароль обновлён ✔";
}

// ---------- Сохранение ----------
async function saveAll() {
  settings.dailyResetHour = clampInt($("resetHour").value, 0, 23);
  settings.defaults.limitMinutes = clampInt($("defLimit").value, 1, 1440);

  // валидация интервалов
  for (const iv of settings.intervals) {
    if (FM.parseHHMM(iv.start) === null || FM.parseHHMM(iv.end) === null) {
      alert("В интервалах есть некорректное время (ожидается 24-ч формат ЧЧ:ММ).");
      return;
    }
  }
  await FM.saveSettings(settings);
  await browser.runtime.sendMessage({ type: "settings-changed" }).catch(() => {});
  $("saveMsg").textContent = "Сохранено ✔ (" + new Date().toLocaleTimeString("ru-RU", { hour12: false }) + ")";
}
