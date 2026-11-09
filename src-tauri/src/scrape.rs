use scraper::{Html, Node, Selector};
use serde::Serialize;
use std::collections::HashSet;
use std::error::Error;
use url::Url;

static UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[derive(Serialize, Clone)]
pub struct ChapterRef {
    pub title: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct Catalog {
    pub book_title: String,
    pub chapters: Vec<ChapterRef>,
}

#[derive(Serialize)]
pub struct ChapterContent {
    pub title: String,
    pub content: String,
}

pub enum FetchError {
    Request(String),
    Parse(String),
    Url(String),
    /// 页面拿到了，但没有正文（站点错误页 / 空白容器），可重试
    Empty(String),
}

impl FetchError {
    /// 是否值得重试：网络错误与空正文通常是站点偶发问题。
    fn retryable(&self) -> bool {
        matches!(self, FetchError::Request(_) | FetchError::Empty(_))
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Request(msg) => write!(f, "请求失败：{}", msg),
            FetchError::Parse(msg) => write!(f, "解析失败：{}", msg),
            FetchError::Url(msg) => write!(f, "地址无效：{}", msg),
            FetchError::Empty(msg) => write!(f, "正文为空：{}", msg),
        }
    }
}

/// 规范化 URL：trim 空白，缺协议补 https://，拒绝明显非法值。
fn normalize_url(raw: &str) -> Result<String, FetchError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(FetchError::Url("地址为空".into()));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    // 基本合法性校验
    let u = Url::parse(&with_scheme).map_err(|e| FetchError::Url(e.to_string()))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(FetchError::Url(format!("不支持的协议：{}", u.scheme())));
    }
    Ok(with_scheme)
}

/// 把 reqwest 错误连同底层原因链展开成可读信息，便于定位 TLS/网络问题。
fn request_error(url: &str, e: reqwest::Error) -> FetchError {
    let mut seen = HashSet::new();
    let mut chain = Vec::new();
    let mut cur: Option<&(dyn Error + 'static)> = Some(&e);
    while let Some(c) = cur {
        let s = c.to_string();
        if seen.insert(s.clone()) {
            chain.push(s);
        }
        cur = c.source();
    }
    FetchError::Request(format!("{} | {}", url, chain.join(" => ")))
}

/// 复用一个客户端：复用 TCP/TLS 连接，显著减少抓取上千章时的握手开销与偶发失败。
fn http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent(UA)
            .timeout(std::time::Duration::from_secs(30))
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

/// 最多尝试 3 次；网络错误与空正文会退避重试，解析/地址错误直接返回。
fn with_retry<T>(mut f: impl FnMut() -> Result<T, FetchError>) -> Result<T, FetchError> {
    let mut last_err: Option<FetchError> = None;
    for attempt in 0..3u64 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400 * attempt));
        }
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                let retryable = e.retryable();
                last_err = Some(e);
                if !retryable {
                    break;
                }
            }
        }
    }
    Err(last_err.expect("至少尝试一次"))
}

/// 发送请求，带编码回退：先按 UTF-8 解码，失败用 GB18030。
fn fetch_html(url: &str) -> Result<String, FetchError> {
    let resp = http_client()
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| request_error(url, e))?;

    // 先从 headers 取 Content-Type（bytes() 会消费 resp）
    let ct: Option<String> = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let bytes = resp
        .bytes()
        .map_err(|e| FetchError::Request(e.to_string()))?;

    if let Some(enc) = ct.as_ref().and_then(|c| charset_from_content_type(c)) {
        let (cow, _, _) = enc.decode(&bytes);
        return Ok(cow.into_owned());
    }
    // 先尝试 UTF-8 strict
    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => {
            let (cow, _, _) = encoding_rs::GB18030.decode(&bytes);
            Ok(cow.into_owned())
        }
    }
}

fn charset_from_content_type(ct: &str) -> Option<&'static encoding_rs::Encoding> {
    let lower = ct.to_ascii_lowercase();
    let idx = lower.find("charset=")?;
    let cs = lower[idx + 8..].split(';').next()?.trim();
    match cs {
        "utf-8" => Some(encoding_rs::UTF_8),
        "gbk" | "gb2312" | "gb18030" => Some(encoding_rs::GB18030),
        "big5" => Some(encoding_rs::BIG5),
        _ => None,
    }
}

/// 提取目录页的书籍标题和章节链接列表。
pub fn fetch_catalog(url: &str) -> Result<Catalog, FetchError> {
    with_retry(|| parse_catalog(&fetch_html(url)?, url))
}

