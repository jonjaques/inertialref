# Judging rendered clouds against photographs

You are one of several judges, each working alone. This folder holds
pictures of clouds drawn by a real-time renderer, in several scenes, and
photographs of real clouds for each scene. You score how close each lettered
picture comes to the real thing, by eye, on the dimensions below, and you
write your scores to one file.

Everything you need is in this folder and in this brief. Nothing else is
part of the task.

## What you are shown

Each scene has a folder named for it (`e1/`, `g3/`, …) holding:

- **Lettered pictures,** `A.png`, `B.png`, and on. Each is a whole frame in
  a cell of {{cell}} pixels. Beside each is `A.crop.png`, a rectangle cut from
  the same place on every picture of the scene and shown at full
  resolution. The limb scene has a second, `A.terminator.png`.
- **Photographs** in `references/`, each with the caption given in its
  scene's section below: how it was taken, and what in it could mislead you.

Every image meets you at one size. One larger than its cell is scaled down
to fit it, and one smaller is never scaled up: it sits at its own size on a
gray ground.

The letters are drawn at random for you alone. They say nothing about a
picture, and neither does their order. Score each picture on its own,
whatever it looks like. Two pictures of a scene may look alike; score each
as you see it.

## What you score

Every lettered picture, on each dimension its scene lists, with a whole
number from 0 to 10, judged against the scene's photographs.

| Dimension       | The question                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| **form**        | Do the clouds have the shapes, sizes and arrangement of the clouds in the photographs, or do they read as noise? |
| **light**       | Tops against bases, the lit side against the shaded one, the silver lining, the color at a low sun               |
| **shadow**      | Each cloud beside a shadow of the right length and direction, on the ground, the sea and the air                 |
| **integration** | The clouds stand in this air, on this limb, over this sea: no seam, no second model, no pasted layer             |
| **artifacts**   | The rendering faults listed below. 10 is none found                                                              |

The scale:

- **10:** at the whole frame's size, this dimension could be the photograph.
- **8:** a convincing real-time cloud at normal viewing size, with minor
  simplifications.
- **6:** plainly clouds, and plainly synthetic.
- **4:** reads as a graphics effect.

Also give **overall**, your whole judgment of the picture on the same scale.

Where a scene asks for a **ranking**, order every lettered picture of the
scene from best to worst on that dimension. No ties: if two look the same,
still put one first.

## Artifacts

Name each fault you find as one of these classes, in one region, on one
lettered picture.

| Class         | What you see                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| `banding`     | Steps in a gradient that should be smooth                                    |
| `grain`       | Noise or a dither pattern at the scale of a pixel                            |
| `ghosting`    | A trail, or an edge drawn twice                                              |
| `seam`        | A line where two resolutions, two layers or two maps meet                    |
| `stair-steps` | Blocks along a cloud's edge                                                  |
| `slicing`     | Parallel sheets or shells through a cloud's body                             |
| `tiling`      | One pattern repeated across the field                                        |
| `halo`        | A bright or dark outline where cloud meets the ground, the limb or an object |
| `cutoff`      | A cloud ended by a straight line or a plane that is not its base             |

A **region** is one cell of the frame's 3 × 3 grid, `top-left`,
`top-center`, `top-right`, `middle-left`, `middle-center`, `middle-right`,
`bottom-left`, `bottom-center` or `bottom-right`; or two cells that share an
edge, joined by `+`, as `top-left+top-center`; or a crop by its name,
`crop` or `terminator`. With each artifact say whether it shows in the whole
frame (`"full": true`) or only in a crop (`"full": false`).

Anything else you notice goes in `other`, in words. It is read, and it does
not count against a picture.

## Three observations

Write three observations a person could check by opening the picture, each
about one named file: `"In e1/C.png the largest cloud is in the top-right
cell."` They are checked against the pixels. One that is false voids your
answer.

## What you must not do

- **Open no file outside this folder,** except your own harness's skill
  files: {{allowed}}. List every file you open, in this folder or out of it,
  in `opened`. An answer that opened another file is set aside.
- Do not search for the pictures or the photographs, or try to learn where
  any of them came from. Judge what you see.
- Change nothing in this folder except writing `review.json`.

## What not to score

