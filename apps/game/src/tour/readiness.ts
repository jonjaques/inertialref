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

/**
 * Whether the subject is in the scene, and whether what draws it has arrived.
 *
 * Out of the runtime, which closes over the DOM and the engine, so that the
 * one decision in it a new kind of subject has to join is a test away. A
 * station is in `scene.stations`, not `scene.bodies`, and without it here a
 * `go_to` the ISS is never present and never arrives. Its asset is the model,
 * fetched on first sight, so it is ready once the scene has drawn it, as a
 * body is once its textures are.
 */
export function subjectView<B extends { readonly address: string }>(
  scene: {
    readonly bodies: readonly B[]
    readonly stars: readonly { readonly system: string }[]
    readonly stations: readonly { readonly address: string }[]
  },
  target: {
    readonly address: string
    readonly system: string
    readonly kind: string
  },
  bodyReady: (body: B) => boolean,
  stationsDrawn: ReadonlySet<string>,
): { present: boolean; assets: boolean } {
  const body = scene.bodies.find((one) => one.address === target.address)
  const station = scene.stations.find((one) => one.address === target.address)
  const star =
    target.kind === 'star' &&
    scene.stars.some((one) => one.system === target.system)
  return {
    present: body !== undefined || station !== undefined || star,
    assets:
      station !== undefined
        ? stationsDrawn.has(station.address)
        : body === undefined || bodyReady(body),
  }
}
