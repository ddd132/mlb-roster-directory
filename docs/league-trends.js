import { leagueName } from "./history-data.js";
import { METRICS, formatValue, readSeasons } from "./league-metrics.js";

const byId = name => document.getElementById("tr-" + name);
const params = new URLSearchParams(location.search);
const labels = { MLB: "全聯盟", AL: "美聯", NL: "國聯" };
const labelFor = key => labels[key] ?? leagueName(key);
const groupTitle = role => role === "hitting" ? "打擊" : "投球";
const number = new Intl.NumberFormat("zh-TW");
const svg = byId("svg");
const controls = Object.fromEntries(["metric", "compare", "league", "from", "to", "year"].map(k => [k, byId(k)]));
const state = { role: params.get("group") === "pitching" ? "pitching" : "hitting" };
let seasons, years, series = [], chart, cursorLayer;

function options(select, pairs, value) {
  select.replaceChildren(...pairs.map(([key, label]) => new Option(label, key)));
  select.value = String(value);
}

function svgNode(tag, attrs, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (text != null) element.textContent = text;
  return element;
}

function metricLabel(key) {
  return METRICS[state.role][key][0] + "（" + key + "）";
}

function scaleGroup(key) {
  const kind = METRICS[state.role][key][1];
  if (kind !== "num") return kind;
  if (key.endsWith("/G")) return "teamGame";
  if (key.endsWith("/9") || key === "ERA" || key === "RA9") return "nineInnings";
  return key;
}

function updateMetrics() {
  const metrics = METRICS[state.role];
  if (!Object.hasOwn(metrics, state.metric)) state.metric = "K%";
  const peers = Object.keys(metrics).filter(k => k !== state.metric && scaleGroup(k) === scaleGroup(state.metric));
  if (!peers.includes(state.compare)) state.compare = "";
  options(controls.metric, Object.keys(metrics).map(k => [k, metricLabel(k)]), state.metric);
  options(controls.compare, [["", "單一指標"], ...peers.map(k => [k, metricLabel(k)])], state.compare);
  controls.compare.disabled = !peers.length;
  for (const button of document.querySelectorAll("[data-role]")) {
    button.setAttribute("aria-pressed", String(button.dataset.role === state.role));
  }
}

function valueFor(year, key) {
  const row = seasons.get(year)?.get(state.league);
  return row ? METRICS[state.role][key][3](row) : null;
}

function fmt(key, value) {
  return formatValue(value, METRICS[state.role][key][1]);
}

function writeUrl() {
  const url = new URL(location.href);
  const fields = {group: state.role, stat: state.metric, compare: state.compare || "none", league: state.league,
    from: state.from, to: state.to, year: state.year};
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  if (url.href !== location.href) history.replaceState(null, "", url);
}

function fitLeagueRange() {
  const covered = years.filter(year => seasons.get(year).has(state.league));
  const inView = covered.filter(year => year >= state.from && year <= state.to);
  if (!inView.length) {
    state.from = covered[0];
    state.to = covered.at(-1);
    state.year = state.to;
  } else if (!inView.includes(state.year)) {
    state.year = inView.reduce((closest, year) =>
      Math.abs(year - state.year) < Math.abs(closest - state.year) ? year : closest);
  }
}

function labelNode(key, index) {
  const span = document.createElement("span");
  span.className = "tr-series-label" + (index ? " tr-b" : "");
  span.textContent = key;
  return span;
}

function renderAnnual() {
  const row = seasons.get(state.year)?.get(state.league);
  const league = labelFor(state.league);
  byId("annual-title").textContent = state.year + " 年" + league + groupTitle(state.role) + "平均";
  const sampleKey = state.role === "hitting" ? "PA" : "TBF";
  const sampleLabel = state.role === "hitting" ? "打席" : "對戰打席";
  byId("sample").textContent = row ? [row.T + " 隊", number.format(row.G) + " 隊場",
    row[sampleKey] == null ? sampleLabel + "紀錄不全" : number.format(row[sampleKey]) + " " + sampleLabel].join(" · ")
    : "該聯盟本季沒有收錄紀錄";
  const grid = byId("metrics");
  if (grid.dataset.role !== state.role) {
    grid.dataset.role = state.role;
    grid.replaceChildren(...Object.keys(METRICS[state.role]).map(key => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.metric = key;
      const title = document.createElement("span");
      title.textContent = metricLabel(key);
      button.append(title, document.createElement("strong"));
      return button;
    }));
  }
  for (const button of grid.querySelectorAll("button")) {
    const key = button.dataset.metric;
    const value = valueFor(state.year, key);
    const strong = button.querySelector("strong");
    strong.textContent = fmt(key, value);
    if (value != null && METRICS[state.role][key][1] === "pp") {
      strong.textContent = value.toFixed(1) + " ";
      const unit = document.createElement("small");
      unit.textContent = "個百分點";
      strong.append(unit);
    }
    button.setAttribute("aria-pressed", String(key === state.metric));
  }
}

