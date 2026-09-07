import { encodePictures, type Picture } from '@inertialref/devtools'

export function downloadPictures(
  pictures: readonly Picture[],
  name = 'inertialref-presets',
): void {
  const url = URL.createObjectURL(
    new Blob([encodePictures(pictures)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
