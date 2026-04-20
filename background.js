chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'PROBE_URL') {
    probeUrl(request.url, request.credentials)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.type === 'DOWNLOAD_MODEL') {
    downloadModel(request.url, request.filename, request.extension)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.type === 'OPEN_IN_NATIVE_SLICER') {
    openInNativeSlicer(request.app, request.filename)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function probeUrl(url, credentials = 'omit') {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    credentials,
    headers: {
      Range: 'bytes=0-1023',
      Accept: '*/*'
    }
  });

  const buffer = await response.arrayBuffer();
  const sampleBytes = new Uint8Array(buffer.slice(0, 256));
  const sampleText = new TextDecoder('utf-8', { fatal: false }).decode(sampleBytes);

  return {
    requestedUrl: url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type') || '',
    contentDisposition: response.headers.get('content-disposition') || '',
    contentLength: response.headers.get('content-length') || '',
    sampleText,
    sampleHex: [...sampleBytes.slice(0, 16)]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join(' ')
  };
}

async function downloadModel(url, filename, extension) {
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: buildDownloadFilename(filename),
        conflictAction: 'uniquify',
        saveAs: false
      },
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (typeof id !== 'number') {
          reject(new Error('Download did not start'));
          return;
        }

        resolve(id);
      }
    );
  });

  const item = await waitForDownload(downloadId);
  await assertDownloadedModel(item, extension);
  return item;
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        if (chrome.runtime.lastError) {
          clearInterval(timer);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const item = items?.[0];
        if (!item) {
          return;
        }

        if (item.state === 'complete') {
          clearInterval(timer);
          resolve({
            id: downloadId,
            filename: item.filename,
            url: item.url,
            finalUrl: item.finalUrl || item.url,
            mime: item.mime || '',
            fileSize: item.fileSize || 0
          });
          return;
        }

        if (item.state === 'interrupted') {
          clearInterval(timer);
          reject(new Error(item.error || 'Download interrupted'));
          return;
        }

        if (Date.now() - startedAt > 120000) {
          clearInterval(timer);
          reject(new Error('Download timeout'));
        }
      });
    }, 300);
  });
}

function buildDownloadFilename(filename) {
  const safeName = String(filename || 'model.stl')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);

  return `Bitrix slicer/${safeName || 'model.stl'}`;
}

async function assertDownloadedModel(item, extension) {
  const ext = String(extension || item.filename.split('.').pop() || '').toLowerCase();
  const filename = String(item.filename || '').toLowerCase();
  const hasModelExtension = filename.endsWith('.stl') || filename.endsWith('.step') || filename.endsWith('.stp');

  if (
    item.mime === 'application/json' ||
    filename.endsWith('.json') ||
    item.mime === 'text/html' ||
    filename.endsWith('.html') ||
    filename.endsWith('.htm')
  ) {
    await removeDownloadedFile(item.id);
    throw new Error('Bitrix downloaded JSON/HTML instead of model');
  }

  if (!hasModelExtension || !['stl', 'step', 'stp'].includes(ext)) {
    await removeDownloadedFile(item.id);
    throw new Error('Downloaded file does not look like STL/STEP');
  }
}

function removeDownloadedFile(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.removeFile(downloadId, () => {
      chrome.downloads.erase({ id: downloadId }, () => resolve());
    });
  });
}

function openInNativeSlicer(app, filename) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      'b24_slicer_launcher',
      { app, filename },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || 'Native slicer launcher failed'));
          return;
        }

        resolve(response);
      }
    );
  });
}