fn parse_catalog(html: &str, url: &str) -> Result<Catalog, FetchError> {
    let doc = Html::parse_document(html);
    let base = Url::parse(url).map_err(|e| FetchError::Parse(e.to_string()))?;

    let book_title = extract_book_title(&doc).unwrap_or_else(|| fallback_book_title(&doc));

    let chapters = extract_chapter_links(&doc, &base);
    if chapters.is_empty() {
        return Err(FetchError::Parse(
            "未识别到任何章节链接。可能目录页结构特殊，请换其他网站试试。".into(),
        ));
    }
    Ok(Catalog {
        book_title,
        chapters,
    })
}

/// 书籍标题：取目录页中形如 `<a href="/novel/32125.html">书名</a>` 的链接文本
/// （末段为纯数字 + `.html`，即书籍详情页地址）。
fn extract_book_title(doc: &Html) -> Option<String> {
    let a_sel = Selector::parse("a").ok()?;
    let mut best: Option<String> = None;
    for a in doc.select(&a_sel) {
        let href = match a.value().attr("href") {
            Some(h) => h.trim(),
            None => continue,
        };
        if !is_book_detail_href(href) {
            continue;
        }
        let text: String = a.text().collect::<Vec<_>>().join("").trim().to_string();
        if text.is_empty() || text.chars().count() > 80 {
            continue;
        }
        // 页面里可能有多处指向详情页的链接（如“最新章节”等），取最长的作为书名
        if best.as_ref().map(|b| b.chars().count()).unwrap_or(0) < text.chars().count() {
            best = Some(text);
        }
    }
    best
}

/// 判断链接是否指向书籍详情页：最后一段为 `<数字>.html`，如 `/novel/32125.html`。
fn is_book_detail_href(href: &str) -> bool {
    let path = href.split(['?', '#']).next().unwrap_or(href).trim_end_matches('/');
    let last = path.rsplit('/').next().unwrap_or("");
    let stem = match last.strip_suffix(".html") {
        Some(s) => s,
        None => return false,
    };
    !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit())
}

/// 兜底书名：`<title>` → `<h1>` → 默认值。
fn fallback_book_title(doc: &Html) -> String {
    doc.select(&Selector::parse("title").unwrap())
        .next()
        .and_then(|n| n.text().next())
        .or_else(|| {
            doc.select(&Selector::parse("h1").unwrap())
                .next()
                .and_then(|n| n.text().next())
        })
        .unwrap_or("未知书籍")
        .trim()
        .to_string()
}

/// 从目录页提取章节链接。
///
/// 优先信任显式的章节列表容器（如 `ul.mulu_list`），容器内的链接直接视为章节，
/// 不做标题长度/关键字过滤；找不到容器时再退回全站 `<a>` 的启发式过滤。
fn extract_chapter_links(doc: &Html, base: &Url) -> Vec<ChapterRef> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();

    // 1) 显式章节列表容器
    let containers = [
        "ul.mulu_list",
        ".mulu_list",
        "ul.listmain",
        ".listmain",
        "#list",
        "#chapterlist",
        ".chapter-list",
        ".chapterlist",
        "#catalog",
        ".catalog",
        ".volume-wrap",
        ".section-list",
        ".book-list",
        "#mulu",
        ".mulu",
    ];
    for c in containers {
        if let Ok(sel) = Selector::parse(c) {
            let mut matched = false;
            for region in doc.select(&sel) {
                matched = true;
                collect_links(&region, base, &mut seen, &mut out, false);
            }
            if matched && !out.is_empty() {
                return out;
            }
        }
    }

    // 2) 降级：全站 <a> 启发式
    collect_links(&doc.root_element(), base, &mut seen, &mut out, true);
    out
}

fn collect_links(
    region: &scraper::ElementRef,
    base: &Url,
    seen: &mut HashSet<String>,
    out: &mut Vec<ChapterRef>,
    heuristic: bool,
) {
    let a_selector = Selector::parse("a").unwrap();
    for a in region.select(&a_selector) {
        let href = match a.value().attr("href") {
            Some(h) => h.trim(),
            None => continue,
        };
        if href.is_empty()
            || href.starts_with('#')
            || href.starts_with("javascript:")
            || href.starts_with("mailto:")
        {
            continue;
        }

        let absolute = match base.join(href) {
            Ok(u) => u.to_string(),
            Err(_) => continue,
        };

        // 过滤非 http / 明显非章节的地址
        let abs_lc = absolute.to_ascii_lowercase();
        if !abs_lc.starts_with("http") {
            continue;
        }
        if abs_lc.ends_with(".jpg")
            || abs_lc.ends_with(".png")
            || abs_lc.ends_with(".gif")
            || abs_lc.ends_with(".zip")
            || abs_lc.contains("/login")
            || abs_lc.contains("/register")
            || abs_lc.contains("/signin")
        {
            continue;
        }

        let title: String = a.text().collect::<Vec<_>>().join("").trim().to_string();
        if title.is_empty() || is_nav_title(&title) {
            continue;
        }

        // 注意用字符数而非字节数：中文标题字节数约为字符数的 3 倍，
        // 用 len() 会把稍长的中文标题误判为“太长”而丢弃。
        let chars = title.chars().count();
        if heuristic {
            if chars < 2 || chars > 60 || !looks_like_chapter_title(&title) {
                continue;
            }
        } else if chars > 120 {
            continue;
        }

        if !seen.insert(absolute.clone()) {
            continue;
        }
        out.push(ChapterRef {
            title,
            url: absolute,
        });
    }
}

