# ISCCP-H as the source of a monthly cloud climatology: research notes

Research date 2026-11-08. Read-only: nothing in any repository was changed. Every figure
marked **measured** came from files downloaded to a scratch directory and read with
h5wasm 0.10.3 under Node v26.13.0. A figure marked **published** is quoted from the source
named next to it. Anything that could not be verified is marked as such.

Scratch evidence (not committed anywhere):
`/private/tmp/claude-501/-Users-jonjaques--t3-worktrees-inertialref-t3-e896a8db/c9127a5f-0d78-4b78-8b2c-d06fa0a4522a/scratchpad/`
(`dl/` has the sample files and 120 Basic HGM months for 2007–2016; `h5probe/` has the reader
scripts `dump.mjs`, `readers.mjs`, `cmp.mjs`, `clim.mjs`, `gaps.mjs`.)

---

## 0. Recommendation in one paragraph

Use **ISCCP-H Basic HGM** (monthly means, 1° equal-angle 360×180, CF-compliant netCDF-4
with deflate). Take the **ten years 2007-01 to 2016-12**: 120 files, 518 MB. Read them
in Node with **h5wasm**, which I tested on every product here. It needs no native addon and
reads 120 files in about 0.8 s. Add **Basic HGH** (8 UTC slots per month, 2.88 GB for the
same decade) only if the diurnal cycle is wanted. HGM averages the diurnal cycle away.
Do not use the Full product unless you need a variable that Basic drops. Full is
equal-area (41 252 cells) and count-coded through lookup tables, and its decoded values
match Basic's exactly (checked cell by cell, §2.4). MODIS is a reasonable alternate but
harder to get: it needs an Earthdata login token, it observes daytime only, and its
ISCCP-like product is still HDF5-in-netCDF-4. It is not easier than ISCCP-H Basic.

---

## 1. Which product, the URLs, how many files, how big

Product page (opened): https://www.ncei.noaa.gov/products/international-satellite-cloud-climatology

| Product   | What it is                                        | Grid                                       | Access                                    |
| --------- | ------------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| **HGM**   | monthly mean = mean of the 8 HGH files            | Full: 1° equal-area; Basic: 1° equal-angle | direct HTTPS                              |
| **HGH**   | monthly mean at each of 8 UTC slots (00, 03 … 21) | same                                       | direct HTTPS                              |
| HGG       | instantaneous 3-hourly                            | same                                       | Basic: direct HTTPS; Full: order by email |
| HXG / HXS | 0.1° / satellite-projection pixel level           | —                                          | order by email                            |

The User's Guide v5.0 (opened, p. 6) describes the averaging: _"The 3-hourly HGG products
are averaged over each month separately at each of eight times of day UTC (0, 3, 6 …, not
local time) to produce HGH; the eight HGH products for each month are then averaged to
produce HGM, the monthly means. This averaging approach ensures equal weight over the
diurnal cycle."_ This means **HGM keeps no diurnal information. HGH does**, but in UTC slots, so
local solar time is `UTC + lon/15`.

### URL patterns (directory listings opened and files downloaded)

Root: `https://www.ncei.noaa.gov/data/international-satellite-cloud-climate-project-isccp-h-series-data/access/`

```
Basic HGM  isccp-basic/hgm/ISCCP-Basic.HGM.v01r00.GLOBAL.{YYYY}.{MM}.99.9999.GPC.10KM.CS00.EA1.00.nc
Basic HGH  isccp-basic/hgh/{YYYY}{MM}/ISCCP-Basic.HGH.v01r00.GLOBAL.{YYYY}.{MM}.99.{HH}00.GPC.10KM.CS00.EA1.00.nc   HH ∈ 00,03,…,21
Full  HGM  isccp/hgm/ISCCP.HGM.v01r00.GLOBAL.{YYYY}.{MM}.99.9999.GPC.10KM.CS00.EQ1.00.nc
Full  HGH  isccp/hgh/{YYYY}{MM}/ISCCP.HGH.v01r00.GLOBAL.{YYYY}.{MM}.99.{HH}00.GPC.10KM.CS00.EQ1.00.nc
```

`EA1` is the equal-angle Basic grid and `EQ1` the equal-area Full grid. THREDDS has the
Basic products too: https://www.ncei.noaa.gov/thredds/catalog/satellite/cdr-isccp-h.html
(linked from the product page; I did not open it).

