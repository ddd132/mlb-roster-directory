import { escape, mlbCalendarDate } from "./mlb.js";

const API = "https://statsapi.mlb.com/api/v1";
const PAGE_SIZE = 30;
const MAX_RESULTS = 2000;
const CACHE_DURATION = 5 * 60_000;
const MLB_LEAGUES = { MLB: null, AL: 103, NL: 104 };
const TYPES = { hitting: "打擊", pitching: "投球" };
const DEFAULT_METRIC = { hitting: "HR", pitching: "SO" };
const SECTIONS = { standard: "標準數據", expanded: "擴充數據" };

// MLB Player Stats field, with a display format for rate stats and innings.
const METRICS = {
  hitting: {
    standard: [
      ["G", "出賽", "gamesPlayed"], ["AB", "打數", "atBats"], ["R", "得分", "runs"],
      ["H", "安打", "hits"], ["2B", "二壘安打", "doubles"], ["3B", "三壘安打", "triples"],
      ["HR", "全壘打", "homeRuns"], ["RBI", "打點", "rbi"], ["BB", "四壞保送", "baseOnBalls"],
      ["SO", "被三振", "strikeOuts"], ["SB", "盜壘成功", "stolenBases"], ["CS", "盜壘失敗", "caughtStealing"],
      ["AVG", "打擊率", "avg", 3], ["OBP", "上壘率", "obp", 3], ["SLG", "長打率", "slg", 3], ["OPS", "攻擊指數", "ops", 3],
    ],
    expanded: [
      ["PA", "打席", "plateAppearances"], ["HBP", "觸身球", "hitByPitch"], ["SAC", "犧牲觸擊", "sacBunts"],
      ["SF", "高飛犧牲打", "sacFlies"], ["GIDP", "擊成雙殺", "groundIntoDoublePlay"],
      ["GO/AO", "滾地出局／飛球出局比", "groundOutsToAirouts", 2], ["XBH", "長打數", "extraBaseHits"],
      ["TB", "壘打數", "totalBases"], ["IBB", "故意四壞", "intentionalWalks"], ["BABIP", "場內安打率", "babip", 3],
      ["ISO", "純長打率", "iso", 3], ["AB/HR", "每轟所需打數", "atBatsPerHomeRun", 2],
      ["BB/K", "保送／三振比", "walksPerStrikeout", 3], ["BB%", "保送率", "walksPerPlateAppearance", "%"],
      ["K%", "三振率", "strikeoutsPerPlateAppearance", "%"],
    ],
  },
  pitching: {
    standard: [
      ["W", "勝投", "wins"], ["L", "敗投", "losses"], ["ERA", "防禦率", "era", 2], ["G", "登板", "gamesPitched"],
      ["GS", "先發", "gamesStarted"], ["CG", "完投", "completeGames"], ["SHO", "完封", "shutouts"],
      ["SV", "救援成功", "saves"], ["SVO", "救援機會", "saveOpportunities"], ["IP", "投球局數", "outs", "IP"],
      ["H", "被安打", "hits"], ["R", "失分", "runs"], ["ER", "自責分", "earnedRuns"], ["HR", "被全壘打", "homeRuns"],
      ["HB", "觸身球", "hitBatsmen"], ["BB", "四壞保送", "baseOnBalls"], ["SO", "三振", "strikeOuts"],
      ["WHIP", "每局被上壘率", "whip", 2], ["AVG", "被打擊率", "avg", 3],
    ],
    expanded: [
      ["TBF", "對戰打席", "battersFaced"], ["NP", "總用球數", "numberOfPitches"], ["P/IP", "平均每局用球數", "pitchesPerInning", 2],
      ["QS", "優質先發", "qualityStarts"], ["GF", "完成場次", "gamesFinished"], ["HLD", "中繼成功", "holds"],
      ["IBB", "故意四壞", "intentionalWalks"], ["WP", "暴投", "wildPitches"], ["BK", "投手犯規", "balks"],
      ["GDP", "製造雙殺", "groundIntoDoublePlay"], ["GO/AO", "滾地出局／飛球出局比", "groundOutsToAirouts", 2],
      ["SO/9", "每九局三振", "strikeoutsPer9Inn", 2], ["BB/9", "每九局保送", "walksPer9Inn", 2],
      ["K/BB", "三振／保送比", "strikeoutWalkRatio", 2], ["BABIP", "被場內安打率", "babip", 3],
      ["SB", "被盜壘成功", "stolenBases"], ["CS", "對手盜壘失敗", "caughtStealing"], ["PK", "牽制出局", "pickoffs"],
    ],
  },
};

