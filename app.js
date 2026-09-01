/* Расписание Лесгафта — личная версия. Данные лежат в data/*.json,
   их обновляет fetch_data.py (вручную или через GitHub Actions). */

"use strict";

const $ = (sel) => document.querySelector(sel);
const DAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const DAY_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTHS_SHORT = ["янв.", "февр.", "марта", "апр.", "мая", "июня",
  "июля", "авг.", "сент.", "окт.", "нояб.", "дек."];

const data = {
  meta: null,
  groups: [],
  teachers: [],
  cabinets: [],
  weeks: [], // [{start, lessons: [...]}]
};

const state = loadState() || {
  mode: "group",            // group | teacher | cabinet
  sel: { group: null, teacher: null, cabinet: null },
  view: "day",              // day | week
  weekIdx: 0,
  weekday: null,            // 1..7, null = автоматически (сегодня)
};

function loadState() {
  try { return JSON.parse(localStorage.getItem("lt_state_v1")); } catch { return null; }
}
function saveState() {
  try { localStorage.setItem("lt_state_v1", JSON.stringify(state)); } catch { /* приватный режим — не страшно */ }
}

/* ---------- разбор названий аудиторий ---------- */
function cabinetInfo(name) {
  if (!name) return { title: "", url: null };
  const m = name.match(/https?:\/\/\S+/);
  if (m) return { title: name.slice(0, m.index).trim() || "онлайн", url: m[0] };
  return { title: name.trim(), url: null };
}

/* база имени: срезаем ТОЛЬКО хвостовое «(число)» — «Зал атлетизма (1)» → «Зал атлетизма»,
   а «Ауд. №1 каф. ТиМ атлетизма» или «Ауд. 103 (Наб. р. Мойки)» не трогаем */
function cabinetBase(title) {
  return title.replace(/\s*\(\d+\)\s*$/, "");
}

/* объединяем одноимённые аудитории: id -> {title, ids[]} */
function buildCabinetGroups() {
  const byBase = new Map();
  data.cabinets.forEach((c) => {
    const info = cabinetInfo(c.name);
    const base = info.url ? info.title : cabinetBase(info.title);
    const key = base.toLowerCase();
    if (!byBase.has(key)) byBase.set(key, { title: base, ids: [] });
    byBase.get(key).ids.push(c.id);
  });
  data.cabGroup = new Map();
  byBase.forEach((g) => g.ids.forEach((id) => data.cabGroup.set(id, g)));
}

function badgeClass(type) {
  if (!type) return "";
  const t = type.toLowerCase();
  if (t.includes("онлайн")) return "online";
  if (t.includes("лекци")) return "lecture";
  if (t.includes("практи")) return "practice";
  if (t.includes("консульт")) return "consult";
  return "lecture";
}

function parseMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function dateOf(weekStart, weekday) {
  const d = new Date(weekStart + "T00:00:00");
  d.setDate(d.getDate() + (weekday - 1));
  return d;
}
function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/* ---------- фильтрация ---------- */
function lessonMatches(lesson, mode, id) {
  if (mode === "group") return lesson.groups.some((g) => g.id === id);
  if (mode === "teacher") return lesson.teachers.some((t) => t.id === id);
  if (mode === "cabinet") {
    if (!lesson.cabinet) return false;
    const grp = data.cabGroup && data.cabGroup.get(id);
    return grp ? grp.ids.includes(lesson.cabinet.id) : lesson.cabinet.id === id;
  }
  return false;
}

function lessonsFor(weekIdx, mode, id) {
  const week = data.weeks[weekIdx];
  if (!week || id == null) return [];
  return week.lessons.filter((l) => lessonMatches(l, mode, id));
}

/* ---------- загрузка ---------- */
async function boot() {
  $("#content").innerHTML = '<div class="loading">Загружаю расписание…</div>';
  try {
    const meta = await (await fetch("data/meta.json", { cache: "no-cache" })).json();
    const [groups, teachers, cabinets, ...weeks] = await Promise.all([
      fetch("data/groups.json").then((r) => r.json()),
      fetch("data/teachers.json").then((r) => r.json()),
      fetch("data/cabinets.json").then((r) => r.json()),
      ...meta.weeks.map((w) => fetch("data/" + w.file, { cache: "no-cache" }).then((r) => r.json())),
    ]);
    data.meta = meta;
    data.groups = groups.sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
    data.teachers = teachers.sort((a, b) => a.fio.localeCompare(b.fio, "ru"));
    data.cabinets = cabinets;
    data.weeks = weeks;
    buildCabinetGroups();

    if (meta.siteName) $("#siteName").textContent = meta.siteName;
    const upd = (meta.updatedAt || "").slice(5).replace(/^(\d\d)-(\d\d) /, "$2.$1 в ");
    $("#updatedAt").textContent = upd ? "Обновлено " + upd : "";

    // не даём сохранённому состоянию указывать на несуществующую неделю
    if (state.weekIdx >= data.weeks.length) state.weekIdx = 0;
    autoPickToday();
    renderAll();
  } catch (err) {
    console.error(err);
    $("#content").innerHTML = '<div class="load-error">Не удалось загрузить данные 😕<br>Проверь интернет и обнови страницу.</div>';
  }
}

