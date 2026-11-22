// The browser's PUT of a file to its signed URL (R2, or the dev route in development). An
// XMLHttpRequest rather than fetch: only it reports upload progress. The Content-Type must be the
// one the URL was signed for; the browser sets Content-Length from the file.

/**
 * Resolves true on a 2xx answer, false on any other status, a network error or an abort
 * (`signal`: the teacher cancelled or left the page).
 */
export function putFile(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const request = new XMLHttpRequest();
    const abort = () => {
      request.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const done = (sent: boolean) => {
      signal?.removeEventListener("abort", abort);
      resolve(sent);
    };
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.floor((event.loaded / event.total) * 100)));
      }
    };
    request.onload = () => {
      done(request.status >= 200 && request.status < 300);
    };
    request.onerror = () => {
      done(false);
    };
    request.onabort = () => {
      done(false);
    };
    request.send(file);
  });
}
