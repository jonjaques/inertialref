import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  combineMonths,
  formatIsccpTable,
  type MonthSums,
  readIsccp,
  reduceMonth,
} from './isccp.ts'
import { ISCCP_H, isccpMonths } from './weatherSources.ts'

/*
 * ISCCP-H's monthly files: where they are kept, how they are fetched, and
 * what each one weighed and hashed to the day the table was made.
 *
 * The 120 files are 518 MB, and none of them is committed. They are kept
 * under the main checkout's `.data/weather/isccp/`, not the worktree's,
 * because a worktree is cut for one change and deleted with it: a cache
 * inside one would be fetched again by every later worktree that rebuilds
 * the table. The main checkout is the one directory every worktree of the
 * repository shares, and git names it: the parent of the common git
 * directory.
 *
 * The manifest below is the record a rebuild is held to. A file whose size
 * or hash differs from it is refused, so a table can only be rebuilt from
 * the bytes it was made from, and a re-release by NCEI is a change someone
 * makes on purpose, here, rather than a table that moves under a rerun.
 */

/** One fetched month: its name, its size in bytes and its SHA-256, hex. */
export interface IsccpFile {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

/** The first eight bytes of every HDF5 file, and so of every NetCDF-4 one. */
const HDF5_SIGNATURE = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]

/*
 * A Basic HGM month weighs 4.1 to 4.7 MB. A response far under that is not
 * the file: an error page, a login form or a truncated transfer.
 */
const LEAST_BYTES = 3_000_000

/** At most four downloads at once: NCEI's server, not this machine, sets the pace. */
const FETCH_JOBS = 4

/**
 * Where the monthly files are kept: `.data/weather/isccp` under the main
 * checkout, found from `root` through git. Outside a git checkout it is the
 * directory under `root` itself.
 */
export function isccpCache(root: string): string {
  let common: string
  try {
    common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return join(root, ISCCP_H.cache)
  }
  const directory = isAbsolute(common) ? common : resolve(root, common)
  return join(dirname(directory), ISCCP_H.cache)
}

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

function isHdf5(bytes: Uint8Array): boolean {
  return HDF5_SIGNATURE.every((byte, k) => bytes[k] === byte)
}

/** The manifest's entry for a file name, or undefined for one it does not list. */
export function manifestEntry(file: string): IsccpFile | undefined {
  return ISCCP_MANIFEST.find((entry) => entry.file === file)
}

/*
 * Held to the manifest when the manifest lists the file. Before the
 * manifest is written, a file is held only to being HDF5 of a plausible
 * size, which is all that can be known of it then.
 */
function check(file: string, bytes: Uint8Array): IsccpFile {
  if (bytes.byteLength < LEAST_BYTES || !isHdf5(bytes))
    throw new Error(
      `${file}: ${bytes.byteLength} bytes that are not a NetCDF-4 file. ` +
        'NCEI serves these anonymously; a page in their place is an error page or a login wall, and a login wall is a stop, not something to get past.',
    )
  const measured = { file, bytes: bytes.byteLength, sha256: sha256(bytes) }
  const expected = manifestEntry(file)
  if (
    expected !== undefined &&
    (expected.bytes !== measured.bytes || expected.sha256 !== measured.sha256)
  )
    throw new Error(
      `${file}: ${measured.bytes} bytes hashing to ${measured.sha256}, where the manifest records ${expected.bytes} and ${expected.sha256}. ` +
        'Delete the cached copy to fetch it again; if NCEI has re-released it, the manifest is what changes.',
    )
  return measured
}

async function fetchOne(
  month: { readonly file: string; readonly url: string },
  cache: string,
): Promise<{ readonly entry: IsccpFile; readonly fetched: boolean }> {
  const target = join(cache, month.file)
  if (existsSync(target))
    return { entry: check(month.file, readFileSync(target)), fetched: false }
  const response = await fetch(month.url, { redirect: 'error' })
  if (!response.ok)
    throw new Error(
      `${month.file}: ${response.status} ${response.statusText} from ${month.url}`,
    )
  const bytes = new Uint8Array(await response.arrayBuffer())
  // Checked before it is cached: a bad payload written here would be read
  // as the month on every later run.
  const entry = check(month.file, bytes)
  const partial = `${target}.part`
  writeFileSync(partial, bytes)
  renameSync(partial, target)
  return { entry, fetched: true }
}

