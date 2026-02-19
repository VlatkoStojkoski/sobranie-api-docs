#!/usr/bin/env node

/**
 * Sobranie.mk API Discovery CLI
 *
 * Interactive pipeline: Record → Extract → Infer → Collect Values →
 * Prompt User → Transform → Validate → Emit OpenAPI
 */

import { program, InvalidOptionArgumentError } from 'commander';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createSession,
  listSessions,
  loadProgress,
  saveProgress,
  updateStep,
  harPath,
  copyHarToSession,
  samplesDir,
  decisionsPath,
  suggestionsPath,
  openApiDir,
} from './session.js';
import {
  checkDevProxy,
  startRecording,
  waitForExit,
  finalizeRecording,
  devProxyInstallInstructions,
} from './recording.js';
import {
  promptMainMenu,
  promptSelectSession,
  promptContinue,
  promptForSuspect,
  promptBatchOrInteractive,
  promptValidationFailure,
} from './prompts.js';

import { extractFromHar } from '../extract.js';
import { inferSchemas } from '../infer.js';
import { buildValueRegistry, detectSuspects } from '../value-registry.js';
import {
  loadDecisions,
  saveDecisions,
  setFieldDecision,
  removeFieldDecision,
  removeComponent,
} from '../decisions.js';
import { transformSchemas } from '../schema-transform.js';
import { validateSchemas } from '../validate.js';
import { emitOpenApi } from '../emit.js';
import {
  collectRelationshipWarnings,
} from '../relationships.js';
import {
  loadSuggestionsState,
  saveSuggestionsState,
  applyUsageToMetrics,
} from '../llm/state.js';
import { createSuggestionClient } from '../llm/suggest.js';

import type {
  MethodCorpus,
  MethodSchema,
  Decisions,
  FieldDecision,
  SharedComponents,
} from '../types.js';
import type { Suspect } from '../value-registry.js';
import type {
  SuggestionAdvice,
  SuggestionCacheEntry,
  SuggestionsState,
} from '../llm/types.js';

type ReviewMode = 'interactive' | 'batch' | 'auto-scalar';
type ValidationFailureMode = 'prompt' | 'force';
type SuggestionsMode = 'on' | 'off';
type SuggestionsProvider = 'google';

interface RunSessionOptions {
  reviewMode?: ReviewMode;
  assumeBatchEdited: boolean;
  validationFailureMode: ValidationFailureMode;
  suggestionsMode: SuggestionsMode;
  suggestionsProvider: SuggestionsProvider;
  suggestionsModel: string;
  suggestionsConfidenceThreshold: number;
  suggestionsInputUsdPer1M?: number;
  suggestionsOutputUsdPer1M?: number;
}

interface PipelineCommandOptions {
  reviewMode?: ReviewMode;
  assumeEdited?: boolean;
  forceOnValidationFailure?: boolean;
  suggestions?: SuggestionsMode;
  suggestionsProvider?: SuggestionsProvider;
  suggestionsModel?: string;
  suggestionsConfidenceThreshold?: number;
  suggestionsInputUsdPer1M?: number;
  suggestionsOutputUsdPer1M?: number;
}

function resolveDecisionComponentId(decision: FieldDecision | undefined): string | undefined {
  if (!decision) return undefined;
  return decision.matchesExisting ?? decision.componentId;
}

function isComponentStillReferenced(
  decisions: Decisions,
  componentId: string,
): boolean {
  return Object.values(decisions.fields).some(
    (decision) => resolveDecisionComponentId(decision) === componentId,
  );
}

function removeLastOccurrence(values: string[], target: string): void {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] === target) {
      values.splice(i, 1);
      return;
    }
  }
}

interface SuggestionFetchResult {
  advice?: SuggestionAdvice;
  error?: string;
}

function suggestionTarget(advice: SuggestionAdvice): string | undefined {
  return advice.reuseComponentId ?? advice.targetFieldId ?? advice.newComponentName;
}

// ── Pipeline runner ─────────────────────────────────────────────────

