const EXTENSION_CLASS = "b24-files-list-ext";
const BLOCK_SELECTOR = '.tasks-field-files[data-task-field-id="fileIds"]';
const LIST_SELECTOR = ".tasks-field-files-list";
const REPLACEMENT_SELECTOR = '[data-b24-files-list="replacement"]';

let renderTimer = null;
let mutationObserver = null;
let urlWatcherTimer = null;
let lastHandledUrl = "";
let routeHooksInstalled = false;
const pendingDeletes = new Map();
const externalLinkCache = new Map();
const PENDING_DELETE_TTL = 10000;
const HIDDEN_SHEET_STYLE_ID = "b24-files-list-hidden-sheet-style";
const BAMBU_FILE_EXTENSIONS = new Set(["STL", "STEP", "STP", "3MF", "OBJ"]);
const LYCHEE_FILE_EXTENSIONS = new Set(["STL", "OBJ", "3MF", "LYS", "LYT", "GLB"]);
const MODEL_FILE_EXTENSIONS = new Set([
  ...BAMBU_FILE_EXTENSIONS,
  ...LYCHEE_FILE_EXTENSIONS
]);

bootstrap();

function bootstrap() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
    return;
  }

  start();
}

function start() {
  observePage();
  observeRouteChanges();
  handleRouteChange();
}

async function probeUrlFromBackground(url, credentials = "omit") {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime?.id) {
        throw new Error("Extension context invalidated. Please refresh the page.");
      }

      chrome.runtime.sendMessage({ type: "PROBE_URL", url, credentials }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.ok) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || "Probe failed"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function downloadModelFromBackground(url, filename, extension) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime?.id) {
        throw new Error("Extension context invalidated. Please refresh the page.");
      }

      chrome.runtime.sendMessage({ type: "DOWNLOAD_MODEL", url, filename, extension }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.ok) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || "Download failed"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function openNativeSlicerFromBackground(app, filename) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome.runtime?.id) {
        throw new Error("Extension context invalidated. Please refresh the page.");
      }

      chrome.runtime.sendMessage({ type: "OPEN_IN_NATIVE_SLICER", app, filename }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.ok) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || "Native slicer open failed"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function isBitrixTaskPage() {
  const path = window.location.pathname.toLowerCase();
  const host = window.location.hostname.toLowerCase();
  const looksLikeBitrixHost =
    host.includes("bitrix") ||
    document.body?.className.toLowerCase().includes("bitrix");

  const looksLikeTaskPath = /\/tasks\/task\/view\/\d+/i.test(path);
  const hasTaskCard = document.querySelector(".tasks-full-card, [data-task-full]");

  return Boolean(looksLikeBitrixHost && (looksLikeTaskPath || hasTaskCard));
}

function observePage() {
  if (mutationObserver) {
    return;
  }

  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (
        mutation.type === "childList" &&
        [...mutation.addedNodes].some(shouldTriggerRender)
      ) {
        scheduleRender();
        return;
      }

      if (
        mutation.type === "attributes" &&
        mutation.target instanceof Element &&
        shouldTriggerRender(mutation.target)
      ) {
        scheduleRender();
        return;
      }
    }
  });

  mutationObserver.observe(document.body, {
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "title",
      "data-src",
      "data-title",
      "data-task-files-count"
    ],
    childList: true,
    subtree: true
  });
}

function observeRouteChanges() {
  if (!routeHooksInstalled) {
    routeHooksInstalled = true;

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function pushState(...args) {
      const result = originalPushState.apply(this, args);
      handleRouteChange();
      return result;
    };

    history.replaceState = function replaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      handleRouteChange();
      return result;
    };

    window.addEventListener("popstate", handleRouteChange, { passive: true });
    window.addEventListener("hashchange", handleRouteChange, { passive: true });
  }

  if (!urlWatcherTimer) {
    urlWatcherTimer = window.setInterval(() => {
      if (window.location.href !== lastHandledUrl) {
        handleRouteChange();
      }
    }, 500);
  }
}

