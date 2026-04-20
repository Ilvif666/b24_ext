(() => {
  const source = "b24-files-list-ext";

  function getRestClient() {
    if (window.BX24?.callMethod) {
      return window.BX24;
    }

    if (window.BX?.rest?.callMethod) {
      return window.BX.rest;
    }

    try {
      if (window.top && window.top !== window) {
        if (window.top.BX24?.callMethod) {
          return window.top.BX24;
        }

        if (window.top.BX?.rest?.callMethod) {
          return window.top.BX.rest;
        }
      }
    } catch (error) {
      // Ignore cross-origin frame access.
    }

    return null;
  }

  function postResponse(id, payload) {
    window.postMessage({ source, id, ...payload }, "*");
  }

  function unwrapResult(result) {
    if (result?.error?.()) {
      throw new Error(result.error());
    }

    if (typeof result?.data === "function") {
      return result.data();
    }

    if (typeof result?.getData === "function") {
      return result.getData().result;
    }

    return result;
  }

  async function waitForRestClient() {
    const existingClient = getRestClient();
    if (existingClient) {
      return existingClient;
    }

    if (window.BX?.Runtime?.loadExtension) {
      await window.BX.Runtime.loadExtension("rest.client");
    }

    const loadedClient = getRestClient();
    if (loadedClient) {
      return loadedClient;
    }

    throw new Error("Bitrix REST client is unavailable on this page");
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== source || event.data?.type !== "callMethod") {
      return;
    }

    const { id, method, params } = event.data;
    try {
      const client = await waitForRestClient();
      client.callMethod(method, params || {}, (result) => {
        try {
          postResponse(id, { ok: true, result: unwrapResult(result) });
        } catch (error) {
          postResponse(id, { ok: false, error: error.message || String(error) });
        }
      });
    } catch (error) {
      postResponse(id, { ok: false, error: error.message || String(error) });
    }
  });
})();
