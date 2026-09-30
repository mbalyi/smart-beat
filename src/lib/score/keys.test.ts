import { model } from "@coderline/alphatab";

import {
  describeAccidentals,
  KEY_SIGNATURES,
  keyAlteration,
  keyName,
  keyTonic,
  prefersFlats,
  spellPitchClass,
  spokenNoteName,
} from "@/lib/score/keys";

const { KeySignatureType } = model;

describe("key signatures", () => {
  it("lists all fifteen keys from 7 flats to 7 sharps", () => {
    expect(KEY_SIGNATURES.map((k) => k.signature)).toEqual([
      -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("names keys, written and spoken", () => {
    expect(keyName(1, KeySignatureType.Major)).toBe("G major");
    expect(keyName(1, KeySignatureType.Minor)).toBe("E minor");
    expect(keyName(-2, KeySignatureType.Major, { spoken: true })).toBe("B flat major");
    expect(keyName(3, KeySignatureType.Minor, { spoken: true })).toBe("F sharp minor");
  });

  it("describes the accidentals", () => {
    expect(describeAccidentals(0)).toBe("No sharps or flats");
    expect(describeAccidentals(1)).toBe("1 sharp");
    expect(describeAccidentals(-3)).toBe("3 flats");
  });

  it("knows which letters the key changes", () => {
    expect(keyAlteration("f", 1)).toBe(1); // G major: F sharp
    expect(keyAlteration("c", 1)).toBe(0);
    expect(keyAlteration("C", 2)).toBe(1); // D major: C sharp
    expect(keyAlteration("b", -1)).toBe(-1); // F major: B flat
    expect(keyAlteration("E", -2)).toBe(-1); // B flat major: E flat
    expect(keyAlteration("A", -2)).toBe(0);
    expect(keyAlteration("B", 7)).toBe(1);
    expect(keyAlteration("F", -7)).toBe(-1);
  });

  it("spells pitch classes with sharps or flats", () => {
    expect(spellPitchClass(10)).toBe("A#");
    expect(spellPitchClass(10, true)).toBe("Bb");
    expect(spellPitchClass(-2, true)).toBe("Bb");
    expect(spellPitchClass(0, true)).toBe("C");
    expect(prefersFlats(-1)).toBe(true);
    expect(prefersFlats(0)).toBe(false);
  });

  it("finds the tonic of a key", () => {
    expect(keyTonic(0, KeySignatureType.Major)).toBe(0);
    expect(keyTonic(1, KeySignatureType.Major)).toBe(7); // G
    expect(keyTonic(-2, KeySignatureType.Major)).toBe(10); // B flat
    expect(keyTonic(1, KeySignatureType.Minor)).toBe(4); // E minor
    expect(keyTonic(-3, KeySignatureType.Minor)).toBe(0); // C minor
  });

  it("spells note names for screen readers", () => {
    expect(spokenNoteName("Bb")).toBe("B flat");
    expect(spokenNoteName("C#")).toBe("C sharp");
    expect(spokenNoteName("B")).toBe("B");
  });
});
