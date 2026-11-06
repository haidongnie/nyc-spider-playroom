// The first request matches the HTML preload exactly. A broken HTTP/2 response
// can fail after headers have arrived, so the timeout covers reading the body.
const attemptLimits = [30_000, 40_000, 55_000];
const stallLimits = [8_000, 10_000, 14_000];
const retryDelays = [450, 1_300];
const lifetime = new AbortController();
window.addEventListener('pagehide', event => {
  if (!event.persisted) lifetime.abort();
});

function reportRetry(url, attempt, finished = false, recovered = false) {
  window.dispatchEvent(new CustomEvent('nyc-asset-retry', {
    detail: {url: url.href, attempt, total: attemptLimits.length, finished, recovered}
  }));
}

function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', cancel, {once:true});
  });
}

async function readAttempt(original, attempt, signal) {
  const url = new URL(original);
  if (attempt) url.searchParams.set('_nyc_retry', attempt + '-' + Date.now().toString(36));
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  const expire = () => controller.abort(new DOMException('Asset transfer timed out', 'TimeoutError'));
  let idleTimer;
  const progress = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(expire, stallLimits[attempt]);
  };
  const deadline = setTimeout(expire, attemptLimits[attempt]);
  signal.addEventListener('abort', cancel, {once:true});
  try {
    if (signal.aborted) throw signal.reason;
    progress();
    const response = await fetch(url, {
      signal:controller.signal, cache:attempt ? 'no-store' : 'default'
    });
    if (!response.ok) {
      controller.abort();
      const error = new Error('HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    progress();
    const body = response.body?.pipeThrough(new TransformStream({
      transform(chunk, output) { progress(); output.enqueue(chunk); }
    }));
    const bytes = new Uint8Array(await (body ? new Response(body).arrayBuffer() : response.arrayBuffer()));
    if (!bytes.length) throw Error('Empty asset response');
    return bytes;
  } finally {
    clearTimeout(deadline);
    clearTimeout(idleTimer);
    signal.removeEventListener('abort', cancel);
  }
}

async function unpack(bytes) {
  // Some static hosts remove gzip's wrapper via Content-Encoding automatically.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// decode runs inside the retry boundary, so corrupt gzip, JSON, or file headers
// receive the same bounded recovery as truncated network transfers.
export async function loadGameAsset(resource, decode = bytes => bytes, externalSignal) {
  const url = new URL(resource, document.baseURI);
  if (url.origin !== location.origin) throw Error('Expected a same-origin game asset.');
  const scope = new AbortController();
  const signals = externalSignal ? [lifetime.signal, externalSignal] : [lifetime.signal];
  const cancel = event => scope.abort(event.target.reason);
  for (const parent of signals) {
    if (parent.aborted) scope.abort(parent.reason);
    else parent.addEventListener('abort', cancel, {once:true});
  }
  const signal = scope.signal;
  let lastError;
  let retrying = false, recovered = false;
  try {
    for (let attempt = 0; attempt < attemptLimits.length; attempt++) {
      if (signal.aborted) throw signal.reason;
      if (attempt) {
        retrying = true;
        reportRetry(url, attempt + 1);
        await waitForRetry(retryDelays[attempt - 1], signal);
      }
      try {
        const bytes = await unpack(await readAttempt(url, attempt, signal));
        const result = await decode(bytes);
        recovered = true;
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
        // Recover a stale missing-file cache once. Authentication failures and
        // other permanent client errors should reach the existing Retry button.
        if (error.status >= 400 && error.status < 500 &&
          ![408,425,429].includes(error.status) && !(error.status === 404 && attempt === 0)) break;
      }
    }
    throw new Error('Could not load ' + url.pathname + ': ' + lastError.message, {cause:lastError});
  } finally {
    for (const parent of signals) parent.removeEventListener('abort', cancel);
    if (retrying) reportRetry(url, 0, true, recovered);
  }
}
