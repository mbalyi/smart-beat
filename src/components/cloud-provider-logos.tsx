import type { ImgHTMLAttributes } from "react";

import dropboxLogo from "@/assets/cloud/logos/dropbox.svg";
import googleDriveLogo from "@/assets/cloud/logos/google-drive.svg";
import oneDriveLogo from "@/assets/cloud/logos/onedrive.svg";
import type { CloudProvider } from "@/lib/cloud";

type LogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "children">;

/**
 * The official app logos of the three cloud services, unaltered (see
 * `src/assets/cloud/logos/README.md` for sources and trademark notices). They only identify the
 * service the user connects. Width and height keep the official proportions of each logo.
 */
function Logo({ src, width, height, ...props }: LogoProps & { src: string }) {
  return <img src={src} alt="" aria-hidden="true" width={width} height={height} {...props} />;
}

/** Google Drive: the three-colour triangle (2020 icon). */
export function GoogleDriveLogo(props: LogoProps) {
  return <Logo src={googleDriveLogo} width={87} height={78} {...props} />;
}

/** Dropbox: the open box glyph, official blue #0061FF. */
export function DropboxLogo(props: LogoProps) {
  return <Logo src={dropboxLogo} width={232} height={197} {...props} />;
}

/** Microsoft OneDrive: the blue cloud (2025 icon). */
export function OneDriveLogo(props: LogoProps) {
  return <Logo src={oneDriveLogo} width={648} height={431} {...props} />;
}

/** The logo of one provider. */
export function CloudProviderLogo({ provider, ...props }: LogoProps & { provider: CloudProvider }) {
  if (provider === "drive") return <GoogleDriveLogo {...props} />;
  if (provider === "dropbox") return <DropboxLogo {...props} />;
  if (provider === "onedrive") return <OneDriveLogo {...props} />;
  return null;
}
