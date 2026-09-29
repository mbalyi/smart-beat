import type { ComponentProps } from "react";

/** Decorative app mark (same artwork as the app icon). */
export function AppLogo(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="100 100 824 824" aria-hidden="true" focusable="false" {...props}>
      <defs>
        <linearGradient id="app-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#1E1B4B" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#app-logo-bg)" />
      <g fill="#FFFFFF">
        <ellipse cx="440" cy="700" rx="112" ry="84" transform="rotate(-22 440 700)" />
        <rect x="522" y="250" width="40" height="455" rx="20" />
        <path d="M542 250c70 30 170 90 170 200 0 40-12 80-34 112 6-26 8-50 4-72-14-70-80-110-140-126z" />
      </g>
    </svg>
  );
}
