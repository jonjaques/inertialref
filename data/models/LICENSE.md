# Models — license and attribution

glTF hulls for the flyable ships, and the stations. **Not covered by the
Apache-2.0 license on the source code** — except the Mars pad
(`mars-pad.glb`), which is original to InertialRef.

- USS Enterprise NCC-1701-D (`enterprise-d.glb`): “Star Trek Online | USS
  Enterprise D” by LoganRolphh (https://sketchfab.com/LoganRolphh), licensed
  CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Used as published;
  the file’s own glTF `asset.extras` block carries the same attribution, so
  the credit travels with the asset even if this file is lost.

- Rocinante / MCRN Tachi (`rocinante.glb`): “MCRN Tachi [Expanse TV Show]” by
  Jakub.Vildomec (https://sketchfab.com/Jakub.Vildomec), licensed CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/). Modified in InertialRef with
  authored PBR finishes, reduced normal relief and static mesh batching. The
  editable master is `design/ships/rocinante.blend`; its source credit and
  modification record travel in the exported glTF `asset.extras` block. The model wears the
  MCRN _Tachi_ livery (hull 158); the ship is renamed _Rocinante_ in the story
  and is the same hull under either name.

Star Trek, The Expanse, and the starship designs are the property of their
respective rights holders (CBS Studios / Paramount; Alcon Entertainment and the
authors of the novels). These are fan-made assets, used here non-commercially.
CC BY 4.0 requires attribution but imposes no share-alike, so — unlike the star
catalog — nothing downstream of these files becomes CC-licensed.

Per-file provenance — source URL, license, and the true overall length used to
scale the model to render meters — is in `manifest.json`. The lengths are the
in-universe overall lengths: 642.5 m for the Galaxy-class Enterprise-D, and 46 m
for the _Corvette_-class light frigate the Rocinante is, the figure the Expanse
wiki and the official _Ships of the Expanse_ RPG both give.

## International Space Station (`iss.glb`)

Adapted from “International Space Station (ISS) (D) (IGOAL)”, credited to
NASA/JSC/Integrated Graphics, Operations, and Analysis Laboratory and
distributed by NASA 3D Resources
(https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/International%20Space%20Station%20(ISS)%20(D)%20(IGOAL)).
NASA's 3D Resources hub states that its assets are free to download and use
(https://science.nasa.gov/3d-resources/), under the NASA Images and Media Usage
Guidelines (https://www.nasa.gov/nasa-brand-center/images-and-media/): texture
maps and polygon data generally are not subject to copyright in the United
States, and the NASA insignia, logotype and identifiers are not in the public
domain. The item page states no license of its own, and whether contractors
worked on IGOAL is not stated; these terms are what the credit relies on.

The derivative removes every agency insignia, national flag, company logo and
mission patch the source's maps and meshes carry — NASA, ESA, ASI, Roscosmos
and RSC Energia marks, the Canada wordmark, the flags of the United States,
Russia and Japan, and the AMS, NICER and Nanoracks marks — and keeps the names
painted on the hardware. `apps/ingest/models/build_iss.py` makes it from the
download whose SHA-256 `README.md` records, and the file's own glTF
`asset.extras` carries the credit and the list of modifications, so it travels
with the asset. NASA does not endorse InertialRef.
