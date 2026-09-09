#!/usr/bin/env python3
"""Build the portable HTML from reviewed source and checked-in assets (stdlib only)."""
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def uri(name, mime):
    return f"data:{mime};base64," + base64.b64encode((ROOT / 'assets' / name).read_bytes()).decode()


def main():
    styles = (ROOT / 'src/styles.css').read_text()
    for token, name in [('BODY', 'zen-kaku-regular.woff2'), ('BOLD', 'zen-kaku-bold.woff2'), ('SERIF', 'noto-serif-shogi.woff2')]:
        styles = styles.replace('__FONT_' + token + '__', uri(name, 'font/woff2'))
    data = json.loads((ROOT / 'src/demo-data.json').read_text())
    data['mascot'] = uri('meerkat-shogi.webp', 'image/webp')
    data['mascotDark'] = uri('meerkat-shogi-dark.webp', 'image/webp')
    data_script = 'const DEMO = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c') + ';'
    html = (ROOT / 'src/index.template.html').read_text()
    html = html.replace('/* INLINE_STYLES */', styles).replace('/* INLINE_DATA */', data_script).replace('/* INLINE_APP */', (ROOT / 'src/app.js').read_text())
    licenses = '\n'.join((ROOT / 'assets' / name).read_text() for name in ['OFL-ZenKakuGothicNew.txt', 'OFL-NotoSerif.txt'])
    html = html.replace('</head>', '<!-- Embedded font licenses:\n' + licenses.replace('--', '—') + '\n-->\n</head>')
    (ROOT / 'index.html').write_text(html)
    print(f'Built docs/mock/index.html ({len(html.encode()):,} bytes); all runtime assets embedded.')


if __name__ == '__main__':
    main()