async function runSession(
  sessionDir: string,
  options: RunSessionOptions = {
    assumeBatchEdited: false,
    validationFailureMode: 'prompt',
    suggestionsMode: 'off',
    suggestionsProvider: 'google',
    suggestionsModel: 'gemini-2.5-flash-lite',
    suggestionsConfidenceThreshold: 0.6,
  },
): Promise<void> {
  let progress = await loadProgress(sessionDir);

  console.log(`\nSession: ${sessionDir}`);
  console.log(`Current step: ${progress.step}\n`);

  // ── Step 1: Recording ──
  if (progress.step === 'recording') {
    await runRecording(sessionDir);
    progress = await updateStep(sessionDir, 'extracted');
  }

  // ── Step 2: Extract + Normalize ──
  let corpora: MethodCorpus[] = [];
  if (progress.step === 'extracted' || needsExtraction(progress.step)) {
    corpora = await runExtract(sessionDir);
    if (progress.step === 'extracted') {
      progress = await updateStep(sessionDir, 'inferred');
    }
  } else {
    corpora = await runExtract(sessionDir);
  }

  // ── Step 3: Infer ──
  let schemas: MethodSchema[] = [];
  if (progress.step === 'inferred' || needsInference(progress.step)) {
    schemas = await runInfer(corpora);
    if (progress.step === 'inferred') {
      progress = await updateStep(sessionDir, 'collecting_values');
    }
  }

  // ── Step 4: Value Registry ──
  let suspects: Suspect[] = [];
  if (progress.step === 'collecting_values') {
    const registry = buildValueRegistry(corpora);
    suspects = detectSuspects(registry);
    console.log(`\n  ${suspects.length} suspect fields detected\n`);
    progress = await updateStep(sessionDir, 'prompting');
  }

  // ── Step 5: Prompt User ──
  let { decisions, components } = await loadDecisions(decisionsPath(sessionDir));

  if (progress.step === 'prompting') {
    if (suspects.length === 0) {
      const registry = buildValueRegistry(corpora);
      suspects = detectSuspects(registry);
    }

    const startIndex = progress.nextPromptIndex ?? 0;
    const undecided = suspects.filter((s) => !(s.decisionKey in decisions.fields));

    if (undecided.length > 0) {
      const mode = options.reviewMode ?? await promptBatchOrInteractive();

      if (mode === 'interactive') {
        let suggestionState: SuggestionsState | null = null;
        let suggestionClient: ReturnType<typeof createSuggestionClient> | null = null;
        const pendingSuggestions = new Map<string, Promise<SuggestionFetchResult>>();
        const suggestionFilePath = suggestionsPath(sessionDir);
        const suggestionPricing = {
          inputUsdPer1M: options.suggestionsInputUsdPer1M,
          outputUsdPer1M: options.suggestionsOutputUsdPer1M,
        };

        if (options.suggestionsMode === 'on') {
          suggestionState = await loadSuggestionsState(
            suggestionFilePath,
            options.suggestionsModel,
            options.suggestionsConfidenceThreshold,
          );
          suggestionClient = createSuggestionClient({
            provider: options.suggestionsProvider,
            model: options.suggestionsModel,
          });

          const ready = suggestionClient.isReady();
          if (!ready.ok) {
            suggestionClient = null;
            console.log(`  LLM suggestions unavailable (${ready.reason}). Continuing manual mode.\n`);
          } else {
            console.log(
              `  LLM suggestions enabled (${options.suggestionsProvider}:${options.suggestionsModel}, threshold ${options.suggestionsConfidenceThreshold.toFixed(2)})\n`,
            );
          }
        }

        const persistSuggestionState = async (): Promise<void> => {
          if (!suggestionState) return;
          await saveSuggestionsState(suggestionFilePath, suggestionState);
        };

        const fetchSuggestion = async (suspect: Suspect): Promise<SuggestionFetchResult> => {
          if (!suggestionState || !suggestionClient) return {};
          const cached = suggestionState.suggestions[suspect.decisionKey];
          if (cached) {
            suggestionState.metrics.cacheHits++;
            await persistSuggestionState();
            return { advice: cached.advice };
          }

          const pending = pendingSuggestions.get(suspect.decisionKey);
          if (pending) return pending;

          suggestionState.metrics.attemptedCalls++;
          const promise = (async (): Promise<SuggestionFetchResult> => {
            const result = await suggestionClient!.suggest({
              suspect,
              components,
              decisions,
            });

            if (result.advice) {
              const entry: SuggestionCacheEntry = {
                model: options.suggestionsModel,
                createdAt: new Date().toISOString(),
                latencyMs: result.latencyMs,
                advice: result.advice,
                usage: result.usage,
              };
              suggestionState!.suggestions[suspect.decisionKey] = entry;
              suggestionState!.metrics.completedCalls++;
              applyUsageToMetrics(suggestionState!.metrics, result.usage, suggestionPricing);
            } else {
              suggestionState!.metrics.failedCalls++;
            }

            await persistSuggestionState();
            return { advice: result.advice, error: result.error };
          })();

          pendingSuggestions.set(suspect.decisionKey, promise);
          try {
            return await promise;
          } finally {
            pendingSuggestions.delete(suspect.decisionKey);
          }
        };

        const prefetchSuggestion = (suspect: Suspect | undefined): void => {
          if (!suspect || !suggestionClient || !suggestionState) return;
          if (suggestionState.suggestions[suspect.decisionKey]) return;
          if (pendingSuggestions.has(suspect.decisionKey)) return;
          void fetchSuggestion(suspect);
        };

        let i = startIndex;
        prefetchSuggestion(undecided[i]);
        while (i < undecided.length) {
          const suspect = undecided[i]!;
          const fetchedSuggestion = await fetchSuggestion(suspect);
          const shownSuggestion = fetchedSuggestion.advice &&
            fetchedSuggestion.advice.confidence >= options.suggestionsConfidenceThreshold
            ? fetchedSuggestion.advice
            : undefined;
          if (shownSuggestion && suggestionState) {
            suggestionState.metrics.suggestionsShown++;
            await persistSuggestionState();
          }

          prefetchSuggestion(undecided[i + 1]);

          const promptStartedAt = Date.now();
          const result = await promptForSuspect(
            suspect,
            components,
            i,
            undecided.length,
            shownSuggestion,
          );
          const decisionDurationMs = Date.now() - promptStartedAt;

          if (result.action === 'apply' && suggestionState) {
            suggestionState.metrics.decisionCount++;
            suggestionState.metrics.decisionTimeMsTotal += decisionDurationMs;
            if (shownSuggestion) {
              suggestionState.metrics.decisionsWithSuggestion++;
              if (result.kind === shownSuggestion.kind) {
                suggestionState.metrics.acceptedKind++;
              }
              const selectedTarget = result.matchesExisting ?? result.componentId;
              const suggestedTargetId = suggestionTarget(shownSuggestion);
              if (
                result.kind === shownSuggestion.kind &&
                (
                  (selectedTarget === undefined && suggestedTargetId === undefined)
                  || selectedTarget === suggestedTargetId
                )
              ) {
                suggestionState.metrics.acceptedExact++;
              }
            }
            await persistSuggestionState();
          }

          if (result.action === 'back') {
            if (i === 0) {
              console.log('  Already at the first field. Nothing to undo.\n');
              continue;
            }

            const previousIndex = i - 1;
            const previousSuspect = undecided[previousIndex]!;
            const previousKey = previousSuspect.decisionKey;
            const previousDecision = decisions.fields[previousKey];

            if (!previousDecision) {
              console.log(`  No saved decision found for previous field (${previousSuspect.keyName}).\n`);
              i = previousIndex;
              continue;
            }

            const componentId = resolveDecisionComponentId(previousDecision);
            removeFieldDecision(decisions, previousKey);

            if (
              componentId &&
              previousDecision.componentId &&
              !previousDecision.matchesExisting &&
              !isComponentStillReferenced(decisions, componentId)
            ) {
              removeComponent(components, componentId);
            }

            removeLastOccurrence(progress.undoStack, previousKey);
            progress.nextPromptIndex = previousIndex;
            await saveProgress(sessionDir, progress);
            await saveDecisions(decisionsPath(sessionDir), decisions, components);

            console.log(
              `  Undid previous decision. Returning to ${previousSuspect.methodName} [${previousSuspect.direction}] ${previousSuspect.keyName}.\n`,
            );

            i = previousIndex;
            continue;
          }

          setFieldDecision(decisions, suspect.decisionKey, {
            kind: result.kind!,
            componentId: result.componentId,
            matchesExisting: result.matchesExisting,
          });

          progress.undoStack.push(suspect.decisionKey);
          progress.nextPromptIndex = i + 1;
          await saveProgress(sessionDir, progress);
          await saveDecisions(decisionsPath(sessionDir), decisions, components);
          i++;
        }
      } else if (mode === 'auto-scalar') {
        for (const suspect of undecided) {
          setFieldDecision(decisions, suspect.decisionKey, { kind: 'scalar' });
        }
        progress.nextPromptIndex = undecided.length;
        await saveProgress(sessionDir, progress);
        await saveDecisions(decisionsPath(sessionDir), decisions, components);
      } else {
        // Batch mode: pre-populate fields with scalar default + values reference, save, let user edit
        for (const s of undecided) {
          if (!(s.decisionKey in decisions.fields)) {
            setFieldDecision(decisions, s.decisionKey, { kind: 'scalar' });
          }
        }
        const suspectReference: Record<string, {
          methodName: string;
          direction: 'request' | 'response';
          parentPath: string;
          keyName: string;
          values: (string | number | boolean)[];
          uniqueCount: number;
          totalOccurrences: number;
        }> = {};
        for (const s of undecided) {
          let totalOccurrences = 0;
          for (const c of s.entry.counts.values()) totalOccurrences += c;
          suspectReference[s.decisionKey] = {
            methodName: s.methodName,
            direction: s.direction,
            parentPath: s.parentPath,
            keyName: s.keyName,
            values: Array.from(s.entry.values),
            uniqueCount: s.entry.values.size,
            totalOccurrences,
          };
        }
        await saveDecisions(decisionsPath(sessionDir), decisions, components, suspectReference);
        console.log(`\n  Decisions file: ${decisionsPath(sessionDir)}`);
        console.log('  Pre-filled with scalar defaults + _suspectValues for context.');
        console.log('  Edit each field: choose enum/fk/foreign_value/index_source/value_source and set componentId.');
        console.log('  Then resume this session to continue.\n');

        const ready = options.assumeBatchEdited || await promptContinue('Have you finished editing decisions.json?');
        if (!ready) {
          console.log('  Session saved. Resume later to continue.\n');
          return;
        }

        // Reload after manual edit
        const reloaded = await loadDecisions(decisionsPath(sessionDir));
        decisions = reloaded.decisions;
        components = reloaded.components;
      }
    }

    await saveDecisions(decisionsPath(sessionDir), decisions, components);
    progress = await updateStep(sessionDir, 'transformed');
  }

  // ── Step 6: Transform ──
  if (progress.step === 'transformed' || progress.step === 'validation_failed') {
    // Reload decisions in case we're resuming after edits
    const reloaded = await loadDecisions(decisionsPath(sessionDir));
    decisions = reloaded.decisions;
    components = reloaded.components;

    const relationshipWarnings = collectRelationshipWarnings(decisions);
    progress.relationshipWarnings = relationshipWarnings;
    await saveProgress(sessionDir, progress);

    // Re-extract and re-infer if needed (we need corpora and schemas)
    if (corpora.length === 0) corpora = await runExtract(sessionDir);
    if (schemas.length === 0) schemas = await runInfer(corpora);

    const transformedSchemas = transformSchemas(schemas, decisions, components);

    // ── Step 7: Validate ──
    console.log('\nValidating (every sample must pass)...');
    const validation = validateSchemas(corpora, transformedSchemas, components);

    for (const r of validation.results) {
      const fails = r.requestFailures.length + r.responseFailures.length;
      const icon = r.pass ? '✓' : '✗';
      console.log(`  ${icon} ${r.methodName}: ${r.totalSamples} samples, ${fails} failures`);
    }

    if (!validation.allPass) {
      progress.validationFailures = validation.failureRecords;
      progress.step = 'validation_failed';
      await saveProgress(sessionDir, progress);

      if (options.validationFailureMode === 'force') {
        console.log('  Forcing emit despite validation failures (--force-on-validation-failure).\n');
      } else {
        // Validation failure loop
        let resolved = false;
        while (!resolved) {
          const action = await promptValidationFailure();

          switch (action) {
            case 'undo': {
            const lastKey = progress.undoStack.pop();
            if (lastKey) {
              const dec = decisions.fields[lastKey];
              const componentId = resolveDecisionComponentId(dec);
              removeFieldDecision(decisions, lastKey);
              if (
                componentId &&
                dec?.componentId &&
                !dec.matchesExisting &&
                !isComponentStillReferenced(decisions, componentId)
              ) {
                removeComponent(components, componentId);
              }
              await saveDecisions(decisionsPath(sessionDir), decisions, components);
              await saveProgress(sessionDir, progress);
                console.log(`  Undid decision for "${lastKey}". Re-validating...`);

                const retransformed = transformSchemas(schemas, decisions, components);
                const revalidation = validateSchemas(corpora, retransformed, components);

                if (revalidation.allPass) {
                  console.log('  All validations pass now!\n');
                  schemas = retransformed as MethodSchema[];
                  resolved = true;
                } else {
                  console.log('  Still has failures.\n');
                }
              } else {
                console.log('  No more decisions to undo.\n');
              }
              break;
            }
            case 'edit': {
              console.log(`\n  Edit: ${decisionsPath(sessionDir)}`);
              const ready = await promptContinue('Done editing?');
              if (ready) {
                const reloaded = await loadDecisions(decisionsPath(sessionDir));
                decisions = reloaded.decisions;
                components = reloaded.components;
              }
              break;
            }
            case 'report': {
              for (const r of validation.results) {
                if (!r.pass) {
                  console.log(`\n  ${r.methodName}:`);
                  for (const f of r.responseFailures.slice(0, 5)) {
                    console.log(`    res[${f.sampleId}]: ${f.errors.slice(0, 3).join('; ')}`);
                  }
                  for (const f of r.requestFailures.slice(0, 5)) {
                    console.log(`    req[${f.sampleId}]: ${f.errors.slice(0, 3).join('; ')}`);
                  }
                }
              }
              break;
            }
            case 'retry': {
              const retransformed = transformSchemas(schemas, decisions, components);
              const revalidation = validateSchemas(corpora, retransformed, components);

              if (revalidation.allPass) {
                console.log('  All validations pass!\n');
                schemas = retransformed as MethodSchema[];
                resolved = true;
              } else {
                console.log('  Still has failures.\n');
              }
              break;
            }
            case 'force': {
              console.log('  Forcing emit despite validation failures.\n');
              resolved = true;
              break;
            }
          }
        }
      }

      // Use transformed schemas for emit
      schemas = transformSchemas(schemas, decisions, components);
    } else {
      schemas = transformedSchemas;
    }

    progress = await updateStep(sessionDir, 'validated');
  }

  // ── Step 8: Emit ──
  if (progress.step === 'validated') {
    // Reload everything for emit
    if (schemas.length === 0) {
      if (corpora.length === 0) corpora = await runExtract(sessionDir);
      schemas = await runInfer(corpora);
      const reloaded = await loadDecisions(decisionsPath(sessionDir));
      schemas = transformSchemas(schemas, reloaded.decisions, reloaded.components);
      components = reloaded.components;
    }

    console.log('\nEmitting OpenAPI spec...');
    const outDir = openApiDir(sessionDir);
    const { rootPath, fileCount } = await emitOpenApi(schemas, components, outDir);
    console.log(`  Root: ${rootPath}`);
    console.log(`  Files written: ${fileCount}\n`);

    progress = await updateStep(sessionDir, 'emitted');
  }

  {
    const finalDecisions = await loadDecisions(decisionsPath(sessionDir));
    const warnings = collectRelationshipWarnings(finalDecisions.decisions);
    progress = await loadProgress(sessionDir);
    progress.relationshipWarnings = warnings;
    await saveProgress(sessionDir, progress);
  }

  const latestProgress = await loadProgress(sessionDir);
  if ((latestProgress.relationshipWarnings?.length ?? 0) > 0) {
    console.log('Relationship warnings:');
    for (const warning of latestProgress.relationshipWarnings!) {
      console.log(`  - ${warning}`);
    }
    console.log();
  }

  if (options.suggestionsMode === 'on') {
    const state = await loadSuggestionsState(
      suggestionsPath(sessionDir),
      options.suggestionsModel,
      options.suggestionsConfidenceThreshold,
    );
    const metrics = state.metrics;
    const acceptanceRate = metrics.decisionsWithSuggestion > 0
      ? (metrics.acceptedKind / metrics.decisionsWithSuggestion) * 100
      : 0;
    const avgDecisionMs = metrics.decisionCount > 0
      ? metrics.decisionTimeMsTotal / metrics.decisionCount
      : 0;

    console.log('Suggestion metrics:');
    console.log(`  Calls: ${metrics.completedCalls}/${metrics.attemptedCalls} (cache hits: ${metrics.cacheHits}, failed: ${metrics.failedCalls})`);
    console.log(`  Tokens: in ${metrics.inputTokens}, out ${metrics.outputTokens}, total ${metrics.totalTokens}`);
    console.log(`  Estimated cost (USD): ${metrics.estimatedCostUsd.toFixed(6)}`);
    console.log(`  Acceptance (kind match): ${acceptanceRate.toFixed(1)}%`);
    console.log(`  Avg decision time: ${avgDecisionMs.toFixed(0)} ms`);
    console.log();
  }

  // ── Done ──
  console.log('═══════════════════════════════════════════');
  console.log(`  Session   : ${sessionDir}`);
  console.log(`  Status    : ${latestProgress.step}`);
  console.log(`  Output    : ${openApiDir(sessionDir)}/`);
  console.log('═══════════════════════════════════════════\n');
}

