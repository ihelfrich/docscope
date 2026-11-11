# DocScope

> **Moved.** DocScope is now the Convert tool in [Scope](https://github.com/ihelfrich/scope) and lives at https://ihelfrich.github.io/scope/convert/. This repository is kept so old links redirect; development continues in `scope/convert/`.

A document-to-text converter and knowledge engine that runs entirely in the browser. Drop in a PDF, DOCX, EPUB, RTF, TXT, HTML, image, or (experimentally) MOBI, and get clean, correctly-ordered text back as `.txt`, `.md`, `.rtf`, or a text-searchable `.pdf`. Then full-text-search everything you've converted.

**Live:** https://ihelfrich.github.io/docscope

## Why it's built this way

GitHub Pages is static hosting. It cannot run a server, so there is no Go/Python backend doing the OCR. Everything happens client-side through WebAssembly. That is not a compromise here, it is the point:

- **Private by construction.** No file is ever uploaded. The bytes never leave your machine.
- **Free and infinitely scalable.** There is no server to pay for or to fall over under load.
- **Fast on the path that matters.** Born-digital extraction (PDF text layer, DOCX, EPUB, RTF) is instant and lossless.

## How each format is handled

| Input | Method | Fidelity |
|---|---|---|
| PDF (born-digital) | PDF.js text layer, with line reconstruction from glyph positions | lossless, instant |
| PDF (scanned) | auto-fallback to Tesseract OCR per page | good, OCR-limited |
| DOCX | Mammoth structural conversion, real Markdown output | high |
| EPUB | JSZip unpack, spine walked in reading order, markup stripped | high |
| RTF | control-word stripping with `\uN` / `\'hh` handling | high |
| HTML | DOM parse, block structure preserved as line breaks | high |
| Images (PNG/JPG/TIFF/…) | Tesseract OCR | OCR-limited |
| MOBI | experimental PalmDoc record extraction + LZ77 unpack | partial |

Output formats: **TXT**, **Markdown** (real structure for DOCX, heading heuristics for plain text), **RTF**, and a **searchable PDF** (selectable text layer via jsPDF).

## Honest limits

In-browser OCR is strong but it is not better than commercial cloud OCR (Google Document AI, AWS Textract, ABBYY) on messy or low-resolution scans. DocScope's edge is the born-digital path and privacy, not beating a data-center OCR model on a bad fax. MOBI is Amazon's proprietary format; the parser recovers PalmDoc text but not full layout, so convert MOBI to EPUB when you can.

## Stack

All client-side, loaded from CDN as UMD globals: PDF.js, Tesseract.js, Mammoth, JSZip, jsPDF, MiniSearch. No build step. Open `index.html` locally or serve the folder; it just works.

```
docscope/
├── index.html        UI
├── css/style.css
├── js/app.js         extractors + exporters + search index
├── .nojekyll
└── README.md
```

## Roadmap

- Searchable-PDF with an *invisible OCR text layer over the original page image* (true scan-to-searchable, not just text-to-PDF)
- Multi-language OCR (Tesseract supports 100+ traineddata packs)
- Web Worker pool so large batches don't block the UI
- Optional WASM module (Go or Rust) for faster RTF/MOBI parsing if profiling justifies it
- Vendored libraries for full offline / air-gapped use

## License

MIT.
