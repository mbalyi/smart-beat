import type { model } from "@coderline/alphatab";

/**
 * Text encodings of Guitar Pro 3–5 files. These formats store byte strings in
 * the system code page of the computer that wrote them, without saying which:
 * usually Windows-1252 (Western) or Windows-1250 (Central European, e.g. the
 * Hungarian ő and ű). Files written by Smart Beat before #53 used UTF-8.
 */
export type TextEncodingId = "utf-8" | "windows-1250" | "windows-1252";

/** What the user can pick in File › Reopen with encoding. */
export type EncodingChoice = "auto" | TextEncodingId;

export const ENCODING_LABELS: Record<EncodingChoice, string> = {
  auto: "Automatic",
  "windows-1250": "Central European (Windows-1250)",
  "windows-1252": "Western (Windows-1252)",
  "utf-8": "Unicode (UTF-8)",
};

const CODE_PAGES = ["windows-1250", "windows-1252"] as const;
type CodePage = (typeof CODE_PAGES)[number];

/** The 256 characters of a code page (the WHATWG decoders map every byte). */
const tables = new Map<CodePage, string[]>();
function table(page: CodePage): string[] {
  let chars = tables.get(page);
  if (!chars) {
    const decoder = new TextDecoder(page);
    chars = Array.from({ length: 256 }, (_, b) => decoder.decode(new Uint8Array([b])));
    tables.set(page, chars);
  }
  return chars;
}

const reverse = new Map<CodePage, Map<string, number>>();
function reverseTable(page: CodePage): Map<string, number> {
  let map = reverse.get(page);
  if (!map) {
    map = new Map(table(page).map((char, byte) => [char, byte] as const));
    reverse.set(page, map);
  }
  return map;
}

const utf8 = new TextEncoder();

/**
 * The bytes of `text` in `encoding`. Characters the code page lacks become
 * "?" and are counted in `lost`.
 */
export function encodeText(
  text: string,
  encoding: TextEncodingId,
): { bytes: Uint8Array; lost: number } {
  if (encoding === "utf-8") return { bytes: utf8.encode(text), lost: 0 };
  const map = reverseTable(encoding);
  const bytes: number[] = [];
  let lost = 0;
  for (const char of text) {
    const byte = map.get(char);
    if (byte === undefined) {
      bytes.push(0x3f);
      lost++;
    } else bytes.push(byte);
  }
  return { bytes: Uint8Array.from(bytes), lost };
}

/** Letters that are common in Central European text (only in Windows-1250). */
const CENTRAL = new Set("őűŐŰčČřŘšŠžŽłŁąĄęĘśŚźŹżŻćĆńŃľĽĺĹťŤďĎňŇůŮăĂșȘțȚşŞţŢ");
/** Letters only in Windows-1252 that are rare in song and track names. */
const RARE_WESTERN = new Set("õÕûÛðÐþÞýÝ");
/** Languages written with Windows-1250. */
const CENTRAL_LANGUAGES = /^(hu|cs|sk|pl|sl|hr|bs|ro|sq|sr-latn)/i;

/**
 * How likely `bytes` (a string read from the file) is to be text in `page`:
 * only the bytes the two code pages decode differently count.
 */
function score(page: CodePage, bytes: Uint8Array): number {
  const own = table(page);
  const other = table(page === "windows-1250" ? "windows-1252" : "windows-1250");
  let points = 0;
  for (const byte of bytes) {
    if (byte < 0x80 || own[byte] === other[byte]) continue;
    const char = own[byte]!;
    if (!/\p{L}/u.test(char))
      points -= 1; // a symbol inside a name is unlikely
    else if (page === "windows-1250") points += CENTRAL.has(char) ? 2 : 1;
    else points += RARE_WESTERN.has(char) ? 0.5 : 2;
  }
  return points;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the encoding of a GP3–5 file from its strings, each given as the bytes
 * it was stored as. Plain ASCII files keep Windows-1252.
 */
export function detectEncoding(
  strings: Uint8Array[],
  language = defaultLanguage(),
): TextEncodingId {
  const nonAscii = strings.filter((s) => s.some((b) => b >= 0x80));
  if (nonAscii.length === 0) return "windows-1252";
  if (nonAscii.every(isUtf8)) return "utf-8";
  let central = 0;
  let western = 0;
  for (const s of nonAscii) {
    central += score("windows-1250", s);
    western += score("windows-1252", s);
  }
  if (central === western)
    return CENTRAL_LANGUAGES.test(language) ? "windows-1250" : "windows-1252";
  return central > western ? "windows-1250" : "windows-1252";
}

function defaultLanguage(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language;
}

/** The encoding for a new song: the user's code page. */
export function defaultEncoding(language = defaultLanguage()): TextEncodingId {
  return CENTRAL_LANGUAGES.test(language) ? "windows-1250" : "windows-1252";
}

/**
 * Every text of a score that was read from the file (the strings the encoding
 * applies to). Read with Windows-1252, which keeps every byte, so `encodeText`
 * gives the stored bytes back.
 */
export function scoreStrings(score: model.Score): string[] {
  const texts: string[] = [
    score.title,
    score.subTitle,
    score.artist,
    score.album,
    score.words,
    score.music,
    score.copyright,
    score.tab,
    score.instructions,
    ...score.notices,
  ];
  for (const bar of score.masterBars) if (bar.section) texts.push(bar.section.text);
  for (const track of score.tracks) {
    texts.push(track.name);
    for (const staff of track.staves) {
      for (const chord of staff.chords?.values() ?? []) texts.push(chord.name);
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            if (beat.text) texts.push(beat.text);
            for (const line of beat.lyrics ?? []) texts.push(line);
          }
        }
      }
    }
  }
  return texts.filter((t) => typeof t === "string" && t.length > 0);
}

/** The encoding a song was read with, to save it the same way. */
const sources = new WeakMap<model.Score, TextEncodingId>();

export function setSourceEncoding(score: model.Score, encoding: TextEncodingId) {
  sources.set(score, encoding);
}

export function sourceEncoding(score: model.Score): TextEncodingId | undefined {
  return sources.get(score);
}

/**
 * The encoding to save `texts` with: the song's own one when every character
 * fits, else a code page they all fit in, else the song's own (with losses).
 */
export function encodingFor(texts: string[], preferred: TextEncodingId): TextEncodingId {
  if (preferred === "utf-8") return preferred;
  const fits = (page: TextEncodingId) => texts.every((t) => encodeText(t, page).lost === 0);
  if (fits(preferred)) return preferred;
  return CODE_PAGES.find(fits) ?? preferred;
}
