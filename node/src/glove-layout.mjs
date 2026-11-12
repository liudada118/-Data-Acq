const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];
const PALM_ROWS = [12, 15, 15, 15, 15];
const invariant = (value, message) => { if (!value) throw new Error(message); };
const sequence = value => Array.isArray(value) || ArrayBuffer.isView(value);
const equal = (left, right) => left.length === right.length && left.every((value, i) => value === right[i]);

/** The physical 137-point SDK regions are distinct from its legacy 13x15 matrix. */
export function validateGloveLayout(layout, side) {
  invariant(layout?.type === 'glove' && layout.version === 1 && ['left', 'right'].includes(layout.side)
    && (side === undefined || side === layout.side), 'Invalid saved glove layout or hand side');
  invariant(layout.fingers && Object.keys(layout.fingers).length === 5 && FINGERS.every(id => layout.fingers[id]),
    'Glove layout must contain five fingers');
  const used = new Set();
  const indices = (values, count) => {
    invariant(Array.isArray(values) && values.length === count, 'Invalid glove source index count');
    for (const index of values) {
      invariant(Number.isSafeInteger(index) && index >= 0 && index < 256 && !used.has(index), 'Invalid or duplicate glove source index');
      used.add(index);
    }
  };
  for (const id of FINGERS) {
    indices(layout.fingers[id].source_indices, 12);
    indices([layout.fingers[id].pulp_source_index], 1);
  }
  invariant(layout.palm && Array.isArray(layout.palm.row_lengths) && equal(layout.palm.row_lengths, PALM_ROWS), 'Invalid glove palm row lengths');
  indices(layout.palm.source_indices, 72);
  invariant(used.size === 137, 'Glove layout must contain 137 unique sensor points');
  return layout;
}

export function glovePreviewFromLayout(layout, adc, side) {
  validateGloveLayout(layout, side);
  invariant(sequence(adc) && adc.length === 256 && Array.from(adc).every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Invalid glove ADC values');
  const fingers = Object.fromEntries(FINGERS.map(id => {
    const mapping = layout.fingers[id];
    return [id, { values: mapping.source_indices.map(index => adc[index]), pulp: adc[mapping.pulp_source_index],
      source_indices: mapping.source_indices, pulp_source_index: mapping.pulp_source_index }];
  }));
  return { side: layout.side, fingers, palm: { values: layout.palm.source_indices.map(index => adc[index]),
    row_lengths: layout.palm.row_lengths, source_indices: layout.palm.source_indices } };
}

function readRegion(region, rowLengths, adc) {
  invariant(region && region.rows === rowLengths.length && region.cols === Math.max(...rowLengths)
    && sequence(region.rowLengths) && equal(Array.from(region.rowLengths), rowLengths), 'SDK glove region shape is invalid');
  const count = rowLengths.reduce((sum, value) => sum + value, 0);
  invariant(sequence(region.sourceIndices) && region.sourceIndices.length === count, 'SDK glove source indices are invalid');
  const source = Array.from(region.sourceIndices);
  invariant(sequence(region.raw) && region.raw.length === count && Array.isArray(region.matrix) && region.matrix.length === rowLengths.length,
    'SDK glove region values are invalid');
  const matrix = region.matrix.flatMap((row, index) => {
    invariant(sequence(row) && row.length === rowLengths[index], 'SDK glove region matrix shape is invalid');
    return Array.from(row);
  });
  invariant(source.every((index, i) => Number.isSafeInteger(index) && index >= 0 && index < adc.length
    && region.raw[i] === adc[index] && matrix[i] === adc[index]), 'SDK glove region values do not match raw ADC');
  return source;
}

export function captureGloveLayout(frame, adc, side, saved) {
  // Older SDK/contract fixtures can provide only the legacy matrix. Never invent
  // physical finger points from that unrelated matrix or a raw channel square.
  if (frame.fingers === undefined && frame.palm === undefined && saved === undefined) return null;
  invariant(frame.side === side && frame.fingers && frame.palm && FINGERS.every(id => frame.fingers[id]), 'SDK glove regions or hand side are invalid');
  const fingers = Object.fromEntries(FINGERS.map(id => [id, {
    source_indices: readRegion(frame.fingers[id], [3, 3, 3, 3], adc),
    pulp_source_index: readRegion(frame.fingers[id].pulp, [1], adc)[0],
  }]));
  const candidate = { type: 'glove', version: 1, side, fingers,
    palm: { row_lengths: [...PALM_ROWS], source_indices: readRegion(frame.palm, PALM_ROWS, adc) } };
  validateGloveLayout(candidate, side);
  if (saved !== undefined) {
    validateGloveLayout(saved, side);
    invariant(FINGERS.every(id => equal(saved.fingers[id].source_indices, fingers[id].source_indices)
      && saved.fingers[id].pulp_source_index === fingers[id].pulp_source_index)
      && equal(saved.palm.source_indices, candidate.palm.source_indices), 'SDK glove mapping changed during the connection');
  }
  const layout = saved ?? candidate;
  return { layout, extra: { glove: glovePreviewFromLayout(layout, adc, side) } };
}

// Fixed mapping copied from shroom-sdk 0.4.0 glove-regions.js. This is used only
// for explicit 0.4.0 legacy recordings with a known side, never for unknown SDKs.
const LEGACY = {
  left: {
    little: [[31,30,29,15,14,13,255,254,253,239,238,237], 222],
    ring: [[28,27,26,12,11,10,252,251,250,236,235,234], 219],
    middle: [[25,24,23,9,8,7,249,248,247,233,232,231], 216],
    index: [[22,21,20,6,5,4,246,245,244,230,229,228], 213],
    thumb: [[19,18,17,3,2,1,243,242,241,227,226,225], 210],
    palm: [207,206,205,204,203,202,201,200,199,198,197,196,
      191,190,189,188,187,186,185,184,183,182,181,180,179,178,177,
      175,174,173,172,171,170,169,168,167,166,165,164,163,162,161,
      159,158,157,156,155,154,153,152,151,150,149,148,147,146,145,
      143,142,141,140,139,138,137,136,135,134,133,132,131,130,129],
  },
  right: {
    thumb: [[240,239,238,256,255,254,16,15,14,32,31,30], 47],
    index: [[237,236,235,253,252,251,13,12,11,29,28,27], 44],
    middle: [[234,233,232,250,249,248,10,9,8,26,25,24], 41],
    ring: [[231,230,229,247,246,245,7,6,5,23,22,21], 38],
    little: [[228,227,226,244,243,242,4,3,2,20,19,18], 35],
    palm: [61,60,59,58,57,56,55,54,53,52,51,50,
      80,79,78,77,76,75,74,73,72,71,70,69,68,67,66,
      96,95,94,93,92,91,90,89,88,87,86,85,84,83,82,
      112,111,110,109,108,107,106,105,104,103,102,101,100,99,98,
      128,127,126,125,124,123,122,121,120,119,118,117,116,115,114],
  },
};
export function legacyGloveLayout040(side) {
  const mapping = LEGACY[side];
  invariant(mapping, 'Invalid legacy glove side');
  return validateGloveLayout({ type: 'glove', version: 1, side,
    fingers: Object.fromEntries(FINGERS.map(id => [id, { source_indices: mapping[id][0].map(index => index - 1), pulp_source_index: mapping[id][1] - 1 }])),
    palm: { row_lengths: [...PALM_ROWS], source_indices: mapping.palm.map(index => index - 1) } });
}
