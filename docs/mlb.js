const API_ROOT = "https://statsapi.mlb.com/api/v1";
const MLB_ORIGIN = "https://www.mlb.com";
const PHOTO_ROOT = "https://img.mlbstatic.com/mlb-photos/image/upload";
const ROSTER_FIELDS = "teamId,rosterType,roster,person,id,fullName,position,code,name,abbreviation,status,description,jerseyNumber,parentTeamId";
const MINOR_ROSTER_FIELDS = "teamId,rosterType,roster,person,id,fullName,position,abbreviation,status,description";
const TRANSACTION_FIELDS = "transactions,id,person,fullName,fromTeam,toTeam,name,date,typeCode,typeDesc,description";
const LIVE_CACHE_KEY = "mlb-40-man-latest-v2";
const MINOR_LEVELS = [11, 12, 13, 14, 15, 16];
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
const mlbDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const clockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

const positions = {
  P: ["pitcher", "投手"], SP: ["pitcher", "先發投手"], RP: ["pitcher", "後援投手"],
  C: ["catcher", "捕手"], "1B": ["infield", "一壘手"], "2B": ["infield", "二壘手"],
  "3B": ["infield", "三壘手"], SS: ["infield", "游擊手"], IF: ["infield", "內野手"],
  LF: ["outfield", "左外野手"], CF: ["outfield", "中外野手"], RF: ["outfield", "右外野手"],
  OF: ["outfield", "外野手"], DH: ["other", "指定打擊"], TWP: ["other", "二刀流"],
  UT: ["other", "工具人"],
};

const countries = {
  USA: "美國", Taiwan: "台灣", Japan: "日本", "Republic of Korea": "韓國", "South Korea": "韓國",
  Canada: "加拿大", Mexico: "墨西哥", "Dominican Republic": "多明尼加", Venezuela: "委內瑞拉",
  Cuba: "古巴", Colombia: "哥倫比亞", "Puerto Rico": "波多黎各", Panama: "巴拿馬",
  Nicaragua: "尼加拉瓜", Curacao: "庫拉索", "Curaçao": "庫拉索", Australia: "澳洲",
  Germany: "德國", Brazil: "巴西", Aruba: "阿魯巴", Bahamas: "巴哈馬", Honduras: "宏都拉斯",
};

const escapeChars = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => escapeChars[character]);
const countryName = country => countries[country] ?? country;
const teamLogo = team => `assets/teams/${team.id}.png`;

function formattedParts(formatter, date) {
  return Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== "literal")
    .map(part => [part.type, part.value]));
}

function taipeiDate(date = new Date()) {
  const { year, month, day } = formattedParts(dateFormatter, date);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function taipeiTime(value) {
  const { year, month, day, hour, minute } = formattedParts(clockFormatter, new Date(value));
  return { date: `${year}.${month}.${day}`, clock: `${hour}:${minute}` };
}

function apiUrl(path, params = {}) {
  const query = new URLSearchParams(params);
  return `${API_ROOT}${path}${query.size ? `?${query}` : ""}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(16_000), ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${url}`);
  return response.json();
}

function fetchSnapshot() {
  return requestJson("data/rosters.json");
}

function readLastRoster(base) {
  try {
    const cached = JSON.parse(localStorage.getItem(LIVE_CACHE_KEY));
    if (cached?.rosterType === base.rosterType
      && cached.teams?.map(team => team.id).join(",") === base.teams.map(team => team.id).join(",")
      && Date.parse(cached.capturedAt) > Date.parse(base.capturedAt)) return cached;
  } catch {
    // The bundled fallback is available even when browser storage is disabled.
  }
  return base;
}

function rememberRoster(snapshot) {
  try {
    localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Continue to serve the current in-memory list.
  }
}

function photoUrl(id) {
  return `${PHOTO_ROOT}/d_people:generic:headshot:silo:current.png/w_320,f_webp,q_auto:good/v1/people/${id}/headshot/silo/current`;
}

