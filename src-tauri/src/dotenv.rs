//! Reads the git-ignored `.env` file at the repository root during the local build (#187).
//!
//! `build.rs` includes this file and passes the cloud client IDs and the Google client secret
//! to the compiler, where `option_env!` picks them up. The release pipeline sets the same names
//! as real environment variables, which win over the file.
//!
//! A linked git worktree does not get the git-ignored `.env` of the main checkout, so the build
//! also looks there ([`env_files`]). Precedence: real environment variables, then the worktree's
//! own `.env`, then the main checkout's `.env`.

use std::path::{Component, Path, PathBuf};

/// Names the build takes from `.env`. Anything else in the file is ignored.
pub const KEYS: [&str; 5] = [
    "SMARTBEAT_GOOGLE_CLIENT_ID",
    "SMARTBEAT_GOOGLE_CLIENT_SECRET",
    "SMARTBEAT_MICROSOFT_CLIENT_ID",
    "SMARTBEAT_DROPBOX_CLIENT_ID",
    // The Practice together signaling Worker (#158); without it "Over the internet" is off.
    "SMART_BEAT_SIGNALING_URL",
];

/// The `KEY=value` pairs of the known [`KEYS`] in `text`, skipping blank values. Supports
/// comments (`#`), an optional `export ` prefix and single or double quotes around the value.
pub fn parse(text: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim();
        for quote in ['"', '\''] {
            if let Some(inner) = value
                .strip_prefix(quote)
                .and_then(|rest| rest.strip_suffix(quote))
            {
                value = inner;
            }
        }
        if value.is_empty() || !KEYS.contains(&key) {
            continue;
        }
        pairs.push((key.to_owned(), value.to_owned()));
    }
    pairs
}

/// Collapses `.` and `..` components without touching the file system.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The main working tree of the repository that the linked worktree at `root` belongs to.
///
/// `dot_git` is the text of `root/.git` when that is a file (`gitdir: <path>`, relative to `root`
/// or absolute), `commondir` the text of the `commondir` file inside that git directory (a path
/// relative to it, `../..` for a worktree). The common directory is the main checkout's `.git`,
/// so its parent is the main working tree. `None` for anything else (a plain checkout, a
/// submodule, a bare repository).
pub fn main_worktree(root: &Path, dot_git: &str, commondir: &str) -> Option<PathBuf> {
    let gitdir = dot_git
        .lines()
        .next()?
        .trim()
        .strip_prefix("gitdir:")?
        .trim();
    let commondir = commondir.lines().next()?.trim();
    if gitdir.is_empty() || commondir.is_empty() {
        return None;
    }
    let gitdir = normalize(&root.join(gitdir));
    let common = normalize(&gitdir.join(commondir));
    if common.file_name()? != ".git" {
        return None;
    }
    Some(common.parent()?.to_path_buf())
}