const ASCENDING = {
  hitting: new Set(["AB/HR"]),
  pitching: new Set(["ERA", "WHIP", "AVG", "P/IP", "BB/9", "BABIP"]),
};
const PREFIX = "leader-";
const element = id => document.getElementById(PREFIX + id);
const params = new URLSearchParams(location.search);
const group = params.get("group") === "pitching" ? "pitching" : "hitting";
const state = {
  group,
  stat: params.get("stat") ?? DEFAULT_METRIC[group],
  season: params.get("season"),
  game: params.get("game") === "P" ? "P" : "R",
  league: Object.hasOwn(MLB_LEAGUES, params.get("league")) ? params.get("league") : "MLB",
  pool: ["all", "qualified"].includes(params.get("pool")) ? params.get("pool") : "auto",
  sort: ["asc", "desc"].includes(params.get("sort")) ? params.get("sort") : null,
  page: 1,
};

const cache = new Map();
const count = new Intl.NumberFormat("zh-TW");
const normalize = value => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
let currentBoard;
let latestRequest = 0;

function descriptor() {
  return Object.values(METRICS[state.group]).flat().find(([stat]) => stat === state.stat);
}

function defaultSort() {
  return ASCENDING[state.group].has(state.stat) ? "asc" : "desc";
}

function selectedPool(metric) {
  if (state.pool !== "auto") return state.pool;
  return metric[3] && metric[3] !== "IP" ? "qualified" : "all";
}