function ageAt(birthDate, date) {
  if (!birthDate) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [bornYear, bornMonth, bornDay] = birthDate.split("-").map(Number);
  return year - bornYear - Number(month < bornMonth || (month === bornMonth && day < bornDay));
}

function normalizePerson(person, position, jersey, known = {}, date = taipeiDate()) {
  const code = position?.abbreviation ?? known.position ?? "—";
  const [positionGroup, positionZh] = positions[code] ?? ["other", position?.name ?? "—"];
  const height = person.height ?? known.height ?? null;
  const dimensions = /^(\d+)'\s*(\d+)"$/.exec(height ?? "");
  const weightLb = person.weight ?? known.weightLb ?? null;
  const birthDate = person.birthDate ?? known.birthDate ?? null;
  const name = person.fullName ?? known.name;
  return {
    id: person.id,
    name,
    searchAliases: known.searchAliases ?? [],
    firstName: person.firstName ?? known.firstName ?? null,
    lastName: person.lastName ?? known.lastName ?? null,
    jersey: jersey || null,
    position: code,
    positionName: position?.name ?? known.positionName ?? "—",
    positionZh,
    positionGroup,
    status: known.status ?? null,
    birthDate,
    age: ageAt(birthDate, date),
    birthCity: person.birthCity ?? known.birthCity ?? null,
    birthRegion: person.birthStateProvince ?? known.birthRegion ?? null,
    birthCountry: person.birthCountry ?? known.birthCountry ?? null,
    height,
    heightCm: dimensions ? Math.round((Number(dimensions[1]) * 12 + Number(dimensions[2])) * 2.54) : null,
    weightLb,
    weightKg: weightLb ? Math.round(weightLb * 0.45359237) : null,
    bats: person.batSide?.code ?? known.bats ?? null,
    throws: person.pitchHand?.code ?? known.throws ?? null,
    debutDate: person.mlbDebutDate ?? known.debutDate ?? null,
    draftYear: person.draftYear ?? known.draftYear ?? null,
    profileUrl: person.nameSlug ? `${MLB_ORIGIN}/player/${encodeURIComponent(person.nameSlug)}`
      : known.profileUrl ?? `${MLB_ORIGIN}/player/${person.id}`,
    headshotUrl: photoUrl(person.id),
  };
}

function handedness(player) {
  const bat = { L: "左打", R: "右打", S: "左右開弓" }[player.bats];
  const arm = { L: "左投", R: "右投", S: "左右投" }[player.throws];
  return [bat, arm].filter(Boolean).join("／") || "—";
}

function isExempt(status) {
  return ["D60", "IL60", "IL-60", "SUSP", "RST"].includes(status.code.toUpperCase())
    || /60[- ]day|restricted list/i.test(status.description ?? "");
}

async function inBatches(entries, size, operation) {
  const all = [];
  for (let index = 0; index < entries.length; index += size) {
    const results = await Promise.all(entries.slice(index, index + size).map(operation));
    all.push(...results);
  }
  return all;
}

function rosterRows(payload, teamId) {
  if (payload.teamId !== teamId || payload.rosterType !== "40Man" || !Array.isArray(payload.roster)) {
    throw new Error(`MLB did not return a 40-man roster for team ${teamId}`);
  }
  const included = [];
  const exceptions = {};
  const players = new Set();
  for (const row of payload.roster) {
    if (!Number.isSafeInteger(row.person?.id) || !row.person.fullName || !row.position?.abbreviation
      || !row.status?.code || row.parentTeamId !== teamId || players.has(row.person.id)) {
      throw new Error(`Invalid MLB roster row for team ${teamId}`);
    }
    players.add(row.person.id);
    if (isExempt(row.status)) exceptions[row.status.code] = (exceptions[row.status.code] ?? 0) + 1;
    else included.push(row);
  }
  if (!included.length || included.length > 40) throw new Error(`Invalid MLB roster size for team ${teamId}`);
  return { included, exceptions };
}