/**
 * Fetch every month the table is made from into `cache`, four at a time,
 * keeping what is already there, and return each file's entry in month
 * order. Every file, fetched or cached, is held to the manifest.
 */
export async function fetchIsccp(
  cache: string,
  onProgress: (message: string) => void = () => {},
): Promise<readonly IsccpFile[]> {
  mkdirSync(cache, { recursive: true })
  const months = isccpMonths()
  const entries: IsccpFile[] = new Array(months.length)
  let next = 0
  let fetched = 0
  const lane = async (): Promise<void> => {
    while (next < months.length) {
      const index = next
      next += 1
      const month = months[index]!
      const result = await fetchOne(month, cache)
      entries[index] = result.entry
      if (result.fetched) {
        fetched += 1
        onProgress(
          `  ${month.file}  ${(result.entry.bytes / 1e6).toFixed(2)} MB  fetched`,
        )
      }
    }
  }
  await Promise.all(Array.from({ length: FETCH_JOBS }, lane))
  onProgress(
    `  ${months.length} months, ${fetched} fetched, ${months.length - fetched} cached`,
  )
  return entries
}

/** Whether every month is in `cache`: the source test runs only when it is. */
export function isccpCached(cache: string): boolean {
  return isccpMonths().every((month) => {
    const target = join(cache, month.file)
    return existsSync(target) && statSync(target).size >= LEAST_BYTES
  })
}

/**
 * One digest over the manifest, in month order: what a table's header
 * carries for its 120 inputs, so the header stays a line long and still
 * names the bytes it was made from.
 */
export function manifestDigest(entries: readonly IsccpFile[]): string {
  const lines = entries
    .map((entry) => `${entry.sha256}  ${entry.bytes}  ${entry.file}\n`)
    .join('')
  return createHash('sha256').update(lines).digest('hex')
}

/*
 * Each month's file as fetched from NCEI on 2026-11-10, in month order.
 * Written from `fetchIsccp`'s return and held by it on every rebuild.
 */
