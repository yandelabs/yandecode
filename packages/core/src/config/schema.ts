import { z } from 'zod';

export const CONFIG_FILENAME = 'yandecode.json';
export const CONFIG_VERSION = 2;

/**
 * yandecode.json v2: the list of enabled modules plus one optional top-level section per module.
 * Sections are validated by the owning module (the core does not know module schemas).
 */
export const ConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    modules: z.array(z.string().min(1)),
  })
  .catchall(z.unknown());

export type YandeCodeConfig = z.infer<typeof ConfigSchema>;