### Counts and sizes (measured from the directory listings)

The archive runs **1983-07 to 2017-06**, which is 408 months. The plan's "1983–2017" is
loose: the record starts in July 1983 and ends in June 2017. The Interim CDR (Jul 2017 – Dec 2018) is on
`ftp://filsrv.cicsnc.org/ISCCP_ICDR/…`. FTP only; not opened.

| Set                      | Files      | Per file                          | Total       |
| ------------------------ | ---------- | --------------------------------- | ----------- |
| Basic HGM, full record   | 408        | 4.12–4.64 MB                      | **1.77 GB** |
| **Basic HGM, 2007–2016** | **120**    | ~4.3 MB                           | **518 MB**  |
| Basic HGH, 2007–2016     | 960        | ~2.8–2.9 MB                       | 2.88 GB     |
| Full HGM, full record    | 408        | 11.31 MB (constant: uncompressed) | 4.61 GB     |
| Full HGM, 2007–2016      | 120        | 11.31 MB                          | 1.36 GB     |
| Full HGH, 2007–2016      | 982 listed | 11.32 MB                          | 10.86 GB    |

The product page quotes "~30 MB" per month for Basic and "~100 MB" for Full. Those
figures are for a whole month of HGM plus HGH. They are not per file.

**Why 2007–2016.** It is a contiguous decade with a full geostationary ring. Every one of its
months downloaded cleanly. It also avoids the issues the caveats file lists (MET-3 1995 missing
VIS, GMS-3 Feb–Apr 1986, the NOAA-15→17 gap 2000–2002, May 1994 Pacific PC errors):
https://www.ncei.noaa.gov/sites/default/files/2021-07/ISCCP_Caveats%20%281%29.pdf (opened).
The C-ATBD says ISCCP retains satellite-zenith-angle artifacts, so a longer mean averages
over more satellite changes but does not remove them. If the ingest can afford
1.77 GB once, the full 34-year mean is available with the same code.

---

## 2. Format and variable names

### 2.1 Format (measured)

- **Every ISCCP-H file I opened is netCDF-4 / HDF5** (magic `\x89HDF\r\n\x1a\n`). That
  covers Basic HGM, Basic HGH and Full HGM. **None is netCDF-3 classic.**
- **Basic**: deflate (HDF5 filter id 1). Global `history` records
  `ncks -a -4 -L 5`, so it is netCDF-4 with deflate level 5. Values are `int16` with CF
  `scale_factor` / `add_offset` / `_FillValue`.
- **Full**: HDF5 with **no filters** (uncompressed, which is why every file is the same
  size). Most cloud properties are `uint8` "counts" decoded through 256-entry lookup tables
  (`pretab`, `tautab`, `tmptab`, `wpatab`, …). Cloud amounts are `int16` in 0.1 %.

### 2.2 Basic HGM / HGH variables (measured from the files; HGH has the identical list)

NCEI's "Basic Variable List" PDF exists and the product page links it:
https://www.ncei.noaa.gov/sites/default/files/2021-07/ISCCPHGMHGHBasicVariableList.pdf
I downloaded it but could not render it. No PDF renderer is installed, and the variable
table is laid out in a way my text extractor did not recover. The list below is therefore
taken **from the files themselves**, which is the authoritative source anyway. The "Basic vs
Full" description PDF (opened, 37 pp.) confirms the mapping:
http://www.ncei.noaa.gov/sites/default/files/2021-07/ISCCPBasicvs.Full-Description.pdf

Dimensions: `time`=1, `lat`=180 (centers **−89.5 → +89.5, south first**), `lon`=360
(centers **0.5 → 359.5**, 0–360 convention), `cloud_type`=18, `cloud_irtype`=3, `cldbin`=10.
Array layout is `[time, (type,) lat, lon]`, row-major.

