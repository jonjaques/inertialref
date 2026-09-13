import { expect, it } from 'vitest'
import { transcriptRows } from './transcript.ts'

it('keeps overlapping speakers in arrival order and stable rows as text grows', () => {
  const first = {
    eventId: 'a',
    speaker: 'guide' as const,
    text: 'Look',
    startMs: 100,
    endMs: 200,
  }
  const second = {
    eventId: 'b',
    speaker: 'guide' as const,
    text: ' at Saturn.',
    startMs: 200,
    endMs: 300,
  }
  const visitor = {
    eventId: 'c',
    speaker: 'visitor' as const,
    text: 'What are the rings?',
    startMs: 250,
    endMs: 500,
  }
  const answer = {
    eventId: 'd',
    speaker: 'guide' as const,
    text: 'The rings',
    startMs: 400,
    endMs: 600,
  }
  const events = [first, second, visitor, answer]
  const rows = transcriptRows(events)
  expect(rows.map((row) => row.eventId)).toEqual(['a', 'c', 'd'])
  expect(rows[0]?.text).toBe('Look at Saturn.')
  expect(events[0]?.text).toBe('Look')
})
