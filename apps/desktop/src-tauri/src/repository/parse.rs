//! Pure parsers for the remote repository script output.
//!
//! The only non-trivial input is `git status --porcelain=v1 -z`, whose records
//! are NUL-terminated. NUL survives the transport because the section is
//! base64-encoded on the remote host (see `mod.rs`), which is exactly why `-z`
//! is used: git never applies C-style quoting in `-z` mode, so filenames with
//! spaces, quotes, newlines or non-UTF-8 bytes arrive verbatim instead of
//! having to be un-quoted here.

use serde::Serialize;

/// Upper bound on the number of status records turned into entries. A tree with
/// more changes than this is unreviewable in a dialog anyway; the excess is
/// dropped rather than shipped to the frontend.
pub(crate) const MAX_ENTRIES: usize = 5_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    /// Path relative to the work-tree root (the NEW path for renames/copies).
    pub path: String,
    /// "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" |
    /// "untracked" | "conflicted".
    pub status: &'static str,
    /// Source path for renames and copies.
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// False when the directory is not inside a work tree; every other field is
    /// then empty and the UI says so instead of showing an error.
    pub is_repo: bool,
    pub root: Option<String>,
    /// Branch name, or the short commit sha when HEAD is detached.
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    /// Commits on HEAD the upstream lacks; `None` when there is no upstream.
    pub ahead: Option<u32>,
    /// Commits on the upstream HEAD lacks; `None` when there is no upstream.
    pub behind: Option<u32>,
    pub staged: Vec<RepoEntry>,
    pub unstaged: Vec<RepoEntry>,
    pub untracked: Vec<RepoEntry>,
}

/// Sections of the status script, already base64-decoded where applicable.
pub(crate) struct StatusSections<'a> {
    pub root: &'a str,
    /// `git rev-parse --abbrev-ref HEAD` ("HEAD" when detached, empty on an
    /// unborn branch).
    pub branch: &'a str,
    /// `git symbolic-ref --short HEAD`, the only source of a name on an unborn
    /// branch (a fresh `git init` with no commits yet).
    pub symref: &'a str,
    /// `git rev-parse --short HEAD`.
    pub head: &'a str,
    pub upstream: &'a str,
    /// `git rev-list --left-right --count @{upstream}...HEAD`.
    pub track: &'a str,
    /// Raw bytes of `git status --porcelain=v1 -z --untracked-files=all`.
    pub porcelain: &'a [u8],
}

/// Assembles the status. Never fails: a missing or malformed section simply
/// contributes nothing, and an absent work-tree root means `is_repo: false`.
pub(crate) fn parse_status(sections: &StatusSections<'_>) -> RepoStatus {
    let root = first_line(sections.root);
    let Some(root) = root else {
        return RepoStatus::default();
    };

    let branch_raw = first_line(sections.branch);
    let head = first_line(sections.head);
    let detached = branch_raw.as_deref() == Some("HEAD");
    let branch = if detached {
        head
    } else {
        // An unborn branch has no HEAD to abbreviate, so fall back to the
        // symbolic ref; a bare `git init` still shows "main".
        branch_raw.or_else(|| first_line(sections.symref))
    };
    let (behind, ahead) = parse_tracking(sections.track);
    let upstream = first_line(sections.upstream);

    let mut status = RepoStatus {
        is_repo: true,
        root: Some(root),
        branch,
        detached,
        // Counts are meaningless without an upstream, and git prints nothing
        // there when `@{upstream}` does not resolve.
        upstream: upstream.clone(),
        ahead: upstream.as_ref().and(ahead),
        behind: upstream.as_ref().and(behind),
        ..RepoStatus::default()
    };
    for record in parse_porcelain_z(sections.porcelain) {
        record.push_into(&mut status);
    }
    status
}

