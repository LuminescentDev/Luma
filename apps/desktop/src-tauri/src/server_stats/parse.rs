//! Defensive parsers for the batched remote stats script output.
//!
//! Every parser is a pure function over strings so it can be unit tested with
//! canned fixtures. A parse failure in any section yields `None` for that
//! section only — never an error for the whole snapshot.

use std::collections::HashMap;

use serde::Serialize;

/// One snapshot of a remote server's state. Every section is optional so a
/// non-Linux host (or a stripped-down container) degrades gracefully: the
/// frontend renders whatever is present and marks the rest unavailable.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatsSnapshot {
    pub system: Option<SystemInfo>,
    pub cpu: Option<CpuStats>,
    pub memory: Option<MemoryStats>,
    pub disks: Option<Vec<DiskStats>>,
    pub network: Option<Vec<NetworkInterfaceStats>>,
    pub top_processes: Option<TopProcesses>,
    /// `None` when the docker CLI is unavailable (or the daemon is down);
    /// `Some(vec![])` when docker responded with zero containers.
    pub docker: Option<Vec<DockerContainer>>,
    /// Milliseconds since the Unix epoch, taken client-side at fetch time so
    /// the frontend can compute rate deltas between refreshes.
    pub sampled_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: Option<String>,
    pub os_pretty_name: Option<String>,
    pub kernel: Option<String>,
    pub arch: Option<String>,
    pub hostname: Option<String>,
    /// From /proc/uptime (Linux only).
    pub uptime_seconds: Option<f64>,
    /// Raw `uptime` output for hosts without /proc.
    pub uptime_text: Option<String>,
}

