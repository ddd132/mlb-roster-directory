import { escape } from "./mlb.js";
import { careerMetrics, careerSeasons, metricText, ROLES, sampleText, trendPoints } from "./career-metrics.js?v=1";

function axisRange(values, metric) {
  const lowest = Math.min(...values), highest = Math.max(...values);
  const precision = metric.innings ? 3 : 10 ** -metric.digits;
  const span = highest - lowest || Math.abs(highest) * 0.1 || precision * 4;
  const target = Math.max(precision, span / 4);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const rounded = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= target) * magnitude;
  const step = metric.innings ? 3 * Math.ceil(rounded / 3) : rounded;
  const padding = span * 0.06;
  let low = Math.floor((lowest - padding) / step) * step;
  const high = Math.ceil((highest + padding) / step) * step;
  if (lowest >= 0) low = Math.max(low, 0);
  return { low, high, step };
}

function chartMarkup(points, selected, metric, width, height) {
  const left = Math.max(45, Math.min(77, Math.max(...points.map(point => metricText(point.value, metric).length)) * 7 + 8));
  const right = width - 19;
  const top = 14;
  const bottom = height - 29;
  const start = points[0].year, end = points.at(-1).year;
  const x = year => start === end ? (left + right) / 2 : left + (right - left) * (year - start) / (end - start);
  const { low, high, step } = axisRange(points.flatMap(point => point.value === null ? [] : [point.value]), metric);
  const y = value => bottom - (bottom - top) * (value - low) / (high - low);
  const ticks = [];
  for (let i = 0; i <= Math.round((high - low) / step); i++) {
    const value = low + i * step;
    const position = y(value);
    ticks.push(`<line class="career-gridline" x1="${left}" x2="${right}" y1="${position}" y2="${position}"/>
      <text x="${left - 7}" y="${position + 4}" text-anchor="end">${metricText(Math.abs(value) < step / 100 ? 0 : value, metric)}</text>`);
  }
  const intervals = Math.min(end - start, Math.max(1, Math.min(8, Math.floor((right - left) / 51))));
  for (let i = 0; i <= intervals; i++) {
    const year = intervals === 0 ? start : start + Math.round((end - start) * i / intervals);
    ticks.push(`<text x="${x(year)}" y="${bottom + 20}" text-anchor="middle">${year}</text>`);
  }
  const path = points.map(({ year, value }, index) => {
    if (value === null) return "";
    const previous = points[index - 1];
    const join = previous && previous.year + 1 === year && previous.value !== null;
    return `${join ? "L" : "M"}${x(year)},${y(value)}`;
  }).join(" ");
  const dots = points.filter(point => point.value !== null).map(point =>
    `<circle class="career-dot${point.year === selected ? " career-active-dot" : ""}" cx="${x(point.year)}" cy="${y(point.value)}" r="${point.year === selected ? 5 : 3.6}"/>`,
  ).join("");
  const targets = points.map(({ year }, index) => {
    const current = x(year);
    const first = index === 0 ? left - 12 : (current + x(points[index - 1].year)) / 2;
    const last = index + 1 === points.length ? right + 12 : (current + x(points[index + 1].year)) / 2;
    return `<rect class="career-hit" data-career-point="${year}" x="${first}" y="0" width="${last - first}" height="${height}"/>`;
  }).join("");
  return `${ticks.join("")}
    <line class="career-guide" x1="${x(selected)}" x2="${x(selected)}" y1="${top}" y2="${bottom}"/>
    <path class="career-line" d="${path}"/>${dots}${targets}`;
}

