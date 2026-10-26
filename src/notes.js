// Pure note/scale mapping: wall index or grid position -> frequency.

export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  minor: [0, 3, 5, 7, 10],
  phrygian: [0, 1, 4, 5, 7, 8, 10],
};

export const SCALE_NAMES = Object.keys(SCALES);

export function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// degree is an index into the scale extended across octaves:
// degree 0 = root, degree scale.length = root one octave up, etc.
export function degreeFreq(rootMidi, scaleName, degree) {
  const scale = SCALES[scaleName];
  if (!scale) throw new Error(`unknown scale: ${scaleName}`);
  const oct = Math.floor(degree / scale.length);
  const step = scale[((degree % scale.length) + scale.length) % scale.length];
  return midiToFreq(rootMidi + step + 12 * oct);
}

// Wall i plays degree i, so more corners = a longer climb up the scale.
export function wallFreq(rootMidi, scaleName, edgeIndex) {
  return degreeFreq(rootMidi, scaleName, edgeIndex);
}

// Grid: pitch comes from the row only; the top row is the highest note.
export function gridFreq(rootMidi, scaleName, row, rows) {
  const degree = Math.max(0, rows - 1 - row);
  return degreeFreq(rootMidi, scaleName, degree + 7); // sit above the bounce register
}
