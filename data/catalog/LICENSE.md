# Star catalog — license and attribution

This directory contains a **derived database** built from published astronomical
catalogs by `apps/ingest`. It is not part of the Apache-2.0 licensed source
code that reads it, and it carries different terms.

**Catalog version:** `hyg-4.4+nea-2b24daf0`

## Terms

The packed catalog (`stars-150ly.irsc`) is a database derived substantially from
the HYG Database and is therefore Adapted Material under CC BY-SA 4.0 § 4(b).
**It is licensed CC BY-SA 4.0.** The share-alike obligation attaches to this
database, not to its individual contents and not to the software that reads it.

- Star data: The HYG Database v4.4 by David Nash (astronexus), https://codeberg.org/astronexus/hyg — licensed CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/. Modified: filtered by distance, grouped into systems, re-projected into galactic coordinates and repacked. This derived database is likewise CC BY-SA 4.0.

- Planet data: This research has made use of the NASA Exoplanet Archive, which is operated by the California Institute of Technology, under contract with the National Aeronautics and Space Administration under the Exoplanet Exploration Program.

## Warranty

These works are provided "as-is" and without warranties of any kind, to the
extent permitted by the respective licenses. Positions, magnitudes and orbital
elements are measurements with published uncertainties; the values derived from
them here (temperature, luminosity, radius, mass) are estimates and are marked as
such in the game where they are shown.

## Rebuilding

```
pnpm catalog:build
```

Sources and their exact digests are recorded in `manifest.json`.
