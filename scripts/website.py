"""Maintain shared HTML and run the static website's contributor commands."""

import argparse
from collections import namedtuple
from functools import partial
from hashlib import sha256
from html import escape
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
from string import Template
import subprocess
import sys
from textwrap import indent
from urllib.parse import quote, urlsplit, urlunsplit


SITE_ORIGIN = "https://rea.tools"
NOTES_FIXTURES = {"examples/notes-electron/index.html", "examples/notes-web/index.html"}
# Each label is a key in website/locales/<language>.json.
NAVIGATION = (
    ("navShowcases", "showcase/"),
    ("navBlog", "blog/"),
    ("navGetStarted", "get-started/"),
    ("navGuides", "guides/"),
    ("navFaq", "faq/"),
)
Language = namedtuple("Language", "tag name og_locale")
# English stays at the root; every other language lives under its directory.
# The order is the language menu's order.
LANGUAGES = {
    "en": Language("en", "English", "en_US"),
    "zh-hans": Language("zh-Hans", "简体中文", "zh_CN"),
    "zh-hant": Language("zh-Hant", "繁體中文", "zh_TW"),
    "ja": Language("ja", "日本語", "ja_JP"),
    "ko": Language("ko", "한국어", "ko_KR"),
    "de": Language("de", "Deutsch", "de_DE"),
    "fr": Language("fr", "Français", "fr_FR"),
}
TRANSLATION_STATUSES = ("draft", "reviewed")
TRANSLATION_RECORD = re.compile(r"<!-- website:translation((?:\s+[\w-]+=\"[^\"]*\")*)\s*-->")
SHARED_REGION = re.compile(r"<!-- website:([\w-]+):start -->.*?<!-- website:\1:end -->", re.S)
NOTICE_START = "      <!-- website:translation-notice:start -->\n"
NOTICE_END = "      <!-- website:translation-notice:end -->"
GLOBE_PATH = (
    "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z M3.6 9h16.8 M3.6 15h16.8 "
    "M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9s1.2-6.5 3.6-9Z"
)


def authored_markdown(root):
    """Discover website documentation while excluding local environments and vendors."""
    site = root / "website"
    return [
        path for path in sorted(site.rglob("*.md"))
        if not any(part.startswith(".") or part in ("node_modules", "__pycache__")
                   for part in path.relative_to(site).parts)
    ]


class PageMetadata(HTMLParser):
    """Read the authored title, description and indexing policy from the head."""

    def __init__(self):
        super().__init__()
        self.in_head = False
        self.in_title = False
        self.titles = []
        self.descriptions = []
        self.noindex = False

    def handle_starttag(self, tag, attrs):
        if tag == "head":
            self.in_head = True
        if not self.in_head:
            return
        if tag == "title":
            self.in_title = True
            self.titles.append("")
        if tag == "meta":
            attributes = dict(attrs)
            name = (attributes.get("name") or "").lower()
            content = attributes.get("content") or ""
            if name == "description":
                self.descriptions.append(content)
            if name in ("robots", "googlebot"):
                self.noindex |= bool(
                    set(content.lower().replace(",", " ").split()) & {"noindex", "none"}
                )

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.titles[-1] += data


def file_route(relative):
    """Map a site-relative HTML file to its public route."""
    return relative.removesuffix("index.html") if PurePosixPath(relative).name == "index.html" else relative


def page_route(site, path):
    """Map an HTML file to its public route without a separate page registry."""
    return file_route(path.relative_to(site).as_posix())


def page_url(site, path):
    """Return the canonical public URL of an authored HTML file."""
    return f"{SITE_ORIGIN}/{quote(page_route(site, path), safe='/')}"


def page_language(site, path):
    """Return a page's language directory and the site-relative file of its English source."""
    relative = path.relative_to(site).as_posix()
    first, separator, rest = relative.partition("/")
    if separator and first in LANGUAGES and first != "en":
        return first, rest
    return "en", relative


