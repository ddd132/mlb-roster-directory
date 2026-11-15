import { escape, fetchTransactions, taipeiTime, teamLogo, transactionDateRange } from "./mlb.js?v=3";

const typeLabels = {
  CU: ["roster", "升上大聯盟"],
  OPT: ["roster", "下放小聯盟"],
  SE: ["roster", "選入大聯盟名單"],
  ASG: ["roster", "指派球隊"],
  TR: ["trade", "交易"],
  DES: ["waivers", "指定讓渡（DFA）"],
  CLW: ["waivers", "讓渡認領"],
  OUT: ["waivers", "直接下放（Outright）"],
  // MLB's DFA code stands for Declared Free Agency. Designations use DES.
  DFA: ["contracts", "成為自由球員"],
  SGN: ["contracts", "簽約"],
  SFA: ["contracts", "簽下自由球員"],
  REL: ["contracts", "釋出"],
  CP: ["contracts", "買入合約"],
  ACQ: ["other", "取得球員"],
  NUM: ["other", "更換背號"],
  R5: ["other", "規則五選秀"],
  R5M: ["other", "規則五選秀（小聯盟）"],
  RTN: ["other", "送回原球隊"],
  SC: ["other", "名單狀態變動"],
};

const PAGE_SIZE = 20;
const RECENT_LEAGUE_DAYS = 30;
const HISTORY_REFRESH_INTERVAL = 86_400_000;

function transactionType(row) {
  const description = row.description ?? "";
  if (/\brehab assignment\b/i.test(description)) {
    const ended = /\b(?:returned|recalled|activated|reinstated)\b/i.test(description);
    return ["injury", ended ? "結束復健指派" : "復健指派"];
  }
  if (/\b(?:injured|disabled) list\b/i.test(description) && row.typeCode === "SC") {
    if (/\b(?:activated|reinstated)\b/i.test(description)) return ["injury", "移出傷兵名單"];
    if (/\btransferred\b/i.test(description)) return ["injury", "轉換傷兵名單"];
    if (/\bplaced\b/i.test(description)) return ["injury", "進入傷兵名單"];
    return ["injury", "傷兵名單異動"];
  }
  return Object.hasOwn(typeLabels, row.typeCode) ? typeLabels[row.typeCode] : ["other", row.typeDesc || "其他異動"];
}

