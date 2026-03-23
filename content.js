const EXTENSION_CLASS = "b24-files-list-ext";
const BLOCK_SELECTOR = '.tasks-field-files[data-task-field-id="fileIds"]';
const LIST_SELECTOR = ".tasks-field-files-list";
const REPLACEMENT_SELECTOR = '[data-b24-files-list="replacement"]';

let renderTimer = null;
let mutationObserver = null;
let urlWatcherTimer = null;
let lastHandledUrl = "";
let routeHooksInstalled = false;

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
      if (mutation.type !== "childList") {
        continue;
      }

      if ([...mutation.addedNodes].some(shouldTriggerRender)) {
        scheduleRender();
        return;
      }
    }
  });

  mutationObserver.observe(document.body, {
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

  document.querySelectorAll(BLOCK_SELECTOR).forEach(renderBlock);
}

function renderBlock(block) {
  const listHost = block.querySelector(LIST_SELECTOR);
  if (!listHost) {
    return;
  }

  const files = collectFiles(block);
  if (!files.length) {
    return;
  }

  const replacement = ensureReplacement(listHost);
  const list = document.createElement("ol");
  list.className = `${EXTENSION_CLASS}__list`;

  for (const file of files) {
    list.append(buildListItem(file));
  }

  replacement.replaceChildren(list);
  block.classList.add(`${EXTENSION_CLASS}--active`);

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
  const tileNodes = block.querySelectorAll(".ui-tile-uploader-item-preview-content");

  tileNodes.forEach((tile) => {
    const file = extractFileFromTile(tile);
    if (file) {
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

function extractFileFromTile(tile) {
  const href = sanitizeUrl(
    tile.dataset.src || tile.querySelector("a[href]")?.getAttribute("href")
  );
  if (!href) {
    return null;
  }

  const title =
    normalizeText(tile.dataset.title) ||
    normalizeText(tile.querySelector(".ui-tile-uploader-item-name-box")?.title) ||
    buildTitleFromChunks(tile) ||
    "Без названия";

  return toFileRecord(title, href);
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

  return toFileRecord(title, href);
}

function buildTitleFromChunks(tile) {
  const name = normalizeText(
    tile.querySelector(".ui-tile-uploader-item-name-title")?.textContent
  );
  const extension = normalizeText(
    tile.querySelector(".ui-tile-uploader-item-name-extension")?.textContent
  );

  return `${name}${extension}`.trim();
}

function toFileRecord(title, href) {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) {
    return null;
  }

  return {
    key: `${href}::${normalizedTitle}`,
    title: normalizedTitle,
    href,
    extension: getExtension(normalizedTitle)
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

function buildListItem(file) {
  const item = document.createElement("li");
  item.className = `${EXTENSION_CLASS}__item`;

  const extension = document.createElement("span");
  extension.className = `${EXTENSION_CLASS}__badge`;
  extension.textContent = file.extension;

  const link = document.createElement("a");
  link.className = `${EXTENSION_CLASS}__link`;
  link.href = file.href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = file.title;

  item.append(extension, link);

  return item;
}
