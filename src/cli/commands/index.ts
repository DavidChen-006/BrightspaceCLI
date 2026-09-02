/**
 * Command registry. Each command module exports `register(program, ctx)`; add one line here
 * per resource (auth, courses, assignments, ...). Order does not matter: schema sorts.
 */
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { register as registerSchema } from './schema.js';
import { register as registerVersion } from './version.js';

export type Registrar = (program: Command, ctx: CliContext) => void;

export const commands: readonly Registrar[] = [registerSchema, registerVersion];
