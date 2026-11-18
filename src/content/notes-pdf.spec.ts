import { NotesPdfService } from './notes-pdf.service';

/** Renders notes without a database (the private render step). */
const render = (sections: number, paragraphsPerSection = 3) => {
  const service = new NotesPdfService({} as never, {} as never, {} as never, {} as never);
  const para = 'Glycolysis converts glucose to pyruvate in the cytosol, producing ATP and NADH. '.repeat(12);
  const topic = {
    title: 'Long topic',
    summary: 'A long topic to check page breaks.',
    material: Array.from({ length: sections }, (_, i) => ({
      heading: `Section ${i + 1}`,
      body: Array.from({ length: paragraphsPerSection }, () => para).join('\n\n'),
      keyPoints: ['Point one', 'Point two', 'Point three'],
    })),
  };
  const course = { title: 'Biochemistry', code: 'BCH 201', description: '' };
  const doc = (service as any).render(course, [topic], 'topic');
  return new Promise<Buffer>(resolve => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
};

const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

describe('notes PDF', () => {
  it('flows long notes onto as many pages as they need', async () => {
    const pdf = await render(20);
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pages(pdf)).toBeGreaterThan(5);
  });

  it('keeps a short topic on one page', async () => {
    expect(pages(await render(1, 1))).toBe(1);
  });

  it('draws the standard note format: boxes, lists, a table, a callout and a figure with its credit', async () => {
    const service = new NotesPdfService({} as never, {} as never, {} as never, {} as never);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="10" y="10" width="380" height="180" fill="#EEF2FE"/><text x="200" y="100" text-anchor="middle">Nephron</text></svg>');
    const figure = { key: 'nephron', label: 'Figure 7.1.1', caption: 'The parts of a nephron.', alt: 'Diagram', source: 'Servier Medical Art', licence: 'CC BY 4.0', attributionText: 'Images provided by Servier Medical Art (smart.servier.com), licensed under CC BY 4.0', modified: false, assetId: 'a'.repeat(32), mimeType: 'image/svg+xml' };
    const topic = {
      id: 't1',
      title: 'The nephron',
      summary: 'How the kidney filters blood.',
      objectives: ['Describe the nephron', 'Explain filtration', 'Relate GFR to clearance'],
      keyPoints: ['Each kidney has about **one million** nephrons'],
      material: [{ heading: 'Structure', body: 'The nephron has **two** parts.\n\n- Glomerulus\n- Tubule\n\n{{fig:nephron}}\n\n| Part | Job |\n|---|---|\n| Glomerulus | Filters |\n| Tubule | Reabsorbs |\n\n> Exam tip: learn the parts in order.' }],
      extended: [{ heading: 'Juxtamedullary nephrons', body: 'Long loops of Henle concentrate urine.' }],
      clinical: [{ heading: 'Nephrotic syndrome', body: 'Protein leaks into urine.' }],
      revision: ['GFR ≈ 125 mL/min'],
      furtherReading: ['Guyton & Hall, Renal chapters'],
      figures: [figure],
    };
    const figures = new Map([['t1:nephron', { figure, mimeType: 'image/svg+xml', data: svg }]]);
    const doc = (service as any).render({ title: 'Physiology III', code: 'PIO212', description: '' }, [topic], 'topic', figures);
    const pdf = await new Promise<Buffer>(resolve => {
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf.length).toBeGreaterThan(5000);
  });
});