def load_locales(root):
    """Read the UI strings for every language and require the same keys as English."""
    directory = root / "website/locales"
    locales = {}
    for code in LANGUAGES:
        path = directory / f"{code}.json"
        try:
            locale = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError(f"website/locales/{code}.json: cannot read UI strings: {error}") from error
        locales[code] = locale
    expected = set(locales["en"]["strings"])
    for code, locale in locales.items():
        label = f"website/locales/{code}.json"
        strings = locale.get("strings")
        if not isinstance(strings, dict) or set(strings) != expected:
            missing = sorted(expected - set(strings or {}))
            extra = sorted(set(strings or {}) - expected)
            raise ValueError(f"{label}: strings must match en.json (missing {missing}, extra {extra})")
        if any(not isinstance(value, str) or not value.strip() for value in strings.values()):
            raise ValueError(f"{label}: every UI string must be nonempty text")
        stars = locale.get("githubStars")
        if not isinstance(stars, dict) or "other" not in stars or not set(stars) <= {"zero", "one", "two", "few", "many", "other"}:
            raise ValueError(f"{label}: githubStars needs an 'other' label and CLDR plural categories only")
        if any("{count}" not in value for value in stars.values()):
            raise ValueError(f"{label}: every githubStars label needs a {{count}} placeholder")
        if "{link}" not in strings["staleNotice"]:
            raise ValueError(f"{label}: staleNotice needs a {{link}} placeholder")
        same = locale.get("sameAsEnglish", [])
        if not isinstance(same, list) or not set(same) <= expected:
            raise ValueError(f"{label}: sameAsEnglish must list UI string keys")
    return locales


def translation_record(source):
    """Return the attributes of a translation's provenance comment, or None."""
    records = TRANSLATION_RECORD.findall(source)
    if len(records) != 1:
        return None
    return dict(re.findall(r'([\w-]+)="([^"]*)"', records[0]))


def copy_targets(source):
    """Return the IDs referenced by copy buttons, in page order."""
    return list(dict.fromkeys(re.findall(r'\bdata-copy="([^"]+)"', source)))


def code_block(identifier):
    """Match a code element by ID, capturing its opening tag, contents and end tag."""
    return re.compile(rf'(<code\b[^>]*\bid="{re.escape(identifier)}"[^>]*>)(.*?)(</code>)', re.S)


def synced_code_ids(source):
    """Return the copy targets that are code blocks; translations take them from English."""
    return [identifier for identifier in copy_targets(source) if code_block(identifier).search(source)]


def source_digest(source):
    """Hash an English page's translatable content.

    Shared regions and copied code blocks are left out, so template edits and
    command-only changes do not mark translations out of date.
    """
    content = SHARED_REGION.sub("", source)
    for identifier in synced_code_ids(source):
        content = code_block(identifier).sub(r"\1\3", content)
    return sha256(" ".join(content.split()).encode("utf-8")).hexdigest()


def sync_code_blocks(english, source, label):
    """Copy every synced code block's contents from the English source, matched by ID."""
    for identifier in synced_code_ids(english):
        contents = code_block(identifier).search(english).group(2)
        pattern = code_block(identifier)
        if len(pattern.findall(source)) != 1:
            raise ValueError(f"{label}: needs one <code id=\"{identifier}\"> block copied from the English page")
        source = pattern.sub(lambda match: match.group(1) + contents + match.group(3), source)
    return source


class SiteState:
    """Read the locales and every translation's status once for a sync or check."""

    def __init__(self, root):
        self.root = root
        self.site = root / "website/public"
        self.locales = load_locales(root)
        self.translations = {}
        for path in sorted(self.site.rglob("*.html")):
            language, english = page_language(self.site, path)
            if language != "en":
                record = translation_record(path.read_text(encoding="utf-8")) or {}
                self.translations[(language, english)] = record.get("status")

    def linkable(self, language, english, from_draft=False):
        """Report whether other pages may link to this language's version of a page."""
        if language == "en":
            return (self.site / english).is_file()
        status = self.translations.get((language, english))
        return status == "reviewed" or (from_draft and status == "draft")

    def alternates(self, english):
        """Return the languages whose versions of a page join its hreflang cluster."""
        return [code for code in LANGUAGES if code == "en" or self.translations.get((code, english)) == "reviewed"]


def language_url(language, english):
    """Return the canonical URL of one language's version of a page."""
    prefix = "" if language == "en" else f"{language}/"
    return f"{SITE_ORIGIN}/{quote(prefix + file_route(english), safe='/')}"


