import { finderMode, syncFinderNavigation } from "./finder-links.js";

const mode = finderMode(new URLSearchParams(location.search));
const panel = document.getElementById(mode + "-panel");
panel.hidden = false;
document.querySelector('[data-finder-mode="' + mode + '"]').setAttribute("aria-current", "page");
syncFinderNavigation();

const moduleRequest = mode === "team" ? import("./history.js?v=3") : import("./search.js?v=2");
moduleRequest.catch(error => {
  console.warn("Could not open the player finder", error);
  panel.hidden = true;
  document.getElementById("finder-error").hidden = false;
});
