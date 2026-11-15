# 球員圖鑑

繁體中文 MLB 40 人名單瀏覽器。以 MLB 球員 ID 為索引，可依球隊、聯盟或分區瀏覽，並以英文姓名、部分常用中文譯名、球隊及出生地搜尋。首屏預設洛杉磯道奇，可透過 `?team=DET` 等網址參數直接開啟球隊。

## GitHub Pages

本專案可從 `main` 分支的 `/docs` 資料夾部署。

## 網站使用的 MLB 資料

- 在名單頁開啟時向 MLB 查詢 30 隊，前景每 2 分鐘刷新。網路或來源暫時中斷時，頁面會顯示最近一次可用名單及時間。
- 個人成績依 MLB 球員 ID 即時查詢 `yearByYear`。例行賽、季後賽及小聯盟分開顯示，同季轉隊採 MLB 提供的合計並可切換各隊分項。
- 下方指令用於重建網站隨附的備用名單。

## 更新進階成績

年度的進階成績讀取 Baseball Savant 公開例行賽排行榜 CSV，以 MLB 球員 ID、球季和打擊／投球配對。用以下指令以相同欄位重新取得資料，將年份換成排行榜已提供的最新球季即可。

```bash
python scripts/update-savant.py --through 2026
```

Baseball Savant 歷史資料自 2015 年起。較早或缺少紀錄的球季由 MLB Stats API 補充可用的進階欄位。

## 更新資料

使用 Python 3.9 以上版本，在專案目錄執行以下命令。預設以台灣當日為取樣日期。若需要重新取得當日資料並核對各隊的 MLB 官網頁面，可加上 `--verify-current-pages`。歷史日期參數為 `--date YYYY-MM-DD`。

```bash
python scripts/update-rosters.py --verify-current-pages
```

- `docs/data/rosters.json` 包含取樣時間、球隊分區、名單來源、球員 ID、守備位置與球員基本資料。
- `docs/data/mlb-40-man.csv` 每位球員一列，以帶有 BOM 的 UTF-8 儲存。
- 各隊的 40 人名單取自 MLB Stats API `rosterType=40Man`。採計 MLB 40 人名額，排除 60 天傷兵等不占名額的項目。
- 球員照片採用 MLB 提供的連結。球場照片為 Wikimedia Commons 的 [Dodger Stadium Field](https://commons.wikimedia.org/wiki/File:Dodger_Stadium_Field.jpg)，Jesuiseduardo 攝影，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 授權。網站中使用縮放後的照片。
- 以靜態伺服器提供 `docs/` 即可運行。
