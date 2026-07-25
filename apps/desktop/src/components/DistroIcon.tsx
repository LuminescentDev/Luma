import { Server } from "lucide-react";
import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siManjaro,
  siNixos,
  siOpensuse,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siSuse,
  siUbuntu,
  siVoidlinux,
  type SimpleIcon,
} from "simple-icons";

type DistroIconProps = {
  osId: string;
  size?: number;
  className?: string;
  /** Accessible label / tooltip (e.g. the remote PRETTY_NAME). */
  label?: string;
};

type BrandGlyph = Pick<SimpleIcon, "title" | "path" | "hex">;

// Simple Icons supplies the official brand paths and brand colors. Closely
// related distributions use their own mark when available and otherwise the
// upstream family mark (Amazon/Oracle Linux use Tux rather than a fabricated
// distro logo). The Windows mark is the official four-pane silhouette, which
// Simple Icons does not currently distribute.
const WINDOWS: BrandGlyph = {
  title: "Windows",
  hex: "0078D4",
  path: "M1 2.25 10.75.9v10.35H1V2.25Zm10.75-1.49L23 0v11.25H11.75V.76ZM1 12.25h9.75V22.6L1 21.25v-9Zm10.75 0H23V24l-11.25-1.55v-10.2Z",
};

const AMAZON_LINUX: BrandGlyph = {
  ...siLinux,
  title: "Amazon Linux",
  hex: "FF9900",
};

const ORACLE_LINUX: BrandGlyph = {
  ...siLinux,
  title: "Oracle Linux",
  hex: "F80000",
};

const BRANDS: Record<string, BrandGlyph> = {
  ubuntu: siUbuntu,
  debian: siDebian,
  fedora: siFedora,
  rhel: siRedhat,
  centos: siCentos,
  rocky: siRockylinux,
  almalinux: siAlmalinux,
  arch: siArchlinux,
  manjaro: siManjaro,
  alpine: siAlpinelinux,
  opensuse: siOpensuse,
  suse: siSuse,
  mint: siLinuxmint,
  kali: siKalilinux,
  gentoo: siGentoo,
  void: siVoidlinux,
  nixos: siNixos,
  amazon: AMAZON_LINUX,
  oracle: ORACLE_LINUX,
  raspbian: siRaspberrypi,
  freebsd: siFreebsd,
  macos: siApple,
  windows: WINDOWS,
  linux: siLinux,
};

/** Render an official distro/platform brand glyph when one is known. */
export function DistroIcon({
  osId,
  size = 12,
  className,
  label,
}: DistroIconProps) {
  const brand = BRANDS[osId];
  if (!brand) {
    return (
      <Server
        size={size}
        className={className}
        aria-label={label ?? "server"}
      />
    );
  }

  // Pure black official marks disappear on Luma's dark surface. Keep their
  // official path while inheriting the theme foreground color.
  const fill = brand.hex === "000000" ? "currentColor" : `#${brand.hex}`;
  const accessibleLabel = label ?? brand.title;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={accessibleLabel}
    >
      <title>{accessibleLabel}</title>
      <path d={brand.path} fill={fill} />
    </svg>
  );
}
