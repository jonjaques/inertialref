/** A readback belongs to the camera and presentation instant that submitted it. */
export class SensorHistory {
  #generation = 0
  #key: string | null = null
  #time: number | null = null
  #retired = false

  advance(key: string, time: number): number {
    if (
      key !== this.#key ||
      this.#time === null ||
      time < this.#time ||
      time - this.#time > 0.5
    )
      this.#generation++
    this.#key = key
    this.#time = time
    return this.#generation
  }

  accepts(
    generation: number,
    key: string,
    time: number,
    held = false,
  ): boolean {
    return (
      !this.#retired &&
      !held &&
      generation === this.#generation &&
      key === this.#key &&
      this.#time !== null &&
      time >= this.#time &&
      time - this.#time <= 0.5
    )
  }

  retire(): void {
    this.#retired = true
    this.#generation++
  }
}
