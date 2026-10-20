# notion2md-userscript

**English** | [繁體中文](README.zh-TW.md)

Export the current Notion page to Markdown and pack it with its images into a ZIP. Everything runs locally in your browser: no AI, no third-party conversion service, no Notion internal API.

## Installation

1. Install a userscript manager that supports `GM_xmlhttpRequest`, such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`notion2md.user.js`](https://github.com/Hon-Lu/notion2md-userscript/releases/latest/download/notion2md.user.js) and install it when your manager prompts you. The manager checks for updates automatically through `@updateURL`.
3. Reload your Notion page.

## Usage

- A round download button appears on the right side of the page. **Click** it to export.
- **Drag** the button to move it. Its position is remembered.
- If some content may not convert completely, you are asked before the export continues.

## Settings

Right-click the button, or choose **Settings** from your userscript manager's menu.

- **Language**: by default the interface follows your browser. Chinese browsers (Traditional or Simplified) get Traditional Chinese; every other language gets English. You can also pick English or 繁體中文 directly.
- The language also applies to the notes and fallback text written into the exported Markdown.

## Output

```text
Page title.zip
├── Page title.md
├── export-report.json
└── images/
    ├── 001.png
    └── 002.svg
```

The `.md` file links images by relative path (for example `![](images/001.png)`), so keep the `images/` folder next to it after unzipping. `export-report.json` records export statistics and known limitations; it contains no page text or URLs.

## Known limitations

- Only the body of the current page is exported. Page properties, sub-pages and the rows of linked databases are not included.
- Multi-column layouts are flattened into one column in DOM order. External embeds (such as Figma) keep only their links.
- Mermaid diagrams are exported as `mermaid` code blocks when the source is readable; otherwise their SVG preview is packed instead.
- If any image fails to download, the export stops. No ZIP with missing images is created.
- Up to 150 images, 32 MiB per file and 240 MiB in total.
- The script depends on Notion's web DOM. A Notion redesign may require updated detection rules.

## Permissions

- `GM_xmlhttpRequest` and `@connect *`: only used to download, with GET requests, images already shown on the page.
- `GM_getValue` / `GM_setValue`: only store the button position and the language setting.
- `GM_registerMenuCommand` / `GM_unregisterMenuCommand`: add the **Settings** entry to your userscript manager's menu.
