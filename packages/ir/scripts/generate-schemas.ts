import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSchemas } from '../src/node/schema-output';

const output = process.argv[2] ?? fileURLToPath(new URL('../contracts', import.meta.url));
const generated = await generateSchemas(path.resolve(output));
for (const filename of generated) console.log(filename);
