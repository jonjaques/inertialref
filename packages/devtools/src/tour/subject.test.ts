import { describe, expect, it, vi } from 'vitest'
import { PICTURES } from '../pictures.ts'
import { openSession } from '../session.ts'
import { createTourContext } from './inventory.ts'
import { normalizeSubjectName, resolveSubject, subjectAt } from './subject.ts'

describe('the guide resolves a named subject directly', () => {
  it('resolves a name, an alias and an article to one subject with its framings', () => {
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:2', { ease: false })
    const saturn = resolveSubject(ir, 'Saturn')
    expect(saturn.ok).toBe(true)
    if (saturn.ok) {
      expect(saturn.subject.candidate.name).toBe('Saturn')
      expect(saturn.subject.candidate.framings).toContain('portrait')
      expect(saturn.subject.brief.facts.length).toBeGreaterThan(3)
      expect(saturn.subject.candidate.id).toBe(saturn.subject.brief.subjectId)
    }
    for (const [said, meant] of [
      ['the moon', 'Luna'],
      ['Sun', 'Sol'],
      ['  titan ', 'Titan'],
    ]) {
      const found = resolveSubject(ir, said!)
      expect(found.ok, said).toBe(true)
      if (found.ok) expect(found.subject.candidate.name).toBe(meant)
    }
    session.dispose()
  })

  it('answers an unknown name with the nearest rows rather than a guess', () => {
    const session = openSession()
    const found = resolveSubject(session.harness, 'Saturnalia')
    expect(found.ok).toBe(false)
    if (!found.ok) expect(Array.isArray(found.nearest)).toBe(true)
    session.dispose()
  })

  it('reads the subject record and prepares no other body', () => {
    /*
     * The measurement this module exists for. Resolving one name through the
     * full inventory read 253 dossiers to find Saturn from Earth; a lookup
     * reads Saturn's. The preset table is excluded because the candidate
     * builder compares each authored picture's address against the subject,
     * which is a read of that picture's record and not a preparation of it.
     */
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:2', { ease: false })
    const pictured = new Set(
      PICTURES.flatMap((picture) => [
        picture.address,
        ir.dossier(picture.address)?.address ?? picture.address,
      ]),
    )
    const reads: string[] = []
    const dossier = ir.dossier.bind(ir)
    vi.spyOn(ir, 'dossier').mockImplementation((address) => {
      reads.push(address)
      return dossier(address)
    })
    const found = resolveSubject(ir, 'Saturn')
    expect(found.ok).toBe(true)
    if (!found.ok) return
    const subject = found.subject.candidate.address
    const prepared = new Set(
      reads
        .map((address) => dossier(address)?.address ?? address)
        .filter((address) => address === subject || !pictured.has(address)),
    )
    expect([...prepared]).toEqual([subject])
    // And the inventory a collection asks for is still the wide one.
    reads.length = 0
    const context = createTourContext(ir, 'Saturn')
    expect(context.candidates.length).toBeGreaterThan(8)
    expect(new Set(reads).size).toBeGreaterThan(8)
    session.dispose()
  })

  it('agrees with the inventory about what a subject is', () => {
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:5', { ease: false })
    const direct = subjectAt(ir, 's:SOL/b:5')!
    const context = createTourContext(ir, 'Saturn')
    const listed = context.candidates.find(
      (one) => one.id === direct.candidate.id,
    )
    expect(listed).toEqual(direct.candidate)
    expect(normalizeSubjectName('The Moon')).toBe('luna')
    session.dispose()
  })
})