/* при заходе показываем сегодняшний день, если он есть в загруженных неделях */
function autoPickToday() {
  const today = new Date();
  data.weeks.forEach((w, i) => {
    for (let wd = 1; wd <= 7; wd++) {
      if (sameDate(dateOf(w.weekStart, wd), today)) {
        if (state.weekday == null) { state.weekIdx = i; state.weekday = wd; }
      }
    }
  });
  if (state.weekday == null) { state.weekIdx = 0; state.weekday = 1; }
}

/* ---------- отрисовка ---------- */
function renderAll() {
  renderModes();
  renderPickerBtn();
  renderControls();
  renderContent();
  saveState();
}

function renderModes() {
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  });
}

function currentSelection() {
  const id = state.sel[state.mode];
  if (id == null) return null;
  if (state.mode === "group") return data.groups.find((g) => g.id === id) || null;
  if (state.mode === "teacher") return data.teachers.find((t) => t.id === id) || null;
  const c = data.cabinets.find((x) => x.id === id);
  return c || null;
}

function selectionTitle() {
  const cur = currentSelection();
  if (!cur) return null;
  if (state.mode === "group") return cur.name;
  if (state.mode === "teacher") return cur.fio;
  const grp = data.cabGroup && data.cabGroup.get(cur.id);
  return grp ? grp.title : cabinetInfo(cur.name).title;
}

function renderPickerBtn() {
  const label = $("#pickerLabel");
  const title = selectionTitle();
  label.textContent = title || { group: "Выбрать группу…", teacher: "Выбрать преподавателя…", cabinet: "Выбрать аудиторию…" }[state.mode];
  label.classList.toggle("placeholder", !title);
}

function fmtRange(weekStart) {
  const a = dateOf(weekStart, 1);
  const b = dateOf(weekStart, 7);
  const f = (d) => d.getDate() + (a.getMonth() === b.getMonth() ? "" : " " + MONTHS_GEN[d.getMonth()].slice(0, 3));
  return f(a) + " – " + b.getDate() + " " + MONTHS_GEN[b.getMonth()].slice(0, 3);
}

