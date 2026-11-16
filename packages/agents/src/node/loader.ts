import { z } from 'zod';
import { jsonCopy } from '@camery/methods';
import { dataDirectoryReader, parseDataJson } from '@camery/methods/node';
import { AgentError, AgentRegistry } from '../registry.js';
import type { AgentDefinition } from '../registry.js';

const FileDeclaration = z.object({ files: z.strictObject({ instructions: z.literal('instructions.md') }) }).catchall(z.json());

/** Load data only; the registry validates all definition fields and no executable path is accepted. */
export async function loadAgentDefinition(directory: string): Promise<AgentDefinition> {
  const reader = await dataDirectoryReader(directory);
  const read = reader.read.bind(reader);
  const parsed = FileDeclaration.safeParse(jsonCopy(parseDataJson(await read('agent.yaml'))));
  if (!parsed.success || Object.hasOwn(parsed.data, 'instructions')) throw new AgentError('INVALID_AGENT_FILE');
  const { files, ...definition } = parsed.data;
  const instructions = await read(files.instructions);
  const registry = new AgentRegistry();
  const pin = registry.register({ ...definition, instructions });
  return registry.resolve(pin);
}