function changeText(points, selected, metric) {
  const index = points.findIndex(point => point.year === selected);
  const current = points[index], previous = points[index - 1];
  if (current.value === null || !previous || previous.year + 1 !== current.year || previous.value === null) return "";
  const difference = current.value - previous.value;
  const direction = Math.sign(difference);
  if (direction === 0) return `與 ${previous.year} 年持平`;
  const context = direction > 0 ? "上升" : "下降";
  const change = metric.unit === "%" ? `${Math.abs(difference).toFixed(1)} 個百分點`
    : metric.innings ? `${metricText(Math.abs(difference), metric)} 局` : metricText(Math.abs(difference), metric);
  let streak = 1;
  for (let i = index - 1; i > 0; i--) {
    const before = points[i - 1], after = points[i];
    if (before.year + 1 !== after.year || before.value === null || Math.sign(after.value - before.value) !== direction) break;
    streak += 1;
  }
  return `較 ${previous.year} 年${context} ${change}${streak >= 2 ? ` · 連續 ${streak} 季${context}` : ""}`;
}

function sourceLink(key, metric) {
  if (key === "wRC+" || key === "ERA-") return '<a href="https://www.fangraphs.com/leaders/major-league" target="_blank" rel="noopener noreferrer">FanGraphs</a>';
  return metric.archive && !metric.read
    ? '<a href="https://baseballsavant.mlb.com/leaderboard/custom" target="_blank" rel="noopener noreferrer">Baseball Savant</a>'
    : '<a href="https://www.mlb.com/stats/" target="_blank" rel="noopener noreferrer">MLB 官方數據</a>';
}

