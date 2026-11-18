import { axisMagnitude } from "./ability.js?v=2";
import { comparisonAxes, comparisonYears, loadComparisonSeason, ROLE_LABELS } from "./compare-data.js?v=1";
import { escape } from "./mlb.js";
import { buildPlayerIndex, searchPlayers } from "./player-search.js?v=2";

const count = new Intl.NumberFormat("zh-TW");
const metricNames = {
  "Barrel%": "紮實擊球率", SLG: "長打率", "Whiff%": "揮空率", "K%": "三振率", "K/9": "每九局三振",
  "Chase%": "追打率", "BB%": "保送率", "BB/9": "每九局保送", "wRC+": "加權得分創造指數",
  OPS: "攻擊指數", Sprint: "衝刺速度", SB: "盜壘成功", "Hard-Hit%": "被強勁擊球率",
  ERA: "防禦率", "ERA-": "校正防禦率指數", WHIP: "每局被上壘率", "H/9": "每九局被安打",
};
const inningMetrics = new Set(["ERA", "ERA-", "WHIP", "K/9", "BB/9", "H/9"]);
const labelsAt = [[180, 26], [306, 102], [268, 242], [92, 242], [54, 102]];
const series = ["solid", "dashed"];
const chartWidth = 360;
const chartHeight = 269;
const origin = [180, 132];

function point(index, ratio) {
  const angle = index * Math.PI * 2 / labelsAt.length - Math.PI / 2;
  return [origin[0] + 87 * Math.cos(angle) * ratio, origin[1] + 87 * Math.sin(angle) * ratio];
}

function line(className, from, to, attributes = "") {
  return `<line class="${className}" x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}"${attributes}/>`;
}

function trace(axes, index) {
  const type = series[index];
  const points = axes.map(({ points }, i) => Number.isFinite(points[index][1]) ? point(i, points[index][1] / 100) : null);
  const fill = points.every(Boolean) ? `<polygon class="cmp-fill cmp-${type}" points="${points.map(vertex => vertex.join(",")).join(" ")}"/>` : "";
  const edges = points.map((vertex, i) => {
    const next = points[(i + 1) % points.length];
    return vertex && next ? line(`cmp-edge cmp-${type}`, vertex, next) : "";
  }).join("");
  const markers = points.map(vertex => vertex
    ? `<circle class="cmp-vertex cmp-${type}" cx="${vertex[0]}" cy="${vertex[1]}" r="3.2"/>` : "").join("");
  return fill + edges + markers;
}

function radar(axes) {
  const rings = [0.25, 0.5, 0.75, 1].map(ratio => {
    const vertices = axes.map((_, i) => point(i, ratio).join(",")).join(" ");
    return `<polygon class="cmp-ring${ratio === 0.5 ? " cmp-mid-ring" : ""}" points="${vertices}"/>`;
  }).join("");
  const spokes = axes.map((_, i) => line("cmp-spoke", origin, point(i, 1), ` data-spoke="${i}"`)).join("");
  const hitAreas = axes.map((_, i) => line("cmp-axis-hit", point(i, 0.27), point(i, 1.10), ` data-axis="${i}"`)).join("");
  const buttons = axes.map(({ title, key }, i) => {
    const [x, y] = labelsAt[i];
    return `<button type="button" class="cmp-axis" data-axis="${i}" aria-pressed="false"
      style="left:${100 * x / chartWidth}%;top:${100 * y / chartHeight}%"><strong>${title}</strong><small>${key}</small></button>`;
  }).join("");
  return `<div class="cmp-radar" role="group" aria-label="雙人能力五邊形，可按指標查看數值">
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" aria-hidden="true">${rings}${spokes}
      ${trace(axes, 0)}${trace(axes, 1)}${hitAreas}</svg>
    ${buttons}
  </div>`;
}

function playerName(player) {
  return `${player.label ? `<span>${escape(player.label)}</span> ` : ""}<span lang="en">${escape(player.name)}</span>`;
}

function sampleText(profile, key, role) {
  const outs = profile.values.get("IP")?.[0];
  if (role === "pitching" && inningMetrics.has(key) && Number.isInteger(outs)) {
    return `${Math.trunc(outs / 3)}.${outs % 3} 局`;
  }
  if (key === "SLG" && Number.isFinite(profile.atBats)) return `${count.format(profile.atBats)} 打數`;
  if (!Number.isFinite(profile.sample)) return "樣本未提供";
  return `${count.format(profile.sample)} ${role === "hitting" ? "打席" : "對戰打席"}`;
}

