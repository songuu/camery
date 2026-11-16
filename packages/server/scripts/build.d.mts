import type { BuildResult } from 'esbuild';
export function buildServer(outputDirectory?: string): Promise<BuildResult<{ metafile: true }>>;
