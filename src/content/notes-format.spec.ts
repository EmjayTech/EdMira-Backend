import { checkTopic, figureTypeOk, licenceProblem, originality, parseQuestions, parseTopic, similarity } from './notes-format';

const TOPIC = `---
id: PHY-07-02
title: Glomerular filtration
summary: How plasma is filtered into Bowman's space.
readMinutes: 12
---

## Objectives
- Define GFR
- List the Starling forces at the glomerulus
- Explain autoregulation

## Key points
- GFR is about **125 mL/min** in a young adult

## Notes
### The filtration barrier
Three layers sit between blood and Bowman's space.

{{fig:barrier}}

### Starling forces
| Force | Direction |
|---|---|
| Glomerular hydrostatic | Out |

## Extended
### Measuring GFR
Inulin clearance is the reference method.

## Clinical correlation
### Nephrotic syndrome
Damage to the barrier lets protein leak.

## Revision
- GFR ≈ 125 mL/min

## Further reading
- Guyton & Hall, Renal chapters (cited, not copied)

## Figures
- key: barrier
  file: figures/barrier.svg
  caption: The three layers of the filtration barrier.
  alt: Diagram of endothelium, basement membrane and podocytes.
`;

const q = (over: Record<string, unknown> = {}) => ({
  stem: 'Which layer of the filtration barrier carries the most negative charge?',
  options: ['Endothelium', 'Basement membrane', 'Podocyte slits', 'Mesangium'],
  answer: 'B',
  explanation: 'The basement membrane is rich in heparan sulphate, so it repels anionic proteins; the other layers matter less for charge.',
  difficulty: 'medium',
  kind: 'understanding',
  ...over,
});

describe('note files', () => {
  it('reads every part of the standard format', () => {
    const t = parseTopic(TOPIC);
    expect(t).toMatchObject({ id: 'PHY-07-02', title: 'Glomerular filtration', readMinutes: 12 });
    expect(t.objectives).toHaveLength(3);
    expect(t.keyPoints).toEqual(['GFR is about **125 mL/min** in a young adult']);
    expect(t.material.map(s => s.heading)).toEqual(['The filtration barrier', 'Starling forces']);
    expect(t.extended[0].heading).toBe('Measuring GFR');
    expect(t.clinical[0].heading).toBe('Nephrotic syndrome');
    expect(t.revision).toEqual(['GFR ≈ 125 mL/min']);
    expect(t.furtherReading).toHaveLength(1);
    expect(t.figures[0]).toMatchObject({ key: 'barrier', file: 'figures/barrier.svg', source: 'EdMira', licence: 'Original', modified: false });
    expect(checkTopic(t, 'x.md', { id: 'PHY-07-02' }).filter(p => p.level === 'error')).toEqual([]);
  });

  it('rejects topics outside the outline and figures that are used but not listed', () => {
    const t = parseTopic(TOPIC.replace('{{fig:barrier}}', '{{fig:barrier}}\n\n{{fig:missing}}'));
    const errors = checkTopic(t, 'x.md', undefined).filter(p => p.level === 'error').map(p => p.message);
    expect(errors.some(m => m.includes("isn't in the curriculum outline"))).toBe(true);
    expect(errors.some(m => m.includes('{{fig:missing}}'))).toBe(true);
  });
});

