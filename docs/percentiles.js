import { taipeiTime } from "./mlb.js";

const ROLE_LABEL = { hitting: "打擊", pitching: "投球" };
const SAMPLE_LABEL = { hitting: "打席", pitching: "對戰打席" };
const LOWER_IS_BETTER = {
  hitting: new Set(["K%", "Whiff%", "Chase%"]),
  pitching: new Set([
    "ERA", "WHIP", "BB/9", "OPS", "ERA-", "BABIP", "xERA", "xwOBA", "xBA", "xSLG",
    "EV", "Barrel%", "Hard-Hit%", "BB%",
  ]),
};
const TRADITIONAL = {
  hitting: [
    ["AVG", "打擊率", 3], ["OBP", "上壘率", 3], ["SLG", "長打率", 3], ["OPS", "攻擊指數", 3],
    ["HR", "全壘打"], ["RBI", "打點"], ["H", "安打"], ["R", "得分"], ["SB", "盜壘"],
  ],
  pitching: [
    ["ERA", "防禦率", 2], ["WHIP", "每局被上壘率", 2], ["K/9", "每九局三振", 2], ["BB/9", "每九局保送", 2],
    ["IP", "投球局數"], ["SO", "三振"], ["W", "勝投"], ["SV", "救援成功"], ["HLD", "中繼成功"],
  ],
};
const ADVANCED = {
  hitting: [
    ["wRC+", "加權得分創造指數"], ["xwOBA", "預期加權上壘率", 3], ["xBA", "預期打擊率", 3], ["xSLG", "預期長打率", 3],
    ["BABIP", "場內安打率", 3], ["EV", "平均擊球初速", 1, " mph"], ["Barrel%", "紮實擊球率", 1, "%"],
    ["Hard-Hit%", "強勁擊球率", 1, "%"], ["SweetSpot%", "理想仰角率", 1, "%"],
    ["Bat Speed", "揮棒速度", 1, " mph"], ["Squared-Up%", "達 80% 潛在初速", 1, "%"],
    ["Chase%", "追打率", 1, "%"], ["Whiff%", "揮空率", 1, "%"], ["K%", "三振率", 1, "%"],
    ["BB%", "保送率", 1, "%"], ["Sprint", "衝刺速度", 1, " ft/s"],
  ],
  pitching: [
    ["ERA-", "校正防禦率指數"], ["xERA", "預期防禦率", 2], ["xwOBA", "被預期加權上壘率", 3],
    ["xBA", "被預期打擊率", 3], ["xSLG", "被預期長打率", 3], ["OPS", "被攻擊指數", 3],
    ["BABIP", "被場內安打率", 3], ["EV", "被平均擊球初速", 1, " mph"],
    ["Barrel%", "被紮實擊球率", 1, "%"], ["Hard-Hit%", "被強勁擊球率", 1, "%"],
    ["Chase%", "對手追打率", 1, "%"], ["Whiff%", "製造揮空率", 1, "%"], ["K%", "三振率", 1, "%"], ["BB%", "保送率", 1, "%"],
  ],
};
const bundleRequests = new Map();
const countFormat = new Intl.NumberFormat("zh-TW");

function loadBundle(part) {
  if (!bundleRequests.has(part)) {
    const historyBundle = part === "history";
    const path = historyBundle ? "percentile-history.json.gz" : "percentile-current.json";
    bundleRequests.set(part, fetch(`data/${path}?v=1`, { signal: AbortSignal.timeout(20_000) })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!historyBundle) return response.json();
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(bytes));
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        return new Response(stream).json();
      })
      .then(data => {
        if (!data?.seasons || !data.capturedAt) throw new Error("Invalid percentile bundle");
        return data;
      })
      .catch(error => {
        bundleRequests.delete(part);
        throw error;
      }));
  }
  return bundleRequests.get(part);
}

async function loadSeason(year) {
  const current = await loadBundle("current");
  if (current.seasons[year]) return { groups: current.seasons[year], capturedAt: current.capturedAt };
  if (Number(year) > Math.max(...Object.keys(current.seasons).map(Number))) return {};
  const history = await loadBundle("history");
  return { groups: history.seasons[year], capturedAt: history.capturedAt };
}

function actualValue(key, value, digits, unit) {
  if (!Number.isFinite(value)) return "—";
  if (key === "IP") return `${Math.trunc(value / 3)}.${value % 3}`;
  if (digits === undefined) return countFormat.format(value);
  const numeric = value.toFixed(digits);
  return (digits === 3 ? numeric.replace(/^0(?=\.)/, "") : numeric) + (unit ?? "");
}

function isPercentile(rank) {
  return Number.isInteger(rank) && rank >= 0 && rank <= 100;
}