/// Raw cumulative jiffy counters straight from /proc/stat. Utilization is a
/// delta between two samples, which the frontend computes between refreshes so
/// the backend never has to sleep-and-resample.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CpuCounters {
    pub name: String,
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuStats {
    /// Aggregate "cpu" line; `None` on hosts without /proc/stat.
    pub total: Option<CpuCounters>,
    pub cores: Vec<CpuCounters>,
    pub load_average: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total_kb: u64,
    pub free_kb: Option<u64>,
    pub available_kb: Option<u64>,
    pub buffers_kb: Option<u64>,
    pub cached_kb: Option<u64>,
    pub swap_total_kb: Option<u64>,
    pub swap_free_kb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub filesystem: String,
    pub mount_point: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub available_kb: u64,
    pub used_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceStats {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    pub pid: Option<u32>,
    pub user: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopProcesses {
    pub by_cpu: Vec<ProcessStats>,
    pub by_memory: Vec<ProcessStats>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub name: String,
    pub state: String,
    pub status: String,
    pub image: String,
    /// Derived from the status text: "healthy", "unhealthy" or "starting".
    pub health: Option<String>,
}

const MAX_TOP_PROCESSES: usize = 10;
const MAX_LIST_ENTRIES: usize = 512;

/// Splits the batched script output into named sections. Marker lines look
/// like `===LUMA:meminfo===` on a line of their own.
pub(crate) fn split_sections(output: &str) -> HashMap<String, String> {
    let mut sections: HashMap<String, String> = HashMap::new();
    let mut current: Option<String> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed
            .strip_prefix("===LUMA:")
            .and_then(|rest| rest.strip_suffix("==="))
        {
            current = Some(name.to_string());
            sections.entry(name.to_string()).or_default();
            continue;
        }
        if let Some(name) = &current {
            let body = sections.entry(name.clone()).or_default();
            body.push_str(line);
            body.push('\n');
        }
    }
    sections
}

/// Assembles a full snapshot from raw script output. Missing or malformed
/// sections come back as `None`; this function itself never fails.
pub(crate) fn parse_snapshot(output: &str, sampled_at_ms: i64) -> ServerStatsSnapshot {
    let sections = split_sections(output);
    let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
    ServerStatsSnapshot {
        system: parse_system(
            section("system"),
            section("osrelease"),
            section("uptime"),
            section("uptimecmd"),
        ),
        cpu: parse_cpu(section("stat"), section("loadavg"), section("uptimecmd")),
        memory: parse_memory(section("meminfo")),
        disks: parse_disks(section("df")),
        network: parse_network(section("netdev")),
        top_processes: parse_processes(section("ps")),
        docker: parse_docker(section("docker")),
        sampled_at_ms,
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn parse_system(
    system: &str,
    os_release: &str,
    proc_uptime: &str,
    uptime_cmd: &str,
) -> Option<SystemInfo> {
    let mut info = SystemInfo {
        os: None,
        os_pretty_name: None,
        kernel: None,
        arch: None,
        hostname: None,
        uptime_seconds: None,
        uptime_text: None,
    };
    for line in system.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = non_empty(value);
        match key.trim() {
            "os" => info.os = value,
            "kernel" => info.kernel = value,
            "arch" => info.arch = value,
            "hostname" => info.hostname = value,
            _ => {}
        }
    }
    info.os_pretty_name = parse_os_pretty_name(os_release);
    info.uptime_seconds = proc_uptime
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0);
    if info.uptime_seconds.is_none() {
        info.uptime_text = non_empty(uptime_cmd);
    }

    let has_any = info.os.is_some()
        || info.os_pretty_name.is_some()
        || info.kernel.is_some()
        || info.arch.is_some()
        || info.hostname.is_some()
        || info.uptime_seconds.is_some()
        || info.uptime_text.is_some();
    has_any.then_some(info)
}

fn parse_os_pretty_name(os_release: &str) -> Option<String> {
    for line in os_release.lines() {
        let Some(value) = line.trim().strip_prefix("PRETTY_NAME=") else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        return non_empty(value);
    }
    None
}

fn parse_cpu_line(line: &str) -> Option<CpuCounters> {
    let mut fields = line.split_whitespace();
    let name = fields.next()?;
    if name != "cpu" && !(name.starts_with("cpu") && name[3..].chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let values: Vec<u64> = fields.map(|field| field.parse().unwrap_or(0)).collect();
    // user nice system idle are mandatory; later kernels append more fields.
    if values.len() < 4 {
        return None;
    }
    let at = |index: usize| values.get(index).copied().unwrap_or(0);
    Some(CpuCounters {
        name: name.to_string(),
        user: at(0),
        nice: at(1),
        system: at(2),
        idle: at(3),
        iowait: at(4),
        irq: at(5),
        softirq: at(6),
        steal: at(7),
    })
}

pub(crate) fn parse_cpu(stat: &str, loadavg: &str, uptime_cmd: &str) -> Option<CpuStats> {
    let mut total = None;
    let mut cores = Vec::new();
    for line in stat.lines() {
        let Some(counters) = parse_cpu_line(line) else {
            continue;
        };
        if counters.name == "cpu" {
            total = Some(counters);
        } else if cores.len() < MAX_LIST_ENTRIES {
            cores.push(counters);
        }
    }
    let load_average = parse_loadavg(loadavg).or_else(|| parse_load_from_uptime(uptime_cmd));

    let has_any = total.is_some() || !cores.is_empty() || load_average.is_some();
    has_any.then_some(CpuStats {
        total,
        cores,
        load_average,
    })
}

fn parse_loadavg(loadavg: &str) -> Option<[f64; 3]> {
    let mut fields = loadavg.split_whitespace();
    let one = fields.next()?.parse().ok()?;
    let five = fields.next()?.parse().ok()?;
    let fifteen = fields.next()?.parse().ok()?;
    Some([one, five, fifteen])
}

/// Fallback for hosts without /proc/loadavg: pulls the three numbers after
/// "load average:" (Linux) or "load averages:" (macOS/BSD) out of `uptime`.
fn parse_load_from_uptime(uptime_cmd: &str) -> Option<[f64; 3]> {
    let line = uptime_cmd
        .lines()
        .find(|line| line.contains("load average"))?;
    let after = line.split_once("load average")?.1;
    let after = after.trim_start_matches("s").trim_start_matches(':');
    let values: Vec<f64> = after
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|field| !field.is_empty())
        .map_while(|field| field.parse().ok())
        .collect();
    match values.as_slice() {
        [one, five, fifteen, ..] => Some([*one, *five, *fifteen]),
        _ => None,
    }
}

pub(crate) fn parse_memory(meminfo: &str) -> Option<MemoryStats> {
    let mut values: HashMap<&str, u64> = HashMap::new();
    for line in meminfo.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(value) = rest.split_whitespace().next().and_then(|v| v.parse().ok()) else {
            continue;
        };
        values.insert(key.trim(), value);
    }
    Some(MemoryStats {
        total_kb: *values.get("MemTotal")?,
        free_kb: values.get("MemFree").copied(),
        available_kb: values.get("MemAvailable").copied(),
        buffers_kb: values.get("Buffers").copied(),
        cached_kb: values.get("Cached").copied(),
        swap_total_kb: values.get("SwapTotal").copied(),
        swap_free_kb: values.get("SwapFree").copied(),
    })
}