describe('image licences (copyright-safe only)', () => {
  const fig = (over: Record<string, unknown>) => ({ key: 'k', file: 'f.png', caption: 'c', alt: 'a', source: 'EdMira', licence: 'Original', attributionText: '', modified: false, ...over });

  it('allows our own figures, Servier CC BY 4.0 and commercial-use Wikimedia files', () => {
    expect(licenceProblem(fig({}))).toBeNull();
    expect(
      licenceProblem(fig({ source: 'Servier Medical Art', licence: 'CC BY 4.0', attributionText: 'Images provided by Servier Medical Art (smart.servier.com), licensed under CC BY 4.0', originalUrl: 'https://smart.servier.com/x' })),
    ).toBeNull();
    expect(licenceProblem(fig({ source: 'Wikimedia Commons', licence: 'CC BY-SA 4.0', attributionText: 'By Jane Doe, CC BY-SA 4.0', originalUrl: 'https://commons.wikimedia.org/wiki/File:X.svg' }))).toBeNull();
    expect(licenceProblem(fig({ source: 'Wikimedia Commons', licence: 'Public domain', attributionText: 'Public domain', originalUrl: 'https://commons.wikimedia.org/wiki/File:Y.png' }))).toBeNull();
  });

  it('refuses NonCommercial, NoDerivatives, textbooks and missing attributions', () => {
    expect(licenceProblem(fig({ source: 'OpenStax', licence: 'CC BY-NC-SA 4.0', attributionText: 'x', originalUrl: 'https://x' }))).toMatch(/NonCommercial/);
    expect(licenceProblem(fig({ source: 'StatPearls', licence: 'CC BY-NC-ND 4.0', attributionText: 'x', originalUrl: 'https://x' }))).toMatch(/NonCommercial|NoDerivatives/);
    expect(licenceProblem(fig({ source: 'Wikimedia Commons', licence: 'CC BY-ND 4.0', attributionText: 'x', originalUrl: 'https://commons.wikimedia.org/x' }))).toMatch(/NoDerivatives/);
    expect(licenceProblem(fig({ source: 'Textbook scan', licence: 'CC BY 4.0', attributionText: 'x', originalUrl: 'https://x' }))).toMatch(/textbooks/);
    expect(licenceProblem(fig({ source: 'Wikimedia Commons', licence: 'CC BY 4.0', attributionText: '', originalUrl: 'https://commons.wikimedia.org/x' }))).toMatch(/attribution/);
    expect(licenceProblem(fig({ source: 'Servier Medical Art', licence: 'CC BY 4.0', attributionText: 'Servier', originalUrl: 'https://smart.servier.com/x' }))).toMatch(/smart\.servier\.com/);
    expect(
      licenceProblem(fig({ source: 'Servier Medical Art', licence: 'CC BY 4.0', modified: true, attributionText: 'Images provided by Servier Medical Art (smart.servier.com), licensed under CC BY 4.0', originalUrl: 'https://smart.servier.com/x' })),
    ).toMatch(/modified/);
    expect(licenceProblem(fig({ source: 'Someone', licence: 'Original' }))).toMatch(/EdMira's own/);
  });
});

describe('questions', () => {
  it('accepts a well-formed question', () => {
    const r = parseQuestions([q()], 'x.mcq.json');
    expect(r.problems.filter(p => p.level === 'error')).toEqual([]);
    expect(r.questions[0]).toMatchObject({ answerIndex: 1, difficulty: 'medium', kind: 'understanding' });
  });

  it('refuses "all of the above", bad answers, thin explanations and near-duplicates', () => {
    const r = parseQuestions(
      [
        q({ options: ['A thing', 'Another', 'Third', 'All of the above'] }),
        q({ answer: 'F' }),
        q({ explanation: 'Because.' }),
        q({ stem: 'Which layer of the filtration barrier carries the most negative charge?' }),
        q({ options: ['One', 'Two', 'Three'] }),
      ],
      'x.mcq.json',
    );
    const msgs = r.problems.filter(p => p.level === 'error').map(p => p.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'No "all / none of the above" options.',
        'The answer must be one of the options (A–E).',
        expect.stringContaining('Needs an explanation'),
        expect.stringContaining('Nearly the same as question'),
        expect.stringContaining('Needs 4 or 5 options'),
      ]),
    );
  });

  it('treats Greek-letter options as different (α1 vs β1)', () => {
    const r = parseQuestions([q({ options: ['α1', 'β1', 'M3', 'β2'], answer: 'D' })], 'x.mcq.json');
    expect(r.problems.filter(p => p.level === 'error')).toEqual([]);
  });

  it('warns when correct answers bunch in one position', () => {
    const many = Array.from({ length: 10 }, (_, i) => q({ stem: `Question number ${i} about a completely different physiology idea ${'xyz'.repeat(i + 1)}?`, answer: 'A' }));
    const r = parseQuestions(many, 'x.mcq.json');
    expect(r.problems.some(p => p.level === 'warning' && /one position/.test(p.message))).toBe(true);
  });

  it('measures stem similarity', () => {
    expect(similarity('What raises GFR in the glomerulus?', 'What raises the GFR in a glomerulus?')).toBeGreaterThan(0.8);
    expect(similarity('What raises GFR?', 'Where is erythropoietin made?')).toBeLessThan(0.2);
  });
});

describe('originality (free check)', () => {
  const para = 'The countercurrent multiplier in the loop of Henle builds an osmotic gradient in the medulla that lets the collecting duct concentrate urine when ADH is present.';
  it('flags a paragraph that repeats another topic', () => {
    const flags = originality({ id: 'PHY-07-05', sections: [{ label: 'Notes › Gradient', body: para }] }, [{ label: 'PIO212 › Tubular Function', text: `Intro. ${para} More text.` }]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ matches: 'PIO212 › Tubular Function' });
    expect(flags[0].score).toBeGreaterThan(0.9);
  });
  it('leaves original writing alone, and catches stock phrases', () => {
    expect(originality({ id: 'x', sections: [{ label: 'Notes', body: para }] }, [{ label: 'other', text: 'Erythropoietin from the kidney drives red cell production in the marrow.' }])).toEqual([]);
    expect(originality({ id: 'x', sections: [{ label: 'Notes', body: para }] }, [], ['lets the collecting duct concentrate urine'])).toHaveLength(1);
  });
});

describe('figure files', () => {
  it('checks the content, not just the extension', () => {
    expect(figureTypeOk('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>'))).toBe(true);
    expect(figureTypeOk('image/svg+xml', Buffer.from('<svg><script>alert(1)</script></svg>'))).toBe(false);
    expect(figureTypeOk('image/svg+xml', Buffer.from('<svg onload="x()"></svg>'))).toBe(false);
    expect(figureTypeOk('image/svg+xml', Buffer.from('<svg><image href="https://evil.example/x.png"/></svg>'))).toBe(false);
    expect(figureTypeOk('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(true);
    expect(figureTypeOk('image/png', Buffer.from('not a png'))).toBe(false);
  });
});
