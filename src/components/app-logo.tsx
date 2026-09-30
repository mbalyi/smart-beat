import type { ComponentProps } from "react";

import appIcon from "@/assets/app-icon.png";

/**
 * Decorative app mark: the app icon's artwork (src-tauri/icons/smart-beat-icon.svg,
 * rendered to a PNG so the header doesn't draw its 1,300 traced paths).
 */
export function AppLogo(props: ComponentProps<"img">) {
  return <img src={appIcon} alt="" aria-hidden="true" draggable={false} {...props} />;
}
