import { AXES } from "./ability.js?v=2";
import { request } from "./history-data.js";
import { loadSeason, loadStatArchive, percentileProfile } from "./percentiles.js?v=4";
import { loadFinderLabels } from "./team-details.js";

export const ROLE_LABELS = { hitting: "打者", pitching: "投手" };
const FIELDS = {
  hitting: { SLG: "slg", OPS: "ops", SB: "stolenBases" },
  pitching: { ERA: "era", WHIP: "whip", "K/9": "strikeoutsPer9Inn", "BB/9": "walksPer9Inn", OPS: "ops" },
};
const LOWER = {
  hitting: new Set(["K%"]),
  pitching: new Set(["ERA", "WHIP", "BB/9", "BB%", "OPS", "H/9"]),
};
const ALTERNATES = {
  hitting: { Sprint: [["SB", "跑壘"]] },
  pitching: {
    "Whiff%": [["WHIP", "壓制上壘"]],
    "Hard-Hit%": [["OPS", "壓制攻勢"], ["H/9", "壓制安打"]],
  },
};
const LIVE_FIELDS = [
  "stats", "group", "displayName", "totalSplits", "splits", "season", "player", "id", "fullName",
  "stat", "plateAppearances", "atBats", "battersFaced", "outs", "strikeOuts", "baseOnBalls", "hits",
  ...new Set(Object.values(FIELDS).flatMap(Object.values)),
].join(",");
const liveRequests = new Map();
let playerNames;

function number(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  return typeof raw === "string" && /^\d*(?:\.\d+|\d)$/.test(raw) ? Number(raw) : null;
}

function sample(stat, role) {
  return number(role === "hitting" ? stat.plateAppearances : stat.battersFaced);
}

function hasSample(stat, role) {
  return sample(stat, role) > 0 || number(role === "hitting" ? stat.atBats : stat.outs) > 0;
}

export function comparisonYears(rows) {
  const years = new Map();
  for (const { season, group, stat } of rows) {
    if (!Object.hasOwn(ROLE_LABELS, group) || !hasSample(stat, group)) continue;
    if (!years.has(season)) years.set(season, new Set());
    years.get(season).add(group);
  }
  return new Map([...years].sort(([a], [b]) => b.localeCompare(a)));
}

function directory() {
  playerNames ??= loadStatArchive("data/player-search.json.gz?v=1").then(data => {
    if (!Array.isArray(data.players)) throw new Error("Invalid player name index");
    return new Map(data.players.filter(player => Number.isSafeInteger(player.id)).map(player => [player.id, player]));
  }).catch(error => {
    playerNames = null;
    throw error;
  });
  return playerNames;
}

function records(people, names) {
  return new Map([...people].map(([id, row]) => {
    const translations = names[id] ?? [];
    return [id, { ...row, id, label: translations[0] || "", aliases: [...translations, ...(row.aliases ?? [])] }];
  }));
}

async function liveBoard(year, role, scope) {
  const { stats } = await request("/stats", {
    stats: "season", group: role, sportIds: 1, season: year, gameType: scope === "postseason" ? "P" : "R",
    playerPool: "ALL", sortStat: role === "hitting" ? "avg" : "era", limit: 2000, fields: LIVE_FIELDS,
  });
  if (!Array.isArray(stats)) throw new Error("Invalid MLB comparison statistics");
  const block = stats.find(item => item.group?.displayName === role);
  if (!block && !stats.length) return new Map();
  if (!Array.isArray(block?.splits) || block.splits.length !== block.totalSplits) {
    throw new Error("MLB returned an incomplete comparison season");
  }
  const players = new Map();
  const seen = new Set();
  for (const { season, player, stat } of block.splits) {
    if (season !== year || !Number.isSafeInteger(player?.id) || !player.fullName || !stat || seen.has(player.id)) {
      throw new Error("MLB returned an unexpected comparison row");
    }
    seen.add(player.id);
    if (hasSample(stat, role)) players.set(player.id, {
      name: player.fullName, sample: sample(stat, role), atBats: number(stat.atBats), stats: liveValues(stat, role),
    });
  }
  return players;
}

function liveValues(stat, role) {
  const values = new Map(Object.entries(FIELDS[role]).map(([key, field]) => [key, number(stat[field])]));
  const faced = sample(stat, role);
  for (const [key, field] of [["K%", "strikeOuts"], ["BB%", "baseOnBalls"]]) {
    const value = number(stat[field]);
    values.set(key, faced > 0 && value !== null ? Math.round(1000 * value / faced) / 10 : null);
  }
  if (role === "pitching") {
    const outs = number(stat.outs);
    const hits = number(stat.hits);
    values.set("IP", outs);
    values.set("H/9", outs > 0 && hits !== null ? Math.round(2700 * hits / outs) / 100 : null);
  }
  return values;
}

function liveProfile(players, role, id) {
  const record = players.get(id);
  const values = new Map([...record.stats].map(([key, value]) => {
    if (!Number.isFinite(value) || key === "IP") return [key, [value, null]];
    let valid = 0;
    let midpoint = 0;
    for (const peer of players.values()) {
      const other = peer.stats.get(key);
      if (!Number.isFinite(other)) continue;
      valid += 1;
      if (other === value) midpoint += 0.5;
      else if (LOWER[role].has(key) ? other > value : other < value) midpoint += 1;
    }
    return [key, [value, valid ? Math.round(100 * midpoint / valid) : null, true]];
  }));
  return { values, sample: record.sample, atBats: record.atBats };
}

export async function loadComparisonSeason(year, role, scope, playerId) {
  if (scope === "regular") {
    try {
      const { groups } = await loadSeason(year);
      const board = groups?.[role];
      if (Object.hasOwn(board?.players ?? {}, playerId)) {
        const [index, labels] = await Promise.all([directory(), loadFinderLabels()]);
        const people = new Map(Object.entries(board.players).flatMap(([id, row]) => {
          const player = index.get(Number(id));
          return player ? [[Number(id), { name: player.name, aliases: player.aliases, sample: row[0] }]] : [];
        }));
        if (people.has(playerId)) return {
          players: records(people, labels),
          profile: id => percentileProfile(board, role, id),
          source: "archive",
        };
      }
    } catch (error) {
      console.warn("Could not load the comparison archive", error);
    }
  }
  const key = [year, role, scope].join("/");
  if (!liveRequests.has(key)) liveRequests.set(key, liveBoard(year, role, scope).catch(error => {
    liveRequests.delete(key);
    throw error;
  }));
  const [people, labels] = await Promise.all([liveRequests.get(key), loadFinderLabels()]);
  return { players: records(people, labels), profile: id => liveProfile(people, role, id), source: "mlb" };
}

export function comparisonAxes(role, first, second) {
  return AXES[role].map(([label, ...keys]) => {
    const options = [[keys[0], label], ...keys.slice(1).map(key => [key, label]), ...(ALTERNATES[role][keys[0]] ?? [])];
    const available = options.map(([key, title]) => ({
      key, title, points: [first.values.get(key) ?? [], second.values.get(key) ?? []],
    }));
    return available.find(({ points }) => points.every(([value, rank]) => Number.isFinite(value) && Number.isFinite(rank)))
      ?? available.find(({ points }) => points.every(([value]) => Number.isFinite(value)))
      ?? available.find(({ points }) => points.some(([value]) => Number.isFinite(value)))
      ?? available[0];
  });
}
