# Astronaut

A neutral EVA suit adapted from NASA's [Astronaut model](https://science.nasa.gov/3d-resources/astronaut/), credited to DigitalSpace Corporation. The bundled suit has an opaque visor, no agency insignia, and no backpack. Its height is 1.8 meters and its rig carries 39 deform bones, including articulated fingers, weighted by Blender's bone-heat solve over the welded source and subdivided once afterward. The helmet and visor belong to the head alone and each boot to its foot.

The rest pose's soles lie on the asset's datum and every grounded clip keeps a planted sole there, so the loader anchors the suit once, from the rest pose, and never re-anchors it per frame. It converts materials to WebGPU node materials and gives every instance an independent skeleton and mixer. Animation remains presentation only. Ten embedded clips, sampled at sixty frames a second, cover idle, walk, run, crouch, crouch walk, left and right strafe, jump, fall, and flight. The walk, run, crouch walk and strafes are authored at a nominal speed with a stride to match, and the runtime advances their shared cycle by the ground the entity covers, so a planted foot stays planted at any speed; a walk backward runs the cycle backward. The walk gives way to the run between 3.6 and 5.2 m/s, and every clip fades to its weight over 0.15 s.

The source is `scripts/models/astronaut-source.glb`. Blender 5.2 rebuilds the derivative from the repository root:

```sh
blender -b --factory-startup --python scripts/models/astronaut.py -- \
  scripts/models/astronaut-source.glb \
  apps/game/public/models/astronaut/astronaut.glb
```

Add `--preview astronaut.png --pose Walk:10,Run:6 --view side` to render inspection images, one per pose, with the frame after the colon. [LICENSE.txt](LICENSE.txt) records the source, usage terms, and modifications. The asset does not require an external animation service, remote asset host, or runtime decoder.
