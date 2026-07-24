const R = "\x1b[0m";
const b = (s: string) => `\x1b[1m${s}${R}`;
const dim = (s: string) => `\x1b[90m${s}${R}`;
const green = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const red = (s: string) => `\x1b[31m${s}${R}`;
const blue = (s: string) => `\x1b[34m${s}${R}`;
const orange = (s: string) => `\x1b[38;2;233;84;32m${s}${R}`;

const crlf = (lines: string[]) => lines.join("\r\n");

const prompt = (user: string, host: string, path: string) =>
  `${green(`${user}@${host}`)}:${blue(path)}$ `;

const UBUNTU_LOGO = [
"                             ....          ",
"              .',:clooo:  .:looooo:.       ",
"           .;looooooooc  .oooooooooo'      ",
"        .;looooool:,''.  :ooooooooooc      ",
"       ;looool;.         'oooooooooo,      ",
"      ;clool'             .cooooooc.  ,,   ",
"         ...                ......  .:oo,  ",
"  .;clol:,.                        .loooo' ",
" :ooooooooo,                        'ooool ",
"'ooooooooooo.                        loooo.",
"'ooooooooool                         coooo.",
" ,loooooooc.                        .loooo.",
"   .,;;;'.                          ;ooooc ",
"       ...                         ,ooool. ",
"    .cooooc.              ..',,'.  .cooo.  ",
"      ;ooooo:.           ;oooooooc.  :l.   ",
"       .coooooc,..      coooooooooo.       ",
"         .:ooooooolc:. .ooooooooooo'       ",
"           .':loooooo;  ,oooooooooc        ",
"               ..';::c'  .;loooo:'         "
];
const LOGO_W = 41;
const GAP = "   ";

const UBUNTU_INFO = [
  b("ubuntu@vps-0cd97c22"),
  orange("-------------------"),
  `${orange("OS")}: Ubuntu 25.04 x86_64`,
  `${orange("Host")}: OpenStack Nova (19.3.2)`,
  `${orange("Kernel")}: Linux 6.14.0-37-generic`,
  `${orange("Uptime")}: 12 days, 19 hours, 23 mins`,
  `${orange("Packages")}: 700 (dpkg)`,
  `${orange("Shell")}: zsh 5.9`,
  `${orange("Terminal")}: /dev/pts/0`,
  `${orange("CPU")}: 2 × AMD EPYC 7B12 (Zen 4)`,
  `${orange("GPU")}: Cirrus Logic GD 5446`,
  `${orange("Memory")}: 3.56 GiB / 7.57 GiB (${green("47%")})`,
  `${orange("Swap")}: Disabled`,
  `${orange("Disk (/)")}: 12 GiB / 71.60 GiB (${yellow("43%")})`,
  `${orange("Local IP (ens3)")}: 192.169.420.69`,
  `${orange("Locale")}: en_US.UTF-8`,
];

const paletteRow = (codes: number[]) =>
  codes.map((c) => `\x1b[${c}m   `).join("") + R;

const ubuntuFetch = (): string[] => {
  const lines = UBUNTU_LOGO.map((art, i) => {
    const info = UBUNTU_INFO[i] ? `${GAP}${UBUNTU_INFO[i]}` : "";
    return `${orange(art.padEnd(LOGO_W))}${info}`;
  });
  const pad = " ".repeat(LOGO_W) + GAP;
  lines.push(`${pad}${paletteRow([40, 41, 42, 43, 44, 45, 46, 47])}`);
  lines.push(`${pad}${paletteRow([100, 101, 102, 103, 104, 105, 106, 107])}`);
  return lines;
};

