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
    return;
  }
  $("manageBlock").classList.add("hidden");
  $("lockBlock").classList.remove("hidden");
  if (!settings.passwordHash) {
    $("pwInput").classList.add("hidden");
    $("unlockBtn").classList.add("hidden");
    $("noPwHint").classList.remove("hidden");
  } else {
    $("pwInput").classList.remove("hidden");
    $("unlockBtn").classList.remove("hidden");
    $("noPwHint").classList.add("hidden");
  }
}

$("setPwBtn").addEventListener("click", async () => {
  const a = $("pwNew1").value, b = $("pwNew2").value;
  if (a.length < 4) { showPwError("Пароль должен быть не короче 4 символов."); return; }
  if (a !== b) { showPwError("Пароли не совпадают."); return; }
  settings.passwordHash = await FM.hashPassword(a);
  await FM.saveSettings(settings);
  notifyChanged();
  unlocked = true;
  renderManage();
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