| Need                                | Variable                                                | Shape          | Encoding (value = raw·scale + offset)                  |
| ----------------------------------- | ------------------------------------------------------- | -------------- | ------------------------------------------------------ |
| Total cloud amount                  | `cldamt`                                                | [1,180,360]    | i16, scale 0.1, offset **50**, fill 32767 → percent    |
| IR-only cloud amount                | `cldamt_ir`                                             | same           | same                                                   |
| 18 VIS/IR types (9 × liquid/ice)    | `cldamt_types`                                          | [1,18,180,360] | same as `cldamt`                                       |
| 3 IR types (low/mid/high, all day)  | `cldamt_irtypes`                                        | [1,3,180,360]  | same                                                   |
| Mean cloud-top pressure             | `pc`                                                    | [1,180,360]    | i16, scale 1, offset 500 → hPa                         |
| PC by type                          | `pc_types`                                              | [1,18,…]       | same as `pc`                                           |
| PC by IR type                       | `pc_irtypes`                                            | [1,3,…]        | same                                                   |
| Mean optical depth                  | `tau`                                                   | [1,180,360]    | i16, scale 0.01, offset 225                            |
| TAU by type                         | `tau_types`                                             | [1,18,…]       | same as `tau`                                          |
| Cloud-top temperature               | `tc`, `tc_types`, `tc_irtypes`                          |                | scale 0.1, offset 250 → K                              |
| Water path                          | `wp`, `wp_types`                                        |                | scale 0.1, offset 2500 → (units attr says "cm")        |
| Land fraction                       | **`eqland`**                                            | [1,180,360]    | i16, percent 0–100, no scaling                         |
| Surface class                       | `scene`                                                 | [1,180,360]    | i8 flags 1 water, 2 land, 3 coast, −1 no-data          |
| Topographic height                  | `eqheight`                                              | [1,180,360]    | i16, m                                                 |
| Snow/ice cover                      | `snoice`                                                | [1,180,360]    | scale 0.1 (no offset), fill 32767 → percent            |
| Cloud-amount frequency distribution | `cldamt_dist`                                           | [1,10,180,360] | as `cldamt`; bins in `cldbin_bounds` (0–10 … 90–100 %) |
| Sampling                            | `n_obs`, `n_day`, `n_orig`, `n_toplev`                  |                | i8, fill −1                                            |
| Labels                              | `cloud_type_label` [18,80], `cloud_irtype_label` [3,80] |                | char                                                   |

The 18 type labels, in array order (read from `cloud_type_label`):

```
 0 cumulus_liquid          680<PC≤1025, 0≤TAU≤3.55,   TC≥253K
 1 stratocumulus_liquid    680<PC≤1025, 3.55<TAU≤22.63
 2 stratus_liquid          680<PC≤1025, 22.63<TAU≤450
 3–5  the same three, ice (TC<253K)
 6 altocumulus_liquid      440<PC≤680,  thin
 7 altostratus_liquid      440<PC≤680,  medium
 8 nimbostratus_liquid     440<PC≤680,  thick
 9–11 the same three, ice
12 cirrus_liquid           10≤PC≤440,   thin
13 cirrostratus_liquid     10≤PC≤440,   medium
14 deep_convective_liquid  10≤PC≤440,   thick
15–17 the same three, ice
```

The nine ISCCP types are the liquid+ice sums, e.g. `Cu = types[0] + types[3]`.

### 2.3 Gotchas found in the data (measured), and what the ingest must do

1. **`pc`, `tau`, `tc`, `wp` and the `*_types` property arrays have no `_FillValue`
   attribute, but they use −32767 as missing.** A CF decoder that trusts attributes will
   turn −32767 into a real number. For `tau` that is −32767·0.01+225 = −102.7. Mask raw
   −32767 explicitly.
2. **`cldamt` uses offset 50 and `snoice` uses none**, so "percent = raw/10" is wrong for
   cloud amount. Apply each variable's own attributes.
3. **The 18 type amounts are missing in polar night.** They are retrieved by day and only
   interpolated across night. In January 2009, 10 740 of 64 800 equal-angle cells had no
   `cldamt_types`; in July 2009 the count was 11 408 (lat −89.5 to 57.5). `cldamt` and
   `cldamt_irtypes` were present in about 95–99 % of those cells. The ingest needs a fallback there: the
   IR low/mid/high split (`cldamt_irtypes`) scaled to `cldamt`, or a climatological fill
   from the months that do have types.
4. **The type amounts do not sum exactly to `cldamt`.** Σ18 − `cldamt` averaged +0.7 to +1.6
   percentage points over cells where both exist (four months tested). The 10-year means:
   Σ18 = 65.97 %, `cldamt` = 64.75 %. Normalize the nine type covers to `cldamt` if the
   renderer needs them to sum to total cover.
