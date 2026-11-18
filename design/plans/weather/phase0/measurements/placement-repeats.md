# The placement's samples

The three samples of each placement cell that ADR-0063's placement rule reads:
campaign 1's row at `8a01d311`, and two repeats at `25df44ab`, started by
hand. The two commits differ in `scripts/clouds/` alone. Every row was measured
quiet. Each figure is the row's own, read from
`.data/clouds/decisions-2026-11-10T05-25-52Z.json`,
`…T07-35-47Z.json` and `…T07-49-25Z.json` on the Mac mini; where campaign 1
retook a row, the table shows the attempt its summary shows.

- **GPU Δ** is `ir.gpu(120)`'s clouds-on against clouds-off, the least of
  three reads over five interleaved pairs, with the spread of the pairs'
  deltas.
- **`sensor` mean** is the `sensor` span's mean over a 3 s profile, clouds off
  and on. **Late frames** and **frames** are that profile's counts.
- Campaign 1's profiles ran at a 60 Hz cap (about 180 frames in 3 s with the
  clouds off); the repeats ran at the GPU's own pace. The `sensor` mean and the
  late count follow the rate, and the GPU Δ does not. Neither row records a
  presentation rate: the runner records one from `a1ddc8d1` on.
- B is `split`, the hand-rolled split; A is `passes`, the two scene passes.

### `horizon`, 1080p

| Placement   | Sample                 | GPU Δ ms (spread) | `sensor` mean ms, off / on | Late frames, off / on | Frames in 3 s, off / on |
| ----------- | ---------------------- | ----------------- | -------------------------- | --------------------- | ----------------------- |
| B, `split`  | campaign 1, `8a01d311` | 4.91 (0.04)       | 6.80 / 5.50                | 1 / 0                 | 180 / 180               |
| B, `split`  | repeat 1, `25df44ab`   | 4.91 (0.07)       | 3.07 / 5.53                | 0 / 0                 | 356 / 272               |
| B, `split`  | repeat 2, `25df44ab`   | 4.88 (0.03)       | 3.05 / 5.24                | 0 / 0                 | 339 / 272               |
| A, `passes` | campaign 1, `8a01d311` | 4.91 (0.02)       | 7.12 / 5.78                | 1 / 18                | 179 / 180               |
| A, `passes` | repeat 1, `25df44ab`   | 4.88 (0.03)       | 3.05 / 5.63                | 0 / 0                 | 353 / 271               |
| A, `passes` | repeat 2, `25df44ab`   | 4.88 (0.03)       | 3.05 / 5.34                | 0 / 0                 | 333 / 272               |

### `inside`, 1080p

| Placement   | Sample                 | GPU Δ ms (spread) | `sensor` mean ms, off / on | Late frames, off / on | Frames in 3 s, off / on |
| ----------- | ---------------------- | ----------------- | -------------------------- | --------------------- | ----------------------- |
| B, `split`  | campaign 1, `8a01d311` | 5.12 (0.05)       | 6.69 / 4.80                | 0 / 0                 | 180 / 181               |
| B, `split`  | repeat 1, `25df44ab`   | 5.14 (0.06)       | 3.23 / 7.04                | 0 / 0                 | 346 / 239               |
| B, `split`  | repeat 2, `25df44ab`   | 5.13 (0.04)       | 3.27 / 6.59                | 0 / 0                 | 328 / 242               |
| A, `passes` | campaign 1, `8a01d311` | 5.14 (0.07)       | 6.40 / 4.62                | 1 / 1                 | 180 / 181               |
| A, `passes` | repeat 1, `25df44ab`   | 5.12 (0.05)       | 3.13 / 7.01                | 0 / 0                 | 340 / 241               |
| A, `passes` | repeat 2, `25df44ab`   | 5.14 (0.14)       | 3.29 / 6.80                | 0 / 0                 | 334 / 241               |

### `orbit`, 1080p