async function fetchLiveRoster(previous) {
  const checkedAt = new Date();
  const rosterDate = taipeiDate(checkedAt);
  const known = new Map(previous.teams.flatMap(team => team.players.map(player => [player.id, player])));
  const liveTeams = await inBatches(previous.teams, 10, async team => {
    const sourceUrl = apiUrl(`/teams/${team.id}/roster`, { rosterType: "40Man", fields: ROSTER_FIELDS });
    const roster = rosterRows(await requestJson(sourceUrl), team.id);
    return { team, sourceUrl, ...roster };
  });
  const players = liveTeams.flatMap(team => team.included);
  if (new Set(players.map(row => row.person.id)).size !== players.length) {
    throw new Error("MLB team endpoints disagree about a recent roster move");
  }

  const missing = players.filter(row => !known.get(row.person.id)?.birthDate).map(row => row.person.id);
  const bios = new Map();
  for (let index = 0; index < missing.length; index += 50) {
    const batch = missing.slice(index, index + 50);
    try {
      const profiles = await requestJson(apiUrl("/people", { personIds: batch.join(",") }));
      for (const person of profiles.people ?? []) bios.set(person.id, person);
    } catch (error) {
      console.warn("Some player bios will be refreshed on the next roster check", error);
    }
  }

  return {
    ...previous,
    season: Number(rosterDate.slice(0, 4)),
    rosterDate,
    capturedAt: checkedAt.toISOString(),
    playerCount: players.length,
    teamPagesVerified: false,
    teams: liveTeams.map(({ team, sourceUrl, included, exceptions }) => ({
      ...team,
      sourceUrl,
      exemptStatusCounts: exceptions,
      players: included.map(row => ({
        ...normalizePerson(bios.get(row.person.id) ?? row.person, row.position, row.jerseyNumber, known.get(row.person.id), rosterDate),
        status: row.status,
      })),
    })),
  };
}

async function fetchPerson(id) {
  const payload = await requestJson(apiUrl(`/people/${id}`, { hydrate: "currentTeam" }));
  const person = payload.people?.find(profile => profile.id === id);
  if (!person) throw new Error(`MLB player ${id} was not found`);
  return person;
}

function mlbCalendarDate(now = new Date()) {
  const { year, month, day } = formattedParts(mlbDateFormatter, now);
  return `${year}-${month}-${day}`;
}

async function fetchMinorRoster(teamId, date = mlbCalendarDate()) {
  const url = apiUrl(`/teams/${teamId}/roster`, { rosterType: "fullRoster", date, fields: MINOR_ROSTER_FIELDS });
  const payload = await requestJson(url, { cache: "no-cache" });
  if (payload.teamId !== teamId || payload.rosterType !== "fullRoster" || !Array.isArray(payload.roster)) {
    throw new Error(`MLB did not return the MiLB roster for team ${teamId}`);
  }
  const players = new Map();
  for (const row of payload.roster) {
    const person = row.person;
    if (!Number.isSafeInteger(person?.id) || person.id <= 0 || !person.fullName) {
      throw new Error(`Invalid player on MiLB team ${teamId}`);
    }
    if (!players.has(person.id)) {
      players.set(person.id, {
        id: person.id, name: person.fullName, position: row.position?.abbreviation ?? null,
        status: row.status?.description ?? null,
      });
    }
  }
  return [...players.values()];
}

