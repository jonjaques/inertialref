# Alpha production review

The review covers [#77, 1.0 Alpha](https://github.com/jonjaques/inertialref/pull/77),
from `origin/main` at `d845ef3` to `codex/galaxy` at `ff07e65`, plus the fixes
listed here. The original diff changes 468 files. Review work uses isolated
checkouts for canonical code, rendering and the application shell, with
deployment and documentation integration checked in the release checkout.

## Fixes

| Failure                                                                | Correction and evidence                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World search discards catalog stars with spectral prefixes.            | The prefilter uses the same parser as generation. Six regression cases fail with the shortcut, including Barnard's `sdM4` and its published planets. The worker task version changes; generated values and addresses do not.        |
| An incompatible imported picture changes camera state before refusing. | Semantic target validation precedes date, lens, processing and camera writes. Rise on Earth, composition of the Sun and surface composition on Jupiter all refuse while preserving the captured picture.                            |
| A catalog selection loses to the picture still present in the URL.     | Selecting a body clears picture fields through the existing URL helper. Regressions cover bundled and portable pictures.                                                                                                            |
| A completed world search leaves its larger intermediate batch visible. | The hook publishes the final capped result and retires its subscription on unmount. A 1,500-row stream finishes with the correct 1,000 rows; late callbacks cannot update the closed panel.                                         |
| Retired star fields retain GPU allocations.                            | Cleanup releases renderer-owned source and appearance buffers. A real-GPU regression observes the leak before the fix and its removal afterward in both history layouts. Projection storage alone reaches 9.6 MB per retired field. |
| Direct image tools use a vulnerable libheif build through sharp.       | Root, headless and ingest resolve sharp 0.35.4 with libheif 1.23.2. The production dependency audit reports zero advisories. Six headless PNG plates generate and decode successfully.                                              |
| Deployment and public metadata name the prior domain.                  | Worker routing, canonical metadata, generated crawler/share assets and published entry points name `inertialref.app`. A hosting test binds the deployment domain to the shared site identity.                                       |

The image dependency update addresses the
[sharp maintainer advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).

## API documentation builds

Every build converts TypeDoc, validates cross-references, and ships all API
articles and search data as JSON. Builds from `main` also pre-render API HTML.
Other branches render prose and one API loading shell, with exact static-asset
proxies for known API URLs. This retains real 404s and does not invoke the
Worker for documentation requests.

Workers Builds uses `WORKERS_CI_BRANCH`; GitHub uses its source-branch
variables; local builds use the checked-out branch. The manifest records the
decision so Astro, routing and output verification agree. To reproduce the
full production output on a feature branch:

```sh
IR_PRERENDER_API=1 pnpm build
```

`IR_PRERENDER_API=0` forces asynchronous API pages. `pnpm preview` applies the
asset proxy rules; `astro preview` does not. Astro development serves API
loading shells on demand.

Measured local Astro output from the same review checkout:

| Mode             | HTML files | Astro build time |
| ---------------- | ---------: | ---------------: |
| Full baseline    |      1,576 |    42.75 seconds |
| Asynchronous API |        118 |     6.40 seconds |

These timings describe the Astro step, excluding TypeDoc and typechecking.
The preview output retains 1,554 JSON documentation pages and uses 1,552
static redirect rules plus two dynamic normalization rules. The generator
fails above Cloudflare's 2,000-static-rule limit; it cannot silently omit
routes. [Cloudflare routing documentation](https://developers.cloudflare.com/workers/static-assets/redirects/).

## Verification

- The baseline full `pnpm check` passes, including 2,218 regular tests, eight
  slow tests and all 1,576 emitted documents.
- The combined `pnpm check` passes, including 2,241 tests across 188 files,
  eight slow tests and all 118 preview HTML documents.
- `IR_PRERENDER_API=1 pnpm build` passes and verifies all 1,576 production
  HTML documents. A no-JavaScript browser visit to an API member finds its
  actual heading, article and production canonical URL in the response.
- The simulation proves all 12 capability checks, including state-hash save
  round trips, frame-rate independence, precision and worker determinism.
- The physical-GPU baseline passes 135 tests across 41 files. Post-cleanup
  checks pass eight tests across three files, including two new allocation
  release cases.
- The actual camera output shaders use 1,472 to 1,488 bytes of private WGSL
  storage, below the 8,192-byte guaranteed budget. Thirty-three production
  fallback graphs generate GLSL successfully.
- Wrangler's deployment dry run succeeds without uploading or deploying.
  The Worker bundle is 14.13 KiB, 5.00 KiB compressed.
- HTTP checks through the local Worker confirm canonical API deep links,
  case-sensitive aliases, trailing-slash and `.html` normalization, missing
  API and prose routes, and `/api/health`.
- The isolated browser hydrates a deep API URL to the correct article, title
  and production canonical address. It remains readable with the App chunk
  blocked. Prose has its article and navigation without JavaScript; async API
  pages provide a no-script notice and documentation link.
- An independent review of the build gate confirms route counts, alias
  targets, main/preview selection, and identical loading-shell markup across
  API URLs.
- A cold production planetarium visit reaches renderer readiness in 6.6
  seconds. The Earthrise view renders; navigation to documentation and browser
  back preserve the same single canvas and load the requested article.
- Invoking the renderer's unexpected-device-loss callback removes the canvas
  and shows the graphics notice while preserving the documentation article.
  Intentional device destruction is ignored by Three and is not equivalent
  to this failure callback.

## Coverage and remaining checks

Canonical review covers population addressing and bounds, catalog
coverage/fallbacks, generation versioning, ship throttle save/hash/rails,
observatory travel/drop/tracking, and imported presets. Rendering review
covers galaxy caches, dust transport, temporal history, radiometry, camera
processing, shader portability, ship materials and plumes. Shell review
covers startup/recovery, hydration/navigation, service-worker routing,
picture URLs, input and search lifecycle.

Mobile Safari needs a physical-device retest of the recent #80 shader-limit
fix. GLSL generation does not prove linking on every WebGL driver. The
existing service-worker policy does not guarantee that every startup chunk
is cached before the first-ever offline restart; this policy also exists on
`origin/main`. Miniflare retains a separate dev-only sharp 0.35.2 dependency;
the production audit and direct image-tool dependencies are clean.

The pull request carries current CI and deployment status. The review does
not merge #77 or deploy production. Production custom-domain provisioning,
the old hostname's redirect policy, and production smoke checks belong to the
deployment step.
