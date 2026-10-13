import { useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A place to drop an audio file, with a button to browse for one. In the desktop app a file
 * dropped on the window arrives through the app instead; the dialog passes it on itself.
 */
export function AudioDropArea({
  extensions,
  disabled = false,
  chosen = false,
  onFile,
  className,
  children,
}: {
  /** File extensions without the dot, such as `mp3`. */
  extensions: readonly string[];
  disabled?: boolean;
  /** A file is chosen already: the button offers to replace it. */
  chosen?: boolean;
  onFile: (file: File | undefined) => void;
  className?: string;
  /** What is shown under the button, such as the chosen file. */
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled) onFile(event.dataTransfer.files[0]);
  };
  return (
    <div
      className={cn("rounded-md border border-dashed p-4", className)}
      role="region"
      aria-label="Audio drop area"
    >
      <p className="mb-3 text-sm">
        Drop an audio file here, or browse. {extensions.join(", ").toUpperCase()}.
      </p>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label="Choose an audio recording"
        accept={extensions.map((ext) => `.${ext}`).join(",")}
        disabled={disabled}
        onChange={(event) => {
          onFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
      >
        {chosen ? "Replace recording…" : "Choose recording…"}
      </Button>
      {children}
    </div>
  );
}