fn looks_like_chapter_title(title: &str) -> bool {
    title.contains("章")
        || title.contains("节")
        || title.contains("卷")
        || title.contains("回")
        || title.contains("序")
        || title.contains("楔")
        || title.contains("尾声")
        || title.contains("番外")
        || title.contains("第")
        || title.starts_with("上")
        || title.starts_with("下")
}

/// 目录容器里偶尔混入的翻页/导航链接，排除掉。
fn is_nav_title(title: &str) -> bool {
    matches!(
        title,
        "上一页"
            | "下一页"
            | "首页"
            | "尾页"
            | "目录"
            | "返回目录"
            | "章节目录"
            | "上一章"
            | "下一章"
    )
}

/// 抓单个章节，返回章节名（`h3.j_chapterName`）与正文纯文本。
///
/// 站点偶发返回「章节不存在或获取失败！」这类错误页（同一 URL 重试即可恢复），
/// 因此这里对空正文/错误页做退避重试。
pub fn fetch_chapter(url: &str) -> Result<ChapterContent, FetchError> {
    with_retry(|| parse_chapter(&fetch_html(url)?, url))
}

fn parse_chapter(html: &str, url: &str) -> Result<ChapterContent, FetchError> {
    let doc = Html::parse_document(html);
    let title = extract_chapter_title(&doc);
    let content = extract_chapter_body(&doc);
    if content.is_empty() {
        return Err(FetchError::Empty(format!("未提取到正文内容：{}", url)));
    }
    if is_site_error_page(&content) {
        return Err(FetchError::Empty(format!(
            "站点返回错误页「{}」：{}",
            content, url
        )));
    }
    Ok(ChapterContent { title, content })
}

/// 识别站点自己的错误提示页（如「章节不存在或获取失败！」），
/// 避免把提示语当成正文写进 epub。
fn is_site_error_page(text: &str) -> bool {
    let t = text.trim();
    t.chars().count() < 80
        && (t.contains("章节不存在")
            || t.contains("获取失败")
            || t.contains("页面不存在")
            || t.contains("内容不存在")
            || t.contains("章节已删除"))
}

/// 章节名：优先站点约定的 `h3.j_chapterName`，其次通用标题。
fn extract_chapter_title(doc: &Html) -> String {
    for sel_str in ["h3.j_chapterName", ".j_chapterName", "h1", "h2", "title"] {
        if let Ok(sel) = Selector::parse(sel_str) {
            if let Some(node) = doc.select(&sel).next() {
                let text: String = node.text().collect::<Vec<_>>().join("").trim().to_string();
                if !text.is_empty() {
                    return text;
                }
            }
        }
    }
    String::new()
}

fn extract_chapter_body(doc: &Html) -> String {
    // 站点约定的正文容器：<div class="read-content j_readContent user_ad_content">
    for sel_str in [".read-content", ".j_readContent"] {
        if let Ok(sel) = Selector::parse(sel_str) {
            for node in doc.select(&sel) {
                let text = clean_node_text(&node);
                if !text.is_empty() {
                    return text;
                }
            }
        }
    }

    // 其他常见正文容器，取候选中最长的正文
    let candidates = [
        "#content",
        ".content",
        "#chaptercontent",
        ".chapter-content",
        ".chaptercontent",
        "#booktxt",
        ".showtxt",
        "#txt",
        ".txtnav",
        "#nr",
        "#nr1",
        ".novelcontent",
        ".novel-content",
        ".book-content",
        ".readcontent",
        ".article-content",
        ".post-content",
        ".entry-content",
        ".text",
    ];

    let mut best = String::new();
    for sel_str in candidates {
        if let Ok(sel) = Selector::parse(sel_str) {
            for node in doc.select(&sel) {
                let text = clean_node_text(&node);
                if text.chars().count() > best.chars().count() {
                    best = text;
                }
            }
        }
    }

    // 候选容器都没命中或太短时，降级到 body（同样过滤 script/style/nav 等）
    if best.chars().count() > 40 {
        return best;
    }
    if let Ok(body_sel) = Selector::parse("body") {
        if let Some(body) = doc.select(&body_sel).next() {
            let body_text = clean_node_text(&body);
            if body_text.chars().count() > best.chars().count() {
                return body_text;
            }
        }
    }
    best
}

