// The Wi-Fi QR code of "Host a network" (#258), drawn as an SVG path.

import { encode } from "uqr";

/** Error correction "M" (15 %): small enough for a short Wi-Fi text, robust on a phone screen. */
const QR_ECC = "M";
/** The quiet zone around the code, in modules (4 is what the QR standard asks for). */
const QR_QUIET_ZONE = 4;

/** The QR code of `text` as one SVG path (one unit square per dark module) and its size. */
export function qrPath(text: string): { path: string; size: number } {
  const { data, size } = encode(text, { ecc: QR_ECC, border: QR_QUIET_ZONE });
  const squares = data.flatMap((row, y) =>
    row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])),
  );
  return { path: squares.join(""), size };
}