function handleRouteChange() {
  lastHandledUrl = window.location.href;
  scheduleRender();
}

function shouldTriggerRender(node) {
  if (!(node instanceof Element)) {
    return false;
  }

  if (node.closest(`.${EXTENSION_CLASS}`)) {
    return false;
  }

  return Boolean(
    node.matches?.(BLOCK_SELECTOR) ||
      node.querySelector?.(BLOCK_SELECTOR) ||
      node.matches?.(".ui-tile-uploader-item, .tasks-full-card") ||
      node.querySelector?.(".ui-tile-uploader-item, .tasks-full-card")
  );
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderAllBlocks, 200);
}

function renderAllBlocks() {
  if (!isBitrixTaskPage()) {
    return;
  }

  cleanupPendingDeletes();
  document.querySelectorAll(BLOCK_SELECTOR).forEach(renderBlock);
}

function renderBlock(block) {
  const listHost = block.querySelector(LIST_SELECTOR);
  if (!listHost) {
    return;
  }

  const files = collectFiles(block);
  const replacement = ensureReplacement(listHost);
  replacement.replaceChildren(buildList(files, block));
  block.classList.add(`${EXTENSION_CLASS}--active`);
  syncHeaderAction(block);

  const countNode = block.querySelector(".tasks-field-files-text");
  if (countNode) {
    countNode.textContent = `Файлы: ${files.length}`;
  }

  hideNativeTiles(listHost);
}

function ensureReplacement(listHost) {
  let replacement = listHost.querySelector(REPLACEMENT_SELECTOR);
  if (!replacement) {
    replacement = document.createElement("div");
    replacement.dataset.b24FilesList = "replacement";
    replacement.className = `${EXTENSION_CLASS} ${EXTENSION_CLASS}__replacement`;
    listHost.append(replacement);
  }

  return replacement;
}

function hideNativeTiles(listHost) {
  [...listHost.children].forEach((child) => {
    if (child.matches(REPLACEMENT_SELECTOR)) {
      return;
    }

    child.classList.add(`${EXTENSION_CLASS}__native`);
  });
}

function collectFiles(block) {
  const files = new Map();
  const tileNodes = block.querySelectorAll(".ui-tile-uploader-item");

  tileNodes.forEach((tile) => {
    const file = extractFileFromTileItem(tile);
    if (file && !isDeletePending(file.key)) {
      files.set(file.key, file);
    }
  });

  if (!files.size) {
    block.querySelectorAll(`${LIST_SELECTOR} a[href]`).forEach((anchor) => {
      const file = extractFileFromAnchor(anchor);
      if (file) {
        files.set(file.key, file);
      }
    });
  }

  return [...files.values()].sort((left, right) =>
    left.title.localeCompare(right.title, "ru")
  );
}

function extractFileFromTileItem(tileItem) {
  const previewContent = tileItem.querySelector(".ui-tile-uploader-item-preview-content");
  const href = sanitizeUrl(
    previewContent?.dataset.unifiedLink ||
      previewContent?.dataset.src ||
      tileItem.querySelector("a[href]")?.getAttribute("href")
  );

  const title =
    normalizeText(previewContent?.dataset.title) ||
    normalizeText(tileItem.querySelector(".ui-tile-uploader-item-name-box")?.title) ||
    buildTitleFromChunks(tileItem) ||
    "Без названия";

  const removeButton = tileItem?.querySelector(".ui-tile-uploader-item-remove");
  const isComplete = tileItem.classList.contains("ui-tile-uploader-item--complete");

  return toFileRecord(
    title,
    href,
    removeButton,
    isComplete ? "ready" : "uploading",
    {
      objectId: normalizeText(previewContent?.dataset.objectId),
      attachedObjectId: normalizeText(previewContent?.dataset.attachedObjectId),
      externalLink: sanitizeUrl(previewContent?.dataset.unifiedLink)
    }
  );
}

