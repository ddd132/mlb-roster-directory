import { escape } from "./mlb.js";
import { contractDetail, contractLabels, contractLine, contractState, payrollLink, statusTag } from "./team-details.js";

const labels = { ...contractLabels, "arb-signed": "薪資仲裁（含已簽）" };
const groups = ["all", "signed", "arb-signed", "prearb", "option", "free-agent", "projected-fa", "unknown"];
const collator = new Intl.Collator("en", { sensitivity: "base" });

export function createContractsView(panel, selectedYear, onYearChange) {
  const select = panel.querySelector("[data-contract-year]");
  const filter = panel.querySelector("[data-contract-filter]");
  const status = panel.querySelector("[data-contract-summary]");
  const results = panel.querySelector("[data-contract-results]");
  const source = panel.querySelector("[data-payroll-source]");
  let active;
  filter.replaceChildren(...groups.map(key => new Option(labels[key] ?? "全部狀態", key)));
  filter.addEventListener("change", render);
  select.addEventListener("change", () => onYearChange(Number(select.value)));

  function render() {
    if (!active || panel.hidden) return;
    const { team, season, data, loading } = active;
    const referenceSeason = data?.season ?? season;
    const year = selectedYear() === referenceSeason ? referenceSeason : referenceSeason + 1;
    select.replaceChildren(new Option(`${referenceSeason + 1} 球季`, referenceSeason + 1), new Option(`${referenceSeason} 球季`, referenceSeason));
    select.value = String(year);
    const currentIds = new Set(team.players.map(p => p.id));
    const rows = team.players.map(p => ({ player: p, contract: contractState(data, p.id, team.id, year) }));
    if (year === referenceSeason + 1) {
      for (const player of data?.free.values() ?? []) {
        if (player.team === team.id && !currentIds.has(player.id)) rows.push({ player, contract: contractState(data, player.id, team.id, year), former: true });
      }
    }
    rows.sort((a, b) => collator.compare(a.player.name, b.player.name));

    const matches = ({ contract }) => filter.value === "all" || filter.value === contract.key
      || filter.value === "arb-signed" && contract.key === "arb";
    const filtered = rows.filter(matches);
    const covered = rows.filter(({ contract }) => contract.key !== "unknown").length;
    const updated = data?.asOf ? ` · 資料日期 ${data.asOf}` : "";
    status.textContent = loading ? "正在讀取合約資料…"
      : `${year} 球季 · ${filtered.length} 位 · ${covered}/${rows.length} 位有公開狀態${updated}`;
    source.href = payrollLink(data, team.id, referenceSeason);
    results.innerHTML = filtered.length ? `<div class="team-detail-table-wrap" role="region" aria-label="球員合約明細" tabindex="0">
      <table class="team-detail-table"><thead><tr><th scope="col">球員</th><th scope="col">合約狀態</th><th scope="col">已知條款與年資</th></tr></thead><tbody>${filtered.map(({ player, contract, former }) => {
        const query = new URLSearchParams({ id: player.id, team: team.abbr, from: "contracts", contractYear: year });
        const display = contractDetail(contract, year);
        return `<tr><th scope="row"><a href="player.html?${escape(query)}">${escape(player.name)}</a>
          <small>${escape(player.position ?? "—")}${former ? " · 上一支球隊" : ""}</small></th>
          <td>${statusTag(contract.key, contract.label)}${contract.source === "MLB" ? '<small>MLB 已公布</small>' : ""}</td>
          <td>${display.length ? escape(display.join(" · ")) : "—"}</td></tr>`;
      }).join("")}</tbody></table></div>` : '<p class="team-detail-empty">沒有符合這個合約狀態的球員。</p>';
  }

  return { open(team, season, data, loading) { active = { team, season, data, loading }; render(); } };
}

export function contractCard(data, id, team) {
  if (!data) return "";
  const year = data.season + 1;
  const contract = contractState(data, id, team.id, year);
  const line = contractLine(contract, year);
  return `<span class="card-contract">${statusTag(contract.key, `${year} ${contract.label}`, line)}
    ${line && contract.end > year ? `<span class="card-contract-term">至 ${contract.end} 年</span>` : ""}</span>`;
}
