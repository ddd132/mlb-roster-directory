import { escape, fetchPitchArsenal, fetchPlayerSplits } from "./mlb.js?v=2";
import { loadPlayerPercentiles, loadStatArchive } from "./percentiles.js?v=4";

const ROLES = { hitting: "打擊", pitching: "投球" };
export const AXES = {
  hitting: [
    ["火力", "Barrel%", "SLG"], ["接觸", "Whiff%", "K%"], ["選球", "Chase%", "BB%"],
    ["打擊產出", "wRC+", "OPS"], ["跑速", "Sprint"],
  ],
  pitching: [
    ["三振", "K%", "K/9"], ["揮空", "Whiff%"], ["控球", "BB%", "BB/9"],
    ["壓制強擊", "Hard-Hit%"], ["防失分", "ERA-", "ERA"],
  ],
};
const GROUPS = { month: "逐月", hand: "左右對戰", venue: "主客場" };
const METRICS = {
  hitting: {
    ops: "OPS", avg: "打擊率", obp: "上壘率", slg: "長打率", homeRuns: "全壘打",
    kRate: "三振率", bbRate: "保送率",
  },
  pitching: {
    ops: "被 OPS", era: "ERA", whip: "WHIP", avg: "被打擊率", obp: "被上壘率",
    slg: "被長打率", kRate: "三振率", bbRate: "保送率",
  },
};
const PITCH_TYPES = {
  FF: "四縫線", SI: "伸卡球", FT: "二縫線", FC: "卡特球", SL: "滑球", ST: "橫掃滑球",
  CU: "曲球", KC: "彈指曲球", CH: "變速球", FS: "指叉球", FO: "叉指球", SV: "滑曲球",
  KN: "蝴蝶球", EP: "超慢球", CS: "慢曲球", SC: "螺旋球",
};
const requests = new Map();
const numberFormat = new Intl.NumberFormat("zh-TW");
const fixed = (value, decimals) => value.toFixed(decimals).replace(/^0[.]/, ".");