def shared_blocks(root, path, source, state=None):
    """Render shared regions while keeping the page's body and metadata authored."""
    state = state or SiteState(root)
    site = state.site
    metadata = PageMetadata()
    metadata.feed(source)
    for name, values in (("title", metadata.titles), ("description", metadata.descriptions)):
        if len(values) != 1 or not values[0].strip():
            raise ValueError(f"{path.relative_to(site)}: needs one nonempty head {name}")
    language, english = page_language(site, path)
    strings = state.locales[language]["strings"]
    depth = len(path.relative_to(site).parent.parts)
    base = "../" * depth or "./"
    route = file_route(english)
    draft = language != "en" and state.translations.get((language, english)) == "draft"

    def href(target_language, target):
        prefix = "" if target_language == "en" else f"{target_language}/"
        return base + file_route(prefix + target)

    def localized(target):
        """Prefer this language's version of a target page, else the English page."""
        if language != "en" and state.linkable(language, target, from_draft=draft):
            return language, href(language, target)
        return "en", href("en", target)

    links = []
    for key, destination in NAVIGATION:
        target_language, url = localized(destination + "index.html")
        attributes = ' class="nav-start"' if destination == "get-started/" else ""
        if route.startswith(destination):
            attributes += ' aria-current="page"'
        badge = ""
        if target_language != language:
            attributes += ' hreflang="en"'
            badge = '<span class="nav-badge" lang="en">EN</span>'
        links.append(f'      <a href="{url}"{attributes}>{escape(strings[key])}{badge}</a>')

    entries = []
    for code, details in LANGUAGES.items():
        if code == language or state.linkable(code, english):
            url = href(code, english)
        elif state.linkable(code, "index.html"):
            url = href(code, "index.html")
        else:
            continue
        current = ' aria-current="true"' if code == language else ""
        entries.append(
            f'          <li><a href="{url}" hreflang="{details.tag}" lang="{details.tag}"{current}>{details.name}</a></li>'
        )
    language_menu = ""
    if len(entries) > 1:
        language_menu = "\n".join((
            "",
            '      <details class="language-menu">',
            "        <summary>",
            '          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
            f'            <path fill="none" stroke="currentColor" stroke-width="1.6" d="{GLOBE_PATH}" />',
            "          </svg>",
            f'          <span class="sr-only">{escape(strings["language"])}: </span>'
            f'<span class="language-current">{LANGUAGES[language].name}</span>',
            "        </summary>",
            '        <ul class="language-list">',
            *entries,
            "        </ul>",
            "      </details>",
        ))

    members = [] if draft else state.alternates(english)
    hreflang = ""
    locale_alternates = ""
    if len(members) > 1:
        for code in [*members, "x-default"]:
            tag = LANGUAGES[code].tag if code != "x-default" else code
            url = language_url(code if code != "x-default" else "en", english)
            hreflang += f'\n<!-- prettier-ignore -->\n<link rel="alternate" hreflang="{tag}" href="{escape(url, quote=True)}" />'
        for code in members:
            if code != language:
                locale_alternates += (
                    f'\n<!-- prettier-ignore -->\n<meta property="og:locale:alternate" content="{LANGUAGES[code].og_locale}" />'
                )

    labels = "".join(
        f'\n        data-label-{category}="{escape(label, quote=True)}"'
        for category, label in state.locales[language]["githubStars"].items()
    )
    values = {
        "base": base,
        "brand": localized("index.html")[1],
        "navigation": "\n" + "\n".join(links) + "\n    ",
        "language_menu": language_menu,
        "canonical": escape(page_url(site, path), quote=True),
        "hreflang": hreflang,
        "og_locale": LANGUAGES[language].og_locale,
        "og_locale_alternates": locale_alternates,
        "origin": SITE_ORIGIN,
        "title": escape(metadata.titles[0].strip(), quote=True),
        "description": escape(metadata.descriptions[0].strip(), quote=True),
        "github_star_labels": labels,
        **{f"t_{key}": escape(value, quote=True) for key, value in strings.items()},
    }
    templates = root / "website/templates"
    return {
        name: indent(Template((templates / f"{name}.html.tmpl").read_text(encoding="utf-8")).substitute(values), "    ")
        for name in ("sharing", "header", "footer")
    }