function referencePercentile(peers, valueIndex, value, lowerIsBetter) {
  let sample = 0;
  let behind = 0;
  let tied = 0;
  for (const row of peers) {
    const peerValue = row[valueIndex];
    if (!Number.isFinite(peerValue) || !isPercentile(row[valueIndex + 1])) continue;
    sample += 1;
    if (peerValue === value) tied += 1;
    else if (lowerIsBetter ? peerValue > value : peerValue < value) behind += 1;
  }
  return sample ? Math.round(100 * (behind + tied / 2) / sample) : null;
}

function metricRow(definition, values) {
  const [key, name, digits, unit] = definition;
  const [value, rank, reference] = values.get(key) ?? [];
  const hasRank = isPercentile(rank);
  const tone = rank < 50 ? "#30578f" : "#b3222d";
  const strength = Math.abs(rank - 50) * 2;
  const properties = hasRank ? ` style="--pr:${rank}%;--pr-tone:color-mix(in srgb,${tone} ${strength}%,#617381)"` : "";
  const marker = reference ? '<sup aria-hidden="true">＊</sup>' : "";
  const rankLabel = reference ? "參考 PR " : "PR ";
  return `<li class="pr-row" data-metric="${key}">
    <span class="pr-metric"><strong>${key}${marker}</strong><small>${name}</small></span>
    <span class="pr-track"${properties}>
      ${hasRank ? `<span class="pr-fill" aria-hidden="true"></span><span class="pr-badge"><span class="visually-hidden">${rankLabel}</span>${rank}</span>` :
        '<span class="pr-unranked"><span aria-hidden="true">—</span><span class="visually-hidden">無百分位</span></span>'}
    </span>
    <span class="pr-actual"><span class="visually-hidden">實際數值 </span>${actualValue(key, value, digits, unit)}</span>
  </li>`;
}

function chart(id, title, definitions, values) {
  return `<section class="pr-card" aria-labelledby="${id}">
    <h4 id="${id}">${title}</h4>
    <div class="pr-columns pr-key" aria-hidden="true"><span>指標</span>
      <span class="pr-ticks"><span>PR 0</span><span>50</span><span>100</span></span><span>實際數值</span></div>
    <ul class="pr-rows" role="list">${definitions.map(definition => metricRow(definition, values)).join("")}</ul>
  </section>`;
}

function sourceDetails(role, year, board, capturedAt) {
  const type = role === "hitting" ? "batter" : "pitcher";
  const extra = role === "hitting" && Number(year) >= 2015 ? "、理想仰角率" : "";
  const history = Number(year) < 2015 ? " 此球季的 K% 與 BB% 依 MLB 官方打席和計數資料計算。" : "";
  const statcast = Number(year) >= 2015
    ? `Statcast 指標優先採用 <a href="https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=${type}&amp;year=${year}" target="_blank" rel="noopener noreferrer">Baseball Savant 官方 PR</a> 與同季實際數值。`
    : "Baseball Savant 的 Statcast 百分位自 2015 年起提供。";
  const direction = role === "hitting" ? "打者的三振率、揮空率與追打率較低時，PR 較高。" : "防禦率、ERA-、被 OPS 與保送率較低時，PR 較高。";
  return `<details class="pr-sources">
    <summary>比較方式與資料來源</summary>
    <p>比較範圍為同一球季的 MLB 例行賽，合併美聯與國聯。同季轉隊採整季合計。${direction}</p>
    <p>${statcast}${history} 傳統比率、BABIP${extra}及 <a href="https://www.fangraphs.com/leaders/major-league" target="_blank" rel="noopener noreferrer">FanGraphs 的 ${role === "hitting" ? "wRC+" : "ERA-"}</a> 由本站換算百分位。這些指標的比較組是同季達 ${board.minimum} ${SAMPLE_LABEL[role]}的 ${board.qualified} 位${role === "hitting" ? "打者" : "投手"}。</p>
    <p>標有＊的參考 PR 以同季、同一指標已有數值和排名的球員作比較。樣本越少，單場結果對 PR 的影響越大。</p>
    <p>累計數據比較所有有${SAMPLE_LABEL[role]}紀錄的球員。本站換算時，同值球員採並列名次的中點。<a href="https://www.mlb.com/stats/" target="_blank" rel="noopener noreferrer">MLB 傳統數據</a>與各來源快照取用日期為 ${taipeiTime(capturedAt).date}。</p>
  </details>`;
}