// ── Sub-steps ───────────────────────────────────────────────────────

async function runRecording(sessionDir: string): Promise<void> {
  const hasDevProxy = await checkDevProxy();
  if (!hasDevProxy) {
    console.error(devProxyInstallInstructions());
    process.exit(1);
  }

  console.log('Starting Dev Proxy recording...');
  console.log('  Browse https://www.sobranie.mk to capture traffic.');
  console.log('  Press Ctrl+C in the proxy window when done.\n');

  const { process: proc } = startRecording(sessionDir);
  await waitForExit(proc);

  console.log('\nRecording stopped. Looking for HAR file...');
  const success = await finalizeRecording(sessionDir);

  if (!success) {
    console.error('No HAR file found after recording. Check Dev Proxy output.');
    process.exit(1);
  }

  console.log('  HAR saved to session.\n');
}

async function runExtract(sessionDir: string): Promise<MethodCorpus[]> {
  console.log('Extracting from HAR...');
  const har = harPath(sessionDir);
  const corpora = await extractFromHar(har);
  const totalSamples = corpora.reduce((s, c) => s + c.samples.length, 0);
  console.log(`  ${corpora.length} methods, ${totalSamples} total samples`);

  if (corpora.length === 0) {
    console.error('No methods found. Check the HAR contains POST /Routing/MakePostRequest entries.');
    process.exit(1);
  }

  // Write samples
  const sDir = samplesDir(sessionDir);
  for (const corpus of corpora) {
    const reqDir = join(sDir, corpus.methodName, 'requests');
    const resDir = join(sDir, corpus.methodName, 'responses');
    await mkdir(reqDir, { recursive: true });
    await mkdir(resDir, { recursive: true });
    for (const sample of corpus.samples) {
      await writeFile(
        join(reqDir, `${sample.id}.json`),
        JSON.stringify(sample.request, null, 2),
        'utf-8',
      );
      await writeFile(
        join(resDir, `${sample.id}.json`),
        JSON.stringify(sample.response, null, 2),
        'utf-8',
      );
    }
  }
  console.log(`  Samples written to ${sDir}/\n`);

  return corpora;
}

