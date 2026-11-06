# Vendored MathJax 3.2.2 (`tex-svg-full.js`)

- Source: `https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg-full.js` (npm package `mathjax@3.2.2`)
- SHA-256: `a4354ff94fd868aea0cc6eaaa79a57fda0588646fc46ee3700a349ee0a11cbe6`
- License: Apache-2.0 (`LICENSE`, copied from the same package)

Why this build: SVG output (glyphs are paths, so no font files to load before capture) and the
"full" bundle (every TeX extension included, so nothing is fetched at runtime → offline and
deterministic). `deckbuild.py` copies it next to a deck only when that deck contains math; the
deck engine typesets every formula once at load, before `__deckReady`.
