/**
 * Focus Manager — popup.
 * Вкладка «Статус» — только просмотр.
 * Вкладка «Управление» — пароль, затем кнопка настроек/сброс/вкл-выкл.
 */

"use strict";

const $ = (id) => document.getElementById(id);

let settings = null;
let state = null;
let unlocked = false; // разблокирована ли вкладка управления в этой сессии попапа

// ---------- Вкладки ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "manage") renderManage();
  });
});

// ---------- Данные ----------
async function loadData() {
  const res = await browser.runtime.sendMessage({ type: "get-overview" });
  settings = res.settings;
  state = res.state;
}

function currentInterval() {
  const mins = FM.nowMinutes();
  return settings.intervals.find((iv) => FM.inInterval(mins, iv)) || null;
}

// ---------- Вкладка статуса ----------
function renderStatus() {
  const line = $("statusLine");
  const iv = currentInterval();

  if (!settings.enabled) {
    line.textContent = "⚪ Расширение выключено";
    line.className = "status-line warn";
    $("timerBlock").classList.add("hidden");
  } else if (iv) {
    const limitSec = iv.limitMinutes * 60;
    const usedSec = Math.min(state.usedSeconds, limitSec);
    const leftMin = Math.max(0, Math.ceil((limitSec - state.usedSeconds) / 60));
    if (state.usedSeconds >= limitSec) {
      line.textContent = `🔴 Лимит (${iv.limitMinutes} мин) исчерпан — сайты из перечня заблокированы`;
      line.className = "status-line bad";
    } else {
      line.textContent = `🟢 Активен интервал ${iv.start}–${iv.end}, осталось ${leftMin} мин`;
      line.className = "status-line ok";
    }
    $("timerBlock").classList.remove("hidden");
    $("usedTime").textContent = FM.fmtDuration(state.usedSeconds);
    $("limitTime").textContent = iv.limitMinutes + " мин";
    $("leftTime").textContent = leftMin + " мин";
    const pct = Math.min(100, Math.round((usedSec / limitSec) * 100));
    $("barFill").style.width = pct + "%";
    $("barFill").className = "bar-fill" + (pct >= 90 ? " danger" : "");
  } else {
    const next = FM.nextIntervalInfo(settings, state);
    line.textContent = next
      ? `⏸ Вне интервалов. Ближайший: ${next.start}–${next.end}`
      : "⏸ Вне интервалов";
    line.className = "status-line warn";
    $("timerBlock").classList.add("hidden");
  }

  // список интервалов
  const ul = $("intervalList");
  ul.innerHTML = "";
  for (const x of settings.intervals) {
    const li = document.createElement("li");
    const isCur = iv && x.id === iv.id;
    li.innerHTML = `<span class="${isCur ? "iv-current" : ""}">${x.start} – ${x.end}</span>` +
                   `<span class="mode-tag">лимит ${x.limitMinutes} мин</span>`;
    ul.appendChild(li);
  }

  // перечень сайтов
  const sl = $("siteList");
  sl.innerHTML = "";
  for (const s of settings.sites) {
    const li = document.createElement("li");
    const modeTxt = s.mode === "no-recs" ? "вне интервала: без рекомендаций" : "вне интервала: блокировка";
    li.innerHTML = `<span>${escapeHtml(s.label || s.host)}</span><span class="mode-tag ${s.mode}">${modeTxt}</span>`;
    sl.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Вкладка управления ----------
async function renderManage() {
  if (unlocked) {
    $("lockBlock").classList.add("hidden");
    $("manageBlock").classList.remove("hidden");
    $("enabledChk").checked = settings.enabled;
    applyRevealPref();
    return;
  }
  $("manageBlock").classList.add("hidden");
  $("lockBlock").classList.remove("hidden");
  const hasPw = !!settings.passwordHash;
  // Исправление: если пароль ещё не задан — не просим его ввести,
  // а показываем удобную форму «задать пароль».
  $("setupPwBox").classList.toggle("hidden", hasPw);
  $("loginBox").classList.toggle("hidden", !hasPw);
  $("resetBox").classList.toggle("hidden", !hasPw);
  $("lockTitle").textContent = hasPw ? "🔒 Для управления введите пароль" : "🔑 Задайте пароль";
  $("pwError").classList.add("hidden");
  applyRevealPref();
  await refreshResetUi();
}

// ---------- Показать/скрыть пароль ----------
const PW_FIELD_IDS = ["pwInput", "pwNew1", "pwNew2", "oldPw", "newPw1", "newPw2"];

function applyRevealPref() {
  const reveal = !!settings.pwReveal;
  for (const id of PW_FIELD_IDS) {
    const el = $(id);
    if (el) el.type = reveal ? "text" : "password";
  }
  $("revealAllChk").checked = reveal;
  syncRevealBtn($("pwInput"), $("loginRevealBtn"));
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

$("loginRevealBtn").addEventListener("click", () => toggleReveal($("pwInput"), $("loginRevealBtn")));
document.querySelectorAll(".reveal-btn[data-reveal]").forEach((btn) => {
  btn.addEventListener("click", () => toggleReveal($(btn.dataset.reveal), btn));
});
$("revealAllChk").addEventListener("change", async (e) => {
  settings.pwReveal = e.target.checked;
  await FM.saveSettings(settings);
  notifyChanged();
  applyRevealPref();
});

$("setPwBtn").addEventListener("click", async () => {
  try {
    // Перечитываем настройки из хранилища: локальная копия могла устареть,
    // и сохранение устаревшего объекта «сверху» ломало задавание пароля.
    settings = await FM.loadSettings();
    const a = $("pwNew1").value, b = $("pwNew2").value;
    if (a.length < 4) { showPwError("Пароль должен быть не короче 4 символов."); return; }
    if (a !== b) { showPwError("Пароли не совпадают."); return; }
    settings.passwordHash = await FM.hashPassword(a);
    await FM.saveSettings(settings);
    notifyChanged();
    $("pwNew1").value = "";
    $("pwNew2").value = "";
    unlocked = true;
    renderManage();
  } catch (err) {
    showPwError("Не удалось задать пароль: " + (err && err.message ? err.message : err));
  }
});

$("unlockBtn").addEventListener("click", tryUnlock);
$("pwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });

async function tryUnlock() {
  const h = await FM.hashPassword($("pwInput").value);
  if (h === settings.passwordHash) {
    unlocked = true;
    $("pwInput").value = "";
    $("pwError").classList.add("hidden");
    renderManage();
  } else {
    showPwError("Неверный пароль.");
  }
}

function showPwError(msg) {
  const el = $("pwError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ---------- Сброс пароля (таймер 5 часов) ----------
let resetTickTimer = null;

$("forgotBtn").addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({ type: "pw-reset-start" });
  if (res && res.ok) { settings = await FM.loadSettings(); await refreshResetUi(); }
});

$("resetCancelBtn").addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({ type: "pw-reset-cancel" });
  if (res && res.ok) { settings = await FM.loadSettings(); await refreshResetUi(); }
});

$("resetApplyBtn").addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({ type: "pw-reset-apply" });
  if (res && res.ok) {
    // пароль сброшен — снова показываем форму «задать пароль»
    settings = await FM.loadSettings();
    unlocked = false;
    renderManage();
  } else {
    showPwError("Таймер ещё не истёк.");
    await refreshResetUi();
  }
});

