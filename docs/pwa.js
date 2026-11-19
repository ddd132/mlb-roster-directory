(() => {
  const root = new URL("./", document.currentScript.src);
  const appUrl = path => new URL(path, root).href;
  const workerUrl = appUrl("service-worker.js");
  const standalone = matchMedia("(display-mode: standalone)");
  const installed = () => standalone.matches || navigator.standalone === true;
  const main = document.querySelector("main");
  const trigger = document.querySelector("[data-pwa-install]");
  let nativePrompt;
  let usingSavedData = false;
  let notice;

  function addNavigation() {
    const nav = document.createElement("nav");
    nav.className = "pwa-nav";
    nav.setAttribute("aria-label", "圖鑑快捷導覽");
    const path = location.pathname.slice(root.pathname.length);
    const view = new URLSearchParams(location.search).get("view");
    const scatter = path === "leaders.html" && view === "scatter";
    const current = flag => flag ? ' aria-current="page"' : "";
    nav.innerHTML = `<div class="shell pwa-nav-inner">
      <a href="${appUrl("./#roster")}"${current(!path || path === "index.html")}>球隊</a>
      <a href="${appUrl("search.html")}"${current(path === "search.html")}>球員搜尋</a>
      <a href="${appUrl("leaders.html")}"${current(path === "leaders.html" && !scatter)}>排行榜</a>
      <details class="pwa-charts">
        <summary>圖表</summary>
        <div class="pwa-chart-menu">
          <a href="${appUrl("league-trends.html")}"${current(path === "league-trends.html")}>聯盟平均與趨勢</a>
          <a href="${appUrl("leaders.html?view=scatter#leader-heading")}"${current(scatter)}>雙指標散點圖</a>
        </div>
      </details>
    </div>`;
    main.before(nav);
    const charts = nav.querySelector("details");
    document.addEventListener("click", event => {
      if (charts.open && !charts.contains(event.target)) charts.open = false;
    });
    charts.addEventListener("keydown", event => {
      if (event.key === "Escape" && charts.open) {
        charts.open = false;
        charts.querySelector("summary").focus();
      }
    });
  }

  function addNotice() {
    notice = document.createElement("div");
    notice.className = "pwa-connection";
    notice.hidden = true;
    notice.innerHTML = `<div class="shell pwa-connection-inner"><span role="status"></span>
      <button type="button" hidden>重新整理</button></div>`;
    notice.querySelector("button").addEventListener("click", () => location.reload());
    main.before(notice);
  }

  function showConnection() {
    if (!notice) return;
    const offline = navigator.onLine === false;
    notice.hidden = !offline && !usingSavedData;
    notice.querySelector("span").textContent = offline
      ? "離線瀏覽 · 可查看這台裝置已儲存的資料"
      : usingSavedData ? "部分內容使用已儲存的資料" : "";
    notice.querySelector("button").hidden = offline || !usingSavedData;
  }

  function updateInstallControl() {
    if (trigger) trigger.hidden = installed();
  }

  function installationGuide() {
    const dialog = document.createElement("dialog");
    dialog.className = "pwa-install-dialog";
    dialog.setAttribute("aria-labelledby", "pwa-install-title");
    dialog.innerHTML = `<div class="pwa-install-header">
      <img src="${appUrl("pwa-icon-192.png")}" width="52" height="52" alt="">
      <h2 id="pwa-install-title">安裝球員圖鑑</h2>
    </div>
    <h3>iPhone／iPad</h3>
    <ol>
      <li>用 Safari 開啟球員圖鑑，點「分享」。</li>
      <li>選「加入主畫面」，開啟「打開為網頁 App」。</li>
      <li>點「加入」，再從主畫面開啟球員圖鑑。</li>
    </ol>
    <h3>Android</h3>
    <p>在 Chrome 選單選「加到主畫面」，再選「安裝」。</p>
    <form method="dialog"><button type="submit" class="source-link" autofocus>完成</button></form>`;
    document.body.append(dialog);
    dialog.showModal();
    dialog.addEventListener("close", () => {
      dialog.remove();
      trigger?.focus();
    }, { once: true });
  }

  async function install() {
    if (nativePrompt) {
      const prompt = nativePrompt;
      nativePrompt = null;
      try {
        await prompt.prompt();
        return;
      } catch {
        // The browser menu is still available if its prompt expires.
      }
    }
    installationGuide();
  }

  if (main) {
    addNavigation();
    addNotice();
    showConnection();
    window.addEventListener("offline", showConnection);
    window.addEventListener("online", showConnection);
  }
  if (trigger) {
    trigger.addEventListener("click", () => void install());
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      nativePrompt = event;
    });
    window.addEventListener("appinstalled", () => { trigger.hidden = true; });
    standalone.addEventListener("change", updateInstallControl);
    updateInstallControl();
  }
  if ("serviceWorker" in navigator && isSecureContext) {
    navigator.serviceWorker.addEventListener("message", event => {
      if (event.source?.scriptURL !== workerUrl || event.data?.type !== "mlb-pwa-saved-data") return;
      usingSavedData = true;
      showConnection();
    });
    navigator.serviceWorker.register(workerUrl, { scope: root.href, updateViaCache: "none" }).catch(error => {
      console.warn("Could not enable offline browsing", error);
    });
  }
})();