async function runInfer(corpora: MethodCorpus[]): Promise<MethodSchema[]> {
  console.log('Inferring schemas [quicktype]...');
  const schemas = await inferSchemas(corpora);
  console.log(`  ${schemas.length} method schemas inferred\n`);
  return schemas;
}

function needsExtraction(step: string): boolean {
  return ['inferred', 'collecting_values', 'prompting', 'transformed', 'validation_failed', 'validated'].includes(step);
}

function needsInference(step: string): boolean {
  return ['collecting_values', 'prompting', 'transformed', 'validation_failed', 'validated'].includes(step);
}

function parseReviewMode(value: string): ReviewMode {
  if (value === 'interactive' || value === 'batch' || value === 'auto-scalar') {
    return value;
  }
  throw new InvalidOptionArgumentError(
    'review-mode must be one of: interactive, batch, auto-scalar',
  );
}

function parseStartAction(value: string): 'new' | 'resume' {
  if (value === 'new' || value === 'resume') return value;
  throw new InvalidOptionArgumentError('action must be one of: new, resume');
}

function parseSuggestionsMode(value: string): SuggestionsMode {
  if (value === 'on' || value === 'off') return value;
  throw new InvalidOptionArgumentError('suggestions must be one of: on, off');
}

function parseSuggestionsProvider(value: string): SuggestionsProvider {
  if (value === 'google') return value;
  throw new InvalidOptionArgumentError('suggestions-provider must be one of: google');
}