function renderSelection() {
  controls.year.value = String(state.year);
  byId("prev").disabled = state.year === state.from;
  byId("next").disabled = state.year === state.to;
  byId("reading").replaceChildren(...series.map(({key}, i) => {
    const wrapper = labelNode(key, i);
    const strong = document.createElement("strong");
    strong.textContent = fmt(key, valueFor(state.year, key));
    wrapper.append(strong);
    return wrapper;
  }));
  renderAnnual();
  if (!cursorLayer || !chart) return;
  const x = chart.x(state.year);
  cursorLayer.replaceChildren(svgNode("line", {x1:x, x2:x, y1:chart.top, y2:chart.bottom, class:"tr-cursor"}));
  for (const [i, {key}] of series.entries()) {
    const v = valueFor(state.year, key);
    if (v != null) cursorLayer.append(svgNode("circle", {cx:x, cy:chart.y(v), r:4.3, class:"tr-dot" + (i ? " tr-b" : "")}));
  }
}

function tickRange(values) {
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || Math.abs(min) * 0.1 || 1;
  const rough = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = ([1, 2, 2.5, 5, 10].find(v => v >= normalized) ?? 10) * magnitude;
  let low = Math.floor((min - span * 0.06) / step) * step;
  const high = Math.ceil((max + span * 0.06) / step) * step;
  if (min >= 0) low = Math.max(0, low);
  return {low, high, step};
}

function drawChart() {
  const width = Math.max(240, Math.round(svg.getBoundingClientRect().width));
  const height = Math.max(180, Math.round(svg.getBoundingClientRect().height));
  const left = 49, right = width - 16, top = 15, bottom = height - 29;
  const sample = series.flatMap(s => s.values.filter(v => v !== null));
  svg.setAttribute("viewBox", [0, 0, width, height].join(" "));
  svg.replaceChildren();
  cursorLayer = null;
  chart = null;
  byId("empty").hidden = sample.length > 0;
  const x = y => state.to === state.from ? (left + right) / 2 : left + (right-left)*(y-state.from)/(state.to-state.from);
  if (sample.length) {
    const {low, high, step} = tickRange(sample);
    const y = v => bottom - (bottom-top)*(v-low)/(high-low);
    chart = {x, y, top, bottom, left, right};
    const kind = METRICS[state.role][state.metric][1];
    for (let v=low, n=0; v<=high+step/10 && n<12; v=low+(++n)*step) {
      const raw = Math.abs(v) < step/100 ? 0 : v;
      const tick = kind === "pp" ? raw.toFixed(1) : fmt(state.metric, raw);
      svg.append(svgNode("line", {x1:left, x2:right, y1:y(v), y2:y(v), class:"tr-grid"}),
        svgNode("text", {x:left-7, y:y(v)+4, "text-anchor":"end"}, tick));
    }
    for (const [index, line] of series.entries()) {
      let segment = [];
      function flush() {
        if (segment.length === 1) {
          svg.append(svgNode("circle", {cx:segment[0][0], cy:segment[0][1], r:3, class:"tr-single" + (index ? " tr-b" : "")}));
        } else if (segment.length > 1) {
          svg.append(svgNode("polyline", {points:segment.map(p => p.join(",")).join(" "), class:"tr-line" + (index ? " tr-b" : "")}));
        }
        segment = [];
      }
      line.values.forEach((value, i) => {
        if (value == null) flush();
        else segment.push([x(state.from+i), y(value)]);
      });
      flush();
    }
    cursorLayer = svgNode("g", {"aria-hidden":"true"});
    svg.append(cursorLayer);
  }
  const count = Math.min(state.to-state.from+1, Math.max(2,Math.min(8,Math.floor((right-left)/65))));
  for (let i=0; i<count; i++) {
    const year = count===1 ? state.from : Math.round(state.from + i*(state.to-state.from)/(count-1));
    svg.append(svgNode("text", {x:x(year), y:bottom+20, "text-anchor":"middle"}, year));
  }
  renderSelection();
}

function renderTable() {
  const header = document.createElement("tr");
  for (const name of ["球季", ...series.map(s => s.key)]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = name;
    header.append(cell);
  }
  byId("thead").replaceChildren(header);
  const rows = [];
  for (let year=state.to; year>=state.from; year--) {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = year;
    row.append(heading);
    for (const {key, values} of series) {
      const cell = document.createElement("td");
      cell.textContent = fmt(key, values[year-state.from]);
      row.append(cell);
    }
    rows.push(row);
  }
  byId("tbody").replaceChildren(...rows);
}

