import type { TranscriptionNote } from "./provider";

/** A lightweight note preview. It does not take over the open score's engine. */
export class NotePreview {
  private context: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  async play(notes: TranscriptionNote[], duration: number, ended: () => void): Promise<void> {
    this.stop();
    const generation = this.generation;
    const context = new AudioContext();
    this.context = context;
    await context.resume();
    if (generation !== this.generation) return;
    const start = context.currentTime + 0.05;
    const sorted = [...notes].sort((a, b) => a.start - b.start);
    let next = 0;
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
        envelope.connect(context.destination);
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
  stop(): void {
    this.generation++;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }
}
