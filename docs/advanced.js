import { fetchSeasonStats } from "./mlb.js";

const commonColumns = [
  ["BABIP", "babip", "場內安打率"],
  ["K%", "kRate", "三振占打席或對戰打席的比例"],
  ["BB%", "bbRate", "四壞保送占打席或對戰打席的比例"],
];

const advancedDefinitions = {
  hitting: {
    label: "打擊進階",
    columns: [
      ["OPS+", "opsPlus", "經聯盟與球場校正的 OPS 指數", true],
      ...commonColumns,
      ["Hard-Hit%", "hardHitRate", "擊球初速達 95 mph 的比例"],
      ["Barrel%", "barrelRate", "Barrel 占擊球事件的比例"],
      ["Whiff%", "whiffRate", "揮空占總揮棒的比例"],
    ],
  },
  pitching: {
    label: "投球進階",
    columns: [
      ["ERA+", "eraPlus", "經聯盟與球場校正的防禦率指數", true],
      ["被 OPS", "ops", "對手的上壘率加長打率", true],
      ...commonColumns,
      ["被 Hard-Hit%", "hardHitRate", "對手擊球初速達 95 mph 的比例"],
      ["被 Barrel%", "barrelRate", "對手 Barrel 占擊球事件的比例"],
      ["Whiff%", "whiffRate", "對手揮空占總揮棒的比例"],
    ],
  },
};

async function savantSnapshot() {
  const response = await fetch("data/savant-seasons.json", { signal: AbortSignal.timeout(16_000) });
  if (!response.ok) throw new Error(`Savant snapshot returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.columns) || !payload.players) throw new Error("Invalid Savant snapshot");
  return payload;
}

function groupLegacyStats(rows) {
  const bySeason = Map.groupBy(rows, row => `${row.group}/${row.season}`);
  const totals = new Map();
  for (const [key, splits] of bySeason) {
    const total = splits.find(row => row.numTeams > 1 && !row.team?.id);
    if (total || splits.length === 1) totals.set(key, (total ?? splits[0]).stat);
  }
  return totals;
}

async function loadAdvanced(id, regularRows) {
  const snapshot = await savantSnapshot().catch(error => {
    console.warn("Could not retrieve the Savant snapshot", error);
    return null;
  });
  const player = snapshot?.players[id] ?? {};
  const needsLegacy = regularRows.some(row => !player[row.group]?.[row.season]);
  const legacy = needsLegacy
    ? await fetchSeasonStats(id, "regular", "yearByYearAdvanced").catch(error => {
      console.warn("Could not retrieve MLB legacy advanced statistics", error);
      return [];
    })
    : [];
  return {
    player,
    columns: snapshot?.columns ?? [],
    firstSeason: snapshot?.firstSeason,
    lastSeason: snapshot?.lastSeason,
    legacy: groupLegacyStats(legacy),
  };
}

function ratio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? 100 * numerator / denominator
    : null;
}

function fixed(value, digits) {
  if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) return null;
  return Number(value).toFixed(digits).replace(/^0(?=\.)/, "");
}

function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : null;
}

function seasonMetrics(data, group, season, stat) {
  const values = data.player[group]?.[season] ?? [];
  const savant = Object.fromEntries(data.columns.map((key, index) => [key, values[index]]));
  const official = data.legacy.get(`${group}/${season}`) ?? {};
  const plateAppearances = group === "hitting" ? stat.plateAppearances : stat.battersFaced;
  const ballsInPlay = stat.atBats - stat.strikeOuts - stat.homeRuns + stat.sacFlies;
  const babip = ballsInPlay > 0 ? (stat.hits - stat.homeRuns) / ballsInPlay : null;
  return {
    babip: fixed(savant.babip ?? official.babip ?? stat.babip ?? babip, 3),
    kRate: percent(savant.kRate ?? ratio(stat.strikeOuts, plateAppearances)),
    bbRate: percent(savant.bbRate ?? ratio(stat.baseOnBalls, plateAppearances)),
    hardHitRate: percent(savant.hardHitRate),
    barrelRate: percent(savant.barrelRate),
    whiffRate: percent(savant.whiffRate ?? ratio(official.swingAndMisses, official.totalSwings)),
    ops: fixed(savant.ops ?? official.ops ?? stat.ops, 3),
  };
}

export { advancedDefinitions, loadAdvanced, seasonMetrics };
