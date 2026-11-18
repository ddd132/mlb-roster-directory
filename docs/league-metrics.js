// Rates are calculated directly from the counts for a season and league.
function sum(...values) {
  return values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;
}

function rate(numerator, denominator, scale = 1) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? scale * numerator / denominator : null;
}

const battingAverage = s => rate(s.H, s.AB);
const onBase = s => rate(sum(s.H, s.BB, s.HBP), sum(s.AB, s.BB, s.HBP, s.SF));
function slugging(s) {
  if (![s.H, s["2B"], s["3B"], s.HR].every(Number.isFinite)) return null;
  const totalBases = s.H + s["2B"] + 2 * s["3B"] + 3 * s.HR;
  return rate(totalBases, s.AB);
}
const strikeoutLead = (strikeouts, walks) => Number.isFinite(strikeouts) && Number.isFinite(walks)
  ? strikeouts - walks : null;

export const METRICS = {
  hitting: {
    "K%":     ["三振率", "pct", "三振數 ÷ 打席數", s => rate(s.SO, s.PA, 100)],
    "BB%":    ["保送率", "pct", "保送數 ÷ 打席數，含故意四壞", s => rate(s.BB, s.PA, 100)],
    "HR%":    ["全壘打率", "pct", "全壘打數 ÷ 打席數", s => rate(s.HR, s.PA, 100)],
    AVG:      ["打擊率", "avg", "安打數 ÷ 打數", battingAverage],
    OBP:      ["上壘率", "avg", "（安打＋保送＋觸身球）÷（打數＋保送＋觸身球＋高飛犧牲打）", onBase],
    SLG:      ["長打率", "avg", "總壘打數 ÷ 打數", slugging],
    OPS:      ["攻擊指數", "avg", "上壘率＋長打率，先計算再四捨五入", s => sum(onBase(s), slugging(s))],
    ISO:      ["純長打率", "avg", "長打率－打擊率", s => {
      const slg = slugging(s), avg = battingAverage(s);
      return slg != null && avg != null ? slg - avg : null;
    }],
    BABIP:    ["場內安打率", "avg", "（安打－全壘打）÷（打數－三振－全壘打＋高飛犧牲打）", s => {
      if (![s.H, s.HR, s.AB, s.SO, s.SF].every(Number.isFinite)) return null;
      return rate(s.H - s.HR, s.AB - s.SO - s.HR + s.SF);
    }],
    "R/G":    ["每隊每場得分", "num", "得分 ÷ 球隊出賽場次總和", s => rate(s.R, s.G)],
    "HR/G":   ["每隊每場全壘打", "num", "全壘打數 ÷ 球隊出賽場次總和", s => rate(s.HR, s.G)],
    "H/G":    ["每隊每場安打", "num", "安打數 ÷ 球隊出賽場次總和", s => rate(s.H, s.G)],
    "2B/G":   ["每隊每場二壘打", "num", "二壘打數 ÷ 球隊出賽場次總和", s => rate(s["2B"], s.G)],
    "3B/G":   ["每隊每場三壘打", "num", "三壘打數 ÷ 球隊出賽場次總和", s => rate(s["3B"], s.G)],
    "SB/G":   ["每隊每場盜壘", "num", "盜壘成功數 ÷ 球隊出賽場次總和", s => rate(s.SB, s.G)],
    "SB%":    ["盜壘成功率", "pct", "盜壘成功數 ÷（成功數＋盜壘刺數）", s => rate(s.SB, sum(s.SB, s.CS), 100)],
  },
  pitching: {
    "K%":     ["三振率", "pct", "奪三振數 ÷ 面對打者數", s => rate(s.SOA, s.TBF, 100)],
    "BB%":    ["保送率", "pct", "投出保送數 ÷ 面對打者數，含故意四壞", s => rate(s.BBA, s.TBF, 100)],
    "K-BB%":  ["三振率減保送率", "pp", "（奪三振數－投出保送數）÷ 面對打者數，以百分點顯示", s => rate(strikeoutLead(s.SOA, s.BBA), s.TBF, 100)],
    ERA:      ["防禦率", "num", "自責分 × 9 ÷ 投球局數", s => rate(s.ER, s.IPouts, 27)],
    WHIP:     ["每局被安打與保送數", "num", "（被安打＋投出保送）÷ 投球局數", s => rate(sum(s.HA, s.BBA), s.IPouts, 3)],
    "K/9":    ["每九局三振", "num", "奪三振數 × 9 ÷ 投球局數", s => rate(s.SOA, s.IPouts, 27)],
    "BB/9":   ["每九局保送", "num", "投出保送數 × 9 ÷ 投球局數", s => rate(s.BBA, s.IPouts, 27)],
    "HR/9":   ["每九局被全壘打", "num", "被全壘打數 × 9 ÷ 投球局數", s => rate(s.HRA, s.IPouts, 27)],
    "H/9":    ["每九局被安打", "num", "被安打數 × 9 ÷ 投球局數", s => rate(s.HA, s.IPouts, 27)],
    "RA9":    ["每九局失分", "num", "全部失分 × 9 ÷ 投球局數，包含非自責分", s => rate(s.RA, s.IPouts, 27)],
    "K/BB":   ["三振保送比", "num", "奪三振數 ÷ 投出保送數", s => rate(s.SOA, s.BBA)],
    "HR%":    ["被全壘打率", "pct", "被全壘打數 ÷ 面對打者數", s => rate(s.HRA, s.TBF, 100)],
  },
};

export function formatValue(value, kind) {
  if (!Number.isFinite(value)) return "—";
  if (kind === "pct") return value.toFixed(1) + "%";
  if (kind === "pp") return value.toFixed(1) + " 個百分點";
  if (kind === "avg") return value.toFixed(3).replace(/^0\./, ".");
  return value.toFixed(2);
}

export function readSeasons(payload) {
  const years = new Map();
  for (const [year, leagues] of Object.entries(payload.seasons)) {
    const groups = new Map();
    for (const [code, row] of Object.entries(leagues)) {
      const values = Object.fromEntries(payload.columns.map((column, i) => [column, row[i]]));
      groups.set(code, values);
    }
    years.set(Number(year), groups);
  }
  return years;
}