export const ISCCP_MANIFEST: readonly IsccpFile[] = [
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4352490,
    sha256: 'dbc1dcd0f58800886bd5ca19afc1f19f4626735bcd461e83b54daf9242a0e1d1',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4334832,
    sha256: '561a7ba7e89a13ee5e7a63097aca2744bf963523e77379a6a0fabcddecba04e5',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4461011,
    sha256: '3dbd0691be51e0b840278d97fe454a826d2b608da4068b2c4dcf7fad9eef3497',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4422317,
    sha256: '63f0183098d22733d10f7534ccadbfacce05652ae965030608a6a6d6930c472c',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4296643,
    sha256: '5bd2a0b7cf39d83e7a814d4a9f16a757383f67a19627b24640a4a2bd13bcf117',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4177866,
    sha256: '062e920940e6e94e284de898f0dbfd211b2a627291bd68b8a7f535284e0d0658',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4209543,
    sha256: '08aefbcd80530ad45f32c38359a1ebcbd9c74ff570616135711b52498991b31a',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4302221,
    sha256: '848f563449ab9a89862e5243098e4dd13c90c24967cc68fa193c07161ea18bc3',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4405068,
    sha256: '4618e488a2ab15c4959106ff192407482e5107dfd156481dea5df5bfe8940620',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4391142,
    sha256: 'a7cf075cca946612962521370790142be7877d82a6f1a2398dc92247881b2c5a',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4300821,
    sha256: '8457bf4171647d4b5695b8152ef3f31c8a79d1e8e6b1c04be35472db76ab8de1',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2007.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4183034,
    sha256: '16e29f0c537a54315efb19f2345dd317ede86bdd01fd40fba69e3a67dde6b909',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4236759,
    sha256: '0a9eb48369fc2f2d0b69a7023a863026cb34a961d396ec661b86feb6a28f2a96',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4365238,
    sha256: 'e7fa388b1f436e16a095b41a80c995b14da5db47b4bac21fcb1dec96983e35d2',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4460494,
    sha256: '840b81b05fb06673afe6eb5dfc83f9ef748754c582ccd9ae0dd952e26e0fe7f3',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4429701,
    sha256: '3e3388b986993600457e68a621d3a67145c33ce1ba179c046b50e20a84d3002e',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4273385,
    sha256: '900244920f750733618160fc986c3290392727b26eda71add0e42a248812ee87',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4162241,
    sha256: 'b36e0c5110aea103845c81fd713060779044ac48f0976f7bc58e59f4b2b2fc56',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4195815,
    sha256: '5c5dfc9decce789a7a83f74b464ce94ea1581f7d8fde5a71bb0b88a14d154b23',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4328465,
    sha256: '539f315d726f813d4b156574bb4fed42cfd4d3f4e725f90777ec32ff1241f582',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4423525,
    sha256: 'c8574644c1fa8969f4500ca94367f79243714a5e09763c0ef94b5a29016ede3e',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4384704,
    sha256: 'd9031a955a3561abf2412e2eb012e472f492f8271b79d2e57703bb014ceddb77',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4290392,
    sha256: 'fa786a7f593f32d0a54de3e7f41ef8e98471f8b2135d1f2092bd58e78ae5f978',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2008.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4202585,
    sha256: 'd3cc489b944101154df5813c7f2401f92bd9ac2a1658b4846a93d35f27c9ef70',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4256129,
    sha256: '201cbb0fe4ab40ad2e29762be71fae6056cdcb55a787b59ded03e82567972657',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4356512,
    sha256: '1e108869407bd8d2b0f12b3642f75351407c9cec9ad7e6a9f9194318cd7e1a88',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4476690,
    sha256: 'ea5c2b68367b39d1484822c910e4b06f3ea84ca8a4759e854944cc2f083c76bd',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4423889,
    sha256: '73b07454f947fa41231c9703fddb9cda947837a84667a7f621967d6e4423cd57',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4294462,
    sha256: 'b2c97f6ad0d3b4a31e65505d43fb096cf252d78dae751f55a051b48bc9508601',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4160833,
    sha256: '40fc5e06c482b68093ed84bd830eba0224c77a36370028705e0fbd87b437c316',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4195962,
    sha256: 'f92ca6e20fedb6bacb65394ef81a9f4db318cb4432238fe2e10dd702c05c482f',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4306500,
    sha256: 'e22378aec32b2454e04e9403bb3830e5e292d24fdd7f3b9bc434e53ea968a096',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4407586,
    sha256: '3dda0b142410f590c072aea7050d9805ca312754612e822a19c593ce81d0b33f',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4403957,
    sha256: '96112e6d24840dfb23551d55b92ee47979b211dc81ac1b7e487e80369b14b108',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4301499,
    sha256: '9ebb1487b02c7765f51e9126e53118255d555bc7d3d7493eb390a4a97be2c329',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2009.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4145098,
    sha256: '3a3d38a612dd4f7f55d2c4ed42a9c3bc2856c4ccd86c064b8f256915f96f898c',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4231364,
    sha256: 'bdf452df199c1c5e68b2de4efb073ea0e6f7c8b1f3971a08feb9e043af5e5ba7',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4354972,
    sha256: 'f4511397285721b22794528778a3fd23d15854d3bd4f1b95d15cee4aa5e02713',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4451404,
    sha256: '2fb68fc74e4360542ba903d1ee30c8402dd30ca9a5c2e5f67692b8ad7d5d3631',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4410215,
    sha256: '235530673876b76167acafaadd35dc4078ae56845222ffdeb55e59c78379dac8',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4265989,
    sha256: '39cdb14d4641dfb5b776a859a09c989d2b6bcb45e9670326aa470f18b9ad92ff',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4153838,
    sha256: '6351187811cf1d797f5a00717a2cfcfdb0f87f34c475724ed609f4da4d824eaa',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4189793,
    sha256: '7c2abf2abfcb6a4be05bd899569e3dfe6deb735cddd4a43e80f332ef2769e227',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4307755,
    sha256: '4f56f5c2bed6197865fa69cad623db8aecdd49735afb7deaff5d9bf2161f24cc',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4418746,
    sha256: '8675286f777d05a193a7d61508052d05602550bc35128613ecc0443e9af3fb1e',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4400003,
    sha256: 'd18a90e60916b91843736a318933fc21ece5514138e9107dc5fd8d71e57a2926',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4291901,
    sha256: 'd2bcb8259c3e9b57aa1c9d957970513d3bd8b4df0765250f913f36e6740d1a14',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2010.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4191000,
    sha256: 'a78c2067a2fbaae63f3d8b8f0ddf59e7382aa8a965c3aa535da2b1a762da06b7',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4243518,
    sha256: 'd30445a57b313050d1d44806b6eb02444b0e21042c7b217914fb28ed588675c2',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4363025,
    sha256: '9ac7b5cb4090048a92d43130cb8cc8dc0b0ef0a292dd133000eaec6cbc0f42bf',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4483276,
    sha256: '7c57b2746d6dddb1ceedf541a1a46d4e733c8d9a2b379e6b2e52c34f947228d6',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4410764,
    sha256: 'f38b54ffa9275ef105029af9c31b66accf2986d1a8764f5fd9721a5a7ed220b7',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4284970,
    sha256: '7a731cedf926fc78ee3fa3e6fcf89d73522d58d014193c14683f2d6526fb8a46',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4165787,
    sha256: 'df7f7069dc28dbeabae058209c8416c6bd70262362794b1837db97d9e86b405d',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4205954,
    sha256: 'a913d59444397b494b05ba99bf076d3208353dec11a7d2ff9116f0324ae2d73e',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4287669,
    sha256: 'eb7005c98c2668a3d3f583c267853594e70a0bd15b911e972d34eec3c85a0492',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4409441,
    sha256: 'ac9818a8e49542587bab7101657314ab082ac6587856a148f955ea96490b20db',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4389552,
    sha256: 'b31f931865845207ef07d0df0c1b07346db10a3f200c3729ef86ca04801cad8e',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4289767,
    sha256: '129eae1195f4d41b912e9e608de4159f6cbf4a66014b68dc7ec1f2518b64afee',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2011.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4204370,
    sha256: '5f7c191be3fb45137c0fe7f172158bf84f99020874b267cd4690c3e4c24bb484',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4249613,
    sha256: '224defbb7317d6311fa347917f6ea693687fd1e1bc546f252ce323356c9ad7de',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4395837,
    sha256: 'd953b20413d17dc3e2000a031b340efa9640ce441ccda16bf9faf5ee3f37502a',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4498905,
    sha256: 'b0b1bec9152572ebfac696beece0b236493cf203b7e129f07d9e7029d34ee861',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4448670,
    sha256: '20795de1b6e82aa97a401d5509e493f509375f2b6886807703733b060e8d854a',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4304069,
    sha256: 'f72ab43a34861fd28bb5d81e4a5911b43b070c7c0caa0ec850f1891e8fae70ef',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4194403,
    sha256: 'ab015c1608f5cf17e5e58ff3ce8608e6bb1f372412ad20c2ce5ded99e0a859df',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4234107,
    sha256: 'e9787928a4a0fe0669a4da22016e6ba469c823c30e315d565167f74b82cbd119',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4362081,
    sha256: 'a32b4e2de9cddc6007cf76a8351bfe81254e56aa891680e375936de0c4cf6a6a',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4526700,
    sha256: '47cf44eb3991db32655e317b8de95dce7b9b86dd4a0ee406c2903fa81c059ba8',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4532318,
    sha256: 'c18c1070cb23edfabf3a59bba1e040a676ee60998a03c220a18d0504f023b46f',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4366951,
    sha256: '7e9d9eb4068278ab247a10b7a1fb36066c68c9fd209f0feeab42635d7eb50250',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2012.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4277666,
    sha256: '92a46d1e818c563c5ed5b4cdbd927fee0464d1f0fdfa0a95682f80f299482292',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4329947,
    sha256: '38af6153b5951d0c03fa5ac3dc5d2377e48b361181588dce71851bc991592193',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4360512,
    sha256: '3b55d16234acb4a66e8e59814bbb536beee3783efe8b24c4203d31fa99ed2c68',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4536398,
    sha256: '55a6a091f6397fdc6fe98b442d318e7ceddb88ab14873aa90f682fa2e633cedd',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4433830,
    sha256: '38d18d840783e7ef56c5b722ab48ec6e1ba36eafd0858473fb17e662d4d23b0f',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4308613,
    sha256: '3d0c9413e914bfa9dbae29950064ae61a53666f56a841bdb416424aeff60f5de',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4166972,
    sha256: '0f8d8e953b1d761dde5461cf7ccd5226d68ea6bdfdac9669b6c3ee8061325c79',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4207433,
    sha256: '3dc7e649aebba89cf18d8952aa8bc27d4e052f5f242e1f1c9cfb71b91f071eb9',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4299476,
    sha256: '65140c9a31d79f104dca3deca8480b016a887120e5cca535a64da2858856aad0',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4397723,
    sha256: 'e9ab1dec3af9765f6d02bf19318849a07cda0d8abd16bbfcef62dd88870f3f14',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4426106,
    sha256: '20b358f897f36d264b3feaf588a53546d5b596dbf9062deda3d344a866a58157',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4261318,
    sha256: 'f3e0bc4216a3382b61d6cfd029a48f6b2a60cb1a0ab3a642ae45ddf39c4792d9',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2013.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4177614,
    sha256: 'fcb68bc74c6c392b6be506d802c092f464df3a963c27e077daf3db60d47d5737',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4201506,
    sha256: '56869cb9fb7200d20b157b1b13a384ebfa802aed5518ade4b4ff82b5f5337be9',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4320581,
    sha256: '8a068883ea7d6fb513f18ec570f28652b0b5a7bddc313afea23f43af84c41677',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4430515,
    sha256: 'a0940f4025bd291c8f812f76b6a2f9bce8db65aebd707d534ef9f436a3ef105d',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4373967,
    sha256: '9c50d68db36c2cf8ba5e59c76e1965f3fa37dd50dc7a29413c72034b4beebb0d',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4244344,
    sha256: '135825feb0601a0f67ce91f0e9f69e78d2544bf3c5bbf87ec9bc6942d3359543',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4118826,
    sha256: 'a130f6e6de0e92f821b3c9697b71d6ad2d2284713d0f6283e0ea2ff3f8d2a960',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4180799,
    sha256: '52e751027346616cc00d0171390082d488eb6d7ca073a9fa805174ce4d7f7b28',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4268938,
    sha256: 'c426e3f25071685c7b9bef069f349c6fa3da96b162ebaf1b3c86528af2df77f3',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4367924,
    sha256: '881f57886a6d29065d19237f63dfb81d6ab82c9da851c804d808d25929ff0d3b',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4345248,
    sha256: 'df1a9f92ec9ee2144ed683e982641b92d36de10d685ada3ef5e56d96de361e7d',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4262199,
    sha256: 'c5b7c9b8792f69c052d4b276754f1d0c7582699b02c1cdba2e13fd1a35dc6125',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2014.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4140159,
    sha256: 'f0010f18d5f1d827ec92f6f395b5870904204e103a5c3c02ce7c8c6b1f538f90',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4200216,
    sha256: '2792aeb81d97aac678d0d5018c5b650cc91e8fd47cb09d339a76250aa3ae92ef',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4330546,
    sha256: '92d3602a1f128fb2de2b6dba136035e101e2dc04694a2fd46502f61d3cbf45f6',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4432577,
    sha256: 'a5523b7a2f01d9facd056b04161b1bc2f7e8454e4bd84818a81ce32a74c15414',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4387654,
    sha256: 'f2d84d86c73d1ae515d2ddaeb3b885bd087034361ed915a13c64faf065a35747',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4254743,
    sha256: 'd1301fde8b57bcb6acc0fe58af490061ad60f5bcbb5cea4a1f8b336424e49471',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4125436,
    sha256: '6257e4ffe6c8a29118635cad76d0d400403aea085c493902c89e4c11d0274d40',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4190913,
    sha256: 'ba8611f1f2ce31fe12d0d03fe342f232675337d6cfb181184f553d3743598535',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4241143,
    sha256: 'a94c19a6d4cbefa28059342272130f62365f0fd620185eae8e656505f912e27c',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4485600,
    sha256: '15c12c9891981bce8b0303fc03278cced618b352b5c55baee0a5d696f7bd1498',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4459829,
    sha256: '43eff97e7fb6795615bbff8e4a9256329719c3ec992b1e81cfd5942315c5da75',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4353007,
    sha256: '7277ee2fcd609cd5898d172ef03bb14c3c0811c579831955047a2466edde0c46',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2015.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4190691,
    sha256: 'd881bc9fb651e2136e68ebed9f8dd031a22a721124dc449339293bee463e5cd4',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.01.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4267545,
    sha256: '838338fe3263a95c9866011c4f96f485d6049667cf4d1f09674b65e8ddf5d067',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.02.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4455798,
    sha256: '9ad83356b7af9625d12a3a67b049cb80a361311ce7c3ea18cc688c4b3d98f911',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.03.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4539442,
    sha256: '0645fe6370df535c1d58233d73cd56c21d69e6d05fecf7bba9e633fc45025bc1',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.04.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4460393,
    sha256: '68ad9f52995a34c1bf05596f79a22f539e8747c2f165d050eaff480f654cab54',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.05.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4305965,
    sha256: '66454e1e08c56432c9bf6b94890b710e846c2e886fab3dcf584630b35fa2f2b5',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.06.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4177641,
    sha256: '2c4570db61e4bad171d5e969ae99cad12b16cec13491a27fedc45e0558b3ca00',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.07.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4211933,
    sha256: '7c7590a8df16aba975582ef8e0c5d1332dd7c31abc893a711bfaa5e5db6f51ca',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.08.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4344433,
    sha256: '1ee7c66bfdcc0f26ece86069e8f0a94cea26aab814edd8090b6f8cda991c32e5',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.09.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4499787,
    sha256: '1d689cb66ab98856bc2e412072708cfe1cbf1cebe28848e0066826e75a93e228',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.10.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4478173,
    sha256: '8423f904ecb24f59aec68d5d07504fc343231548db97bc445f0408049f330e14',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.11.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4327045,
    sha256: '0f6f1be5e712773a72d0d6b17874ce66a80acf2701f1a655e408603846424625',
  },
  {
    file: 'ISCCP-Basic.HGM.v01r00.GLOBAL.2016.12.99.9999.GPC.10KM.CS00.EA1.00.nc',
    bytes: 4192479,
    sha256: '5d7d5c5cac59fdc25a6051d70e83b4389f70642c106ad76b486a31ee5b220df7',
  },
]

