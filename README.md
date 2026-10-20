# notion2md-userscript

將目前開啟的 Notion 頁面正文匯出為 Markdown，並與圖片一起打包成 ZIP。轉換完全在瀏覽器本機進行，不呼叫 AI、第三方轉檔服務或 Notion 內部 API。

## 安裝

1. 安裝任一支援 `GM_xmlhttpRequest` 的 Userscript 管理器，例如 [Tampermonkey](https://www.tampermonkey.net/)、[Violentmonkey](https://violentmonkey.github.io/)。
2. 開啟 [`notion2md.user.js`](https://github.com/Hon-Lu/notion2md-userscript/releases/latest/download/notion2md.user.js)，依管理器提示安裝。之後管理器會依 `@updateURL` 自動檢查更新。
3. 重新整理 Notion 頁面。

## 使用

- 頁面右側會出現一顆圓形下載按鈕，**點擊**即開始匯出。
- **按住拖曳**可移動按鈕，位置會自動記住。
- 若偵測到可能無法完整轉換的內容，會先詢問是否繼續。

## 輸出格式

```text
頁面標題.zip
├── 頁面標題.md
├── export-report.json
└── images/
    ├── 001.png
    └── 002.svg
```

`.md` 以相對路徑引用圖片（例如 `![](images/001.png)`），解壓縮後請保留 `images/` 的相對位置。`export-report.json` 記錄匯出統計與已知限制，不含正文或 URL。

## 已知限制

- 只匯出目前頁面正文；不含頁首屬性，不展開子頁面或內嵌資料庫的資料列。
- 多欄版面依 DOM 順序轉為單欄；外部嵌入（如 Figma）只保留連結。
- Mermaid 能讀到原始碼時輸出 `mermaid` 區塊，否則嘗試打包 SVG 預覽。
- 任一圖片下載失敗即中止匯出，不會產生缺圖的 ZIP。
- 圖片上限 150 個、單檔 32 MiB、總計 240 MiB。
- 依賴 Notion 網頁的 DOM 結構，Notion 改版時可能需要更新辨識規則。

## 權限說明

- `GM_xmlhttpRequest` 與 `@connect *`：僅用於以 GET 下載頁面中已出現的圖片。
- `GM_getValue`／`GM_setValue`：僅儲存按鈕位置。
