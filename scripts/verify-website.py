"""Check website references, search metadata and the sole production publisher."""

from collections import Counter
from html.parser import HTMLParser
import os
from pathlib import Path
import re
import struct
import sys
import unicodedata
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile

from website import (
    LANGUAGES,
    NOTES_FIXTURES,
    SITE_ORIGIN,
    SiteState,
    authored_markdown,
    code_block,
    copy_targets,
    page_language,
    page_url,
    source_digest,
    sync_pages,
    synced_code_ids,
    translation_record,
)

LEGACY_ORIGIN = "morluto.github.io"
SITE_TEXT_URL = re.compile(
    r"https?://(?:rea\.tools|morluto\.github\.io)/[^\s<>\"'`]+", re.IGNORECASE
)


def markdown_ids(path):
    """Collect GitHub heading anchors and explicit HTML IDs in local Markdown."""
    source = path.read_text(encoding="utf-8")
    parser = HtmlReferences()
    parser.feed(source)
    identifiers = set(parser.ids)
    counts = {}
    fenced = False
    for line in source.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        if fenced:
            continue
        heading = re.match(r"^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$", line)
        if not heading:
            continue
        text = re.sub(r"<[^>]*>", "", heading[1]).lower()
        slug = "".join(c for c in text if c in "-_ " or unicodedata.category(c)[0] in "LN").replace(" ", "-")
        count = counts.get(slug, 0)
        identifiers.add(f"{slug}-{count}" if count else slug)
        counts[slug] = count + 1
    return identifiers


def check_repository_links(root):
    """Check local links in website Markdown and current-repository source links."""
    errors = []
    sources = {}
    for path in authored_markdown(root):
        text = re.sub(r"(?ms)^\s*(```|~~~).*?^\s*\1[^\n]*$", "", path.read_text(encoding="utf-8"))
        text = re.sub(r"`[^`]*`", "", text)
        sources[path] = re.findall(r"\[[^\]\n]*\]\(([^\s)]+)\)", text)
    for path in sorted((root / "website/public").rglob("*.html")):
        parser = HtmlReferences()
        parser.feed(path.read_text(encoding="utf-8"))
        sources[path] = parser.references
    for path, references in sources.items():
        for reference in references:
            try:
                url = urlsplit(reference)
            except ValueError as error:
                errors.append(f"{path.relative_to(root)}: invalid URL {reference!r}: {error}")
                continue
            if url.hostname == LEGACY_ORIGIN and (url.path == "/rea" or url.path.startswith("/rea/")):
                errors.append(f"{path.relative_to(root)}: obsolete website URL: {reference}")
                continue
            if url.hostname == "github.com":
                match = re.match(r"^/morluto/rea/(?:blob|tree)/main/(.+)$", url.path)
                if not match:
                    continue
                target = (root / unquote(match[1])).resolve()
            elif url.scheme or url.netloc or path.suffix == ".html":
                continue
            else:
                target = (path.parent / unquote(url.path)).resolve() if url.path else path
            if not target.is_relative_to(root) or not target.exists():
                errors.append(f"{path.relative_to(root)}: missing repository target: {reference}")
            elif target.suffix == ".md" and url.fragment and unquote(url.fragment) not in markdown_ids(target):
                errors.append(f"{path.relative_to(root)}: missing Markdown fragment: {reference}")
    return errors


class HtmlReferences(HTMLParser):
    """Collect document IDs and references without fetching external URLs."""

    def __init__(self):
        super().__init__()
        self.ids = set()
        self.references = []
        self.duplicate_ids = []
        self.in_head = False
        self.in_title = False
        self.titles = []
        self.meta = {}
        self.properties = {}
        self.canonicals = []
        self.lang = None
        self.h1_count = 0
        self.text = []
        self.copy_targets = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "html":
            self.lang = attributes.get("lang")
        if tag == "h1":
            self.h1_count += 1
        if tag == "head":
            self.in_head = True
        if self.in_head:
            if tag == "title":
                self.titles.append("")
                self.in_title = True
            if (
                tag == "link"
                and "canonical" in (attributes.get("rel") or "").lower().split()
            ):
                self.canonicals.append(attributes.get("href") or "")
            if tag == "meta":
                for attribute, collection in (
                    ("name", self.meta),
                    ("property", self.properties),
                ):
                    key = attributes.get(attribute)
                    if key:
                        collection.setdefault(key.lower(), []).append(
                            attributes.get("content") or ""
                        )
        identifier = attributes.get("id")
        if identifier is not None:
            if identifier in self.ids:
                self.duplicate_ids.append(identifier)
            self.ids.add(identifier)
        for attribute in ("href", "src"):
            reference = attributes.get(attribute)
            if reference is not None:
                self.references.append(reference)
        if attributes.get("data-copy"):
            self.copy_targets.append(attributes["data-copy"])

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        self.text.append(data)
        if self.in_title:
            self.titles[-1] += data

    def noindex(self):
        """Recognize directives that exclude this page from Google's index."""
        directives = ",".join(
            self.meta.get("robots", []) + self.meta.get("googlebot", [])
        ).lower()
        return bool(set(re.split(r"[\s,]+", directives)) & {"noindex", "none"})