function renderControls() {
  const has = state.sel[state.mode] != null;
  $("#controls").hidden = !has;
  $("#daystrip").hidden = !has || state.view !== "day";
  if (!has) return;

  // недели (в виде «Месяц» не нужны — месяц и так виден целиком)
  const weeksEl = $("#weeks");
  weeksEl.hidden = state.view === "month";
  weeksEl.innerHTML = "";
  data.weeks.forEach((w, i) => {
    const chip = document.createElement("button");
    chip.className = "week-chip" + (i === state.weekIdx ? " active" : "");
    chip.textContent = i === 0 ? "Эта неделя" : i === 1 ? "Следующая" : fmtRange(w.weekStart);
    chip.title = fmtRange(w.weekStart);
    chip.onclick = () => { state.weekIdx = i; renderAll(); };
    weeksEl.appendChild(chip);
  });

  // переключатель вида
  document.querySelectorAll("#viewToggle button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });

  // полоса дней
  const strip = $("#daystrip");
  strip.innerHTML = "";
  const week = data.weeks[state.weekIdx];
  const mode = state.mode, id = state.sel[mode];
  const today = new Date();
  const daysWith = new Set(lessonsFor(state.weekIdx, mode, id).map((l) => l.weekday));
  for (let wd = 1; wd <= 7; wd++) {
    const d = dateOf(week.weekStart, wd);
    const btn = document.createElement("button");
    btn.className = "day-btn"
      + (wd === state.weekday ? " active" : "")
      + (sameDate(d, today) ? " today" : "")
      + (wd >= 6 ? " weekend" : "")
      + (daysWith.has(wd) ? " has" : "");
    btn.innerHTML = `<span class="dw">${DAY_NAMES[wd - 1]}</span><span class="dn">${d.getDate()}</span><span class="dot"></span>`;
    btn.onclick = () => { state.weekday = wd; state.view = "day"; renderAll(); };
    strip.appendChild(btn);
  }
}

function lessonRow(lesson) {
  const today = new Date();
  const week = data.weeks[state.weekIdx];
  const isToday = sameDate(dateOf(week.weekStart, lesson.weekday), today);
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const endMin = parseMin(lesson.end);
  const isNow = isToday && lesson.startMin != null && endMin != null && nowMin >= lesson.startMin && nowMin < endMin;

  const row = document.createElement("div");
  row.className = "ev" + (isNow ? " now" : "");

  const meta = [];
  if (lesson.type) meta.push(`<span class="ev-type ${badgeClass(lesson.type)}">${esc(lesson.type)}</span>`);
  if (lesson.teachers.length) {
    meta.push(lesson.teachers.map((t) =>
      `<button class="chip-link teacher-link" data-id="${t.id}">${esc(t.fio)}</button>`).join(", "));
  }
  if (lesson.cabinet) {
    const info = cabinetInfo(lesson.cabinet.name);
    meta.push(`<button class="chip-link cab-chip" data-id="${lesson.cabinet.id}">${esc(info.title)}</button>` +
      (info.url ? ` <a class="web-link" href="${esc(info.url)}" target="_blank" rel="noopener">подключиться ↗</a>` : ""));
  }
  const showGroups = state.mode !== "group" || lesson.groups.length > 1;
  if (showGroups && lesson.groups.length) {
    meta.push(lesson.groups.map((g) => {
      const sub = g.subgroup && typeof g.subgroup === "object" ? g.subgroup.name : g.subgroup;
      return esc(g.name) + (sub ? ` <span class="subgroup">(${esc(String(sub))})</span>` : "");
    }).join(", "));
  }

  row.innerHTML = `
    <span class="ev-bar ${badgeClass(lesson.type)}"></span>
    <div class="ev-main">
      <div class="ev-title">${esc(lesson.subject || "Занятие")}${isNow ? '<span class="now-tag">● идёт</span>' : ""}</div>
      <div class="ev-meta">${meta.join('<span class="sep"> · </span>')}</div>
    </div>
    <div class="ev-time">
      <b>${esc(lesson.start || "")}</b><span>${esc(lesson.end || "")}</span>${lesson.num ? `<em>${lesson.num} пара</em>` : ""}
    </div>`;

  row.querySelectorAll(".teacher-link").forEach((el) => {
    el.onclick = () => { state.mode = "teacher"; state.sel.teacher = Number(el.dataset.id); renderAll(); scrollTop(); };
  });
  row.querySelectorAll(".cab-chip").forEach((el) => {
    el.onclick = () => { state.mode = "cabinet"; state.sel.cabinet = Number(el.dataset.id); renderAll(); scrollTop(); };
  });
  return row;
}

function scrollTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }

function dayHeader(weekStart, wd, count) {
  const d = dateOf(weekStart, wd);
  const el = document.createElement("div");
  el.className = "day-head" + (sameDate(d, new Date()) ? " today" : "");
  el.innerHTML = `${DAY_FULL[wd - 1]} — ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}` +
    (count ? ` <span class="cnt">· ${count} ${plural(count, "пара", "пары", "пар")}</span>` : "");
  return el;
}