function transactionDateRange(days, now = new Date()) {
  const endDate = mlbCalendarDate(now);
  const end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

async function fetchTransactions(teamId, days, now = new Date()) {
  const { startDate, endDate } = transactionDateRange(days, now);
  const params = { sportId: 1, startDate, endDate, fields: TRANSACTION_FIELDS };
  if (teamId != null) params.teamId = teamId;
  const payload = await requestJson(apiUrl("/transactions", params), {
    cache: "no-cache",
    signal: AbortSignal.timeout(teamId == null ? 30_000 : 16_000),
  });
  if (!Array.isArray(payload.transactions)) throw new Error("MLB did not return transactions");
  return payload.transactions.filter(row => Number.isSafeInteger(row?.id)
    && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.date >= startDate && row.date <= endDate);
}

async function fetchSeasonStats(id, scope, stats = "yearByYear") {
  const gameType = scope === "postseason" ? "P" : "R";
  const sportIds = scope === "minors" ? MINOR_LEVELS : [1];
  const group = stats === "yearByYearAdvanced" ? "hitting,pitching" : "hitting,pitching,fielding";
  const results = await Promise.all(sportIds.map(async sportId => {
    const payload = await requestJson(apiUrl(`/people/${id}/stats`, {
      stats, group, sportId, gameType,
    }));
    if (!Array.isArray(payload.stats)) throw new Error("MLB did not return season statistics");
    return payload.stats.flatMap(group => (group.splits ?? [])
      .filter(split => split.sport?.id === sportId && split.gameType === gameType && /^\d{4}$/.test(split.season) && split.stat)
      .map(split => ({ ...split, group: group.group.displayName })));
  }));
  return results.flat();
}

const PLAYER_SPLIT_CODES = ["vl", "vr", "h", "a", ...Array.from({ length: 12 }, (_, index) => String(index + 1))];

async function fetchPlayerSplits(id, season, group, scope) {
  const gameType = scope === "postseason" ? "P" : "R";
  const payload = await requestJson(apiUrl(`/people/${id}/stats`, {
    stats: "statSplits", group, season, sportIds: 1, gameType, sitCodes: PLAYER_SPLIT_CODES.join(","),
  }));
  if (!Array.isArray(payload.stats)) throw new Error("MLB did not return player splits");
  return payload.stats
    .filter(section => section.group?.displayName === group && section.type?.displayName === "statSplits")
    .flatMap(section => section.splits ?? [])
    .filter(row => row.season === season && row.gameType === gameType && row.sport?.id === 1
      && row.stat && PLAYER_SPLIT_CODES.includes(row.split?.code));
}

async function fetchPitchArsenal(id, season, scope) {
  const payload = await requestJson(apiUrl(`/people/${id}/stats`, {
    stats: "pitchArsenal", group: "pitching", season, sportId: 1, gameType: scope === "postseason" ? "P" : "R",
  }));
  if (!Array.isArray(payload.stats)) throw new Error("MLB did not return pitch arsenal");
  return payload.stats.filter(section => section.type?.displayName === "pitchArsenal")
    .flatMap(section => section.splits ?? []).map(row => row.stat);
}

const CSV_PLAYER_FIELDS = [
  "id", "name", "jersey", "position", "positionName", "positionZh", "bats", "throws",
  "age", "birthDate", "birthCity", "birthRegion", "birthCountry", "height", "heightCm",
  "weightLb", "weightKg", "debutDate", "draftYear", "profileUrl", "headshotUrl",
];

function rosterCsv(snapshot) {
  const columns = [
    "rosterDate", "league", "division", "teamId", "team", "teamZh", "teamAbbr",
    "statusCode", "statusDescription", ...CSV_PLAYER_FIELDS,
  ];
  const values = snapshot.teams.flatMap(team => team.players.map(player => [
    snapshot.rosterDate, team.league, team.division, team.id, team.name, team.nameZh,
    team.abbr, player.status?.code, player.status?.description, ...CSV_PLAYER_FIELDS.map(key => player[key]),
  ]));
  const cell = value => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return "\uFEFF" + [columns, ...values].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

function installPhotoFallback() {
  document.addEventListener("error", event => {
    const photo = event.target;
    if (!(photo instanceof HTMLImageElement) || !photo.classList.contains("player-photo")) return;
    if (photo.dataset.fallback) {
      photo.hidden = true;
    } else {
      photo.dataset.fallback = "true";
      photo.src = "assets/player-silhouette.webp";
    }
  }, true);
}

export { countryName, escape, fetchLiveRoster, fetchMinorRoster, fetchPerson, fetchPitchArsenal, fetchPlayerSplits, fetchSeasonStats, fetchSnapshot, fetchTransactions, fetchTransactions as fetchTeamTransactions, handedness, installPhotoFallback, mlbCalendarDate, normalizePerson, readLastRoster, rememberRoster, rosterCsv, taipeiTime, teamLogo, transactionDateRange };