def check_search_metadata(site, pages):
    """Verify route-specific canonicals, sharing assets and the generated sitemap."""
    errors = []
    indexable = set()
    titles = set()
    for path, page in pages.items():
        label = path.relative_to(site).as_posix()
        title = page.titles[0].strip() if len(page.titles) == 1 else ""
        if not title:
            errors.append(f"{label}: needs exactly one nonempty head title")
        tag = LANGUAGES[page_language(site, path)[0]].tag
        if page.lang != tag or page.h1_count != 1:
            errors.append(f"{label}: needs lang={tag} and exactly one h1")
        if label in NOTES_FIXTURES and not page.noindex():
            errors.append(
                f"{label}: example application must have a head noindex directive"
            )
        if page.noindex():
            continue
        url = page_url(site, path)
        indexable.add(url)
        if page.canonicals != [url]:
            errors.append(f"{label}: needs exactly one head canonical for {url}")
        if title in titles:
            errors.append(f"{label}: duplicate search title {title!r}")
        titles.add(title)
        descriptions = page.meta.get("description", [])
        description = descriptions[0].strip() if len(descriptions) == 1 else ""
        if not description:
            errors.append(f"{label}: needs exactly one nonempty head description")
        expected_og = {
            "og:type": "website",
            "og:site_name": "REA",
            "og:title": title,
            "og:description": description,
            "og:url": url,
            "og:image": f"{SITE_ORIGIN}/assets/social-card.png",
            "og:image:type": "image/png",
            "og:image:width": "1200",
            "og:image:height": "630",
        }
        expected_twitter = {
            "twitter:card": "summary_large_image",
            "twitter:title": title,
            "twitter:description": description,
            "twitter:image": expected_og["og:image"],
        }
        for collection, expected in (
            (page.properties, expected_og),
            (page.meta, expected_twitter),
        ):
            for key, value in expected.items():
                if collection.get(key) != [value]:
                    errors.append(
                        f"{label}: {key} must appear once and match {value!r}"
                    )
        for collection, key in (
            (page.properties, "og:image:alt"),
            (page.meta, "twitter:image:alt"),
        ):
            values = collection.get(key, [])
            if len(values) != 1 or not values[0].strip():
                errors.append(f"{label}: needs exactly one nonempty {key}")

    sitemap_path = site / "sitemap.xml"
    try:
        sitemap = ET.parse(sitemap_path).getroot()
        namespace = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
        urls = [entry.findtext(f"{namespace}loc") for entry in sitemap]
        if sitemap.tag != f"{namespace}urlset" or any(
            entry.tag != f"{namespace}url" for entry in sitemap
        ):
            errors.append("sitemap.xml: needs a sitemap-protocol urlset")
        if len(urls) != len(set(urls)) or set(urls) != indexable:
            errors.append(
                "sitemap.xml: must contain each indexable page once, using its rea.tools URL"
            )
        if any(
            len(entry) != 1 or entry[0].tag != f"{namespace}loc" for entry in sitemap
        ):
            errors.append(
                "sitemap.xml: keep entries to loc; do not invent lastmod or add priority/changefreq"
            )
    except (OSError, ET.ParseError) as error:
        errors.append(
            f"sitemap.xml: cannot read sitemap ({error}); run scripts/prepare-website.py"
        )

    robots_path = site / "robots.txt"
    if not robots_path.is_file():
        errors.append("robots.txt: authored crawl rules are missing")
    else:
        directives = []
        for line in robots_path.read_text(encoding="utf-8").splitlines():
            value = line.split("#", 1)[0].strip()
            if value:
                key, separator, content = value.partition(":")
                directives.append(
                    (key.lower(), content.strip()) if separator else (value, "")
                )
        expected = [
            ("user-agent", "*"),
            ("allow", "/"),
            ("sitemap", f"{SITE_ORIGIN}/sitemap.xml"),
        ]
        if directives != expected:
            errors.append(
                "robots.txt: expected crawl access and one absolute rea.tools sitemap directive"
            )

    image = site / "assets/social-card.png"
    if not image.is_file():
        errors.append("Social preview PNG is missing; run scripts/prepare-website.py")
    else:
        header = image.read_bytes()[:24]
        if (
            len(header) != 24
            or header[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
            or struct.unpack(">II", header[16:24]) != (1200, 630)
        ):
            errors.append("Social preview must be a 1200 × 630 PNG")
    return len(indexable), errors


def parse_pages(site):
    """Parse every HTML page once for reference, metadata and translation checks."""
    pages = {}
    for path in sorted(site.rglob("*.html")):
        parser = HtmlReferences()
        parser.feed(path.read_text(encoding="utf-8"))
        pages[path] = parser
    return pages


def check_site(site):
    """Check assets, HTML fragment destinations and SVG syntax."""
    pages = parse_pages(site)
    errors = []
    references = 0
    if site / "index.html" not in pages:
        errors.append("website/public/index.html is missing")

    for path, page in pages.items():
        label = path.relative_to(site)
        for identifier in page.duplicate_ids:
            errors.append(f"{label}: duplicate ID {identifier!r}")
        for identifier in page.copy_targets:
            if identifier not in page.ids:
                errors.append(f"{label}: missing copy target: {identifier}")
        text_urls = [match.group().rstrip(".,;)") for match in SITE_TEXT_URL.finditer(" ".join(page.text))]
        for reference in page.references + text_urls:
            try:
                url = urlsplit(reference)
            except ValueError as error:
                errors.append(f"{label}: invalid URL {reference!r}: {error}")
                continue
            if url.hostname == LEGACY_ORIGIN and (url.path == "/rea" or url.path.startswith("/rea/")):
                errors.append(f"{label}: obsolete website URL: {reference}; use rea.tools")
                continue
            if url.hostname == "rea.tools":
                if url.scheme != "https" or url.netloc != "rea.tools":
                    errors.append(f"{label}: website URL must use {SITE_ORIGIN}: {reference}")
                    continue
                target = (site / unquote(url.path).lstrip("/")).resolve()
            elif url.scheme or url.netloc:
                continue
            elif url.path.startswith("/"):
                errors.append(f"{label}: use a relative site reference: {reference}")
                continue
            else:
                target = (path.parent / unquote(url.path)).resolve() if url.path else path
            references += 1
            if not target.is_relative_to(site):
                errors.append(f"{label}: reference leaves the website: {reference}")
                continue
            if target.is_dir():
                target /= "index.html"
            if not target.is_file():
                errors.append(f"{label}: missing local target: {reference}")
            elif (
                target in pages
                and url.fragment
                and unquote(url.fragment) not in pages[target].ids
            ):
                errors.append(f"{label}: missing HTML fragment: {reference}")

    for path in sorted(site.rglob("*.svg")):
        try:
            ET.parse(path)
        except ET.ParseError as error:
            errors.append(f"{path.relative_to(site)}: invalid SVG XML: {error}")
    indexable, metadata_errors = check_search_metadata(site, pages)
    errors.extend(metadata_errors)
    return len(pages), references, indexable, errors


# Han, kana and CJK punctuation; a space between two of them renders as a gap.
CJK_GAP = re.compile(
    r"([、-〿぀-ヿ㐀-䶿一-鿿豈-﫿！-￯])"
    r"\s+([、-〿぀-ヿ㐀-䶿一-鿿豈-﫿！-￯])"
)
CODE_TAGS = {"code", "kbd", "pre", "script", "style"}


class TranslationText(HTMLParser):
    """Collect prose, inline code and message attributes for comparing translations."""

    def __init__(self, synced):
        super().__init__()
        self.synced = set(synced)
        self.stack = []
        self.prose = []
        self.inline_code = Counter()
        self.messages = Counter()

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        self.messages.update(name for name in attributes if name.startswith("data-msg-"))
        if tag in CODE_TAGS:
            self.stack.append([tag, attributes.get("id"), ""])

    def handle_startendtag(self, tag, attrs):
        attributes = dict(attrs)
        self.messages.update(name for name in attributes if name.startswith("data-msg-"))

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1][0] == tag:
            name, identifier, text = self.stack.pop()
            if name in ("code", "kbd") and identifier not in self.synced:
                self.inline_code[" ".join(text.split())] += 1
            if self.stack:
                self.stack[-1][2] += text

    def handle_data(self, data):
        if self.stack:
            self.stack[-1][2] += data
        else:
            self.prose.append(data)