function parseConfidenceThreshold(value: string): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  throw new InvalidOptionArgumentError('suggestions-confidence-threshold must be between 0 and 1');
}

function parseUsdPer1M(value: string): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  throw new InvalidOptionArgumentError('cost-per-1m options must be non-negative numbers');
}

function configureSessionsDir(sessionsDir?: string): void {
  if (!sessionsDir) return;
  process.env.SOBRANIE_SESSIONS_DIR = resolve(process.cwd(), sessionsDir);
}

function toRunSessionOptions(options: PipelineCommandOptions): RunSessionOptions {
  return {
    reviewMode: options.reviewMode,
    assumeBatchEdited: options.assumeEdited ?? false,
    validationFailureMode: options.forceOnValidationFailure ? 'force' : 'prompt',
    suggestionsMode: options.suggestions ?? 'off',
    suggestionsProvider: options.suggestionsProvider ?? 'google',
    suggestionsModel: options.suggestionsModel ?? 'gemini-2.5-flash-lite',
    suggestionsConfidenceThreshold: options.suggestionsConfidenceThreshold ?? 0.6,
    suggestionsInputUsdPer1M: options.suggestionsInputUsdPer1M,
    suggestionsOutputUsdPer1M: options.suggestionsOutputUsdPer1M,
  };
}