async function request(path, options) {
  const query = new URLSearchParams(options);
  const response = await fetch(`${API}${path}?${query}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`MLB Stats API returned HTTP ${response.status}`);
  return response.json();
}

async function getSeasons() {
  const date = mlbCalendarDate();
  try {
    const { seasons } = await request("/seasons/all", {
      sportId: 1, fields: "seasons,seasonId,regularSeasonStartDate,seasonStartDate",
    });
    const list = seasons.filter(season => /^\d{4}$/.test(season.seasonId)
      && (season.regularSeasonStartDate ?? season.seasonStartDate ?? "9999") <= date)
      .map(season => season.seasonId);
    if (list.length) return [...new Set(list)].sort().reverse();
  } catch (error) {
    console.warn("Could not get the MLB season list", error);
  }
  const year = Number(date.slice(0, 4));
  return Array.from({ length: year - 1875 }, (_, index) => String(year - index));
}

function statsRows(block) {
  if (!block) return [];
  const rows = block.splits ?? [];
  if (!Array.isArray(rows) || (Number.isInteger(block.totalSplits) && rows.length !== block.totalSplits)) {
    throw new Error("MLB returned an incomplete leaderboard");
  }
  return rows;
}

async function fetchBoard(filters) {
  const { group, season, game, league, pool } = filters;
  const fields = new Set([
    "stats", "group", "type", "displayName", "totalSplits", "splits", "stat", "season", "player", "id", "fullName",
    "team", "name", "numTeams", "position", "abbreviation", "plateAppearances", "battersFaced", "atBats", "outs",
    ...Object.values(METRICS[group]).flat().map(([, , field]) => field),
  ]);
  const key = [group, season, game, league, pool].join("/");
  const previous = cache.get(key);
  if (previous && Date.now() - previous.created < CACHE_DURATION) return previous.promise;

  const params = {
    sportIds: 1, stats: "season,seasonAdvanced", group, season, gameType: game,
    playerPool: pool === "qualified" ? "QUALIFIED" : "ALL", hydrate: "team", limit: MAX_RESULTS,
    sortStat: group === "hitting" ? "avg" : "era", fields: [...fields].join(","),
  };
  if (MLB_LEAGUES[league]) params.leagueIds = MLB_LEAGUES[league];
  const promise = request("/stats", params).then(result => {
    if (!Array.isArray(result.stats)) throw new Error("MLB did not return season stats");
    const blocks = result.stats.filter(block => block.group?.displayName === group);
    const standard = blocks.find(block => block.type?.displayName === "season");
    if (!standard && result.stats.length) throw new Error("MLB did not return the selected group");
    const expanded = blocks.find(block => block.type?.displayName === "seasonAdvanced");
    const additional = new Map(statsRows(expanded).map(row => [row.player?.id, row.stat]));
    const ids = new Set();
    return statsRows(standard).map(row => {
      const id = row.player?.id;
      if (row.season !== season || !Number.isSafeInteger(id) || !row.player.fullName || ids.has(id)) {
        throw new Error("MLB returned an unexpected season or duplicate player");
      }
      ids.add(id);
      return { ...row, stat: { ...additional.get(id), ...row.stat } };
    });
  }).catch(error => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { promise, created: Date.now() });
  return promise;
}

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return null;
  return Number(value);
}

function display(value, format) {
  if (value === null) return "—";
  if (format === "IP") return `${Math.floor(value / 3)}.${value % 3}`;
  if (format === "%") return `${(value * 100).toFixed(1)}%`;
  if (typeof format === "number") {
    const number = value.toFixed(format);
    return format === 3 && value < 1 && value >= 0 ? number.replace(/^0/, "") : number;
  }
  return count.format(value);
}

function rankRows(rows, metric, ascending) {
  const [, , field] = metric;
  const records = rows.map(row => ({ row, value: numeric(row.stat[field]) })).filter(record => record.value !== null);
  records.sort((a, b) => ((ascending ? 1 : -1) * (a.value - b.value))
    || a.row.player.fullName.localeCompare(b.row.player.fullName, "en") || a.row.player.id - b.row.player.id);
  let rank = 0;
  return records.map((record, index) => {
    if (!index || record.value !== records[index - 1].value) rank = index + 1;
    return { ...record, rank };
  });
}

function club(row) {
  if (row.numTeams > 1) return { label: `${row.numTeams} 隊合計`, name: "整季多隊成績合計" };
  return { label: row.team?.abbreviation ?? row.team?.name ?? "—", name: row.team?.name ?? "" };
}

function playerHref(row) {
  const params = new URLSearchParams({ id: row.player.id });
  if (row.numTeams <= 1 && row.team?.abbreviation) params.set("team", row.team.abbreviation);
  if (state.game === "P") params.set("scope", "postseason");
  return `player.html?${escape(params.toString())}`;
}

function renderRows() {
  if (!currentBoard) return;
  const { metric, ranked, pool } = currentBoard;
  const [key, name, , format] = metric;
  const search = normalize(element("search").value);
  const matches = search ? ranked.filter(({ row }) => normalize(row.player.fullName).includes(search)) : ranked;
  const pageCount = Math.ceil(matches.length / PAGE_SIZE);
  state.page = Math.max(1, Math.min(state.page, pageCount));
  const start = (state.page - 1) * PAGE_SIZE;
  const visible = matches.slice(start, start + PAGE_SIZE);
  const sampleField = state.group === "hitting" ? "plateAppearances" : "outs";
  const sampleLabel = state.group === "hitting" ? "PA" : "IP";
  const sampleFormat = state.group === "hitting" ? undefined : "IP";
  const showSample = key !== sampleLabel;
  const details = [state.league, state.game === "P" ? "季後賽" : "例行賽", pool === "qualified" ? "達官方門檻" : "全部球員"];
  details.push(`${count.format(matches.length)} 位${search ? `符合搜尋（全榜 ${count.format(ranked.length)} 位）` : "球員有數值"}`);
  element("status").textContent = details.join(" · ");
  element("pages").hidden = pageCount <= 1;
  element("page-status").textContent = `第 ${state.page}／${pageCount} 頁 · 第 ${start + 1}–${start + visible.length} 筆`;
  element("prev").disabled = state.page === 1;
  element("next").disabled = state.page >= pageCount;

  if (!visible.length) {
    element("results").innerHTML = `<div class="empty-state"><strong>${search ? "找不到符合的球員" : "目前沒有可排名的數據"}</strong><p>${search ? "請試試其他球員英文姓名。" : "可切換球季、項目或球員範圍。"}</p></div>`;
    return;
  }
  const rows = visible.map(({ row, value, rank }) => {
    const team = club(row);
    const position = row.position?.abbreviation;
    return `<tr><td class="leader-rank"><strong${rank <= 3 ? ' class="leader-top-rank"' : ""}>${rank}</strong></td>
      <th class="leader-player" scope="row"><a href="${playerHref(row)}">${escape(row.player.fullName)}</a>
        <small><span class="leader-mobile-club">${escape(team.label)}${position ? " · " : ""}</span>${escape(position)}</small></th>
      <td class="leader-club"><span class="leader-abbr" title="${escape(team.name)}">${escape(team.label)}</span></td>
      <td class="leader-value leader-number">${display(value, format)}</td>
      ${showSample ? `<td class="leader-number">${display(numeric(row.stat[sampleField]), sampleFormat)}</td>` : ""}</tr>`;
  }).join("");
  element("results").innerHTML = `<div class="leader-table-wrap"><table class="leader-table" aria-labelledby="leader-heading"><thead><tr>
    <th scope="col">名次</th><th scope="col">球員</th><th scope="col" class="leader-club">球隊</th>
    <th scope="col" class="leader-number" aria-sort="${state.sort === "asc" ? "ascending" : "descending"}" title="${name}">${key}</th>
    ${showSample ? `<th scope="col" class="leader-number" title="${sampleLabel === "PA" ? "打席" : "投球局數"}">${sampleLabel}</th>` : ""}
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

function writeUrl() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(state)) {
    if (key !== "page") url.searchParams.set(key, value);
  }
  history.replaceState(null, "", url);
}