def translation_warning(path, root, message):
    """Return a warning tied to a repository file."""
    return (path.relative_to(root).as_posix(), message)


def check_translations(root, pages):
    """Check translation records, copied code, structure parity and CJK spacing.

    A changed English source is a warning: its translation keeps working, shows a
    notice after sync and is updated later. Errors cover what sync or the
    translator controls directly.
    """
    site = root / "website/public"
    errors = []
    warnings = []
    try:
        state = SiteState(root)
    except ValueError as error:
        return [str(error)], []
    for path, page in pages.items():
        language, english = page_language(site, path)
        if language == "en":
            continue
        label = path.relative_to(site).as_posix()
        source = path.read_text(encoding="utf-8")
        record = translation_record(source)
        english_path = site / english
        if not english_path.is_file():
            errors.append(f"{label}: translates {english}, which does not exist")
            continue
        english_source = english_path.read_text(encoding="utf-8")
        if record is None:
            errors.append(f"{label}: needs one <!-- website:translation source-sha256=... status=... --> record")
            continue
        status = record.get("status")
        if status not in ("draft", "reviewed"):
            errors.append(f"{label}: translation status must be draft or reviewed")
        if status == "draft" and not page.noindex():
            errors.append(f"{label}: a draft translation needs <meta name=\"robots\" content=\"noindex\" />")
        if status == "reviewed":
            if page.noindex():
                errors.append(f"{label}: remove noindex from a reviewed translation")
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", record.get("reviewed", "")):
                errors.append(f"{label}: a reviewed translation needs reviewed=\"YYYY-MM-DD\"")
        fresh = record.get("source-sha256") == source_digest(english_source)
        if not fresh:
            warnings.append(translation_warning(
                path, root,
                f"The English page {english} has changed since this translation. Update the translation, "
                "then set source-sha256 to the new value from python3 scripts/website.py translations.",
            ))

        synced = synced_code_ids(english_source)
        for identifier in synced:
            expected = code_block(identifier).search(english_source).group(2)
            found = code_block(identifier).findall(source)
            if len(found) != 1 or found[0][1] != expected:
                errors.append(f"{label}: code block {identifier} must match the English page; run sync")

        english_page = pages[english_path]
        differences = []
        if page.ids != english_page.ids:
            differences.append(
                f"element IDs differ (missing {sorted(english_page.ids - page.ids)}, extra {sorted(page.ids - english_page.ids)})"
            )
        if copy_targets(source) != copy_targets(english_source):
            differences.append("copy buttons differ from the English page")
        translated = TranslationText(synced)
        translated.feed(source)
        original = TranslationText(synced)
        original.feed(english_source)
        if translated.messages != original.messages:
            differences.append("data-msg-* message attributes differ from the English page")
        for difference in differences:
            if fresh:
                errors.append(f"{label}: {difference}")
            else:
                warnings.append(translation_warning(path, root, difference))
        if fresh and translated.inline_code != original.inline_code:
            changed = sorted((translated.inline_code - original.inline_code) + (original.inline_code - translated.inline_code))
            warnings.append(translation_warning(
                path, root, f"inline code differs from the English page: {', '.join(repr(text) for text in changed[:5])}",
            ))

        if language in ("ja", "zh-hans", "zh-hant"):
            for text in translated.prose:
                for match in CJK_GAP.finditer(text):
                    errors.append(
                        f"{label}: whitespace between {match.group(1)!r} and {match.group(2)!r} renders as a gap; "
                        "keep CJK text on one line without spaces"
                    )

        for reference in page.references:
            url = urlsplit(reference)
            if url.scheme or url.netloc or not url.path or reference.startswith("/"):
                continue
            target = (path.parent / unquote(url.path)).resolve()
            if target.is_dir():
                target /= "index.html"
            if not target.is_relative_to(site.resolve()):
                continue
            target_language, target_english = page_language(site.resolve(), target)
            if (
                target_language == "en"
                and target_english != english
                and state.translations.get((language, target_english)) == "reviewed"
            ):
                warnings.append(translation_warning(
                    path, root, f"links to the English {target_english}; link to its reviewed translation instead",
                ))

    english_strings = state.locales["en"]["strings"]
    for code in LANGUAGES:
        if code == "en" or not any(key[0] == code for key in state.translations):
            continue
        locale = state.locales[code]
        same = sorted(
            key for key, value in locale["strings"].items()
            if value == english_strings[key] and key not in locale.get("sameAsEnglish", [])
        )
        if same:
            warnings.append((f"website/locales/{code}.json", f"UI strings still in English: {', '.join(same)}"))
    return errors, warnings


