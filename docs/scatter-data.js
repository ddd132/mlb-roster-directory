import { ADVANCED, loadSeason } from "./percentiles.js?v=5";
import { loadFinderLabels } from "./team-details.js";

export const DEFAULT_AXES = { hitting: ["K%", "OPS"], pitching: ["K%", "ERA"] };
const STANDARD_KEYS = {
  hitting: ["AVG", "OBP", "SLG", "OPS", "HR", "H", "RBI", "R", "SB", "PA", "BABIP"],
  pitching: ["ERA", "WHIP", "OPS", "SO/9", "BB/9", "SO", "IP", "TBF", "W", "SV", "HLD", "BABIP"],
};
const ARCHIVE_KEYS = { "SO/9": "K/9" };
const MINIMUM = { R: { hitting: 100, pitching: 20 }, P: { hitting: 20, pitching: 5 } };
export const SAMPLE_LIMIT = 3000;

export async function prepareScatter(filters) {
  const { season, group, game, league } = filters;
  const hasArchive = game === "R" && league === "MLB" && Number(season) >= 2010;
  const [labels, archive] = await Promise.all([
    loadFinderLabels(),
    hasArchive ? loadSeason(season).catch(error => {
      console.warn("Could not load the advanced scatter data", error);
      return { unavailable: true };
    }) : {},
  ]);
  return { labels, board: archive.groups?.[group], capturedAt: archive.capturedAt, unavailable: archive.unavailable };
}

export function minimumSample(raw, group, game) {
  return /^\d+$/.test(raw ?? "") ? Math.min(SAMPLE_LIMIT, Number(raw)) : MINIMUM[game][group];
}

function officialValue(key, field, stat, numeric) {
  if (["ERA", "WHIP", "SO/9", "BB/9"].includes(key) && !(numeric(stat.outs) > 0)) return null;
  if (["AVG", "SLG"].includes(key) && numeric(stat.atBats) === 0) return null;
  if (["OPS", "OBP"].includes(key) && (numeric(stat.plateAppearances) ?? numeric(stat.battersFaced)) === 0) return null;
  return numeric(stat[field]);
}

export function scatterMetrics(definitions, group, board, numeric) {
  const metrics = new Map();
  const batter = group === "hitting";
  const sampleField = batter ? "plateAppearances" : "battersFaced";
  for (const [key, name, field] of [["K%", "三振率", "strikeOuts"], ["BB%", "保送率", "baseOnBalls"]]) {
    metrics.set(key, {
      key, name, format: "%",
      read: stat => {
        const sample = numeric(stat[sampleField]), events = numeric(stat[field]);
        return sample > 0 && events !== null ? events / sample : null;
      },
    });
  }
  const official = new Map(Object.values(definitions).flat().map(definition => [definition[0], definition]));
  if (!batter) official.set("OPS", ["OPS", "被攻擊指數", "ops", 3]);
  for (const key of STANDARD_KEYS[group]) {
    const [, name, field, format] = official.get(key);
    metrics.set(key, { key, name, format, read: stat => officialValue(key, field, stat, numeric) });
  }
  if (board) {
    const records = Object.values(board.players);
    const columns = new Map(board.columns.map((key, i) => [key, 1 + 2 * i]));
    for (const [key, name, digits, unit] of ADVANCED[group]) {
      if (metrics.has(key)) continue;
      const column = columns.get(key);
      if (column === undefined || !records.some(row => Number.isFinite(row[column]))) continue;
      metrics.set(key, { key, name, format: unit === "%" ? "%" : digits, unit: unit === "%" ? "" : unit });
    }
    for (const metric of metrics.values()) {
      const column = ["PA", "TBF"].includes(metric.key) ? 0 : columns.get(ARCHIVE_KEYS[metric.key] ?? metric.key);
      if (column !== undefined) metric.archive = row => {
        const value = row[column];
        return Number.isFinite(value) ? value / (metric.format === "%" ? 100 : 1) : null;
      };
    }
  }
  return metrics;
}

export function scatterPoints(rows, options) {
  const { group, minimum, xMetric, yMetric, board, numeric } = options;
  const archived = !xMetric.read || !yMetric.read;
  const batter = group === "hitting";
  const min = batter ? minimum : minimum * 3;
  const outsColumn = board ? board.columns.indexOf("IP") : -1;
  const points = [];
  let eligible = 0;
  for (const row of rows) {
    const archive = archived ? board?.players[row.player.id] : null;
    const innings = archived ? (outsColumn >= 0 ? numeric(archive?.[1 + outsColumn * 2]) : null) : numeric(row.stat.outs);
    const batters = archived ? numeric(archive?.[0]) : numeric(row.stat[batter ? "plateAppearances" : "battersFaced"]);
    const sample = batter ? batters : innings;
    if ((sample ?? 0) < min) continue;
    eligible += 1;
    const x = archived ? (archive && xMetric.archive?.(archive)) : xMetric.read(row.stat);
    const y = archived ? (archive && yMetric.archive?.(archive)) : yMetric.read(row.stat);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ row, id: row.player.id, x, y, sample, batters });
  }
  return { points, eligible, archived };
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}