def translation_notice(state, path, english_source, record):
    """Render the stale-translation notice, or nothing while the source hash matches."""
    if record is None or record.get("source-sha256") == source_digest(english_source):
        return ""
    language, english = page_language(state.site, path)
    strings = state.locales[language]["strings"]
    depth = len(path.relative_to(state.site).parent.parts)
    link = (
        f'<a href="{"../" * depth}{file_route(english)}" hreflang="en">'
        f'{escape(strings["staleNoticeLink"])}</a>'
    )
    message = escape(strings["staleNotice"]).replace("{link}", link)
    return f'      <!-- prettier-ignore -->\n      <p class="translation-notice" role="note">{message}</p>\n'


def replace_region(source, start, end, block, label, name):
    """Replace the contents of one marked region."""
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError(f"{label}: needs one {name} region; use new-page or translate for a new page")
    before, _, remaining = source.partition(start)
    _, found, after = remaining.partition(end)
    if not found:
        raise ValueError(f"{label}: {name} region is out of order")
    return before + start + block + end + after


def region_contents(source, start, end):
    """Return the current contents of a marked region."""
    return source.partition(start)[2].partition(end)[0]


def sync_pages(root, check=False):
    """Update shared regions, or reject drift without changing any authored file.

    Returns the pages that changed. With check=True, structural drift raises, so
    the returned pages are translations whose only drift is the stale notice;
    an out-of-date translation is a warning rather than a failure.
    """
    state = SiteState(root)
    site = state.site
    changes = []
    notices = []
    for path in sorted(site.rglob("*.html")):
        if path.relative_to(site).as_posix() in NOTES_FIXTURES:
            continue
        label = path.relative_to(site).as_posix()
        original = path.read_text(encoding="utf-8")
        source = original
        language, english = page_language(site, path)
        english_source = None
        if language != "en":
            english_path = site / english
            if not english_path.is_file():
                raise ValueError(f"{label}: translates {english}, which does not exist")
            english_source = english_path.read_text(encoding="utf-8")
            source = sync_code_blocks(english_source, source, label)
        for name, block in shared_blocks(root, path, source, state).items():
            source = replace_region(
                source, f"    <!-- website:{name}:start -->\n", f"    <!-- website:{name}:end -->", block, label, name
            )
        if language != "en":
            notice = translation_notice(state, path, english_source, translation_record(source))
            structural = replace_region(
                source, NOTICE_START, NOTICE_END, region_contents(original, NOTICE_START, NOTICE_END), label,
                "translation-notice",
            )
            source = replace_region(source, NOTICE_START, NOTICE_END, notice, label, "translation-notice")
            if structural == original and source != original:
                notices.append((path, source))
                continue
        if source != original:
            changes.append((path, source))
    if check and changes:
        names = ", ".join(str(path.relative_to(site)) for path, _ in changes)
        raise ValueError(f"Shared HTML is stale: {names}. Run python3 scripts/website.py sync and commit the updated pages.")
    if not check:
        for path, source in changes + notices:
            path.write_text(source, encoding="utf-8")
    if check:
        print(f"Checked shared HTML ({len(notices)} translation notices to refresh).")
    else:
        print(f"Synced shared HTML ({len(changes) + len(notices)} pages changed).")
    return [path for path, _ in (notices if check else changes + notices)]


