import { createWebAudioBackend } from "@/lib/stems/player";
import { createSongPlayer, songKinds } from "@/lib/stems/song-player";
import { STEM_SONG } from "@/test/tauri";

afterEach(() => vi.unstubAllGlobals());

describe("songKinds", () => {
  it("lists the parts of a song in the page's order", () => {
    expect(songKinds(STEM_SONG)).toEqual(["drums", "bass", "vocals", "panned", "other"]);
    const some = { ...STEM_SONG, stems: [...STEM_SONG.stems].reverse().slice(1) };
    expect(songKinds(some)).toEqual(["drums", "bass", "vocals", "panned"]);
  });
});

describe("without Web Audio", () => {
  it("has no backend and no player, instead of failing", () => {
    expect(createWebAudioBackend()).toBeNull();
    expect(createSongPlayer(STEM_SONG)).toBeNull();
  });

  it("has none when the context cannot be made", () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("No audio device.");
        }
      },
    );
    expect(createWebAudioBackend()).toBeNull();
  });
});

describe("the Web Audio backend", () => {
  function stubContext() {
    const sources: {
      buffer: unknown;
      loop: boolean;
      loopStart: number;
      loopEnd: number;
      onended: (() => void) | null;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }[] = [];
    const gain = { value: 1, setTargetAtTime: vi.fn() };
    const buffer = {
      duration: 4,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array([0, 0.5, -1, 0]),
    };
    class Context {
      currentTime = 3;
      state = "suspended";
      destination = {};
      resume = vi.fn(async () => {
        this.state = "running";
      });
      close = vi.fn(async () => {});
      decodeAudioData = vi.fn(async () => buffer);
      createGain = () => ({ gain, connect: (to: unknown) => to, disconnect: vi.fn() });
      createBufferSource() {
        const source = {
          buffer: null as unknown,
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          onended: null as (() => void) | null,
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          connect: (to: unknown) => to,
        };
        sources.push(source);
        return source;
      }
    }
    vi.stubGlobal("AudioContext", Context);
    return { sources, gain, buffer };
  }

  it("decodes a clip, measures it and plays it with a loop and a gain", async () => {
    const { sources, gain } = stubContext();
    const backend = createWebAudioBackend()!;
    expect(backend.clock()).toBe(3);
    await backend.resume();
    const clip = await backend.decode(new ArrayBuffer(8));
    expect(clip.duration).toBe(4);
    expect(clip.peaks(2)).toEqual([0.5, 1]);

    const ended = vi.fn();
    const voice = backend.start(clip, 1.5, 0.25, { start: 1, end: 2 }, 0, ended);
    const source = sources[0]!;
    // A moment that has passed starts now (the context's clock is at 3).
    expect(source.start).toHaveBeenCalledWith(3, 1.5);
    expect([source.loop, source.loopStart, source.loopEnd]).toEqual([true, 1, 2]);
    expect(gain.value).toBe(0.25);
    voice.setGain(0);
    expect(gain.setTargetAtTime).toHaveBeenCalledWith(0, 3, 0.01);

    // It reports the end of the clip, but not a stop on purpose.
    source.onended?.();
    expect(ended).toHaveBeenCalledOnce();
    voice.stop();
    expect(source.onended).toBeNull();
    expect(source.stop).toHaveBeenCalled();
  });

  it("does not loop without a loop, and closes the context", async () => {
    const { sources } = stubContext();
    const backend = createWebAudioBackend()!;
    const clip = await backend.decode(new ArrayBuffer(8));
    backend.start(clip, 0, 1, null, 5, () => {});
    expect(sources[0]!.start).toHaveBeenCalledWith(5, 0);
    expect(sources[0]!.loop).toBe(false);
    backend.close();
  });
});
