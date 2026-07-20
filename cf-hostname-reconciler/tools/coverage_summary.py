"""Render coverage.xml as a Markdown table for the GitHub Actions job summary."""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET


def main(path: str = "coverage.xml") -> int:
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        print(f"> cobertura indisponivel: {exc}")
        return 0

    print("### Cobertura\n")
    print(f"Total: **{float(root.get('line-rate', 0)) * 100:.1f}%**\n")
    print("| Arquivo | Linhas | Cobertura |")
    print("|---|---:|---:|")
    for cls in sorted(root.iter("class"), key=lambda c: c.get("filename") or ""):
        lines = cls.find("lines")
        total = len(lines) if lines is not None else 0
        rate = float(cls.get("line-rate", 0)) * 100
        print(f"| `{cls.get('filename')}` | {total} | {rate:.0f}% |")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
