# Astronaut

A neutral EVA suit adapted from NASA's [Astronaut model](https://science.nasa.gov/3d-resources/astronaut/), credited to DigitalSpace Corporation. The bundled suit has an opaque visor, no agency insignia, and no backpack. Its height is 1.8 meters and its rig carries 39 deform bones, including articulated fingers.

The loader places the feet at the entity's foot datum, converts materials to WebGPU node materials, and gives every instance an independent skeleton. Animation remains presentation only. Ten embedded clips cover idle, walk, run, crouch, crouch walk, left and right strafe, jump, fall, and flight. Backward movement reverses the walking cycle. The mixer crossfades transitions and follows the simulation's presentation time.

The source is `scripts/models/astronaut-source.glb`. Blender 5.2 rebuilds the derivative from the repository root:

```sh
blender -b --factory-startup --python scripts/models/astronaut.py -- \
  scripts/models/astronaut-source.glb \
  apps/game/public/models/astronaut/astronaut.glb
```

Add `--preview /tmp/astronaut.png` to render an inspection image. [LICENSE.txt](LICENSE.txt) records the source, usage terms, and modifications. The asset does not require an external animation service, remote asset host, or runtime decoder.