/* день как секция: заголовок + белая группа строк занятий */
function renderDaySection(content, wd, lessons, emptyText) {
  const week = data.weeks[state.weekIdx];
  content.appendChild(dayHeader(week.weekStart, wd, lessons.length));
  if (!lessons.length) {
    const e = document.createElement("div");
    e.className = "empty-day";
    e.textContent = emptyText;
    content.appendChild(e);
    return;
  }
  const grp = document.createElement("div");
  grp.className = "ev-group";
  lessons.forEach((l) => grp.appendChild(lessonRow(l)));
  content.appendChild(grp);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function renderContent() {
  const content = $("#content");
  content.innerHTML = "";
  const id = state.sel[state.mode];
  if (id == null) {
    content.innerHTML = `<div class="hero"><div class="hero-emoji">🗓️</div>
      <p>Выбери ${{ group: "группу", teacher: "преподавателя", cabinet: "аудиторию" }[state.mode]} —<br>и здесь появится расписание.</p></div>`;
    return;
  }
  const week = data.weeks[state.weekIdx];
  const lessons = lessonsFor(state.weekIdx, state.mode, id);

  if (state.view === "month") {
    renderMonthView(content, id);
  } else if (state.view === "day") {
    const dayLessons = lessons.filter((l) => l.weekday === state.weekday);
    renderDaySection(content, state.weekday, dayLessons, "Занятий нет 🎉");
  } else {
    let shown = 0;
    for (let wd = 1; wd <= 7; wd++) {
      const dayLessons = lessons.filter((l) => l.weekday === wd);
      if (!dayLessons.length) continue;
      shown++;
      renderDaySection(content, wd, dayLessons, "");
    }
    if (!shown) {
      const e = document.createElement("div");
      e.className = "empty-day";
      e.textContent = "На этой неделе занятий нет 🎉";
      content.appendChild(e);
    }
  }
}

/* ---------- вид «Месяц»: календарная сетка месяца выбранной недели ---------- */
function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* короткое имя типа занятия для клетки календаря */
function typeShort(t) {
  if (!t) return "";
  const s = t.toLowerCase();
  if (s.includes("практ")) return "Практ.";
  if (s.includes("семинар")) return "Семинар";
  if (s.includes("консульт")) return "Конс.";
  if (s.includes("лаборат")) return "Лаб.";
  if (s.includes("зачёт") || s.includes("зачет")) return "Зачёт";
  if (s.includes("экзам")) return "Экзамен";
  if (s.includes("лекци")) return "Лекция";
  return t.split(" ")[0];
}

/* фамилия первого преподавателя без регалий: «Зуев А.Я.» */
function teacherShort(lesson) {
  const t = lesson.teachers && lesson.teachers[0];
  return t && t.fio ? t.fio.split(",")[0].trim() : "";
}

function renderMonthView(content, id) {
  const week = data.weeks[state.weekIdx];
  const anchor = dateOf(week.weekStart, state.weekday || 1);
  const y = anchor.getFullYear(), m = anchor.getMonth();

  // какие даты покрыты загруженными неделями и какие пары в каждой
  const lessonsByDate = new Map();
  const locByDate = new Map(); // дата -> {wi, wd}, чтобы по клику открыть день
  data.weeks.forEach((w, wi) => {
    for (let wd = 1; wd <= 7; wd++) locByDate.set(isoDate(dateOf(w.weekStart, wd)), { wi, wd });
    w.lessons.forEach((l) => {
      if (!lessonMatches(l, state.mode, id)) return;
      const key = isoDate(dateOf(w.weekStart, l.weekday));
      if (!lessonsByDate.has(key)) lessonsByDate.set(key, []);
      lessonsByDate.get(key).push(l);
    });
  });
  lessonsByDate.forEach((arr) => arr.sort((a, b) => (a.startMin || 0) - (b.startMin || 0)));

  const title = document.createElement("div");
  title.className = "cal-title";
  title.textContent = MONTHS_NOM[m] + " " + y;
  content.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "month-grid";
  DAY_NAMES.forEach((dn, i) => {
    const e = document.createElement("div");
    e.className = "month-dw" + (i >= 5 ? " weekend" : "");
    e.textContent = dn;
    grid.appendChild(e);
  });
  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Пн = 0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7; // добиваем сетку до полных недель
  const today = new Date();
  for (let i = 0; i < total; i++) {
    const dn = i - offset + 1;
    if (dn < 1 || dn > daysInMonth) {
      const e = document.createElement("div");
      e.className = "m-day blank";
      grid.appendChild(e);
      continue;
    }
    const d = new Date(y, m, dn);
    const key = isoDate(d);
    const loc = locByDate.get(key);
    const dayLessons = lessonsByDate.get(key) || [];
    const cell = document.createElement("button");
    cell.className = "m-day"
      + (loc ? "" : " off")
      + (dayLessons.length ? " has" : "")
      + (i % 7 >= 5 ? " weekend" : "")
      + (sameDate(d, today) ? " today" : "");
    const chips = dayLessons.map((l) => {
      const fio = state.mode !== "teacher" ? teacherShort(l) : "";
      return `<span class="ln"><b>${esc(l.start || "")}</b> ${esc(typeShort(l.type))}${fio ? ` <span class="fio">${esc(fio)}</span>` : ""}</span>`;
    }).join("");
    cell.innerHTML = `<span class="n">${dn}</span><span class="chips">${chips}</span>`;
    if (loc) {
      cell.onclick = () => { state.weekIdx = loc.wi; state.weekday = loc.wd; state.view = "day"; renderAll(); };
    } else {
      cell.disabled = true;
    }
    grid.appendChild(cell);
  }
  content.appendChild(grid);

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Серые числа — вне периода, на который вуз опубликовал расписание.";
  content.appendChild(hint);
}

/* ---------- шторка выбора ---------- */
let sheetItems = [];

function openSheet() {
  const overlay = $("#overlay");
  overlay.hidden = false;
  const input = $("#searchInput");
  input.value = "";
  input.placeholder = { group: "Найти группу…", teacher: "Найти преподавателя…", cabinet: "Найти аудиторию…" }[state.mode];
  buildSheetItems();
  renderSheetList("");
  if (matchMedia("(min-width: 700px)").matches) input.focus();
}

function closeSheet() { $("#overlay").hidden = true; }

function buildSheetItems() {
  if (state.mode === "group") {
    sheetItems = data.groups.map((g) => ({ id: g.id, title: g.name, sub: null, cnt: null }));
  } else if (state.mode === "teacher") {
    sheetItems = data.teachers.map((t) => ({ id: t.id, title: t.fio, sub: t.position, cnt: null }));
  } else {
    // аудитории: одноимённые объединены, пары считаем по сумме, занятые — наверх
    const counts = new Map();
    data.weeks.forEach((w) => w.lessons.forEach((l) => {
      if (l.cabinet) counts.set(l.cabinet.id, (counts.get(l.cabinet.id) || 0) + 1);
    }));
    const seen = new Set();
    sheetItems = [];
    data.cabinets.forEach((c) => {
      const grp = data.cabGroup.get(c.id);
      if (seen.has(grp)) return;
      seen.add(grp);
      const n = grp.ids.reduce((s, cid) => s + (counts.get(cid) || 0), 0);
      const info = cabinetInfo(c.name);
      const sub = info.url ? "онлайн-аудитория"
        : grp.ids.length > 1 ? `объединены: ${grp.ids.length} ${plural(grp.ids.length, "аудитория", "аудитории", "аудиторий")}` : null;
      sheetItems.push({ id: grp.ids[0], ids: grp.ids, title: grp.title, sub, cnt: n });
    });
    sheetItems.sort((a, b) => (b.cnt > 0) - (a.cnt > 0) || a.title.localeCompare(b.title, "ru", { numeric: true }));
  }
}

function renderSheetList(query) {
  const list = $("#sheetList");
  list.innerHTML = "";
  const q = query.trim().toLowerCase();
  const filtered = q ? sheetItems.filter((i) => (i.title + " " + (i.sub || "")).toLowerCase().includes(q)) : sheetItems;
  if (!filtered.length) {
    list.innerHTML = '<div class="sheet-note">Ничего не нашлось.</div>';
    return;
  }
  const selId = state.sel[state.mode];
  const frag = document.createDocumentFragment();
  filtered.slice(0, 400).forEach((item) => {
    const isSel = item.ids ? item.ids.includes(selId) : item.id === selId;
    const btn = document.createElement("button");
    btn.className = "sheet-item" + (isSel ? " selected" : "");
    btn.innerHTML = `<span>${esc(item.title)}${item.sub ? `<span class="sub">${esc(item.sub)}</span>` : ""}</span>` +
      (item.cnt != null ? `<span class="cnt">${item.cnt ? item.cnt + " " + plural(item.cnt, "пара", "пары", "пар") : "пусто"}</span>` : "");
    btn.onclick = () => {
      state.sel[state.mode] = item.id;
      closeSheet();
      renderAll();
    };
    frag.appendChild(btn);
  });
  if (filtered.length > 400) {
    const note = document.createElement("div");
    note.className = "sheet-note";
    note.textContent = "Показаны первые 400 — уточни поиск.";
    frag.appendChild(note);
  }
  list.appendChild(frag);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- обработчики ---------- */
document.querySelectorAll(".mode-btn").forEach((b) => {
  b.onclick = () => {
    state.mode = b.dataset.mode;
    renderAll();
    if (state.sel[state.mode] == null) openSheet();
  };
});
$("#pickerBtn").onclick = openSheet;
$("#sheetClose").onclick = closeSheet;
$("#overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); });
$("#searchInput").addEventListener("input", (e) => renderSheetList(e.target.value));
document.querySelectorAll("#viewToggle button").forEach((b) => {
  b.onclick = () => { state.view = b.dataset.view; renderAll(); };
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

boot();
