use std::path::Path;

// VS Code의 기본 files.exclude와 같은 항목
const HIDDEN: &[&str] = &[".git", ".DS_Store", ".svn", ".hg", "Thumbs.db"];

#[derive(serde::Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = std::fs::read_dir(Path::new(&path))
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| !HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
        .map(|e| {
            // 심볼릭 링크는 따라가서 대상이 폴더인지 본다.
            let is_dir = std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
            Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirs_first_case_insensitive_and_hidden_skipped() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for d in ["b_dir", "A_dir", ".git"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in ["z.txt", "a.txt", ".DS_Store"] {
            std::fs::write(dir.join(f), "").unwrap();
        }

        let names: Vec<_> = list_dir(dir.to_string_lossy().into_owned())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["A_dir", "b_dir", "a.txt", "z.txt"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