/** `isccp:fetch`: every month into the cache, and, asked, the manifest's text to paste below. */
export async function fetchIsccpMonths(
  root: string,
  printManifest: boolean,
): Promise<void> {
  const cache = isccpCache(root)
  console.log(`ISCCP-H into ${cache}`)
  const entries = await fetchIsccp(cache, (message) => console.log(message))
  const bytes = entries.reduce((n, entry) => n + entry.bytes, 0)
  console.log(`  ${bytes} bytes, digest ${manifestDigest(entries)}`)
  if (printManifest)
    console.log(
      entries
        .map(
          (entry) =>
            `  { file: '${entry.file}', bytes: ${entry.bytes}, sha256: '${entry.sha256}' },`,
        )
        .join('\n'),
    )
}

/** At most four processes read the files: the CPU window the read is granted. */
const READ_JOBS = 4

/** `isccp:reduce`: the child's half. Each named file reduced alone, as JSON on stdout. */
export async function reduceIsccpFiles(
  paths: readonly string[],
): Promise<void> {
  const reduced = []
  for (const path of paths) {
    const name = basename(path)
    const month = isccpMonths().find((entry) => entry.file === name)
    if (month === undefined)
      throw new Error(`isccp:reduce: ${name} is no month of the table`)
    reduced.push({
      file: name,
      sums: reduceMonth(await readIsccp(path), month.month),
    })
  }
  process.stdout.write(JSON.stringify(reduced))
}

