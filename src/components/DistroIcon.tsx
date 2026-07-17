import type { ReactNode } from "react";
import { Server } from "lucide-react";

/*
 * Inline SVG logos for the remote OS ids reported by the backend `ssh-remote-os`
 * event. Self-contained on purpose: no icon dependency is added. The glyphs are
 * deliberately simple, brand-tinted representations (distro logos are
 * trademarks) that stay recognizable at tab-bar sizes (~12px). Any id without a
 * glyph — including "unknown" — falls back to the generic Lucide Server icon so
 * behavior is unchanged when detection is absent or fails.
 */

type DistroIconProps = {
  osId: string;
  size?: number;
  className?: string;
  /** Accessible label / tooltip (e.g. the remote PRETTY_NAME). */
  label?: string;
};

function Glyph({
  size,
  className,
  label,
  children,
}: {
  size: number;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={label}
    >
      {label ? <title>{label}</title> : null}
      {children}
    </svg>
  );
}

// Each entry renders inside a 24x24 viewBox. Kept intentionally small.
const GLYPHS: Record<string, ReactNode> = {
  ubuntu: (
    <>
      <circle cx="12" cy="12" r="11" fill="#E95420" />
      <circle cx="12" cy="12" r="4.1" fill="none" stroke="#fff" strokeWidth="1.7" />
      <circle cx="20" cy="12" r="2.1" fill="#fff" />
      <circle cx="8" cy="18.9" r="2.1" fill="#fff" />
      <circle cx="8" cy="5.1" r="2.1" fill="#fff" />
    </>
  ),
  debian: (
    <>
      <circle cx="12" cy="12" r="11" fill="#fff" />
      <path
        d="M13 6.2a5.8 5.8 0 1 0 4.8 8.7 4.6 4.6 0 1 1-4.2-6.6 3.3 3.3 0 0 0-.6-2.1z"
        fill="#A81D33"
      />
    </>
  ),
  fedora: (
    <>
      <circle cx="12" cy="12" r="11" fill="#51A2DA" />
      <path
        d="M14.6 7.2a3.4 3.4 0 0 0-3.4 3.4V17"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path d="M8.7 12.4h4.3" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
    </>
  ),
  rhel: (
    <>
      <circle cx="12" cy="12" r="11" fill="#EE0000" />
      <path d="M9 11.5c0-2 1.4-3.2 3-3.2s3 1.2 3 3.2" fill="#fff" />
      <path d="M6 14.4c0-1.2 2.4-2.1 6-2.1s6 .9 6 2.1v1.4H6z" fill="#fff" />
    </>
  ),
  centos: (
    <>
      <rect x="2.5" y="2.5" width="8.5" height="8.5" rx="1" fill="#9CCD2A" />
      <rect x="13" y="2.5" width="8.5" height="8.5" rx="1" fill="#932279" />
      <rect x="2.5" y="13" width="8.5" height="8.5" rx="1" fill="#EFA724" />
      <rect x="13" y="13" width="8.5" height="8.5" rx="1" fill="#262577" />
    </>
  ),
  rocky: (
    <>
      <path d="M12 2 3 12l9 10 9-10z" fill="#10B981" />
      <path d="M12 7 8 12l4 5 4-5z" fill="#fff" opacity="0.35" />
    </>
  ),
  almalinux: (
    <>
      <circle cx="12" cy="12" r="11" fill="#0B2D5B" />
      <path
        d="M12 6.5 16.5 17H14l-2-5-2 5H7.5z"
        fill="#fff"
      />
    </>
  ),
  arch: <path d="M12 3 3.2 20.4h3.5L12 9.8l5.3 10.6h3.5z" fill="#1793D1" />,
  manjaro: (
    <g fill="#35BF5C">
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="12" y="3" width="9" height="8" rx="1" />
      <rect x="12" y="13" width="9" height="8" rx="1" />
    </g>
  ),
  alpine: (
    <>
      <circle cx="12" cy="12" r="11" fill="#0D597F" />
      <path d="M6 16 9.2 10.5l2.3 3.3 3-6 4.5 8.2z" fill="#fff" />
    </>
  ),
  opensuse: (
    <>
      <circle cx="12" cy="12" r="11" fill="#73BA25" />
      <path d="M6.5 13c2.2-4 8.8-4 11 0-2.7 2.3-8.3 2.3-11 0z" fill="#fff" />
      <circle cx="12" cy="12" r="1.6" fill="#73BA25" />
    </>
  ),
  suse: (
    <>
      <circle cx="12" cy="12" r="11" fill="#73BA25" />
      <path d="M6.5 13c2.2-4 8.8-4 11 0-2.7 2.3-8.3 2.3-11 0z" fill="#fff" />
      <circle cx="12" cy="12" r="1.6" fill="#73BA25" />
    </>
  ),
  mint: (
    <>
      <circle cx="12" cy="12" r="11" fill="#8DBF42" />
      <path
        d="M5 8.5h8.8a4.7 4.7 0 0 1 4.7 4.7V19h-2.9v-5.8a2 2 0 0 0-2-2h-1.1V19H8.9v-7.8H5z"
        fill="#fff"
      />
    </>
  ),
  kali: (
    <>
      <circle cx="12" cy="12" r="11" fill="#1A1A1A" />
      <path d="M8.5 4.5v15" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M8.5 13 15 8M8.5 13l6.5 6.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  nixos: (
    <g strokeWidth="2.2" fill="none" strokeLinecap="round">
      <path d="M12 3v18" stroke="#7EBAE4" />
      <path d="M4.2 7.5 19.8 16.5" stroke="#5277C3" />
      <path d="M19.8 7.5 4.2 16.5" stroke="#5277C3" />
    </g>
  ),
  amazon: (
    <>
      <circle cx="12" cy="12" r="11" fill="#232F3E" />
      <path
        d="M6.5 13.5c3.3 3 9.7 3 13 0"
        fill="none"
        stroke="#FF9900"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M17.5 15.5 20 13l.4 3z" fill="#FF9900" />
    </>
  ),
  oracle: (
    <ellipse
      cx="12"
      cy="12"
      rx="10"
      ry="6"
      fill="none"
      stroke="#C74634"
      strokeWidth="2.6"
    />
  ),
  raspbian: (
    <>
      <path d="M12 8.5C11 5.5 7.8 5.3 6.5 6.8c.2 2.3 2.6 3 3.6 2.8z" fill="#75A928" />
      <path d="M12 8.5C13 5.5 16.2 5.3 17.5 6.8c-.2 2.3-2.6 3-3.6 2.8z" fill="#75A928" />
      <g fill="#C51A4A">
        <circle cx="10" cy="12" r="2" />
        <circle cx="14" cy="12" r="2" />
        <circle cx="8.4" cy="15" r="2" />
        <circle cx="12" cy="15.4" r="2" />
        <circle cx="15.6" cy="15" r="2" />
        <circle cx="10.4" cy="18.2" r="2" />
        <circle cx="13.6" cy="18.2" r="2" />
      </g>
    </>
  ),
  gentoo: (
    <>
      <circle cx="12" cy="12" r="11" fill="#54487A" />
      <path
        d="M15.8 9.2c-1.3-1.9-4.3-2-6.1-.3-1.8 1.2-1.9 3.8-.1 5 1.9 1.2 4.7 1 5.9-.9-1.7 1.2-4.4.7-5.2-1 2.6 1 5.4-.7 5.5-2.8z"
        fill="#fff"
      />
    </>
  ),
  void: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="#478061" strokeWidth="2.6" />
      <circle cx="12" cy="12" r="3.4" fill="#478061" />
    </>
  ),
  freebsd: (
    <>
      <path
        d="M7.5 4 10 8M16.5 4 14 8"
        stroke="#AB2B28"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="13" r="9" fill="#AB2B28" />
      <circle cx="9.4" cy="11.5" r="1.4" fill="#fff" />
      <circle cx="14.6" cy="11.5" r="1.4" fill="#fff" />
    </>
  ),
  macos: (
    <path
      d="M16.3 12.4c0-2.1 1.7-3.1 1.8-3.2-1-1.4-2.5-1.6-3-1.6-1.3-.1-2.5.7-3.1.7-.6 0-1.6-.7-2.6-.7-1.4 0-2.6.8-3.3 2-1.4 2.4-.4 6 1 8 .7.9 1.4 2 2.5 1.9 1 0 1.4-.6 2.6-.6s1.5.6 2.6.6 1.7-.9 2.4-1.8c.7-1.1 1-2.1 1-2.1-.1 0-2-.8-2-3.1zM14.4 6.2c.5-.7 1-1.6.8-2.6-.8 0-1.8.6-2.4 1.2-.5.6-1 1.5-.9 2.4.9.1 1.9-.4 2.5-1z"
      fill="currentColor"
    />
  ),
  windows: (
    <g fill="#0078D4">
      <rect x="3" y="3" width="8" height="8" />
      <rect x="13" y="3" width="8" height="8" />
      <rect x="3" y="13" width="8" height="8" />
      <rect x="13" y="13" width="8" height="8" />
    </g>
  ),
  linux: (
    <>
      <ellipse cx="12" cy="14" rx="6" ry="7.5" fill="#111827" />
      <ellipse cx="12" cy="16" rx="3.8" ry="5.2" fill="#F3F4F6" />
      <circle cx="12" cy="6.5" r="4" fill="#111827" />
      <circle cx="10.6" cy="6.3" r="1" fill="#fff" />
      <circle cx="13.4" cy="6.3" r="1" fill="#fff" />
      <circle cx="10.6" cy="6.3" r="0.4" fill="#111827" />
      <circle cx="13.4" cy="6.3" r="0.4" fill="#111827" />
      <path d="M10.7 8.2h2.6L12 10z" fill="#F9C22B" />
      <ellipse cx="9" cy="21" rx="2.4" ry="1.1" fill="#F9C22B" />
      <ellipse cx="15" cy="21" rx="2.4" ry="1.1" fill="#F9C22B" />
    </>
  ),
};

/**
 * Render the logo for a remote OS id. Falls back to the generic Server icon for
 * "unknown" and any unrecognized id, so callers can pass an id unconditionally.
 */
export function DistroIcon({ osId, size = 12, className, label }: DistroIconProps) {
  const glyph = GLYPHS[osId];
  if (!glyph) {
    return <Server size={size} className={className} aria-label={label ?? "server"} />;
  }
  return (
    <Glyph size={size} className={className} label={label ?? osId}>
      {glyph}
    </Glyph>
  );
}
