import { escape, taipeiTime } from "./mlb.js";
import { buildPlayerIndex, searchPlayers } from "./player-search.js?v=2";
import { DEFAULT_AXES, median, minimumSample, SAMPLE_LIMIT, scatterMetrics, scatterPoints } from "./scatter-data.js?v=1";

export { prepareScatter } from "./scatter-data.js?v=1";

const LEAGUES = { MLB: "MLB 全聯盟", AL: "美國聯盟", NL: "國家聯盟" };
const count = new Intl.NumberFormat("zh-TW");

function scale(values, format, intervals) {
  const min = Math.min(...values), max = Math.max(...values);
  const precision = format === "IP" ? 3 : format === "%" ? .001 : 10 ** -(format ?? 0);
  const span = max - min || Math.abs(max) * .1 || precision * 4;
  const target = Math.max(precision, span / intervals);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 5, 10].map(value => value * magnitude).find(value => value >= target);
  const tick = format === "IP" ? 3 * Math.ceil(step / 3) : format === undefined ? Math.ceil(step) : step;
  const low = Math.floor((min - .045 * span) / tick) * tick;
  const high = Math.ceil((max + .045 * span) / tick) * tick;
  const base = min >= 0 ? Math.max(0, low) : low;
  const ticks = Array.from({ length: Math.round((high - base) / tick) + 1 }, (_, index) => {
    const value = base + tick * index;
    return Math.abs(value) < tick / 100 ? 0 : value;
  });
  return { map: value => (value - base) / (high - base), ticks };
}

function figure(points, width, height, xMetric, yMetric, format, middle) {
  const top = 31, right = width - 17, bottom = height - 45;
  const yScale = scale(points.map(point => point.y), yMetric.format, 5);
  const left = Math.max(45, Math.min(79, Math.max(...yScale.ticks.map(value => format(value, yMetric).length)) * 6.8 + 9));
  const xScale = scale(points.map(point => point.x), xMetric.format, Math.max(3, Math.min(7, Math.floor((right - left) / 54))));
  const x = value => left + (right - left) * xScale.map(value);
  const y = value => bottom - (bottom - top) * yScale.map(value);
  const grid = [
    ...xScale.ticks.map(value => `<line class="scatter-gridline" x1="${x(value)}" x2="${x(value)}" y1="${top}" y2="${bottom}"/>
      <text x="${x(value)}" y="${bottom + 17}" text-anchor="middle">${format(value, xMetric)}</text>`),
    ...yScale.ticks.map(value => `<line class="scatter-gridline" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/>
      <text x="${left - 7}" y="${y(value) + 4}" text-anchor="end">${format(value, yMetric)}</text>`),
  ].join("");
  const medianX = x(middle.x), medianY = y(middle.y);
  const bounds = { left, right, top, bottom };
  return {
    bounds, width, height,
    positions: points.map(point => ({ point, px: x(point.x), py: y(point.y) })),
    decorations: `${grid}
      <line class="scatter-median" x1="${medianX}" x2="${medianX}" y1="${top}" y2="${bottom}"/>
      <line class="scatter-median" x1="${left}" x2="${right}" y1="${medianY}" y2="${medianY}"/>
      <text class="scatter-axis" x="${left}" y="16">Y · ${yMetric.key}${yMetric.unit ? ` (${yMetric.unit.trim()})` : ""}</text>
      <text class="scatter-axis" x="${(left + right) / 2}" y="${height - 9}" text-anchor="middle">X · ${xMetric.key}${xMetric.unit ? ` (${xMetric.unit.trim()})` : ""}</text>`,
  };
}