5. **Type properties are daytime-only. Type amounts are day plus night-interpolated.** User's
   Guide p. 7: _"the 18 daytime cloud type amounts, but not their properties are
   interpolated over the nighttime. Consequently in the monthly averaged products (HGH,
   HGM), the weighted average of the cloud type properties is no longer consistent with the
   grid-averaged properties."_ `tau_types` is the **in-cloud** mean optical depth of that
   type. In one cell, the stratocumulus types decoded to 5.88 and 6.22, inside the
   3.55–22.63 bin, so it is not grid-diluted. It is also radiatively averaged (averaged in
   counts), not a linear mean.
6. **The Basic grid replicates the equal-area cells.** A polar cell is copied across many
   longitudes, so area-weight by `cos(lat)` and never by cell count. In my January sample
   the missing-type count is 16.6 % of cells but a much smaller share of area.
7. **jsfive did not read Basic attributes.** It read the data but returned an empty attribute
   map, while h5wasm read every attribute. Do not rely on jsfive for the scale/offset.

### 2.4 Full vs Basic cross-check (measured)

The same month (2010-07) was compared at five equal-area cells. Each cell was mapped to
Basic through `eqlat_index` and `sqlon_beg` (1-based, Fortran order, as the files' `comment`
attribute documents). `cldamt`, `pc` and `tau` agreed exactly:
for example cell 5000, Full `tautab[77]` = 3.79 vs Basic −22121·0.01+225 = 3.79. The type amounts
agreed too. So Basic's `raw·scale + offset` decoding is right, and Basic loses nothing for this
use except variables it drops: the marginal/IR-only/VIS-only categories, the
surface/atmosphere ancillaries, and `eqveg`.

Full-only variables a renderer might want: `eqveg` (vegetation class),
`cldamt_ironly`/`cldamt_visonly`/`*marg` (detection uncertainty), `ts`, `rs`, `psurf`,
`temp_profile`, `rh_profile`, `ozone`. None is needed for the cloud climatology described.

### 2.5 What the artifact can carry, by variable

- **Nine-type cover per month and cell:** `cldamt_types`, liquid+ice summed, normalized to
  `cldamt`, with an IR-type fallback in polar night.
- **Three-level cover:** `cldamt_irtypes` (all-day IR, blackbody cloud tops), or the
  nine-type sums by row. They differ: IR puts thin cirrus too low.
- **In-cloud optical depth per level:** amount-weighted mean of `tau_types` over that row's
  types. Average in log or count space, not linearly.
- **Convective/stratiform share:** e.g. deep-convective / high-level cover
  (`types[14]+types[17]` over `types[12..17]`), or the thick-type share per level. ISCCP
  has no convective flag. Any "share" is a definition the project makes and should
  document.
- **Land fraction:** `eqland` (static, identical every month).
- **Diurnal cycle:** only from HGH. It holds the same variables per UTC slot (8 files per
  month), which gives 8 × 12 = 96 maps.

---

## 3. License, terms and the citation text for the manifest

**License.** Basic HGM's global attribute says `license = "No constraints on data access or
use."` (measured). The CDR fair-use statement (opened, 2 pp.):
https://www.ncei.noaa.gov/pub/data/sds/cdr/CDRs/Cloud_Properties-ISCCP/UseAgreement_01B-29.pdf
says, under "CDR Program Open Data Policy": _"the CDR data sets are non-proprietary, publicly
available, and no restrictions are placed upon their use."_ It _urges_ acknowledgment and
citation, and "encourages" offering co-authorship where a CDR is fundamental to a
publication. That is a request, not a condition. There is no CC license. US-government open
data is effectively public domain, but the documents do not state CC0 and neither should
the manifest.

**Dataset citation.** As given on the product page (latest version v01r00):

> Rossow, W.B.; Walker, A.; Golea, V.; Knapp, K. R.; Young, A.; Inamdar A.; Hankins, B.;
> and NOAA's Climate Data Record Program (2016). International Satellite Cloud Climatology
> Project Climate Data Record, H-Series [indicate subset used]. NOAA National Centers for
> Environmental Information. [access date]. doi:10.7289/V5QZ281S

