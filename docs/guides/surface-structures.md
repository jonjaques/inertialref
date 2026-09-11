# Surface structures

Structures are game objects anchored to a body's latitude and longitude. The
Mars landing pad uses the same placement record in flight, the planetarium,
and Cinema. [ADR-0040](../adr/0040-structures-keep-a-body-fixed-anchor.md)
describes ownership and persistence.

## Place and inspect

The harness accepts degrees and meters. World records use radians.

```js
ir.structures()
ir.placeStructure({
  id: 'second-mars-pad',
  assetId: 'mars-pad',
  bodyAddress: 'g:milky-way/s:SOL/b:3',
  latitude: 0,
  longitude: 0,
  height: 2,
  heading: 30,
})
ir.visitStructure('second-mars-pad', 120)
ir.removeStructure('second-mars-pad')
```

Use `ir.targets()` to obtain the body's exact address before placing an
object. `visitStructure` moves the planetarium camera. Placing, moving, and
removing a structure change the world and are included in its next save.
`ir.moveStructure(record)` replaces an existing placement atomically. Reusing
an ID with `placeStructure` is an error. Removal remains in effect after loading.

The facility `mars-basin-pad` is seeded in new Sol games at 34.560341698° N,
85.053877851° E. It sits two meters above the local terrain. This is a basin
surveyed in the game's relief, not a named real-world landing site.

## Add an asset

Define the asset ID, footprint, and optional deck support radius in
`packages/universe/src/structures.ts`. Keep URLs and rendering classes in the
browser adapter. The support radius describes a flat circular deck; it does
not create wall or ramp collision.

Author the mesh in Blender at one meter per unit. Export glTF with +Y up and
the contact deck at y=0. Retain the editable master under `design/structures/`
and a repeatable generator or export script under `apps/ingest/models/`.
The game reads `data/models/`; these are generated assets, not hand-edited
files. Join material batches for export while retaining editable parts in
the master.

The pad producer is reproducible:

```sh
blender -b --python apps/ingest/models/build_mars_pad.py
pnpm vitest run marsPadAsset
```

The asset test checks metric bounds, the landing datum, materials, and the
realtime geometry budget. The reusable browser loader preserves the authored
origin and rebuilds glTF materials as WebGPU node materials.

## Mars landing in Cinema

Open `/cinema/mars-landing`, or use the director:

```js
ir.play('mars-landing')
ir.pause()
ir.seekCutscene(720)
```

The 46-second scene runs at 24 fps. It opens on a ground telephoto, widens
during the braking burn, and holds after touchdown at 41 seconds. Entry heat,
drive intensity, and dust derive from the sampled playhead, so a seek gives
the same effect state as playback. The scene chooses the Rocinante without
changing the player's ship preference.

The deck and cinematic poses share the placement resolver. The sunset
presentation instant holds Mars, its terrain, and its light together while
the scene advances. The Sun is three degrees above the site's horizon;
the warm haze and blue/gold horizontal flare follow its actual direction.
Leaving Cinema returns control to the player's world.