def report_warnings(warnings):
    """Print warnings, as GitHub annotations and a job summary when running in Actions."""
    for file, message in warnings:
        print(f"Warning: {file}: {message}")
    if os.environ.get("GITHUB_ACTIONS") != "true" or not warnings:
        return
    for file, message in warnings:
        print(f"::warning file={file}::{message}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write("### Website warnings\n\n")
            output.writelines(f"- `{file}`: {message}\n" for file, message in warnings)


def check_publisher(root):
    """Detect a second Pages action that could replace the website."""
    expected = root / ".github/workflows/website-pages.yml"
    workflows = root / ".github/workflows"
    deploy_action = re.compile(
        r"^\s*-?\s*uses:\s*['\"]?actions/deploy-pages@", re.MULTILINE
    )
    publishers = [
        path
        for path in sorted(workflows.iterdir())
        if path.suffix in (".yml", ".yaml")
        and deploy_action.search(path.read_text(encoding="utf-8"))
    ]
    if publishers != [expected]:
        actual = ", ".join(str(path.relative_to(root)) for path in publishers) or "none"
        return [f"Pages must have one publisher, website-pages.yml; found: {actual}"]
    return []


def check_example_archive(site):
    """Verify the downloadable ZIP contains the current six source files."""
    source = site / "examples/notes-electron"
    expected = {
        f"notes-example/{name}": source / name
        for name in (
            "package.json",
            "main.js",
            "preload.js",
            "renderer.js",
            "csv.js",
            "index.html",
        )
    }
    path = site / "examples/notes-example.zip"
    if not path.is_file():
        return ["Notes example ZIP is missing; run python3 scripts/prepare-website.py."]
    try:
        with ZipFile(path) as archive:
            if sorted(archive.namelist()) != sorted(expected):
                return [
                    "Notes example ZIP must contain exactly the six files in notes-example/."
                ]
            return [
                f"Notes example ZIP has stale source: {name}"
                for name, original in expected.items()
                if archive.read(name) != original.read_bytes()
            ]
    except (BadZipFile, RuntimeError) as error:
        return [f"Notes example ZIP cannot be read: {error}"]


def main():
    """Run the same checks locally, on website PRs and before publishing."""
    root = Path(__file__).resolve().parent.parent
    pages, references, indexable, errors = check_site(root / "website/public")
    errors.extend(check_example_archive(root / "website/public"))
    errors.extend(check_publisher(root))
    errors.extend(check_repository_links(root))
    translation_errors, warnings = check_translations(root, parse_pages(root / "website/public"))
    errors.extend(translation_errors)
    try:
        for path in sync_pages(root, check=True):
            warnings.append(translation_warning(
                path, root, "the out-of-date notice needs refreshing; run python3 scripts/website.py sync",
            ))
    except (OSError, ValueError, KeyError) as error:
        errors.append(str(error))
    report_warnings(warnings)
    if errors:
        print("Website checks failed:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print(
        f"Verified {pages} HTML pages, {references} local references, SVG XML and the example ZIP."
    )
    print(
        f"Verified search/sharing metadata, robots.txt and the sitemap for {indexable} indexable pages."
    )
    print("website-pages.yml is the sole GitHub Pages publisher.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