function extractFileFromAnchor(anchor) {
  if (anchor.closest(`.${EXTENSION_CLASS}`)) {
    return null;
  }

  const href = sanitizeUrl(anchor.getAttribute("href"));
  const title =
    normalizeText(anchor.getAttribute("title")) ||
    normalizeText(anchor.textContent);

  if (!href || !title) {
    return null;
  }

  return toFileRecord(title, href, null, "ready");
}

function buildTitleFromChunks(tile) {
  const directTitle = normalizeText(
    tile.querySelector(".ui-tile-uploader-item-name")?.textContent
  );
  if (directTitle) {
    return directTitle;
  }

  const name = normalizeText(
    tile.querySelector(".ui-tile-uploader-item-name-title")?.textContent
  );
  const extension = normalizeText(
    tile.querySelector(".ui-tile-uploader-item-name-extension")?.textContent
  );

  return `${name}${extension}`.trim();
}

function toFileRecord(title, href, removeButton, status, details = {}) {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) {
    return null;
  }

  return {
    key: `${href}::${normalizedTitle}`,
    title: normalizedTitle,
    href,
    objectId: details.objectId || null,
    attachedObjectId: details.attachedObjectId || null,
    externalLink: details.externalLink || null,
    extension: getExtension(normalizedTitle),
    removeButton: removeButton instanceof HTMLElement ? removeButton : null,
    status
  };
}

function sanitizeUrl(url) {
  if (!url || url.startsWith("#") || url.startsWith("javascript:")) {
    return null;
  }

  try {
    return new URL(url, window.location.href).href;
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getExtension(title) {
  const match = title.match(/\.([a-z0-9]{2,8})$/i);
  return match ? match[1].toUpperCase() : "FILE";
}

function buildList(files, block) {
  const fragment = document.createDocumentFragment();

  if (!files.length) {
    const emptyState = document.createElement("div");
    emptyState.className = `${EXTENSION_CLASS}__empty`;
    emptyState.textContent = "Файлов пока нет";
    fragment.append(emptyState);
    return fragment;
  }

  const list = document.createElement("ol");
  list.className = `${EXTENSION_CLASS}__list`;

  for (const file of files) {
    list.append(buildListItem(file));
  }

  fragment.append(list, buildFooter(files, block));
  return fragment;
}

function buildListItem(file) {
  const item = document.createElement("li");
  item.className = `${EXTENSION_CLASS}__item`;
  if (isDeletePending(file.key)) {
    item.classList.add(`${EXTENSION_CLASS}__item--pending`);
  }
  if (file.status !== "ready") {
    item.classList.add(`${EXTENSION_CLASS}__item--uploading`);
  }

  const extension = document.createElement("span");
  extension.className = `${EXTENSION_CLASS}__badge`;
  extension.textContent = file.status === "ready" ? file.extension : "...";

  const titleNode =
    file.href && file.status === "ready"
      ? document.createElement("a")
      : document.createElement("span");
  titleNode.className = `${EXTENSION_CLASS}__link`;
  titleNode.textContent = file.title;

  if (titleNode instanceof HTMLAnchorElement) {
    titleNode.href = file.href;
    titleNode.target = "_blank";
    titleNode.rel = "noreferrer";
  }

  const main = document.createElement("div");
  main.className = `${EXTENSION_CLASS}__main`;
  main.append(titleNode);

  if (shouldRenderSlicerActions(file)) {
    main.append(buildSlicerActions(file));
  }

  const actions = document.createElement("div");
  actions.className = `${EXTENSION_CLASS}__actions`;

  if (file.removeButton && !isDeletePending(file.key)) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = `${EXTENSION_CLASS}__delete`;
    deleteButton.textContent = "×";
    deleteButton.setAttribute("aria-label", `Удалить файл ${file.title}`);
    deleteButton.title = "Удалить";
    if (isDeletePending(file.key)) {
      deleteButton.disabled = true;
    }
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDeletePending(file.key)) {
        return;
      }

      pendingDeletes.set(file.key, Date.now());
      item.classList.add(`${EXTENSION_CLASS}__item--pending`);
      deleteButton.disabled = true;
      triggerNativeRemove(file.removeButton);
      scheduleRender();
    });
    actions.append(deleteButton);
  }

  item.append(extension, main, actions);

  return item;
}

