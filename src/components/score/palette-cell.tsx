import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlignJustifyIcon,
  BetweenVerticalStartIcon,
  Columns3CogIcon,
  GuitarIcon,
  Grid3x3Icon,
  KeyboardIcon,
  LayersIcon,
  LinkIcon,
  MicVocalIcon,
  SplineIcon,
  Trash2Icon,
  TypeIcon,
  type LucideIcon,
} from "lucide-react";

import { Glyph, MarkText } from "@/components/score/palette-button";
import { markedName, PRESSED } from "@/components/score/palette-style";
import { useInkCentring } from "@/components/score/use-ink-centring";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ACTIVE_BRAND } from "@/components/ui/mixer-toggle-styles";
import { Tip } from "@/components/ui/tip";
import type { ToggleState } from "@/lib/score/editor";
import type {
  PaletteBox,
  PaletteGroup,
  PaletteIconName,
  PaletteItem,
  PaletteVisual,
} from "@/lib/score/palette-model";
import { SMUFL, type SmuflName } from "@/lib/score/smufl";
import { inkCentring } from "@/lib/score/smufl-ink";
import { cn } from "@/lib/utils";

const ICONS: Record<PaletteIconName, LucideIcon> = {
  tie: LinkIcon,
  fillRests: AlignJustifyIcon,
  insertBeat: BetweenVerticalStartIcon,
  deleteBeat: Trash2Icon,
  bar: Columns3CogIcon,
  bend: SplineIcon,
  whammy: GuitarIcon,
  text: TypeIcon,
  chord: Grid3x3Icon,
  lyrics: MicVocalIcon,
  shortcuts: KeyboardIcon,
  nested: LayersIcon,
};

const LABEL = "text-[0.78rem] leading-none font-semibold";