async function createSessionForCommand(har?: string): Promise<string> {
  const sessionDir = await createSession();
  console.log(`\nCreated session: ${sessionDir}\n`);

  if (!har) return sessionDir;

  const harPathResolved = resolve(process.cwd(), har);
  try {
    await access(harPathResolved);
  } catch {
    console.error(`HAR file not found: ${har}\n`);
    process.exit(1);
  }

  await copyHarToSession(harPathResolved, sessionDir);
  await saveProgress(sessionDir, { step: 'extracted', undoStack: [] });
  console.log(`Using HAR: ${har}\n`);

  return sessionDir;
}

function addPipelineOptions<T extends import('commander').Command>(command: T): T {
  return command
    .option(
      '--review-mode <mode>',
      'Suspect review mode: interactive | batch | auto-scalar',
      parseReviewMode,
    )
    .option(
      '--assume-edited',
      'In batch mode, skip confirmation prompt and continue immediately',
      false,
    )
    .option(
      '--force-on-validation-failure',
      'If validation fails, force emit without opening the interactive retry menu',
      false,
    )
    .option(
      '--suggestions <mode>',
      'LLM suggestions mode: on | off',
      parseSuggestionsMode,
      'off',
    )
    .option(
      '--suggestions-provider <provider>',
      'Suggestion provider (currently: google)',
      parseSuggestionsProvider,
      'google',
    )
    .option(
      '--suggestions-model <model>',
      'Suggestion model id',
      'gemini-2.5-flash-lite',
    )
    .option(
      '--suggestions-confidence-threshold <n>',
      'Show suggestions only when confidence >= n (0..1)',
      parseConfidenceThreshold,
      0.6,
    )
    .option(
      '--suggestions-input-usd-per-1m <usd>',
      'Estimated input token cost per 1M tokens (for metrics)',
      parseUsdPer1M,
    )
    .option(
      '--suggestions-output-usd-per-1m <usd>',
      'Estimated output token cost per 1M tokens (for metrics)',
      parseUsdPer1M,
    );
}

