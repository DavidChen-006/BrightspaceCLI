/**
 * Command registry. Each command module exports `register(program, ctx)`; add one line here
 * per resource (auth, courses, assignments, ...). Order does not matter: schema sorts.
 */
import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { register as registerAssignments } from './assignments.js';
import { register as registerAuth } from './auth.js';
import { register as registerCourses } from './courses.js';
import { register as registerGrades } from './grades.js';
import { register as registerQuizzes } from './quizzes.js';
import { register as registerSchema } from './schema.js';
import { register as registerVersion } from './version.js';
import { register as registerWhoami } from './whoami.js';

export type Registrar = (program: Command, ctx: CliContext) => void;

export const commands: readonly Registrar[] = [
  registerAssignments,
  registerAuth,
  registerCourses,
  registerQuizzes,
  registerGrades,
  registerSchema,
  registerVersion,
  registerWhoami,
];
