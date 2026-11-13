/** The layer catalog: every layer of every registered source, indexed for the pipeline, the store and the API. */
import { DOMAINS, type LayerDef, type SourceAdapter, type SourceManifest } from './types.ts';

export interface CatalogLayer extends LayerDef {
  sourceId: string;
}

export class Catalog {
  readonly sources = new Map<string, SourceManifest>();
  readonly layers = new Map<string, CatalogLayer>();
  readonly adapters = new Map<string, SourceAdapter>();

  constructor(adapters: SourceAdapter[]) {
    for (const a of adapters) {
      const m = a.manifest;
      if (this.sources.has(m.id)) throw new Error(`duplicate source id ${m.id}`);
      this.sources.set(m.id, m);
      this.adapters.set(m.id, a);
      for (const l of m.layers) {
        if (this.layers.has(l.id)) throw new Error(`duplicate layer id ${l.id} (sources ${this.layers.get(l.id)!.sourceId} and ${m.id})`);
        this.layers.set(l.id, { ...l, sourceId: m.id });
      }
    }
  }

  layer(id: string): CatalogLayer | undefined {
    return this.layers.get(id);
  }
  layersOfSource(sourceId: string): CatalogLayer[] {
    return [...this.layers.values()].filter((l) => l.sourceId === sourceId);
  }
  /** Layers grouped by domain in the canonical domain order. */
  grouped(): { domain: (typeof DOMAINS)[number]; layers: CatalogLayer[] }[] {
    return DOMAINS.map((domain) => ({ domain, layers: [...this.layers.values()].filter((l) => l.domain === domain.id) })).filter((g) => g.layers.length > 0);
  }
}
