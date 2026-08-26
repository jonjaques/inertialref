# Shape models — provenance

Measured figures of Solar System bodies, built by `apps/ingest` from models
archived at the NASA Planetary Data System Small Bodies Node.

**These are United States Government works and are in the public domain.** There
is no license to comply with. What is here instead is _provenance_, which for a
shape model matters more than a license does: a body's figure is a measurement,
and a measurement with no citation is a guess.

- NASA / OSIRIS-REx / University of Arizona (PDS Small Bodies Node)

- P. C. Thomas, PDS Small Bodies Node (ast-sat.thomas.shape-models)

- P. J. Stooke, PDS Small Bodies Node (small_bodies.stooke.shape-models)

- PDS Small Bodies Node radar shape model compilation

- R. W. Gaskell, PDS Small Bodies Node

Per-model provenance — the source URL, the publication the model comes from, the
reconstructed volume against the source's own, and the output digest — is in
`manifest.json`. Rebuild with `pnpm shapes:build`.
