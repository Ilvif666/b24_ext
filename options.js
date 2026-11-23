const FILES_LIST_SETTING = "filesListEnabled";
const checkbox = document.getElementById("files-list");

chrome.storage.sync
  .get({ [FILES_LIST_SETTING]: false })
  .then((values) => {
    checkbox.checked = Boolean(values[FILES_LIST_SETTING]);
  })
  .catch(() => {});

checkbox.addEventListener("change", () => {
  chrome.storage.sync.set({ [FILES_LIST_SETTING]: checkbox.checked });
});