function sourceText(archived, capturedAt, unavailable) {
  const official = '<a href="https://www.mlb.com/stats/" target="_blank" rel="noopener noreferrer">MLB 官方數據</a>';
  if (archived) return `兩軸與樣本採用 ${taipeiTime(capturedAt).date} 的同季資料快照。
    ${official} · <a href="https://baseballsavant.mlb.com/leaderboard/custom" target="_blank" rel="noopener noreferrer">Baseball Savant</a> ·
    <a href="https://www.fangraphs.com/leaders/major-league" target="_blank" rel="noopener noreferrer">FanGraphs</a>`;
  return `${unavailable ? "進階指標暫時無法載入。" : ""}${official}`;
}

function labelFor(player) {
  return `${player.label ? `<span>${escape(player.label)}</span> ` : ""}<span lang="en">${escape(player.name)}</span>`;
}

export function renderScatter(container, { rows, filters, definitions, data, numeric, display, club, profileHref, query, report }) {
  const { group, season, game, league } = filters;
  const batter = group === "hitting";
  const role = batter ? "打擊" : "投球";
  const sampleUnit = batter ? "打席" : "局";
  const metrics = scatterMetrics(definitions, group, data.board, numeric);
  const params = new URLSearchParams(location.search);
  const [defaultX, defaultY] = DEFAULT_AXES[group];
  let xKey = metrics.has(params.get("x")) ? params.get("x") : defaultX;
  let yKey = metrics.has(params.get("y")) ? params.get("y") : defaultY;
  if (xKey === yKey) yKey = xKey === defaultX ? defaultY : defaultX;
  let minimum = minimumSample(params.get("min"), group, game);
  let selected = /^\d{1,10}$/.test(params.get("focus") ?? "") ? Number(params.get("focus")) : null;
  let plotted = new Map();
  let searchIndex = [];
  let matches = new Set();
  let layout;
  let middle;
  let firstOption;
  let nearby = [];

  container.innerHTML = `<section class="league-scatter" aria-label="全聯盟雙指標散點圖">
    <div class="scatter-controls">
      <label>X 軸<select data-axis="x"></select></label>
      <label>Y 軸<select data-axis="y"></select></label>
      <label class="scatter-minimum">${batter ? "最低打席" : "最低投球局數"}<input data-scatter-min type="number"
        min="0" max="${SAMPLE_LIMIT}" step="1" value="${minimum}" inputmode="numeric"></label>
      <button type="button" class="source-link scatter-swap" data-scatter-swap>對調 X／Y</button>
    </div>
    <div class="scatter-body">
      <figure class="scatter-figure">
        <svg class="scatter-plot" role="img" aria-label="${season} 球季${role}散點圖"></svg>
        <p class="scatter-empty" role="status" hidden></p>
        <figcaption><span class="scatter-legend"><i aria-hidden="true"></i>一點一位球員</span>
          <span class="scatter-legend"><i aria-hidden="true"></i>圖中球員中位數</span></figcaption>
      </figure>
      <aside class="scatter-sidebar" aria-label="球員數值">
        <div class="scatter-matches" hidden></div>
        <div class="scatter-selection" aria-live="polite" aria-atomic="true"></div>
      </aside>
    </div>
    <p class="scatter-source"></p>
  </section>`;
  const panel = container.firstElementChild;
  const xSelect = panel.querySelector('select[data-axis="x"]');
  const ySelect = panel.querySelector('select[data-axis="y"]');
  const minInput = panel.querySelector("[data-scatter-min]");
  const svg = panel.querySelector(".scatter-plot");
  const empty = panel.querySelector(".scatter-empty");
  const choices = panel.querySelector(".scatter-matches");
  const selection = panel.querySelector(".scatter-selection");
  const source = panel.querySelector(".scatter-source");

  function format(value, metric) {
    return display(value, metric.format) + (metric.unit ?? "");
  }

  function writeSelection() {
    const url = new URL(location.href);
    for (const [field, value] of Object.entries({ x: xKey, y: yKey, min: minimum, focus: selected, q: query().trim() })) {
      if (value === null || value === "") url.searchParams.delete(field);
      else url.searchParams.set(field, value);
    }
    history.replaceState(null, "", url);
  }

  function populateAxis(select, key, other) {
    select.replaceChildren(...[...metrics.values()].map(metric => {
      const option = new Option(`${metric.name}（${metric.key}）`, metric.key);
      option.disabled = metric.key === other;
      return option;
    }));
    select.value = key;
  }

  function draw() {
    if (!plotted.size) return;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const width = Math.max(250, Math.round(bounds.width)), height = Math.max(200, Math.round(bounds.height));
    const xMetric = metrics.get(xKey), yMetric = metrics.get(yKey);
    layout = figure([...plotted.values()], width, height, xMetric, yMetric, format, middle);
    const dots = [], highlighted = [];
    for (const { point, px, py } of layout.positions) {
      const active = point.id === selected;
      const match = matches.has(point.id);
      const className = active ? "scatter-active" : match ? "scatter-match" : matches.size ? "scatter-dim" : "";
      const dot = `<circle class="scatter-dot ${className}" data-scatter-id="${point.id}" cx="${px}" cy="${py}" r="${active ? 5.9 : match ? 4.3 : width > 500 ? 3.1 : 2.55}">
        <title>${escape(point.row.player.fullName)} · ${xKey} ${format(point.x, xMetric)} · ${yKey} ${format(point.y, yMetric)}</title></circle>`;
      (active || match ? highlighted : dots).push(dot);
    }
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("aria-label", `${season} 球季${role}散點圖，X 軸 ${xKey}，Y 軸 ${yKey}，${plotted.size} 位球員`);
    svg.innerHTML = layout.decorations + dots.join("") + highlighted.join("");
  }

  function sampleText(point) {
    const sample = point.sample === null ? "—" : `${display(point.sample, batter ? undefined : "IP")} ${sampleUnit}`;
    return !batter && point.batters !== null ? `${sample} · ${count.format(point.batters)} 對戰打席` : sample;
  }

  function showSelection() {
    const point = plotted.get(selected);
    if (!point) {
      selection.innerHTML = '<p class="scatter-hint">點圖上的球員或搜尋姓名，查看兩項數值與球季樣本。</p>';
      return;
    }
    const { row, player } = point;
    const team = club(row);
    const detail = [[xKey, point.x], [yKey, point.y]].map(([key, value]) => {
      const metric = metrics.get(key);
      return `<div><dt>${metric.name}<small>${key}</small></dt><dd>${format(value, metric)}</dd></div>`;
    }).join("");
    const alternatives = nearby.length > 1 ? `<label class="scatter-nearby">鄰近球員
      <select data-scatter-nearby>${nearby.map(id => {
        const player = plotted.get(id).player;
        return `<option value="${id}"${id === selected ? " selected" : ""}>${escape(player.label || player.name)}</option>`;
      }).join("")}</select></label>` : "";
    selection.innerHTML = `<h3>${labelFor(player)}</h3><p class="scatter-team">${escape(team.label)} · ${sampleText(point)}</p>
      <dl>${detail}</dl><a class="source-link scatter-profile" href="${profileHref(row)}">查看球員卡</a>${alternatives}`;
  }

  function select(id, focusLink = false, close = []) {
    if (!plotted.has(id)) return;
    selected = id;
    nearby = close;
    writeSelection();
    showSelection();
    draw();
    if (focusLink) selection.querySelector("a")?.focus({ preventScroll: true });
  }

  function updateSearch() {
    const text = query().trim();
    const found = text ? searchPlayers(searchIndex, text) : [];
    matches = new Set(found.map(player => player.id));
    firstOption = found[0]?.id;
    choices.hidden = !text;
    choices.innerHTML = !text ? "" : found.length
      ? `<p>找到 ${count.format(found.length)} 位圖中球員</p><ul>${found.slice(0, 7).map(player =>
        `<li><button type="button" data-scatter-pick="${player.id}">${labelFor(player)}</button></li>`).join("")}</ul>`
      : '<p role="status">圖中的球員沒有符合此搜尋。可調低樣本門檻或換個姓名。</p>';
    writeSelection();
    draw();
  }

  function applyFilters() {
    populateAxis(xSelect, xKey, yKey);
    populateAxis(ySelect, yKey, xKey);
    minInput.value = minimum;
    const xMetric = metrics.get(xKey), yMetric = metrics.get(yKey);
    const { points, eligible, archived } = scatterPoints(rows, { group, minimum, xMetric, yMetric, board: data.board, numeric });
    plotted = new Map(points.map(point => {
      const aliases = data.labels[point.id] ?? [];
      return [point.id, { ...point, player: { id: point.id, name: point.row.player.fullName, label: aliases[0], aliases } }];
    }));
    searchIndex = buildPlayerIndex([...plotted.values()].map(point => point.player));
    if (!plotted.has(selected)) selected = null;
    nearby = [];
    layout = null;
    middle = points.length ? { x: median(points.map(point => point.x)), y: median(points.map(point => point.y)) } : null;
    svg.toggleAttribute("hidden", !points.length);
    svg.replaceChildren();
    empty.hidden = Boolean(points.length);
    empty.textContent = points.length ? "" : "沒有球員同時符合樣本門檻且具備兩項數值。";
    report(`${LEAGUES[league]} · ${game === "P" ? "季後賽" : "例行賽"} · ${count.format(points.length)} 位球員${eligible > points.length ? `（${count.format(eligible - points.length)} 位缺少任一指標）` : ""}`);
    source.innerHTML = sourceText(archived, data.capturedAt, data.unavailable);
    updateSearch();
    showSelection();
  }

  for (const [which, control] of [["x", xSelect], ["y", ySelect]]) {
    control.addEventListener("change", () => {
      if (which === "x") xKey = control.value;
      else yKey = control.value;
      applyFilters();
    });
  }

  function updateMinimum() {
    const next = minimumSample(minInput.value, group, game);
    if (next === minimum) return;
    minimum = next;
    applyFilters();
  }

  minInput.addEventListener("input", () => {
    if (/^\d+$/.test(minInput.value)) updateMinimum();
  });
  minInput.addEventListener("change", () => {
    updateMinimum();
    minInput.value = minimum;
  });
  panel.querySelector("[data-scatter-swap]").addEventListener("click", () => {
    [xKey, yKey] = [yKey, xKey];
    applyFilters();
  });
  choices.addEventListener("click", event => {
    const button = event.target.closest("[data-scatter-pick]");
    if (button) select(Number(button.dataset.scatterPick));
  });
  selection.addEventListener("change", event => {
    if (!event.target.hasAttribute("data-scatter-nearby")) return;
    select(Number(event.target.value), false, nearby);
    selection.querySelector("select")?.focus({ preventScroll: true });
  });
  svg.addEventListener("click", event => {
    if (!layout) return;
    const pos = svg.getBoundingClientRect();
    const px = (event.clientX - pos.left) * layout.width / pos.width;
    const py = (event.clientY - pos.top) * layout.height / pos.height;
    const { left, right, top, bottom } = layout.bounds;
    if (px < left - 10 || px > right + 10 || py < top - 10 || py > bottom + 10) return;
    const order = layout.positions.map(dot => ({ ...dot, distance: (dot.px - px) ** 2 + (dot.py - py) ** 2 }))
      .filter(dot => dot.distance <= 17 ** 2).sort((a, b) => a.distance - b.distance);
    const nearest = order[0];
    if (!nearest) return;
    const close = order.filter(dot => (dot.px - nearest.px) ** 2 + (dot.py - nearest.py) ** 2 <= 8 ** 2)
      .slice(0, 6).map(dot => dot.point.id);
    select(nearest.point.id, false, close);
  });
  applyFilters();
  const sizes = new ResizeObserver(() => {
    if (panel.isConnected) draw();
    else sizes.disconnect();
  });
  sizes.observe(svg);
  return { updateSearch, chooseFirst: () => select(firstOption, true) };
}