Score the clouds: their form, their light, and what they do to the scene.
Whatever made a picture or a photograph, these are not the cloud's, and no
dimension counts them for or against it:

- the color grade, the exposure and the white balance;
- the terrain, its cover and the sea's surface;
- a lens flare, or a glare off the lens;
- an editor's gizmo: an axis, a handle or an icon drawn over the scene;
- the frame's sharpness or softness, and its size: a picture smaller than
  its cell is shown at its own size on a gray ground, and the ground is not
  part of the picture.

Each scene's section says what else its pictures cannot show or are not
judged on. Leave those out of every dimension, and do not count them as
faults.

## The scenes

{{scenes}}

## Notes on the photographs

{{notes}}

## Your answer

Write `review.json` in this folder, in exactly this form. `scenes` has one
entry a scene, `scores` one entry a letter, and each score is a whole number
from 0 to 10. A dimension marked "when present" may be `null` when the
picture does not show it. `rankings` appears only on a scene that asks for
one; `worse` only on a scene that asks which picture is worse.

```json
{{example}}
```

<!-- Picture notes: packet.mjs places each block in its scene's section and drops the rest. -->

<!-- picture e1 -->

**Cumulus from orbit.** Earth seen straight down from a space station 400 km
up, through a 120 mm lens (an 11.4° field, about 80 km top to bottom), over
the Amazon basin in the early afternoon, the sun 50° up. It has to show fair-
weather cumulus cells about a kilometer across, each beside its own shadow on
the ground. Do not score the ground itself, its cover, or the sea's texture:
score the clouds, their light and what they do to the scene.

<!-- end -->

<!-- picture e2 -->

**The limb at dusk.** Earth's sunset horizon seen from 400 km up, through a
120 mm lens (an 11.4° field), the sun just under the limb. It has to show
cloud tops standing into the orange band, the band's layers of color, and a
terminator that darkens. Score **shadow** in the `terminator` crop only:
the shadows the tops lay on the air. Do not score the band's size on the
screen (the photographs are taken through longer lenses, so their band is
larger), the absence of anvil clouds, the ground's surface, or the night side
past the terminator, which is black.

<!-- end -->

<!-- picture e3 -->

**The whole face.** The whole sunlit disk of Earth, as from a satellite far
away. It has to show the large-scale circulation: the equatorial band of
convection, the clear subtropical belts, a stratocumulus deck off a west
coast, the storm tracks' overcast. Do not score cyclones and comma clouds,
or where one day's clouds happen to lie, or the night side, which is black.

<!-- end -->

<!-- picture g1 -->

**Fair weather.** Standing on a rise 40 m above open ground on a wet world,
at local noon, through a 50° lens tilted 4° up. It has to show flat cloud
bases at one height, bright tops, and shadows crossing the ground. Do not
score the ground's texture or cover.

<!-- end -->

<!-- picture g2 -->

**Overcast over water.** Standing on a shore 2 m up, facing the sea, under a
full deck of cloud, through a 50° lens. The sun is high and hidden. It has
to show gray light with no sun, and the deck in the sea where a blue sky
would stand. Do not score the sea's own texture or the shore's.

<!-- end -->

<!-- picture g3 -->

**Underlit at dusk.** Standing on land 2 m up, facing the sun just after it
has set, through a 55° lens tilted 15° up, under a mid-level layer of cloud
that ends toward the sun, with a clear slot under it. It has to show the
layer lit orange from below. Score **shadow** only when you find rays of
shadow in the air; give `null` when there are none, and do not count their
absence. Do not score the ground.

<!-- end -->

<!-- picture g4 -->

**Over the deck.** Flying 3 km above the top of a deck of stratocumulus,
looking at the point opposite the sun (the sun is 35° up behind), through a
70° lens. It has to show the deck's cells, and the glory: small colored rings
around that point, with no shadow at their center, because nothing stands
between the viewer and the sun. Do not score the missing aircraft shadow,
the absence of a cloudbow (a broad white arc far from the center), or the
strong color of the one cloudbow photograph.

<!-- end -->

<!-- picture guard -->

**A pair.** Two pictures of one view that is not itself being judged. Say
which of the two is **worse** on integration and which on artifacts, and
score both on those two dimensions.

<!-- end -->