function groupTransactions(rows) {
  const events = new Map();
  const seenRows = new Set();
  for (const row of rows) {
    // MLB sends one row per participant with the same ID for a trade.
    const eventKey = `${row.date}/${row.typeCode}/${row.id}`;
    const rowKey = `${eventKey}/${row.person?.id ?? row.person?.fullName ?? ""}/${row.fromTeam?.id ?? ""}/${row.toTeam?.id ?? ""}`;
    if (seenRows.has(rowKey)) continue;
    seenRows.add(rowKey);
    const [category, label] = transactionType(row);
    const key = category === "trade" ? eventKey : rowKey;
    if (!events.has(key)) events.set(key, { date: row.date, id: row.id, category, label, rows: [] });
    events.get(key).rows.push(row);
  }
  return [...events.values()].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

function officialTransactionsUrl(team) {
  return team ? new URL("transactions", team.rosterUrl).href : "https://www.mlb.com/roster/transactions";
}

function playerLink(person, team, eventId) {
  if (!person?.fullName) return "";
  const name = escape(person.fullName);
  if (!Number.isSafeInteger(person.id) || person.id <= 0) return name;
  const teamParam = team ? `&amp;team=${escape(team.abbr)}` : "";
  return `<a href="player.html?id=${person.id}${teamParam}" data-transaction-player="${eventId}-${person.id}">${name}</a>`;
}

function clubLink(club, getTeam) {
  const team = getTeam(club.id);
  if (!team) return escape(club.name);
  return `<a class="transaction-club" href="?team=${escape(team.abbr)}&amp;view=transactions#roster">
    <img src="${teamLogo(team)}" alt="" width="17" height="17" loading="lazy">${escape(team.nameZh)}
  </a>`;
}

function tradeMarkup(title, groups, description, leagueTrade = false) {
  const rows = groups.filter(([, players]) => players.size)
    .map(([label, players]) => `<div><dt>${escape(label)}</dt><dd>${[...players.values()].join("、")}</dd></div>`).join("");
  const extras = [];
  if (/\bcash considerations?\b/i.test(description)) extras.push("現金");
  if (/\bplayers? to be named later\b/i.test(description)) extras.push("日後指定球員");
  if (/\bother considerations?\b/i.test(description)) extras.push("其他交易條件");
  return `<h3>${title}</h3>${rows ? `<dl class="transaction-trade${leagueTrade ? " transaction-trade-league" : ""}">${rows}</dl>` : ""}
    ${extras.length ? `<p>另含${extras.join("、")}</p>` : ""}`;
}

function tradeDetails(event, team, teamName) {
  const partners = new Map();
  const arrivals = new Map();
  const departures = new Map();
  const unassigned = new Map();
  for (const { fromTeam, toTeam, person } of event.rows) {
    for (const club of [fromTeam, toTeam]) {
      if (club && club.id !== team.id) partners.set(club.id, teamName(club));
    }
    const link = playerLink(person, team, event.id);
    if (!link) continue;
    const players = toTeam?.id === team.id ? arrivals : fromTeam?.id === team.id ? departures : unassigned;
    players.set(person.id ?? person.fullName, link);
  }
  const title = partners.size ? [...partners.values()].join("、") : "球員交易";
  return tradeMarkup(escape(title), [["獲得", arrivals], ["送出", departures], ["涉及球員", unassigned]], event.rows[0].description);
}

function leagueTradeDetails(event, getTeam, teamName) {
  const clubs = new Map();
  const directions = new Map();
  for (const { fromTeam, toTeam, person } of event.rows) {
    for (const club of [fromTeam, toTeam]) {
      if (club) clubs.set(club.id, club);
    }
    const playerTeam = getTeam(toTeam?.id) ?? getTeam(fromTeam?.id);
    const link = playerLink(person, playerTeam, event.id);
    if (!link) continue;
    const key = `${fromTeam?.id ?? ""}/${toTeam?.id ?? ""}`;
    if (!directions.has(key)) directions.set(key, { fromTeam, toTeam, players: new Map() });
    directions.get(key).players.set(person.id ?? person.fullName, link);
  }
  const title = [...clubs.values()].map(club => clubLink(club, getTeam)).join(" · ") || "球員交易";
  const groups = [...directions.values()].map(({ fromTeam, toTeam, players }) => {
    let label = "涉及球員";
    if (fromTeam && toTeam) label = `${teamName(fromTeam)} → ${teamName(toTeam)}`;
    else if (toTeam) label = `${teamName(toTeam)}獲得`;
    else if (fromTeam) label = `${teamName(fromTeam)}送出`;
    return [label, players];
  });
  return tradeMarkup(title, groups, event.rows[0].description, true);
}

function transactionDetails(event, team, teamName) {
  const row = event.rows[0];
  const player = playerLink(row.person, team, event.id);
  const description = row.description ?? "";
  let detail = "";
  if (row.fromTeam && row.toTeam && row.fromTeam.id !== row.toTeam.id) {
    detail = `${teamName(row.fromTeam)} → ${teamName(row.toTeam)}`;
  } else if (event.category === "injury") {
    const list = [...description.matchAll(/(\d+)-day (?:injured|disabled) list/gi)].at(-1);
    if (list) detail = `${list[1]} 天傷兵名單`;
  } else if (/\bminor league contract\b/i.test(description)) {
    detail = "小聯盟合約";
  } else if (/\bmajor league contract\b/i.test(description)) {
    detail = "大聯盟合約";
  }
  return `${player ? `<h3>${player}</h3>` : ""}${detail ? `<p>${escape(detail)}</p>` : ""}`;
}

function transactionMarkup(event, team, getTeam, teamName) {
  const month = event.date.slice(0, 7).replace("-", "/");
  const trade = event.category === "trade";
  const row = event.rows[0];
  const playerTeam = team ?? getTeam(row.toTeam?.id) ?? getTeam(row.fromTeam?.id);
  const club = !team && !trade && playerTeam ? clubLink(playerTeam, getTeam) : "";
  const details = trade
    ? (team ? tradeDetails(event, team, teamName) : leagueTradeDetails(event, getTeam, teamName))
    : transactionDetails(event, playerTeam, teamName);
  return `<li class="transaction-item">
    <a class="transaction-date" href="${escape(`${officialTransactionsUrl(team)}/${month}`)}" target="_blank" rel="noopener noreferrer" title="查看該月 MLB 官方異動">
      <time datetime="${event.date}">${event.date.replaceAll("-", "/")}</time>
    </a>
    <div class="transaction-copy">
      <div class="transaction-meta"><span class="transaction-label" data-category="${event.category}">${escape(event.label)}</span>${club}</div>
      ${details}
    </div>
  </li>`;
}

function createTransactionsView(panel, getTeam, refreshInterval) {
  const period = panel.querySelector("#transaction-period");
  const filters = panel.querySelector("#transaction-filters");
  const status = panel.querySelector("#transaction-status");
  const results = panel.querySelector("#transaction-results");
  const retry = panel.querySelector("#transaction-retry");
  const more = panel.querySelector("#transaction-more");
  const cache = new Map();
  const pending = new Set();
  // An undefined team closes the panel. A null selection includes all MLB teams.
  let team;
  let category = "all";
  let limit = PAGE_SIZE;
  const currentKey = () => `${team?.id ?? "league"}/${period.value}`;
  const teamName = club => getTeam(club.id)?.nameZh ?? club.name ?? "球隊未列出";

  function render() {
    const key = currentKey();
    const result = cache.get(key);
    const loading = pending.has(key);
    const entries = category === "all" ? result?.entries : result?.entries?.filter(event => event.category === category);
    more.hidden = !entries || entries.length <= limit;
    retry.hidden = !result?.failed || loading;
    results.setAttribute("aria-busy", String(loading && !entries));
    if (!entries) {
      status.textContent = result?.failed && !loading ? "暫時無法查詢 MLB 異動。" : "正在查詢 MLB 官方異動…";
      results.replaceChildren();
      return;
    }

    const clock = taipeiTime(result.checkedAt);
    status.textContent = result.failed
      ? `${entries.length} 筆 · 顯示上次成功查詢的紀錄（${clock.date} ${clock.clock}）`
      : `${entries.length} 筆 · ${clock.clock} 已查詢 MLB`;
    const focused = document.activeElement?.dataset.transactionPlayer;
    results.innerHTML = entries.length
      ? `<ol class="transaction-list">${entries.slice(0, limit).map(event => transactionMarkup(event, team, getTeam, teamName)).join("")}</ol>`
      : '<div class="empty-state"><strong>這段期間沒有符合條件的異動</strong><p>可以調整日期範圍或異動類型。</p></div>';
    if (!more.hidden) more.textContent = `再顯示 ${Math.min(PAGE_SIZE, entries.length - limit)} 筆`;
    if (focused) results.querySelector(`[data-transaction-player="${focused}"]`)?.focus({ preventScroll: true });
  }

  async function refresh(force = false) {
    if (team === undefined || document.visibilityState === "hidden") return;
    const key = currentKey();
    const previous = cache.get(key);
    const startedAt = Date.now();
    if (pending.has(key) || (!force && previous && startedAt - previous.startedAt < refreshInterval)) return;
    const league = team === null;
    const days = Number(period.value);
    const now = new Date(startedAt);
    const recentOnly = league && days > RECENT_LEAGUE_DAYS && !force
      && startedAt - previous?.fullAt < HISTORY_REFRESH_INTERVAL;
    pending.add(key);
    if (!previous?.entries || previous.failed) render();
    try {
      const rows = await fetchTransactions(team?.id, recentOnly ? RECENT_LEAGUE_DAYS : days, now);
      let entries = groupTransactions(rows);
      if (league) entries = entries.filter(event => event.rows.some(row => getTeam(row.fromTeam?.id) || getTeam(row.toTeam?.id)));
      if (recentOnly) {
        const { startDate } = transactionDateRange(days, now);
        const recentStart = transactionDateRange(RECENT_LEAGUE_DAYS, now).startDate;
        entries.push(...previous.entries.filter(event => event.date >= startDate && event.date < recentStart));
      }
      cache.set(key, { entries, checkedAt: Date.now(), startedAt, fullAt: recentOnly ? previous.fullAt : startedAt });
    } catch (error) {
      console.warn("Could not refresh MLB team transactions", error);
      cache.set(key, { ...previous, startedAt, failed: true });
    } finally {
      pending.delete(key);
      if (team !== undefined && currentKey() === key) render();
    }
  }

  function open(selected) {
    if (team === selected || (team && selected && team.id === selected.id)) return;
    team = selected;
    limit = PAGE_SIZE;
    render();
    void refresh();
  }

  filters.addEventListener("click", event => {
    const button = event.target.closest("[data-transaction-filter]");
    if (!button || team === undefined) return;
    category = button.dataset.transactionFilter;
    limit = PAGE_SIZE;
    for (const option of filters.querySelectorAll("button")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
    render();
  });
  period.addEventListener("change", () => {
    if (team === undefined) return;
    limit = PAGE_SIZE;
    render();
    void refresh();
  });
  retry.addEventListener("click", () => void refresh(true));
  more.addEventListener("click", () => {
    const firstNewIndex = limit;
    limit += PAGE_SIZE;
    render();
    if (more.hidden) results.querySelectorAll(".transaction-item")[firstNewIndex]?.querySelector("a")?.focus();
  });

  return { open, close: () => { team = undefined; }, refresh };
}

export { createTransactionsView, officialTransactionsUrl };
