import { escape, fetchMinorRoster, mlbCalendarDate } from "./mlb.js";
import { loadMinorMetadata, minorLevelLabel, rule5Mark } from "./team-details.js";

const POSITIONS = [
  ["P", "投手"], ["C", "捕手"], ["1B", "一壘"], ["2B", "二壘"], ["3B", "三壘"], ["SS", "游擊"],
  ["LF", "左外野"], ["CF", "中外野"], ["RF", "右外野"], ["OF", "全部外野"], ["DH", "指定打擊"],
];
const positionLabels = new Map(POSITIONS);
const collator = new Intl.Collator("en", { sensitivity: "base" });
const fieldPosition = new Set(["P", "RHP", "LHP", "SP", "RP", "CL", "TWP"]);
const outfield = new Set(["OF", "LF", "CF", "RF"]);

function hasPosition(position, target) {
  const positions = String(position ?? "").toUpperCase().split("/");
  if (target === "P") return positions.some(code => fieldPosition.has(code));
  if (target === "OF") return positions.some(code => outfield.has(code));
  return positions.includes(target) || target === "DH" && positions.includes("TWP");
}

function gamesAt(fielding, position) {
  if (position !== "OF") return fielding[position] ?? 0;
  // A player may cover several spots in one game. Use the most-played outfield spot here.
  return Math.max(fielding.LF ?? 0, fielding.CF ?? 0, fielding.RF ?? 0);
}

function match(player, position, played, prospect, fielding) {
  const games = gamesAt(fielding, position);
  if (hasPosition(player.position, position)) return { priority: 0, reason: "名單守位", games };
  if (played && games > 0) return { priority: 1, reason: "本季曾出賽", games };
  if (hasPosition(prospect?.position, position)) return { priority: 2, reason: "Pipeline 列有此守位", games };
  return null;
}

function playerHref(player, team, position, minor) {
  const query = new URLSearchParams({ id: player.id, team: team.abbr, from: "depth", pos: position });
  if (minor) query.set("scope", "minors");
  return `player.html?${query}`;
}

function rosterSection(title, source, rows, team, pos, details, minor = false) {
  return `<section class="depth-tier">
    <div class="depth-tier-header"><div><h4>${escape(title)}</h4><small>${escape(source)}</small></div><span>${rows.length} 位</span></div>
    ${rows.length ? `<ul>${rows.map(row => {
      const p = row.player;
      const rank = row.prospect;
      const appearances = row.match.games && pos !== "OF" ? ` · ${row.match.games} 場` : "";
      const info = `${p.position ?? "—"} · ${row.match.reason}${appearances}`;
      return `<li><div><a href="${escape(playerHref(p, team, pos, minor))}">${escape(p.name)}</a><small>${escape(info)}</small></div>
        <div class="depth-tags">${rank ? `<span class="depth-rank">Top ${rank.rank}</span>` : ""}${minor && details ? rule5Mark(details, p.id, team.id) : ""}</div></li>`;
    }).join("")}</ul>` : '<p>這一層目前沒有符合守位的球員。</p>'}
  </section>`;
}

function prospectSection(team, board, position, details, assignmentByPlayer) {
  if (!board) return '<section class="depth-tier"><div class="depth-tier-header"><h4>球團 Top 30</h4></div><p>暫時無法載入 MLB Pipeline 榜單。</p></section>';
  const rows = board.players.filter(p => hasPosition(p.position, position));
  return `<section class="depth-tier depth-prospects">
    <div class="depth-tier-header"><div><h4>球團 Top 30</h4><small>${escape(board.year)} MLB Pipeline</small></div><span>${rows.length} 位</span></div>
    ${rows.length ? `<ul>${rows.map(p => {
      const assignment = assignmentByPlayer.get(p.id);
      const level = minorLevelLabel[assignment ?? p.level] ?? "層級待查";
      const detail = [p.position, level, p.eta ? `預計 ${p.eta} 登上 MLB` : ""].filter(Boolean).join(" · ");
      return `<li><div><a href="${escape(playerHref(p, team, position, assignment !== 1 && Number(p.level) !== 1))}">${escape(p.name)}</a><small>${escape(detail)}</small></div>
        <div class="depth-tags"><span class="depth-rank">#${p.rank}</span>${details ? rule5Mark(details, p.id, team.id) : ""}</div></li>`;
    }).join("")}</ul>` : '<p>Top 30 目前沒有列出這個守位的球員。</p>'}
  </section>`;
}

export function validDepthPosition(value) {
  return positionLabels.has(value) ? value : "SS";
}