async function refreshResetUi() {
  stopResetTicker();
  const panel = $("resetPanel");
  const forgot = $("forgotBtn");
  if (!settings.passwordHash) {
    panel.classList.add("hidden");
    forgot.classList.remove("hidden");
    return;
  }
  const res = await browser.runtime.sendMessage({ type: "pw-reset-status" }).catch(() => null);
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

$("openOptionsBtn").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

$("resetBtn").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "reset-counter" });
  await loadData();
  renderStatus();
});

$("enabledChk").addEventListener("change", async (e) => {
  settings.enabled = e.target.checked;
  await FM.saveSettings(settings);
  notifyChanged();
  renderStatus();
});

$("changePwBtn").addEventListener("click", () => {
  $("changePwForm").classList.toggle("hidden");
});

$("savePwBtn").addEventListener("click", async () => {
  const msg = $("pwMsg");
  const oldH = await FM.hashPassword($("oldPw").value);
  if (settings.passwordHash && oldH !== settings.passwordHash) {
    msg.textContent = "Текущий пароль неверен."; return;
  }
  const a = $("newPw1").value, b = $("newPw2").value;
  if (a.length < 4) { msg.textContent = "Новый пароль слишком короткий."; return; }
  if (a !== b) { msg.textContent = "Новые пароли не совпадают."; return; }
  settings.passwordHash = await FM.hashPassword(a);
  await FM.saveSettings(settings);
  notifyChanged();
  ["oldPw", "newPw1", "newPw2"].forEach((id) => ($(id).value = ""));
  msg.textContent = "Пароль обновлён ✔";
});

$("lockAgainBtn").addEventListener("click", () => {
  unlocked = false;
  renderManage();
});

function notifyChanged() {
  browser.runtime.sendMessage({ type: "settings-changed" }).catch(() => {});
}

// ---------- Старт ----------
(async function init() {
  await loadData();
  renderStatus();
  renderManage();
  setInterval(async () => {
    await loadData();
    renderStatus();
  }, 15000);
})();
