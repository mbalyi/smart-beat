/**
 * A tiny SoundFont 2 (for tests): one percussion preset (bank 128) whose
 * zones cover the given key ranges, each with a named sample.
 */
export interface DrumZone {
  low: number;
  high: number;
  sample: string;
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (text: string, length = text.length) => {
  const bytes = new Array<number>(length).fill(0);
  for (let i = 0; i < Math.min(text.length, length); i++) bytes[i] = text.charCodeAt(i);
  return bytes;
};
const chunk = (id: string, data: number[]) => [
  ...ascii(id),
  ...u32(data.length),
  ...data,
  ...(data.length % 2 ? [0] : []),
];

export function makeDrumSoundFont(zones: DrumZone[], { bank = 128, program = 0 } = {}): Uint8Array {
  // Preset headers (38 bytes): name, program, bank, bag index, 3 reserved dwords. The last is the terminator.
  const phdr = [
    ...ascii("Kit", 20),
    ...u16(program),
    ...u16(bank),
    ...u16(0),
    ...u32(0),
    ...u32(0),
    ...u32(0),
    ...ascii("EOP", 20),
    ...u16(0),
    ...u16(0),
    ...u16(1),
    ...u32(0),
    ...u32(0),
    ...u32(0),
  ];
  // One preset zone (bag) with one generator: instrument 0 (generator 41).
  const pbag = [...u16(0), ...u16(0), ...u16(1), ...u16(0)];
  const pgen = [...u16(41), ...u16(0), ...u16(0), ...u16(0)];
  // One instrument; its zones (bags) each have a key range (generator 43) and a sample (generator 53).
  const inst = [...ascii("Drums", 20), ...u16(0), ...ascii("EOI", 20), ...u16(zones.length)];
  const ibag: number[] = [];
  const igen: number[] = [];
  zones.forEach((zone, i) => {
    ibag.push(...u16(i * 2), ...u16(0));
    igen.push(...u16(43), zone.low, zone.high, ...u16(53), ...u16(i));
  });
  ibag.push(...u16(zones.length * 2), ...u16(0));
  igen.push(...u16(0), ...u16(0));
  // Sample headers (46 bytes): name(20) and 26 bytes of data.
  const shdr = [
    ...zones.flatMap((zone) => [...ascii(zone.sample, 20), ...new Array<number>(26).fill(0)]),
    ...ascii("EOS", 20),
    ...new Array<number>(26).fill(0),
  ];
  const pdta = [
    ...ascii("pdta"),
    ...chunk("phdr", phdr),
    ...chunk("pbag", pbag),
    ...chunk("pmod", new Array(10).fill(0)),
    ...chunk("pgen", pgen),
    ...chunk("inst", inst),
    ...chunk("ibag", ibag),
    ...chunk("imod", new Array(10).fill(0)),
    ...chunk("igen", igen),
    ...chunk("shdr", shdr),
  ];
  const body = [...ascii("sfbk"), ...chunk("LIST", pdta)];
  return Uint8Array.from([...ascii("RIFF"), ...u32(body.length), ...body]);
}

export interface MelodicZone {
  low: number;
  high: number;
  /** The pitch the sample was recorded at (the sample header's original pitch). */
  samplePitch: number;
  /** The zone's own root key, which wins over the sample's (generator 58). */
  rootKey?: number;
}

export interface MelodicPreset {
  program: number;
  bank?: number;
  zones: MelodicZone[];
}

/**
 * A tiny SoundFont 2 of melodic presets (for tests): each preset has one
 * instrument whose zones cover key ranges, each with a sample recorded at a
 * given pitch.
 */
export function makeMelodicSoundFont(presets: MelodicPreset[]): Uint8Array {
  // Preset headers (38 bytes): name, program, bank, bag index, 3 reserved dwords; then the terminator.
  const phdr: number[] = [];
  const pbag: number[] = [];
  const pgen: number[] = [];
  const inst: number[] = [];
  const ibag: number[] = [];
  const igen: number[] = [];
  const shdr: number[] = [];
  let zoneCount = 0;
  let sampleCount = 0;
  presets.forEach((preset, p) => {
    phdr.push(
      ...ascii(`Preset ${preset.program}`, 20),
      ...u16(preset.program),
      ...u16(preset.bank ?? 0),
      ...u16(p),
      ...u32(0),
      ...u32(0),
      ...u32(0),
    );
    // One preset zone: instrument p.
    pbag.push(...u16(p), ...u16(0));
    pgen.push(...u16(41), ...u16(p));
    inst.push(...ascii(`Instrument ${p}`, 20), ...u16(zoneCount));
    for (const zone of preset.zones) {
      ibag.push(...u16(igen.length / 4), ...u16(0));
      igen.push(...u16(43), zone.low, zone.high);
      if (zone.rootKey !== undefined) igen.push(...u16(58), ...u16(zone.rootKey));
      igen.push(...u16(53), ...u16(sampleCount));
      // Sample header: name(20), start, end, loop start, loop end, rate (5 × 4), pitch(1), correction(1), link(2), type(2).
      shdr.push(
        ...ascii(`Sample ${sampleCount}`, 20),
        ...u32(0),
        ...u32(0),
        ...u32(0),
        ...u32(0),
        ...u32(44_100),
        zone.samplePitch,
        0,
        ...u16(0),
        ...u16(1),
      );
      sampleCount++;
      zoneCount++;
    }
  });
  phdr.push(
    ...ascii("EOP", 20),
    ...u16(0),
    ...u16(0),
    ...u16(presets.length),
    ...u32(0),
    ...u32(0),
    ...u32(0),
  );
  pbag.push(...u16(presets.length), ...u16(0));
  pgen.push(...u16(0), ...u16(0));
  inst.push(...ascii("EOI", 20), ...u16(zoneCount));
  ibag.push(...u16(igen.length / 4), ...u16(0));
  igen.push(...u16(0), ...u16(0));
  shdr.push(...ascii("EOS", 20), ...new Array<number>(26).fill(0));
  const pdta = [
    ...ascii("pdta"),
    ...chunk("phdr", phdr),
    ...chunk("pbag", pbag),
    ...chunk("pmod", new Array(10).fill(0)),
    ...chunk("pgen", pgen),
    ...chunk("inst", inst),
    ...chunk("ibag", ibag),
    ...chunk("imod", new Array(10).fill(0)),
    ...chunk("igen", igen),
    ...chunk("shdr", shdr),
  ];
  const body = [...ascii("sfbk"), ...chunk("LIST", pdta)];
  return Uint8Array.from([...ascii("RIFF"), ...u32(body.length), ...body]);
}
