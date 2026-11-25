/**
 * Focus Manager — страница настроек.
 * Открывается ТОЛЬКО после ввода пароля (экран-гейт).
 * Все времена — 24-часовой формат (<input type="time"> в русской локали = HH:MM).
 */

"use strict";

const $ = (id) => document.getElementById(id);

let settings = null;
let sessionUnlocked = false; // пароль вводился в этой вкладке?
let resetTickTimer = null;   // интервал обновления таймера сброса пароля

// ---------- Инициализация ----------
(async function init() {
  settings = await FM.loadSettings();

  if (!settings.passwordHash) {
    // пароль ещё не задан — сначала заставим задать
    gateModeSetup();
  }

  $("gateBtn").addEventListener("click", gateSubmit);
  $("gatePw").addEventListener("keydown", (e) => { if (e.key === "Enter") gateSubmit(); });

  // кнопка «показать пароль» на гейте + глобальная настройка pwReveal
  applyRevealPref();
  $("gateRevealBtn").addEventListener("click", () => toggleReveal($("gatePw"), $("gateRevealBtn")));

  // сброс пароля по таймеру 5 часов
  $("forgotBtn").addEventListener("click", startReset);
  $("resetCancelBtn").addEventListener("click", cancelReset);
  $("resetApplyBtn").addEventListener("click", applyReset);
  await refreshResetUi();

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
  $("revealAllChk2").addEventListener("change", async (e) => {
    settings.pwReveal = e.target.checked;
    await FM.saveSettings(settings);
    applyRevealPref();
  });
  document.querySelectorAll(".reveal-btn[data-reveal]").forEach((btn) => {
    btn.addEventListener("click", () => toggleReveal($(btn.dataset.reveal), btn));
  });

  $("gatePw").focus();
})();

// ---------- Режим «задать пароль» на гейте ----------
// Исправление: раньше поле просило ввести пароль даже когда он ещё не был задан.
function gateModeSetup() {
  $("gateText").textContent =
    "Пароль ещё не задан. Придумайте и введите новый пароль — он будет запрашиваться для входа в настройки и вкладку «Управление».";
  $("gatePw").placeholder = "Придумайте пароль";
  $("gateBtn").textContent = "Задать пароль";
  $("resetBlock").classList.add("hidden");
}

// Обычный режим гейта — «введите пароль» (используется после сброса пароля).
function gateModeLogin() {
  $("gateText").textContent = "Введите пароль, чтобы изменить интервалы, перечень сайтов и лимиты.";
  $("gatePw").placeholder = "Пароль";
  $("gateBtn").textContent = "Войти";
  $("resetBlock").classList.remove("hidden");
}

// ---------- Показать/скрыть пароль ----------
const PW_FIELD_IDS = ["gatePw", "oldPw2", "newPwA", "newPwB"];

function applyRevealPref() {
  const reveal = !!settings.pwReveal;
  for (const id of PW_FIELD_IDS) {
    const el = $(id);
    if (el) el.type = reveal ? "text" : "password";
  }
  $("revealAllChk2").checked = reveal;
  syncRevealBtn($("gatePw"), $("gateRevealBtn"));
  document.querySelectorAll(".reveal-btn[data-reveal]").forEach((b) => syncRevealBtn($(b.dataset.reveal), b));
}

function toggleReveal(input, btn) {
  input.type = input.type === "password" ? "text" : "password";
  syncRevealBtn(input, btn);
}

function syncRevealBtn(input, btn) {
  const shown = input.type === "text";
  btn.textContent = shown ? "🙈" : "👁";
  btn.title = shown ? "Скрыть пароль" : "Показать пароль";
}

// ---------- Гейт пароля ----------
async function gateSubmit() {
  const pw = $("gatePw").value;
  if (!settings.passwordHash) {
    // пароль ещё не задан — задаём его прямо здесь, одним полем
    if (pw.length < 4) { gateError("Пароль должен быть не короче 4 символов."); return; }
    settings.passwordHash = await FM.hashPassword(pw);
    await FM.saveSettings(settings);
    sessionUnlocked = true;
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
  stopResetTicker();
  $("gate").classList.add("hidden");
  $("main").classList.remove("hidden");
  applyRevealPref();
  renderAll();
}

// ---------- Сброс пароля (таймер 5 часов) ----------
async function startReset() {
  const res = await browser.runtime.sendMessage({ type: "pw-reset-start" });
  if (res && res.ok) { settings = await FM.loadSettings(); await refreshResetUi(); }
}

async function cancelReset() {
  const res = await browser.runtime.sendMessage({ type: "pw-reset-cancel" });
  if (res && res.ok) { settings = await FM.loadSettings(); await refreshResetUi(); }
}

async function applyReset() {
  const res = await browser.runtime.sendMessage({ type: "pw-reset-apply" });
  if (res && res.ok) {
    // пароль сброшен — переходим в режим «задать новый пароль»
    settings = await FM.loadSettings();
    if (settings.passwordHash) gateModeLogin(); else gateModeSetup();
    $("gatePw").value = "";
    $("gateErr").classList.add("hidden");
    sessionUnlocked = false;
    stopResetTicker();
    $("gate").classList.remove("hidden");
    $("main").classList.add("hidden");
    $("gatePw").focus();
  } else {
    $("gateErr").textContent = "Таймер ещё не истёк.";
    $("gateErr").classList.remove("hidden");
    await refreshResetUi();
  }
}

async function refreshResetUi() {
  const res = await browser.runtime.sendMessage({ type: "pw-reset-status" }).catch(() => null);
  const panel = $("resetPanel");
  const forgot = $("forgotBtn");
  stopResetTicker();
  if (!res || !res.active) {
    panel.classList.add("hidden");
    forgot.classList.remove("hidden");
    $("resetApplyBtn").classList.add("hidden");
    return;
  }
  forgot.classList.add("hidden");
  panel.classList.remove("hidden");
  if (res.ready) {
    $("resetTimer").textContent = "Готово!";
    $("resetCancelBtn").classList.add("hidden");
    $("resetApplyBtn").classList.remove("hidden");
  } else {
    $("resetCancelBtn").classList.remove("hidden");
    $("resetApplyBtn").classList.add("hidden");
    const deadline = Date.now() + res.leftMs;
    updateResetTimer(deadline - Date.now());
    resetTickTimer = setInterval(() => updateResetTimer(deadline - Date.now()), 1000);
  }
}

function updateResetTimer(leftMs) {
  leftMs = Math.max(0, leftMs);
  if (leftMs <= 0) { stopResetTicker(); refreshResetUi(); return; }
  const total = Math.ceil(leftMs / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  $("resetTimer").textContent = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function stopResetTicker() {
  if (resetTickTimer) { clearInterval(resetTickTimer); resetTickTimer = null; }
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