function reduceIn(
  main: string,
  paths: readonly string[],
): Promise<readonly { readonly file: string; readonly sums: MonthSums }[]> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [main, 'isccp:reduce', ...paths], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0) fail(new Error(`isccp:reduce exited ${code}`))
      else done(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    })
  })
}

/*
 * The months are dealt to the processes in turn and gathered back by name,
 * then combined in month order: which process read which file does not
 * reach the table.
 */
async function reduceAll(
  main: string,
  cache: string,
): Promise<readonly MonthSums[]> {
  const files = isccpMonths().map((month) => month.file)
  const lanes = Array.from({ length: READ_JOBS }, (_, lane) =>
    files
      .filter((_file, k) => k % READ_JOBS === lane)
      .map((file) => join(cache, file)),
  )
  const results = (
    await Promise.all(lanes.map((paths) => reduceIn(main, paths)))
  ).flat()
  return files.map((file) => {
    const found = results.find((result) => result.file === file)
    if (found === undefined) throw new Error(`isccp: ${file} was not reduced`)
    return found.sums
  })
}

const share = (value: number | null): string =>
  value === null ? '   —' : (100 * value).toFixed(1).padStart(5)

/**
 * `isccp`: fetch what is missing, hold every file to the manifest, read
 * the ten years over four processes and write the zonal table. `main` is
 * the entry the children are started from.
 */
