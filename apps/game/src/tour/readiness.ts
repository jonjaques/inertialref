/** A camera solve is ready only after its assets have reached rendered frames. */
export class ViewReadiness {
  #renderer: object | null = null
  #revision = -1
  #frame = Infinity
  ready(view: {
    renderer: object
    revision: number
    frame: number
    present: boolean
    assets: boolean
  }): boolean {
    if (
      view.renderer !== this.#renderer ||
      view.revision !== this.#revision ||
      !view.present ||
      !view.assets
    ) {
      this.#renderer = view.renderer
      this.#revision = view.revision
      this.#frame = Infinity
    }
    if (!view.present || !view.assets) return false
    if (this.#frame === Infinity) this.#frame = view.frame
    return view.frame >= this.#frame + 2
  }
}
