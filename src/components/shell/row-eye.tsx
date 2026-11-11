import { EyeIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Toggle } from "@/components/ui/toggle";

/** Room of a row's reorder handle (size-6 and its right margin), also kept free where it is not. */
export const ROW_HANDLE_SLOT = "mr-0.5 size-6 shrink-0";

/**
 * The eye column of a track row (tab or audio lane): an optional leading control such as the
 * reorder handle, then the eye. Tab rows and lane rows use this one component so the eye has the
 * same size, shape, states and place in every row. `keepHandleRoom` leaves the handle's room free
 * in a row that has none, so the eyes of all rows line up when the handles show.
 */
export function RowEye({
  pressed,
  onPressedChange,
  disabled,
  label,
  title,
  handle,
  keepHandleRoom = false,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  disabled?: boolean;
  label: string;
  title: string;
  handle?: ReactNode;
  keepHandleRoom?: boolean;
}) {
  return (
    <div className="flex items-center" data-testid="row-eye">
      {handle ?? (keepHandleRoom && <span aria-hidden="true" className={ROW_HANDLE_SLOT} />)}
      <Toggle
        size="sm"
        pressed={pressed}
        disabled={disabled}
        onPressedChange={onPressedChange}
        aria-label={label}
        title={title}
        className="size-7 min-w-7 px-0"
      >
        <EyeIcon />
      </Toggle>
    </div>
  );
}