export async function buildIsccp(root: string, main: string): Promise<void> {
  const cache = isccpCache(root)
  console.log(`ISCCP-H from ${cache}`)
  const entries = await fetchIsccp(cache, (message) => console.log(message))
  const unlisted = entries.filter(
    (entry) => manifestEntry(entry.file) === undefined,
  )
  if (unlisted.length > 0)
    throw new Error(
      `isccp: the manifest lists ${entries.length - unlisted.length} of ${entries.length} files. ` +
        'Run `node apps/ingest/src/main.ts isccp:fetch --print-manifest` and record its lines in ISCCP_MANIFEST.',
    )
  const started = performance.now()
  const table = combineMonths(await reduceAll(main, cache))
  const seconds = (performance.now() - started) / 1000
  const text = formatIsccpTable(table, {
    generator:
      '`pnpm isccp:build` (apps/ingest/src/isccpSources.ts and isccp.ts)',
    name: ISCCP_H.name,
    files: entries.length,
    bytes: entries.reduce((n, entry) => n + entry.bytes, 0),
    digest: manifestDigest(entries),
    citations: ISCCP_H.citations,
    license: ISCCP_H.license,
  })
  writeFileSync(join(root, ISCCP_H.table), text)
  const { global } = table
  console.log(`
  read and reduced in ${seconds.toFixed(1)} s over ${READ_JOBS} processes
  global ${share(global.cover)}%   land ${share(global.land)}%   ocean ${share(global.ocean)}%
  low ${share(global.low)}%   middle ${share(global.middle)}%   high ${share(global.high)}%
  levels from the infrared types over ${share(table.infrared)}% of the area, from neither over ${share(table.unsplit)}%
  bands, south to north: ${table.annual.cover.map(share).join(' ')}
${table.types.map((row) => `  ${row.type.padEnd(16)} cover ${share(row.cover)}%  τ ${row.depth.toFixed(2).padStart(6)} (linear ${row.linearDepth.toFixed(2)}, log ${row.logDepth.toFixed(2)})  pc ${row.pressure.toFixed(0)} hPa`).join('\n')}
  written to ${ISCCP_H.table}`)
}
