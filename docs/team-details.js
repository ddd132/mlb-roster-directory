import { loadArchive } from "./history-data.js";
import { escape, mlbCalendarDate } from "./mlb.js";

let detailsRequest;
let minorsRequest;
let labelsRequest;
const rosterRights = new Map();
const dayLength = 86_400_000;
const seasonDate = mlbCalendarDate();

export const contractLabels = {
  signed: "已簽約", "arb-signed": "仲裁年已簽約", arb: "薪資仲裁",
  prearb: "仲裁前", "free-agent": "自由球員", "projected-fa": "預計成為自由球員",
  option: "選擇權", unknown: "合約待查",
};

const optionLabels = {
  "CLUB OPTION": "球隊選擇權", "PLAYER OPTION": "球員選擇權", "MUTUAL OPTION": "雙方選擇權",
  "VESTING OPTION": "條件選擇權", "OPT OUT": "跳脫條款", "OPT-OUT": "跳脫條款",
};
const rule5Reasons = {
  birth: "缺少出生日期", sign: "未查到首份職業合約", prior: "較早有職業紀錄，首簽待核對",
  range: "首簽接近球季尾聲，起算年度待核對", review: "簽約資料待核對",
};

export const minorLevelLabel = {
  1: "MLB", 11: "3A", 12: "2A", 13: "高階 1A", 14: "1A", 15: "短季 1A", 16: "新人聯盟",
};

export function loadTeamDetails() {
  detailsRequest ??= loadArchive("team-details.json.gz?v=1").then(data => {
    if (data.version !== 1 || !data.asOf || !data.rule5 || !data.contracts || !data.depth) {
      throw new Error("Invalid team details snapshot");
    }
    const reserve = new Map(Object.entries(data.reserve).flatMap(([team, entries]) =>
      Object.entries(entries).map(([id, status]) => [Number(id), { team: Number(team), status }])));
    const free = new Map(data.freeAgents.map(([id, name, team, position, date]) => [id, { id, name, team, position, date }]));
    const teamByContract = new Map();
    for (const [team, [, players]] of Object.entries(data.contracts)) {
      for (const id of Object.keys(players)) {
        const list = teamByContract.get(Number(id)) ?? [];
        list.push(Number(team));
        teamByContract.set(Number(id), list);
      }
    }
    return { ...data, reserveByTeam: data.reserve, reserve, free, teamByContract };
  }).catch(error => { detailsRequest = null; throw error; });
  return detailsRequest;
}

export function updateRosterRights(data, team, rosterDate) {
  if (!data || rosterDate <= data.asOf) return;
  rosterRights.set(team.id, new Map(team.players.map(p => [p.id, p.status?.code])));
}

function reservedBy(data, id, orgId) {
  const live = rosterRights.get(orgId);
  if (live?.has(id)) return { team: orgId, status: live.get(id) };
  const snap = data?.reserve.get(id);
  if (!snap) return null;
  // The live 40-man list excludes 60-day IL; preserve verified reserved rights for those players.
  if (rosterRights.has(snap.team) && !rosterRights.get(snap.team).has(id) && !/60/.test(snap.status ?? "")) return null;
  return snap;
}

export function loadMinorMetadata() {
  const get = async file => {
    const response = await fetch(`data/${file}.json`, { signal: AbortSignal.timeout(16_000) });
    if (!response.ok) throw new Error(`Could not load ${file}`);
    return response.json();
  };
  minorsRequest ??= Promise.all([get("minor-league-rosters"), get("pipeline-rankings").catch(() => null)])
    .catch(error => { minorsRequest = null; throw error; });
  return minorsRequest;
}

export function loadFinderLabels() {
  labelsRequest ??= fetch("finder-labels.json?v=1").then(response => {
    if (!response.ok) throw new Error("Could not load translated names");
    return response.json();
  }).then(data => data.players ?? {}).catch(() => ({}));
  return labelsRequest;
}

export function rule5Draft(data) {
  const today = seasonDate;
  if (!data) return { year: Number(today.slice(0, 4)), days: null };
  const next = data.rule5Date && today > data.rule5Date;
  const year = Math.max(Number(today.slice(0, 4)), data.season + Number(Boolean(next)));
  const days = data.rule5Date && year === data.season
    ? Math.round((Date.parse(data.rule5Date) - Date.parse(today)) / dayLength) : null;
  return { year, days };
}

