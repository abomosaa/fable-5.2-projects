// Contact-sheet composer: grid of images with text labels (uses sharp + SVG text).
import sharp from 'sharp';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{label:string, image:Buffer|string, sub?:string}[]} cells
 * @param {{cellW:number, cellH:number, cols:number, labelH?:number, out:string, quality?:number, bg?:string}} opts
 */
export async function contactSheet(cells, opts) {
  const { cellW, cellH, cols, out } = opts;
  const labelH = opts.labelH ?? 22;
  const rows = Math.ceil(cells.length / cols);
  const W = cols * cellW;
  const H = rows * (cellH + labelH);
  const composites = [];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * (cellH + labelH);
    const buf = await sharp(c.image)
      .resize(cellW, cellH, { fit: 'contain', background: opts.bg ?? '#202428' })
      .flatten({ background: opts.bg ?? '#202428' })
      .png({ compressionLevel: 1 })
      .toBuffer();
    composites.push({ input: buf, left: x, top: y + labelH });
    const fs = Math.min(15, Math.max(9, Math.floor((cellW * 1.7) / Math.max(8, (c.label + (c.sub ? '  ' + c.sub : '')).length))));
    svg += `<text x="${x + 4}" y="${y + labelH - 6}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fs}" fill="#fff">${esc(c.label)}${c.sub ? `<tspan fill="#9cf" dx="10">${esc(c.sub)}</tspan>` : ''}</text>`;
  }
  svg += '</svg>';
  composites.push({ input: Buffer.from(svg), left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111418' } })
    .composite(composites)
    .toFormat(out.endsWith('.png') ? 'png' : 'jpeg', out.endsWith('.png') ? { compressionLevel: 7 } : { quality: opts.quality ?? 86, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return { width: W, height: H };
}
