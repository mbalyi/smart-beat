/**
 * Practice together over the local network. The sockets live in Rust (`src-tauri/src/practice.rs`);
 * this is the page's end of them, shaped as a {@link PeerTransport}.
 */
import {
  onPracticeFrame,
  onPracticeState,
  practiceHost,
  practiceJoin,
  practiceLeave,
  practiceSend,
  type PracticeHostInfo,
} from "@/lib/tauri";
import type { LinkState, PeerTransport } from "@/lib/practice-together/transport";

class LanTransport implements PeerTransport {
  private frames = new Set<(text: string) => void>();
  private states = new Set<(state: LinkState, detail?: string) => void>();
  private stops: (() => void)[] = [];
  private closed = false;

  /** Starts hearing the link. Call before the command that opens it, so no event is missed. */
  async listen() {
    this.stops = [
      await onPracticeFrame((text) => {
        for (const listener of [...this.frames]) listener(text);
      }),
      await onPracticeState((state, detail) => {
        if (state === "closed") this.release();
        for (const listener of [...this.states]) listener(state, detail);
      }),
    ];
  }

  private release() {
    for (const stop of this.stops.splice(0)) stop();
  }

  send(text: string) {
    if (!this.closed) void practiceSend(text).catch(() => {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    void practiceLeave().catch(() => {});
    this.release();
  }

  onFrame(listener: (text: string) => void) {
    this.frames.add(listener);
    return () => this.frames.delete(listener);
  }

  onState(listener: (state: LinkState, detail?: string) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
}

/** Listens on the local network. The code goes to the other player. */
export async function hostOnLan(): Promise<{ transport: PeerTransport; info: PracticeHostInfo }> {
  const transport = new LanTransport();
  await transport.listen();
  try {
    return { transport, info: await practiceHost() };
  } catch (error) {
    transport.close();
    throw error;
  }
}

/** Joins a host on the local network by its room code. */
export async function joinOnLan(code: string): Promise<PeerTransport> {
  const transport = new LanTransport();
  await transport.listen();
  try {
    await practiceJoin(code);
    return transport;
  } catch (error) {
    transport.close();
    throw error;
  }
}
