import { METRICS } from "./league-metrics.js";
import { ADVANCED, loadSeason, loadStatArchive } from "./percentiles.js?v=5";

export const ROLES = { hitting: "打擊", pitching: "投球" };
const FIT = { AVG: 3, OBP: 3, SLG: 3, OPS: 3, ERA: 2, WHIP: 2, "K/9": 2, "BB/9": 2 };
const PER_INNING = new Set(["era", "whip", "strikeoutsPer9Inn", "walksPer9Inn"]);
const ADDITIVE = new Set([
  "gamesPlayed", "gamesPitched", "gamesStarted", "plateAppearances", "battersFaced", "atBats",
  "hits", "homeRuns", "rbi", "stolenBases", "runs", "doubles", "triples", "baseOnBalls", "strikeOuts",
  "caughtStealing", "hitByPitch", "sacFlies", "totalBases", "wins", "losses", "saves", "holds", "earnedRuns",
  "completeGames", "shutouts",
]);
const number = new Intl.NumberFormat("zh-TW");
let wobaRequest;

function numeric(value) {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return Number.isFinite(value) ? value : null;
}

function outs(stat) {
  if (Number.isInteger(stat.outs) && stat.outs >= 0) return stat.outs;
  const match = /^(\d+)(?:\.([012]))?$/.exec(stat.inningsPitched);
  return match ? Number(match[1]) * 3 + Number(match[2] ?? 0) : null;
}

function sum(values) {
  return values.every(Number.isFinite) ? values.reduce((total, value) => total + value, 0) : null;
}

function divide(numerator, denominator, factor = 1) {
  return numerator !== null && denominator > 0 ? factor * numerator / denominator : null;
}

function advancedInput(stat, role) {
  const walks = numeric(stat.baseOnBalls), strikeouts = numeric(stat.strikeOuts);
  if (role === "hitting") return {
    PA: numeric(stat.plateAppearances), SO: strikeouts, BB: walks,
    H: numeric(stat.hits), HR: numeric(stat.homeRuns), AB: numeric(stat.atBats), SF: numeric(stat.sacFlies),
    HBP: numeric(stat.hitByPitch), "2B": numeric(stat.doubles), "3B": numeric(stat.triples),
  };
  return {
    TBF: numeric(stat.battersFaced), SOA: strikeouts, BBA: walks, ER: numeric(stat.earnedRuns),
    HA: numeric(stat.hits), IPouts: outs(stat),
  };
}

function splitTotals(rows, role) {
  // MLB usually supplies the full-season row itself. Use additive counts when only clubs are listed.
  if (rows.some(row => !row.team?.id) || new Set(rows.map(row => row.team.id)).size !== rows.length) return {};
  const stat = Object.fromEntries([...ADDITIVE].map(key => [key, sum(rows.map(row => numeric(row.stat[key])))]));
  const input = advancedInput(stat, role);
  const pa = sum([input.AB, input.BB, input.HBP, input.SF]);
  const obp = divide(sum([input.H, input.BB, input.HBP]), pa);
  const slg = divide(stat.totalBases, input.AB);
  stat.avg = divide(input.H, input.AB);
  stat.obp = obp;
  stat.slg = slg;
  stat.ops = sum([obp, slg]);
  if (role === "pitching") {
    stat.outs = sum(rows.map(row => outs(row.stat)));
    input.IPouts = stat.outs;
    for (const [key, field] of [["ERA", "era"], ["WHIP", "whip"], ["K/9", "strikeoutsPer9Inn"], ["BB/9", "walksPer9Inn"]]) {
      stat[field] = METRICS.pitching[key][3](input);
    }
  }
  return stat;
}

export function careerSeasons(rows, totalRow) {
  const roles = new Map();
  for (const role of Object.keys(ROLES)) {
    const grouped = Map.groupBy(rows.filter(row => row.group === role), row => Number(row.season));
    const years = [...grouped].sort(([a], [b]) => a - b).map(([year, splits]) => {
      const whole = totalRow(splits) ?? (splits.length === 1 ? splits[0] : null);
      const stat = whole?.stat ?? splitTotals(splits, role);
      return { year, stat, sample: role === "hitting" ? numeric(stat.plateAppearances) : outs(stat) };
    });
    if (years.length) roles.set(role, years);
  }
  return roles;
}