function axisDetail(axis, players, profiles, role) {
  const { key, title, points } = axis;
  const definition = key === "OPS" && role === "pitching" ? "被攻擊指數" : metricNames[key];
  return `<h4>${title} <span>${definition} · ${key}</span></h4>
    <table class="cmp-values"><thead><tr><th scope="col">球員</th><th scope="col">實際值</th><th scope="col">PR</th><th scope="col">樣本</th></tr></thead>
      <tbody>${players.map((player, index) => {
        const [value, rank, reference] = points[index];
        const profile = profiles[index];
        const small = Number.isFinite(profile.minimum) && profile.sample < profile.minimum;
        const display = Number.isFinite(value) ? axisMagnitude(value, key) : "—";
        return `<tr><th scope="row"><span class="cmp-swatch cmp-${series[index]}" aria-hidden="true"></span>${playerName(player)}</th>
          <td><strong>${display}</strong></td>
          <td>${Number.isFinite(rank) ? `<strong>${rank}</strong>${reference ? "<small>參考</small>" : ""}` : "—"}</td>
          <td>${sampleText(profile, key, role)}${small ? "<small>小樣本</small>" : ""}</td></tr>`;
      }).join("")}</tbody></table>`;
}

function titleFor(scope) {
  return scope === "postseason" ? "季後賽" : "例行賽";
}

