# Translating the website

The home page, Get started, the Guides index and the FAQ are translated into six
languages. Guide pages, the blog, showcases and examples remain in English;
translated pages link to their English versions.

| Directory   | `lang` and `hreflang` | `og:locale` | Menu name |
| ----------- | --------------------- | ----------- | --------- |
| (site root) | `en`                  | `en_US`     | English   |
| `zh-hans/`  | `zh-Hans`             | `zh_CN`     | 简体中文  |
| `zh-hant/`  | `zh-Hant`             | `zh_TW`     | 繁體中文  |
| `ja/`       | `ja`                  | `ja_JP`     | 日本語    |
| `ko/`       | `ko`                  | `ko_KR`     | 한국어    |
| `de/`       | `de`                  | `de_DE`     | Deutsch   |
| `fr/`       | `fr`                  | `fr_FR`     | Français  |

`LANGUAGES` in `scripts/website.py` owns these values. Each language's shared
UI text (navigation, header and footer labels, copy messages, the stale-page
notice and the sharing-image description) lives in `locales/<language>.json`.
The site never redirects by browser language.

## How a translated page works

A translation is an ordinary HTML file at the English page's path under its
language directory, such as `public/zh-hant/get-started/index.html`. Its head
records where it came from:

```html
<!-- website:translation source-sha256="…" status="draft" -->
```

- `source-sha256` identifies the English text the translation was made from.
  It hashes the English page without its shared regions and copied code
  blocks, so template and command changes do not count.
- `status="draft"` pages carry `noindex`. They are left out of the sitemap,
  hreflang, the language menu and other pages' navigation; open them by URL.
- `status="reviewed" reviewed="YYYY-MM-DD"` pages are indexable and linked.
  Only a native-speaking reviewer marks a page reviewed.

`python3 scripts/website.py sync` maintains everything shared:

- The header, footer and sharing regions use the page's locale. The language
  menu offers the same page in each reviewed language, or that language's
  reviewed home page, and leaves out languages with neither.
- Navigation points to reviewed pages in the same language. Links to English
  pages, such as Showcases and Blog, carry a small `EN` badge.
- Reviewed versions of a page list each other with `hreflang` alternates and
  `x-default` pointing to English.
- Every code block that a Copy button targets is copied from the English page
  by ID. Translations never hold their own copy of a command; edit the English
  page and run `sync`.
- When the English text changes, the `website:translation-notice` region at
  the top of the content says the page may be out of date and links to the
  English version. Updating the hash removes it.

## Create and update a translation

1. Create the draft from the English page:

   ```sh
   python3 scripts/website.py translate zh-hant get-started
   python3 scripts/website.py translate ja /   # the home page
   ```

   The command sets `lang`, adds the record and `noindex`, rewrites relative
   links for the new directory, links pages that already exist in that
   language and runs `sync`.

2. Translate the text in place, following the rules below. Keep the page's
   structure: element IDs, Copy buttons and `data-msg-*` attributes stay as in
   English.
3. Run `python3 scripts/website.py check` and `npm run format:check`.
4. Run `python3 scripts/website.py translations` to see each page's status,
   whether its English source changed, the OS names still to confirm and any
   UI strings still in English.

When the English page changes, `check` warns, and after `sync` the notice
appears. Update the translation's text first. Then set `source-sha256` to the
value `translations` prints. Never refresh the hash without updating the
content: the hash is the record that the translation matches that English text.

### What the checks enforce

Failures:

- A missing or invalid record, a draft without `noindex`, or a reviewed page
  with `noindex` or without its review date.
- A copied code block that differs from English (run `sync`).
- While the record matches the English page: different element IDs, Copy
  buttons or `data-msg-*` attributes.
- In Japanese and Chinese, whitespace between two CJK characters. A line break
  inside a sentence renders as a visible gap, so keep CJK text unwrapped and
  let the formatter break lines at existing spaces.

Warnings:

- The English source changed since the translation, or the notice needs `sync`.
- Inline code in prose differs from English.
- A link points to an English page that has a reviewed translation.
- A locale still has English placeholders. List intentionally identical
  strings in that locale's `sameAsEnglish`.

## Translation rules

- Keep in English: REA, MCP, CLI, Node.js, npm, Ghidra, Hopper, IDA, JDK,
  product and client names (Claude Code, Codex, OpenCode, Cursor, Gemini CLI,
  Windsurf, Grok Build, VS Code), and every command, path, code sample, flag,
  environment variable and file name. Keep the brand line "Reverse Engineer
  Anything" in English.
- Translate the prompts readers paste into their coding agent. Keep any
  command or path inside a prompt unchanged, and check that the translated
  prompt still asks for the same actions.
- Use the OS menu and button names that the OS shows in that language. Mark
  each one for review with `data-os-ui="windows"`, `"macos"` or `"linux"`, for
  example `<em data-os-ui="windows">複製路徑</em>`. Windows 10 and 11 sometimes
  differ; name both when they do.
- When an OS shows an error message in the reader's language, give the
  translated message and the English original, since many readers use an
  English system.
- Follow the glossary. It comes from the README translations in the
  repository root, with the zh-Hant changes noted below.
- Leave a space between CJK text and Latin words or numbers, as the READMEs
  do: `使用 REA 的 MCP 服務`. In French, put a non-breaking space (U+00A0)
  before `:` and inside `« »`, and a narrow non-breaking space (U+202F) before
  `?`, `!` and `;`.
- Keep `<title>` and the meta description natural for search in that
  language. They must not repeat another page's title.

### Register

| Language | Prose            | Agent prompts              |
| -------- | ---------------- | -------------------------- |
| zh-Hans  | 你               | 你; direct requests        |
| zh-Hant  | 你               | 你; direct requests        |
| ja       | です・ます       | 〜してください             |
| ko       | 해요체 (`-세요`) | 반말 (`-해 줘`), as README |
| de       | du               | du                         |
| fr       | vous             | tu, as in the README       |

### Glossary

Terms marked † do not appear in the README translations and are proposals for
review. zh-Hant uses Taiwan-standard terms; where `README_zh-TW.md` differs,
this table wins and the README will be aligned separately.

