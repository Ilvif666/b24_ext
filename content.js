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
const PENDING_DELETE_TTL = 10000;
const HIDDEN_SHEET_STYLE_ID = "b24-files-list-hidden-sheet-style";

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
    previewContent?.dataset.src || tileItem.querySelector("a[href]")?.getAttribute("href")
  );

  const title =
    normalizeText(previewContent?.dataset.title) ||
    normalizeText(tileItem.querySelector(".ui-tile-uploader-item-name-box")?.title) ||
    buildTitleFromChunks(tileItem) ||
    "Без названия";

  const removeButton = tileItem?.querySelector(".ui-tile-uploader-item-remove");
  const isComplete = tileItem.classList.contains("ui-tile-uploader-item--complete");

  return toFileRecord(title, href, removeButton, isComplete ? "ready" : "uploading");
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

function toFileRecord(title, href, removeButton, status) {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) {
    return null;
  }

  return {
    key: `${href}::${normalizedTitle}`,
    title: normalizedTitle,
    href,
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

  item.append(extension, titleNode, actions);

  return item;
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
