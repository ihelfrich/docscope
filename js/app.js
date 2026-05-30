/* DocScope — client-side document-to-text engine.
   Everything here runs in the browser. No network calls except loading the
   WASM/JS libraries from the CDN. No file ever leaves the machine. */
(function () {
  "use strict";

  // pdf.js worker (UMD global `pdfjsLib`)
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  const $ = (s) => document.querySelector(s);
  const el = (s) => document.querySelectorAll(s);
  const docs = []; // {id,name,ext,text,bytesIn,status}
  let ocrWorker = null;
  let miniSearch = null;
  let active = null;

  // ---------- tabs ----------
  el(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      el(".tab").forEach((x) => x.classList.remove("active"));
      el(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("#" + t.dataset.tab).classList.add("active");
    })
  );

  // ---------- drop zone ----------
  const drop = $("#drop");
  const input = $("#fileInput");
  ["dragenter", "dragover"].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((e) =>
    drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("drag"); })
  );
  drop.addEventListener("drop", (ev) => handleFiles(ev.dataTransfer.files));
  input.addEventListener("change", () => handleFiles(input.files));

  function extOf(name) { return (name.split(".").pop() || "").toLowerCase(); }
  function iconFor(ext) {
    return ({ pdf: "▦", docx: "▤", epub: "❑", rtf: "✎", txt: "≣", md: "≣",
      mobi: "❑", png: "▣", jpg: "▣", jpeg: "▣", webp: "▣", tif: "▣", tiff: "▣" }[ext]) || "◍";
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    for (const f of files) {
      const doc = { id: "d" + Date.now() + Math.random().toString(36).slice(2, 6),
        name: f.name, ext: extOf(f.name), text: "", bytesIn: f.size, status: "wait" };
      docs.push(doc);
      renderQueue();
      try {
        setStatus(doc, "run", 0);
        doc.text = await convert(f, doc);
        doc.status = "done";
        setStatus(doc, "done");
        addToIndex(doc);
        if (!active) selectDoc(doc.id);
        $("#downloadAll").disabled = false;
      } catch (err) {
        console.error(err);
        doc.status = "err";
        doc.error = (err && err.message) || String(err);
        setStatus(doc, "err");
      }
      renderQueue();
    }
  }

  // ---------- dispatch ----------
  async function convert(file, doc) {
    const buf = await file.arrayBuffer();
    switch (doc.ext) {
      case "pdf": return await extractPDF(buf, doc);
      case "docx": return await extractDOCX(buf);
      case "epub": return await extractEPUB(buf);
      case "rtf": return deRTF(new TextDecoder().decode(buf));
      case "txt":
      case "md": return new TextDecoder().decode(buf);
      case "htm":
      case "html": return stripHTML(new TextDecoder().decode(buf));
      case "mobi": return await extractMOBI(buf);
      case "png": case "jpg": case "jpeg": case "webp":
      case "bmp": case "tif": case "tiff": return await ocrImage(file, doc);
      default: throw new Error("Unsupported type: ." + doc.ext);
    }
  }

  // ---------- PDF ----------
  async function extractPDF(buf, doc) {
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const forceOCR = $("#forceOCR").checked;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      let text = "";
      if (!forceOCR) text = reconstructLines(await page.getTextContent());
      if (forceOCR || text.replace(/\s/g, "").length < 8) {
        text = await ocrPage(page);
      }
      out.push(text.trim());
      setStatus(doc, "run", p / pdf.numPages);
    }
    return out.join("\n\n");
  }

  // group text items into lines using their y-position, then x-order
  function reconstructLines(content) {
    const items = content.items.filter((i) => i.str !== undefined);
    if (!items.length) return "";
    const rows = [];
    let cur = [], lastY = null;
    for (const it of items) {
      const y = it.transform[5];
      if (lastY === null) lastY = y;
      if (Math.abs(y - lastY) > 3) { rows.push(cur); cur = []; lastY = y; }
      cur.push(it);
    }
    if (cur.length) rows.push(cur);
    return rows
      .map((r) => r.sort((a, b) => a.transform[4] - b.transform[4])
        .map((i) => i.str).join("").replace(/\s+/g, " ").trim())
      .filter((l) => l.length)
      .join("\n");
  }

  async function ocrPage(page) {
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const w = await getOCR();
    const { data } = await w.recognize(canvas);
    return data.text;
  }

  async function ocrImage(file, doc) {
    setStatus(doc, "run", 0.1);
    const w = await getOCR();
    const { data } = await w.recognize(file);
    setStatus(doc, "run", 1);
    return data.text;
  }

  async function getOCR() {
    if (ocrWorker) return ocrWorker;
    $("#engineStatus").textContent = "loading OCR engine…";
    ocrWorker = await Tesseract.createWorker("eng", 1, {
      logger: (m) => { if (m.status) $("#engineStatus").textContent = m.status + " " + Math.round((m.progress || 0) * 100) + "%"; },
    });
    $("#engineStatus").textContent = "ready";
    return ocrWorker;
  }

  // ---------- DOCX ----------
  async function extractDOCX(buf) {
    const fmt = $("#outFormat").value;
    if (fmt === "md") {
      const r = await mammoth.convertToMarkdown({ arrayBuffer: buf });
      return r.value;
    }
    const r = await mammoth.extractRawText({ arrayBuffer: buf });
    return r.value;
  }

  // ---------- EPUB ----------
  async function extractEPUB(buf) {
    const zip = await JSZip.loadAsync(buf);
    // find the OPF via META-INF/container.xml
    const containerXml = await zip.file("META-INF/container.xml").async("string");
    const opfPath = new DOMParser().parseFromString(containerXml, "application/xml")
      .querySelector("rootfile").getAttribute("full-path");
    const baseDir = opfPath.includes("/") ? opfPath.replace(/[^/]+$/, "") : "";
    const opfXml = await zip.file(opfPath).async("string");
    const opf = new DOMParser().parseFromString(opfXml, "application/xml");
    // manifest id -> href
    const hrefById = {};
    opf.querySelectorAll("manifest > item").forEach((i) =>
      (hrefById[i.getAttribute("id")] = i.getAttribute("href")));
    // spine order
    const order = [...opf.querySelectorAll("spine > itemref")].map((i) => i.getAttribute("idref"));
    const parts = [];
    for (const id of order) {
      const href = hrefById[id];
      if (!href) continue;
      const f = zip.file(baseDir + href) || zip.file(href);
      if (!f) continue;
      parts.push(stripHTML(await f.async("string")));
    }
    return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function stripHTML(html) {
    const dom = new DOMParser().parseFromString(html, "text/html");
    dom.querySelectorAll("script,style,head").forEach((n) => n.remove());
    // keep block structure as line breaks
    dom.querySelectorAll("p,div,br,li,h1,h2,h3,h4,h5,h6,tr").forEach((n) => n.append("\n"));
    return (dom.body ? dom.body.textContent : dom.textContent)
      .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---------- RTF ----------
  function deRTF(rtf) {
    let s = rtf;
    s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((parseInt(n, 10) + 65536) % 65536));
    s = s.replace(/\\par[d]?\b/g, "\n").replace(/\\line\b/g, "\n").replace(/\\tab\b/g, "\t");
    s = s.replace(/\{\\\*[^{}]*\}/g, "");            // delete groups like {\*\... }
    s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, "");        // control words
    s = s.replace(/[{}]/g, "");                       // group braces
    return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---------- MOBI (experimental: PalmDoc text records) ----------
  async function extractMOBI(buf) {
    try {
      const dv = new DataView(buf);
      const td = new TextDecoder("utf-8");
      const numRecs = dv.getUint16(76); // PDB record count
      const offsets = [];
      for (let i = 0; i < numRecs; i++) offsets.push(dv.getUint32(78 + i * 8));
      offsets.push(buf.byteLength);
      // record 0 holds PalmDOC header: compression at byte 0, record count at 8
      const r0 = new DataView(buf, offsets[0], offsets[1] - offsets[0]);
      const compression = r0.getUint16(0); // 1=none, 2=PalmDOC LZ77
      const textRecs = r0.getUint16(8);
      let out = "";
      for (let i = 1; i <= textRecs && i < offsets.length - 1; i++) {
        const slice = new Uint8Array(buf, offsets[i], offsets[i + 1] - offsets[i]);
        out += compression === 2 ? td.decode(palmDocUnpack(slice)) : td.decode(slice);
      }
      out = stripHTML(out);
      if (out.replace(/\s/g, "").length < 20)
        throw new Error("no readable text recovered");
      return out + "\n\n[DocScope note: MOBI support is experimental. For full fidelity convert to EPUB.]";
    } catch (e) {
      throw new Error("MOBI parse failed (" + e.message + "). Convert this file to EPUB and retry.");
    }
  }

  // PalmDOC LZ77 decompressor
  function palmDocUnpack(input) {
    const out = [];
    let i = 0;
    while (i < input.length) {
      const b = input[i++];
      if (b === 0) out.push(0);
      else if (b <= 8) { for (let j = 0; j < b; j++) out.push(input[i++]); }
      else if (b <= 0x7f) out.push(b);
      else if (b <= 0xbf) {
        const b2 = input[i++];
        let dist = ((b << 8) | b2) & 0x3fff;
        dist >>= 3;
        let len = (b2 & 0x07) + 3;
        let start = out.length - dist;
        for (let j = 0; j < len; j++) out.push(out[start + j]);
      } else { out.push(32); out.push(b ^ 0x80); }
    }
    return new Uint8Array(out);
  }

  // ---------- queue + preview ----------
  function renderQueue() {
    const q = $("#queue");
    q.innerHTML = "";
    docs.forEach((d) => {
      const li = document.createElement("li");
      li.className = "qitem";
      li.dataset.id = d.id;
      li.innerHTML =
        `<span class="qicon">${iconFor(d.ext)}</span>
         <div class="qmeta">
           <div class="qname">${escapeHTML(d.name)}</div>
           <div class="qsub">${fmtBytes(d.bytesIn)}${d.text ? " → " + wordCount(d.text) + " words" : ""}${d.error ? " · " + escapeHTML(d.error) : ""}</div>
           <div class="bar"><i id="bar-${d.id}"></i></div>
         </div>
         <span class="qstatus s-${d.status}" id="st-${d.id}">${statusLabel(d.status)}</span>`;
      li.addEventListener("click", () => d.text && selectDoc(d.id));
      q.appendChild(li);
    });
  }
  function statusLabel(s) { return { wait: "queued", run: "working", done: "done", err: "error" }[s] || s; }
  function setStatus(doc, s, prog) {
    doc.status = s;
    const st = $("#st-" + doc.id), bar = $("#bar-" + doc.id);
    if (st) { st.textContent = statusLabel(s); st.className = "qstatus s-" + s; }
    if (bar && prog != null) bar.style.width = Math.round(prog * 100) + "%";
  }

  function selectDoc(id) {
    active = docs.find((d) => d.id === id);
    if (!active) return;
    $("#previewWrap").classList.remove("hidden");
    $("#previewName").textContent = active.name;
    const out = render(active);
    $("#preview").value = typeof out === "string" ? out : "[binary export — use Download]";
    const bytesOut = new Blob([typeof out === "string" ? out : ""]).size;
    const ratio = active.bytesIn ? Math.round((bytesOut / active.bytesIn) * 100) : 100;
    $("#previewStats").textContent =
      `${wordCount(active.text)} words · ${fmtBytes(bytesOut)} out · ${ratio}% of source`;
  }

  // ---------- exporters ----------
  function cleanText(t) {
    if (!$("#normalizeWS").checked) return t;
    return t.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function render(doc) {
    const fmt = $("#outFormat").value;
    const text = cleanText(doc.text);
    if (fmt === "txt") return text;
    if (fmt === "md") return doc.ext === "docx" ? text : toMarkdown(text);
    if (fmt === "rtf") return toRTF(text);
    if (fmt === "pdf") return text; // binary built at download time
    return text;
  }
  function toMarkdown(text) {
    // light heuristics: ALL-CAPS or short Title lines on their own become headings
    return text.split("\n").map((l) => {
      const t = l.trim();
      if (!t) return "";
      if (t.length < 80 && /^[A-Z0-9][A-Z0-9 \-:']+$/.test(t)) return "## " + titleCase(t);
      return t;
    }).join("\n\n").replace(/\n{3,}/g, "\n\n");
  }
  function titleCase(s) { return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); }
  function toRTF(text) {
    const body = text
      .replace(/[\\{}]/g, (m) => "\\" + m)
      .replace(/\r?\n/g, "\\par\n")
      .replace(/[-￿]/g, (c) => "\\u" + c.charCodeAt(0) + "?");
    return "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\fs22\n" + body + "\n}";
  }
  function buildPDF(text) {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "letter" });
    const margin = 54, width = pdf.internal.pageSize.getWidth() - margin * 2;
    const height = pdf.internal.pageSize.getHeight() - margin * 2;
    pdf.setFont("helvetica", "normal").setFontSize(11);
    const lines = pdf.splitTextToSize(text, width);
    let y = margin;
    for (const line of lines) {
      if (y > height + margin) { pdf.addPage(); y = margin; }
      pdf.text(line, margin, y);
      y += 15;
    }
    return pdf.output("blob");
  }

  function downloadDoc(doc) {
    const fmt = $("#outFormat").value;
    const base = doc.name.replace(/\.[^.]+$/, "");
    if (fmt === "pdf") return saveBlob(buildPDF(cleanText(doc.text)), base + ".txt.pdf");
    const map = { txt: ["text/plain", ".txt"], md: ["text/markdown", ".md"], rtf: ["application/rtf", ".rtf"] };
    const [mime, ext] = map[fmt];
    saveBlob(new Blob([render(doc)], { type: mime }), base + ext);
  }
  function saveBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  $("#downloadOne").addEventListener("click", () => active && downloadDoc(active));
  $("#downloadAll").addEventListener("click", () => docs.filter((d) => d.text).forEach(downloadDoc));
  $("#copyText").addEventListener("click", () => {
    if (active) navigator.clipboard.writeText($("#preview").value);
  });
  ["outFormat", "normalizeWS"].forEach((id) =>
    $("#" + id).addEventListener("change", () => active && selectDoc(active.id)));

  // ---------- knowledge engine ----------
  function ensureIndex() {
    if (miniSearch) return;
    miniSearch = new MiniSearch({
      fields: ["name", "text"], storeFields: ["name", "text"],
      searchOptions: { boost: { name: 2 }, fuzzy: 0.15, prefix: true },
    });
  }
  function addToIndex(doc) {
    ensureIndex();
    miniSearch.add({ id: doc.id, name: doc.name, text: doc.text });
    $("#searchBox").disabled = false;
    $("#searchStatus").textContent = docs.filter((d) => d.text).length + " document(s) indexed.";
  }
  $("#searchBox").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    const ul = $("#searchResults");
    ul.innerHTML = "";
    if (!q || !miniSearch) return;
    const hits = miniSearch.search(q).slice(0, 25);
    $("#searchStatus").textContent = hits.length + " match(es).";
    hits.forEach((h) => {
      const li = document.createElement("li");
      li.className = "ritem";
      li.innerHTML = `<h4>${escapeHTML(h.name)}</h4><div class="snippet">${snippet(h.text, q)}</div>`;
      ul.appendChild(li);
    });
  });
  function snippet(text, q) {
    const term = q.split(/\s+/)[0];
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    const start = Math.max(0, idx - 80);
    let frag = (idx < 0 ? text.slice(0, 200) : text.slice(start, start + 200));
    frag = escapeHTML(frag);
    const re = new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    return (start > 0 ? "…" : "") + frag.replace(re, "<mark>$1</mark>") + "…";
  }

  // ---------- utils ----------
  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }
  function wordCount(t) { return (t.trim().match(/\S+/g) || []).length; }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