pub(crate) fn parse_disks(df: &str) -> Option<Vec<DiskStats>> {
    let mut disks = Vec::new();
    // Skip the "Filesystem 1024-blocks ..." header.
    for line in df.lines().skip(1) {
        if disks.len() >= MAX_LIST_ENTRIES {
            break;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        let (Ok(total_kb), Ok(used_kb), Ok(available_kb)) = (
            fields[1].parse::<u64>(),
            fields[2].parse::<u64>(),
            fields[3].parse::<u64>(),
        ) else {
            continue;
        };
        if total_kb == 0 {
            continue;
        }
        let used_percent = fields[4]
            .trim_end_matches('%')
            .parse::<f64>()
            .ok()
            .filter(|percent| percent.is_finite());
        disks.push(DiskStats {
            filesystem: fields[0].to_string(),
            // Mount points may contain spaces; everything after the capacity
            // column belongs to the mount point.
            mount_point: fields[5..].join(" "),
            total_kb,
            used_kb,
            available_kb,
            used_percent,
        });
    }
    (!disks.is_empty()).then_some(disks)
}

pub(crate) fn parse_network(netdev: &str) -> Option<Vec<NetworkInterfaceStats>> {
    let mut interfaces = Vec::new();
    for line in netdev.lines() {
        if interfaces.len() >= MAX_LIST_ENTRIES {
            break;
        }
        // "eth0: 12345 84 0 0 0 0 0 0 67890 45 0 0 0 0 0 0"
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || name.contains(char::is_whitespace) {
            continue;
        }
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let (Ok(rx_bytes), Ok(tx_bytes)) = (fields[0].parse::<u64>(), fields[8].parse::<u64>())
        else {
            continue;
        };
        interfaces.push(NetworkInterfaceStats {
            name: name.to_string(),
            rx_bytes,
            tx_bytes,
        });
    }
    (!interfaces.is_empty()).then_some(interfaces)
}

pub(crate) fn parse_processes(ps: &str) -> Option<TopProcesses> {
    let mut processes = Vec::new();
    // Skip the "USER PID %CPU %MEM ..." header.
    for line in ps.lines().skip(1) {
        if processes.len() >= 4096 {
            break;
        }
        // Take the first 10 whitespace-separated columns, then keep the rest of
        // the line intact as the command (which may itself contain spaces).
        let compact: Vec<&str> = {
            let mut out = Vec::new();
            let mut rest = line;
            while out.len() < 10 {
                rest = rest.trim_start();
                let Some(end) = rest.find(char::is_whitespace) else {
                    break;
                };
                out.push(&rest[..end]);
                rest = &rest[end..];
            }
            let command = rest.trim();
            if out.len() == 10 && !command.is_empty() {
                out.push(command);
            }
            out
        };
        if compact.len() < 11 {
            continue;
        }
        let (Ok(cpu_percent), Ok(mem_percent)) =
            (compact[2].parse::<f64>(), compact[3].parse::<f64>())
        else {
            continue;
        };
        if !cpu_percent.is_finite() || !mem_percent.is_finite() {
            continue;
        }
        processes.push(ProcessStats {
            pid: compact[1].parse().ok(),
            user: compact[0].to_string(),
            cpu_percent,
            mem_percent,
            command: compact[10].to_string(),
        });
    }
    if processes.is_empty() {
        return None;
    }
    let mut by_cpu = processes.clone();
    by_cpu.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    by_cpu.truncate(MAX_TOP_PROCESSES);
    let mut by_memory = processes;
    by_memory.sort_by(|a, b| {
        b.mem_percent
            .partial_cmp(&a.mem_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    by_memory.truncate(MAX_TOP_PROCESSES);
    Some(TopProcesses { by_cpu, by_memory })
}

pub(crate) fn parse_docker(docker: &str) -> Option<Vec<DockerContainer>> {
    let mut lines = docker.lines().filter(|line| !line.trim().is_empty());
    // The script prints "@ok" only when the docker CLI ran successfully, which
    // distinguishes "no containers" from "docker unavailable".
    if lines.next()?.trim() != "@ok" {
        return None;
    }
    let mut containers = Vec::new();
    for line in lines {
        if containers.len() >= MAX_LIST_ENTRIES {
            break;
        }
        // Tab-separated; tolerate a docker build that leaves "\t" literal.
        let fields: Vec<&str> = if line.contains('\t') {
            line.split('\t').collect()
        } else {
            line.split("\\t").collect()
        };
        if fields.len() < 4 {
            continue;
        }
        let status = fields[2].trim().to_string();
        let lowered = status.to_ascii_lowercase();
        let health = if lowered.contains("(healthy)") {
            Some("healthy".to_string())
        } else if lowered.contains("(unhealthy)") {
            Some("unhealthy".to_string())
        } else if lowered.contains("health: starting") {
            Some("starting".to_string())
        } else {
            None
        };
        containers.push(DockerContainer {
            name: fields[0].trim().to_string(),
            state: fields[1].trim().to_string(),
            status,
            image: fields[3].trim().to_string(),
            health,
        });
    }
    Some(containers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_marked_sections() {
        let output = "noise before markers\n===LUMA:one===\nalpha\nbeta\n===LUMA:two===\ngamma\n";
        let sections = split_sections(output);
        assert_eq!(sections["one"], "alpha\nbeta\n");
        assert_eq!(sections["two"], "gamma\n");
        assert!(!sections.contains_key("three"));
    }

    #[test]
    fn parses_system_section() {
        let info = parse_system(
            "os=Linux\nkernel=6.8.0-45-generic\narch=x86_64\nhostname=web-01\n",
            "ID=ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n",
            "352452.13 2755231.55\n",
            "",
        )
        .unwrap();
        assert_eq!(info.os.as_deref(), Some("Linux"));
        assert_eq!(info.kernel.as_deref(), Some("6.8.0-45-generic"));
        assert_eq!(info.arch.as_deref(), Some("x86_64"));
        assert_eq!(info.hostname.as_deref(), Some("web-01"));
        assert_eq!(info.os_pretty_name.as_deref(), Some("Ubuntu 24.04 LTS"));
        assert_eq!(info.uptime_seconds, Some(352452.13));
        assert_eq!(info.uptime_text, None);
    }

    #[test]
    fn system_falls_back_to_uptime_text_without_proc() {
        let info = parse_system(
            "os=Darwin\nkernel=23.5.0\narch=arm64\nhostname=mac-mini\n",
            "",
            "",
            "10:03  up 12 days,  1:42, 2 users, load averages: 1.98 2.02 2.03\n",
        )
        .unwrap();
        assert_eq!(info.uptime_seconds, None);
        assert!(info.uptime_text.unwrap().contains("12 days"));
        assert_eq!(info.os_pretty_name, None);
    }

    #[test]
    fn empty_system_sections_yield_none() {
        assert_eq!(parse_system("", "", "", ""), None);
        assert_eq!(parse_system("os=\nkernel=\n", "", "", ""), None);
    }

    #[test]
    fn parses_proc_stat_counters() {
        let stat = "cpu  1000 20 300 4000 50 6 7 8 0 0\n\
                    cpu0 500 10 150 2000 25 3 4 4 0 0\n\
                    cpu1 500 10 150 2000 25 3 3 4 0 0\n\
                    intr 12345 0 0\nctxt 999\n";
        let cpu = parse_cpu(stat, "0.52 0.58 0.59 1/389 12345\n", "").unwrap();
        let total = cpu.total.unwrap();
        assert_eq!(total.user, 1000);
        assert_eq!(total.idle, 4000);
        assert_eq!(total.iowait, 50);
        assert_eq!(total.steal, 8);
        assert_eq!(cpu.cores.len(), 2);
        assert_eq!(cpu.cores[0].name, "cpu0");
        assert_eq!(cpu.cores[1].irq, 3);
        assert_eq!(cpu.load_average, Some([0.52, 0.58, 0.59]));
    }

    #[test]
    fn cpu_load_falls_back_to_uptime_output() {
        let cpu = parse_cpu("", "", "10:03  up 12 days, load averages: 1.98 2.02 2.03\n").unwrap();
        assert_eq!(cpu.total, None);
        assert!(cpu.cores.is_empty());
        assert_eq!(cpu.load_average, Some([1.98, 2.02, 2.03]));

        let linux = parse_cpu("", "", "up 1 day, load average: 0.10, 0.20, 0.30\n").unwrap();
        assert_eq!(linux.load_average, Some([0.10, 0.20, 0.30]));
        assert_eq!(parse_cpu("", "", "garbage without loads\n"), None);
    }

    #[test]
    fn parses_meminfo() {
        let meminfo = "MemTotal:       16308856 kB\n\
                       MemFree:         1156280 kB\n\
                       MemAvailable:    9078000 kB\n\
                       Buffers:          526704 kB\n\
                       Cached:          7549960 kB\n\
                       SwapTotal:       4194300 kB\n\
                       SwapFree:        4194300 kB\n";
        let memory = parse_memory(meminfo).unwrap();
        assert_eq!(memory.total_kb, 16_308_856);
        assert_eq!(memory.available_kb, Some(9_078_000));
        assert_eq!(memory.cached_kb, Some(7_549_960));
        assert_eq!(memory.swap_free_kb, Some(4_194_300));
        assert_eq!(parse_memory("garbage\n"), None);
    }

    #[test]
    fn parses_df_output_including_spaced_mounts() {
        let df = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n\
                  /dev/sda1        102687672  60967740  36462708      63% /\n\
                  tmpfs              8154428         0   8154428       0% /dev/shm\n\
                  /dev/sdb1         51475068  10240000  38614044      21% /mnt/backup disk\n\
                  none                     0         0         0        - /proc\n";
        let disks = parse_disks(df).unwrap();
        assert_eq!(disks.len(), 3);
        assert_eq!(disks[0].filesystem, "/dev/sda1");
        assert_eq!(disks[0].mount_point, "/");
        assert_eq!(disks[0].used_percent, Some(63.0));
        assert_eq!(disks[2].mount_point, "/mnt/backup disk");
        assert_eq!(parse_disks(""), None);
    }

    #[test]
    fn parses_proc_net_dev() {
        let netdev = "Inter-|   Receive                                                |  Transmit\n\
                      face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n\
                      lo:  123456     840    0    0    0     0          0         0   123456     840    0    0    0     0       0          0\n\
                      eth0: 987654321 765432    0    0    0     0          0         0 123456789 234567    0    0    0     0       0          0\n";
        let interfaces = parse_network(netdev).unwrap();
        assert_eq!(interfaces.len(), 2);
        assert_eq!(interfaces[1].name, "eth0");
        assert_eq!(interfaces[1].rx_bytes, 987_654_321);
        assert_eq!(interfaces[1].tx_bytes, 123_456_789);
        assert_eq!(parse_network("no interfaces here\n"), None);
    }

    #[test]
    fn parses_ps_aux_and_ranks_top_processes() {
        let ps = "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n\
                  root           1  0.0  0.1 167744 11788 ?        Ss   Jan01   1:23 /sbin/init splash\n\
                  postgres     900 12.5  8.4 998244 684000 ?       Ss   Jan01  99:00 postgres: writer process\n\
                  deploy      1234 55.0  2.1 749596 171876 ?       Sl   Jan02  12:34 node /srv/app/server.js --port 3000\n\
                  malformed line without enough fields\n";
        let top = parse_processes(ps).unwrap();
        assert_eq!(top.by_cpu[0].command, "node /srv/app/server.js --port 3000");
        assert_eq!(top.by_cpu[0].cpu_percent, 55.0);
        assert_eq!(top.by_cpu[0].pid, Some(1234));
        assert_eq!(top.by_memory[0].user, "postgres");
        assert_eq!(top.by_memory[0].mem_percent, 8.4);
        assert_eq!(top.by_cpu.len(), 3);
        assert_eq!(parse_processes("USER PID\n"), None);
    }

    #[test]
    fn parses_docker_sections() {
        let docker = "@ok\n\
                      web\trunning\tUp 3 days (healthy)\tnginx:1.27\n\
                      db\trunning\tUp 3 days (unhealthy)\tpostgres:16\n\
                      worker\texited\tExited (1) 2 hours ago\tapp/worker:latest\n";
        let containers = parse_docker(docker).unwrap();
        assert_eq!(containers.len(), 3);
        assert_eq!(containers[0].name, "web");
        assert_eq!(containers[0].health.as_deref(), Some("healthy"));
        assert_eq!(containers[1].health.as_deref(), Some("unhealthy"));
        assert_eq!(containers[2].health, None);
        assert_eq!(containers[2].state, "exited");

        // docker present, zero containers
        assert_eq!(parse_docker("@ok\n"), Some(Vec::new()));
        // docker missing entirely
        assert_eq!(parse_docker(""), None);
        assert_eq!(parse_docker("command not found\n"), None);
    }

    #[test]
    fn full_snapshot_degrades_per_section() {
        let output = "===LUMA:system===\nos=Linux\nkernel=6.1.0\narch=aarch64\nhostname=pi\n\
                      ===LUMA:meminfo===\nMemTotal: 1024 kB\nMemFree: 512 kB\n\
                      ===LUMA:stat===\ntotal garbage here\n";
        let snapshot = parse_snapshot(output, 1_700_000_000_000);
        assert!(snapshot.system.is_some());
        assert_eq!(snapshot.memory.as_ref().unwrap().total_kb, 1024);
        assert_eq!(snapshot.cpu, None);
        assert_eq!(snapshot.disks, None);
        assert_eq!(snapshot.network, None);
        assert_eq!(snapshot.top_processes, None);
        assert_eq!(snapshot.docker, None);
        assert_eq!(snapshot.sampled_at_ms, 1_700_000_000_000);
    }
}
