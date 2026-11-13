import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSourceSync } from "@/hooks/use-source-sync";
import type { HostRoom } from "@/lib/practice-together/host-room";
import type { SourceMessage } from "@/lib/practice-together/protocol";
import { SourceInbox, type SourceIo } from "@/lib/practice-together/source-transfer";

const ID = "a".repeat(64);

const io: SourceIo = {
  size: async () => null,
  chunk: async () => new Uint8Array(),
  stageBegin: async () => 0,
  stageAppend: async () => 0,
  stageFinish: async () => {},
  stageAbort: async () => {},
};

/** A host room that only records what the hook plugs in and sends. */
function fakeRoom() {
  const sent: { seat: string; msg: SourceMessage }[] = [];
  let hooks: Parameters<HostRoom["setSourceHooks"]>[0] = null;
  const room = {
    role: "host",
    setSourceHooks: (h: typeof hooks) => (hooks = h),
    sourceSeats: () => [{ id: "g1", name: "Ann" }],
    sendSource: (seat: string, msg: SourceMessage) => sent.push({ seat, msg }),
  } as unknown as HostRoom;
  return { room, sent, hooks: () => hooks };
}

describe("useSourceSync", () => {
  it("does nothing without a session: no files to wait for, and Play is not held back", () => {
    const { result } = renderHook(() =>
      useSourceSync({
        session: null,
        owns: true,
        phase: undefined,
        inbox: new SourceInbox(),
        paused: () => false,
        io,
      }),
    );
    expect(result.current.complete()).toBe(true);
    expect(result.current.state.waiting.size).toBe(0);
    act(() => result.current.setNeeded([{ id: ID, name: "Drums" }], []));
    expect(result.current.complete()).toBe(true);
  });

  it("as a host: plugs into the room, tells a guest what it has, and is not complete until the guest has it", async () => {
    const { room, sent, hooks } = fakeRoom();
    const { result, unmount } = renderHook(() =>
      useSourceSync({
        session: room,
        owns: true,
        phase: "synchronized",
        inbox: new SourceInbox(),
        paused: () => false,
        io,
      }),
    );
    expect(hooks()).not.toBeNull();
    // The lanes say what they need (before the session existed or after): the host has it.
    act(() => result.current.setNeeded([{ id: ID, name: "Drums" }], [ID]));
    expect(sent).toContainEqual({ seat: "g1", msg: { type: "src-have", ids: [ID] } });
    // The guest has not said it has the file yet: nobody starts.
    expect(result.current.complete()).toBe(false);
    expect(result.current.lacking()).toEqual([{ peer: "g1", id: ID, name: "Drums" }]);
    act(() => hooks()!.receive("g1", { type: "src-have", ids: [ID] }));
    expect(result.current.complete()).toBe(true);
    unmount();
    expect(hooks()).toBeNull();
  });

  it("remembers what the lanes need for a session that starts later", () => {
    const { room, sent } = fakeRoom();
    const { result, rerender } = renderHook(
      ({ session }: { session: HostRoom | null }) =>
        useSourceSync({
          session,
          owns: true,
          phase: "synchronized",
          inbox: new SourceInbox(),
          paused: () => false,
          io,
        }),
      { initialProps: { session: null as HostRoom | null } },
    );
    act(() => result.current.setNeeded([{ id: ID, name: "Drums" }], [ID]));
    rerender({ session: room });
    expect(sent).toContainEqual({ seat: "g1", msg: { type: "src-have", ids: [ID] } });
  });

  it("as a guest: files it lacks are waited for until they arrive", async () => {
    const inbox = new SourceInbox();
    const guestSent: SourceMessage[] = [];
    const session = {
      role: "guest",
      peerLanes: true,
      sendSource: (msg: SourceMessage) => guestSent.push(msg),
    } as never;
    const { result } = renderHook(() =>
      useSourceSync({ session, owns: true, phase: "synchronized", inbox, paused: () => false, io }),
    );
    act(() => result.current.setNeeded([{ id: ID, name: "Drums" }], []));
    expect(result.current.state.waiting.has(ID)).toBe(true);
    expect(result.current.complete()).toBe(false);
    // The host says it has the file: the guest asks for it.
    await act(async () => inbox.push({ type: "src-have", ids: [ID] }));
    expect(guestSent).toContainEqual({ type: "src-want", id: ID });
    vi.clearAllMocks();
  });
});
