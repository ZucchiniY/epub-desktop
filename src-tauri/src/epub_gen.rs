use serde::Deserialize;

#[derive(Deserialize)]
pub struct ChapterInput {
    pub title: String,
    pub content: String,
}

const CSS: &str = r#"
body { font-family: serif; line-height: 1.8; margin: 5% 6%; }
h1 { font-size: 1.5em; text-align: center; margin-bottom: 1em; }
p { text-indent: 2em; margin: 0.4em 0; }
"#;

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn chapter_to_xhtml(title: &str, content: &str) -> String {
    let normalized = content.replace("\r\n", "\n");
    let blocks: Vec<String> = if normalized.contains("\n\n") {
        normalized.split("\n\n").map(|b| b.replace('\n', "")).collect()
    } else {
        normalized.split('\n').map(|l| l.to_string()).collect()
    };
    let mut html = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    html.push_str("<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\">\n<head><title>");
    html.push_str(&escape_html(title));
    html.push_str("</title></head>\n<body>\n<h1>");
    html.push_str(&escape_html(title));
    html.push_str("</h1>\n");
    for block in blocks {
        let t = block.trim();
        if !t.is_empty() {
            html.push_str("<p>");
            html.push_str(&escape_html(t));
            html.push_str("</p>\n");
        }
    }
    html.push_str("</body>\n</html>");
    html
}

#[tauri::command]
pub fn generate_epub(
    path: String,
    title: String,
    author: Option<String>,
    chapters: Vec<ChapterInput>,
) -> Result<(), String> {
    use epub_builder::{EpubBuilder, EpubContent, EpubVersion, ReferenceType, ZipLibrary};
    use std::fs::File;

    let mut builder = EpubBuilder::new(ZipLibrary::new().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    builder
        .epub_version(EpubVersion::V30)
        .metadata("title", title.as_str())
        .map_err(|e| e.to_string())?
        .metadata("lang", "zh")
        .map_err(|e| e.to_string())?;
    if let Some(a) = author.as_deref() {
        if !a.trim().is_empty() {
            builder.metadata("author", a).map_err(|e| e.to_string())?;
        }
    }
    builder.stylesheet(CSS.as_bytes()).map_err(|e| e.to_string())?;
    for (i, ch) in chapters.iter().enumerate() {
        let name = format!("chapter_{}.xhtml", i);
        let xhtml = chapter_to_xhtml(&ch.title, &ch.content);
        builder
            .add_content(
                EpubContent::new(name, xhtml.as_bytes())
                    .title(ch.title.trim())
                    .reftype(ReferenceType::Text),
            )
            .map_err(|e| e.to_string())?;
    }
    let mut file = File::create(&path).map_err(|e| format!("无法创建文件 {path}: {e}"))?;
    builder.generate(&mut file).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("epub_gen_test_{name}.epub"))
    }

    #[test]
    fn test_generate_and_read_back() {
        let path = test_path("normal");
        let _ = std::fs::remove_file(&path);

        let chapters = vec![
            ChapterInput {
                title: "第一章".into(),
                content: "第一段内容。\n\n第二段内容。".into(),
            },
            ChapterInput {
                title: "第二章".into(),
                content: "第二章的内容。".into(),
            },
        ];
        let result = generate_epub(
            path.to_string_lossy().into_owned(),
            "测试书名".into(),
            Some("作者A".into()),
            chapters,
        );
        assert!(result.is_ok(), "generate_epub 应成功: {:?}", result);

        let bytes = std::fs::read(&path).expect("读取生成的 epub 文件失败");
        assert_eq!(&bytes[0..4], b"PK\x03\x04", "文件应以 zip 本地头 PK\\x03\\x04 开头");

        let method = u16::from_le_bytes([bytes[8], bytes[9]]);
        assert_eq!(method, 0, "mimetype 应使用 stored（不压缩）方式存储");
        let name_len = u16::from_le_bytes([bytes[26], bytes[27]]) as usize;
        let name = &bytes[30..30 + name_len];
        assert_eq!(name, b"mimetype", "第一个本地文件条目应为 mimetype");

        let doc = epub::doc::EpubDoc::new(&path).expect("用 epub 库打开生成的 epub 失败");
        assert_eq!(
            doc.mdata("title").map(|m| m.value.as_str()),
            Some("测试书名")
        );
        assert_eq!(
            doc.mdata("language").map(|m| m.value.as_str()),
            Some("zh")
        );
        assert_eq!(doc.spine.len(), 2);

        let labels: Vec<String> = doc
            .toc
            .iter()
            .map(|np| np.label.clone())
            .collect::<Vec<_>>();
        assert_eq!(labels, vec!["第一章", "第二章"]);
    }

    #[test]
    fn test_empty_chapters_creates_blank_epub() {
        let path = test_path("blank");
        let _ = std::fs::remove_file(&path);
        let result = generate_epub(
            path.to_string_lossy().into_owned(),
            "测试书名".into(),
            Some("作者A".into()),
            vec![],
        );
        assert!(result.is_ok(), "空章节应能生成空白 epub: {:?}", result);

        let bytes = std::fs::read(&path).expect("读取生成的 epub 文件失败");
        assert_eq!(
            &bytes[0..4],
            b"PK\x03\x04",
            "空白 epub 也应是合法的 zip 文件"
        );

        let doc = epub::doc::EpubDoc::new(&path).expect("用 epub 库打开空白 epub 失败");
        assert_eq!(
            doc.mdata("title").map(|m| m.value.as_str()),
            Some("测试书名")
        );
        assert_eq!(doc.spine.len(), 0);
    }
}
