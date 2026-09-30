/**
 * Reads which drum keys a SoundFont plays. A SoundFont (SF2, or SF3 with
 * compressed samples) keeps its instruments in a `pdta` list of RIFF chunks:
 * presets (with a bank and program), their zones, the instruments those zones
 * use and the samples. The percussion kit is preset 0 of bank 128; a zone's
 * key range says which MIDI keys (drum numbers) it covers.
 *
 * No imports, so the `scripts/drum-support.mjs` report can use it too.
 */

/** The preset (bank 128, program 0 by default) is missing from the SoundFont. */
export class NoPercussionError extends Error {}

interface Chunks {
  [id: string]: DataView;
}

const text = (view: DataView, at: number, length: number) => {
  let out = "";
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(at + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
};

/** Reads the chunks inside a `LIST` chunk of type `pdta`. */
function pdtaChunks(bytes: Uint8Array): Chunks {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (text(view, 0, 4) !== "RIFF" || text(view, 8, 4) !== "sfbk") {
    throw new Error("Not a SoundFont.");
  }
  let at = 12;
  while (at + 8 <= view.byteLength) {
    const id = text(view, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === "LIST" && text(view, at + 8, 4) === "pdta") {
      const chunks: Chunks = {};
      let inner = at + 12;
      const end = at + 8 + size;
      while (inner + 8 <= end) {
        const innerId = text(view, inner, 4);
        const innerSize = view.getUint32(inner + 4, true);
        chunks[innerId] = new DataView(view.buffer, view.byteOffset + inner + 8, innerSize);
        inner += 8 + innerSize + (innerSize % 2);
      }
      return chunks;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("The SoundFont has no instrument data.");
}

/** Generator numbers (SoundFont 2.04 spec, 8.1.2). */
const GEN_KEY_RANGE = 43;
const GEN_INSTRUMENT = 41;
const GEN_SAMPLE_ID = 53;

interface Zone {
  /** Generators of the zone, by number. */
  gens: Map<number, number>;
  keyLow: number | null;
  keyHigh: number | null;
}

function zonesOf(bag: DataView, gen: DataView, first: number, last: number): Zone[] {
  const zones: Zone[] = [];
  for (let z = first; z < last; z++) {
    const from = bag.getUint16(z * 4, true);
    const to = bag.getUint16((z + 1) * 4, true);
    const gens = new Map<number, number>();
    let keyLow: number | null = null;
    let keyHigh: number | null = null;
    for (let g = from; g < to; g++) {
      const id = gen.getUint16(g * 4, true);
      if (id === GEN_KEY_RANGE) {
        keyLow = gen.getUint8(g * 4 + 2);
        keyHigh = gen.getUint8(g * 4 + 3);
      } else {
        gens.set(id, gen.getUint16(g * 4 + 2, true));
      }
    }
    zones.push({ gens, keyLow, keyHigh });
  }
  return zones;
}

/**
 * For each MIDI key the percussion kit plays: the names of the samples that
 * sound on it. Keys missing from the result are silent.
 */
export function percussionKeys(bytes: Uint8Array, program = 0): Map<number, string[]> {
  const pdta = pdtaChunks(bytes);
  const { phdr, pbag, pgen, inst, ibag, igen, shdr } = pdta;
  if (!phdr || !pbag || !pgen || !inst || !ibag || !igen || !shdr) {
    throw new Error("The SoundFont is incomplete.");
  }

  // Preset headers are 38 bytes: name(20) preset(2) bank(2) bagIndex(2) + 12.
  const presetCount = phdr.byteLength / 38 - 1; // the last one is a terminator
  let preset = -1;
  for (let i = 0; i < presetCount; i++) {
    if (
      phdr.getUint16(i * 38 + 20, true) === program &&
      phdr.getUint16(i * 38 + 22, true) === 128
    ) {
      preset = i;
    }
  }
  if (preset < 0) throw new NoPercussionError("The SoundFont has no percussion kit (bank 128).");

  const sampleName = (id: number) => text(shdr, id * 46, 20);
  const keys = new Map<number, string[]>();
  const add = (low: number, high: number, name: string) => {
    for (let key = Math.max(0, low); key <= Math.min(127, high); key++) {
      const names = keys.get(key) ?? [];
      if (!names.includes(name)) names.push(name);
      keys.set(key, names);
    }
  };

  const presetZones = zonesOf(
    pbag,
    pgen,
    phdr.getUint16(preset * 38 + 24, true),
    phdr.getUint16((preset + 1) * 38 + 24, true),
  );
  for (const presetZone of presetZones) {
    const instrument = presetZone.gens.get(GEN_INSTRUMENT);
    if (instrument === undefined) continue; // the global zone
    // Instrument headers are 22 bytes: name(20) bagIndex(2).
    const zones = zonesOf(
      ibag,
      igen,
      inst.getUint16(instrument * 22 + 20, true),
      inst.getUint16((instrument + 1) * 22 + 20, true),
    );
    for (const zone of zones) {
      const sample = zone.gens.get(GEN_SAMPLE_ID);
      if (sample === undefined) continue; // the global zone
      const low = Math.max(zone.keyLow ?? 0, presetZone.keyLow ?? 0);
      const high = Math.min(zone.keyHigh ?? 127, presetZone.keyHigh ?? 127);
      add(low, high, sampleName(sample));
    }
  }
  return keys;
}
