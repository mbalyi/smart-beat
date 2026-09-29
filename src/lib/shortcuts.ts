import type { Shortcut } from "@/lib/tauri";

/** Groups shortcuts by menu, keeping menu order. */
export function groupByMenu(shortcuts: Shortcut[]): [menu: string, items: Shortcut[]][] {
  const groups = new Map<string, Shortcut[]>();
  for (const shortcut of shortcuts) {
    const items = groups.get(shortcut.menu) ?? [];
    items.push(shortcut);
    groups.set(shortcut.menu, items);
  }
  return [...groups];
}
