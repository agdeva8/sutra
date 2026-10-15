/**
 * Upload transport, with progress.
 *
 * `fetch` cannot report upload progress — only the response body is a stream — so both routes below
 * use XMLHttpRequest, which fires `progress` while the request body is still being written.
 *
 * Deliberately imports nothing from `api.js`: the compose step (ask the server where the bytes go,
 * then record the row) lives there, and this module is the transport it drives. Keeping the
 * dependency one-way is what stops the two from becoming a cycle.
 */

/** PUT the bytes straight to a signed object-store URL. */
export function putToUrl(url, file, onProgress, contentType) {
  return xhrSend({
    method: "PUT",
    url,
    body: file,
    onProgress,
    headers: {
      // The store reads these, not the API: it needs the type to serve the object back correctly, and
      // `x-upsert` so re-uploading the same name overwrites rather than 409s.
      "Content-Type": contentType || file.type || "application/octet-stream",
      "x-upsert": "true",
    },
  });
}

/** Post a file through the API — for a deployment with no object store to sign for. */
export function postFile(url, file, fields, onProgress) {
  const form = new FormData();
  form.append("file", file);
  for (const [name, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null) form.append(name, String(value));
  }
  return xhrSend({ method: "POST", url, body: form, onProgress, headers: {} });
}

function xhrSend({ method, url, body, onProgress, headers }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.withCredentials = true; // the API is session-cookie authed; the store ignores it
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    // `lengthComputable` is false until the browser knows the body length. Reporting a percentage then
    // would be inventing it, so those events are dropped and the row goes on saying "Uploading…".
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve(parseJson(xhr.responseText));
      } else {
        reject(new Error(problemFrom(xhr) || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error — the upload didn't go through."));
    xhr.ontimeout = () => reject(new Error("The upload took too long and was stopped."));
    xhr.send(body);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The server's own sentence, from either the API's `detail` or the store's `message`. */
function problemFrom(xhr) {
  const body = parseJson(xhr.responseText);
  return body?.detail || body?.message || body?.error || "";
}
