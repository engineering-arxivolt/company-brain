# Must match the @cloudflare/sandbox version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.10-python

# LaTeX is what makes PDF generation possible at all: without pdflatex the
# sandbox cannot build the resume/cover letter the user is promised.
#
# Keep this list to base + recommended + fonts. texlive-latex-extra would add
# titlesec/enumitem/lastpage, but it pushes the image past Cloudflare's 4000MB
# container-image limit (it measured 4475MB and the deploy was rejected). The
# document templates therefore stick to packages that live in the three
# collections below -- add a package here only if the image still fits.
RUN apt-get update && apt-get install -y \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-fonts-recommended \
    latexmk \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace
