# The plans

A plan promises. It says what is left of one subject, in the order it lands,
and loses a section when that section's decision moves into an
[ADR](../../docs/adr/README.md). Nothing here describes the system as it is;
[`docs/`](../../docs/README.md) does that.

**Borrow first.** Where someone has already built the thing and published it
under a license we can take, the plan starts from their code and not from a
blank file: takram's clouds and atmosphere, three.js's own addons, a
contributor's fork. A plan that builds something in-house says what it read
first and why that did not serve. [The clouds](the-clouds.md) §2 has the rule
and the order: a setting, an adapter, a patch, and a fork last.

## The picture

| Plan                                             | What it holds                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [The clouds](the-clouds.md)                      | takram's renderer made the game's: its gaps, their routes, and the native march's retirement |
| [The weather](the-weather.md)                    | The field as a function of time, what clouds do to everything else, storms, rain, the night  |
| [The weather's working notes](weather/README.md) | Where the weather's phases stand, and the native march's record                              |
| [The frame](the-frame.md)                        | What to borrow from Ben Houston's notes: noise, histories, depth, a hull's light, the ladder |
| [The air](the-air.md)                            | The air's open defects                                                                       |
| [The upscaler](the-upscaler.md)                  | Reconstruction's reproduction procedure                                                      |
| [Terrain](terrain.md)                            | What is left of the ground                                                                   |
| [Erosion](erosion.md)                            | What the rivers still owe                                                                    |
| [The look council](look-council.md)              | The blind protocol a picture is judged by, and [its defects](look-council-defects.md)        |
| [tng-intro](tng-intro.md)                        | What is left of the opening's accuracy pass                                                  |

## The machine under it

| Plan                            | What it holds                                             |
| ------------------------------- | --------------------------------------------------------- |
| [Perf](perf.md)                 | Every open figure: the frame, streaming, boot, memory     |
| [The deepening](arch-review.md) | What is left of the architecture review                   |
| [Playwright](playwright.md)     | The suites Playwright runs, with `drive.mjs` as the probe |
| [Telemetry](telemetry.md)       | What PostHog does next                                    |

## The game round it

| Plan                      | What it holds                          |
| ------------------------- | -------------------------------------- |
| [The shell](the-shell.md) | What a design pass found in the chrome |
| [The guide](the-guide.md) | The guide, eight weeks in              |
| [Stations](satellites.md) | The orbital record, with the ISS first |
