#!/usr/bin/env bash
# Compile-test all LaTeX templates inside the company-brain sandbox.
# Run this inside a sandbox session.
#
#   ./compile-test.sh
#
# Every template must produce a .pdf with no errors in the build log.
# If pdflatex reports "File `X.sty' not found", drop X and rewrite with
# core LaTeX — do not add texlive-latex-extra packages.

set -euo pipefail

echo "=== Compiling resume.tex ==="
latexmk -pdf -interaction=nonstopmode resume.tex
echo "=== Compiling cover-letter.tex ==="
latexmk -pdf -interaction=nonstopmode cover-letter.tex
echo "=== Compiling newspaper.tex ==="
latexmk -pdf -interaction=nonstopmode newspaper.tex
echo "=== Compiling comic.tex ==="
latexmk -pdf -interaction=nonstopmode comic.tex

echo ""
echo "=== Output files ==="
ls -la *.pdf

echo ""
echo "=== Log check (should show no errors) ==="
grep -E "^!|Error" resume.log cover-letter.log newspaper.log comic.log || echo "No errors found."

echo ""
echo "=== Done. PDFs are ready to pull as sandbox artifacts. ==="