// ── CLI setup ───────────────────────────────────────────────────────

program
  .name('sobranie-cli')
  .description('Sobranie.mk API Discovery — HAR to OpenAPI pipeline')
  .version('0.2.0')
  .option('--sessions-dir <path>', 'Override sessions directory (default: ./sessions)');

addPipelineOptions(
  program
    .command('start')
  .description('Interactive session (new or resume)')
  .option('--action <action>', 'Skip menu: new | resume', parseStartAction)
  .option('--session <name>', 'Session name to resume')
  .option('--har <path>', 'Use HAR when action=new (skips recording)')
  .option('--latest', 'Resume the newest session when action=resume', false)
  .action(async function (
    this: { opts: () => PipelineCommandOptions & {
      action?: 'new' | 'resume';
      session?: string;
      har?: string;
      latest?: boolean;
    } },
  ) {
    configureSessionsDir(program.opts<{ sessionsDir?: string }>().sessionsDir);
    const options = this.opts();
    const sessions = await listSessions();
    const runOptions = toRunSessionOptions(options);

    const action = options.action ?? await promptMainMenu(sessions.length > 0);

    switch (action) {
      case 'new': {
        const sessionDir = await createSessionForCommand(options.har);
        await runSession(sessionDir, runOptions);
        break;
      }
      case 'resume': {
        if (sessions.length === 0) {
          console.log('No sessions found. Run `sobranie-cli new` to start.\n');
          return;
        }

        let sessionDir: string | undefined;

        if (options.session) {
          const session = sessions.find((s) => s.name === options.session);
          if (!session) {
            console.error(`Session "${options.session}" not found.\n`);
            process.exitCode = 1;
            return;
          }
          sessionDir = session.path;
        } else if (options.latest) {
          sessionDir = sessions[0]?.path;
        } else {
          const selected = await promptSelectSession(
            sessions.map((s) => ({ name: s.name, step: s.step })),
          );
          const session = sessions.find((s) => s.name === selected);
          sessionDir = session?.path;
        }

        if (sessionDir) {
          await runSession(sessionDir, runOptions);
        }
        break;
      }
      case 'exit': {
        console.log('Bye!\n');
        break;
      }
    }
  }),
);