fn clean_node_text(node: &scraper::ElementRef) -> String {
    let mut buf = String::new();
    collect_text(node, &mut buf);
    let lines: Vec<String> = buf
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .filter(|l| !is_noise(l))
        .collect();
    lines.join("\n")
}

/// 只收集当前元素“直接子节点”的文本，遇到元素节点则递归。
///
/// 注意：不能用 `ElementRef::text()`——它会递归返回所有后代文本，
/// 再配合子元素递归会导致内容被重复拼接（抓取结果与网页不一致的主因）。
fn collect_text(node: &scraper::ElementRef, out: &mut String) {
    for child in node.children() {
        if matches!(child.value(), Node::Element(_)) {
            let el = match scraper::ElementRef::wrap(child) {
                Some(e) => e,
                None => continue,
            };
            let tag = el.value().name();
            if is_skip_tag(tag) {
                continue;
            }
            let block = is_block_tag(tag);
            if block {
                out.push('\n');
            }
            collect_text(&el, out);
            if block {
                out.push('\n');
            }
        } else if let Node::Text(text) = child.value() {
            out.push_str(&text.text);
        }
    }
}

/// 这些标签里的文本不应作为正文（脚本/样式/导航等）。
fn is_skip_tag(tag: &str) -> bool {
    matches!(
        tag,
        "script"
            | "style"
            | "noscript"
            | "nav"
            | "footer"
            | "header"
            | "form"
            | "iframe"
            | "link"
            | "meta"
    )
}

/// 块级标签前后插入换行，保留段落结构。
fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "div"
            | "br"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "li"
            | "ul"
            | "ol"
            | "tr"
            | "dd"
            | "dt"
            | "blockquote"
            | "section"
            | "article"
    )
}

fn is_noise(line: &str) -> bool {
    let lc = line.to_ascii_lowercase();
    let noise_kw = [
        "点击",
        "收藏",
        "分享",
        "订阅",
        "推荐",
        "打赏",
        "扫码",
        "下载",
        "安装",
        "app",
        "广告",
        "版权",
        "本站",
        "原创",
        "转自",
        "复制",
        "搜索",
        "登陆",
        "登录",
        "注册",
        "书架",
        "换源",
        "缓存",
        "离线",
        "翻页",
        "上一页",
        "下一页",
        "章节目录",
        "返回顶部",
        "浏览器",
        "微信",
        "公众号",
    ];
    let count = line.chars().count();
    // 纯导航短句
    if count < 3 {
        return true;
    }
    // 全是标点或数字
    if !line.chars().any(|c| c.is_alphanumeric()) {
        return true;
    }
    // 仅对“短行”做关键词过滤，避免误删正文段落里出现的“推荐/下载”等词
    if count <= 15 {
        for kw in noise_kw {
            if lc.contains(kw) {
                return true;
            }
        }
    }
    false
}

// ==================== Tauri 命令 ====================

