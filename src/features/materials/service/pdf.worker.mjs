// Ruling R10: the worker thread that parses an untrusted PDF (started by pdf-worker.ts and
// pdf-text.ts with heap limits and a hard timeout). Plain JavaScript so Node runs it as is, in
// tests and in the Next.js server bundle. One operation per worker; it posts exactly one message
// and ends.
//   op "inspect": { status: "ok", pages } | { status: "encrypted" } | { status: "damaged" }
//   op "text" (from, to, maxChars): { status: "ok", pages, texts } with the text layer of pages
//     from..min(to, pages), each cut at maxChars | { status: "encrypted" } | { status: "damaged" }
import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

async function withDocument(bytes, read) {
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes, { verbosity: 0 });
    // Reads only the trailer's /Encrypt dictionary. Never call getMetadata: it inflates the XMP
    // stream without a limit.
    const permissions = await pdf.getPermissions();
    if (permissions !== null) return { status: "encrypted" };
    return await read(pdf);
  } catch (error) {
    // A user password is needed to open it at all.
    if (error && error.name === "PasswordException") return { status: "encrypted" };
    return { status: "damaged" };
  } finally {
    try {
      await pdf?.loadingTask.destroy();
    } catch {
      // The worker ends anyway.
    }
  }
}

function inspect(bytes) {
  return withDocument(bytes, (pdf) => ({ status: "ok", pages: pdf.numPages }));
}

// numPages is pdf.js's page count (the page tree's /Count, or the pages it actually found when
// that count is broken); getPage never goes past it, and the caller never asks past page 300.
function text(bytes, from, to, maxChars) {
  return withDocument(bytes, async (pdf) => {
    const texts = [];
    const last = Math.min(to, pdf.numPages);
    for (let pageNo = from; pageNo <= last; pageNo += 1) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      let out = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        out += item.str;
        if (item.hasEOL) out += "\n";
        if (out.length > maxChars) break;
      }
      texts.push(out.slice(0, maxChars));
      page.cleanup();
    }
    return { status: "ok", pages: pdf.numPages, texts };
  });
}

const bytes = new Uint8Array(workerData.bytes);
let answer;
if (workerData.op === "inspect") answer = await inspect(bytes);
else if (workerData.op === "text") {
  answer = await text(bytes, workerData.from, workerData.to, workerData.maxChars);
} else answer = { status: "damaged" };
parentPort.postMessage(answer);
