/**
 * Compressed MusicXML (`.mxl`): a ZIP archive with the MusicXML score and the
 * `META-INF/container.xml` that names it, as MusicXML readers expect.
 */
import { writeMusicXml } from "@/lib/export/musicxml";
import { writeZip } from "@/lib/export/zip";
import type { Score } from "@/lib/score/model";

const SCORE_FILE = "score.xml";

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="${SCORE_FILE}" media-type="application/vnd.recordare.musicxml+xml"/>
  </rootfiles>
</container>
`;

export function writeMxl(score: Score): Uint8Array {
  const encoder = new TextEncoder();
  return writeZip([
    { name: "META-INF/container.xml", data: encoder.encode(CONTAINER) },
    { name: SCORE_FILE, data: encoder.encode(writeMusicXml(score)) },
  ]);
}
