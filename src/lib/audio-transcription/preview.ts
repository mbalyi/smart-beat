import type { TranscriptionNote } from "./provider";

export interface PlayOptions {
  /** The recording to play together with the MIDI. */
  original?: AudioBuffer | null;
  /** 0 is only the original, 1 only the MIDI. */
  mix?: number;
  /** The original on the left channel, the MIDI on the right. */
  stereo?: boolean;
  /** Where to start, in seconds. */
  from?: number;
}

/** Decodes the recording for playback. Null when the webview cannot decode it. */
export async function decodeOriginal(file: File): Promise<AudioBuffer | null> {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    return await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    return null;
  } finally {
    void context?.close().catch(() => {});
  }
}

/** Equal-power crossfade: the loudness stays level across the slider. */
const gains = (mix: number) => {
  const angle = Math.min(1, Math.max(0, mix)) * (Math.PI / 2);
  return { original: Math.cos(angle), midi: Math.sin(angle) };
};

/** A lightweight note preview. It does not take over the open score's engine. */
export class NotePreview {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private mix = 0.5;
  private stereo = false;
  private origin = 0;
  /** The context time at which the playhead is at `origin`. */
  private beginTime = 0;
  private midiGain: GainNode | null = null;
  private midiPan: StereoPannerNode | null = null;
  private originalGain: GainNode | null = null;
  private originalPan: StereoPannerNode | null = null;
  private source: AudioBufferSourceNode | null = null;

  async play(
    notes: TranscriptionNote[],
    duration: number,
    ended: () => void,
    options: PlayOptions = {},
  ): Promise<void> {
    this.stop();
    const generation = this.generation;
    const context = new AudioContext();
    this.context = context;
    await context.resume();
    if (generation !== this.generation) return;
    const from = Math.max(0, options.from ?? 0);
    this.mix = options.mix ?? this.mix;
    this.stereo = options.stereo ?? this.stereo;
    this.origin = from;
    this.beginTime = context.currentTime + 0.05;
    const start = this.beginTime - from;
    // The MIDI bus and, when there is one, the original's bus.
    this.midiGain = context.createGain();
    this.midiPan = context.createStereoPanner();
    this.midiGain.connect(this.midiPan);
    this.midiPan.connect(context.destination);
    this.originalGain = context.createGain();
    this.originalPan = context.createStereoPanner();
    this.originalGain.connect(this.originalPan);
    this.originalPan.connect(context.destination);
    this.apply();
    if (options.original) {
      const source = context.createBufferSource();
      source.buffer = options.original;
      source.connect(this.originalGain);
      source.start(this.beginTime, from);
      this.source = source;
    }
    const sorted = [...notes].filter((n) => n.end > from).sort((a, b) => a.start - b.start);
    let next = 0;
    const midi = this.midiGain;
    const schedule = () => {
      while (next < sorted.length && sorted[next]!.start < context.currentTime - start + 0.25) {
        const note = sorted[next++]!;
        const at = Math.max(context.currentTime, start + note.start);
        const end = Math.max(at + 0.02, start + note.end);
        const voice = context.createOscillator();
        const envelope = context.createGain();
        voice.type = note.instrument === "drums" ? "square" : "triangle";
        voice.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
        envelope.gain.setValueAtTime(0, at);
        envelope.gain.linearRampToValueAtTime((0.06 * (note.velocity ?? 90)) / 127, at + 0.01);
        envelope.gain.exponentialRampToValueAtTime(0.0001, end);
        voice.connect(envelope);
        envelope.connect(midi);
        voice.onended = () => {
          voice.disconnect();
          envelope.disconnect();
        };
        voice.start(at);
        voice.stop(end + 0.02);
      }
      if (context.currentTime >= start + duration + 0.1) {
        this.stop();
        ended();
      }
    };
    schedule();
    this.timer = setInterval(schedule, 50);
  }

  /** 0 only the original, 1 only the MIDI. Takes effect at once. */
  setMix(mix: number): void {
    this.mix = mix;
    this.apply();
  }

  setStereo(stereo: boolean): void {
    this.stereo = stereo;
    this.apply();
  }

  /** Seconds into the recording while playing; where it stopped otherwise. */
  position(): number {
    if (!this.context) return this.origin;
    return Math.max(0, this.origin + this.context.currentTime - this.beginTime);
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    try {
      this.source?.stop();
    } catch {
      // Not started, or already stopped.
    }
    this.source = null;
    this.midiGain = this.midiPan = this.originalGain = this.originalPan = null;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }

  private apply(): void {
    const level = gains(this.mix);
    if (this.originalGain) this.originalGain.gain.value = level.original;
    if (this.midiGain) this.midiGain.gain.value = level.midi;
    if (this.originalPan) this.originalPan.pan.value = this.stereo ? -1 : 0;
    if (this.midiPan) this.midiPan.pan.value = this.stereo ? 1 : 0;
  }
}