| English                    | zh-Hans                | zh-Hant                     | ja                                       | ko                        | fr                           | de                               |
| -------------------------- | ---------------------- | --------------------------- | ---------------------------------------- | ------------------------- | ---------------------------- | -------------------------------- |
| reverse engineering        | 逆向工程               | 逆向工程                    | リバースエンジニアリング                 | 리버스 엔지니어링         | rétro-ingénierie             | Reverse Engineering              |
| (coding) agent             | 智能体 (编程智能体†)   | AI 代理 (程式設計 AI 代理†) | エージェント (コーディングエージェント†) | 에이전트 (코딩 에이전트†) | agent (agent de code†)       | Agent (Coding-Agent†)            |
| setup / set up             | 设置 / 设置流程        | 設定 / 設定流程             | セットアップ                             | 설정 / 설정 과정          | configurer; « Setup »        | Einrichtung / einrichten         |
| approve                    | 批准                   | 核准                        | 承認                                     | 승인                      | approuver                    | bestätigen                       |
| restart                    | 重启                   | 重新啟動                    | 再起動                                   | 다시 시작                 | redémarrer                   | neu starten                      |
| MCP server                 | MCP 服务               | MCP 服務                    | MCP サーバー                             | MCP 서버                  | serveur MCP                  | MCP-Server                       |
| client                     | 客户端                 | 用戶端                      | クライアント                             | 클라이언트                | client                       | Client†                          |
| skill                      | skill                  | skill                       | スキル                                   | 스킬                      | le skill                     | der Skill                        |
| provider                   | 提供方                 | 提供者                      | プロバイダー                             | 제공자                    | fournisseur                  | Provider                         |
| native analysis            | 原生分析               | 原生分析                    | ネイティブ分析                           | 네이티브 분석             | analyse native               | native Analyse                   |
| analysis engine            | 分析引擎               | 分析引擎                    | 分析エンジン                             | 분석 엔진                 | moteur d'analyse             | Analyse-Engine                   |
| binary                     | 二进制文件             | 二進位檔案                  | バイナリ                                 | 바이너리                  | binaire                      | Binärdatei                       |
| executable†                | 可执行文件             | 執行檔                      | 実行ファイル                             | 실행 파일                 | exécutable                   | ausführbare Datei                |
| library†                   | 库                     | 函式庫                      | ライブラリ                               | 라이브러리                | bibliothèque                 | Bibliothek                       |
| function                   | 函数                   | 函式                        | 関数                                     | 함수                      | fonction†                    | Funktion†                        |
| pseudocode                 | 伪代码                 | 偽程式碼                    | 疑似コード                               | 의사 코드                 | pseudo-code                  | Pseudocode                       |
| assembly                   | 汇编                   | 組合語言                    | アセンブリ                               | 어셈블리                  | assembleur                   | Assemblercode                    |
| decompile                  | 反编译                 | 反編譯                      | 逆コンパイル                             | 디컴파일                  | décompiler†                  | dekompilieren†                   |
| code                       | 代码                   | 程式碼                      | コード                                   | 코드                      | code                         | Code                             |
| implement / implementation | 实现                   | 實作                        | 実装                                     | 구현                      | implémenter / implémentation | implementieren / Implementierung |
| via / through              | 通过                   | 透過                        | 経由で                                   | 통해                      | via                          | über                             |
| evidence                   | 证据                   | 證據                        | 根拠                                     | 근거                      | preuves                      | Belege                           |
| Evidence (product record)  | Evidence               | Evidence                    | Evidence                                 | Evidence                  | Evidence                     | Evidence                         |
| findings                   | 发现                   | 發現                        | 調査結果                                 | 조사 결과                 | constatations                | Ergebnisse                       |
| target                     | 目标                   | 目標                        | 対象                                     | 대상                      | cible                        | Ziel                             |
| investigation              | 调查                   | 調查                        | 調査                                     | 조사                      | investigation                | Untersuchung                     |
| terminal                   | 终端                   | 終端機                      | ターミナル                               | 터미널                    | terminal                     | Terminal                         |
| module / import            | 模块 / 导入            | 模組 / 匯入                 | モジュール / インポート                  | 모듈 / 임포트             | modules / imports            | Module / Imports                 |
| session                    | 会话                   | 工作階段                    | セッション                               | 세션                      | session†                     | Sitzung†                         |
| configuration              | 配置                   | 設定                        | 設定                                     | 설정                      | configuration                | Konfiguration                    |
| backup                     | 备份                   | 備份                        | バックアップ                             | 백업                      | sauvegarde                   | Sicherung / sichern              |
| update                     | 更新                   | 更新                        | 更新                                     | 업데이트 / 갱신           | mettre à jour                | aktualisieren                    |
| headless                   | 无界面                 | 無介面                      | ヘッドレス                               | 헤드리스                  | headless†                    | headless†                        |
| locally                    | 本机                   | 本機                        | ローカル                                 | 로컬                      | localement                   | lokal                            |
| bug / issue                | 错误 / issue           | 錯誤 / issue                | バグ / issue                             | 버그 / issue              | bug / issue                  | Fehler / Issue                   |
| community                  | 社区                   | 社群                        | コミュニティ†                            | 커뮤니티                  | communauté†                  | Community†                       |
| Showcases                  | 案例                   | 案例                        | 事例                                     | 사례                      | Études de cas                | Fallstudien                      |
| Guides                     | 指南                   | 指南                        | ガイド                                   | 가이드                    | Guides                       | Anleitungen                      |
| FAQ                        | 常见问题               | 常見問題                    | よくある質問                             | 자주 묻는 질문            | Questions fréquentes         | Häufige Fragen                   |
| Get started                | 快速开始               | 快速開始                    | クイックスタート                         | 빠른 시작                 | Démarrage rapide             | Schnellstart                     |
| Blog†                      | 博客                   | 部落格                      | ブログ                                   | 블로그                    | Blog                         | Blog                             |
| Copy / Copied / Selected†  | 复制 / 已复制 / 已选中 | 複製 / 已複製 / 已選取      | コピー / コピーしました / 選択しました   | 복사 / 복사됨 / 선택됨    | Copier / Copié / Sélectionné | Kopieren / Kopiert / Markiert    |
| Skip to content†           | 跳到正文               | 跳至主要內容                | 本文へスキップ                           | 본문으로 건너뛰기         | Aller au contenu             | Zum Inhalt springen              |
| Back to top†               | 返回顶部               | 回到頂端                    | ページの先頭へ                           | 맨 위로                   | Retour en haut               | Nach oben                        |

