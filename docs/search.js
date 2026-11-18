import { syncFinderNavigation, withFinderReturn } from "./finder-links.js";
import { loadArchive } from "./history-data.js";
import { fetchLiveRoster, fetchSnapshot, readLastRoster } from "./mlb.js?v=5";
import { buildPlayerIndex, playerSearchUrl, searchPlayers } from "./player-search.js?v=2";

const byId = id => document.getElementById(id);
const form = byId("player-name-search");
const field = byId("player-name-query");
const list = byId("player-search-results");
const status = byId("player-search-status");
const more = byId("player-search-more");
const retry = byId("player-search-retry");
const number = new Intl.NumberFormat("zh-Hant");
const pageSize = 25;
const positions = {
  P: "投手", RHP: "右投手", LHP: "左投手", SP: "先發投手", RP: "後援投手", CL: "終結者",
  C: "捕手", "1B": "一壘手", "2B": "二壘手", "3B": "三壘手", SS: "游擊手", IF: "內野手", INF: "內野手",
  LF: "左外野手", CF: "中外野手", RF: "右外野手", OF: "外野手", DH: "指定打擊", TWP: "二刀流",
  PH: "代打", PR: "代跑", UTIL: "工具人",
};
const levels = { 1: "MLB", 11: "3A", 12: "2A", 13: "高階 1A", 14: "1A", 15: "短季 1A", 16: "新人聯盟" };
const directory = { label: "歷史與小聯盟名單", state: "idle", players: [] };
const roster = { label: "40 人名單", state: "idle", snapshot: null };

let index = [];
let query = "";
let limit = pageSize;
let delay;

function summary(player) {
  const entry = player.roster ?? player.minor ?? player.career;
  const position = entry.position && entry.position !== "—" ? entry.position : player.career?.position;
  const info = [positions[position] ?? position, entry.club];
  if (player.roster) {
    info.push(`${player.roster.season} 年 40 人名單`);
  } else if (player.minor) {
    const source = player.minor.prospect ? "新秀榜" : "小聯盟名單";
    info.push(`${player.minor.season} 年${source}`, levels[player.minor.level]);
  }
  if (player.career) {
    const { first, last } = player.career;
    info.push(`MLB 出賽 ${first === last ? first : `${first}–${last}`}`);
  }
  return info.filter(value => value && value !== "—").join(" · ");
}

function resultRow(player) {
  const li = document.createElement("li");
  const link = document.createElement("a");
  link.className = "player-search-result";
  link.href = withFinderReturn(playerSearchUrl(player));
  link.dataset.player = player.id ?? player.history.player;

  const description = document.createElement("span");
  const name = document.createElement("strong");
  const chinese = player.aliases?.find(alias => /\p{Script=Han}/u.test(alias));
  name.textContent = chinese ? `${chinese} · ${player.name}` : player.name;
  const meta = document.createElement("span");
  meta.className = "player-search-result-meta";
  meta.textContent = summary(player);
  description.append(name, meta);

  const arrow = document.createElement("span");
  arrow.className = "icon icon-chevron";
  arrow.setAttribute("aria-hidden", "true");
  link.append(description, arrow);
  li.append(link);
  return li;
}

function render() {
  const pending = [directory, roster].some(source => source.state === "loading");
  const failures = [directory, roster].filter(source => source.state === "failed").map(source => source.label);
  const results = query ? searchPlayers(index, query) : [];
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.player : null;
  list.replaceChildren(...results.slice(0, limit).map(resultRow));
  list.hidden = !results.length;
  retry.hidden = !query || !failures.length;
  more.hidden = results.length <= limit;
  if (focused) {
    list.querySelector(`[data-player="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  const messages = [];
  if (results.length) messages.push(`找到 ${number.format(results.length)} 位球員。`);
  if (pending) messages.push("正在讀取名單…");
  if (failures.length) messages.push(`${failures.join("及")}暫時無法載入。`);
  if (!messages.length) messages.push("找不到符合姓名的球員。");
  status.textContent = query ? messages.join(" ") : "";
}

function updateIndex() {
  index = buildPlayerIndex(directory.players, roster.snapshot);
  render();
}

async function loadDirectory() {
  if (directory.state === "loading" || directory.state === "ready") return;
  directory.state = "loading";
  try {
    const data = await loadArchive("data/player-search.json.gz?v=1");
    if (data.version !== 1 || !Array.isArray(data.players) || !data.players.length) {
      throw new Error("Invalid player search index");
    }
    directory.players = data.players;
    directory.state = "ready";
  } catch (error) {
    console.warn("Could not load the player search index", error);
    directory.state = "failed";
  }
  updateIndex();
}

async function loadRoster() {
  if (roster.state === "loading" || roster.state === "ready") return;
  roster.state = "loading";
  try {
    roster.snapshot = readLastRoster(await fetchSnapshot());
    roster.state = "ready";
  } catch (error) {
    console.warn("Could not load the search roster", error);
    roster.state = "failed";
  }
  updateIndex();

  if (roster.snapshot && Date.now() - Date.parse(roster.snapshot.capturedAt) >= 120_000) {
    try {
      roster.snapshot = await fetchLiveRoster(roster.snapshot);
      updateIndex();
    } catch (error) {
      console.warn("Could not refresh the 40-man search roster", error);
    }
  }
}

function refreshQuery() {
  clearTimeout(delay);
  const next = field.value.trim();
  if (next !== query) limit = pageSize;
  query = next;
  const url = new URL(location.href);
  url.searchParams.set("mode", "name");
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
  syncFinderNavigation();
  if (query) {
    void loadDirectory();
    void loadRoster();
  }
  render();
}

field.addEventListener("input", event => {
  clearTimeout(delay);
  if (!event.isComposing) delay = setTimeout(refreshQuery, 150);
});
field.addEventListener("compositionend", refreshQuery);
form.addEventListener("submit", event => {
  event.preventDefault();
  refreshQuery();
});
more.addEventListener("click", () => {
  const firstNew = limit;
  limit += pageSize;
  render();
  list.children[firstNew]?.querySelector("a").focus();
});
retry.addEventListener("click", refreshQuery);

field.value = (new URLSearchParams(location.search).get("q") ?? "").slice(0, 120);
if (field.value) refreshQuery();
