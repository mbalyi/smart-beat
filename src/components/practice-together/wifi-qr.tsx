import { qrPath } from "@/lib/practice-together/wifi-qr";

type Props = {
  /** The Wi-Fi QR text (`WIFI:T:WPA;S:…;P:…;;`). */
  text: string;
  /** What a screen reader hears. */
  label: string;
  className?: string;
};

/**
 * A Wi-Fi QR code: a phone camera joins the network with it. Always dark on white, in light and
 * dark mode alike, because scanners expect that.
 */
export function WifiQr({ text, label, className }: Props) {
  const { path, size } = qrPath(text);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={className}
      data-testid="wifi-qr"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
