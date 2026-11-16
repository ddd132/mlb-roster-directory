import { mlbCalendarDate } from "./mlb.js";

const API = "https://statsapi.mlb.com/api/v1";
export const FIRST_SEASON = 1871;
export const LAST_ARCHIVE = 2025;
export const MLB_LEAGUES = { 103: "AL", 104: "NL" };

const LEAGUES = {
  AL: "美國聯盟", NL: "國家聯盟", NA: "國家協會（1871–1875）",
  AA: "美國協會", UA: "聯合協會", PL: "球員聯盟", FL: "聯邦聯盟",
  NNL: "黑人國家聯盟（第一期）", NN2: "黑人國家聯盟（第二期）",
  ECL: "東部有色聯盟", ANL: "美國黑人聯盟（1929）", EWL: "東西聯盟",
  NSL: "黑人南方聯盟", NAL: "黑人美國聯盟",
};

export const leagueName = code => LEAGUES[code] ?? code;

export async function request(path, params) {
  const response = await fetch(API + path + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("MLB Stats API HTTP " + response.status);
  return response.json();
}

export async function availableSeasons() {
  const date = mlbCalendarDate();
  let latest = Math.max(LAST_ARCHIVE, Number(date.slice(0, 4)));
  try {
    const { seasons } = await request("/seasons/all", { sportId: 1, fields: "seasons,seasonId,regularSeasonStartDate" });
    latest = Math.max(LAST_ARCHIVE, ...seasons.filter(season => season.regularSeasonStartDate && season.regularSeasonStartDate <= date)
      .map(season => Number(season.seasonId)).filter(Number.isInteger));
  } catch (error) {
    console.warn("Using calendar year for the season selector", error);
  }
  return Array.from({ length: latest - FIRST_SEASON + 1 }, (_, index) => latest - index);
}

export async function loadArchive(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(24_000) });
  if (!response.ok) throw new Error("Could not load " + url);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