#[tauri::command]
pub fn scrape_catalog(url: String) -> Result<Catalog, String> {
    let normalized = normalize_url(&url).map_err(|e| e.to_string())?;
    fetch_catalog(&normalized).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scrape_chapter(url: String) -> Result<ChapterContent, String> {
    let normalized = normalize_url(&url).map_err(|e| e.to_string())?;
    fetch_chapter(&normalized).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_relative_urls() {
        let base = Url::parse("https://novel.example.com/book/1234/").unwrap();
        let tests = [
            ("ch1.html", "https://novel.example.com/book/1234/ch1.html"),
            ("./ch2.html", "https://novel.example.com/book/1234/ch2.html"),
            ("/book/1234/ch3.html", "https://novel.example.com/book/1234/ch3.html"),
        ];
        for (href, want) in tests {
            let got = base.join(href).unwrap().to_string();
            assert_eq!(got, want);
        }
    }

    #[test]
    fn chapter_title_heuristic() {
        for t in ["第一章 启程", "第二节", "第123章", "序章", "楔子", "尾声"] {
            assert!(looks_like_chapter_title(t), "should accept: {t}");
        }
        assert!(!looks_like_chapter_title("随便一段话"));
    }

    #[test]
    fn extract_all_chapters_from_mulu_list() {
        // 用户实际遇到的格式：ul.mulu_list + 带换行的链接文本
        let html = r#"<html><head><title>测试书</title></head><body>
        <ul class="mulu_list">
            <li><a href="/book/33160/b7d2d71b3c284.html" target="_blank">第一卷 第1章 重生，遇仇敌女友
</a></li>
            <li><a href="/book/33160/b7d2d71b3c285.html" target="_blank">第一卷 第2章 前尘往事如烟散
</a></li>
        </ul></body></html>"#;
        let doc = Html::parse_document(html);
        let base = Url::parse("https://www.example.com/book/33160/").unwrap();
        let chapters = extract_chapter_links(&doc, &base);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title, "第一卷 第1章 重生，遇仇敌女友");
        assert_eq!(chapters[1].title, "第一卷 第2章 前尘往事如烟散");
        assert!(chapters[0].url.ends_with("/book/33160/b7d2d71b3c284.html"));
    }

    #[test]
    fn long_chinese_title_not_dropped_in_fallback() {
        // 无章节容器时退回全站启发式；该标题字节数 > 40，但字符数不大，应保留
        let html = r#"<html><body><a href="/c1.html">第一卷 第1章 重生，遇仇敌女友</a></body></html>"#;
        let doc = Html::parse_document(html);
        let base = Url::parse("https://www.example.com/book/").unwrap();
        let chapters = extract_chapter_links(&doc, &base);
        assert_eq!(chapters.len(), 1);
    }

    #[test]
    fn book_title_from_novel_link() {
        // 用户实际遇到的格式：<li><a href="/novel/32125.html">书名</a></li>
        let html = r#"<html><head><title>网站名</title></head><body>
        <li><a href="/novel/32125.html">我能让女人出轨（我能看到出轨率）</a></li>
        <li><a href="/novel/32126.html">另一本书</a></li>
        </body></html>"#;
        let doc = Html::parse_document(html);
        assert_eq!(
            extract_book_title(&doc).as_deref(),
            Some("我能让女人出轨（我能看到出轨率）")
        );
        assert!(is_book_detail_href("/novel/32125.html"));
        assert!(is_book_detail_href("https://x.com/novel/32125.html?from=list"));
        assert!(!is_book_detail_href("/book/33160/b7d2d71b3c284.html"));
    }

    #[test]
    fn chapter_title_and_content_from_station_markup() {
        let html = r#"<html><head><title>章节页</title></head><body>
        <h3 class="j_chapterName">第一卷 第1章 重生，遇仇敌女友</h3>
        <div class="read-content j_readContent user_ad_content">
            <p>第一段正文。</p>
            <p>第二段正文。</p>
        </div>
        <script>var secret = 1;</script>
        </body></html>"#;
        let doc = Html::parse_document(html);
        assert_eq!(
            extract_chapter_title(&doc),
            "第一卷 第1章 重生，遇仇敌女友"
        );
        let body = extract_chapter_body(&doc);
        assert_eq!(body, "第一段正文。\n第二段正文。");
        assert!(!body.contains('<'));
        assert!(!body.contains("secret"));
    }

    #[test]
    fn site_error_page_detection() {
        assert!(is_site_error_page("章节不存在或获取失败！"));
        assert!(is_site_error_page("抱歉，页面不存在"));
        // 正常长正文里出现这些词不应被误判
        assert!(!is_site_error_page(&"这是一段正常的章节正文内容。".repeat(20)));
    }

    #[test]
    fn noise_detection() {
        assert!(is_noise("点击下载APP"));
        assert!(is_noise("下一页"));
        assert!(!is_noise("这是一段正常的正文内容，没有任何关键词"));
    }

    #[test]
    fn noise_only_filters_short_lines() {
        assert!(is_noise("点击推荐"));
        let long = "他向我推荐了这本书，说非常值得一读，并且反复强调了很多次。";
        assert!(!is_noise(long));
    }

    #[test]
    fn collect_text_keeps_structure_without_duplication() {
        let html = r#"<div class="content">
            <p>第一段正文。</p>
            <p>第二段<span>内嵌</span>文字。</p>
            <script>var secret = 1;</script>
            <style>.x{}</style>
        </div>"#;
        let doc = Html::parse_document(html);
        let sel = Selector::parse(".content").unwrap();
        let node = doc.select(&sel).next().unwrap();
        let text = clean_node_text(&node);
        assert_eq!(text, "第一段正文。\n第二段内嵌文字。");
        assert!(!text.contains("secret"));
        assert!(!text.contains("var"));
    }
}
