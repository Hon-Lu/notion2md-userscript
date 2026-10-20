// ==UserScript==
// @name         notion2md
// @namespace    https://github.com/Hon-Lu/notion2md-userscript
// @version      0.0.0
// @author       Hon.Lu
// @license      MIT
// @description  將目前 Notion 頁面匯出為 Markdown（含圖片）
// @homepageURL  https://github.com/Hon-Lu/notion2md-userscript
// @supportURL   https://github.com/Hon-Lu/notion2md-userscript/issues
// @downloadURL  https://github.com/Hon-Lu/notion2md-userscript/releases/latest/download/notion2md.user.js
// @updateURL    https://github.com/Hon-Lu/notion2md-userscript/releases/latest/download/notion2md.user.js
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @match        https://*.notion.so/*
// @match        https://www.notion.com/*
// @match        https://notion.com/*
// @match        https://*.notion.site/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      self
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.0';

  // No @require, remote scripts, remote services, or Notion internal APIs.
  // @connect * is needed ONLY for GET requests to image URLs already present in the page.
  const LIMITS = Object.freeze({
    scrollSteps: 300,
    images: 150,
    imageBytes: 32 * 1024 * 1024,
    archiveBytes: 240 * 1024 * 1024,
    loadPauseMs: 95,
    imageTimeoutMs: 25000,
  });
  const textEncoder = new TextEncoder();
  const LIST_TYPES = new Set(['bulleted_list', 'numbered_list', 'to_do']);
  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);
  let running = false;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const isHttp = (url) => /^https?:\/\//i.test(url);

  function safeFilename(name) {
    const sanitized = String(name || 'Notion 頁面')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/[\s.]+$/g, '')
      .trim()
      .slice(0, 110);
    const result = sanitized || 'Notion 頁面';
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result) ? `_${result}` : result;
  }

  function pageTitle() {
    const raw = document.title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*[|–-]\s*Notion\s*$/i, '')
      .trim();
    return raw || document.querySelector('.notion-page-block h1, .notion-page-title')?.textContent?.trim() || 'Notion 頁面';
  }

  function isBlock(element) {
    return element?.nodeType === 1 && element.hasAttribute('data-block-id') &&
      [...element.classList].some(cls => /^notion-[\w-]+-block$/.test(cls));
  }

  function blockType(element) {
    for (const cls of element.classList) {
      const match = cls.match(/^notion-([\w-]+)-block$/);
      if (match) return match[1].replace(/-/g, '_');
    }
    return 'unknown';
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function findContentRoot() {
    const roots = [...document.querySelectorAll('.notion-page-content')]
      .filter(isVisible)
      .filter(root => !root.parentElement?.closest('.notion-page-content'));
    if (!roots.length) throw new Error('找不到目前 Notion 頁面的正文容器（.notion-page-content）。請確認頁面已載入。');
    if (roots.length > 1) {
      throw new Error('偵測到多個 Notion 正文容器。請先關閉側邊預覽、彈出視窗或多頁分割後重試，避免匯錯頁面。');
    }
    return roots[0];
  }

  function getScroller(root) {
    let node = root.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 30) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollPosition(scroller) {
    return scroller.scrollTop || 0;
  }

  function setScroll(scroller, position) {
    scroller.scrollTop = Math.max(0, position);
  }

  function removeNestedBlocks(clone) {
    [...clone.querySelectorAll('[data-block-id]')].filter(isBlock).forEach(node => node.remove());
    return clone;
  }

  function imageOptions(element) {
    const images = [...element.querySelectorAll('img')]
      .filter(img => !img.closest('[role="button"], button'))
      .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    const choices = [];
    const push = (value) => {
      if (!value || typeof value !== 'string') return;
      try {
        const href = new URL(value, location.href).href;
        if (/^(https?:|data:image\/|blob:)/i.test(href) && !choices.includes(href)) choices.push(href);
      } catch (_) { /* Ignore invalid URLs. */ }
    };
    for (const img of images) {
      const anchor = img.closest('a[href]');
      const href = anchor?.getAttribute('href') || '';
      if (/(?:\.(?:png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#]|$)|file\.notion\.so|amazonaws\.com|notionusercontent\.com)/i.test(href)) push(href);
      push(img.getAttribute('data-src'));
      push(img.getAttribute('src'));
      push(img.currentSrc);
      const srcset = img.getAttribute('srcset') || '';
      for (const item of srcset.split(/,\s*(?=https?:)/).reverse()) {
        push(item.trim().split(/\s+/)[0]);
      }
    }
    const captionNode = element.querySelector('[class*="image-caption"], figcaption');
    const alt = captionNode?.textContent?.trim() || images[0]?.alt?.trim() || '圖片';
    // Prefer HTTP asset URLs to tiny data-URI placeholders.
    choices.sort((a, b) => Number(isHttp(b)) - Number(isHttp(a)));
    return { candidates: choices, alt };
  }

  // Mermaid diagrams in Notion are code blocks. The editor may be hidden in Preview
  // mode, while only the rendered SVG is present in the DOM.
  const MERMAID_START = /^\s*(?:%%[^\n]*\n\s*|---[\s\S]*?---\s*)*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|xychart-beta|block-beta|architecture-beta|kanban|packet-beta|treemap-beta)\b/i;

  function looksLikeMermaid(source) {
    return MERMAID_START.test(String(source || '').trim());
  }

  function codeText(element) {
    const selectors = [
      'pre code', '.cm-content', '.CodeMirror-code', '[data-testid="code-block-content"]',
      '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
      '[role="textbox"]', 'pre', 'textarea',
    ];
    for (const selector of selectors) {
      const candidates = [...element.querySelectorAll(selector)];
      for (const candidate of candidates) {
        const lines = [...candidate.querySelectorAll('.cm-line')];
        let value = lines.length ? lines.map(line => line.textContent).join('\n') :
          candidate.tagName?.toLowerCase() === 'textarea' ? candidate.value : candidate.textContent;
        value = (value || '').replace(/\r\n?/g, '\n').trim();
        if (value) return value;
      }
    }
    const leaves = [...element.querySelectorAll('[data-content-editable-leaf]')];
    if (leaves.length) return leaves.map(leaf => leaf.textContent).join('\n').replace(/\r\n?/g, '\n').trim();
    // Do not use the code block's entire textContent: it often contains
    // controls such as Mermaid / Code / Preview / Copy instead of code.
    return '';
  }

  function codeLanguage(element, source) {
    const nodes = [element, ...element.querySelectorAll('[data-language], [data-code-language], [class*="language-"], [aria-label]')];
    const hints = nodes.flatMap(node => [
      node.getAttribute('data-language') || '',
      node.getAttribute('data-code-language') || '',
      node.getAttribute('class') || '',
      node.getAttribute('aria-label') || '',
    ]);
    const menuLabels = [...element.querySelectorAll('button, [role="button"]')]
      .map(node => (node.textContent || '').trim());
    if ([...hints, ...menuLabels].some(x => /(?:^|[^a-z])mermaid(?:[^a-z]|$)/i.test(x))) return 'mermaid';
    if (looksLikeMermaid(source)) return 'mermaid';
    const explicit = nodes.map(node => node.getAttribute('data-language') || node.getAttribute('data-code-language'))
      .find(Boolean);
    if (explicit) return explicit.toLowerCase();
    const classname = hints.find(x => /(?:^|\s)language-[a-z0-9+#.-]+(?:\s|$)/i.test(x));
    return classname?.match(/(?:^|\s)language-([a-z0-9+#.-]+)/i)?.[1] || '';
  }

  function diagramSvg(element, isMermaid) {
    const candidates = [...element.querySelectorAll('svg')];
    if (element.localName?.toLowerCase() === 'svg') candidates.unshift(element);
    for (const svg of candidates) {
      const hints = ['id', 'class', 'aria-roledescription', 'aria-label']
        .map(name => svg.getAttribute(name) || '').join(' ');
      const ancestorHints = svg.closest('[id^="mermaid-"], .mermaid, [class*="mermaid"]');
      const looksLikeDiagram = /mermaid|flowchart|sequenceDiagram|stateDiagram|erDiagram/i.test(hints) || Boolean(ancestorHints);
      const graphicCount = svg.querySelectorAll('g, path, rect, text, polygon, line').length;
      if (looksLikeDiagram || (isMermaid && graphicCount >= 3)) return svg.cloneNode(true);
    }
    return null;
  }

  // In Notion's Mermaid Preview layout, the diagram can be a *sibling* of the
  // .notion-code-block element, rather than a descendant of it. Stay inside a
  // wrapper with exactly one Notion block so a nearby diagram is never copied.
  function codePreviewScope(element) {
    let scope = element;
    for (let step = 0; step < 3; step++) {
      const parent = scope.parentElement;
      if (!parent || parent.classList?.contains('notion-page-content')) break;
      const unrelated = [...parent.querySelectorAll('[data-block-id]')].some(node =>
        isBlock(node) && !element.contains(node) && node !== element);
      if (unrelated) break;
      scope = parent;
    }
    return scope;
  }

  function getCodeInfo(element) {
    const scope = codePreviewScope(element);
    const source = codeText(element) || (scope !== element ? codeText(scope) : '');
    const language = codeLanguage(element, source) ||
      (scope !== element ? codeLanguage(scope, source) : '');
    const svg = diagramSvg(scope, language === 'mermaid' || looksLikeMermaid(source));
    return { source, language, isMermaid: language === 'mermaid' || Boolean(svg), svg };
  }

  function getOwnSnapshot(element) {
    const clone = removeNestedBlocks(element.cloneNode(true));
    // Chrome pages can recycle DOM nodes during virtualized scrolling; snapshot now.
    return clone;
  }

  function snapshotBlocks(root, collected) {
    const rootRect = root.getBoundingClientRect();
    for (const element of root.querySelectorAll('[data-block-id]')) {
      if (!isBlock(element) || !isVisible(element)) continue;
      const id = element.getAttribute('data-block-id');
      if (!id || collected.has(id)) continue;
      const parent = element.parentElement?.closest('[data-block-id]');
      const parentId = parent && root.contains(parent) && isBlock(parent) ? parent.getAttribute('data-block-id') : null;
      const type = blockType(element);
      const rect = element.getBoundingClientRect();
      const item = {
        id, parentId, type,
        order: collected.size,
        x: rect.left - rootRect.left,
        y: rect.top - rootRect.top,
        own: getOwnSnapshot(element),
        mediaNodes: {
          iframes: element.querySelectorAll('iframe').length,
          canvases: element.querySelectorAll('canvas').length,
        },
        collapsed: type === 'toggle' && Boolean(element.querySelector('[aria-expanded="false"]')),
        checked: type === 'to_do' && Boolean(element.querySelector('input:checked, [role="checkbox"][aria-checked="true"], [class*="checkbox-on"]')),
        tableHasHeader: ['table', 'simple_table'].includes(type) && Boolean(element.querySelector('th, [role="columnheader"], .notion-table-view-header-row')),
        // Capture cell text before removing child blocks from the snapshot.
        // Otherwise real Notion tables can lose all of their rows.
        tableData: ['table', 'simple_table'].includes(type) ? readTableMatrix(element) : null,
        image: type === 'image' ? imageOptions(element) : null,
        databaseUrl: ['child_database', 'collection_view', 'collection_view_page'].includes(type)
          ? databaseLink(element) : '',
        code: type === 'code' ? getCodeInfo(element) : null,
        diagram: type === 'embed' ? diagramSvg(element, false) : null,
      };
      collected.set(id, item);
    }
    snapshotDetachedMermaid(root, collected);
  }

  function snapshotDetachedMermaid(root, collected) {
    // Some releases render the diagram outside its code block. If the normal
    // code-block detector did not capture it, preserve the visual as a separate
    // SVG block instead of silently discarding it.
    const rendered = root.querySelectorAll('svg[id^="mermaid-"], [id^="mermaid-"] svg, .mermaid svg, [class*="mermaid"] svg');
    for (const svg of rendered) {
      if (!isVisible(svg)) continue;
      const diagramId = svg.getAttribute('id') || svg.closest('[id^="mermaid-"]')?.getAttribute('id');
      if (!diagramId) continue;
      const alreadySaved = [...collected.values()].some(item =>
        item.code?.svg?.getAttribute('id') === diagramId || item.diagram?.getAttribute('id') === diagramId);
      if (alreadySaved) continue;
      const owner = svg.closest('[data-block-id]');
      const ownerId = owner && isBlock(owner) ? owner.getAttribute('data-block-id') : null;
      const ownerEntry = ownerId ? collected.get(ownerId) : null;
      if (ownerEntry?.type === 'code') {
        ownerEntry.code = { ...ownerEntry.code, isMermaid: true, svg: svg.cloneNode(true) };
        continue;
      }
      if (ownerEntry?.type === 'embed') {
        ownerEntry.diagram = svg.cloneNode(true);
        continue;
      }
      const id = `n2z-mermaid-${diagramId}`;
      if (collected.has(id)) continue;
      let order = collected.size;
      if (typeof svg.compareDocumentPosition === 'function' &&
          typeof Node.DOCUMENT_POSITION_FOLLOWING === 'number') {
        // Place a standalone preview immediately after the nearest preceding
        // saved Notion block, rather than always moving it to the document end.
        for (const element of root.querySelectorAll('[data-block-id]')) {
          const saved = collected.get(element.getAttribute('data-block-id'));
          if (saved && isBlock(element) &&
              (element.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING)) {
            order = saved.order + 0.5;
          }
        }
      }
      collected.set(id, {
        id, parentId: ownerEntry ? ownerId : null,
        type: 'mermaid_preview', order,
        own: svg.cloneNode(true), diagram: svg.cloneNode(true),
      });
    }
  }

  async function scanCurrentPage(status) {
    const root = findContentRoot();
    const scroller = getScroller(root);
    const savedScroll = scrollPosition(scroller);
    const collected = new Map();
    let hitLimit = true;
    let lastTop = -1;
    try {
      setScroll(scroller, 0);
      await sleep(150);
      for (let step = 0; step < LIMITS.scrollSteps; step++) {
        snapshotBlocks(root, collected);
        if (step % 5 === 0) status(`掃描正文：${collected.size} 個區塊…`);
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const top = scrollPosition(scroller);
        if (top >= maxTop - 3) {
          await sleep(260);
          snapshotBlocks(root, collected);
          const refreshedMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (top >= refreshedMax - 3) {
            hitLimit = false;
            break;
          }
        }
        const nextTop = Math.min(maxTop, top + Math.max(260, Math.floor(scroller.clientHeight * 0.70)));
        if (nextTop <= top + 1 || Math.abs(top - lastTop) < 1) {
          if (top < maxTop - 3) throw new Error('Notion 捲動容器沒有按預期移動，無法確認正文是否已完整載入。');
          hitLimit = false;
          break;
        }
        lastTop = top;
        setScroll(scroller, nextTop);
        await sleep(LIMITS.loadPauseMs);
      }
    } finally {
      setScroll(scroller, savedScroll);
    }
    if (!collected.size) throw new Error('正文容器內沒有辨識到可匯出的 Notion 區塊。為避免匯出空檔案，已停止。');
    if (hitLimit) throw new Error(`頁面掃描超過 ${LIMITS.scrollSteps} 次捲動上限，無法確定內容完整，已停止匯出。`);
    return [...collected.values()].sort((a, b) => a.order - b.order);
  }

  function escapeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/([*_`|])/g, '\\$1')
      // Literal bracketed prose is not necessarily a Markdown link.
      // Escape bracket pairs only when followed by link/reference syntax.
      .replace(/\[[^\]\n]*\](?=\s*[([])/g, pair => pair.replace(/[\[\]]/g, '\\$&'))
      // Avoid accidentally turning ordinary source text into a task item.
      .replace(/(^|\n)\[([xX ])\](?=\s)/g, '$1\\[$2]')
      .replace(/(^|\n)([#>+\-])(?=\s)/g, '$1\\$2')
      .replace(/(^|\n)(\d+)\.(?=\s)/g, '$1$2\\.');
  }

  function escapeLinkLabelBrackets(value) {
    // Link/image labels use [label](URL), so any bracket within the label
    // must be escaped even though ordinary prose may retain literal brackets.
    return value.replace(/(?<!\\)([\[\]])/g, '\\$1');
  }

  function inlineCode(value) {
    const max = Math.max(0, ...[...String(value).matchAll(/`+/g)].map(x => x[0].length));
    const fence = '`'.repeat(max + 1);
    const content = String(value).replace(/\r/g, '');
    const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${content}${pad}${fence}`;
  }

  function mark(value, marker) {
    if (!value.trim()) return value;
    const leading = value.match(/^\s*/)?.[0] || '';
    const trailing = value.match(/\s*$/)?.[0] || '';
    const core = value.slice(leading.length, value.length - trailing.length);
    return `${leading}${marker}${core}${marker}${trailing}`;
  }

  function safeHref(raw) {
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return '';
      return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
    } catch (_) { return ''; }
  }

  // Rendered equations can live inside a regular list/text block, not only a
  // dedicated notion-equation-block. Preserve the display boundary and, where
  // available, the original TeX instead of flattening it into adjacent prose.
  function equationMarkdown(element) {
    const classes = element.getAttribute('class') || '';
    const attrs = ['data-latex', 'data-equation', 'data-expression', 'data-tex'];
    const attrSource = attrs.map(key => element.getAttribute(key)).find(Boolean) || '';
    const mathWrapper = /(?:^|\s)(?:katex-display|katex|notion-(?:inline-)?equation(?:-block)?|notion-equation-inline|math-display|display-math)(?:\s|$)/i.test(classes);
    if (!mathWrapper && !attrSource) return null;
    const display = /(?:^|\s)(?:katex-display|math-display|display-math|notion-equation-block)(?:\s|$)/i.test(classes) ||
      element.getAttribute('data-display') === 'true' || /display\s*:\s*block/i.test(element.getAttribute('style') || '');
    // KaTeX duplicates visible text and MathML accessibility nodes. Reading the
    // original annotation avoids both duplication and loss of math commands.
    const annotation = [...element.querySelectorAll('annotation')].find(node =>
      /application\/x-tex/i.test(node.getAttribute('encoding') || ''));
    let latex = (attrSource || annotation?.textContent || '').trim();
    if (latex.startsWith('\\[') && latex.endsWith('\\]')) latex = latex.slice(2, -2).trim();
    if (latex.startsWith('$$') && latex.endsWith('$$')) latex = latex.slice(2, -2).trim();
    if (latex) return display ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`;
    const visual = element.querySelector('.katex-html')?.textContent ||
      element.getAttribute('aria-label') || element.textContent || '';
    // Without TeX, keep the displayed text as a separate paragraph. Never
    // guess at LaTeX or invent math commands from the rendered prose.
    const plain = escapeText(visual.replace(/\s+/g, ' ').trim());
    return plain ? (display ? `\n\n${plain}\n\n` : plain) : '';
  }

  function inlineMarkdown(node, options = {}) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node;
    const tag = element.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'button', 'input', 'textarea', 'select'].includes(tag)) return '';
    if (element.getAttribute('aria-hidden') === 'true' || element.closest('[data-n2z-exporter]')) return '';
    if (tag === 'br') return '\n';
    if (tag === 'img') return /^[\p{Extended_Pictographic}\u200d\ufe0f]+$/u.test(element.alt || '') ? element.alt : '';
    if (tag === 'code') return inlineCode(element.textContent);
    const math = equationMarkdown(element);
    if (math !== null) return math;

    // A heading is bold by definition. Notion may also assign font-weight to
    // the editor, to wrapper spans, and to actual rich-text annotations.
    // Treat font-weight as an annotation only on text spans, not the wrapper.
    const style = element.getAttribute('style') || '';
    const richSpan = tag === 'span' && !element.hasAttribute('contenteditable');
    const bold = !options.suppressBold && (tag === 'strong' || tag === 'b' ||
      (richSpan && /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)));
    const italic = tag === 'em' || tag === 'i' ||
      (richSpan && /font-style\s*:\s*italic/i.test(style));
    const strike = ['del', 's', 'strike'].includes(tag) ||
      (richSpan && /text-decoration(?:-line)?\s*:\s*line-through/i.test(style));
    const childOptions = {
      ...options,
      boldActive: Boolean(options.boldActive || bold),
      italicActive: Boolean(options.italicActive || italic),
      strikeActive: Boolean(options.strikeActive || strike),
    };
    let content = [...element.childNodes].map(child => inlineMarkdown(child, childOptions)).join('');
    if (tag === 'a') {
      const href = safeHref(element.getAttribute('href'));
      if (href && content.trim()) content = `[${escapeLinkLabelBrackets(content)}](${href})`;
    }
    if (bold && !options.boldActive) content = mark(content, '**');
    if (italic && !options.italicActive) content = mark(content, '*');
    if (strike && !options.strikeActive) content = mark(content, '~~');
    if (tag === 'u') content = `<u>${content}</u>`;
    return content;
  }

  function getRich(node, options = {}) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('button, [role="button"], script, style, svg, [data-n2z-exporter]')
      .forEach(child => child.remove());
    const content = clone.matches?.('[contenteditable], [data-content-editable-leaf]') ? clone :
      clone.querySelector('[contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], .notion-semantic-string, [data-content-editable-leaf]');
    const target = content || clone;
    return inlineMarkdown(target, options).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function textFrom(item, options = {}) { return getRich(item.own, options); }

  function getLink(item) {
    const a = item.own.querySelector('a[href]');
    return safeHref(a?.getAttribute('href'));
  }

  function linkLabel(item) {
    // getRich() already turns <a> into Markdown, so inserting it inside a
    // second [label](url) corrupts the output. Use literal text for link cards.
    const node = item.own.querySelector('[contenteditable="true"], [contenteditable="plaintext-only"], .notion-semantic-string, a[href]') || item.own;
    return escapeLinkLabelBrackets(escapeText((node.textContent || '').replace(/\s+/g, ' ').trim()));
  }

  // Database grids contain headers and rows that are not the database title.
  // Capture the explicit "open as page" anchor before cloning nested blocks.
  function databaseLink(element) {
    const links = [...element.querySelectorAll('a[href]')];
    const isOpenAsPage = a => /\u4ee5\u5b8c\u6574\u9801\u9762\u6253\u958b|open as (?:full )?page|open in (?:new )?page/i.test(
      [a.getAttribute('aria-label'), a.getAttribute('title'), a.textContent].filter(Boolean).join(' '));
    const opener = links.find(a => isOpenAsPage(a) && safeHref(a.getAttribute('href')));
    if (opener) return safeHref(opener.getAttribute('href'));
    // If no opener exists, accept a named page link but not an arbitrary data-row link.
    const named = links.find(a =>
      safeHref(a.getAttribute('href')) &&
      (a.textContent || '').trim().length > 0 &&
      !a.closest('tr, [role="row"], [role="gridcell"], [role="cell"]'));
    return named ? safeHref(named.getAttribute('href')) : '';
  }

  function databaseLabel(item) {
    const anchors = [...item.own.querySelectorAll('a[href]')];
    const named = anchors.find(a =>
      safeHref(a.getAttribute('href')) &&
      (a.textContent || '').trim().length > 0 &&
      !a.closest('tr, [role="row"], [role="gridcell"], [role="cell"]'));
    if (named) return escapeLinkLabelBrackets(escapeText(named.textContent.trim().replace(/\s+/g, ' ')));
    const leaves = [...item.own.querySelectorAll('[data-content-editable-leaf], [contenteditable="true"], [contenteditable="plaintext-only"]')]
      .filter(node => !node.parentElement?.closest('[data-content-editable-leaf], [contenteditable]') &&
        !node.closest('tr, [role="row"], [role="gridcell"], [role="cell"]'))
      .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    // Multiple leaves commonly mean column headers. Never concatenate these
    // headers into a misleading title (as happened for a Notion Test case view).
    if (leaves.length === 1 && leaves[0].length <= 48) return escapeLinkLabelBrackets(escapeText(leaves[0]));
    return '\u672a\u547d\u540d';
  }

  function getTableCells(row) {
    const element = row.own;
    let cells = [...element.querySelectorAll('td, th, [role="cell"], [role="columnheader"], .notion-table-cell, [class*="table-cell"], [data-col-index]')];
    cells = cells.filter(cell => !cells.some(other => {
      if (other === cell) return false;
      let parent = cell.parentElement || cell.parentNode;
      while (parent) {
        if (parent === other) return true;
        parent = parent.parentElement || parent.parentNode;
      }
      return false;
    }));
    if (!cells.length) {
      // Notion's simple-table sometimes uses data-col-index for each cell.
      cells = [...element.querySelectorAll('[data-col-index]')].filter(cell =>
        !cell.parentElement?.closest('[data-col-index]'));
    }
    if (!cells.length) {
      // Some Notion builds render each cell as a direct editable child.
      cells = [...element.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]')]
        .filter(cell => !cell.parentElement?.closest('[contenteditable]'));
    }
    return cells.map(cell => getRich(cell, { suppressBold: cell.tagName?.toLowerCase() === 'th' || cell.getAttribute('role') === 'columnheader' }).replace(/\n+/g, '<br>'));
  }

  function readTableMatrix(tableBlock) {
    const rowSelectors = 'tr, [role="row"], .notion-table-row-block, .notion-simple_table_row-block, .notion-table-row, [class*="table-row"]';
    let rows = [...tableBlock.querySelectorAll(rowSelectors)];
    // If a row has nested editor wrappers also named *table-row*, keep the
    // outermost row, not the nested presentation rows.
    rows = rows.filter(row => !row.parentElement?.closest(rowSelectors));
    let matrix = rows.map(row => getTableCells({ own: row })).filter(row => row.length);
    if (!matrix.length) {
      // Notion can expose only column-indexed cells without tr/role=row.
      const indexed = [...tableBlock.querySelectorAll('[data-col-index]')];
      const groups = new Map();
      for (const cell of indexed) {
        if (cell.parentElement?.closest('[data-col-index]')) continue;
        const owner = cell.parentElement;
        if (!groups.has(owner)) groups.set(owner, []);
        groups.get(owner).push(cell);
      }
      matrix = [...groups.values()].filter(cells => cells.length > 1).map(cells =>
        cells.map(cell => getRich(cell).replace(/\n+/g, '<br>')));
    }
    return matrix;
  }

  function renderTable(item, children, warnings) {
    const rows = children.filter(child => ['table_row', 'simple_table_row'].includes(child.type));
    let matrix = (item.tableData?.length ? item.tableData : rows.map(getTableCells))
      .filter(row => row.length).map(row => [...row]);
    if (!matrix.length) {
      const table = item.own.querySelector('table');
      if (table) matrix = [...table.querySelectorAll('tr')].map(tr =>
        [...tr.querySelectorAll('td,th')].map(cell => getRich(cell).replace(/\n+/g, '<br>')));
    }
    if (!matrix.length) {
      const rowNodes = item.own.querySelectorAll('[role="row"], .notion-table-row');
      matrix = [...rowNodes].map(row => getTableCells({ own: row })).filter(row => row.length);
    }
    if (!matrix.length) {
      warnings.push('有一個表格無法辨識欄位，已保留缺失標記。');
      return '> [!WARNING] 此 Notion 表格無法可靠轉換，請回原頁面確認。';
    }
    const width = Math.max(...matrix.map(row => row.length));
    if (matrix.some(row => row.length !== width)) warnings.push('表格有不等長的資料列，已補空欄位。');
    const cell = value => value || ''; // getRich() already escapes Markdown pipes.
    const line = row => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(' | ')} |`;
    // Empty header avoids falsely treating the first Notion row as a header.
    // If a real <th> is present, keep the header row as the Markdown header.
    const actualHeader = Boolean(item.tableHasHeader || item.own.querySelector('th, [role="columnheader"], .notion-table-view-header-row'));
    const header = actualHeader ? matrix.shift() : Array(width).fill('');
    return [line(header), line(Array(width).fill('---')), ...matrix.map(line)].join('\n');
  }

  function buildTree(blocks) {
    const lookup = new Map(blocks.map(item => [item.id, item]));
    const children = new Map();
    const roots = [];
    for (const item of blocks) {
      // Guard against broken parent IDs or cycles introduced by DOM changes.
      if (!item.parentId || !lookup.has(item.parentId) || item.parentId === item.id) {
        roots.push(item);
      } else {
        if (!children.has(item.parentId)) children.set(item.parentId, []);
        children.get(item.parentId).push(item);
      }
    }
    return { roots, children };
  }

  function fencedCode(source, language) {
    const maxTicks = Math.max(2, ...[...source.matchAll(/`+/g)].map(x => x[0].length));
    const fence = '`'.repeat(maxTicks + 1);
    return `${fence}${String(language || '').replace(/[^\w+#.-]/g, '')}\n${source}\n${fence}`;
  }

  function renderContent(blocks, paths, title) {
    const warnings = [];
    const { roots, children } = buildTree(blocks);
    const visited = new Set();
    // depth is a character-column indent, not a fixed 2-space nesting level.
    // Ordered-list markers (such as "1. " and "10. ") need wider child indents.
    function siblings(entries, depth, recursionDepth = 0, parentIsList = false) {
      if (recursionDepth > 60) { warnings.push('內容巢狀超過 60 層，已停止深入。'); return ''; }
      let result = '';
      let prev = null;
      let number = 0;
      for (const entry of entries) {
        if (visited.has(entry.id)) { warnings.push('偵測到重複或循環區塊，已略過重複項目。'); continue; }
        visited.add(entry.id);
        if (entry.type === 'numbered_list') number++;
        else number = 0;
        let content = renderOne(entry, depth, number, recursionDepth);
        if (content && parentIsList && !LIST_TYPES.has(entry.type)) {
          const indent = ' '.repeat(depth);
          content = content.split('\n').map(line => line ? indent + line : '').join('\n');
        }
        if (content) {
          const separator = prev && prev.type === entry.type && LIST_TYPES.has(entry.type) ? '\n' : '\n\n';
          result += (result ? separator : '') + content;
          prev = entry;
        }
      }
      return result;
    }
    function renderOne(entry, depth, number, recursionDepth) {
      const type = entry.type;
      const own = textFrom(entry, { suppressBold: ['header', 'sub_header', 'sub_sub_header', 'heading_1', 'heading_2', 'heading_3'].includes(type) });
      const descendants = children.get(entry.id) || [];
      let line = '';
      let childDepth = depth;
      switch (type) {
        case 'header': case 'heading_1': line = `## ${own.replace(/^(\d+)\\\.(?=\s)/, '$1.')}`; break;
        case 'sub_header': case 'heading_2': line = `### ${own.replace(/^(\d+)\\\.(?=\s)/, '$1.')}`; break;
        case 'sub_sub_header': case 'heading_3': line = `#### ${own.replace(/^(\d+)\\\.(?=\s)/, '$1.')}`; break;
        case 'text': line = own; break;
        case 'bulleted_list': {
          const prefix = `${' '.repeat(depth)}- `;
          line = prefix + own.replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
          childDepth = prefix.length; break;
        }
        case 'numbered_list': {
          const prefix = `${' '.repeat(depth)}${number}. `;
          line = prefix + own.replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
          childDepth = prefix.length; break;
        }
        case 'to_do': {
          const prefix = `${' '.repeat(depth)}- [${entry.checked ? 'x' : ' '}] `;
          line = prefix + own.replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
          childDepth = prefix.length; break;
        }
        case 'toggle':
          line = `**▸ ${own || '收合區塊'}**`;
          if (entry.collapsed && !descendants.length) {
            warnings.push(`收合區塊「${own.slice(0, 45)}」的子內容未展開，可能無法取得。`);
            line += '\n\n> [!WARNING] 此區塊在匯出時為收合狀態，子內容可能未包含。';
          }
          break;
        case 'quote': line = own.split('\n').map(x => `> ${x}`).join('\n'); break;
        case 'callout': {
          // Notion's image accessibility labels can include UI-only words such as
          // 'Callout icon' / '標註圖示'. Keep the actual emoji, not the label.
          const alt = entry.own.querySelector('img[alt]')?.alt || '';
          const symbol = alt.match(/^\s*([\p{Extended_Pictographic}\u2600-\u27BF](?:\ufe0f|\u200d[\p{Extended_Pictographic}\u2600-\u27BF])*)/u)?.[1] || '💡';
          line = `${symbol} ${own}`.trim().split('\n').map(x => `> ${x}`).join('\n');
          break;
        }
        case 'code': {
          const info = entry.code || { source: '', language: '', isMermaid: false, svg: null };
          const source = (info.source || '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
          if (info.isMermaid) {
            if (source.trim()) {
              line = fencedCode(source, 'mermaid');
              if (!looksLikeMermaid(source)) warnings.push('一個 Mermaid 原始碼未符合常見的圖表開頭語法，已原樣保留。');
            } else if (paths.get(entry.id)) {
              line = `![Mermaid 流程圖](${paths.get(entry.id)})`;
              warnings.push('一個 Mermaid 區塊只能從頁面取得 SVG 預覽，無法取得可編輯的 Mermaid 原始碼。');
            } else if (info.svg) {
              // The asset path is assigned after the preflight stage.
              line = '> [!NOTE] Mermaid 圖表將以 SVG 保留。';
              warnings.push('一個 Mermaid 區塊只能從頁面取得 SVG 預覽，無法取得可編輯的 Mermaid 原始碼。');
            } else {
              warnings.push('一個 Mermaid 區塊的原始碼與預覽均未載入，無法匯出。');
              line = '> [!WARNING] Mermaid 流程圖無法讀取，請回 Notion 改為 Code 或 Split 檢視後重試。';
            }
          } else if (source) {
            line = fencedCode(source, info.language);
          } else {
            warnings.push('一個程式碼區塊沒有可讀取的原始碼，請回 Notion 確認。');
            line = '> [!WARNING] 程式碼區塊無法讀取。';
          }
          break;
        }
        case 'divider': line = '---'; break;
        case 'button':
          // Notion action controls are interactive UI, not requirement text.
          // Count them in diagnostics instead of injecting unsupported warnings.
          line = ''; break;
        case 'image': {
          const path = paths.get(entry.id);
          if (!path) { warnings.push('有一張圖片沒有成功建立檔案路徑。'); line = '> [!WARNING] 圖片遺失。'; }
          else line = `![${escapeLinkLabelBrackets(escapeText(entry.image?.alt || '圖片'))}](${path})`;
          break;
        }
        case 'table': case 'simple_table': line = renderTable(entry, descendants, warnings); break;
        case 'table_row': case 'simple_table_row':
          // Already rendered by the parent table.
          return '';
        case 'bookmark': case 'link_preview': case 'link_to_page': case 'child_page': {
          const url = getLink(entry);
          const label = linkLabel(entry);
          line = url ? `[${label || '頁面連結'}](${url})` : label;
          break;
        }
        case 'child_database': case 'collection_view': case 'collection_view_page': {
          warnings.push(`內嵌資料庫「${own.slice(0, 45) || '未命名'}」的資料列不在單頁匯出範圍。`);
          const url = entry.databaseUrl || '';
          const label = databaseLabel(entry);
          line = `> [!NOTE] 內嵌資料庫：${url ? `[${label}](${url})` : label}（未匯出資料列）`;
          break;
        }
        case 'embed': {
          const path = paths.get(entry.id);
          if (path) {
            line = `![嵌入的 Mermaid 圖表](${path})`;
            warnings.push('嵌入 Mermaid 圖表僅保存 SVG 預覽，未包含原始碼。');
          } else if (entry.diagram) {
            line = '> [!NOTE] Mermaid 圖表將以 SVG 保留。';
            warnings.push('嵌入 Mermaid 圖表僅保存 SVG 預覽，未包含原始碼。');
          } else {
            const url = getLink(entry);
            warnings.push('embed 區塊只保留來源連結，未下載外部嵌入內容。');
            line = url ? `[${linkLabel(entry) || type}](${url})` : '> [!NOTE] 嵌入內容未下載，請參考 Notion 原頁。';
          }
          break;
        }
        case 'mermaid_preview': {
          const path = paths.get(entry.id);
          if (path) {
            line = `![Mermaid 流程圖](${path})`;
            warnings.push('偵測到不在標準 Code Block 中的 Mermaid 預覽，已保存 SVG；無法保證原始碼可讀。');
          } else {
            line = '> [!WARNING] 已偵測 Mermaid 預覽，但無法保存 SVG。';
            warnings.push('偵測到不在標準 Code Block 中的 Mermaid 預覽，SVG 未保存。');
          }
          break;
        }
        case 'file': case 'pdf': case 'audio': case 'video': {
          const url = getLink(entry);
          warnings.push(`${type} 區塊只保留來源連結，未下載其附件。`);
          line = url ? `[${linkLabel(entry) || type}](${url})` : `> [!NOTE] ${type} 內容未下載，請參考 Notion 原頁。`;
          break;
        }
        case 'equation': line = own ? `$$\n${entry.own.textContent.trim()}\n$$` : ''; break;
        case 'table_of_contents': case 'breadcrumb': line = ''; break;
        case 'column': case 'column_list':
          warnings.push('多欄版面已按 DOM 區塊順序攤平成單欄。'); break;
        case 'synced_block': break;
        case 'page':
          line = own ? `**${own}**` : '';
          break;
        default: {
          warnings.push(`無法識別的 Notion 區塊類型：${type}，已保留缺失標記。`);
          line = `> [!WARNING] 未支援的 Notion 區塊（${escapeText(type)}）：${own.slice(0, 100)}`;
        }
      }
      // Table rows are emitted inside renderTable, not as duplicated sections.
      const nested = ['table', 'simple_table', 'collection_view', 'collection_view_page', 'child_database', 'button'].includes(type) ? [] : descendants;
      const nestedText = siblings(nested, childDepth, recursionDepth + 1, LIST_TYPES.has(type));
      if (!nestedText) return line;
      return line ? `${line}\n${LIST_TYPES.has(type) ? '' : '\n'}${nestedText}` : nestedText;
    }
    const body = siblings(roots, 0);
    if (visited.size < blocks.length) {
      // Some Notion versions put table rows under a table, which is handled
      // separately; remaining skipped items can still indicate an orphan/cycle.
      const skipped = blocks.filter(block => !visited.has(block.id) &&
        !['table_row', 'simple_table_row'].includes(block.type) &&
        !['collection_view', 'collection_view_page', 'child_database', 'button'].includes(
          blocks.find(parent => parent.id === block.parentId)?.type));
      if (skipped.length) warnings.push(`有 ${skipped.length} 個區塊未能建立可靠的父子順序。`);
    }
    const md = `# ${escapeText(title)}\n\n${body}`.trimEnd() + '\n';
    return { markdown: md, warnings: [...new Set(warnings)] };
  }

  function parseHeader(headers, field) {
    return String(headers || '').split(/\r?\n/).find(x => x.toLowerCase().startsWith(`${field.toLowerCase()}:`))?.split(':').slice(1).join(':').trim() || '';
  }

  function sniffImage(bytes, contentType) {
    const b = bytes;
    const starts = (pattern) => pattern.every((v, index) => b[index] === v);
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (starts([0xff, 0xd8, 0xff])) return 'jpg';
    if (b.length > 6 && String.fromCharCode(...b.subarray(0, 3)) === 'GIF') return 'gif';
    if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
        String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'webp';
    if (starts([0x42, 0x4d])) return 'bmp';
    if (b.length > 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' &&
        /^(avif|avis)$/.test(String.fromCharCode(...b.subarray(8, 12)))) return 'avif';
    const prefix = new TextDecoder().decode(b.subarray(0, Math.min(512, b.length))).replace(/^\ufeff/, '').trim();
    if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix)) return 'svg';
    const mime = String(contentType).split(';')[0].trim().toLowerCase();
    const format = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/svg+xml': 'svg' })[mime];
    return IMAGE_EXTENSIONS.has(format) ? format : null;
  }

  async function requestImage(url) {
    if (url.startsWith('blob:') || url.startsWith('data:image/')) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`讀取圖片失敗：HTTP ${response.status}`);
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') || '' };
    }
    if (typeof GM_xmlhttpRequest !== 'function') throw new Error('Userscript 管理器未提供 GM_xmlhttpRequest 權限。');
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', timeout: LIMITS.imageTimeoutMs,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`)); return;
          }
          if (!(response.response instanceof ArrayBuffer)) {
            reject(new Error('下載資料不是 ArrayBuffer')); return;
          }
          resolve({
            bytes: new Uint8Array(response.response),
            contentType: parseHeader(response.responseHeaders, 'content-type'),
          });
        },
        ontimeout: () => reject(new Error('連線逾時')),
        onerror: () => reject(new Error('網路或權限錯誤（請檢查腳本管理器的網域許可）')),
        onabort: () => reject(new Error('圖片下載被取消')),
      });
    });
  }

  // Only a diagram already rendered inside Notion can be copied to SVG.
  // Remove executable and remotely loading content before archiving an SVG.
  function serializeDiagramSvg(original) {
    const svg = original.cloneNode(true);
    const forbidden = new Set(['script', 'iframe', 'object', 'embed', 'image', 'animate',
      'animatemotion', 'animatetransform', 'set', 'audio', 'video', 'link', 'meta']);
    for (const element of [svg, ...svg.querySelectorAll('*')]) {
      if (!element.parentNode && element !== svg) continue;
      if (forbidden.has(element.localName.toLowerCase())) { element.remove(); continue; }
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on') || ['src', 'srcset', 'formaction', 'action'].includes(name) ||
            ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) ||
            ((name === 'style' || name === 'filter') && /url\(\s*['"]?(?!#)/i.test(value))) {
          element.removeAttribute(attr.name);
        }
      }
      if (element.localName.toLowerCase() === 'style') {
        element.textContent = (element.textContent || '')
          .replace(/@import\b[^;]*;/gi, '')
          .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
      }
    }
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const w = Number(original.getAttribute('width'));
    const h = Number(original.getAttribute('height'));
    if ((!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0)) {
      const box = original.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        svg.setAttribute('width', String(Math.round(box.width)));
        svg.setAttribute('height', String(Math.round(box.height)));
      }
    }
    const serialized = new XMLSerializer().serializeToString(svg);
    // Normalize the root default namespace. Some HTML serializers append an
    // additional XHTML namespace even if an SVG namespace is already present.
    const openTagEnd = serialized.indexOf('>');
    if (!serialized.startsWith('<svg') || openTagEnd < 0) throw new Error('Mermaid SVG 內容無法序列化');
    const rootTag = serialized.slice(0, openTagEnd)
      .replace(/\sxmlns="[^"]*"/g, '')
      .replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const content = rootTag + serialized.slice(openTagEnd);
    if (content.length < 30) throw new Error('Mermaid SVG 內容無法序列化');
    return textEncoder.encode(content);
  }

  async function getImages(blocks, status) {
    const imageBlocks = blocks.filter(block => block.type === 'image');
    const mermaidVisuals = blocks.filter(block =>
      (block.type === 'code' && block.code?.isMermaid &&
       !block.code.source?.trim() && block.code.svg) ||
      (['embed', 'mermaid_preview'].includes(block.type) && block.diagram));
    const assets = blocks.filter(block => imageBlocks.includes(block) || mermaidVisuals.includes(block));
    if (assets.length > LIMITS.images) throw new Error(`本頁圖片與流程圖總數超過 ${LIMITS.images} 個的保護上限，未建立 ZIP。`);
    const files = new Map();
    const paths = new Map();
    const duplicates = new Map();
    let total = 0;
    for (const block of assets) {
      const index = assets.indexOf(block) + 1;
      const diagram = block.type !== 'image';
      status(`處理${diagram ? '流程圖' : '圖片'} ${index}/${assets.length}…`);
      let image = null;
      if (diagram) {
        const svg = block.type === 'code' ? block.code.svg : block.diagram;
        const bytes = serializeDiagramSvg(svg);
        image = { bytes, ext: 'svg' };
      } else {
        const rawCandidates = block.image?.candidates || [];
        // Never silently replace a failed real image with a tiny data-URI placeholder.
        const remoteCandidates = rawCandidates.filter(isHttp);
        const candidates = remoteCandidates.length ? remoteCandidates : rawCandidates;
        if (!candidates.length) throw new Error(`圖片 ${index}/${assets.length} 無法辨識來源。已取消匯出，不會產生缺圖 ZIP。`);
        let lastError = null;
        for (const url of candidates) {
          try {
            const result = await requestImage(url);
            if (!result.bytes.length) throw new Error('圖片為空檔案');
            if (result.bytes.length > LIMITS.imageBytes) throw new Error('單張圖片超過 32 MiB 上限');
            const ext = sniffImage(result.bytes, result.contentType);
            if (!ext) throw new Error('回應內容不是可辨識的圖片格式');
            image = { ...result, ext };
            break;
          } catch (error) { lastError = error; }
        }
        if (!image) throw new Error(`圖片 ${index}/${assets.length} 下載失敗：${lastError?.message || '未知錯誤'}。已取消匯出。`);
      }
      if (image.bytes.length > LIMITS.imageBytes) throw new Error('單張圖片或流程圖超過 32 MiB 上限，未建立 ZIP。');
      total += image.bytes.length;
      if (total > LIMITS.archiveBytes) throw new Error('圖片總大小超過 240 MiB 的保護上限，未建立 ZIP。');
      let checksum;
      if (globalThis.crypto?.subtle) {
        const hash = await globalThis.crypto.subtle.digest('SHA-256', image.bytes);
        checksum = [...new Uint8Array(hash)].map(c => c.toString(16).padStart(2, '0')).join('');
      } else {
        checksum = `${image.bytes.length}:${crc32(image.bytes)}`;
      }
      if (!duplicates.has(checksum)) {
        const filename = `images/${String(files.size + 1).padStart(3, '0')}.${image.ext}`;
        files.set(filename, image.bytes);
        duplicates.set(checksum, filename);
      }
      paths.set(block.id, duplicates.get(checksum));
    }
    return { files, paths, imageCount: imageBlocks.length, diagramCount: mermaidVisuals.length };
  }

  // A deterministic, dependency-free ZIP writer (ZIP32, STORE, UTF-8 filenames).
  // Images are already compressed, so STORE avoids unnecessary recompression.
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();
  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function put16(view, offset, value) { view.setUint16(offset, value, true); }
  function put32(view, offset, value) { view.setUint32(offset, value, true); }
  function makeZip(fileMap) {
    const entries = [...fileMap.entries()].map(([name, data]) => ({
      name: textEncoder.encode(name),
      data: data instanceof Uint8Array ? data : new Uint8Array(data),
    }));
    if (entries.length > 65535) throw new Error('ZIP 檔案數量超出 ZIP32 限制。');
    let offset = 0;
    let centralSize = 0;
    for (const entry of entries) {
      if (entry.data.length > 0xffffffff) throw new Error('檔案超過 ZIP32 4 GiB 限制。');
      entry.offset = offset;
      entry.crc = crc32(entry.data);
      offset += 30 + entry.name.length + entry.data.length;
      centralSize += 46 + entry.name.length;
    }
    if (offset + centralSize + 22 > 0xffffffff) throw new Error('ZIP 超過 ZIP32 4 GiB 限制。');
    const output = new Uint8Array(offset + centralSize + 22);
    const view = new DataView(output.buffer);
    let position = 0;
    for (const entry of entries) {
      put32(view, position, 0x04034b50);
      put16(view, position + 4, 20);
      put16(view, position + 6, 0x0800); // UTF-8 filenames
      put16(view, position + 8, 0);      // STORED
      put16(view, position + 10, 0);     // fixed timestamp
      put16(view, position + 12, 0);
      put32(view, position + 14, entry.crc);
      put32(view, position + 18, entry.data.length);
      put32(view, position + 22, entry.data.length);
      put16(view, position + 26, entry.name.length);
      put16(view, position + 28, 0);
      position += 30;
      output.set(entry.name, position); position += entry.name.length;
      output.set(entry.data, position); position += entry.data.length;
    }
    const centralStart = position;
    for (const entry of entries) {
      put32(view, position, 0x02014b50);
      put16(view, position + 4, 20);
      put16(view, position + 6, 20);
      put16(view, position + 8, 0x0800);
      put16(view, position + 10, 0);
      put16(view, position + 12, 0);
      put16(view, position + 14, 0);
      put32(view, position + 16, entry.crc);
      put32(view, position + 20, entry.data.length);
      put32(view, position + 24, entry.data.length);
      put16(view, position + 28, entry.name.length);
      put16(view, position + 30, 0);
      put16(view, position + 32, 0);
      put16(view, position + 34, 0);
      put16(view, position + 36, 0);
      put32(view, position + 38, 0);
      put32(view, position + 42, entry.offset);
      position += 46;
      output.set(entry.name, position); position += entry.name.length;
    }
    put32(view, position, 0x06054b50);
    put16(view, position + 4, 0); put16(view, position + 6, 0);
    put16(view, position + 8, entries.length); put16(view, position + 10, entries.length);
    put32(view, position + 12, position - centralStart);
    put32(view, position + 16, centralStart);
    put16(view, position + 20, 0);
    return output;
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function makeDiagnostics(blocks, imageCount, svgCount, warningCount) {
    const kinds = {};
    for (const item of blocks) kinds[item.type] = (kinds[item.type] || 0) + 1;
    const codeBlocks = blocks.filter(item => item.type === 'code');
    const mermaidCode = codeBlocks.filter(item => item.code?.isMermaid);
    const mermaidSource = mermaidCode.filter(item => item.code?.source?.trim());
    const mermaidVisualOnly = mermaidCode.filter(item => !item.code?.source?.trim() && item.code?.svg);
    const standalonePreviews = blocks.filter(item => item.type === 'mermaid_preview');
    const embedPreviews = blocks.filter(item => item.type === 'embed' && item.diagram);
    // Privacy-safe diagnostic explanations: do not copy text, links, or images
    // from the page into export-report.json. Counts refer to scanned DOM blocks.
    const limitations = [];
    const addLimitation = (code, description, count) => {
      if (count > 0) limitations.push({ code, description, detectedBlocks: count });
    };
    addLimitation('linked_database_rows', '內嵌資料庫的資料列未包含在單頁匯出範圍。',
      (kinds.collection_view || 0) + (kinds.collection_view_page || 0) + (kinds.child_database || 0));
    addLimitation('flattened_columns', '多欄版面依區塊順序轉為單欄。',
      (kinds.column || 0) + (kinds.column_list || 0));
    addLimitation('collapsed_toggles', '收合中的區塊可能有尚未載入的子內容。',
      blocks.filter(item => item.type === 'toggle' && item.collapsed).length);
    addLimitation('linked_media', '非圖片媒體附件只保留來源連結，未打包原檔。',
      (kinds.file || 0) + (kinds.pdf || 0) + (kinds.audio || 0) + (kinds.video || 0));
    addLimitation('unreadable_tables', '部分表格無法可靠轉為 Markdown。',
      blocks.filter(item => ['table', 'simple_table'].includes(item.type) && !item.tableData?.length).length);
    return {
      exporterVersion: VERSION,
      information: '本檔只有區塊類型與數量統計，不包含 Notion 文件文字、登入資訊或圖片網址。',
      blockCount: blocks.length,
      blockTypes: Object.fromEntries(Object.entries(kinds).sort(([a], [b]) => a.localeCompare(b))),
      mermaid: {
        codeBlocks: mermaidCode.length,
        readableSources: mermaidSource.length,
        svgOnlyCodeBlocks: mermaidVisualOnly.length,
        detachedSvgPreviews: standalonePreviews.length,
        embeddedSvgPreviews: embedPreviews.length,
        savedSvgFiles: svgCount,
      },
      richMath: {
        displayElements: blocks.reduce((sum, item) => sum + item.own.querySelectorAll(
          '.katex-display, .notion-equation-block, .math-display, .display-math, [data-display="true"][data-latex]'
        ).length, 0),
      },
      tables: {
        blocks: (kinds.table || 0) + (kinds.simple_table || 0),
        rowsDetected: blocks.filter(item => ['table', 'simple_table'].includes(item.type))
          .reduce((sum, item) => sum + (item.tableData?.length || 0), 0),
        unrecognized: blocks.filter(item => ['table', 'simple_table'].includes(item.type) && !item.tableData?.length).length,
      },
      otherMedia: {
        imageBlocks: imageCount,
        iframeElementsInBlocks: blocks.reduce((sum, item) => sum + (item.mediaNodes?.iframes || 0), 0),
        canvasElementsInBlocks: blocks.reduce((sum, item) => sum + (item.mediaNodes?.canvases || 0), 0),
      },
      omissions: { interactiveButtons: kinds.button || 0 },
      limitations,
      warningCategoriesCount: warningCount,
    };
  }

  async function exportPage(status) {
    const title = pageTitle();
    const blocks = await scanCurrentPage(status);
    status(`辨識 ${blocks.length} 個區塊，正在檢查…`);
    const preflight = renderContent(blocks, new Map(), title);
    const preWarnings = preflight.warnings.filter(w => !w.includes('沒有成功建立檔案路徑'));
    if (preWarnings.length) {
      // Keep the confirmation short. Detailed limitations stay in the ZIP's
      // export-report.json; never surprise the user by omitting the warning.
      if (!confirm('部分內容可能無法完整匯出，仍要繼續嗎？')) {
        status('已取消'); return null;
      }
    }
    const unavailable = blocks.filter(block => block.type === 'code' && block.code?.isMermaid &&
      !block.code.source?.trim() && !block.code.svg);
    if (unavailable.length) throw new Error(`有 ${unavailable.length} 個 Mermaid 流程圖沒有可取得的原始碼或 SVG 預覽。請在 Notion 切換為 Code 或 Split 檢視後再匯出，避免遺漏流程圖。`);
    const { files, paths, imageCount, diagramCount } = await getImages(blocks, status);
    const { markdown, warnings } = renderContent(blocks, paths, title);
    if (!markdown.trim()) throw new Error('Markdown 內容為空，已取消匯出。');
    status('建立 ZIP…');
    const base = safeFilename(title);
    const warningCount = warnings.filter(w => !w.includes('沒有成功建立檔案路徑')).length;
    const diagnostics = makeDiagnostics(blocks, imageCount, diagramCount, warningCount);
    const packageFiles = new Map([
      [`${base}.md`, textEncoder.encode(markdown)],
      ['export-report.json', textEncoder.encode(JSON.stringify(diagnostics, null, 2) + '\n')],
      ...files,
    ]);
    const bytes = makeZip(packageFiles);
    downloadBytes(bytes, `${base}.zip`);
    status('已開始下載 ZIP');
    return { title, blocks: blocks.length, imageCount, diagramCount, warnings };
  }

  function mountButton() {
    if (document.getElementById('n2z-export-control')) return;
    const host = document.createElement('div');
    host.id = 'n2z-export-control';
    host.setAttribute('data-n2z-exporter', '');
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all:initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft JhengHei', system-ui, sans-serif; }
      *, *::before, *::after { box-sizing:border-box; }
      .wrap { position:relative; display:flex; width:50px; height:50px; align-items:center; justify-content:center; }
      .action { display:grid; place-items:center; flex:none; width:50px; height:50px;
        border:1px solid rgba(255,255,255,.18); border-radius:50%; padding:0;
        color:#fff; background:rgba(31,38,48,.94); cursor:grab; touch-action:none; user-select:none;
        -webkit-tap-highlight-color:transparent;
        box-shadow:0 5px 22px rgba(13,21,30,.19), 0 1px 4px rgba(13,21,30,.10), inset 0 1px 0 rgba(255,255,255,.12);
        transition:transform .19s cubic-bezier(.2,.7,.2,1),background-color .19s ease,box-shadow .19s ease;
      }
      .action:hover { background:rgba(44,54,68,.97); transform:translateY(-1px);
        box-shadow:0 8px 26px rgba(13,21,30,.24),0 1px 4px rgba(13,21,30,.12); }
      .action:active { transform:scale(.94); }
      .wrap.dragging .action, .wrap.dragging .action:hover { cursor:grabbing; transform:scale(1.04); transition:none; }
      .action:focus-visible { outline:3px solid #56a6ff; outline-offset:3px; }
      .action:disabled { cursor:progress; opacity:1; }
      .action:disabled:hover { transform:none; }
      .action[data-state='success'] { background:#25804b; }
      .action[data-state='error'] { background:#a83235; }
      .symbol { display:none; width:22px; height:22px; stroke:currentColor; fill:none;
        stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .action[data-state='idle'] .symbol-download,
      .action[data-state='success'] .symbol-check,
      .action[data-state='error'] .symbol-alert { display:block; }
      .spinner { display:none; width:21px; height:21px; border-radius:50%;
        border:2px solid rgba(255,255,255,.30); border-top-color:#fff;
        animation:n2z-spin .75s linear infinite; }
      .action[data-state='working'] .spinner { display:block; }
      @keyframes n2z-spin { to { transform:rotate(360deg); } }
      .tooltip { position:absolute; right:0; bottom:calc(100% + 10px); pointer-events:none;
        padding:7px 11px; border-radius:10px; font:500 12px/1.35 system-ui, sans-serif;
        color:#fff; white-space:nowrap; background:rgba(34,40,49,.94);
        box-shadow:0 5px 14px rgba(15,23,32,.17); opacity:0; transform:translateY(4px);
        transition:opacity .15s ease,transform .15s ease; }
      .wrap:not(.dragging):not(.has-toast) .action:hover ~ .tooltip,
      .wrap:not(.dragging):not(.has-toast) .action:focus-visible ~ .tooltip { opacity:1; transform:translateY(0); }
      .wrap.show-below .tooltip { top:calc(100% + 10px); bottom:auto; }
      .wrap.show-right .tooltip { left:0; right:auto; }
      .status { position:absolute; right:calc(100% + 12px); bottom:3px; min-height:42px;
        display:flex; align-items:center; width:max-content; max-width:min(320px, var(--n2z-status-room, 260px));
        padding:10px 13px; border:1px solid rgba(0,0,0,.07); border-radius:13px;
        background:rgba(255,255,255,.95); color:#24303d;
        box-shadow:0 8px 30px rgba(13,21,30,.14),0 2px 5px rgba(13,21,30,.05);
        font:500 12.5px/1.5 system-ui, 'Microsoft JhengHei', sans-serif;
        overflow-wrap:anywhere; white-space:normal;
        opacity:0; transform:translateX(5px); pointer-events:none;
        transition:opacity .18s ease,transform .18s ease;
        -webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px); }
      .status.show { opacity:1; transform:translateX(0); }
      .wrap.show-right .status { left:calc(100% + 12px); right:auto; }
      .wrap.show-below .status { top:0; bottom:auto; }
      .wrap.dragging .status { opacity:0; }
      .status.error { color:#a62f38; border-color:rgba(166,47,56,.22); }
      @media (prefers-color-scheme: dark) {
        .status { background:rgba(37,41,47,.95); color:#f5f6f7; border-color:rgba(255,255,255,.10); }
        .status.error { color:#ffb4b8; border-color:rgba(255,180,184,.25); }
      }
      @media (prefers-contrast: more) {
        .action { border:2px solid #fff; } .status { border:2px solid currentColor; }
      }
      @media (prefers-reduced-transparency: reduce) {
        .status { -webkit-backdrop-filter:none; backdrop-filter:none; background:#fff; }
      }
      @media (prefers-color-scheme: dark) and (prefers-reduced-transparency: reduce) {
        .status { background:#25292f; color:#f5f6f7; }
      }
      @media (prefers-reduced-motion: reduce) {
        .action,.status,.tooltip { transition:none; }
        .action:hover,.action:active,.status,.tooltip { transform:none; }
        .spinner { animation:none; border-color:rgba(255,255,255,.55); border-top-color:#fff; }
      }
    `;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const note = document.createElement('div');
    note.className = 'status';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    note.setAttribute('aria-atomic', 'true');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action';
    button.dataset.state = 'idle';
    button.setAttribute('aria-label', '匯出目前 Notion 頁面為 Markdown 與圖片 ZIP');
    button.setAttribute('aria-busy', 'false');
    button.innerHTML = `
      <svg class="symbol symbol-download" aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3.5v11m0 0-4-4m4 4 4-4M5 17v2.5h14V17"/>
      </svg>
      <span class="spinner" aria-hidden="true"></span>
      <svg class="symbol symbol-check" aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg>
      <svg class="symbol symbol-alert" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 8v5m0 3.5h.01M10.3 3.8 2.7 17.2a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg>
    `;
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.textContent = '點擊匯出 · 拖曳移動';
    tooltip.setAttribute('aria-hidden', 'true');
    // Persist ratios rather than pixel positions so a saved location stays useful
    // after zooming or resizing the viewport (including mobile rotation).
    const POSITION_KEY = 'n2z.export-button-position.v1';
    const BUTTON_SIZE = 50;
    const EDGE_PADDING = 12;
    const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
    const bounds = () => {
      const width = Math.max(BUTTON_SIZE + EDGE_PADDING * 2, window.innerWidth || document.documentElement.clientWidth || 0);
      const height = Math.max(BUTTON_SIZE + EDGE_PADDING * 2, window.innerHeight || document.documentElement.clientHeight || 0);
      return {
        minX: EDGE_PADDING, maxX: width - BUTTON_SIZE - EDGE_PADDING,
        minY: EDGE_PADDING, maxY: height - BUTTON_SIZE - EDGE_PADDING,
        width, height,
      };
    };
    const parsePosition = raw => {
      try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
        if (value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) return null;
        return { x: value.x, y: value.y };
      } catch (_) { return null; }
    };
    const readPosition = () => {
      try {
        if (typeof GM_getValue === 'function') {
          const stored = parsePosition(GM_getValue(POSITION_KEY, null));
          if (stored) return stored;
        }
      } catch (_) { /* Userscript storage may be unavailable in offline tests. */ }
      try { return parsePosition(localStorage.getItem(POSITION_KEY)); }
      catch (_) { return null; }
    };
    const writePosition = value => {
      const raw = JSON.stringify(value);
      try { if (typeof GM_setValue === 'function') GM_setValue(POSITION_KEY, raw); }
      catch (_) { /* Fall back to localStorage below. */ }
      try { localStorage.setItem(POSITION_KEY, raw); }
      catch (_) { /* Private mode may prevent storage; dragging still works. */ }
    };
    let savedPosition = readPosition();
    let currentPosition = { x: 0, y: 0 };
    const placeAt = (left, top) => {
      const rect = bounds();
      const x = clamp(left, rect.minX, rect.maxX);
      const y = clamp(top, rect.minY, rect.maxY);
      currentPosition = { x, y };
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      // Keep hover help and status messages on-screen after dragging.
      const roomLeft = x - EDGE_PADDING;
      const roomRight = rect.width - x - BUTTON_SIZE - EDGE_PADDING;
      const showRight = roomRight > roomLeft;
      wrap.classList.toggle('show-right', showRight);
      wrap.classList.toggle('show-below', y < 76);
      wrap.style.setProperty('--n2z-status-room', `${Math.max(60, Math.floor((showRight ? roomRight : roomLeft) - 12))}px`);
    };
    const ratiosFromPosition = () => {
      const rect = bounds();
      const rangeX = rect.maxX - rect.minX;
      const rangeY = rect.maxY - rect.minY;
      return {
        x: rangeX ? clamp((currentPosition.x - rect.minX) / rangeX, 0, 1) : 0.5,
        y: rangeY ? clamp((currentPosition.y - rect.minY) / rangeY, 0, 1) : 0.5,
      };
    };
    const positionFromPreference = () => {
      const rect = bounds();
      if (savedPosition) {
        placeAt(
          rect.minX + savedPosition.x * (rect.maxX - rect.minX),
          rect.minY + savedPosition.y * (rect.maxY - rect.minY)
        );
      } else {
        // Midpoint between the top edge and the viewport center (25% high).
        placeAt(rect.width - BUTTON_SIZE - 20, rect.height * 0.25 - BUTTON_SIZE / 2);
      }
    };
    let drag = null;
    let suppressClickUntil = 0;
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('pointerdown', event => {
      if (running || !event.isPrimary || event.button !== 0) return;
      drag = {
        id: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        left: currentPosition.x, top: currentPosition.y, moved: false,
      };
      try { button.setPointerCapture(event.pointerId); } catch (_) { /* Ignore unsupported capture. */ }
    });
    button.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.clientX;
      const dy = event.clientY - drag.clientY;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        wrap.classList.add('dragging');
      }
      placeAt(drag.left + dx, drag.top + dy);
      event.preventDefault();
    });
    const finishDrag = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      wrap.classList.remove('dragging');
      if (moved) {
        savedPosition = ratiosFromPosition();
        writePosition(savedPosition);
        suppressClickUntil = performance.now() + 450;
        event.preventDefault();
      }
      try { if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId); }
      catch (_) { /* Capture may have already been released. */ }
    };
    button.addEventListener('pointerup', finishDrag);
    button.addEventListener('pointercancel', finishDrag);
    button.addEventListener('lostpointercapture', finishDrag);
    window.addEventListener('resize', () => { if (!drag) positionFromPreference(); });
    positionFromPreference();
    let toastTimer = null;
    let stateTimer = null;
    const cancelTimers = () => {
      clearTimeout(toastTimer); clearTimeout(stateTimer);
      toastTimer = null; stateTimer = null;
    };
    const setState = (state, message = '', duration = 0) => {
      cancelTimers();
      button.dataset.state = state;
      button.setAttribute('aria-busy', String(state === 'working'));
      button.setAttribute('aria-label', state === 'error'
        ? '重試匯出目前 Notion 頁面'
        : '匯出目前 Notion 頁面為 Markdown 與圖片 ZIP');
      note.textContent = message;
      note.classList.toggle('show', Boolean(message));
      note.classList.toggle('error', state === 'error');
      note.setAttribute('role', state === 'error' ? 'alert' : 'status');
      wrap.classList.toggle('has-toast', Boolean(message));
      if (duration > 0) {
        toastTimer = setTimeout(() => {
          note.classList.remove('show');
          wrap.classList.remove('has-toast');
          note.textContent = '';
        }, duration);
        if (state === 'success') {
          stateTimer = setTimeout(() => { button.dataset.state = 'idle'; }, duration);
        }
      }
    };
    const friendlyStatus = (message) => {
      if (/^掃描正文/.test(message)) return '正在讀取頁面…';
      if (/^辨識/.test(message)) return '正在檢查內容…';
      if (/^處理(圖片|流程圖)/.test(message)) return message.replace(/^處理/, '儲存');
      if (/^建立 ZIP/.test(message)) return '正在打包 ZIP…';
      return String(message).replace(/\s+/g, ' ').slice(0, 130);
    };
    button.addEventListener('click', async event => {
      // Browsers can dispatch a click immediately after a pointer drag.
      if (event.detail > 0 && performance.now() < suppressClickUntil) {
        event.preventDefault();
        return;
      }
      if (running) return;
      running = true;
      button.disabled = true;
      setState('working', '正在準備匯出…');
      try {
        const result = await exportPage(message => {
          const shortMessage = friendlyStatus(message);
          // Avoid repeating identical live-region announcements while scanning.
          if (note.textContent !== shortMessage) setState('working', shortMessage);
        });
        if (result) setState('success', 'ZIP 已開始下載', 3100);
        else setState('idle', '已取消', 1800);
      } catch (error) {
        console.error('[Notion MD ZIP]', error);
        const message = String(error?.message || '未知錯誤').replace(/\s+/g, ' ').slice(0, 170);
        setState('error', `匯出失敗：${message}`);
      } finally {
        running = false;
        button.disabled = false;
      }
    });
    wrap.append(note, button, tooltip);
    shadow.append(style, wrap);
    document.body.appendChild(host);
  }

  // Allows the bundled offline Chromium fixture to run the pure converter tests.
  // Not enabled on real Notion web origins.
  if (location.protocol === 'file:' && window.__N2Z_TEST__ === true) {
    window.__N2Z_API__ = { safeFilename, escapeText, inlineMarkdown, getRich, blockType,
      getOwnSnapshot, snapshotBlocks, renderContent, sniffImage, makeZip, crc32, imageOptions,
      scanCurrentPage, getImages, getCodeInfo, serializeDiagramSvg, makeDiagnostics,
      exportPage, pageTitle, mountButton };
    return;
  }
  if (document.body) mountButton();
  else document.addEventListener('DOMContentLoaded', mountButton, { once: true });
})();
