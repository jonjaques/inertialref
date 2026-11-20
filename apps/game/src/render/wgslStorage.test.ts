import { expect, it } from 'vitest'
import { wgslEntryPoint, wgslStorage } from './wgslStorage.ts'

it('sums SizeOf including matrix column stride, array stride, and struct padding', () => {
  const shader = `
    enable f16;
    alias Pair = array<vec3h, 2>;
    struct Packet {
      a: f32,
      @align(16) @size(24) b: vec3f,
      pair: Pair,
      matrix: mat3x3h,
    }
    var<private> packet: Packet;
    var<private> vector: vec3f;
    var<private> unused: array<vec4f, 2048>;
    fn contribute() -> f32 {
      var typed: array<array<vec3f, 2>, 3>;
      var inferred = array(vec2f(0), vec2f(1), vec2f(2));
      return packet.a + vector.x + typed[0][0].x + inferred[0].x;
    }
    @compute @workgroup_size(1)
    fn run() {
      var<function> a: bool;
      { var x: mat2x3f; }
      let output = contribute();
    }
  `
  expect(wgslEntryPoint(shader, 'compute')).toBe('run')
  // Packet = roundUp(16 + 24 + 16 + 24, 16) = 80.
  expect(wgslStorage(shader, 'run')).toEqual({
    privateBytes: 80 + 12,
    functionBytes: 96 + 24,
    functionName: 'contribute',
  })
})

it('measures stages separately and ignores nested shader comments', () => {
  const shader = `
    /* /* nested */ // comment ends here */ var<private> pixel: vec4f;
    // var<private> fake: array<vec4f, 2048>;
    @fragment fn frag() -> @location(0) vec4f { return pixel; }
    @vertex fn vert() -> @builtin(position) vec4f {
      var point = vec4f(0, 0, 0, 1);
      return point;
    }
  `
  expect(wgslEntryPoint(shader, 'fragment')).toBe('frag')
  expect(wgslStorage(shader, 'frag')).toEqual({
    privateBytes: 16,
    functionBytes: 0,
    functionName: 'frag',
  })
  expect(wgslStorage(shader, 'vert')).toEqual({
    privateBytes: 0,
    functionBytes: 16,
    functionName: 'vert',
  })
})

it('surfaces unsupported size expressions with the declaration type', () => {
  expect(() =>
    wgslStorage(
      'var<private> v: array<f32, COUNT>; fn main() { v[0] = 0; }',
      'main',
    ),
  ).toThrow('Unknown WGSL array length in array<f32, COUNT>')
})