export function createDepthView(panel, onPositionChange) {
  const select = panel.querySelector("select");
  const includePlayed = panel.querySelector('input[type="checkbox"]');
  const status = panel.querySelector(".depth-summary");
  const output = panel.querySelector(".depth-grid");
  let minorData;
  let pipeline;
  let pending;
  let active;
  const recent = new Map();
  const refreshes = new Map();

  select.replaceChildren(...POSITIONS.map(([pos, label]) => new Option(`${label}（${pos}）`, pos)));
  select.addEventListener("change", () => onPositionChange(select.value));
  includePlayed.addEventListener("change", render);
  panel.addEventListener("click", event => {
    if (event.target.closest("[data-depth-retry]")) void loadMinors();
  });

  async function loadMinors() {
    if (pending || minorData) return;
    pending = true;
    if (!panel.hidden) status.textContent = "正在讀取球團附屬隊與新秀榜…";
    try {
      [minorData, pipeline] = await loadMinorMetadata();
      render();
      if (active && !panel.hidden) void refreshAffiliates(active.team.id);
    } catch (error) {
      console.warn("Could not load depth chart rosters", error);
      status.textContent = "暫時無法載入附屬隊資料";
      output.innerHTML = '<div class="empty-state"><button type="button" class="retry-button" data-depth-retry>重新載入</button></div>';
    } finally {
      pending = false;
    }
  }

  async function refreshAffiliates(orgId) {
    if (!minorData || panel.hidden || document.visibilityState === "hidden"
        || Date.now() - (refreshes.get(orgId) ?? 0) < 120_000) return;
    refreshes.set(orgId, Date.now());
    const today = mlbCalendarDate();
    const teams = minorData.affiliates.filter(t => t.orgId === orgId && (t.level === 11 || t.level === 12));
    await Promise.allSettled(teams.map(async team => {
      const players = await fetchMinorRoster(team.id, today);
      recent.set(team.id, { players, date: today });
    }));
    if (active?.team.id === orgId && !panel.hidden) render();
  }

  function render() {
    if (!active || panel.hidden || !minorData) return;
    const { team, details, position, date } = active;
    const board = pipeline?.byTeam[team.id];
    const prospects = new Map(board?.players.map(p => [p.id, p]));
    const playersByLevel = new Map();
    const assignmentByPlayer = new Map();
    for (const t of minorData.affiliates.filter(t => t.orgId === team.id)) {
      if (t.level === 11 || t.level === 12) {
        const available = details?.depth[t.id];
        const fallback = available && available[0] >= minorData.rosterDate
          ? { date: available[0], players: available[1].map(([id, name, position, status]) => ({ id, name, position, status })) }
          : { players: t.players, date: minorData.rosterDate };
        const minor = recent.get(t.id) ?? fallback;
        playersByLevel.set(t.level, { teamId: t.id, name: t.name, ...minor });
        for (const p of minor.players) assignmentByPlayer.set(p.id, t.level);
      }
    }
    // A 40-man player can still be playing in Triple-A or Double-A.
    for (const p of team.players) if (!assignmentByPlayer.has(p.id)) assignmentByPlayer.set(p.id, 1);

    function rowsFor(players, teamId) {
      const fielding = details?.fielding[teamId];
      return players.map(player => ({
        player, prospect: prospects.get(player.id),
        match: match(player, position, includePlayed.checked, prospects.get(player.id), fielding?.[player.id] ?? {}),
      })).filter(row => row.match).sort((a, b) => a.match.priority - b.match.priority
        || b.match.games - a.match.games || collator.compare(a.player.name, b.player.name));
    }

    const focus = output.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
    const html = [rosterSection("大聯盟 40 人名單", date, rowsFor(team.players, team.id), team, position, details)];
    for (const level of [11, 12]) {
      const affiliate = playersByLevel.get(level);
      const rows = affiliate ? rowsFor(affiliate.players, affiliate.teamId) : [];
      html.push(rosterSection(minorLevelLabel[level], affiliate ? `${affiliate.name} · ${affiliate.date}` : "附屬隊資料暫缺",
        rows, team, position, details, true));
    }
    html.push(prospectSection(team, board && { ...board, year: pipeline.season }, position, details, assignmentByPlayer));
    status.textContent = `${team.nameZh} · ${positionLabels.get(position)}${details ? ` · ${details.season} 年例行賽守位` : ""}`;
    output.innerHTML = html.join("");
    if (focus) [...output.querySelectorAll("a")].find(link => link.getAttribute("href") === focus)?.focus({ preventScroll: true });
    const boardLink = panel.querySelector("[data-depth-prospect-link]");
    if (boardLink) boardLink.href = `minors.html?team=${encodeURIComponent(team.abbr)}&view=team-prospects#minors`;
  }

  function open(team, date, position, details) {
    active = { team, date, position, details };
    select.value = position;
    render();
    if (minorData) void refreshAffiliates(team.id);
    else void loadMinors();
  }
  return { open };
}