export function renderComparison(container, { id, name, preferredRole, rows, scope }) {
  const years = comparisonYears(rows);
  if (!years.size) {
    container.innerHTML = `<div class="empty-state"><strong>這位球員沒有 MLB ${titleFor(scope)}的打擊或投球紀錄</strong>
      <p>可從球員名單或排行榜選擇另一位球員。</p></div>`;
    return;
  }
  const url = new URL(location.href);
  const requestedYear = url.searchParams.get("compareYear");
  const requestedRole = url.searchParams.get("compareRole");
  const roleYear = [...years].find(([, roles]) => roles.has(requestedRole))?.[0];
  const vs = url.searchParams.get("vs") ?? "";
  let year = years.has(requestedYear) ? requestedYear : roleYear ?? years.keys().next().value;
  let role = chooseRole(requestedRole);
  let secondId = /^\d{1,10}$/.test(vs) && Number(vs) !== id ? Number(vs) : null;
  let selectedAxis = 0;
  let revision = 0;
  let season;
  let index;
  let suggestions;
  let players;
  let profiles;
  let axes;

  container.innerHTML = `<section class="comparison" aria-labelledby="comparison-title">
    <div class="cmp-heading"><div><h3 id="comparison-title">球員比較</h3><p>${escape(name)} · MLB ${titleFor(scope)}</p></div>
      <div class="cmp-filters">
        <label>球季<select data-compare-year>${[...years.keys()].map(value => `<option value="${value}">${value}</option>`).join("")}</select></label>
        <label>角色<select data-compare-role></select></label>
      </div>
    </div>
    <details class="cmp-picker" open>
      <summary>選第二位球員</summary>
      <label class="visually-hidden" for="compare-search">搜尋第二位球員</label>
      <input id="compare-search" type="search" autocomplete="off" placeholder="輸入英文姓名或中文譯名">
      <p class="cmp-message" data-picker-message aria-live="polite"></p>
      <ul class="cmp-options"></ul>
    </details>
    <div class="cmp-output"></div>
  </section>`;
  const panel = container.firstElementChild;
  const yearSelect = panel.querySelector("[data-compare-year]");
  const roleSelect = panel.querySelector("[data-compare-role]");
  const picker = panel.querySelector(".cmp-picker");
  const pickerTitle = picker.querySelector("summary");
  const search = panel.querySelector("input");
  const message = panel.querySelector("[data-picker-message]");
  const options = panel.querySelector(".cmp-options");
  const output = panel.querySelector(".cmp-output");

  function chooseRole(preference) {
    const roles = years.get(year);
    if (roles.has(preference)) return preference;
    return roles.has(preferredRole) ? preferredRole : roles.values().next().value;
  }

  function rememberSelection() {
    const current = new URL(location.href);
    current.searchParams.set("compareYear", year);
    current.searchParams.set("compareRole", role);
    if (secondId) current.searchParams.set("vs", secondId);
    else current.searchParams.delete("vs");
    history.replaceState(null, "", current);
  }

  function updateRoles() {
    roleSelect.innerHTML = Object.entries(ROLE_LABELS).filter(([value]) => years.get(year).has(value))
      .map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    yearSelect.value = year;
    roleSelect.value = role;
  }

  function showOptions() {
    if (!index) return;
    const query = search.value.trim();
    const candidates = query ? searchPlayers(index, query) : suggestions;
    const choices = candidates.filter(player => player.id !== secondId).slice(0, 6);
    const desc = `${year} 年${titleFor(scope)} · ${ROLE_LABELS[role]}`;
    message.textContent = choices.length ? (query ? desc : `${desc} · 可搜尋或從下方選擇`)
      : query ? `${desc} · 找不到符合姓名的球員` : "這個球季沒有其他可比較的球員。";
    options.innerHTML = choices.map(player => `<li><button type="button" data-select-player="${player.id}">
      <span>${playerName(player)}</span><small>${player.sample > 0
        ? `${count.format(player.sample)} ${role === "hitting" ? "打席" : "對戰打席"}` : ""}</small></button></li>`).join("");
  }

  function showAxis(axis) {
    selectedAxis = axis;
    for (const button of output.querySelectorAll("button[data-axis]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.axis) === axis));
    }
    for (const spoke of output.querySelectorAll("[data-spoke]")) {
      spoke.classList.toggle("cmp-active-spoke", Number(spoke.dataset.spoke) === axis);
    }
    output.querySelector(".cmp-detail").innerHTML = axisDetail(axes[axis], players, profiles, role);
  }

  function showPair(focusChart = false) {
    const first = season.players.get(id);
    const second = season.players.get(secondId);
    if (!first || !second) return;
    players = [first, second];
    profiles = [season.profile(id), season.profile(secondId)];
    axes = comparisonAxes(role, ...profiles);
    pickerTitle.textContent = "更換第二位球員";
    picker.open = false;
    const reference = season.source === "mlb" ? "參考 PR 以同季 MLB 有紀錄的球員計算。"
      : "參考 PR 以同季、同項已有排名的球員換算。";
    output.innerHTML = `<div class="cmp-figure">
      <ul class="cmp-legend" aria-label="球員圖例">${players.map((player, i) => `<li>
        <span class="cmp-swatch cmp-${series[i]}" aria-hidden="true"></span>
        <span class="visually-hidden">${i ? "虛線" : "實線"}</span>${playerName(player)}</li>`).join("")}</ul>
      <p class="cmp-chart-hint">點選指標看數值 · 越外側 PR 越高</p>
      ${radar(axes)}
      <div class="cmp-detail" aria-live="polite" aria-atomic="true"></div>
      <p class="cmp-note">${reference} Statcast 指標列出球季打席或對戰打席。缺少數值或 PR 時以「—」顯示。</p>
    </div>`;
    showAxis(selectedAxis);
    if (focusChart) output.querySelector(`button[data-axis="${selectedAxis}"]`).focus({ preventScroll: true });
  }

  async function refresh() {
    const request = ++revision;
    updateRoles();
    rememberSelection();
    season = null;
    index = null;
    search.value = "";
    search.disabled = true;
    options.replaceChildren();
    message.textContent = "正在載入同季球員…";
    output.innerHTML = '<p class="loading-message" role="status">正在讀取比較數據…</p>';
    try {
      const data = await loadComparisonSeason(year, role, scope, id);
      if (request !== revision || !panel.isConnected) return;
      season = data;
      if (!season.players.has(id)) {
        message.textContent = "目前無法讀取這位球員在所選球季的紀錄。可切換球季或角色。";
        picker.open = true;
        output.replaceChildren();
        return;
      }
      suggestions = [...season.players.values()].filter(player => player.id !== id)
        .sort((a, b) => (b.sample ?? 0) - (a.sample ?? 0) || a.name.localeCompare(b.name, "en"));
      index = buildPlayerIndex(suggestions);
      const missing = secondId && !season.players.has(secondId);
      if (missing) {
        secondId = null;
        rememberSelection();
      }
      search.disabled = false;
      showOptions();
      if (secondId) showPair();
      else {
        pickerTitle.textContent = "選第二位球員";
        picker.open = true;
        output.innerHTML = missing ? '<p class="cmp-message" role="status">原比較對象在這個球季或角色沒有紀錄。請重新選擇球員。</p>' : "";
      }
    } catch (error) {
      if (request !== revision || !panel.isConnected) return;
      console.warn("Could not load comparison statistics", error);
      message.textContent = "同季球員資料暫時無法載入。";
      picker.open = true;
      output.innerHTML = '<button type="button" class="retry-button" data-compare-retry>重新載入</button>';
    }
  }

  yearSelect.addEventListener("change", () => {
    year = yearSelect.value;
    role = chooseRole(role);
    selectedAxis = 0;
    void refresh();
  });
  roleSelect.addEventListener("change", () => {
    role = roleSelect.value;
    selectedAxis = 0;
    void refresh();
  });
  search.addEventListener("input", showOptions);
  search.addEventListener("keydown", event => {
    if (event.key === "Enter") options.querySelector("button")?.click();
  });
  options.addEventListener("click", event => {
    const button = event.target.closest("[data-select-player]");
    if (!button) return;
    const next = Number(button.dataset.selectPlayer);
    if (!season?.players.has(next) || next === id) return;
    secondId = next;
    selectedAxis = 0;
    rememberSelection();
    search.value = "";
    showOptions();
    showPair(true);
  });
  output.addEventListener("click", event => {
    const axis = event.target.closest("[data-axis]");
    if (axis) showAxis(Number(axis.dataset.axis));
    else if (event.target.closest("[data-compare-retry]")) void refresh();
  });
  void refresh();
}