export const UBUNTU_SESSION = crlf([
  dim("Last login: Tue Jul 21 09:14:02 2026 from 158.69.198.20"),
  "",
  ...ubuntuFetch(),
  "",
  `${prompt("ubuntu", "vps-0cd97c22", "~")}ls`,
  `${blue("logs")}  ${blue("scripts")}  docker-compose.yml  notes.md`,
  "",
  `${prompt("ubuntu", "vps-0cd97c22", "~")}git status`,
  `On branch ${green("main")}`,
  `Your branch is up to date with '${red("origin/main")}'.`,
  "",
  "Changes not staged for commit:",
  `        ${red("modified:   docker-compose.yml")}`,
  "",
  `${prompt("ubuntu", "vps-0cd97c22", "~")}`,
]);
const UBUNTU_INFO_MOBILE = [
  b("ubuntu@vps-0cd97c22"),
  orange("-------------------"),
  `${orange("OS")}: Ubuntu 25.04 x86_64`,
  `${orange("Kernel")}: 6.14.0-37-generic`,
  `${orange("Uptime")}: 12 days, 19 hours`,
  `${orange("Packages")}: 700 (dpkg)`,
  `${orange("Shell")}: zsh 5.9`,
  `${orange("CPU")}: 2 × AMD EPYC 7B12`,
  `${orange("Memory")}: 3.56 / 7.57 GiB (${green("47%")})`,
  `${orange("Disk (/)")}: 12 / 71.6 GiB (${yellow("43%")})`,
  `${orange("Local IP")}: 192.169.420.69`,
];

export const UBUNTU_SESSION_MOBILE = crlf([
  dim("Last login: Tue Jul 21 09:14 2026"),
  "",
  ...UBUNTU_INFO_MOBILE,
  "",
  paletteRow([40, 41, 42, 43, 44, 45, 46, 47]),
  paletteRow([100, 101, 102, 103, 104, 105, 106, 107]),
  "",
  `${prompt("ubuntu", "vps-0cd97c22", "~")}ls`,
  `${blue("logs")}  ${blue("scripts")}  docker-compose.yml`,
  "",
  `${prompt("ubuntu", "vps-0cd97c22", "~")}git status`,
  `On branch ${green("main")}`,
  `Up to date with '${red("origin/main")}'.`,
  "",
  "Changes not staged for commit:",
  `  ${red("modified:   docker-compose.yml")}`,
  "",
  `${prompt("ubuntu", "vps-0cd97c22", "~")}`,
]);

export const DEBIAN_SESSION = crlf([
  dim("Linux db-primary 6.1.0-26-amd64 #1 SMP Debian 6.1.112-1 x86_64"),
  "",
  `${prompt("root", "db-primary", "~")}systemctl status postgresql`,
  `${green("●")} postgresql.service - PostgreSQL RDBMS`,
  `     Loaded: loaded (${dim("/lib/systemd/system/postgresql.service")}; enabled)`,
  `     Active: ${green("active (running)")} since Fri 2026-06-06; 45 days ago`,
  `   Main PID: 812 (postgres)`,
  `      Tasks: 24 (limit: 9509)`,
  `     Memory: 412.6M`,
  "",
  `${prompt("root", "db-primary", "~")}pg_lsclusters`,
  `${b("Ver Cluster Port Status Owner    Data directory")}`,
  `16  main    5432 ${green("online")} postgres /var/lib/postgresql/16/main`,
  "",
  `${prompt("root", "db-primary", "~")}tail -n 4 /var/log/pg/main.log`,
  dim("2026-07-21 09:12:41 UTC ") + green("LOG") + ":  checkpoint complete",
  dim("2026-07-21 09:13:02 UTC ") + green("LOG") + ":  autovacuum: analyze orders",
  dim("2026-07-21 09:13:55 UTC ") + yellow("WARNING") + ":  connections at 82% of max",
  dim("2026-07-21 09:14:10 UTC ") + green("LOG") + ":  replication client connected",
  "",
  `${prompt("root", "db-primary", "~")}`,
]);

export function fillerSession(user: string, host: string): string {
  return crlf([
    dim(`Connected to ${host}`),
    `${prompt(user, host, "~")}uptime`,
    ` 09:14:22 up 12 days,  3:41,  1 user,  load average: 0.05, 0.09, 0.06`,
    `${prompt(user, host, "~")}`,
  ]);
}
