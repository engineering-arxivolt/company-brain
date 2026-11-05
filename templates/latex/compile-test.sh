#!/usr/bin/env bash
# Compile-test both LaTeX templates inside the company-brain sandbox.
# Run this after the AI has filled in placeholders, or with placeholder text
# to verify the templates compile cleanly.

set -euo pipefail

echo "=== Compiling resume.tex ==="
latexmk -pdf -interaction=nonstopmode resume.tex
echo "=== Compiling cover-letter.tex ==="
latexmk -pdf -interaction=nonstopmode cover-letter.tex

echo ""
echo "=== Output files ==="
ls -la *.pdf

echo ""
echo "=== Log check (should show no errors) ==="
grep -E "^!|Error" resume.log cover-letter.log || echo "No errors found."

echo ""
echo "=== Done. PDFs are ready to pull as sandbox artifacts. ==="