/// The `.env` files to read for a build at repository root `root`, most important first: the
/// root's own, then (in a linked worktree) the main checkout's. No file is required to exist.
pub fn env_files(root: &Path) -> Vec<PathBuf> {
    let mut files = vec![root.join(".env")];
    let main = std::fs::read_to_string(root.join(".git"))
        .ok()
        .and_then(|dot_git| {
            let gitdir = dot_git
                .lines()
                .next()?
                .trim()
                .strip_prefix("gitdir:")?
                .trim();
            let gitdir = normalize(&root.join(gitdir));
            let commondir = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
            main_worktree(root, &dot_git, &commondir)
        });
    if let Some(main) = main {
        let file = main.join(".env");
        if normalize(&file) != normalize(&files[0]) {
            files.push(file);
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worktree_points_at_the_main_checkouts_env() {
        let root = Path::new("/work/repo/.claude/worktrees/feature");
        let main = main_worktree(
            root,
            "gitdir: /work/repo/.git/worktrees/feature\n",
            "../..\n",
        );
        assert_eq!(main, Some(PathBuf::from("/work/repo")));
    }

    #[test]
    fn a_relative_gitdir_is_read_from_the_worktree_root() {
        let root = Path::new("/work/wt");
        let main = main_worktree(root, "gitdir: ../repo/.git/worktrees/wt", "../..");
        assert_eq!(main, Some(PathBuf::from("/work/repo")));
    }

    #[test]
    fn anything_that_is_not_a_linked_worktree_has_no_main_checkout() {
        let root = Path::new("/work/repo");
        // Not a gitdir line, or an empty one.
        assert_eq!(main_worktree(root, "ref: refs/heads/main", "../.."), None);
        assert_eq!(main_worktree(root, "gitdir:", "../.."), None);
        assert_eq!(main_worktree(root, "gitdir: /x/.git/worktrees/a", ""), None);
        // A bare repository's common directory is not named `.git`.
        assert_eq!(
            main_worktree(root, "gitdir: /srv/repo.git/worktrees/a", "../.."),
            None
        );
    }

    #[test]
    fn dot_dot_components_collapse_without_the_file_system() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(normalize(Path::new("a/../../b")), PathBuf::from("../b"));
    }

    #[test]
    fn env_files_lists_the_worktree_env_before_the_main_checkouts() {
        let dir = std::env::temp_dir().join(format!("sb-dotenv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let main = dir.join("main");
        let worktree = main.join(".claude/worktrees/feature");
        let gitdir = main.join(".git/worktrees/feature");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        assert_eq!(
            env_files(&worktree),
            [worktree.join(".env"), main.join(".env")]
        );
        // The main checkout itself (`.git` is a directory) has only its own file.
        assert_eq!(env_files(&main), [main.join(".env")]);
        // A submodule: `.git` is a file, but its git directory has no `commondir`.
        let module = dir.join("module");
        std::fs::create_dir_all(dir.join("super/.git/modules/module")).unwrap();
        std::fs::create_dir_all(&module).unwrap();
        std::fs::write(
            module.join(".git"),
            "gitdir: ../super/.git/modules/module\n",
        )
        .unwrap();
        assert_eq!(env_files(&module), [module.join(".env")]);
        // A folder that is no repository at all too.
        assert_eq!(env_files(&dir), [dir.join(".env")]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_known_keys_and_skips_the_rest() {
        let text = "# cloud\nSMARTBEAT_GOOGLE_CLIENT_ID=abc\nOTHER=1\n\nexport SMARTBEAT_DROPBOX_CLIENT_ID=\"def\"\nSMARTBEAT_MICROSOFT_CLIENT_ID='ghi'\n";
        assert_eq!(
            parse(text),
            [
                ("SMARTBEAT_GOOGLE_CLIENT_ID".to_owned(), "abc".to_owned()),
                ("SMARTBEAT_DROPBOX_CLIENT_ID".to_owned(), "def".to_owned()),
                ("SMARTBEAT_MICROSOFT_CLIENT_ID".to_owned(), "ghi".to_owned()),
            ]
        );
    }

    #[test]
    fn the_signaling_worker_address_is_read_too() {
        assert_eq!(
            parse("SMART_BEAT_SIGNALING_URL=https://signal.example.workers.dev"),
            [(
                "SMART_BEAT_SIGNALING_URL".to_owned(),
                "https://signal.example.workers.dev".to_owned()
            )]
        );
    }

    #[test]
    fn blank_values_and_comments_are_skipped() {
        assert!(
            parse("SMARTBEAT_GOOGLE_CLIENT_SECRET=\n# SMARTBEAT_GOOGLE_CLIENT_ID=x").is_empty()
        );
    }

    #[test]
    fn values_may_contain_equals_signs() {
        assert_eq!(parse("SMARTBEAT_GOOGLE_CLIENT_SECRET=a=b==")[0].1, "a=b==");
    }
}