| Placement   | Sample                 | GPU Δ ms (spread) | `sensor` mean ms, off / on | Late frames, off / on | Frames in 3 s, off / on |
| ----------- | ---------------------- | ----------------- | -------------------------- | --------------------- | ----------------------- |
| B, `split`  | campaign 1, `8a01d311` | 3.08 (0.04)       | 4.39 / 4.78                | 0 / 0                 | 180 / 180               |
| B, `split`  | repeat 1, `25df44ab`   | 3.03 (0.10)       | 2.21 / 1.54                | 0 / 0                 | 360 / 360               |
| B, `split`  | repeat 2, `25df44ab`   | 3.07 (0.02)       | 2.25 / 1.81                | 0 / 0                 | 360 / 360               |
| A, `passes` | campaign 1, `8a01d311` | 3.08 (0.03)       | 4.13 / 4.87                | 0 / 0                 | 180 / 180               |
| A, `passes` | repeat 1, `25df44ab`   | 3.07 (0.01)       | 2.21 / 1.76                | 0 / 0                 | 361 / 360               |
| A, `passes` | repeat 2, `25df44ab`   | 3.07 (0.01)       | 2.32 / 1.58                | 0 / 0                 | 360 / 360               |

### `horizon`, Retina

| Placement   | Sample                 | GPU Δ ms (spread) | `sensor` mean ms, off / on | Late frames, off / on | Frames in 3 s, off / on |
| ----------- | ---------------------- | ----------------- | -------------------------- | --------------------- | ----------------------- |
| B, `split`  | campaign 1, `8a01d311` | 6.79 (0.47)       | 3.61 / 14.22               | 0 / 0                 | 181 / 146               |
| B, `split`  | repeat 1, `25df44ab`   | 6.87 (0.02)       | 7.30 / 14.09               | 0 / 0                 | 215 / 145               |
| B, `split`  | repeat 2, `25df44ab`   | 6.90 (0.05)       | 7.54 / 13.92               | 0 / 1                 | 216 / 145               |
| A, `passes` | campaign 1, `8a01d311` | 6.88 (0.05)       | 3.82 / 13.93               | 0 / 0                 | 182 / 147               |
| A, `passes` | repeat 1, `25df44ab`   | 6.90 (0.02)       | 7.03 / 13.82               | 0 / 0                 | 216 / 146               |
| A, `passes` | repeat 2, `25df44ab`   | 6.92 (0.02)       | 6.92 / 14.09               | 0 / 0                 | 215 / 145               |

### `inside`, Retina

| Placement   | Sample                 | GPU Δ ms (spread) | `sensor` mean ms, off / on | Late frames, off / on | Frames in 3 s, off / on |
| ----------- | ---------------------- | ----------------- | -------------------------- | --------------------- | ----------------------- |
| B, `split`  | campaign 1, `8a01d311` | 7.98 (0.07)       | 6.68 / 9.20                | 0 / 28                | 182 / 130               |
| B, `split`  | repeat 1, `25df44ab`   | 7.85 (0.03)       | 8.92 / 10.12               | 0 / 19                | 194 / 131               |
| B, `split`  | repeat 2, `25df44ab`   | 7.98 (0.05)       | 8.35 / 6.93                | 2 / 25                | 192 / 130               |
| A, `passes` | campaign 1, `8a01d311` | 8.00 (0.08)       | 6.10 / 10.71               | 0 / 21                | 181 / 132               |
| A, `passes` | repeat 1, `25df44ab`   | 7.87 (0.09)       | 8.61 / 13.63               | 0 / 20                | 194 / 133               |
| A, `passes` | repeat 2, `25df44ab`   | 8.01 (0.06)       | 8.77 / 11.57               | 0 / 25                | 193 / 132               |

### `orbit`, Retina

| Placement   | Sample                 | GPU Δ ms (spread) | `sensor` mean ms, off / on | Late frames, off / on | Frames in 3 s, off / on |
| ----------- | ---------------------- | ----------------- | -------------------------- | --------------------- | ----------------------- |
| B, `split`  | campaign 1, `8a01d311` | 5.66 (0.02)       | 3.16 / 1.77                | 0 / 0                 | 180 / 167               |
| B, `split`  | repeat 1, `25df44ab`   | 5.67 (0.04)       | 1.12 / 1.74                | 0 / 0                 | 234 / 166               |
| B, `split`  | repeat 2, `25df44ab`   | 5.69 (0.01)       | 1.25 / 1.68                | 0 / 0                 | 234 / 166               |
| A, `passes` | campaign 1, `8a01d311` | 5.66 (0.01)       | 3.16 / 1.46                | 0 / 0                 | 181 / 166               |
| A, `passes` | repeat 1, `25df44ab`   | 5.67 (0.02)       | 1.24 / 1.52                | 0 / 0                 | 235 / 165               |
| A, `passes` | repeat 2, `25df44ab`   | 5.68 (0.02)       | 1.24 / 1.69                | 0 / 0                 | 234 / 163               |