### OS names to confirm

These are starting points, not confirmed names. Mark each use with
`data-os-ui` and have the reviewer confirm it on that OS in that language.

| English                                      | zh-Hans                      | zh-Hant                      | ja                     | ko                           | fr                                     | de                        |
| -------------------------------------------- | ---------------------------- | ---------------------------- | ---------------------- | ---------------------------- | -------------------------------------- | ------------------------- |
| File Explorer (Windows)                      | 文件资源管理器               | 檔案總管                     | エクスプローラー       | 파일 탐색기                  | Explorateur de fichiers                | Explorer                  |
| Copy as path (Windows 10 / 11)               | 复制为路径 / 复制文件地址    | 複製為路徑 / 複製路徑        | パスのコピー           | 경로로 복사                  | Copier en tant que chemin d'accès      | Als Pfad kopieren         |
| Start menu (Windows)                         | 开始菜单                     | 開始功能表                   | スタートメニュー       | 시작 메뉴                    | menu Démarrer                          | Startmenü                 |
| "running scripts is disabled on this system" | translated message + English | translated message + English | translated + English   | translated + English         | translated + English                   | translated + English      |
| Finder (macOS)                               | 访达                         | Finder                       | Finder                 | Finder                       | Finder                                 | Finder                    |
| Copy "…" as Pathname (macOS)                 | 将"…"拷贝为路径名称          | 將「…」拷貝為路徑名稱        | "…"のパス名をコピー    | "…"을(를) 경로 이름으로 복사 | Copier « … » en tant que nom de chemin | „…" als Pfadname kopieren |
| Show Package Contents (macOS)                | 显示包内容                   | 顯示套件內容                 | パッケージの内容を表示 | 패키지 내용 보기             | Afficher le contenu du paquet          | Paketinhalt zeigen        |
| Terminal (macOS app)                         | 终端                         | 終端機                       | ターミナル             | 터미널                       | Terminal                               | Terminal                  |

## Review checklist

A reviewer reads the translation beside the English page and checks:

- The meaning matches, with nothing added or dropped, and the glossary and
  register are followed.
- Commands, paths, flags and product names are unchanged. Copied code blocks
  come from English automatically.
- Each translated agent prompt, pasted into a real coding agent, leads to the
  same actions as the English prompt (for the setup prompt: it runs
  `npx rea-agents@latest setup` and shows the plan before changing anything).
- Every `data-os-ui` name matches the OS in that language. `translations`
  lists them.
- The title and description read naturally in search results.
- The page works at 320, 375, 768, 1024 and 1440 pixels wide: headings, the
  header and language menu, Copy buttons and their announced status, opened
  details, and the back-to-top link.

To mark the page reviewed, change its record to
`status="reviewed" reviewed="YYYY-MM-DD"`, remove its `noindex` line and run
`sync`, which adds it to the language menu, hreflang and other pages'
navigation. Commit those regenerated pages with it.