/// First non-empty line of a section, trimmed. `None` when the command
/// produced nothing (it failed, or git is not installed).
fn first_line(section: &str) -> Option<String> {
    section
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// `git rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>":
/// the left side is the upstream, the right side is HEAD.
fn parse_tracking(section: &str) -> (Option<u32>, Option<u32>) {
    let Some(line) = first_line(section) else {
        return (None, None);
    };
    let mut fields = line.split_whitespace();
    let behind = fields.next().and_then(|value| value.parse().ok());
    let ahead = fields.next().and_then(|value| value.parse().ok());
    match (behind, ahead) {
        (Some(behind), Some(ahead)) => (Some(behind), Some(ahead)),
        // A partial line is not a usable count pair.
        _ => (None, None),
    }
}

/// One `XY <path>` record, with its rename/copy source when present.
#[derive(Debug, PartialEq, Eq)]
struct Record {
    index: char,
    work_tree: char,
    path: String,
    old_path: Option<String>,
}

impl Record {
    /// Files the two-letter code across the staged / unstaged / untracked
    /// groups. A file modified in both the index and the work tree legitimately
    /// appears in two groups, which is what the XY pair means.
    fn push_into(self, status: &mut RepoStatus) {
        if self.index == '?' || self.work_tree == '?' {
            status.untracked.push(RepoEntry {
                path: self.path,
                status: "untracked",
                old_path: None,
            });
            return;
        }
        // Ignored entries are never requested, but a future flag change should
        // not turn them into phantom modifications.
        if self.index == '!' || self.work_tree == '!' {
            return;
        }
        if is_conflict(self.index, self.work_tree) {
            // Unmerged paths are neither staged nor cleanly unstaged; they are
            // shown in the work-tree group where the user has to act on them.
            status.unstaged.push(RepoEntry {
                path: self.path,
                status: "conflicted",
                old_path: self.old_path,
            });
            return;
        }
        if let Some(kind) = status_for(self.index) {
            status.staged.push(RepoEntry {
                path: self.path.clone(),
                status: kind,
                old_path: self.old_path.clone(),
            });
        }
        if let Some(kind) = status_for(self.work_tree) {
            status.unstaged.push(RepoEntry {
                path: self.path,
                status: kind,
                // A work-tree rename source is only reported alongside an index
                // rename, so reusing it here keeps both rows self-describing.
                old_path: self.old_path,
            });
        }
    }
}

/// Unmerged combinations from `git status`'s porcelain table.
fn is_conflict(index: char, work_tree: char) -> bool {
    index == 'U' || work_tree == 'U' || matches!((index, work_tree), ('D', 'D') | ('A', 'A'))
}

fn status_for(code: char) -> Option<&'static str> {
    match code {
        'M' => Some("modified"),
        'A' => Some("added"),
        'D' => Some("deleted"),
        'R' => Some("renamed"),
        'C' => Some("copied"),
        'T' => Some("typechange"),
        _ => None,
    }
}