function render() {
  updateMetrics();
  const visible = years.filter(y => y>=state.from && y<=state.to);
  state.year = Math.max(state.from, Math.min(state.to, state.year));
  controls.from.value = state.from;
  controls.to.value = state.to;
  options(controls.year, visible.slice().reverse().map(y => [y, y+" 年"]), state.year);
  series = [state.metric, state.compare].filter(Boolean).map(key => ({key, values:visible.map(y=>valueFor(y, key))}));
  const heading = series.map(s=>METRICS[state.role][s.key][0]).join("與");
  byId("title").textContent = heading;
  byId("chart-scope").textContent = [labelFor(state.league), groupTitle(state.role), state.from + "–" + state.to].join(" · ");
  byId("chart-description").textContent = heading + "按球季繪製。詳細數值可查看下方歷年數值表。";
  byId("legend").replaceChildren(...series.map((s,i)=>labelNode(s.key,i)));
  byId("formula").textContent = series.map(s=>s.key+" ＝ "+METRICS[state.role][s.key][2]).join("。") + "。";
  renderTable();
  drawChart();
  writeUrl();
}

function selectYear(year) {
  year = Math.round(Math.max(state.from, Math.min(state.to, year)));
  if (year === state.year) return;
  state.year = year;
  renderSelection();
  writeUrl();
}

function connect() {
  for (const button of document.querySelectorAll("[data-role]")) button.addEventListener("click", () => {
    state.role = button.dataset.role;
    render();
  });
  for (const key of ["metric", "compare", "league", "from", "to"]) controls[key].addEventListener("change", () => {
    state[key] = key === "from" || key === "to" ? Number(controls[key].value) : controls[key].value;
    if (key === "league") fitLeagueRange();
    if (key === "from" && state.from > state.to) state.to = state.from;
    if (key === "to" && state.to < state.from) state.from = state.to;
    render();
  });
  controls.year.addEventListener("change", () => selectYear(Number(controls.year.value)));
  byId("prev").addEventListener("click", () => selectYear(state.year-1));
  byId("next").addEventListener("click", () => selectYear(state.year+1));
  byId("metrics").addEventListener("click", event => {
    const button = event.target.closest("button[data-metric]");
    if (!button) return;
    state.metric = button.dataset.metric;
    render();
  });
  byId("chart").addEventListener("keydown", e => {
    const target = {ArrowLeft:state.year-1, ArrowRight:state.year+1, Home:state.from, End:state.to}[e.key];
    if (target !== undefined) {e.preventDefault(); selectYear(target);}
  });
  svg.addEventListener("click", e => {
    if (!chart) return;
    const pixel = e.clientX - svg.getBoundingClientRect().left;
    selectYear(state.from + (pixel-chart.left)*(state.to-state.from)/(chart.right-chart.left));
  });
  if ("ResizeObserver" in window) new ResizeObserver(drawChart).observe(svg);
  else window.addEventListener("resize", drawChart);
}

async function start() {
  const resp = await fetch("data/league-trends.json");
  if (!resp.ok) throw Error("無法讀取聯盟球季資料");
  seasons = readSeasons(await resp.json());
  years = [...seasons.keys()].sort((a,b)=>a-b);
  const leagues = new Set([...seasons.values()].flatMap(v=>[...v.keys()]));
  const order = ["MLB", "AL", "NL", ...[...leagues].filter(l=>!["MLB","AL","NL"].includes(l))];
  const yearParam = (key, fallback) => years.includes(Number(params.get(key))) ? Number(params.get(key)) : fallback;
  state.from = yearParam("from", Math.max(years[0], years.at(-1)-19));
  state.to = yearParam("to", years.at(-1));
  if (state.from > state.to) [state.from, state.to] = [state.to, state.from];
  state.year = yearParam("year", state.to);
  state.league = leagues.has(params.get("league")) ? params.get("league") : "MLB";
  if (!params.has("from") && !params.has("to")) fitLeagueRange();
  state.metric = params.get("stat") ?? "K%";
  state.compare = params.get("compare") ?? (state.metric === "K%" ? "BB%" : "");
  options(controls.league, order.map(l=>[l,labelFor(l)]), state.league);
  const choices = years.slice().reverse().map(y=>[y,y]);
  options(controls.from, choices, state.from); options(controls.to, choices, state.to);
  byId("scope").textContent = "MLB 例行賽 · " + years[0] + "–" + years.at(-1) + " 球季";
  byId("status").hidden = true;
  byId("dashboard").hidden = false;
  connect();
  render();
}

start().catch(() => {
  byId("dashboard").hidden = true;
  const status = byId("status");
  status.hidden = false;
  status.textContent = "歷年資料暫時無法載入。";
  const retry = document.createElement("button");
  retry.type = "button"; retry.className = "retry-button"; retry.textContent = "重新載入";
  retry.addEventListener("click", () => location.reload());
  status.append(" ", retry);
});