export function rule5State(data, id, orgId) {
  const [first, signed, age, reason, last] = data?.rule5[id] ?? [];
  const draft = rule5Draft(data);
  const confirmed = data?.confirmed[id] ?? 0;
  const reserve = reservedBy(data, id, orgId);
  const details = { signed, age, first, last: last ?? first, confirmed, year: draft.year };
  const countdown = draft.days === null ? "" : draft.days > 0 ? `距選秀約 ${draft.days} 天` : "選秀日";
  if (reserve) {
    return { ...details, key: "protected", label: "受 40 人名單保護", detail: /60/.test(reserve.status ?? "") ? "大聯盟保留權（60 天傷兵）" : "", team: reserve.team };
  }
  if (confirmed === draft.year) {
    return { ...details, key: "eligible", label: "已符合資格",
      detail: [`${confirmed} 年 MLB Pipeline 點名`, countdown].filter(Boolean).join(" · ") };
  }
  if (first && orgId && !Object.hasOwn(data.reserveByTeam, orgId) && !rosterRights.has(orgId)) {
    return { ...details, key: "unknown", label: "保護狀態待查", detail: "球團資料暫缺" };
  }
  if (first && (last ?? first) <= draft.year) {
    return { ...details, key: "eligible", label: "推估已符合", detail: countdown };
  }
  if (first && first > draft.year) {
    const years = first === (last ?? first) ? String(first) : `${first}–${last}`;
    return { ...details, key: "upcoming", label: `預計 ${years} 年`,
      detail: last && last !== first ? `還有 ${first - draft.year}–${last - draft.year} 屆` : `還有 ${first - draft.year} 屆` };
  }
  return { ...details, key: "unknown", label: "資格待查",
    detail: reason === "range" ? `可能為 ${first}–${last} 年；起算年度待核對`
      : rule5Reasons[reason] ?? (data ? "未查到首份職業合約" : "規則五資料暫缺") };
}

export function statusTag(key, label, detail = "") {
  return `<span class="detail-tag" data-detail-status="${escape(key)}"${detail ? ` title="${escape(detail)}"` : ""}>${escape(label)}</span>`;
}

export function rule5Mark(data, id, orgId, showDetail = false) {
  const status = rule5State(data, id, orgId);
  return statusTag(status.key, status.label, status.detail)
    + (showDetail && status.detail ? `<small class="detail-secondary">${escape(status.detail)}</small>` : "");
}

export function contractState(data, id, orgId, year = data?.season) {
  const free = data?.free.get(id);
  if (free && (!orgId || free.team === orgId) && year === data.season + 1) {
    return { key: "free-agent", label: contractLabels["free-agent"], date: free.date, confirmed: true };
  }
  if (!data) return { key: "unknown", label: contractLabels.unknown };
  const listed = reservedBy(data, id, orgId);
  const candidates = data.teamByContract.get(id) ?? [];
  const team = orgId || listed?.team || (candidates.length === 1 ? candidates[0] : null);
  const record = data.contracts[team]?.[1][id];
  const [kind, confirmed, start, end, through, amount, options, source] = record?.[0][year] ?? [];
  if (!kind) return { key: "unknown", label: contractLabels.unknown, team, service: record?.[1] };
  const key = kind.includes("OPTION") || kind.includes("OPT") ? "option" : kind;
  const label = optionLabels[kind] ?? contractLabels[key] ?? contractLabels.unknown;
  return { key, label, confirmed, start, end, through, amount, options, team, source, service: record[1] };
}

export function payrollLink(data, orgId, year) {
  const slug = data?.contracts[orgId]?.[0];
  return slug && /^[a-z-]+$/.test(slug)
    ? `https://www.fangraphs.com/roster-resource/payroll/${slug}?season=${Number(year)}` : "https://www.fangraphs.com/roster-resource/breakdowns/payroll";
}

export function formatService(value) {
  if (!/^\d{1,2}\.\d{3}$/.test(value ?? "")) return "";
  const [years, days] = value.split(".").map(Number);
  return `${years} 年 ${days} 天`;
}

export function contractLine(state, year) {
  if (state.key === "free-agent") return state.date ? `${state.date} 成為自由球員` : "";
  if (state.end && (state.key === "signed" || state.key === "arb-signed")) {
    return state.end === year ? `合約涵蓋 ${year} 球季` : `合約涵蓋至 ${state.end} 年`;
  }
  if (state.key === "projected-fa") return "依合約／年資推估";
  if (state.key === "arb" || state.key === "prearb") return "公開薪資資料分類";
  return "";
}

export function contractDetail(state, year) {
  const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const rows = [contractLine(state, year)];
  if (state.start && state.end && state.start < state.end && state.confirmed) rows.push(`${state.start}–${state.end} 球季`);
  if (state.amount > 0) rows.push(`合約公布總額 ${currency.format(state.amount)}`);
  for (const [optionYear, kind, status] of state.options ?? []) {
    if (optionYear >= year) rows.push(`${optionYear} 年 ${optionLabels[kind] ?? kind}${status === "EXERCISED" ? "（已執行）" : ""}`);
  }
  const service = formatService(state.service);
  if (service) rows.push(`資料所列 MLB 年資 ${service}`);
  return [...new Set(rows.filter(Boolean))];
}
