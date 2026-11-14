# The forced rows, retaken at f9746fd35229

The `targets` batch's `cut`, `scrub` and `fly` rows and its `pair-neighbor` rows, with `pair-moon`'s steady rows first at each size as the control, run by hand with `node scripts/clouds/measure.mjs --batch targets --runs /cut --runs /scrub --runs /fly --runs pair-neighbor --runs pair-moon/1080p/steady --runs pair-moon/retina/steady --gpu-wait 1800`, the display dark. Started 2026-11-10T12:25:50.836Z, finished 2026-11-10T13:10:01.264Z.

`.data/clouds/targets-2026-11-10T12-25-50Z.json`: 40 of 40 runs measured quiet, 0 failures, 42 rows: `ground` at 1080p under `scrub` was marked under load twice, beside a `pnpm`, a `vitest` and an `astro` this work did not start, and taken a third time quiet.

| Scenario      | Size   | Kind   | Lever  | Base ms | Candidate ms | Δ ms (spread) | scene over clouds | cloud trace | cloud history | cloud depth | bakes | passes/frame | bytes MB | quiet |
| ------------- | ------ | ------ | ------ | ------- | ------------ | ------------- | ----------------- | ----------- | ------------- | ----------- | ----- | ------------ | -------- | ----- |
| pair-moon     | 1080p  | steady | landed | 1.36    | 10.68        | 9.31 (0.04)   | 1.95              | 4.73        | 0.26          | 0.06        | 2.31  | 36           | 96.41    | yes   |
| pair-neighbor | 1080p  | steady | landed | 5.88    | 13.06        | 7.18 (0.07)   | 1.70              | 3.67        | 0.27          | 0.12        | 1.85  | 41           | 96.41    | yes   |
| ground        | 1080p  | cut    | landed | 5.88    | 29.54        | 23.67 (0.05)  | 1.71              | 6.69        | 0.24          | 0.09        | 14.89 | 102          | 91.62    | yes   |
| horizon       | 1080p  | cut    | landed | 6.25    | 26.55        | 20.30 (0.02)  | 1.53              | 5.59        | 0.24          | 0.09        | 13.98 | 102          | 91.62    | yes   |
| inside        | 1080p  | cut    | landed | 7.47    | 32.15        | 24.68 (0.01)  | 2.08              | 4.69        | 0.23          | 0.11        | 18.17 | 100          | 91.62    | yes   |
| decks         | 1080p  | cut    | landed | 2.98    | 22.38        | 19.40 (0.02)  | 2.20              | 6.09        | 0.23          | 0.03        | 9.55  | 96           | 91.62    | yes   |
| orbit         | 1080p  | cut    | landed | 5.16    | 8.35         | 3.19 (0.03)   | 1.72              | 0.35        | 0.20          | 0.12        | 0.80  | 32           | 91.62    | yes   |
| pair-moon     | 1080p  | cut    | landed | 1.37    | 36.47        | 35.10 (0.00)  | 1.97              | 18.98       | 0.22          | 0.05        | 13.96 | 98           | 96.41    | yes   |
| pair-neighbor | 1080p  | cut    | landed | 5.89    | 29.65        | 23.76 (0.02)  | 1.72              | 6.56        | 0.23          | 0.09        | 14.80 | 103          | 96.41    | yes   |
| ground        | 1080p  | scrub  | landed | 5.88    | 22.68        | 16.79 (0.34)  | 1.69              | 5.84        | 0.25          | 0.09        | 9.86  | 102          | 91.62    | yes   |
| horizon       | 1080p  | scrub  | landed | 6.25    | 21.25        | 15.01 (0.10)  | 1.53              | 5.12        | 0.22          | 0.11        | 8.34  | 102          | 91.62    | yes   |
| inside        | 1080p  | scrub  | landed | 7.49    | 24.50        | 17.01 (0.06)  | 2.05              | 4.32        | 0.27          | 0.13        | 9.88  | 100          | 91.62    | yes   |
| decks         | 1080p  | scrub  | landed | 2.98    | 18.67        | 15.70 (0.05)  | 2.18              | 5.85        | 0.23          | 0.03        | 7.11  | 98           | 91.62    | yes   |
| orbit         | 1080p  | scrub  | landed | 5.40    | 8.56         | 3.15 (0.16)   | 1.75              | 0.36        | 0.21          | 0.11        | 0.86  | 32           | 91.62    | yes   |
| pair-moon     | 1080p  | scrub  | landed | 1.37    | 30.71        | 29.34 (0.05)  | 1.98              | 17.68       | 0.23          | 0.08        | 8.90  | 98           | 96.41    | yes   |
| pair-neighbor | 1080p  | scrub  | landed | 5.90    | 23.26        | 17.36 (0.12)  | 1.72              | 6.02        | 0.25          | 0.12        | 8.60  | 101          | 96.41    | yes   |
| ground        | 1080p  | fly    | landed | 6.09    | 12.94        | 6.85 (0.16)   | 1.68              | 3.55        | 0.25          | 0.12        | 1.64  | 40           | 91.62    | yes   |
| orbit         | 1080p  | fly    | landed | 5.48    | 7.66         | 2.18 (0.29)   | 1.03              | 0.05        | 0.26          | 0.11        | 0.80  | 26           | 91.62    | yes   |
| earth-ground  | 1080p  | fly    | clouds | 3.59    | 9.75         | 6.15 (0.14)   | 1.55              | 3.12        | 0.59          | 0.14        | 0.80  | 41           | 91.62    | yes   |
| earth-orbit   | 1080p  | fly    | clouds | 3.21    | 5.70         | 2.47 (0.04)   | 1.08              | 0.06        | 0.25          | 0.11        | 0.84  | 23           | 91.62    | yes   |
| pair-moon     | retina | steady | landed | 3.15    | 13.37        | 10.21 (0.04)  | 4.71              | 3.03        | 0.17          | 0.13        | 2.21  | 34           | 89.80    | yes   |
| pair-neighbor | retina | steady | landed | 13.52   | 22.36        | 8.84 (0.27)   | 4.20              | 3.07        | 0.18          | 0.28        | 1.77  | 41           | 89.80    | yes   |
| ground        | retina | cut    | landed | 13.12   | 37.72        | 24.59 (0.13)  | 4.24              | 5.08        | 0.16          | 0.24        | 15.15 | 102          | 85.01    | yes   |
| horizon       | retina | cut    | landed | 14.03   | 36.19        | 22.14 (0.04)  | 3.93              | 5.18        | 0.17          | 0.21        | 13.98 | 102          | 85.01    | yes   |
| inside        | retina | cut    | landed | 15.50   | 41.67        | 26.17 (0.06)  | 5.05              | 3.24        | 0.21          | 0.29        | 18.13 | 98           | 85.01    | yes   |
| decks         | retina | cut    | landed | 7.02    | 27.81        | 20.79 (0.02)  | 5.37              | 4.41        | 0.17          | 0.08        | 9.56  | 98           | 85.01    | yes   |
| orbit         | retina | cut    | landed | 13.44   | 19.14        | 5.56 (0.40)   | 4.36              | 0.27        | 0.15          | 0.27        | 0.84  | 32           | 85.01    | yes   |
| pair-moon     | retina | cut    | landed | 3.16    | 33.80        | 30.64 (0.05)  | 4.72              | 11.88       | 0.18          | 0.13        | 13.96 | 98           | 89.80    | yes   |
| pair-neighbor | retina | cut    | landed | 13.12   | 37.82        | 24.70 (0.04)  | 4.26              | 5.10        | 0.18          | 0.33        | 14.66 | 103          | 89.80    | yes   |
| ground        | retina | scrub  | landed | 13.53   | 31.26        | 17.77 (0.36)  | 4.19              | 4.66        | 0.17          | 0.23        | 8.53  | 100          | 85.01    | yes   |
| horizon       | retina | scrub  | landed | 14.09   | 30.69        | 16.64 (0.57)  | 3.90              | 4.60        | 0.17          | 0.26        | 8.01  | 100          | 85.01    | yes   |
| inside        | retina | scrub  | landed | 15.51   | 34.21        | 18.71 (0.04)  | 4.99              | 2.94        | 0.21          | 0.26        | 11.47 | 98           | 85.01    | yes   |
| decks         | retina | scrub  | landed | 6.99    | 24.02        | 17.04 (0.03)  | 5.31              | 4.19        | 0.16          | 0.09        | 7.36  | 96           | 85.01    | yes   |
| orbit         | retina | scrub  | landed | 12.85   | 18.63        | 5.78 (0.06)   | 4.31              | 0.27        | 0.15          | 0.26        | 0.84  | 32           | 85.01    | yes   |
| pair-moon     | retina | scrub  | landed | 3.16    | 28.28        | 25.13 (0.12)  | 4.74              | 10.14       | 0.17          | 0.09        | 11.01 | 98           | 89.80    | yes   |
| pair-neighbor | retina | scrub  | landed | 13.12   | 31.71        | 18.58 (0.41)  | 4.21              | 4.40        | 0.16          | 0.31        | 9.32  | 103          | 89.80    | yes   |
| ground        | retina | fly    | landed | 13.41   | 22.11        | 8.70 (0.34)   | 4.13              | 3.00        | 0.16          | 0.30        | 1.62  | 40           | 85.01    | yes   |
| orbit         | retina | fly    | landed | 12.86   | 16.92        | 4.08 (0.27)   | 2.53              | 0.05        | 0.17          | 0.27        | 0.83  | 24           | 85.01    | yes   |
| earth-ground  | retina | fly    | clouds | 7.63    | 15.52        | 7.89 (0.04)   | 3.85              | 2.25        | 0.53          | 0.31        | 0.92  | 41           | 85.01    | yes   |
| earth-orbit   | retina | fly    | clouds | 7.82    | 12.07        | 4.26 (0.09)   | 2.68              | 0.05        | 0.16          | 0.25        | 0.83  | 25           | 85.01    | yes   |

1080p: presented at 104–120 Hz.
retina: presented at 64–120 Hz.
