/*
 * A twentieth of a second of silence, as a WAV in a data URL.
 *
 * What a deck plays inside the first gesture to be allowed to play later.
 * Safari permits an `<audio>` element to play without a gesture once it has
 * played inside one, whatever it is later pointed at — and the deck that will
 * take the second track of a crossfade has nothing to play during that first
 * gesture. Silence is a file it can play without a request, and a data URL is
 * same-origin for the purposes of `createMediaElementSource`, so the graph
 * passes it through rather than zeroing it.
 *
 * Built rather than written out: a header and 400 zero samples are clearer as
 * the arithmetic than as a kilobyte of base64.
 */

const RATE = 8_000
const SAMPLES = 400

function wav(): Uint8Array {
  const data = SAMPLES * 2
  const bytes = new Uint8Array(44 + data)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1)
      bytes[offset + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + data, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, data, true)
  return bytes
}

/** The silent file, as a URL an element can play. */
export function silence(): string {
  let binary = ''
  for (const byte of wav()) binary += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(binary)}`
}