async function refresh() {
  const request = ++latestRequest;
  const metric = descriptor();
  const pool = selectedPool(metric);
  const filters = { ...state, pool };
  const results = element("results");
  element("heading").textContent = `${state.season} ${metric[1]}排行`;
  const source = new URL(`https://www.mlb.com/stats/${state.group === "pitching" ? "pitching/" : ""}${state.season}${state.game === "P" ? "/postseason" : ""}`);
  if (METRICS[state.group].expanded.includes(metric)) source.searchParams.set("expanded", "true");
  element("source").href = source.href;
  element("sort").value = state.sort;
  element("pages").hidden = true;
  element("status").textContent = "正在向 MLB 查詢…";
  results.setAttribute("aria-busy", "true");
  results.innerHTML = '<p class="loading-message">正在讀取 MLB 官方成績…</p>';
  currentBoard = null;
  writeUrl();
  try {
    const rows = await fetchBoard(filters);
    if (request !== latestRequest) return;
    currentBoard = { metric, pool, ranked: rankRows(rows, metric, state.sort === "asc") };
    renderRows();
  } catch (error) {
    if (request !== latestRequest) return;
    console.warn("Could not load MLB leaderboard", error);
    element("status").textContent = "查詢失敗";
    results.innerHTML = '<div class="empty-state"><strong>暫時無法讀取 MLB 官方成績</strong><button type="button" class="retry-button">重新查詢</button></div>';
    results.querySelector("button").addEventListener("click", refresh);
  } finally {
    if (request === latestRequest) results.setAttribute("aria-busy", "false");
  }
}

function writeMetrics() {
  element("metric").innerHTML = Object.entries(METRICS[state.group]).map(([section, metrics]) =>
    `<optgroup label="${SECTIONS[section]}">${metrics.map(([key, name]) =>
      `<option value="${key}">${name} · ${key}</option>`).join("")}</optgroup>`).join("");
  element("metric").value = state.stat;
  for (const button of element("group").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.group === state.group));
  }
}

async function start() {
  const seasons = await getSeasons();
  if (!seasons.includes(state.season)) state.season = seasons[0];
  if (!descriptor()) state.stat = DEFAULT_METRIC[state.group];
  state.sort ??= defaultSort();
  element("season").innerHTML = seasons.map(year => `<option value="${year}">${year}</option>`).join("");
  for (const key of ["season", "game", "league", "pool", "sort"]) {
    const select = element(key);
    select.value = state[key];
    select.addEventListener("change", () => {
      state[key] = select.value;
      state.page = 1;
      void refresh();
    });
  }
  writeMetrics();
  element("group").addEventListener("click", event => {
    const next = event.target.closest("button")?.dataset.group;
    if (!Object.hasOwn(TYPES, next) || next === state.group) return;
    state.group = next;
    state.stat = DEFAULT_METRIC[next];
    state.sort = defaultSort();
    state.page = 1;
    writeMetrics();
    void refresh();
  });
  element("metric").addEventListener("change", () => {
    state.stat = element("metric").value;
    state.sort = defaultSort();
    state.page = 1;
    void refresh();
  });
  element("search").addEventListener("input", () => {
    state.page = 1;
    renderRows();
  });
  for (const [key, step] of [["prev", -1], ["next", 1]]) {
    element(key).addEventListener("click", () => {
      state.page += step;
      renderRows();
      element("heading").focus();
    });
  }
  void refresh();
}

void start();
