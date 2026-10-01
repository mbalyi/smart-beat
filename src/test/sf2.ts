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