function shouldRenderSlicerActions(file) {
  return Boolean(
    file?.href &&
      file.status === "ready" &&
      MODEL_FILE_EXTENSIONS.has(file.extension)
  );
}

function buildSlicerActions(file) {
  const container = document.createElement("div");
  container.className = `${EXTENSION_CLASS}__slicer-actions`;

  container.append(
    buildSlicerButton({
      file,
      app: "lychee",
      label: "Lychee",
      title: "Открыть в Lychee",
      disabled: !LYCHEE_FILE_EXTENSIONS.has(file.extension),
      disabledTitle: `Lychee не поддерживает ${file.extension}. Подойдут STL, OBJ, 3MF, LYS, LYT или GLB.`
    }),
    buildSlicerButton({
      file,
      app: "bambu",
      label: "Bambu Studio",
      title: "Открыть в Bambu Studio",
      disabled: !BAMBU_FILE_EXTENSIONS.has(file.extension),
      disabledTitle: `Bambu Studio не поддерживает ${file.extension} для этой кнопки.`
    })
  );

  return container;
}

function buildSlicerButton({ file, app, label, title, disabled = false, disabledTitle = title }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${EXTENSION_CLASS}__slicer-button ${EXTENSION_CLASS}__slicer-button--${app}`;
  button.title = disabled ? disabledTitle : title;
  button.disabled = disabled;
  button.setAttribute("aria-label", `${disabled ? disabledTitle : title}: ${file.title}`);

  const icon = document.createElement("span");
  icon.className = `${EXTENSION_CLASS}__slicer-icon`;
  icon.setAttribute("aria-hidden", "true");
  icon.append(createSlicerIcon(app));

  const text = document.createElement("span");
  text.className = `${EXTENSION_CLASS}__slicer-label`;
  text.textContent = label;

  button.append(icon, text);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) {
      return;
    }

    await openFileInSlicer(app, file, button, text);
  });

  return button;
}

function createSlicerIcon(app) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.classList.add(`${EXTENSION_CLASS}__slicer-icon-svg`);

  if (app === "lychee") {
    const body = document.createElementNS(svgNS, "path");
    body.setAttribute(
      "d",
      "M12 4.5c-3.5 0-6.5 2.76-6.5 6.1 0 4.42 3.72 8.9 6.5 8.9s6.5-4.48 6.5-8.9c0-3.34-3-6.1-6.5-6.1Z"
    );
    body.setAttribute("fill", "#ea4c89");

    const highlight = document.createElementNS(svgNS, "path");
    highlight.setAttribute(
      "d",
      "M9.2 7.5c-1.44.7-2.45 2.04-2.45 3.53 0 2.53 2.06 5.8 3.61 7.02-.96-.1-2.35-1.34-3.44-2.99-1.01-1.53-1.67-3.17-1.67-4.56 0-1.47 1.66-2.82 3.95-3Z"
    );
    highlight.setAttribute("fill", "#ff9ac0");

    const leaf = document.createElementNS(svgNS, "path");
    leaf.setAttribute(
      "d",
      "M12.56 3.9c.52-1.18 1.55-1.93 3.32-2.4-.1 1.96-1.03 3.25-2.88 3.95l-.44-1.55Z"
    );
    leaf.setAttribute("fill", "#2aa84a");

    svg.append(body, highlight, leaf);
    return svg;
  }

  const outer = document.createElementNS(svgNS, "path");
  outer.setAttribute(
    "d",
    "M12 2.75 19.25 7v10L12 21.25 4.75 17V7L12 2.75Z"
  );
  outer.setAttribute("fill", "#00ae42");

  const inner = document.createElementNS(svgNS, "path");
  inner.setAttribute(
    "d",
    "M12 6.5 16 8.75v4.5L12 15.5 8 13.25v-4.5L12 6.5Z"
  );
  inner.setAttribute("fill", "#ffffff");

  const core = document.createElementNS(svgNS, "circle");
  core.setAttribute("cx", "12");
  core.setAttribute("cy", "11");
  core.setAttribute("r", "1.6");
  core.setAttribute("fill", "#00ae42");

  svg.append(outer, inner, core);
  return svg;
}

async function openFileInSlicer(app, file, button, labelNode) {
  const previousLabel = labelNode.textContent;
  button.disabled = true;
  button.classList.remove(`${EXTENSION_CLASS}__slicer-button--error`);
  button.classList.add(`${EXTENSION_CLASS}__slicer-button--loading`);
  labelNode.textContent = "Готовлю...";

  try {
    const externalLink = await getExternalLink(file);
    console.log(`${EXTENSION_CLASS}: Download link resolved for ${file.title}`);
    labelNode.textContent = "Скачиваю...";
    const download = await downloadModelFromBackground(externalLink, file.title, file.extension);
    console.log(`${EXTENSION_CLASS}: Downloaded model:`, {
      id: download.id,
      filename: download.filename,
      mime: download.mime,
      fileSize: download.fileSize
    });
    labelNode.textContent = "Открываю...";
    await openNativeSlicerFromBackground(app, download.filename);
  } catch (error) {
    console.warn(`${EXTENSION_CLASS}: slicer open failed`, error);
    button.classList.add(`${EXTENSION_CLASS}__slicer-button--error`);
    labelNode.textContent = "Ошибка";
    window.setTimeout(() => {
      button.classList.remove(`${EXTENSION_CLASS}__slicer-button--error`);
      labelNode.textContent = previousLabel;
    }, 2500);
    return;
  } finally {
    button.disabled = false;
    button.classList.remove(`${EXTENSION_CLASS}__slicer-button--loading`);
  }

  labelNode.textContent = previousLabel;
}

async function getExternalLink(file) {
  const cacheKey = file.objectId || file.attachedObjectId || file.href;
  if (externalLinkCache.has(cacheKey)) {
    return externalLinkCache.get(cacheKey);
  }

  const candidates = [];
  const addCandidate = (url, source) => {
    const cleanUrl = sanitizeUrl(url);
    if (!cleanUrl) {
      return;
    }

    candidates.push({ url: cleanUrl, source });
  };

  addCandidate(file.href, "dom.href");
  addCandidate(file.externalLink, "dom.externalLink");

  const checkedCandidates = new Set();
  for (const candidate of candidates) {
    if (!candidate?.url || checkedCandidates.has(candidate.url)) {
      continue;
    }

    checkedCandidates.add(candidate.url);

    let probe;
    try {
      probe = await probeUrlFromBackground(candidate.url, "include");
    } catch (error) {
      console.warn(`${EXTENSION_CLASS}: probe failed`, candidate, error);
      continue;
    }

    console.debug(`${EXTENSION_CLASS}: probe`, {
      source: candidate.source,
      url: candidate.url,
      probe
    });

    if (isProbablyModelResponse(probe, file.extension)) {
      const launchUrl = probe.finalUrl || candidate.url;
      externalLinkCache.set(cacheKey, launchUrl);
      console.log(`${EXTENSION_CLASS}: Найдена рабочая ссылка на модель`, {
        source: candidate.source,
        status: probe.status,
        contentType: probe.contentType,
        contentDisposition: probe.contentDisposition
      });
      return launchUrl;
    }
  }

  throw new Error("DOM-ссылка Bitrix не отдала поддерживаемый файл модели.");
}

function isProbablyModelResponse(probe, extension) {
  if (!probe || ![200, 206].includes(Number(probe.status))) {
    return false;
  }

  if (isProbablyErrorResponse(probe)) {
    return false;
  }

  const ext = String(extension || "").toLowerCase();
  const contentType = String(probe.contentType || "").toLowerCase();
  const contentDisposition = String(probe.contentDisposition || "").toLowerCase();
  const finalUrl = String(probe.finalUrl || probe.requestedUrl || "").toLowerCase();
  const sampleText = String(probe.sampleText || "").trimStart();
  const lowerSample = sampleText.toLowerCase();

  if (ext && contentDisposition.includes(`.${ext}`)) {
    return true;
  }

  if ((ext === "step" || ext === "stp") && lowerSample.startsWith("iso-10303-21")) {
    return true;
  }

  if (ext === "stl" && lowerSample.startsWith("solid")) {
    return true;
  }

  if (ext === "obj" && looksLikeObjFile(lowerSample)) {
    return true;
  }

  if ((ext === "3mf" || ext === "lys" || ext === "lyt") && looksLikeZipFile(probe)) {
    return true;
  }

  if (ext === "glb" && looksLikeGlbFile(probe)) {
    return true;
  }

  if (
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/zip") ||
    contentType.includes("model/gltf-binary") ||
    contentType.includes("model/") ||
    contentType.includes("application/sla") ||
    contentType.includes("application/vnd")
  ) {
    return true;
  }

  return Boolean(ext === "stl" && finalUrlHasModelPath(finalUrl, ext) && looksLikeBinaryFile(probe));
}

function looksLikeObjFile(sampleText) {
  return (
    sampleText.startsWith("v ") ||
    sampleText.startsWith("o ") ||
    sampleText.startsWith("g ") ||
    sampleText.startsWith("#") ||
    sampleText.includes("\nv ") ||
    sampleText.includes("\nf ")
  );
}

function looksLikeZipFile(probe) {
  return String(probe?.sampleHex || "").toLowerCase().startsWith("50 4b");
}

function looksLikeGlbFile(probe) {
  return String(probe?.sampleText || "").startsWith("glTF");
}

function isProbablyHtmlResponse(probe) {
  const contentType = String(probe?.contentType || "").toLowerCase();
  const sampleText = String(probe?.sampleText || "").trimStart().toLowerCase();

  return (
    contentType.includes("text/html") ||
    sampleText.startsWith("<!doctype") ||
    sampleText.startsWith("<html") ||
    sampleText.includes("<head") ||
    sampleText.includes("<body") ||
    sampleText.includes("bitrix") ||
    sampleText.includes("bx.")
  );
}

function isProbablyErrorResponse(probe) {
  const contentType = String(probe?.contentType || "").toLowerCase();
  const sampleText = String(probe?.sampleText || "").trimStart().toLowerCase();

  return (
    isProbablyHtmlResponse(probe) ||
    contentType.includes("application/json") ||
    sampleText.startsWith("{") ||
    sampleText.startsWith("[") ||
    sampleText.includes('"status":"error"') ||
    sampleText.includes('"errors"') ||
    sampleText.includes("could not find configuration")
  );
}

function finalUrlHasModelPath(finalUrl, extension) {
  try {
    const url = new URL(finalUrl);
    return url.pathname.toLowerCase().endsWith(`.${extension}`);
  } catch {
    return finalUrl.split("?")[0].endsWith(`.${extension}`);
  }
}

function looksLikeBinaryFile(probe) {
  const text = String(probe?.sampleText || "");
  if (!text) {
    return false;
  }

  let suspiciousChars = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 0 || (code < 9 && code !== 7)) {
      suspiciousChars += 1;
    }
  }

  return suspiciousChars > 0;
}

function buildFooter(files, block) {
  const footer = document.createElement("div");
  footer.className = `${EXTENSION_CLASS}__footer`;

  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.className = `${EXTENSION_CLASS}__footer-button`;
  detailsButton.textContent = "Подробно";
  detailsButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openNativeCardsView(block);
  });

  const downloadAllButton = document.createElement("button");
  downloadAllButton.type = "button";
  downloadAllButton.className = `${EXTENSION_CLASS}__footer-button`;
  downloadAllButton.textContent = "Скачать всё";
  downloadAllButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await triggerNativeArchiveDownload(block, downloadAllButton);
  });

  footer.append(detailsButton, downloadAllButton);
  return footer;
}

function syncHeaderAction(block) {
  const headerButton = block.querySelector(".tasks-field-files-main");
  if (!headerButton || headerButton.dataset.b24FilesListBound === "true") {
    return;
  }

  headerButton.dataset.b24FilesListBound = "true";
  headerButton.addEventListener("click", () => {
    window.setTimeout(() => scheduleRender(), 250);
  });
}

function openNativeCardsView(block) {
  const nativeOpenControl =
    block.querySelector("[data-task-files-open]") ||
    block.querySelector(".tasks-field-files-main");

  if (nativeOpenControl instanceof HTMLElement) {
    nativeOpenControl.click();
    window.setTimeout(() => scheduleRender(), 300);
  }
}

async function downloadAllFiles(files, button) {
  return undefined;
}

async function triggerNativeArchiveDownload(block, button) {
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Скачиваю...";

  try {
    const archiveButton = await findArchiveDownloadButton(block, true);
    if (archiveButton instanceof HTMLElement) {
      archiveButton.click();
      closeNativeFilesSheet(block.dataset.taskId);
    }
  } finally {
    unhideNativeFilesSheet();
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

async function findArchiveDownloadButton(block, openSilently = false) {
  const taskId = block.dataset.taskId;
  const existingButton = queryArchiveDownloadButton(taskId);
  if (existingButton) {
    return existingButton;
  }

  if (openSilently) {
    hideNativeFilesSheet();
  }

  openNativeCardsView(block);
  return waitForArchiveDownloadButton(taskId, 2500);
}

function queryArchiveDownloadButton(taskId) {
  const scope = taskId
    ? `.tasks-field-files-sheet[data-task-id="${taskId}"]`
    : ".tasks-field-files-sheet";

  return document.querySelector(
    `${scope} [data-task-files-download-archive] button, ${scope} [data-task-files-download-archive]`
  );
}

function waitForArchiveDownloadButton(taskId, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const check = () => {
      const button = queryArchiveDownloadButton(taskId);
      if (button) {
        resolve(button);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(null);
        return;
      }

      window.setTimeout(check, 100);
    };

    check();
  });
}

function closeNativeFilesSheet(taskId) {
  const scope = taskId
    ? `.tasks-field-files-sheet[data-task-id="${taskId}"]`
    : ".tasks-field-files-sheet";
  const closeButton = document.querySelector(
    `${scope} [data-task-files-close], ${scope} .tasks-field-files-close`
  );

  if (closeButton instanceof HTMLElement) {
    window.setTimeout(() => closeButton.click(), 50);
  }
}

function hideNativeFilesSheet() {
  if (document.getElementById(HIDDEN_SHEET_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = HIDDEN_SHEET_STYLE_ID;
  style.textContent = `
    [class*="bottom-sheet"],
    .tasks-field-files-sheet,
    .tasks-field-files-sheet * {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
      transition: none !important;
      animation: none !important;
    }
  `;
  document.head.append(style);
}

function unhideNativeFilesSheet() {
  document.getElementById(HIDDEN_SHEET_STYLE_ID)?.remove();
}

function triggerNativeRemove(removeButton) {
  const targets = [removeButton, removeButton.firstElementChild].filter(Boolean);

  for (const target of targets) {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
      (eventName) => {
        target.dispatchEvent(
          new MouseEvent(eventName, {
            bubbles: true,
            cancelable: true,
            view: window
          })
        );
      }
    );
  }
}

function isDeletePending(fileKey) {
  const startedAt = pendingDeletes.get(fileKey);
  if (!startedAt) {
    return false;
  }

  if (Date.now() - startedAt > PENDING_DELETE_TTL) {
    pendingDeletes.delete(fileKey);
    return false;
  }

  return true;
}

function cleanupPendingDeletes() {
  for (const [fileKey, startedAt] of pendingDeletes.entries()) {
    if (Date.now() - startedAt > PENDING_DELETE_TTL) {
      pendingDeletes.delete(fileKey);
    }
  }
}