function numeric(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cached(key, load) {
  if (!requests.has(key)) {
    requests.set(key, load().catch(error => {
      requests.delete(key);
      throw error;
    }));
  }
  return requests.get(key);
}

function totalStat(rows) {
  return rows.find(row => !row.team?.id)?.stat ?? (rows.length === 1 ? rows[0].stat : null);
}

function opportunities(stat, role) {
  return numeric(role === "hitting" ? stat?.plateAppearances : stat?.battersFaced);
}

function sampleLabel(stat, role) {
  const sample = opportunities(stat, role);
  if (sample == null) return "樣本數未提供";
  const count = numberFormat.format(sample);
  if (role === "hitting") return `${count} 打席`;
  return `${count} 對戰打席${/^\d+\.[012]$/.test(stat.inningsPitched) ? ` · ${stat.inningsPitched} 局` : ""}`;
}

function metricValue(stat, key, role) {
  if (!stat || !(opportunities(stat, role) > 0)) return null;
  if (key === "kRate" || key === "bbRate") {
    const count = numeric(key === "kRate" ? stat.strikeOuts : stat.baseOnBalls);
    return count == null ? null : 100 * count / opportunities(stat, role);
  }
  const value = numeric(stat[key]);
  return value != null && value >= 0 ? value : null;
}

function formatMetric(value, key) {
  if (value == null) return "—";
  if (key === "kRate" || key === "bbRate") return `${value.toFixed(1)}%`;
  if (key === "homeRuns") return numberFormat.format(value);
  if (key === "era" || key === "whip") return value.toFixed(2);
  return fixed(value, 3);
}

export function axisMagnitude(value, key) {
  if (value == null) return "—";
  if (key.endsWith("%")) return `${value.toFixed(1)}%`;
  if (key === "Sprint") return `${value.toFixed(1)} ft/s`;
  if (["OPS", "SLG"].includes(key)) return fixed(value, 3);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function radarAxes(profile, role) {
  return AXES[role].map(([label, ...choices]) => {
    const key = choices.find(item => Number.isFinite(profile?.values.get(item)?.[1])) ?? choices[0];
    const [value, rank, reference] = profile?.values.get(key) ?? [];
    return { label, key, value, rank: Number.isFinite(rank) ? rank : null, reference };
  });
}

function radarMarkup(axes) {
  const point = (index, ratio) => {
    const angle = index * 2 * Math.PI / axes.length - Math.PI / 2;
    return [180 + 91 * ratio * Math.cos(angle), 137 + 91 * ratio * Math.sin(angle)];
  };
  const pointsAt = ratio => axes.map((_, i) => point(i, ratio).join(",")).join(" ");
  const observed = axes.map((axis, i) => axis.rank == null ? null : point(i, axis.rank / 100));
  const complete = observed.every(Boolean);
  const grid = [0.25, 0.5, 0.75, 1].map(ratio =>
    `<polygon class="ab-ring${ratio === 0.5 ? " ab-mid-ring" : ""}" points="${pointsAt(ratio)}"/>`).join("");
  const spokes = axes.map((_, i) => {
    const [x, y] = point(i, 1);
    return `<line class="ab-spoke" x1="180" y1="137" x2="${x}" y2="${y}"/>`;
  }).join("");
  const edges = observed.map((vertex, i) => {
    const next = observed[(i + 1) % observed.length];
    return vertex && next
      ? `<line class="ab-radar-edge" x1="${vertex[0]}" y1="${vertex[1]}" x2="${next[0]}" y2="${next[1]}"/>`
      : "";
  }).join("");
  const labels = axes.map((axis, i) => {
    const [x, y] = point(i, 1.39);
    const dy = i === 0 ? 12 : 0;
    return `<text class="ab-axis-label" x="${x}" y="${y + dy}" text-anchor="middle">${axis.label}
      <tspan class="ab-axis-rank" x="${x}" dy="17">${axis.rank ?? "—"}</tspan></text>`;
  }).join("");
  const dots = observed.map(vertex => vertex
    ? `<circle class="ab-vertex" cx="${vertex[0]}" cy="${vertex[1]}" r="4"/>` : "").join("");
  return `<svg class="ab-radar" viewBox="0 0 360 278" role="img" aria-label="${escape(axes.map(axis =>
    `${axis.label} PR ${axis.rank ?? "缺值"}`).join("、"))}">
    ${grid}${spokes}${complete ? `<polygon class="ab-radar-fill" points="${observed.map(p => p.join(",")).join(" ")}"/>` : ""}
    ${edges}${dots}${labels}</svg>`;
}

function showRadar(panel, profile, role) {
  const axes = radarAxes(profile, role);
  if (!axes.some(axis => axis.rank != null)) {
    panel.innerHTML = '<p class="ab-message">這個球季尚無可用的同季百分位。</p>';
    return;
  }
  const sample = profile.sample < profile.minimum ? " · 小樣本" : "";
  const hasReference = axes.some(axis => axis.reference);
  panel.innerHTML = `<div class="ab-radar-layout">${radarMarkup(axes)}
    <ul class="ab-axis-list">${axes.map(axis => `<li><span><strong>${axis.label}</strong><small>${axis.key}</small></span>
      <span><strong>${axis.rank == null ? "—" : "PR " + axis.rank + (axis.reference ? "＊" : "")}</strong>
      <small>${axisMagnitude(axis.value, axis.key)}</small></span></li>`).join("")}</ul></div>
    <p class="ab-note">${numberFormat.format(profile.sample)} ${role === "hitting" ? "打席" : "對戰打席"}${sample} · 同季 MLB 例行賽百分位，越外側越靠前${hasReference ? " · ＊為參考 PR" : ""}</p>`;
}

function monthPoints(data) {
  const present = [...data.keys()].map(Number).filter(month => Number.isInteger(month) && month >= 1 && month <= 12);
  if (!present.length) return [];
  const first = Math.min(...present);
  return Array.from({ length: Math.max(...present) - first + 1 }, (_, i) => {
    const month = first + i;
    return { label: `${month}月`, stat: data.get(String(month)) };
  });
}

function pairPoints(data, kind, role) {
  if (kind === "venue") return [{ label: "主場", stat: data.get("h") }, { label: "客場", stat: data.get("a") }];
  const label = role === "hitting" ? "投" : "打";
  return [{ label: `對左${label}`, stat: data.get("vl") }, { label: `對右${label}`, stat: data.get("vr") }];
}

function chartDescription(points, role, key) {
  return escape(points.map(point =>
    `${point.label} ${formatMetric(point.value, key)}${point.value == null ? "" : "，" + sampleLabel(point.stat, role)}`).join("、"));
}

function monthChart(points, role, key, label, overall) {
  if (!points.some(p => p.value != null)) return '<p class="ab-message">這個球季沒有可畫出的逐月數據。</p>';
  const data = points.map(point => point.value).filter(value => value != null);
  if (overall != null) data.push(overall);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pad = Math.max((max - min) * 0.18, key === "homeRuns" ? 1 : key.endsWith("Rate") ? 1 : 0.025);
  const floor = Math.max(0, min - pad);
  const ceil = max + pad;
  const x = i => (i + 0.5) * 100 / points.length;
  const y = value => 100 * (ceil - value) / (ceil - floor);
  const ticks = [0, 33.33, 66.67, 100];
  let connected = false;
  const linePath = points.map((point, i) => {
    if (point.value == null) {
      connected = false;
      return "";
    }
    const command = connected ? "L" : "M";
    connected = true;
    return `${command} ${x(i)} ${y(point.value)}`;
  }).join(" ");
  const latest = points.findLastIndex(point => point.value != null);
  const detail = index => `${points[index].label} · ${label} ${formatMetric(points[index].value, key)} · ${sampleLabel(points[index].stat, role)}`;
  return `<div class="ab-month-chart" style="--ab-months:${points.length}">
    <div class="ab-y-axis" aria-hidden="true">${ticks.map(tick =>
      `<span style="--ab-y:${tick}%">${formatMetric(ceil - tick * (ceil - floor) / 100, key)}</span>`).join("")}</div>
    <div class="ab-plot" role="img" aria-label="逐月 ${label}，${chartDescription(points, role, key)}">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${ticks.map(tick => `<line class="ab-plot-grid" x1="0" x2="100" y1="${tick}" y2="${tick}"/>`).join("")}
        ${overall == null ? "" : `<line class="ab-season-line" x1="0" x2="100" y1="${y(overall)}" y2="${y(overall)}"/>`}
        <path class="ab-trend-line" d="${linePath}"/>
      </svg>
      ${points.map((point, i) => point.value == null ? "" :
        `<span class="ab-month-dot${i === latest ? " ab-active-dot" : ""}" data-point="${i}"
        style="--ab-x:${x(i)}%;--ab-y:${y(point.value)}%" aria-hidden="true"></span>`).join("")}
    </div>
    <div class="ab-month-tabs" aria-label="查看月份">${points.map((point, i) =>
      `<button type="button" data-month-index="${i}" aria-pressed="${i === latest}"${point.value == null ? " disabled" : ""}
      aria-label="${point.value == null ? point.label + " 無紀錄" : escape(detail(i))}">${point.label}</button>`).join("")}</div>
    </div><div class="ab-chart-detail">
      <p class="ab-month-detail" aria-live="polite">${detail(latest)}</p>
      ${overall == null ? "" : `<span class="ab-season-legend">整季 ${formatMetric(overall, key)}</span>`}</div>`;
}

function barChart(points, role, key, label, overall) {
  if (!points.some(point => point.value != null)) return '<p class="ab-message">沒有這個情境的數據。</p>';
  const max = Math.max(0.01, overall ?? 0, ...points.map(point => point.value ?? 0)) * 1.08;
  return `<div class="ab-bars" role="group" aria-label="${label}，${chartDescription(points, role, key)}">
    ${points.map(point => `<div class="ab-split-bar">
      <div><strong>${point.label}</strong><small>${point.stat ? sampleLabel(point.stat, role) : "無紀錄"}</small></div>
      <div class="ab-bar-track" aria-hidden="true">
        ${point.value == null ? "" : `<div style="--ab-bar:${100 * point.value / max}%"></div>`}
        ${overall == null ? "" : `<span style="--ab-x:${100 * overall / max}%"></span>`}</div>
      <strong>${formatMetric(point.value, key)}</strong></div>`).join("")}</div>
    ${overall == null ? "" : `<span class="ab-season-legend">整季 ${formatMetric(overall, key)}</span>`}`;
}

function showSplits(panel, rows, role, wholeSeason) {
  const byCode = Map.groupBy(rows, row => row.split.code);
  const data = new Map([...byCode].map(([code, records]) => [code, totalStat(records)]));
  const controls = panel.querySelector(".ab-split-controls");
  const metric = panel.querySelector("#ab-split-metric");
  const chart = panel.querySelector(".ab-split-output");
  if (![...data.values()].some(Boolean)) {
    chart.innerHTML = '<p class="ab-message">MLB 目前沒有提供這個球季的 Splits 紀錄。</p>';
    return;
  }
  controls.hidden = false;
  let kind = "month";
  let points = [];

  function renderSplit() {
    const key = metric.value;
    const label = METRICS[role][key];
    const total = key === "homeRuns" ? null : metricValue(wholeSeason, key, role);
    points = (kind === "month" ? monthPoints(data) : pairPoints(data, kind, role))
      .map(point => ({ ...point, value: metricValue(point.stat, key, role) }));
    chart.innerHTML = kind === "month" ? monthChart(points, role, key, label, total)
      : barChart(points, role, key, label, total);
  }

  function selectGroup(next) {
    kind = next;
    const prior = metric.value;
    const options = Object.entries(METRICS[role]).filter(([key]) => kind !== "hand" || !["era", "whip"].includes(key));
    metric.replaceChildren(...options.map(([key, label]) => new Option(label, key)));
    metric.value = options.some(([key]) => key === prior) ? prior : "ops";
    for (const button of controls.querySelectorAll("[data-split]")) {
      button.setAttribute("aria-pressed", String(button.dataset.split === kind));
    }
    renderSplit();
  }

  controls.addEventListener("click", event => {
    const next = event.target.closest("[data-split]")?.dataset.split;
    if (next) selectGroup(next);
  });
  metric.addEventListener("change", renderSplit);
  chart.addEventListener("click", event => {
    const button = event.target.closest("[data-month-index]");
    if (!button) return;
    const index = Number(button.dataset.monthIndex);
    const point = points[index];
    const key = metric.value;
    for (const item of chart.querySelectorAll("[data-month-index]")) item.setAttribute("aria-pressed", String(item === button));
    for (const dot of chart.querySelectorAll("[data-point]")) dot.classList.toggle("ab-active-dot", Number(dot.dataset.point) === index);
    chart.querySelector(".ab-month-detail").textContent =
      `${point.label} · ${METRICS[role][key]} ${formatMetric(point.value, key)} · ${sampleLabel(point.stat, role)}`;
  });
  selectGroup("month");
}

function showPerformance(panel, stats, role, profile, woba) {
  const baseline = role === "hitting" ? ["wOBA", woba?.[0]] : ["ERA", numeric(stats?.era)];
  const expectedKey = role === "hitting" ? "xwOBA" : "xERA";
  const expected = role === "hitting" ? woba?.[1] : null;
  const values = [baseline, [expectedKey, expected ?? profile?.values.get(expectedKey)?.[0]]]
    .filter(([, value]) => Number.isFinite(value) && value >= 0);
  if (!values.length) return;
  const max = Math.max(0.01, ...values.map(([, value]) => value)) * 1.08;
  panel.hidden = false;
  panel.innerHTML = `<h3>球季表現</h3><div class="ab-bars">${values.map(([label, value]) =>
    `<div class="ab-split-bar"><strong>${label}</strong><div class="ab-bar-track" aria-hidden="true">
    <div style="--ab-bar:${100 * value / max}%"></div></div><strong>${formatMetric(value, role === "hitting" ? "woba" : "era")}</strong></div>`
  ).join("")}</div><p class="ab-note">${sampleLabel(stats, role)}${values.some(([label]) => label === expectedKey) ? " · x 為預期數值" : ""}</p>`;
}

function showArsenal(panel, rows, whiffRates) {
  const pitches = rows.filter(row => row?.type?.code && row.count > 0
    && Number.isFinite(row.percentage) && row.percentage > 0 && row.percentage <= 1)
    .sort((a, b) => b.percentage - a.percentage);
  if (!pitches.length) return;
  panel.hidden = false;
  panel.innerHTML = `<h3>球種表現</h3><div class="ab-split-controls"><label>指標 <select>
    <option value="usage">使用率</option>${whiffRates ? '<option value="whiff">揮空率</option>' : ""}
    </select></label></div><div class="ab-bars"></div>`;
  const select = panel.querySelector("select");
  const bars = panel.querySelector(".ab-bars");
  function draw() {
    bars.innerHTML = pitches.map(pitch => {
      const code = pitch.type.code;
      const name = PITCH_TYPES[code] ?? pitch.type.description;
      const speed = Number.isFinite(pitch.averageSpeed) ? ` · ${pitch.averageSpeed.toFixed(1)} mph` : "";
      const value = select.value === "usage" ? pitch.percentage * 100 : whiffRates?.[code];
      const number = value == null ? "—" : `${value.toFixed(1)}%`;
      return `<div class="ab-split-bar"><div><strong>${escape(name)}</strong><small>${numberFormat.format(pitch.count)} 球${speed}</small></div>
        <div class="ab-bar-track" aria-hidden="true">${value == null ? "" : `<div style="--ab-bar:${value}%"></div>`}</div>
        <strong>${number}</strong></div>`;
    }).join("");
  }
  select.addEventListener("change", draw);
  draw();
}

function showPitchMatchups(panel, matchups) {
  const pitches = Object.entries(matchups ?? {}).sort((a, b) => b[1][3] - a[1][3]);
  if (!pitches.length) return;
  panel.hidden = false;
  panel.innerHTML = `<h3>面對各球種</h3><div class="ab-split-controls"><label>指標 <select>
    <option value="woba">wOBA</option><option value="whiff">揮空率</option></select></label></div>
    <div class="ab-bars"></div>`;
  const select = panel.querySelector("select");
  const bars = panel.querySelector(".ab-bars");
  const maxWoba = Math.max(...pitches.map(([, row]) => row[0]), 0.01) * 1.08;
  function draw() {
    const woba = select.value === "woba";
    bars.innerHTML = pitches.map(([code, [weighted, pa, whiff, count]]) => {
      const value = woba ? weighted : whiff;
      return `<div class="ab-split-bar"><div><strong>${PITCH_TYPES[code] ?? escape(code)}</strong>
        <small>${numberFormat.format(woba ? pa : count)} ${woba ? "打席" : "球"}</small></div>
        <div class="ab-bar-track" aria-hidden="true">${value == null ? "" : `<div style="--ab-bar:${woba ? 100 * value / maxWoba : value}%"></div>`}</div>
        <strong>${formatMetric(value, woba ? "woba" : "kRate")}</strong></div>`;
    }).join("");
  }
  select.addEventListener("change", draw);
  draw();
}

function showFielding(panel, record) {
  if (!record) return;
  const [runs, framing, blocking, throwing, running] = record;
  const parts = [["守備得分", runs], ["接捕", framing], ["擋球", blocking], ["阻殺", throwing], ["跑壘得分", running]]
    .filter(([, value]) => Number.isFinite(value));
  if (!parts.length) return;
  const max = Math.max(1, ...parts.map(([, value]) => Math.abs(value))) * 1.08;
  panel.hidden = false;
  panel.innerHTML = `<h3>守備與跑壘</h3><div class="ab-bars">${parts.map(([label, value]) => {
    const magnitude = 50 * Math.abs(value) / max;
    return `<div class="ab-split-bar"><strong>${label}</strong>
      <div class="ab-bar-track ab-diverging" aria-hidden="true"><div style="--ab-bar:${magnitude}%;--ab-start:${value < 0 ? 50 - magnitude : 50}%"></div><span style="--ab-x:50%"></span></div>
      <strong>${value > 0 ? "+" : ""}${value.toFixed(1)}</strong></div>`;
  }).join("")}</div><p class="ab-note">Statcast · 單位為分，0 為平均</p>`;
}

export function renderAbility(container, playerId, rows, scope) {
  const seasons = Map.groupBy(rows.filter(row => Object.hasOwn(ROLES, row.group)), row => row.season);
  const years = [...seasons.keys()].sort((a, b) => Number(b) - Number(a));
  if (!years.length) {
    container.innerHTML = '<p class="ab-message">這位球員在此賽事層級尚無打擊或投球紀錄。</p>';
    return;
  }
  const url = new URL(location.href);
  const requested = url.searchParams.get("abYear");
  const year = seasons.has(requested) ? requested : years[0];
  const roles = Object.keys(ROLES).filter(role => seasons.get(year).some(row => row.group === role));
  const requestedRole = url.searchParams.get("abRole");
  const role = roles.includes(requestedRole) ? requestedRole : roles[0];
  const wholeSeason = totalStat(seasons.get(year).filter(row => row.group === role));
  const regular = scope === "regular";
  container.innerHTML = `<section class="ab-view" aria-label="球員能力分析">
    <header class="ab-header"><div><h3>能力分析</h3><p>${year} 球季 · ${ROLES[role]} · MLB ${regular ? "例行賽" : "季後賽"}</p></div>
      <div class="ab-choices"><label for="ab-year">球季 <select id="ab-year">${years.map(value =>
        `<option value="${value}"${value === year ? " selected" : ""}>${value}</option>`).join("")}</select></label>
        ${roles.length < 2 ? "" : `<div class="scope-switch" role="group" aria-label="球員角色">${roles.map(value =>
          `<button type="button" data-ability-role="${value}" aria-pressed="${value === role}">${ROLES[value]}</button>`).join("")}</div>`}</div></header>
    ${regular ? '<section class="ab-card" aria-labelledby="ab-radar-title"><h3 id="ab-radar-title">能力五邊形</h3><div id="ab-radar-output" aria-busy="true"><p class="ab-message">正在讀取能力百分位…</p></div></section>' : ""}
    <section class="ab-card" id="ab-splits" aria-labelledby="ab-split-title">
      <h3 id="ab-split-title">情境數據 <small>Splits</small></h3>
      <div class="ab-split-controls" hidden><div class="scope-switch" role="group" aria-label="情境種類">${Object.entries(GROUPS).map(([code, label]) =>
        `<button type="button" data-split="${code}" aria-pressed="${code === "month"}">${label}</button>`).join("")}</div>
        <label for="ab-split-metric">指標 <select id="ab-split-metric"></select></label></div>
      <div class="ab-split-output" aria-busy="true"><p class="ab-message">正在讀取 MLB 情境數據…</p></div>
    </section>
    ${regular ? '<section class="ab-card" id="ab-performance" hidden></section><section class="ab-card" id="ab-pitches" hidden></section><section class="ab-card" id="ab-extra" hidden></section>' : ""}
    <p class="ab-note"><a href="https://www.mlb.com/stats/" target="_blank" rel="noopener noreferrer">MLB</a> · <a href="https://baseballsavant.mlb.com/leaderboard/percentile-rankings" target="_blank" rel="noopener noreferrer">Baseball Savant</a> · <a href="https://www.fangraphs.com/leaders/major-league" target="_blank" rel="noopener noreferrer">FanGraphs</a></p>
  </section>`;

  const view = container.querySelector(".ab-view");
  const pick = (key, value, focus) => {
    url.searchParams.set(key, value);
    history.replaceState(null, "", url);
    renderAbility(container, playerId, rows, scope);
    container.querySelector(focus)?.focus({ preventScroll: true });
  };
  view.querySelector("#ab-year").addEventListener("change", event => pick("abYear", event.target.value, "#ab-year"));
  for (const button of view.querySelectorAll("[data-ability-role]")) {
    const nextRole = button.dataset.abilityRole;
    button.addEventListener("click", () => pick("abRole", nextRole, `[data-ability-role="${nextRole}"]`));
  }

  const radar = view.querySelector("#ab-radar-output");
  if (regular) {
    const profile = loadPlayerPercentiles(year, role, playerId);
    profile.then(data => {
      if (view.isConnected) showRadar(radar, data, role);
    }).catch(error => {
      console.warn("Could not load player ability percentiles", error);
      if (view.isConnected) radar.innerHTML = '<p class="ab-message">能力百分位暫時無法載入。</p>';
    }).finally(() => radar.setAttribute("aria-busy", "false"));
    const savant = Number(year) < 2015 ? Promise.resolve(null)
      : cached("savant", () => loadStatArchive("ability-savant.json.gz?v=1")).then(data => data[year]).catch(error => {
        console.warn("Could not load Savant ability data", error);
        return null;
      });
    const performance = view.querySelector("#ab-performance");
    Promise.all([profile.catch(() => null), savant]).then(([data, comparison]) => {
      if (view.isConnected) showPerformance(performance, wholeSeason, role, data, comparison?.woba?.[playerId]);
    });
    const pitchPanel = view.querySelector("#ab-pitches");
    const extra = view.querySelector("#ab-extra");
    const supplemental = role === "pitching"
      ? Promise.all([cached(`pitches/${playerId}/${year}`, () => fetchPitchArsenal(playerId, year, scope)), savant])
        .then(([rows, data]) => { if (view.isConnected) showArsenal(pitchPanel, rows, data?.pitcher?.[playerId]); })
      : cached("fielding", () => loadStatArchive("ability-fielding.json.gz?v=1"))
        .then(data => { if (view.isConnected) showFielding(extra, data[year]?.[playerId]); });
    if (role === "hitting") savant.then(data => {
      if (view.isConnected) showPitchMatchups(pitchPanel, data?.batter?.[playerId]);
    });
    supplemental.catch(error => console.warn("Could not load supplementary ability data", error));
  }
  const splitPanel = view.querySelector("#ab-splits");
  const output = splitPanel.querySelector(".ab-split-output");
  const getSplits = () => cached(`splits/${playerId}/${year}/${role}/${scope}`,
    () => fetchPlayerSplits(playerId, year, role, scope)).then(data => {
    if (view.isConnected) showSplits(splitPanel, data, role, wholeSeason);
  }).catch(error => {
    console.warn("Could not load MLB splits", error);
    if (!view.isConnected) return;
    output.innerHTML = '<p class="ab-message">情境數據暫時無法載入。</p><button class="retry-button" type="button">重試</button>';
    output.querySelector("button").addEventListener("click", () => {
      output.setAttribute("aria-busy", "true");
      output.innerHTML = '<p class="ab-message">正在讀取 MLB 情境數據…</p>';
      void getSplits();
    });
  }).finally(() => output.setAttribute("aria-busy", "false"));
  void getSplits();
}
