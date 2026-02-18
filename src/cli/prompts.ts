/**
 * Interactive prompts for user decisions (enum/FK/scalar classification).
 * Uses @inquirer/prompts for the interactive UI.
 */

import { select, confirm, input } from '@inquirer/prompts';
import type { FieldKind, SharedComponents, SharedComponent } from '../types.js';
import type { Suspect } from '../value-registry.js';
import {
  findOverlappingComponents,
  generateComponentId,
  addComponent,
  mergeIntoComponent,
} from '../decisions.js';

// ── Format helpers ──────────────────────────────────────────────────

function formatValues(values: Set<string | number | boolean>, max: number = 10): string {
  const arr = Array.from(values).map((v) => {
    if (v === '') return '""';
    if (typeof v === 'string' && v.trim() === '' && v.length > 0) return JSON.stringify(v);
    return String(v);
  });
  if (arr.length <= max) return arr.join(', ');
  return arr.slice(0, max).join(', ') + ` ... (+${arr.length - max} more)`;
}

function formatComponent(id: string, comp: SharedComponent): string {
  const vals = comp.values.length > 0
    ? ` [${comp.values.slice(0, 5).map(String).join(', ')}${comp.values.length > 5 ? '...' : ''}]`
    : '';
  return `${id} (${comp.kind}, ${comp.baseType}${vals})`;
}

// ── Prompt for a single suspect ─────────────────────────────────────

export interface PromptResult {
  kind: FieldKind;
  componentId?: string;
  matchesExisting?: string;
}

export async function promptForSuspect(
  suspect: Suspect,
  components: SharedComponents,
  index: number,
  total: number,
): Promise<PromptResult> {
  const { keyName, entry } = suspect;
  const uniqueCount = entry.values.size;
  let totalOccurrences = 0;
  for (const c of entry.counts.values()) totalOccurrences += c;

  console.log(`\n[${ index + 1}/${total}] Field: ${keyName}`);
  console.log(`  Unique values: ${uniqueCount}  |  Total occurrences: ${totalOccurrences}`);
  console.log(`  Values: ${formatValues(entry.values)}`);

  // Check for overlapping existing components
  const valuesArr = Array.from(entry.values);
  const overlaps = findOverlappingComponents(components, valuesArr);

  if (overlaps.length > 0) {
    console.log(`  Overlapping components found:`);
    for (const o of overlaps.slice(0, 5)) {
      console.log(`    - ${formatComponent(o.id, o.component)} (${o.overlapCount} shared values)`);
    }
  }

  const kind = await select<FieldKind>({
    message: `What is "${keyName}"?`,
    choices: [
      { value: 'scalar' as const, name: 'Scalar (plain string/number/boolean)' },
      { value: 'enum' as const, name: 'Enum (closed set of known values)' },
      { value: 'fk' as const, name: 'Foreign Key (reference to another entity)' },
    ],
  });

  if (kind === 'scalar') {
    return { kind };
  }

  // For enum or FK, check if it matches an existing component
  if (overlaps.length > 0) {
    const matchExisting = await confirm({
      message: 'Does this match an existing component?',
      default: false,
    });

    if (matchExisting) {
      const choices = overlaps.map((o) => ({
        value: o.id,
        name: formatComponent(o.id, o.component),
      }));

      const matchId = await select({
        message: 'Which component does it match?',
        choices,
      });

      // If the value sets differ, offer to merge
      const matchComp = components[matchId]!;
      const matchSet = new Set(matchComp.values);
      const newValues = valuesArr.filter((v) => !matchSet.has(v));

      if (newValues.length > 0 && kind === 'enum') {
        const shouldMerge = await confirm({
          message: `Merge ${newValues.length} new value(s) into ${matchId}? (${newValues.map(String).join(', ')})`,
          default: true,
        });

        if (shouldMerge) {
          mergeIntoComponent(components, matchId, valuesArr);
        }
      }

      return { kind, matchesExisting: matchId };
    }
  }

  // Determine base type from values
  const baseType = inferBaseType(entry.values);

  // Create a new component
  const autoId = generateComponentId(components, keyName, kind);
  const componentId = await input({
    message: `Component name:`,
    default: autoId,
  });

  const component: SharedComponent = {
    kind,
    baseType,
    values: kind === 'enum' ? valuesArr.sort((a, b) => String(a).localeCompare(String(b))) : [],
    description: kind === 'enum' ? `Enum for ${keyName}` : `Reference: ${keyName}`,
  };

  addComponent(components, componentId, component);

  return { kind, componentId };
}

function inferBaseType(values: Set<string | number | boolean>): string {
  let hasString = false;
  let hasNumber = false;
  let hasInteger = true;

  for (const v of values) {
    if (typeof v === 'string') hasString = true;
    if (typeof v === 'number') {
      hasNumber = true;
      if (!Number.isInteger(v)) hasInteger = false;
    }
  }

  if (hasString) return 'string';
  if (hasNumber) return hasInteger ? 'integer' : 'number';
  return 'string';
}

// ── Batch review (edit decisions JSON) ──────────────────────────────

export async function promptBatchOrInteractive(): Promise<'interactive' | 'batch'> {
  return select({
    message: 'How would you like to review suspects?',
    choices: [
      { value: 'interactive' as const, name: 'Interactive (one at a time)' },
      { value: 'batch' as const, name: 'Batch (edit decisions.json manually, then continue)' },
    ],
  });
}

// ── Validation failure prompts ──────────────────────────────────────

export type ValidationAction = 'undo' | 'edit' | 'report' | 'retry' | 'force';

export async function promptValidationFailure(): Promise<ValidationAction> {
  return select({
    message: 'Validation failed. What would you like to do?',
    choices: [
      { value: 'undo' as const, name: 'Undo last decision' },
      { value: 'edit' as const, name: 'Edit decisions.json manually' },
      { value: 'report' as const, name: 'View full failure report' },
      { value: 'retry' as const, name: 'Retry validation' },
      { value: 'force' as const, name: 'Force emit anyway (not recommended)' },
    ],
  });
}

// ── Main menu ───────────────────────────────────────────────────────

export type MainAction = 'new' | 'resume' | 'exit';

export async function promptMainMenu(hasSessions: boolean): Promise<MainAction> {
  const choices: { value: MainAction; name: string }[] = [
    { value: 'new', name: 'New session (start recording)' },
  ];

  if (hasSessions) {
    choices.push({ value: 'resume', name: 'Resume existing session' });
  }

  choices.push({ value: 'exit', name: 'Exit' });

  return select({ message: 'What would you like to do?', choices });
}

export async function promptSelectSession(
  sessions: { name: string; step: string }[],
): Promise<string> {
  return select({
    message: 'Select a session to resume:',
    choices: sessions.map((s) => ({
      value: s.name,
      name: `${s.name} (step: ${s.step})`,
    })),
  });
}

export async function promptContinue(message: string): Promise<boolean> {
  return confirm({ message, default: true });
}