/// Splits `-z` porcelain output into records. Malformed fields are skipped
/// rather than aborting the parse, so a truncated tail still yields everything
/// before it.
fn parse_porcelain_z(data: &[u8]) -> Vec<Record> {
    let mut records = Vec::new();
    // `split` on the terminator yields a trailing empty field, which is simply
    // skipped by the length check below.
    let mut fields = data.split(|byte| *byte == 0);
    while let Some(field) = fields.next() {
        if records.len() >= MAX_ENTRIES {
            break;
        }
        // "XY " plus at least one path byte.
        if field.len() < 4 || field[2] != b' ' {
            continue;
        }
        let index = field[0] as char;
        let work_tree = field[1] as char;
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        // In `-z` mode the rename/copy source follows as its own field.
        let old_path = if matches!(index, 'R' | 'C') || matches!(work_tree, 'R' | 'C') {
            fields
                .next()
                .map(|source| String::from_utf8_lossy(source).into_owned())
                .filter(|source| !source.is_empty())
        } else {
            None
        };
        records.push(Record {
            index,
            work_tree,
            path,
            old_path,
        });
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sections<'a>(porcelain: &'a [u8]) -> StatusSections<'a> {
        StatusSections {
            root: "/home/dev/project\n",
            branch: "main\n",
            symref: "main\n",
            head: "1a2b3c4\n",
            upstream: "origin/main\n",
            track: "2\t3\n",
            porcelain,
        }
    }

    /// Builds `-z` porcelain output from already-formatted records.
    fn porcelain(records: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for record in records {
            out.extend_from_slice(record.as_bytes());
            out.push(0);
        }
        out
    }

    #[test]
    fn empty_output_yields_a_clean_repository() {
        let status = parse_status(&sections(b""));
        assert!(status.is_repo);
        assert_eq!(status.root.as_deref(), Some("/home/dev/project"));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.detached);
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.behind, Some(2));
        assert_eq!(status.ahead, Some(3));
        assert!(status.staged.is_empty());
        assert!(status.unstaged.is_empty());
        assert!(status.untracked.is_empty());
    }

    #[test]
    fn missing_root_means_not_a_repository() {
        let mut input = sections(b"");
        input.root = "";
        let status = parse_status(&input);
        assert!(!status.is_repo);
        assert_eq!(status.root, None);
        assert_eq!(status.branch, None);
    }

    #[test]
    fn detached_head_reports_the_short_sha() {
        let mut input = sections(b"");
        input.branch = "HEAD\n";
        let status = parse_status(&input);
        assert!(status.detached);
        assert_eq!(status.branch.as_deref(), Some("1a2b3c4"));
    }

    #[test]
    fn unborn_branch_falls_back_to_the_symbolic_ref() {
        let mut input = sections(b"");
        input.branch = "";
        input.head = "";
        let status = parse_status(&input);
        assert!(!status.detached);
        assert_eq!(status.branch.as_deref(), Some("main"));
    }

    #[test]
    fn no_upstream_means_no_counts() {
        let mut input = sections(b"");
        input.upstream = "";
        input.track = "";
        let status = parse_status(&input);
        assert_eq!(status.upstream, None);
        assert_eq!(status.ahead, None);
        assert_eq!(status.behind, None);
    }

    #[test]
    fn partial_tracking_line_is_ignored() {
        assert_eq!(parse_tracking("7\n"), (None, None));
        assert_eq!(parse_tracking(""), (None, None));
        assert_eq!(parse_tracking("0\t0\n"), (Some(0), Some(0)));
        assert_eq!(parse_tracking("bad\tworse\n"), (None, None));
    }

    #[test]
    fn splits_staged_unstaged_and_untracked() {
        let data = porcelain(&["M  staged.rs", " M worktree.rs", "?? new.rs"]);
        let status = parse_status(&sections(&data));
        assert_eq!(
            status.staged,
            vec![RepoEntry {
                path: "staged.rs".into(),
                status: "modified",
                old_path: None,
            }]
        );
        assert_eq!(
            status.unstaged,
            vec![RepoEntry {
                path: "worktree.rs".into(),
                status: "modified",
                old_path: None,
            }]
        );
        assert_eq!(
            status.untracked,
            vec![RepoEntry {
                path: "new.rs".into(),
                status: "untracked",
                old_path: None,
            }]
        );
    }

    #[test]
    fn two_letter_codes_place_a_file_in_both_groups() {
        let data = porcelain(&["MM both.rs", "AD added_then_deleted.rs"]);
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged.len(), 2);
        assert_eq!(status.unstaged.len(), 2);
        assert_eq!(status.staged[0].path, "both.rs");
        assert_eq!(status.staged[0].status, "modified");
        assert_eq!(status.unstaged[0].status, "modified");
        assert_eq!(status.staged[1].status, "added");
        assert_eq!(status.unstaged[1].status, "deleted");
    }

    #[test]
    fn renames_carry_their_source_path() {
        let data = porcelain(&["R  new/name.rs", "old/name.rs", " M other.rs"]);
        let status = parse_status(&sections(&data));
        assert_eq!(
            status.staged,
            vec![RepoEntry {
                path: "new/name.rs".into(),
                status: "renamed",
                old_path: Some("old/name.rs".into()),
            }]
        );
        // The source field must not be mistaken for the next record.
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].path, "other.rs");
    }

    #[test]
    fn copies_carry_their_source_path() {
        let data = porcelain(&["C  copy.rs", "origin.rs"]);
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged[0].status, "copied");
        assert_eq!(status.staged[0].old_path.as_deref(), Some("origin.rs"));
    }

    #[test]
    fn rename_with_further_work_tree_edits_lands_in_both_groups() {
        let data = porcelain(&["RM new.rs", "old.rs"]);
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged[0].status, "renamed");
        assert_eq!(status.staged[0].old_path.as_deref(), Some("old.rs"));
        assert_eq!(status.unstaged[0].status, "modified");
        assert_eq!(status.unstaged[0].path, "new.rs");
    }

    #[test]
    fn conflicts_are_reported_once_as_conflicted() {
        let data = porcelain(&[
            "UU both_modified.rs",
            "AA both_added.rs",
            "DD both_deleted.rs",
            "AU added_by_us.rs",
            "UD deleted_by_them.rs",
        ]);
        let status = parse_status(&sections(&data));
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 5);
        assert!(status
            .unstaged
            .iter()
            .all(|entry| entry.status == "conflicted"));
    }

    #[test]
    fn paths_with_spaces_quotes_and_newlines_survive_intact() {
        let data = porcelain(&[
            "M  dir with spaces/a b.rs",
            " M weird\"quote\".rs",
            "?? line\nbreak.rs",
            "M  caf\u{e9}.rs",
        ]);
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged[0].path, "dir with spaces/a b.rs");
        assert_eq!(status.unstaged[0].path, "weird\"quote\".rs");
        assert_eq!(status.untracked[0].path, "line\nbreak.rs");
        assert_eq!(status.staged[1].path, "café.rs");
    }

    #[test]
    fn invalid_utf8_paths_are_replaced_not_dropped() {
        let mut data = b"M  bad".to_vec();
        data.push(0xff);
        data.push(b'\0');
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged.len(), 1);
        assert!(status.staged[0].path.starts_with("bad"));
    }

    #[test]
    fn malformed_records_are_skipped() {
        // Too short, missing separator, and a stray empty field.
        let data = porcelain(&["M", "MMnospace.rs", "", "M  good.rs"]);
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "good.rs");
    }

    #[test]
    fn ignored_entries_are_dropped() {
        let data = porcelain(&["!! build/out.o", "M  kept.rs"]);
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged.len(), 1);
        assert!(status.unstaged.is_empty());
        assert!(status.untracked.is_empty());
    }

    #[test]
    fn record_count_is_capped() {
        let records: Vec<String> = (0..MAX_ENTRIES + 50)
            .map(|index| format!("M  file{index}.rs"))
            .collect();
        let refs: Vec<&str> = records.iter().map(String::as_str).collect();
        let data = porcelain(&refs);
        let status = parse_status(&sections(&data));
        assert_eq!(status.staged.len(), MAX_ENTRIES);
    }
}
