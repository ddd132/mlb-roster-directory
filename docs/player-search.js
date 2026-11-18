const collator = new Intl.Collator("en", { sensitivity: "base" });

function normalizeName(value) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function buildPlayerIndex(directory, roster) {
  const players = new Map(directory.map(player => [player.id ?? player.history.player, player]));
  for (const team of roster?.teams ?? []) {
    for (const row of team.players) {
      const known = players.get(row.id);
      const aliases = new Set([...row.searchAliases, known?.name, ...(known?.aliases ?? [])]);
      aliases.delete(undefined);
      aliases.delete(row.name);
      players.set(row.id, {
        ...known, id: row.id, name: row.name, aliases: [...aliases],
        roster: { team: team.abbr, club: team.nameZh, season: roster.season, position: row.position, debut: row.debutDate },
      });
    }
  }
  return [...players.values()].map(player => ({
    player,
    names: [player.name, ...(player.aliases ?? [])].map(normalizeName),
  }));
}

function matchRank(names, query, compact, words) {
  let rank = Infinity;
  for (const name of names) {
    if (name === query || name.replaceAll(" ", "") === compact) return 0;
    if (name.startsWith(query)) rank = Math.min(rank, 1);
    else if (words.every(word => name.includes(word))) rank = Math.min(rank, 2);
  }
  return rank;
}

export function searchPlayers(index, value) {
  const query = normalizeName(value);
  if (!query) return [];
  const compact = query.replaceAll(" ", "");
  const words = query.split(" ");
  const results = [];
  for (const { player, names } of index) {
    const rank = matchRank(names, query, compact, words);
    if (Number.isFinite(rank)) results.push({ player, rank });
  }
  return results.sort((a, b) => a.rank - b.rank
    || Number(Boolean(b.player.roster)) - Number(Boolean(a.player.roster))
    || collator.compare(a.player.name, b.player.name))
    .map(({ player }) => player);
}

export function playerSearchUrl(player) {
  if (!player.id || (player.history && player.career.last < 1876)) {
    return "history.html?" + new URLSearchParams(player.history);
  }
  const params = new URLSearchParams({ id: player.id });
  if (player.roster) {
    params.set("team", player.roster.team);
    if (!player.roster.debut && !player.career) params.set("scope", "minors");
  } else if (player.minor) {
    params.set("scope", "minors");
    params.set("from", "minors");
    if (player.minor.team) params.set("team", player.minor.team);
  } else if (!player.career.regular) {
    params.set("scope", "postseason");
  }
  return "player.html?" + params;
}