function officialStat(stat, role, key, field) {
  if (key === "IP") return outs(stat);
  if (role === "pitching" && PER_INNING.has(field) && !(outs(stat) > 0)) return null;
  if (role === "hitting" && ["AVG", "SLG"].includes(key) && numeric(stat.atBats) === 0) return null;
  if (role === "hitting" && ["OBP", "OPS"].includes(key) && numeric(stat.plateAppearances) === 0) return null;
  return numeric(stat[field]);
}

function officialBabip(stat) {
  return numeric(stat.babip) ?? METRICS.hitting.BABIP[3](advancedInput(stat, "hitting"));
}

export function careerMetrics(definitions, role, scope) {
  const metrics = new Map();
  for (const key of ["K%", "BB%"]) {
    const [name, , description, formula] = METRICS[role][key];
    metrics.set(key, { name, digits: 1, unit: "%", description, read: stat => formula(advancedInput(stat, role)) });
  }
  const ops = { name: role === "hitting" ? "攻擊指數" : "被攻擊指數", digits: 3, read: stat => numeric(stat.ops) };
  for (const [key, field, name] of definitions[role].columns) {
    metrics.set(key, { name, digits: FIT[key] ?? 0, innings: key === "IP", read: stat => officialStat(stat, role, key, field) });
  }
  if (role === "hitting") metrics.get("OPS").name = ops.name;
  else metrics.set("OPS", { ...ops, archive: scope === "regular" ? "percentiles" : undefined });
  for (const [key, name, digits, unit] of ADVANCED[role]) {
    if (metrics.has(key)) continue;
    if (key === "BABIP") metrics.set(key, {
      name: role === "hitting" ? name : "被場內安打率", digits: 3, read: officialBabip,
      archive: scope === "regular" ? "percentiles" : undefined,
    });
    else if (scope === "regular") metrics.set(key, { name, digits: digits ?? 0, unit, archive: "percentiles" });
  }
  if (scope === "regular" && role === "hitting") {
    metrics.set("wOBA", { name: "加權上壘率", digits: 3, archive: "woba" });
  }
  return metrics;
}

async function archivedValue(metric, key, year, role, id) {
  if (metric.archive === "woba") {
    if (year < 2015) return null;
    wobaRequest ??= loadStatArchive("ability-savant.json.gz?v=1").catch(error => {
      wobaRequest = null;
      throw error;
    });
    return (await wobaRequest)[year]?.woba?.[id]?.[0] ?? null;
  }
  if (year < 2010) return null;
  const { groups } = await loadSeason(String(year));
  const board = groups?.[role];
  const index = board?.columns.indexOf(key) ?? -1;
  return index === -1 ? null : board.players[id]?.[index * 2 + 1] ?? null;
}

export async function trendPoints(seasons, metric, key, role, id) {
  return Promise.all(seasons.map(async ({ year, stat, sample }) => {
    const official = metric.read?.(stat) ?? null;
    const backup = official === null && metric.archive ? await archivedValue(metric, key, year, role, id) : null;
    const value = official ?? backup;
    return { year, value: Number.isFinite(value) ? Number(value.toFixed(metric.digits)) : null, sample };
  }));
}

export function inningsText(value) {
  return `${Math.floor(value / 3)}.${value % 3}`;
}

export function metricText(value, metric) {
  if (!Number.isFinite(value)) return "—";
  if (metric.innings) return inningsText(value);
  const raw = metric.digits === 0 ? number.format(value) : value.toFixed(metric.digits);
  return (metric.digits === 3 ? raw.replace(/^0(?=\.)/, "") : raw) + (metric.unit ?? "");
}

export function sampleText(value, role) {
  if (!Number.isFinite(value)) return "—";
  return role === "hitting" ? `${number.format(value)} 打席` : `${inningsText(value)} 局`;
}
