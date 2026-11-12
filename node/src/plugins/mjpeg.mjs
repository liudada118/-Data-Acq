import { MAX_FRAME_BYTES } from './contract.mjs';

export const MAX_JPEG_PREVIEW_BYTES = 2 * 1024 * 1024;
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Structural inspection only, without decoding, rewriting or discarding original SDK bytes. */
export function inspectJpeg(payload, { width, height, maxDecodedBytes = MAX_FRAME_BYTES } = {}) {
  const bytes = payload instanceof Uint8Array ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : Buffer.alloc(0);
  const result = { status: 'ok', issues: [], width: null, height: null, preview_allowed: true, decoder_verified: false, byte_length: bytes.length, trailing_bytes: 0 };
  const issue = (code, invalid = true) => {
    if (!result.issues.includes(code)) result.issues.push(code);
    if (invalid) { result.status = 'invalid'; result.preview_allowed = false; }
    else if (result.status === 'ok') result.status = 'warning';
  };
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES) { issue('jpeg_size_out_of_bounds'); return result; }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) { issue('missing_soi'); return result; }
  let offset = 2, entropy = false, sawScan = false, sawEnd = false, markers = 0, searches = 0;
  while (offset < bytes.length) {
    // Bound work even on hostile/corrupt buffers consisting entirely of markers.
    if (++searches > 262144) { issue('jpeg_inspection_limit'); break; }
    let markerAt = bytes.indexOf(0xff, offset);
    if (markerAt < 0) break;
    if (!entropy && markerAt !== offset) issue('extraneous_marker_bytes', false);
    let cursor = markerAt + 1;
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor++;
    if (cursor >= bytes.length) break;
    const marker = bytes[cursor++];
    offset = cursor;
    if (entropy && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
    entropy = false;
    if (marker === 0xd9) { sawEnd = true; result.trailing_bytes = bytes.length - cursor; break; }
    if (marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) { issue('unexpected_marker'); break; }
    if (marker === 0x01) continue; // TEM is a standalone marker.
    if (++markers > 4096) { issue('jpeg_inspection_limit'); break; }
    if (cursor + 2 > bytes.length) { issue('truncated_segment'); break; }
    const length = bytes.readUInt16BE(cursor), end = cursor + length;
    if (length < 2 || end > bytes.length) { issue('truncated_segment'); break; }
    if (SOF.has(marker)) {
      if (length < 8) { issue('invalid_sof'); break; }
      const components = bytes[cursor + 7], observedHeight = bytes.readUInt16BE(cursor + 3), observedWidth = bytes.readUInt16BE(cursor + 5);
      if (length !== 8 + 3 * components || !components || !observedWidth || !observedHeight) { issue('invalid_sof'); break; }
      if (result.width !== null && (result.width !== observedWidth || result.height !== observedHeight)) issue('conflicting_dimensions');
      result.width = observedWidth; result.height = observedHeight;
      if (observedWidth * observedHeight * 3 > maxDecodedBytes) issue('decoded_image_too_large');
      if (width !== undefined && width !== observedWidth || height !== undefined && height !== observedHeight) issue('dimension_mismatch');
      if (bytes[cursor + 2] !== 8 || ![1, 3].includes(components) || ![0xc0, 0xc1, 0xc2].includes(marker)) {
        issue('preview_format_unsupported', false); result.preview_allowed = false;
      }
    }
    if (marker === 0xda) {
      if (result.width === null) { issue('missing_sof'); break; }
      if (length < 6 || length !== 6 + 2 * bytes[cursor + 2]) { issue('invalid_sos'); break; }
      sawScan = true; entropy = true;
    }
    offset = end;
  }
  if (result.width === null) issue('missing_sof');
  if (!sawScan) issue('missing_sos');
  if (!sawEnd) issue('missing_eoi');
  if (result.trailing_bytes) issue('trailing_bytes', false);
  return result;
}

/** A bounded preview view; large/invalid JPEGs remain recordable with an explicit preview status. */
export function jpegPreview(payload, expected, sequence, inspected) {
  const jpeg_status = inspected ?? inspectJpeg(payload, expected);
  const result = { width: expected?.width ?? jpeg_status.width, height: expected?.height ?? jpeg_status.height, sequence: Number(sequence), jpeg_status };
  if (!jpeg_status.preview_allowed) return { ...result, preview_status: jpeg_status.status === 'invalid' ? 'invalid-jpeg' : 'unsupported-jpeg' };
  if (payload.byteLength > MAX_JPEG_PREVIEW_BYTES) return { ...result, preview_status: 'jpeg-too-large' };
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return { ...result, jpeg_base64: bytes.toString('base64') };
}
