import type { SmuflName } from "@/lib/score/smufl";

/**
 * How far the ink of each glyph reaches above and below its baseline, in em: `[above, below]`.
 * Measured from the bundled Bravura (`measureText` at 2000px: actualBoundingBoxAscent and
 * actualBoundingBoxDescent). The palette uses it to centre every icon vertically in its cell,
 * whatever its height. Add an entry when a glyph is added to `SMUFL`; a test checks that none is
 * missing.
 */
export const SMUFL_INK: Record<SmuflName, readonly [number, number]> = {
  noteWhole: [0.136, 0.137],
  noteHalfUp: [0.875, 0.145],
  noteQuarterUp: [0.875, 0.141],
  note8thUp: [0.873, 0.138],
  note16thUp: [0.873, 0.138],
  note32ndUp: [1.023, 0.138],
  note64thUp: [1.222, 0.138],
  augmentationDot: [0.05, 0.05],
  restQuarter: [0.373, 0.375],
  tuplet3: [0.375, 0.008],
  accidentalFlat: [0.439, 0.175],
  accidentalNatural: [0.341, 0.335],
  accidentalSharp: [0.35, 0.348],
  accidentalDoubleSharp: [0.127, 0.125],
  accidentalDoubleFlat: [0.437, 0.175],
  timeSig0: [0.251, 0.25],
  timeSig1: [0.251, 0.25],
  timeSig2: [0.254, 0.257],
  timeSig3: [0.249, 0.251],
  timeSig4: [0.251, 0.25],
  timeSig5: [0.246, 0.251],
  timeSig6: [0.251, 0.249],
  timeSig7: [0.249, 0.25],
  timeSig8: [0.259, 0.259],
  timeSig9: [0.251, 0.249],
  dynamicPPP: [0.274, 0.142],
  dynamicPP: [0.274, 0.142],
  dynamicPiano: [0.274, 0.142],
  dynamicMP: [0.274, 0.142],
  dynamicMF: [0.431, 0.165],
  dynamicForte: [0.444, 0.152],
  dynamicFF: [0.444, 0.152],
  dynamicFFF: [0.444, 0.152],
  dynamicCrescendoHairpin: [0.356, -0.093],
  dynamicDiminuendoHairpin: [0.356, -0.093],
  articAccentAbove: [0.245, -0.001],
  articStaccatoAbove: [0.084, 0],
  articTenutoAbove: [0.048, 0],
  articMarcatoAbove: [0.253, 0.001],
  fermataAbove: [0.329, 0.003],
  noteheadXBlack: [0.125, 0.125],
  noteheadParenthesisLeft: [0.181, 0.181],
  noteheadParenthesisRight: [0.181, 0.181],
  noteheadBlack: [0.125, 0.125],
  noteheadDiamondWhite: [0.125, 0.125],
  graceNoteAcciaccaturaStemUp: [0.524, 0.083],
  graceNoteAppoggiaturaStemUp: [0.526, 0.081],
  ornamentTrill: [0.39, 0.01],
  wiggleTrill: [0.209, -0.098],
  tremolo1: [0.094, 0.093],
  tremolo2: [0.187, 0.187],
  tremolo3: [0.278, 0.28],
  stringsDownBow: [0.318, 0],
  stringsUpBow: [0.495, -0.001],
  arpeggiatoUp: [1.511, -0.007],
  arpeggiatoDown: [1.5, 0.004],
  ottavaAlta: [0.463, 0.01],
  ottavaBassaVb: [0.463, 0.01],
  quindicesimaAlta: [0.461, 0.01],
  quindicesimaBassaMb: [0.461, 0.01],
  guitarFadeIn: [0.365, 0],
  guitarFadeOut: [0.365, 0],
  guitarVolumeSwell: [0.365, 0],
  guitarOpenPedal: [0.286, 0],
  guitarClosePedal: [0.285, 0.001],
  guitarStrumUp: [0.527, 0],
  guitarStrumDown: [0.527, 0],
  guitarVibratoStroke: [0.119, 0],
  guitarWideVibratoStroke: [0.224, 0],
  repeatLeft: [1, 0],
  repeatRight: [1, 0],
  segno: [0.759, 0.027],
  coda: [0.898, 0.158],
  dalSegno: [0.442, 0.009],
  daCapo: [0.442, 0.009],
};

/**
 * Where Bravura's baseline sits in a `line-height: 1` box, in em below the box centre (measured;
 * the font's ascent and descent are nearly equal, so it is almost on the centre).
 */
const BASELINE_BELOW_CENTRE = -0.014;

/**
 * The vertical shift (em, down) that puts the middle of the ink of `names` on the middle of the
 * box. The glyphs of a run share one baseline, so the run reaches as far up and down as its
 * tallest and deepest glyph.
 */
export function inkCentring(names: readonly SmuflName[]): number {
  const above = Math.max(...names.map((n) => SMUFL_INK[n][0]));
  const below = Math.max(...names.map((n) => SMUFL_INK[n][1]));
  const ink = (above - below) / 2; // the ink centre, in em above the baseline
  return Math.round((ink - BASELINE_BELOW_CENTRE) * 1000) / 1000;
}