def new_page(root, route, title, description):
    """Create a draft reading page with correct depth, metadata and shared regions."""
    parts = PurePosixPath(route)
    if not route or parts.is_absolute() or ".." in parts.parts or "\\" in route or parts.suffix:
        raise ValueError("Use a relative directory route, such as blog/my-article.")
    if parts.parts[0] in LANGUAGES:
        raise ValueError("Create the English page first, then use translate for another language.")
    site = root / "website/public"
    path = site.joinpath(*parts.parts, "index.html")
    if not path.resolve().is_relative_to(site.resolve()):
        raise ValueError("The new page must stay inside website/public.")
    if path.exists():
        raise ValueError(f"Page already exists: {path.relative_to(site)}")
    base = "../" * len(parts.parts) or "./"
    source = Template((root / "website/templates/page.html").read_text(encoding="utf-8")).substitute(
        title=escape(title, quote=True), description=escape(description, quote=True), base=base,
    )
    # Render before writing, so invalid input cannot leave an incomplete page.
    blocks = shared_blocks(root, path, source)
    for name, block in blocks.items():
        source = source.replace(f"    <!-- website:{name}:start -->\n", f"    <!-- website:{name}:start -->\n{block}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    print(f"Created {path.relative_to(root)}. Write the page, add its index link, then remove the Draft label and noindex directive when ready.")
    return path


def relocate_references(source, english, language, state):
    """Rewrite relative references for the translation's directory.

    Pages that already have a version in this language link to it; everything
    else keeps pointing at the English page or asset.
    """
    english_directory = posixpath.dirname(english)
    translation_directory = posixpath.join(language, english_directory)

    def rewrite(match):
        value = match.group(2)
        url = urlsplit(value)
        if not value or url.scheme or url.netloc or value.startswith(("#", "/")):
            return match.group(0)
        target = posixpath.normpath(posixpath.join(english_directory, url.path))
        directory = url.path.endswith("/") or target == "."
        if directory:
            page = "index.html" if target == "." else f"{target}/index.html"
            if (language, page) in state.translations:
                target = posixpath.normpath(posixpath.join(language, target))
        relative = posixpath.relpath(target, translation_directory or ".")
        if directory:
            relative = "./" if relative == "." else relative + "/"
        return f'{match.group(1)}="{urlunsplit(("", "", relative, url.query, url.fragment))}"'

    return re.sub(r'\b(href|src)="([^"]*)"', rewrite, source)


def new_translation(root, language, route):
    """Create a draft translation of an English page, ready to be translated in place."""
    if language not in LANGUAGES or language == "en":
        raise ValueError(f"Choose one of: {', '.join(code for code in LANGUAGES if code != 'en')}.")
    route = route.strip("/")
    parts = PurePosixPath(route) if route not in ("", ".") else PurePosixPath()
    if parts.is_absolute() or ".." in parts.parts or "\\" in route or parts.suffix:
        raise ValueError("Use the English page's directory route, such as get-started, or / for the home page.")
    if parts.parts and parts.parts[0] in LANGUAGES:
        raise ValueError("Name the English route, without a language directory.")
    english = PurePosixPath(*parts.parts, "index.html").as_posix()
    state = SiteState(root)
    site = state.site
    source_path = site / english
    if not source_path.is_file() or english in NOTES_FIXTURES:
        raise ValueError(f"No English page to translate at {english}.")
    path = site / language / english
    if path.exists():
        raise ValueError(f"Translation already exists: {path.relative_to(site)}")
    source = source_path.read_text(encoding="utf-8")
    if source.count('<html lang="en">') != 1 or source.count("    <!-- website:sharing:start -->\n") != 1:
        raise ValueError(f"{english}: needs <html lang=\"en\"> and one sharing region")
    main = re.search(r"^ {4}<main\b[^>]*>\n", source, re.M)
    if main is None:
        raise ValueError(f"{english}: needs a <main> element on its own line")
    source = source.replace('<html lang="en">', f'<html lang="{LANGUAGES[language].tag}">')
    source = relocate_references(source, english, language, state)
    record = (
        f'    <!-- website:translation source-sha256="{source_digest(source_path.read_text(encoding="utf-8"))}" '
        'status="draft" -->\n'
    )
    robots = "" if '<meta name="robots"' in source else '    <meta name="robots" content="noindex" />\n'
    source = source.replace("    <!-- website:sharing:start -->\n", robots + record + "    <!-- website:sharing:start -->\n")
    main = re.search(r"^ {4}<main\b[^>]*>\n", source, re.M)
    source = source[: main.end()] + NOTICE_START + NOTICE_END + "\n" + source[main.end():]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    sync_pages(root)
    print(
        f"Created {path.relative_to(root)} as a noindex draft. Translate its text in place following "
        "website/translation.md, then run python3 scripts/website.py check."
    )
    return path


def translation_report(root, language=None):
    """Describe each translation's review status, freshness and remaining review items."""
    state = SiteState(root)
    site = state.site
    lines = []
    for (code, english), status in sorted(state.translations.items()):
        if language and code != language:
            continue
        path = site / code / english
        source = path.read_text(encoding="utf-8")
        record = translation_record(source) or {}
        english_path = site / english
        current = source_digest(english_path.read_text(encoding="utf-8")) if english_path.is_file() else None
        fresh = record.get("source-sha256") == current
        reviewed = f" on {record['reviewed']}" if record.get("reviewed") else ""
        lines.append(f"{code}/{file_route(english) or '(home)'}: {status or 'no record'}{reviewed}, "
                     f"{'up to date' if fresh else 'English source changed'}")
        if not fresh and current:
            lines.append(f"  after updating the translation, record source-sha256=\"{current}\"")
        if status != "reviewed":
            for system, text in re.findall(r'<(?:em|span|strong|kbd)\b[^>]*\bdata-os-ui="([^"]+)"[^>]*>(.*?)</', source, re.S):
                lines.append(f"  confirm on {system}: {' '.join(text.split())}")
    english_strings = state.locales["en"]["strings"]
    for code in LANGUAGES:
        if code == "en" or (language and code != language):
            continue
        if not any(key[0] == code for key in state.translations):
            continue
        locale = state.locales[code]
        same = sorted(
            key for key, value in locale["strings"].items()
            if value == english_strings[key] and key not in locale.get("sameAsEnglish", [])
        )
        if same:
            lines.append(f"{code}: UI strings still in English: {', '.join(same)}")
    print("\n".join(lines) or "No translated pages.")
    return lines


def run_script(root, name, arguments=()):
    """Use the active Python environment for the existing preparation and checks."""
    subprocess.run([sys.executable, str(root / "scripts" / name), *arguments], cwd=root, check=True)


def run_browser_script_tests(root):
    """Run the page-script regressions with the repository's Node.js."""
    try:
        subprocess.run(["node", str(root / "scripts/test-website-scripts.mjs")], cwd=root, check=True)
    except FileNotFoundError as error:
        raise OSError("The website script tests need Node.js; see website/README.md.") from error


def preview_handler(site, prefix):
    """Serve one static directory at root or a Pages prefix, preserving redirects."""
    class Handler(SimpleHTTPRequestHandler):
        def send_head(self):
            if not urlsplit(self.path).path.startswith(prefix):
                self.send_error(404)
                return None
            return super().send_head()

        def translate_path(self, path):
            return super().translate_path("/" + path[len(prefix):])

    return partial(Handler, directory=str(site))


def main():
    """Expose one small command for synchronizing, checking and previewing the site."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    sync = commands.add_parser("sync", help="Update shared HTML after editing templates or page metadata")
    sync.add_argument("--check", action="store_true", help="Report drift without rewriting pages")
    commands.add_parser("check", help="Check shared HTML, prepare assets, verify links and run regression tests")
    links = commands.add_parser("links", help="Audit external targets using gh and HTTP; separate from offline checks")
    links.add_argument("--report", help="Write the full external-link JSON report")
    create = commands.add_parser("new-page", help="Create a draft reading page")
    create.add_argument("route")
    create.add_argument("--title", required=True)
    create.add_argument("--description", required=True)
    translate = commands.add_parser("translate", help="Create a draft translation of an English page")
    translate.add_argument("language", choices=[code for code in LANGUAGES if code != "en"])
    translate.add_argument("route", help="The English page's directory route, or / for the home page")
    report = commands.add_parser("translations", help="List translation status, freshness and review items")
    report.add_argument("--lang", choices=[code for code in LANGUAGES if code != "en"])
    serve = commands.add_parser("serve", help="Prepare and preview the static site")
    serve.add_argument("--port", type=int, default=4173)
    serve.add_argument("--base-path", choices=("/", "/rea/"), default="/")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        if args.command == "new-page":
            new_page(root, args.route, args.title, args.description)
        elif args.command == "translate":
            new_translation(root, args.language, args.route)
        elif args.command == "translations":
            translation_report(root, args.lang)
        elif args.command == "sync":
            sync_pages(root, check=args.check)
        elif args.command == "check":
            sync_pages(root, check=True)
            for name in ("prepare-website.py", "verify-website.py", "test-website.py"):
                run_script(root, name)
            run_browser_script_tests(root)
        elif args.command == "links":
            run_script(root, "audit-website-links.py", ["--report", args.report] if args.report else [])
        else:
            sync_pages(root)
            run_script(root, "prepare-website.py")
            prefix = args.base_path

            handler = preview_handler(root / "website/public", prefix)
            with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
                print(f"Preview: http://127.0.0.1:{server.server_port}{prefix}", flush=True)
                server.serve_forever()
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        return error.returncode
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
