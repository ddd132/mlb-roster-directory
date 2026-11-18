export function finderMode(params) {
  if (params.has("player")) return "team";
  const mode = params.get("mode");
  if (mode === "team" || mode === "name") return mode;
  return params.has("q") && !params.has("season") && !params.has("team") ? "name" : "team";
}

function browseParams() {
  const params = new URLSearchParams(location.search);
  params.delete("player");
  params.delete("finder");
  return params;
}

export function syncFinderNavigation() {
  const params = browseParams();
  for (const link of document.querySelectorAll("[data-finder-mode]")) {
    params.set("mode", link.dataset.finderMode);
    link.href = "search.html?" + params;
  }
}

export function withFinderReturn(href) {
  const destination = new URL(href, location.href);
  const origin = browseParams();
  origin.set("mode", finderMode(new URLSearchParams(location.search)));
  destination.searchParams.set("finder", origin.toString());
  return destination.href;
}

export function finderReturnUrl(params) {
  const saved = params.get("finder");
  return saved ? "search.html?" + new URLSearchParams(saved) : "";
}
