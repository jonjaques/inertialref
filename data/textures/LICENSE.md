# Planetary textures — license and attribution

Surface maps for the Solar System, built by `apps/ingest` from published
imagery. **Not covered by the Apache-2.0 license on the source code.**

Most of these are **public domain**: NASA and USGS imagery is not subject to
copyright. The exceptions are marked `cc-by-4.0` in `manifest.json` and are
listed below; CC BY 4.0 requires attribution but imposes no share-alike, so
unlike the star catalog these do not make anything downstream of them
CC-licensed.

- Earth and Moon imagery: NASA Earth Observatory (Blue Marble Next Generation, Black Marble) and NASA Scientific Visualization Studio (LRO LROC color, LOLA topography). Public domain.

- Io, Europa, Ganymede and Callisto: NASA / JPL / USGS Astrogeology Science Center global mosaics, from Voyager and Galileo. Public domain.

- Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune and Saturn’s rings: Solar System Scope (https://www.solarsystemscope.com/textures/), licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Modified: resized and re-encoded.

Per-file provenance — source URL, license and output digest — is in
`manifest.json`. Rebuild with `pnpm textures:build`; see
`docs/guides/catalogue.md`.
