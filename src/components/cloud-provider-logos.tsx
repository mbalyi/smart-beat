import type { SVGProps } from "react";

import type { CloudProvider } from "@/lib/cloud";

type LogoProps = SVGProps<SVGSVGElement>;

/** Google Drive: the three-colour triangle, simplified. */
export function GoogleDriveLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 48 42" aria-hidden="true" focusable="false" {...props}>
      <path d="M16 0h16l16 28H32z" fill="#fbbc04" />
      <path d="M16 0 0 28l8 14 16-28z" fill="#34a853" />
      <path d="M8 42h32l8-14H16z" fill="#4285f4" />
      <path d="M32 28h16l-8 14H24z" fill="#ea4335" />
    </svg>
  );
}

/** Dropbox: the open box of four blue diamonds. */
export function DropboxLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 48 42" aria-hidden="true" focusable="false" {...props}>
      <g fill="#0061ff">
        <path d="M12 0 24 7.5 12 15 0 7.5z" />
        <path d="M36 0 48 7.5 36 15 24 7.5z" />
        <path d="M12 15 24 22.5 12 30 0 22.5z" />
        <path d="M36 15 48 22.5 36 30 24 22.5z" />
        <path d="M24 25 36 32.5 24 40 12 32.5z" />
      </g>
    </svg>
  );
}

/** OneDrive: the blue cloud. */
export function OneDriveLogo(props: LogoProps) {
  return (
    <svg viewBox="0 0 48 32" aria-hidden="true" focusable="false" {...props}>
      <path
        d="M19 4a11 11 0 0 1 10 6 9 9 0 0 1 3-.5 9.5 9.5 0 0 1 9.5 9.5 7 7 0 0 1-1 13.5H11A9.5 9.5 0 0 1 9 14a11 11 0 0 1 10-10z"
        fill="#0f78d4"
      />
      <path
        d="M19 4a11 11 0 0 1 10 6A9 9 0 0 0 20 20H9a9.5 9.5 0 0 1 0-6A11 11 0 0 1 19 4z"
        fill="#28a8ea"
      />
    </svg>
  );
}

/** The logo of one provider. */
export function CloudProviderLogo({ provider, ...props }: LogoProps & { provider: CloudProvider }) {
  if (provider === "drive") return <GoogleDriveLogo {...props} />;
  if (provider === "dropbox") return <DropboxLogo {...props} />;
  return <OneDriveLogo {...props} />;
}
