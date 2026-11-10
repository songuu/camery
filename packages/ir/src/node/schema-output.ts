import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toChangeSetJsonSchema, toJsonSchema } from '../schema';

export async function generateSchemas(outputDirectory: string): Promise<string[]> {
  await mkdir(outputDirectory, { recursive: true });
  const filename = path.join(outputDirectory, 'storyboard-package.schema.json');
  await writeFile(filename, JSON.stringify(toJsonSchema(), null, 2) + '\n', 'utf8');
  const changeFilename = path.join(outputDirectory, 'changeset.schema.json');
  await writeFile(changeFilename, JSON.stringify(toChangeSetJsonSchema(), null, 2) + '\n', 'utf8');
  return [filename, changeFilename];
}
