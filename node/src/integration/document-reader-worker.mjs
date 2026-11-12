import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { createRequire } from 'node:module';

const { limits, format } = workerData;
const data = Buffer.from(workerData.data);
const require = createRequire(import.meta.url);

async function inspectDocx() {
  const { default: yauzl } = await import('yauzl');
  const archive = await yauzl.fromBufferPromise(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  let entries = 0, declaredBytes = 0, actualBytes = 0, documentFound = false;
  const names = new Set();
  try {
    for await (const entry of archive.eachEntry()) {
      if (++entries > limits.zipEntries) throw new Error('DOCX 内部文件超过 2048 个。');
      const name = entry.fileName;
      if (names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..')) throw new Error('DOCX 包含无效或重复的内部路径。');
      names.add(name);
      if (entry.generalPurposeBitFlag & 1) throw new Error('不能读取加密 DOCX。');
      declaredBytes += entry.uncompressedSize;
      if (entry.uncompressedSize > limits.zipEntryBytes || declaredBytes > limits.zipExpandedBytes) throw new Error('DOCX 解压大小超过限制（单项 8 MiB、总计 32 MiB）。');
      if (name === 'word/document.xml') documentFound = true;
      if (name.endsWith('/')) continue;
      // Validate actual sizes before Mammoth decompresses; do not extract to disk.
      const stream = await archive.openReadStreamPromise(entry);
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length; actualBytes += chunk.length;
        if (size > limits.zipEntryBytes || actualBytes > limits.zipExpandedBytes) {
          stream.destroy(); throw new Error('DOCX 实际解压大小超过限制。');
        }
      }
      if (size !== entry.uncompressedSize) throw new Error('DOCX 内部文件长度不一致。');
    }
    if (!documentFound) throw new Error('此文件不是有效 DOCX：缺少 word/document.xml。');
  } finally { archive.close(); }
}

async function readDocx() {
  await inspectDocx();
  const { default: mammoth } = await import('mammoth');
  // Raw extraction does not execute macros, load images or dereference links.
  const result = await mammoth.extractRawText({ buffer: data });
  const content = result.value.replaceAll('\0', '').slice(0, limits.textCharacters);
  return { content, format: 'docx', text_truncated: result.value.length > limits.textCharacters,
    extraction: 'local-text', note: '提取 DOCX 正文文本；不含图片、宏或附件，表格按文档顺序展开。' };
}

async function readPdf() {
  if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('此文件没有有效 PDF 标识。');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bundled = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const loading = getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false, disableFontFace: true, useSystemFonts: false,
    cMapUrl: path.join(bundled, 'cmaps').replaceAll('\\', '/') + '/',
    standardFontDataUrl: path.join(bundled, 'standard_fonts').replaceAll('\\', '/') + '/',
    cMapPacked: true, verbosity: 0,
  });
  try {
    const doc = await loading.promise;
    if (doc.numPages > limits.pdfPages) throw new Error('PDF 超过 200 页，请拆分后导入。');
    const pages = [], chunks = [];
    let length = 0, truncated = false, textPages = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const reader = page.streamTextContent({ disableNormalization: false }).getReader();
      const parts = []; let pageLength = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const text = item.str + (item.hasEOL ? '\n' : ' ');
            const remaining = limits.textCharacters - length - pageLength - 40;
            if (remaining <= 0) { truncated = true; break; }
            parts.push(text.slice(0, remaining)); pageLength += Math.min(text.length, remaining);
            if (text.length > remaining) { truncated = true; break; }
          }
          if (truncated) { await reader.cancel(); break; }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      const text = parts.join('').trim();
      if (text) textPages++;
      const section = `\n--- PDF 第 ${number} 页 ---\n${text || '[本页没有可提取文本，可能为扫描图片；当前未执行 OCR。]'}\n`;
      pages.push({ page: number, offset: length, characters: section.length, has_text: Boolean(text) });
      chunks.push(section); length += section.length;
      if (truncated || length >= limits.textCharacters) { truncated = true; break; }
    }
    return { content: chunks.join('').replaceAll('\0', '').slice(0, limits.textCharacters), format: 'pdf', pages,
      page_count: doc.numPages, text_pages: textPages, text_truncated: truncated, extraction: 'local-text',
      note: '提取 PDF 文字层并保留页码；图片、二维码和示意图未做 OCR，不执行 PDF 脚本或打开附件。' };
  } finally { await loading.destroy(); }
}

try {
  parentPort.postMessage(await (format === '.docx' ? readDocx() : readPdf()));
} catch (error) {
  // Parser diagnostics may contain document contents; expose only known limit
  // and format errors, not native stacks or arbitrary document-derived text.
  const message = String(error?.message ?? '');
  const safe = /^(DOCX |PDF 超过|不能读取加密|此文件)/.test(message)
    ? message : error?.name === 'PasswordException' ? 'PDF 已加密，需要先导入未加密副本。' : '文档格式损坏或暂不支持，无法提取正文。';
  parentPort.postMessage({ error: safe });
}