function showCharts(panel, group, year, board, playerId, capturedAt) {
  const row = board?.players[playerId];
  if (!row) {
    panel.innerHTML = '<div class="empty-state"><strong>此球季尚無球員排名</strong><p>可以切換球季，或在基本成績查看這一年的資料。</p></div>';
    return;
  }
  const peers = Object.values(board.players);
  const values = new Map(board.columns.map((key, index) => {
    const valueIndex = 2 * index + 1;
    const value = row[valueIndex];
    const rank = row[valueIndex + 1];
    if (isPercentile(rank) || !Number.isFinite(value)) return [key, [value, rank]];

    const reference = referencePercentile(peers, valueIndex, value, LOWER_IS_BETTER[group].has(key));
    return [key, [value, reference, isPercentile(reference)]];
  }));
  const advanced = ADVANCED[group].filter(([key]) => values.get(key)?.some(Number.isFinite));
  const sample = row[0] < board.minimum ? " · 小樣本" : "";
  const referenceNote = [...values.values()].some(([, , reference]) => reference)
    ? "＊ 為本站補算的參考 PR。" : "";
  panel.innerHTML = `<p class="pr-sample">${countFormat.format(row[0])} ${SAMPLE_LABEL[group]}${sample} · PR 越高代表該項表現越靠前，50 居中。<span>${referenceNote}— 表示缺少可用數值或比較資料。</span></p>
    <nav class="stat-jumps pr-jumps" aria-label="跳到百分位類別"><a href="#pr-advanced">進階數據</a><a href="#pr-traditional">傳統數據</a></nav>
    <div class="pr-grid">
      ${chart("pr-advanced", "進階數據", advanced, values)}
      ${chart("pr-traditional", "傳統數據", TRADITIONAL[group], values)}
    </div>
    ${sourceDetails(group, year, board, capturedAt)}`;
}

export function renderPercentiles(container, playerId, rows) {
  const knownRows = rows.filter(row => Object.hasOwn(ROLE_LABEL, row.group));
  const seasons = Map.groupBy(knownRows, row => row.season);
  const years = [...seasons.keys()].sort((a, b) => Number(b) - Number(a));
  if (!years.length) {
    container.innerHTML = '<div class="empty-state"><strong>這位球員尚無 MLB 例行賽紀錄</strong><p>聯盟百分位按 MLB 例行賽球季比較。</p><button class="reset-filter" data-select-scope="minors" type="button">查看小聯盟成績</button></div>';
    return;
  }
  const params = new URLSearchParams(location.search);
  const year = seasons.has(params.get("prYear")) ? params.get("prYear") : years[0];
  const available = new Set(seasons.get(year).map(row => row.group));
  const roles = Object.keys(ROLE_LABEL).filter(group => available.has(group));
  const group = roles.includes(params.get("prRole")) ? params.get("prRole") : roles[0];
  const panel = document.createElement("section");
  panel.className = "pr-panel";
  panel.setAttribute("aria-labelledby", "pr-title");
  panel.innerHTML = `<header class="pr-heading"><div>
      <h3 id="pr-title">${year} MLB 聯盟百分位</h3><p>例行賽 · ${ROLE_LABEL[group]} · MLB 30 隊</p>
    </div><div class="pr-controls">
      <label for="pr-season">球季 <select id="pr-season">${years.map(value =>
        `<option value="${value}"${value === year ? " selected" : ""}>${value}</option>`,
      ).join("")}</select></label>
      ${roles.length > 1 ? `<div class="scope-switch" role="group" aria-label="二刀流成績">${roles.map(value =>
        `<button type="button" data-pr-role="${value}" aria-pressed="${value === group}">${ROLE_LABEL[value]}</button>`,
      ).join("")}</div>` : ""}
    </div></header>
    <div class="pr-content" aria-busy="true"><p class="loading-message" role="status">正在讀取 ${year} 年聯盟百分位…</p></div>`;
  container.replaceChildren(panel);

  function updateSelection(name, value, focusSelector) {
    const url = new URL(location.href);
    url.searchParams.set(name, value);
    history.replaceState(null, "", url);
    renderPercentiles(container, playerId, rows);
    container.querySelector(focusSelector)?.focus({ preventScroll: true });
  }

  panel.querySelector("#pr-season").addEventListener("change", event => updateSelection("prYear", event.target.value, "#pr-season"));
  for (const button of panel.querySelectorAll("[data-pr-role]")) {
    const role = button.dataset.prRole;
    button.addEventListener("click", () => updateSelection("prRole", role, `[data-pr-role="${role}"]`));
  }
  const output = panel.querySelector(".pr-content");
  loadSeason(year).then(({ groups, capturedAt }) => {
    if (panel.isConnected) showCharts(output, group, year, groups?.[group], playerId, capturedAt);
  }).catch(error => {
    if (!panel.isConnected) return;
    console.warn("Could not load MLB percentile data", error);
    output.innerHTML = '<div class="empty-state"><strong>聯盟百分位暫時無法載入</strong><button class="retry-button" type="button">重新載入</button></div>';
    output.querySelector("button").addEventListener("click", () => renderPercentiles(container, playerId, rows));
  }).finally(() => output.setAttribute("aria-busy", "false"));
}