export function renderCareerTrend(container, { id, name, rows, scope, preferredRole, definitions, totalRow, focus }) {
  const career = careerSeasons(rows, totalRow);
  if (!career.size) {
    container.innerHTML = '<div class="empty-state"><strong>這位球員在此賽事尚無 MLB 打擊或投球紀錄</strong><p>可切換例行賽與季後賽查看。</p></div>';
    return;
  }
  const query = new URLSearchParams(location.search);
  const scopeText = scope === "postseason" ? "MLB 季後賽" : "MLB 例行賽";
  let role = [query.get("trendRole"), preferredRole, ...career.keys()].find(key => career.has(key));
  let key = query.get("trendMetric") ?? "K%";
  let selected = Number(query.get("trendYear")) || null;
  let metrics;
  let points;
  let revision = 0;
  let observer;
  let bringIntoView = focus;
  container.innerHTML = `<section class="career-trend" aria-labelledby="career-title">
    <header class="career-heading"><div>
      <h3 id="career-title" tabindex="-1">生涯趨勢</h3>
      <p>${escape(name)} · ${scopeText}</p>
    </div><div class="career-controls">
      <label${career.size < 2 ? " hidden" : ""}>角色<select data-career-role>${[...career.keys()].map(value =>
        `<option value="${value}">${ROLES[value]}</option>`).join("")}</select></label>
      <label>指標<select data-career-metric></select></label>
    </div></header>
    <div class="career-output"></div>
  </section>`;
  const panel = container.firstElementChild;
  const metricSelect = panel.querySelector("[data-career-metric]");
  const roleSelect = panel.querySelector("[data-career-role]");
  const output = panel.querySelector(".career-output");

  function writeUrl() {
    const url = new URL(location.href);
    url.searchParams.set("trendRole", role);
    url.searchParams.set("trendMetric", key);
    if (selected) url.searchParams.set("trendYear", selected);
    else url.searchParams.delete("trendYear");
    history.replaceState(null, "", url);
  }

  function updateMetrics() {
    metrics = careerMetrics(definitions, role, scope);
    if (!metrics.has(key)) key = "K%";
    metricSelect.replaceChildren(...[...metrics].map(([value, metric]) => new Option(`${metric.name}（${value}）`, value)));
    metricSelect.value = key;
    roleSelect.value = role;
  }

  function paint() {
    const svg = output.querySelector(".career-plot");
    if (!svg) return;
    const bounds = svg.getBoundingClientRect();
    const width = Math.max(240, Math.round(bounds.width));
    const height = Math.max(180, Math.round(bounds.height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = chartMarkup(points, selected, metrics.get(key), width, height);
  }

  function selectYear(year) {
    const point = points?.find(item => item.year === year);
    if (!point) return;
    selected = year;
    writeUrl();
    const metric = metrics.get(key);
    const change = changeText(points, selected, metric);
    const detail = output.querySelector(".career-selected");
    detail.innerHTML = `<div class="career-selected-main"><strong>${year} 球季</strong><b>${metricText(point.value, metric)}</b>
      <span>${sampleText(point.sample, role)}</span></div>${change ? `<p>${change}</p>` : ""}`;
    for (const button of output.querySelectorAll("button[data-career-point]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.careerPoint) === selected));
    }
    paint();
  }

  function showFocusedTrend() {
    if (!bringIntoView) return;
    bringIntoView = false;
    panel.querySelector("h3").focus({ preventScroll: true });
    panel.scrollIntoView({ behavior: "instant", block: "start" });
  }

  async function refresh() {
    const request = ++revision;
    observer?.disconnect();
    output.setAttribute("aria-busy", "true");
    output.innerHTML = '<p class="loading-message" role="status">正在讀取逐季數據…</p>';
    const metric = metrics.get(key);
    writeUrl();
    try {
      const series = await trendPoints(career.get(role), metric, key, role, id);
      if (request !== revision || !panel.isConnected) return;
      points = series;
      const valid = points.filter(point => point.value !== null);
      if (!points.some(point => point.year === selected)) selected = (valid.at(-1) ?? points.at(-1)).year;
      const missing = points.some((point, i) => point.value === null || (i > 0 && point.year !== points[i - 1].year + 1));
      output.innerHTML = `<div class="career-results">
        <div class="career-chart">
          <h4>${metric.name} <span>${key}</span></h4>
          <div class="career-selected" aria-live="polite" aria-atomic="true"></div>
          ${valid.length ? '<svg class="career-plot" aria-hidden="true"></svg>' :
            '<p class="career-message">此球員在選定賽事沒有這項數值，可切換其他指標。</p>'}
          <p class="career-note">${[valid.length ? "點圖上年份或表格球季即可查看樣本。" : "",
            missing ? "缺值或未出賽年份的折線保留空白。" : "",
            metric.description ? metric.description + "。" : "",
          ].join("")} ${sourceLink(key, metric)}</p>
        </div>
        <div class="career-table-wrap" role="region" aria-label="逐季數值與樣本" tabindex="0">
          <table class="career-table"><thead><tr><th scope="col">球季</th><th scope="col">${key}</th>
            <th scope="col">${role === "hitting" ? "打席數" : "投球局數"}</th></tr></thead><tbody>
            ${[...points].reverse().map(({ year, value, sample }) => `<tr><th scope="row"><button type="button"
              data-career-point="${year}" aria-pressed="false">${year}</button></th>
              <td>${metricText(value, metric)}</td><td>${sampleText(sample, role)}</td></tr>`).join("")}
          </tbody></table>
        </div></div>`;
      selectYear(selected);
      const svg = output.querySelector(".career-plot");
      if (svg) {
        const sizes = new ResizeObserver(() => {
          if (svg.isConnected) paint();
          else sizes.disconnect();
        });
        sizes.observe(svg);
        observer = sizes;
      }
      showFocusedTrend();
    } catch (error) {
      if (request !== revision || !panel.isConnected) return;
      console.warn("Could not load career trend data", error);
      output.innerHTML = '<p class="career-message">暫時無法讀取這項逐季數據。</p><button class="retry-button" data-career-retry type="button">重新載入</button>';
      showFocusedTrend();
    } finally {
      if (request === revision) output.setAttribute("aria-busy", "false");
    }
  }

  roleSelect.addEventListener("change", () => {
    role = roleSelect.value;
    selected = null;
    updateMetrics();
    void refresh();
  });
  metricSelect.addEventListener("change", () => {
    key = metricSelect.value;
    void refresh();
  });
  output.addEventListener("click", event => {
    const target = event.target.closest("[data-career-point]");
    if (target) selectYear(Number(target.dataset.careerPoint));
    else if (event.target.closest("[data-career-retry]")) void refresh();
  });
  updateMetrics();
  void refresh();
}