addPipelineOptions(
  program
    .command('new')
  .description('Create a new session and start the pipeline')
  .option('--har <path>', 'Use an existing HAR file instead of recording')
  .action(async function (this: { opts: () => PipelineCommandOptions & { har?: string } }) {
    configureSessionsDir(program.opts<{ sessionsDir?: string }>().sessionsDir);
    const options = this.opts();
    const sessionDir = await createSessionForCommand(options.har);
    await runSession(sessionDir, toRunSessionOptions(options));
  }),
);

addPipelineOptions(
  program
    .command('resume [session]')
  .description('Resume an existing session')
  .option('--latest', 'Resume the newest session (no selection prompt)', false)
  .action(async function (
    this: { opts: () => PipelineCommandOptions & { latest?: boolean } },
    sessionName?: string,
  ) {
    configureSessionsDir(program.opts<{ sessionsDir?: string }>().sessionsDir);
    const options = this.opts();
    const sessions = await listSessions();

    if (sessions.length === 0) {
      console.log('No sessions found. Run `sobranie-cli new` to start.\n');
      return;
    }

    let sessionDir: string;

    if (sessionName) {
      const session = sessions.find((s) => s.name === sessionName);
      if (!session) {
        console.error(`Session "${sessionName}" not found.\n`);
        process.exitCode = 1;
        return;
      }
      sessionDir = session.path;
    } else if (options.latest) {
      sessionDir = sessions[0]!.path;
    } else {
      const selected = await promptSelectSession(
        sessions.map((s) => ({ name: s.name, step: s.step })),
      );
      const session = sessions.find((s) => s.name === selected);
      if (!session) return;
      sessionDir = session.path;
    }

    await runSession(sessionDir, toRunSessionOptions(options));
  }),
);

program
  .command('sessions')
  .description('List all sessions')
  .action(async () => {
    configureSessionsDir(program.opts<{ sessionsDir?: string }>().sessionsDir);
    const sessions = await listSessions();

    if (sessions.length === 0) {
      console.log('No sessions found.\n');
      return;
    }

    console.log('\nSessions:\n');
    for (const s of sessions) {
      console.log(`  ${s.name}  [${s.step}]`);
    }
    console.log();
  });

program.parse();