/** Plain bold text in a cell (the "=120" of a tempo, "3:2"), its ink centred in the cell. */
function LabelText({ children, className }: { children?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useInkCentring(ref, children ?? "");
  return (
    <span ref={ref} aria-hidden="true" className={cn(LABEL, className)}>
      {children}
    </span>
  );
}

/** A time signature drawn with Bravura's digits, one above the other. */
function TimeDigits({ digits }: { digits: readonly [number, number] }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none flex flex-col items-center gap-[0.08rem]"
    >
      {digits.map((value, i) => {
        const names = String(value)
          .split("")
          .map((d) => `timeSig${d}` as SmuflName);
        return (
          <span key={i} className="relative block h-[0.58rem] min-w-[0.7rem]">
            <span
              style={{ translate: `0 ${inkCentring(names)}em` }}
              className="absolute inset-x-0 top-1/2 -mt-[0.5em] h-[1em] text-center font-[Bravura] text-[1.1rem] leading-none whitespace-nowrap"
            >
              {names.map((n) => String.fromCodePoint(SMUFL[n])).join("")}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The words a cell writes on screen (a mark or plain text, such as "sl." or "V1"). WCAG 2.5.3
 * (Label in Name): the accessible name has to contain them as whole words, so a voice command
 * like "click sl." finds the cell.
 */
function visibleText(visual: PaletteVisual): string {
  return [visual.mark, visual.text, visual.sub?.text]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** The visible text of `visual` when `name` does not contain it (as a run of whole words). */
function missingVisible(name: string, visual: PaletteVisual): string | undefined {
  const text = visibleText(visual);
  const wanted = words(text);
  if (wanted.length === 0) return undefined;
  const have = words(name);
  for (let i = 0; i + wanted.length <= have.length; i++) {
    if (wanted.every((word, k) => have[i + k] === word)) return undefined;
  }
  return text;
}

/** `name`, with the visible text appended when the name does not contain it yet. */
function withVisibleText(name: string, visual: PaletteVisual): string {
  const missing = missingVisible(name, visual);
  return missing ? `${name}, ${missing}` : name;
}

/** What a cell shows: never a text label (the name is in the tooltip and the accessible name). */
export function CellVisual({ visual }: { visual: PaletteVisual }) {
  if (visual.digits) return <TimeDigits digits={visual.digits} />;
  if (visual.icon) {
    const Icon = ICONS[visual.icon];
    return <Icon className="size-4" aria-hidden="true" />;
  }
  if (visual.mark !== undefined && visual.sub) {
    // Two lines: the mark, and what it jumps to.
    return (
      <span
        aria-hidden="true"
        // The two lines (a mark and "al Fine", or a mark and a coda sign) sit a little high: nudge them.
        className={cn(
          "pointer-events-none flex flex-col items-center gap-0.5",
          visual.sub.glyph ? "translate-y-[1.8px]" : "translate-y-[1.5px]",
        )}
      >
        <MarkText centre={false} className="text-[0.7rem] leading-none font-bold">
          {visual.mark}
        </MarkText>
        <span className="inline-flex items-center gap-0.5 font-serif text-[0.58rem] leading-none font-semibold whitespace-nowrap italic">
          {visual.sub.text}
          {visual.sub.glyph && (
            <Glyph
              name={visual.sub.glyph}
              className="[translate:none] text-[0.72rem] [font-weight:400] [font-style:normal]"
            />
          )}
        </span>
      </span>
    );
  }
  if (visual.glyph) {
    return (
      <span className="pointer-events-none inline-flex items-center gap-0.5">
        <Glyph
          name={visual.glyph}
          className={cn(visual.small && "text-[0.95rem]", visual.glyphClass)}
        />
        {visual.text && <LabelText>{visual.text}</LabelText>}
      </span>
    );
  }
  if (visual.mark !== undefined) return <MarkText>{visual.mark}</MarkText>;
  return <LabelText className="pointer-events-none">{visual.text}</LabelText>;
}

const CELL =
  "palette-cell inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent p-0 text-sidebar-foreground outline-none disabled:pointer-events-none disabled:opacity-40";

/** The size of a cell in the palette (32px) and in a box (34px). */
const SIZE = { cell: "size-8", box: "size-[34px]" } as const;

export interface PaletteCellProps {
  label: string;
  /** The written mark the icon shows; it becomes part of the accessible name. */
  mark?: string;
  shortcut?: string;
  /** A toggle: `aria-pressed` true, false or mixed. Actions leave it out. */
  state?: ToggleState;
  /** A radio of a group: `role=radio` with `aria-checked`. */
  checked?: boolean;
  disabled?: boolean;
  tabIndex?: number;
  size?: keyof typeof SIZE;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  /** Set on the cells of a box: arrow keys move between them. */
  "data-box-item"?: boolean;
}

/**
 * One icon-only button of the edit palette: 32px, rounded, transparent until the pointer or the
 * keyboard reaches it (the hover and focus effect is `.palette-cell` in `index.css`). The name
 * shows in a tooltip on hover and focus and is the accessible name. A click does not take focus
 * from the score, so typing carries on there.
 */
export function PaletteCell({
  label,
  mark,
  shortcut,
  state,
  checked,
  disabled,
  tabIndex,
  size = "cell",
  className,
  style,
  onClick,
  onKeyDown,
  children,
  ...rest
}: PaletteCellProps) {
  const on = checked ?? state === "on";
  const pressed = state === "mixed" ? "mixed" : on;
  const button = (
    <button
      type="button"
      data-slot="palette-button"
      data-box-item={rest["data-box-item"] ? "" : undefined}
      role={checked === undefined ? undefined : "radio"}
      aria-checked={checked}
      aria-label={markedName(label, mark)}
      aria-pressed={checked === undefined && state !== undefined ? pressed : undefined}
      data-state={on ? "on" : "off"}
      disabled={disabled}
      tabIndex={tabIndex}
      style={style}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.preventDefault()} // typing continues in the score
      className={cn(CELL, SIZE[size], state && PRESSED[state], checked && PRESSED.on, className)}
    >
      {children}
    </button>
  );
  return <Tip label={shortcut ? `${label} (${shortcut})` : label}>{button}</Tip>;
}

export interface VariantCellProps {
  box: PaletteBox;
  /** The groups of the box that exist on this track (never empty). */
  groups: PaletteGroup[];
  stateOf: (item: PaletteItem) => ToggleState;
  isDisabled: (item: PaletteItem) => boolean;
  /** Runs an item's action; true when it opens a dialog (focus must not go back to the score). */
  onPick: (item: PaletteItem) => boolean | void;
  /** Gives focus back to the score once a pick is done. */
  onDone: () => void;
  /** What the cell shows instead of the active or last picked variant (time signature). */
  shown?: { visual: PaletteVisual; label: string };
  /** Extra controls under the grid; `done` closes the box and hands focus to the score. */
  footer?: (done: () => void) => ReactNode;
}

/**
 * A palette cell that opens a box of variants (key, tempo, slide, harmonic...). The cell shows
 * the variant that is on, else the one picked last. The box is a group of icon-only buttons:
 * arrow keys move in two dimensions, Escape closes it and returns to the cell, a pick runs and
 * hands focus back to the score.
 */
export function VariantCell({
  box,
  groups,
  stateOf,
  isDisabled,
  onPick,
  onDone,
  shown,
  footer,
}: VariantCellProps) {
  const [open, setOpen] = useState(false);
  const [lastPick, setLastPick] = useState<string | null>(null);
  // How the box closed: a pick sends focus to the score (or to the dialog it opened); Escape or
  // leaving the box is left to Radix (Escape returns to the cell).
  const [closing, setClosing] = useState<"score" | "dialog" | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);

  const items = groups.flatMap((g) => g.items);
  const active = items.find((item) => !item.neutral && stateOf(item) !== "off");
  const activeState = active ? stateOf(active) : "off";
  const last = items.find((item) => item.id === lastPick);
  const visual = shown?.visual ?? active?.visual ?? last?.visual ?? box.idle ?? items[0]!.visual;
  const current = shown?.label ?? active?.label;
  const lit = !box.setting && activeState !== "off";

  const name = withVisibleText(
    box.setting
      ? `${box.label}${current ? `, ${current}` : ""}`
      : active
        ? `${box.label}, ${active.label} (on)`
        : box.label,
    visual,
  );
  const tip = box.setting && current ? `${box.label}: ${current}` : box.label;

  // A box scrolls only when its content is taller than the room the window leaves it. The size of
  // the content is measured from its two blocks: the glyph boxes inside are taller than they look.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!open || !el?.firstElementChild || !el.lastElementChild) return;
    const room = parseFloat(
      getComputedStyle(el).getPropertyValue("--radix-popover-content-available-height"),
    );
    const content =
      (el.firstElementChild as HTMLElement).offsetHeight +
      8 +
      (el.lastElementChild as HTMLElement).offsetHeight +
      24;
    setScrolls(Number.isFinite(room) && content > room);
  }, [open]);

  const close = () => setOpen(false);
  /** For the controls under the grid: closes the box and hands focus to the score. */
  const finish = () => {
    setClosing("score");
    close();
  };
  const pick = (item: PaletteItem) => {
    // A dialog takes focus on its own; the score gets it for everything else.
    setClosing(onPick(item) === true ? "dialog" : "score");
    if (!item.neutral && item.action.type !== "nestedTuplet") setLastPick(item.id);
    close();
  };

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    // A tooltip on the focused variant takes the first Escape: the box closes on it too.
    if (event.key === "Escape" && target instanceof Node && contentRef.current?.contains(target)) {
      setOpen(false);
      return;
    }
    if (!(target instanceof HTMLElement) || !target.hasAttribute("data-box-item")) return;
    const buttons = [
      ...(contentRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-box-item]:not(:disabled)",
      ) ?? []),
    ];
    const index = buttons.indexOf(target as HTMLButtonElement);
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: box.columns,
      ArrowUp: -box.columns,
    }[event.key];
    let next: number | undefined;
    if (step !== undefined) next = index + step;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    if (next >= 0 && next < buttons.length) buttons[next]!.focus();
  };

  let order = 0;
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (value) setClosing(null);
        setOpen(value);
      }}
    >
      <Tip label={tip} suppress={open}>
        <PopoverTrigger
          aria-haspopup="true"
          aria-label={name}
          data-slot="palette-button"
          data-state={lit ? "on" : open ? "open" : "closed"}
          // No preventDefault on mouse down here: the box takes focus, and gives it back.
          className={cn(
            CELL,
            SIZE.cell,
            lit && (activeState === "mixed" ? PRESSED.mixed : ACTIVE_BRAND),
          )}
        >
          <CellVisual visual={visual} />
          {/* A corner mark says the cell opens a box of variants. */}
          <span
            aria-hidden="true"
            className="absolute right-0.5 bottom-0.5 size-1.5 bg-current opacity-70 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
          />
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        ref={contentRef}
        role="group"
        aria-label={box.label}
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className={cn(
          "dark palette-box w-max max-w-[calc(100vw-1rem)] p-3 text-popover-foreground",
          // Only a box taller than the window scrolls (the glyph boxes would show a scrollbar otherwise).
          scrolls && "max-h-(--radix-popover-content-available-height) overflow-y-auto",
        )}
        onKeyDown={move}
        onOpenAutoFocus={(event) => {
          // Into the box: on the variant that is on, else the first.
          event.preventDefault();
          const buttons = contentRef.current?.querySelectorAll<HTMLButtonElement>(
            "[data-box-item]:not(:disabled)",
          );
          const start =
            contentRef.current?.querySelector<HTMLButtonElement>(
              "[data-box-item][data-state=on]",
            ) ??
            buttons?.[0] ??
            contentRef.current;
          start?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!closing) return; // Escape returns to the cell
          event.preventDefault();
          if (closing === "score") onDone();
        }}
      >
        <div
          aria-hidden="true"
          className="mb-2 text-[0.7rem] font-medium tracking-wider text-muted-foreground uppercase"
        >
          {box.label}
        </div>
        <div className="flex flex-col gap-2">
          {groups.map((group, g) => (
            <div
              key={group.label ?? g}
              role={group.label ? "group" : undefined}
              aria-label={group.label}
              className="flex flex-col gap-1"
            >
              {group.label && groups.length > 1 && (
                <div aria-hidden="true" className="text-[0.65rem] text-muted-foreground">
                  {group.label}
                </div>
              )}
              <div
                className="palette-box-grid grid gap-1"
                style={{ gridTemplateColumns: `repeat(${box.columns}, 34px)` }}
              >
                {group.items.map((item) => (
                  <PaletteCell
                    key={item.id}
                    size="box"
                    data-box-item
                    label={item.label}
                    mark={item.mark ?? missingVisible(item.label, item.visual)}
                    shortcut={item.shortcut}
                    state={item.action.type === "nestedTuplet" ? undefined : stateOf(item)}
                    disabled={isDisabled(item)}
                    style={
                      {
                        "--i": order++,
                        gridColumn: item.span ? `span ${item.span}` : undefined,
                      } as CSSProperties
                    }
                    onClick={() => pick(item)}
                  >
                    <CellVisual visual={item.visual} />
                  </PaletteCell>
                ))}
              </div>
            </div>
          ))}
          {footer?.(finish)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
