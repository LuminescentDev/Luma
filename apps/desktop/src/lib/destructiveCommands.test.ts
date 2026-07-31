import { describe, expect, it } from "vitest";
import { classifyDraft, type DestructiveLevel } from "./destructiveCommands";

/** Labels that fired, for order-independent assertions. */
function labels(draft: string): string[] {
  return classifyDraft(draft).matches.map((m) => m.label);
}

function level(draft: string): DestructiveLevel {
  return classifyDraft(draft).level;
}

/** Assert the draft fires a rule whose label contains `needle`, at `expected`. */
function expectFlagged(
  draft: string,
  expected: Exclude<DestructiveLevel, "none">,
  needle: string,
) {
  const report = classifyDraft(draft);
  expect(report.level, `level for ${JSON.stringify(draft)}`).toBe(expected);
  expect(
    report.matches.some((m) => m.label.toLowerCase().includes(needle.toLowerCase())),
    `expected a ${needle} match in ${JSON.stringify(draft)}, got ${JSON.stringify(
      report.matches.map((m) => m.label),
    )}`,
  ).toBe(true);
}

describe("classifyDraft — nothing to flag", () => {
  it("returns none for empty and whitespace drafts", () => {
    for (const draft of ["", "   ", "\n\t\n"]) {
      expect(classifyDraft(draft)).toEqual({ level: "none", matches: [] });
    }
  });

  it("leaves ordinary commands alone", () => {
    for (const draft of [
      "ls -la",
      "git status",
      "cd /var/www && npm ci",
      "docker ps -a",
      "tail -f /var/log/syslog",
      "grep -rn TODO src/",
      "systemctl status nginx",
      "kubectl get pods -n prod",
      "cargo test --all-targets",
      "cp -r src dst",
      "mv old new",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — rm", () => {
  it("flags rm -rf as danger in every spelling", () => {
    for (const draft of [
      "rm -rf /",
      "rm -fr /var/lib",
      "rm -r -f build",
      "rm -f -R node_modules",
      "rm --recursive --force dist",
      "sudo rm -rf /opt/app",
      "rm    -rf    target",
      "rm '-rf' /srv",
      'rm "-rf" /srv',
    ]) {
      expectFlagged(draft, "danger", "rm -rf");
    }
  });

  it("flags rm with only one of -r or -f as warn", () => {
    for (const draft of ["rm -r build", "rm -f stale.lock", "rm --force x"]) {
      expectFlagged(draft, "warn", "rm -r");
    }
  });

  it("does not double-report -rf as both danger and warn", () => {
    const report = classifyDraft("rm -rf /tmp/x");
    const rmLabels = report.matches.filter((m) => m.label.includes("delete"));
    expect(rmLabels).toHaveLength(1);
    expect(rmLabels[0].label).toContain("rm -rf");
  });

  it("ignores plain rm and rm-like words", () => {
    for (const draft of [
      "rm stale.txt",
      "echo information",
      "cat /etc/os-release # information",
      "npm run format",
      "grep -i rm README",
      "alarm --list",
      "systemctl restart alarm.service",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });

  it("finds rm -rf after a separator, not mid-word", () => {
    expectFlagged("cd /tmp && rm -rf junk", "danger", "rm -rf");
    expectFlagged("make clean; rm -rf dist", "danger", "rm -rf");
    expectFlagged("echo $(rm -rf x)", "danger", "rm -rf");
    // "confirm -rf" is not a command named rm.
    expect(level("./confirm -rf")).toBe("none");
  });
});

describe("classifyDraft — dd and filesystems", () => {
  it("flags dd with of= as danger", () => {
    expectFlagged("dd if=/dev/zero of=/dev/sda bs=1M", "danger", "dd of=");
    expectFlagged("sudo dd if=image.iso of=/dev/disk2", "danger", "dd of=");
  });

  it("flags read-only dd as warn", () => {
    expectFlagged("dd if=/dev/urandom bs=1M count=10", "warn", "dd if=");
  });

  it("ignores dd without operands and dd-like names", () => {
    expect(level("dd")).toBe("none");
    expect(level("ddrescue /dev/sda image.img")).toBe("none");
  });

  it("flags mkfs variants but not the word format", () => {
    expectFlagged("mkfs.ext4 /dev/sdb1", "danger", "mkfs");
    expectFlagged("sudo mkfs -t xfs /dev/sdb1", "danger", "mkfs");
    expectFlagged("mke2fs /dev/sdb1", "danger", "mkfs");
    for (const draft of [
      "npm run format",
      "cargo fmt",
      "echo 'disk format instructions'",
      "man mkfs.ext4".replace("mkfs.ext4", "filesystems"),
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });

  it("flags redirection onto a block device", () => {
    expectFlagged("cat image.img > /dev/sda", "danger", "block device");
    expectFlagged("echo x >/dev/nvme0n1", "danger", "block device");
  });
});

describe("classifyDraft — power state", () => {
  it("flags shutdown, reboot, halt and poweroff", () => {
    for (const draft of [
      "shutdown -h now",
      "sudo reboot",
      "halt",
      "poweroff",
      "sudo systemctl reboot",
      "init 0",
      "make build && sudo reboot",
    ]) {
      expectFlagged(draft, "danger", "power state");
    }
  });

  it("does not match reboot inside a path or an argument", () => {
    for (const draft of [
      "cat /var/log/reboot.log",
      "ls /etc/reboot.d",
      "grep reboot /var/log/syslog",
      "echo reboot",
      "tail -n 50 ~/reboot-history.txt",
      "systemctl status reboot-guard.service",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — permissions and ownership", () => {
  it("flags recursive 777 and recursive changes on /", () => {
    expectFlagged("chmod -R 777 /", "danger", "permission change on /");
    expectFlagged("sudo chmod -R 777 /var/www", "danger", "permission change on /");
    expectFlagged("chmod --recursive 777 /srv", "danger", "permission change on /");
    expectFlagged("sudo chown -R nobody:nogroup /", "danger", "ownership change on /");
  });

  it("warns on non-recursive 777", () => {
    expectFlagged("chmod 777 upload.sh", "warn", "world-writable");
  });

  it("ignores ordinary permission work", () => {
    for (const draft of [
      "chmod 644 file.txt",
      "chmod +x script.sh",
      "chmod -R 755 ./public",
      "chown -R app:app /srv/app",
      "chown me file.txt",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — fork bomb", () => {
  it("flags the classic fork bomb and spaced variants", () => {
    expectFlagged(":(){ :|:& };:", "danger", "fork bomb");
    expectFlagged(": ( ) { : | : & } ; :", "danger", "fork bomb");
    expectFlagged(":(){ :|:& } ; :", "danger", "fork bomb");
  });

  it("ignores ordinary shell functions and ternaries", () => {
    for (const draft of [
      "deploy() { npm ci && npm run build; }",
      "echo ${x:-default}",
      "test -f x && echo yes || echo no",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — pipe to shell", () => {
  it("flags curl/wget piped into an interpreter", () => {
    for (const draft of [
      "curl -fsSL https://example.com/install.sh | sh",
      "curl https://get.example.io | bash",
      "wget -qO- https://example.com/i.sh | sudo bash",
      "curl -sSf https://sh.rustup.rs | sh -s -- -y",
      "wget -O - https://example.com/x | python3",
      "curl https://example.com/x.rb | ruby",
    ]) {
      expectFlagged(draft, "danger", "pipe download");
    }
  });

  it("ignores curl and wget that do not feed a shell", () => {
    for (const draft of [
      "curl -fsSL https://example.com/api | jq .",
      "wget https://example.com/file.tar.gz",
      "curl -o out.json https://example.com/api",
      "curl https://example.com | grep -o 'sh'",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — git", () => {
  it("warns on force pushes", () => {
    for (const draft of [
      "git push --force",
      "git push -f origin main",
      "git push --force-with-lease origin feature",
      "git push origin main --force",
      "git -c foo=bar push --force",
    ]) {
      expectFlagged(draft, "warn", "force push");
    }
  });

  it("ignores ordinary git usage", () => {
    for (const draft of [
      "git push",
      "git push origin main",
      "git pull --rebase",
      "git commit -m 'force a rebuild'",
      "git log --format=%h",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — docker", () => {
  it("warns on docker rm -f and image prune, dangers on system prune", () => {
    expectFlagged("docker rm -f web", "warn", "force-remove containers");
    expectFlagged("docker container rm --force api", "warn", "force-remove containers");
    expectFlagged("docker system prune -a --volumes", "danger", "bulk docker cleanup");
    expectFlagged("docker volume prune", "danger", "bulk docker cleanup");
    expectFlagged("docker image prune", "warn", "docker cleanup");
  });

  it("ignores read-only and non-forced docker commands", () => {
    for (const draft of [
      "docker ps",
      "docker rm old-container",
      "docker logs -f web",
      "docker compose up -d",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — truncate, killall, iptables", () => {
  it("flags truncate -s 0", () => {
    expectFlagged("truncate -s 0 /var/log/app.log", "danger", "empty a file");
    expectFlagged("truncate -s0 app.log", "danger", "empty a file");
    expect(level("truncate -s 100M sparse.img")).toBe("none");
  });

  it("warns on killall", () => {
    expectFlagged("killall node", "warn", "kill processes");
    expectFlagged("sudo killall -9 nginx", "warn", "kill processes");
    expect(level("kill 1234")).toBe("none");
    expect(level("pgrep -l node")).toBe("none");
  });

  it("flags firewall flushes", () => {
    expectFlagged("iptables -F", "danger", "flush firewall");
    expectFlagged("sudo ip6tables --flush", "danger", "flush firewall");
    expectFlagged("nft flush ruleset", "danger", "flush firewall");
    expect(level("iptables -L -n")).toBe("none");
    expect(level("iptables -A INPUT -p tcp --dport 22 -j ACCEPT")).toBe("none");
  });
});

describe("classifyDraft — SQL one-liners", () => {
  it("flags drops and truncates through a database client", () => {
    for (const draft of [
      `psql -c "DROP DATABASE prod"`,
      `mysql -e 'drop table users'`,
      `psql -U app -c "TRUNCATE TABLE events"`,
      `mysql app -e "DELETE FROM sessions"`,
      `sqlite3 app.db "drop table cache"`,
    ]) {
      expectFlagged(draft, "danger", "destructive sql");
    }
  });

  it("ignores SQL words without a client, and read-only queries", () => {
    for (const draft of [
      "echo 'we should drop table cruft someday'",
      `psql -c "SELECT count(*) FROM users"`,
      "grep -rn 'DROP TABLE' migrations/",
      "cat drop_table_notes.md",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — truncating redirects", () => {
  it("warns on absolute paths outside home and the scratch dirs", () => {
    expectFlagged("echo '' > /etc/hosts", "warn", "truncating redirect");
    expectFlagged("cat cfg > /usr/local/etc/app.conf", "warn", "truncating redirect");
  });

  it("stays quiet for sinks, scratch dirs, relative and home paths", () => {
    for (const draft of [
      "make build > /dev/null 2>&1",
      "npm test > /tmp/test.log",
      "cmd > /var/tmp/out",
      "cmd > out.txt",
      "cmd > ./build/out.txt",
      "cmd > ~/notes.txt",
      "cmd > $HOME/notes.txt",
      "cmd >> /etc/hosts",
      "cmd 2>&1",
    ]) {
      expect(level(draft), draft).toBe("none");
    }
  });
});

describe("classifyDraft — reporting shape", () => {
  it("reports the worst level and lists danger matches first", () => {
    const report = classifyDraft("git push --force; sudo rm -rf /srv");
    expect(report.level).toBe("danger");
    expect(report.matches.length).toBeGreaterThanOrEqual(2);
    expect(report.matches[0].label).toContain("rm -rf");
    expect(report.matches.map((m) => m.label)).toContain(
      "Force push (git push --force)",
    );
  });

  it("gives a trimmed, separator-free snippet", () => {
    const report = classifyDraft("cd /tmp   &&   rm   -rf    junk");
    expect(report.matches[0].snippet).toBe("rm -rf");
    expect(report.matches[0].snippet.startsWith("&")).toBe(false);
  });

  it("clips very long snippets", () => {
    const report = classifyDraft(`chmod -R 777 /${"a".repeat(400)}`);
    expect(report.level).toBe("danger");
    expect(report.matches[0].snippet.length).toBeLessThanOrEqual(80);
    expect(report.matches[0].snippet.endsWith("…")).toBe(true);
  });

  it("deduplicates identical matches and caps the list", () => {
    const report = classifyDraft(Array.from({ length: 40 }, () => "rm -rf /x").join("; "));
    expect(report.level).toBe("danger");
    expect(report.matches.length).toBeLessThanOrEqual(12);
    expect(new Set(labels("rm -rf a; rm -rf a")).size).toBe(1);
  });

  it("finds a risky command on any line of a multi-line draft", () => {
    const draft = ["#!/bin/sh", "set -e", "npm ci", "sudo rm -rf /var/cache/app"].join("\n");
    expectFlagged(draft, "danger", "rm -rf");
  });

  it("looks inside quotes, so wrapped commands are still caught", () => {
    // The reason an opening quote counts as command position.
    expectFlagged(`sh -c "rm -rf /srv"`, "danger", "rm -rf");
    expectFlagged(`ssh prod "sudo reboot"`, "danger", "power state");
    expectFlagged(`ansible all -a 'rm -rf /tmp/x'`, "danger", "rm -rf");
  });

  it("flags risky text even inside quotes (documented over-eagerness)", () => {
    // Not a shell parser: this is a deliberate false positive, not a bug. It is
    // the unavoidable cost of seeing into `sh -c "…"` above.
    expect(level(`echo "rm -rf /"`)).toBe("danger");
  });

  it("handles pathological input without hanging", () => {
    const started = Date.now();
    expect(level("-".repeat(5000))).toBe("none");
    expect(level(`rm ${"-r ".repeat(2000)}`)).toBe("warn");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