The use agreement gives a shorter variant:
_"William B. Rossow and NOAA CDR Program (2017): NOAA Climate Data Record (CDR) of Cloud
Properties - ISSCP, Version 1. [indicate subset used]. NOAA National Centers for
Environmental Information (NCEI). doi:10.7289/V5QZ281S [access date]"_ ("ISSCP" is NCEI's own
typo). Prefer the product-page text.

**Product paper**, which the page asks users to cite:

> Young, A. H., Knapp, K. R., Inamdar, A., Hankins, W., and Rossow, W. B. (2018). The
> International Satellite Cloud Climatology Project H-Series climate data record product.
> Earth System Science Data, 10, 583–593. https://doi.org/10.5194/essd-10-583-2018

**The file's own `references` attribute** asks for Rossow & Schiffer (1999), BAMS 80,
2261–2287, doi:10.1175/1520-0477(1999)080<2261:AIUCFI>2.0.CO;2, in addition to the dataset
citation.

**Acknowledgment text** (use agreement): _"The ISCCP H-Series Cloud Properties CDR used in
this study was acquired from the NOAA National Centers for Environmental Information (NCEI;
formerly NCDC) (https://www.ncei.noaa.gov). This CDR was developed by William B. Rossow,
Violeta Golea, and Cindy Pearl of The City College of New York, Alison Walker of Desert Sage
Software, Inc., Alisa Young and Ken Knapp of NOAA/NESDIS/National Centers for Environmental
Information, Anand Inamdar of the Cooperative Institute for Climate and Satellites (CICS)
North Carolina, and Bill Hankins of ERT Inc., Asheville NC. Development of the CDR was
supported by NOAA's CDR Program."_

**Short form** where a full citation does not fit: _"ISCCP-H series cloud data from NOAA/NCEI."_
(product page). Suggested manifest fields: `source: ISCCP-H Basic HGM v01r00`,
`subset: 2007-01..2016-12`, `doi: 10.7289/V5QZ281S`, `accessed: <date>`,
`license: "No constraints on data access or use (NOAA CDR Open Data Policy)"`, plus the two
citations above.

---

## 4. Reading it from Node without a native addon

All three libraries were installed into a scratch project with `bun add` and run on the real
files (`readers.mjs`):

| Library                          | Version | Result on ISCCP-H                                                                                                                                                         | Notes                                                                                                                    |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **netcdfjs**                     | 4.0.0   | **FAIL**: `Not a valid NetCDF v3.x file: should start with CDF`                                                                                                           | netCDF-3 only, and every ISCCP-H file is netCDF-4. Usable only after a CLI conversion.                                   |
| **jsfive**                       | 0.4.2   | Data OK (Basic `cldamt_types` in 45 ms; Full too). **Basic attributes came back empty**, so no `scale_factor`/`add_offset`/`_FillValue`.                                  | Pure JS. Deflate supported. The attribute gap matters, because the offsets differ per variable.                          |
| **h5wasm**                       | 0.10.3  | **OK on Basic HGM, Basic HGH, Full HGM**: data, attributes, deflate, char arrays. `Int16Array` out. 13 ms per variable; 120 months × 3 variables aggregated in **0.8 s**. | HDF5 compiled to WebAssembly; `import h5wasm from "h5wasm/node"` opens files by path. No native addon.                   |
| CLI (`ncdump`, `nccopy`, `gdal`) | —       | **Not tested.** Homebrew `netcdf` 4.10.1 and `hdf5` 2.2.0 are available but **not installed**, and I did not install them.                                                | `nccopy -k classic in.nc out.nc` would make netCDF-3 for netcdfjs. That adds a system dependency and a step for no gain. |

**Recommendation: h5wasm.** It is the only one that read everything, attributes included,
and it is still pure JS + WASM. Pattern used:

```js
import h5wasm from 'h5wasm/node'
await h5wasm.ready
const f = new h5wasm.File(path, 'r')
const d = f.get('cldamt_types') // Dataset
const raw = d.value // Int16Array, length 18*180*360
const { scale_factor, add_offset, _FillValue } = Object.fromEntries(
  Object.entries(d.attrs).map(([k, a]) => [k, a.value]),
)
// scale_factor etc. come back as 1-element typed arrays → take [0]
f.close()
```

The ingest needs a proper `.close()` per file. h5wasm keeps the file open in its virtual FS.

---

## 5. The MODIS alternate

Directory listings opened through the LAADS JSON API. File names and sizes for July 2010 (doy 182):

| Product                                              | Format                            | Size per month | What it gives                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCD06COSP_M3_MODIS** (C6.2, Terra+Aqua merged)     | **netCDF-4** (`.nc`, HDF5 groups) | **68 MB**      | 1° monthly, daytime only, from July 2002. Cloud fraction from mask and from retrievals, split high (<440 hPa) / mid (440–680) / low (≥680) and liquid/ice. Optical thickness (linear and log means). **τ × p_c joint histogram whose bins "follow ISCCP conventions"** (Pincus et al. 2023). Groups hold `Mean`, `Sum`, `Sum_Squares`, `Standard_Deviation`, `Pixel_Counts`. |
| MOD08_M3 / MYD08_M3 (C6.1)                           | **HDF4** (`.hdf`)                 | 369 / 374 MB   | 1° monthly, hundreds of SDS, statistic suffixes `_Mean_Mean`, `_FMean` etc. Cloud-mask `Cloud_Fraction`, `Cloud_Optical_Thickness_{Liquid,Ice,Combined}`, joint histograms vs cloud-top pressure.                                                                                                                                                                            |
| CLDPROP_M3_MODIS_Aqua (MODIS–VIIRS continuity, v1.1) | netCDF-4                          | 637 MB         | Continuity product. Large.                                                                                                                                                                                                                                                                                                                                                   |

URL pattern, e.g.
`https://ladsweb.modaps.eosdis.nasa.gov/archive/allData/62/MCD06COSP_M3_MODIS/{YYYY}/{DOY}/MCD06COSP_M3_MODIS.A{YYYY}{DOY}.062.{processing-timestamp}.nc`.
The processing timestamp varies, so list `…/{YYYY}/{DOY}/.json` first.

**Access.** Listing is anonymous. **Downloading is not**: an unauthenticated GET returned
`303 → https://ladsweb.modaps.eosdis.nasa.gov/profiles/licenses/…` (measured). Scripted
downloads need an Earthdata Login token in an `Authorization: Bearer` header. Tokens expire after
60 days ([LAADS EDL token guide](https://ladsweb.modaps.eosdis.nasa.gov/learn/download-files-using-edl-tokens/),
from search results; not opened). That is a credential the user must supply.

**License.** LAADS's data-use statement (from search results; the PDF
https://modaps.modaps.eosdis.nasa.gov/services/faq/LAADS_Data-Use_Citation_Policies.pdf was
not opened) says the products "are not copyrighted", carry "no restrictions on subsequent
use or redistribution", and asks for acknowledgment and citation. The plan's "CC0" label
**could not be verified**. NASA ESDS policy is open/unrestricted but does not, in what I
saw, name CC0. Write "NASA open data, no restrictions; citation requested" unless a CC0
statement is found.

**Is it easier than ISCCP-H?** No:

- It needs credentials. ISCCP-H downloads anonymously over plain HTTPS.
- MOD08_M3 is **HDF4**. h5wasm, jsfive and netcdfjs cannot read HDF4, so the ingest would need
  the GDAL or `hdf` CLI from Homebrew. MCD06COSP is HDF5-based, so h5wasm should read it,
  but I did not download one to confirm, for lack of a token.
- It is **daytime only**: no night or diurnal information, and two fixed overpass times
  (10:30/13:30).
- It needs more assembly: its "types" come from a joint histogram, not ready-made 9/18-type
  amounts with in-cloud τ per type.
- Its advantages are higher resolution, better phase detection and particle size. They do
  not matter for a renderer climatology.

Keep MCD06COSP_M3 as the cross-check source, not the primary.

Product paper (opened via the ESSD HTML): Pincus, R., Hubanks, P. A., Platnick, S., Meyer, K.,
Holz, R. E., Botambekov, D., and Wall, C. J. (2023). Updated observations of clouds by MODIS
for global model assessment. ESSD 15, 2483–2497. https://essd.copernicus.org/articles/15/2483/2023/
— dataset doi:10.5067/MODIS/MCD06COSP_M3_MODIS.062.

---

## 6. Climatological checks for the renderer's tests

### 6.1 ISCCP-H's own numbers, measured from Basic HGM 2007-01..2016-12 (120 months)

Area weight is `cos(lat)` on the 1° grid. Cloud amounts are percent of sky.

| Quantity                               | Value                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| Global mean total cloud (`cldamt`)     | **64.75 %**                                                                    |
| Land, weighted by `eqland` fraction    | **55.46 %**                                                                    |
| Ocean, weighted by 1 − `eqland`        | **68.41 %**                                                                    |
| By `scene` class: water / land / coast | 68.52 / 55.10 / 64.62 %                                                        |
| Global IR-only cloud (`cldamt_ir`)     | 61.10 %                                                                        |
| Σ 18 types (day + night-interpolated)  | 65.97 % (land 59.55, ocean 68.48)                                              |
| Monthly global means, Jan → Dec        | 65.2 64.6 65.3 64.8 64.4 64.4 64.3 64.1 64.3 64.6 65.3 65.6 (range 1.5 points) |

Nine-type global means (liquid+ice, percent): **Cu 9.72, Sc 10.48, St 2.76, Ac 6.18,
As 7.99, Ns 4.67, Ci 14.02, Cs 6.13, Dc 4.03**. By level: low 22.96, mid 18.83, high 24.19.

Zonal means of `cldamt` in 10° bands, south → north (percent):

```
-90..-80 44.1   -80..-70 56.2   -70..-60 80.1   -60..-50 87.1   -50..-40 83.3
-40..-30 70.8   -30..-20 57.5   -20..-10 56.7   -10..0   58.3     0..10  65.7
 10..20  53.7    20..30  50.5    30..40  62.5    40..50  71.9    50..60  73.9
 60..70  67.6    70..80  66.8    80..90  62.9
```

These shapes are the ones a test should pin: Southern Ocean maximum 87 % at 50–60°S, ITCZ
peak at 0–10°N, subtropical minima near 20–30°N (50.5 %) and 20–30°S, and a dip over the
Antarctic plateau.

### 6.2 Published figures to compare against

| Figure                                  | Value                                                                                                                                 | Source (status)                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISCCP-H global CF, January 2009         | **65.46 %** (ISCCP-D 66.29 %)                                                                                                         | Young et al. 2018, ESSD 10, 583 — https://essd.copernicus.org/articles/10/583/2018/ (opened)                                                                           |
| ISCCP-H − D, mean over 1983-07..2009-12 | ≈ 0.21 % global; land +0.16 %, water −0.06 %; land CF below water CF in both series                                                   | same (opened)                                                                                                                                                          |
| MODIS global CF (cloud mask)            | **∼67 %**, Terra ≈ Aqua                                                                                                               | King et al. 2013, IEEE TGRS 51(7), 3826–3852 — PDF opened, text extracted: _"Globally, the cloud fraction derived by the MODIS cloud mask is ∼67%"_                    |
| MODIS land / ocean                      | **∼55 % / ∼72 %**; land has "a distinctive seasonal cycle", ocean "much reduced seasonal variation"                                   | same: _"the cloud fraction over land is ∼55%, … whereas the ocean cloudiness is much higher, around 72%"_                                                              |
| ISCCP global CF per King et al.         | "ISCCP also finds the global cloud fraction ∼67%, as discussed by Pincus et al. [39]"                                                 | same paper (refers to earlier ISCCP-D, not H)                                                                                                                          |
| GEWEX multi-dataset global CF           | **≈ 0.68 ± 0.03** for τ > 0.1; ≈ 0.74 including τ < 0.01 (lidar); ≈ 0.56 for τ > 2 only                                               | Stubenrauch et al. 2013, AIP Conf. Proc. 1531, 404 (**from search-result snippets; not opened**); full paper BAMS 94, 1031, doi:10.1175/BAMS-D-12-00117.1 (not opened) |
| ISCCP missed thin cloud                 | misses ≈ 0.05 of cover with τ < ~0.3; high cloud underestimated, mid overestimated by ≈ 0.10 vs lidar; CA varies ≈ 0.05 nadir → slant | ISCCP-H User's Guide v5.0 p. 16 (opened)                                                                                                                               |
| ISCCP-H random uncertainty              | CA ±3 %, PC ±50/±100 hPa (low/upper), TAU ±15 %                                                                                       | same, p. 16                                                                                                                                                            |

The C-ATBD (Rev 1, 2022-06-01, CDRP-ATBD-0872; text extracted from the opened PDF)
has **no single headline global mean cloud amount** in its text. I searched it for global-mean
CA statements and found only sampling tests ("global mean difference in CA is < 0.01")
and calibration-sensitivity figures. So **ISCCP-H's own long-term global mean is not
published as one number in the documents I read**. The measured 64.75 % (2007–2016) and the
paper's 65.46 % (Jan 2009) are the defensible ISCCP-H anchors.

### 6.3 Suggested test bounds

- Global mean of the artifact's total cover: **64.75 % ± 0.5** if it is built from ISCCP-H
  2007–2016 unaltered. That checks the ingest, not the physics. A wider sanity band of
  **62–70 %** covers ISCCP-H, MODIS (67 %) and GEWEX (68 ± 3 %).
- Ocean > land by **10–17 points**: ISCCP-H 68.4 vs 55.5 (12.9); MODIS 72 vs 55 (17).
  Land ≈ 55 % agrees across both datasets. **ISCCP-H ocean is about 3.5 points below
  MODIS's 72 %**, so a test asserting "ocean ≈ 72 %" against an ISCCP-H artifact fails
  by design. Use ISCCP-H's own 68.4 %.
- Zonal: max in 50–60°S ≥ 85 %; 0–10°N exceeds both 10–20°N and 10–20°S; 20–30°N
  is the northern-hemisphere minimum (≈ 50 %).
- Seasonality: global monthly mean spread ≤ 2 points (measured 1.5).
- Type sanity: high-thin (Ci) is the largest type globally (≈ 14 %); St and Dc are the
  smallest (≈ 3–4 %).

---

## Not verified / open

- The Basic Variable List PDF content: downloaded but not rendered. The variable list here is
  from the files, which supersede it.
- The CLI conversion route (netcdf/gdal not installed; deliberately not installed).
- MCD06COSP's exact group and variable names and that h5wasm reads it. No Earthdata token,
  so no file was downloaded.
- The CC0 claim for MODIS. The LAADS data-use PDF and the Stubenrauch papers were seen only
  through search snippets.
- THREDDS/OPeNDAP subsetting for ISCCP-H (linked, not opened). It could avoid downloading
  whole files, but the files are small enough that it is not worth the dependency.

---

## Summary

- **Product:** ISCCP-H **Basic HGM** v01r00, 1° equal-angle, netCDF-4 with deflate. 2007–2016 is 120
  files and 518 MB; the whole record (1983-07..2017-06) is 408 files and 1.77 GB, downloadable
  anonymously over HTTPS. Add Basic HGH (8 UTC slots, 2.88 GB per decade) only for a
  diurnal cycle. HGM has none.
- **Variables:** `cldamt`, `cldamt_types` [18] (sum liquid+ice into 9), `cldamt_irtypes` [3],
  `pc`/`tau`/`tc`/`wp` and their `_types`, `eqland` (land %), `scene`, `snoice`. Gotchas:
  undeclared −32767 fill on properties; `cldamt` offset 50; types missing in polar night;
  Σtypes ≈ `cldamt` + 1 point; type properties are daytime and in-cloud.
- **License:** "No constraints on data access or use" (NOAA CDR open data). Cite
  doi:10.7289/V5QZ281S and Young et al. 2018; no CC license is stated.
- **Reader:** **h5wasm** reads everything, attributes included, with no native code. netcdfjs
  cannot read netCDF-4. jsfive reads the data but drops Basic's attributes.
- **MODIS:** MCD06COSP_M3 (netCDF-4, 68 MB/month) is the useful alternate. It needs an Earthdata
  token and is daytime-only. MOD08_M3 is HDF4 at 370 MB/month and no JS reader handles HDF4.
  Neither is easier than ISCCP-H.
- **Test anchors:** ISCCP-H 2007–2016 global 64.75 %, land 55.5 %, ocean 68.4 %, plus the zonal
  profile in §6.1. Published comparisons: ISCCP-H 65.46 % (Jan 2009, Young et al.), MODIS
  ∼67 / 55 / 72 % (King et al. 2013), GEWEX 0.68 ± 0.03.
