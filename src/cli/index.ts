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
  llmUsagePath,
  promptLogPath,
  llmLogPath,
  pipelineLogPath,
  openApiDir,
  setSessionsDirOverride,
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
  setPromptTraceLogger,
  setPromptReloadHandler,
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
  saveSessionUsageSnapshot,
  applyUsageToMetrics,
} from '../llm/state.js';
import { createSuggestionClient } from '../llm/suggest.js';
import { appendJsonLine, timestampedEvent } from '../logging.js';

import type {
  MethodCorpus,
  MethodSchema,
  Decisions,
  FieldDecision,
  FieldKind,
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

function decisionFieldIds(decision: FieldDecision | undefined): string[] {
  if (!decision) return [];
  const out: string[] = [];
  if (decision.sourceFieldId) out.push(decision.sourceFieldId);
  if (decision.referenceFieldId) out.push(decision.referenceFieldId);
  return out;
}

function isComponentStillReferenced(
  decisions: Decisions,
  componentId: string,
): boolean {
  return Object.values(decisions.fields)
    .some((decision) => decisionFieldIds(decision).includes(componentId));
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

const SUGGESTION_PREFETCH_AHEAD = 2;

function compareSuspectsForPrompting(a: Suspect, b: Suspect): number {
  return (
    a.methodName.localeCompare(b.methodName)
    || a.direction.localeCompare(b.direction)
    || a.parentPath.localeCompare(b.parentPath)
    || a.keyName.localeCompare(b.keyName)
    || a.decisionKey.localeCompare(b.decisionKey)
  );
}

function sortSuspectsForPrompting(suspects: Suspect[]): Suspect[] {
  return [...suspects].sort(compareSuspectsForPrompting);
}

function responseSuspectsOnly(suspects: Suspect[]): Suspect[] {
  return suspects.filter((suspect) => suspect.direction === 'response');
}

function suggestedKind(advice: SuggestionAdvice | undefined): FieldKind | undefined {
  if (!advice) return undefined;
  const hasSource = advice.source.recommended === 'yes';
  const hasReference = advice.reference.recommended === 'yes';
  if (hasSource && hasReference) return 'source_reference';
  if (hasSource) return 'source';
  if (hasReference) return 'reference';
  return 'scalar';
}

function suggestionTarget(advice: SuggestionAdvice | undefined): string | undefined {
  if (!advice) return undefined;
  if (advice.source.recommended === 'yes') return advice.source.yesPayload.fieldId;
  if (advice.reference.recommended === 'yes') return advice.reference.yesPayload.fieldId;
  return undefined;
}

function parseModelFieldId(value: string | undefined): { modelName: string; fieldName: string } | null {
  if (!value) return null;
  const lastDot = value.lastIndexOf('.');
  if (lastDot <= 0 || lastDot >= value.length - 1) return null;
  const modelName = value.slice(0, lastDot).trim();
  const fieldName = value.slice(lastDot + 1).trim();
  if (!modelName || !fieldName) return null;
  return { modelName, fieldName };
}

function inferPrimitiveTypes(values: Set<string | number | boolean>): string[] {
  let hasString = false;
  let hasNumber = false;
  let hasInteger = true;
  let hasBoolean = false;
  for (const value of values) {
    if (typeof value === 'string') hasString = true;
    if (typeof value === 'boolean') hasBoolean = true;
    if (typeof value === 'number') {
      hasNumber = true;
      if (!Number.isInteger(value)) hasInteger = false;
    }
  }
  const out: string[] = [];
  if (hasString) out.push('string');
  if (hasNumber) out.push(hasInteger ? 'integer' : 'number');
  if (hasBoolean) out.push('boolean');
  return out;
}

function componentTypes(component: { baseType: string; baseTypes?: string[] }): string[] {
  if (component.baseTypes && component.baseTypes.length > 0) {
    return Array.from(new Set(component.baseTypes));
  }
  if (component.baseType && component.baseType !== 'mixed') return [component.baseType];
  return [];
}

function hasTypeConflict(
  existing: { baseType: string; baseTypes?: string[] },
  inferred: string[],
): boolean {
  const existingSet = new Set(componentTypes(existing));
  const inferredSet = new Set(inferred);
  if (existingSet.size === 0 || inferredSet.size === 0) return false;
  if (existingSet.size !== inferredSet.size) return true;
  for (const t of existingSet) {
    if (!inferredSet.has(t)) return true;
  }
  return false;
}

function kindFromPromptResult(result: {
  kind?: FieldKind;
  sourceFieldId?: string;
  referenceFieldId?: string;
}): FieldKind {
  if (result.kind) return result.kind;
  const hasSource = !!result.sourceFieldId;
  const hasReference = !!result.referenceFieldId;
  if (hasSource && hasReference) return 'source_reference';
  if (hasSource) return 'source';
  if (hasReference) return 'reference';
  return 'scalar';
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decisionsFingerprint(
  decisions: Decisions,
  components: SharedComponents,
): string {
  return stableStringify({
    fields: decisions.fields,
    components,
  });
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
  let decisions: Decisions = { fields: {} };
  let components: SharedComponents = {};
  let decisionsLoaded = false;
  const pipelineLog = pipelineLogPath(sessionDir);
  const promptsLog = promptLogPath(sessionDir);
  const llmLog = llmLogPath(sessionDir);

  const logPipeline = async (
    event: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    await appendJsonLine(pipelineLog, timestampedEvent(event, payload));
  };

  const logLlm = async (
    event: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    await appendJsonLine(llmLog, timestampedEvent(event, payload));
  };

  setPromptTraceLogger(async (event) => {
    await appendJsonLine(promptsLog, {
      timestamp: event.timestamp,
      promptType: event.promptType,
      context: event.context,
      message: event.message,
      response: event.response,
      choices: event.choices,
    });
  });
  const stopPromptTracing = (): void => {
    setPromptTraceLogger(null);
  };

  const reloadDecisionsFromDisk = async (reason: string): Promise<void> => {
    if (!decisionsLoaded) {
      await logPipeline('decisions.reload.skip', { reason, because: 'not_loaded_yet' });
      return;
    }
    const reloaded = await loadDecisions(decisionsPath(sessionDir));
    decisions = reloaded.decisions;
    components = reloaded.components;
    await logPipeline('decisions.reload', {
      reason,
      decided: Object.keys(decisions.fields).length,
      components: Object.keys(components).length,
    });
    console.log('\n  Reloaded decisions.json. Restarting current prompt.\n');
  };

  setPromptReloadHandler(async () => {
    await reloadDecisionsFromDisk('ctrl+r');
  });

  await logPipeline('session.start', {
    sessionDir,
    step: progress.step,
    options,
  });

  console.log(`\nSession: ${sessionDir}`);
  console.log(`Current step: ${progress.step}\n`);
  await logPipeline('session.state', { step: progress.step });

  // ── Step 1: Recording ──
  if (progress.step === 'recording') {
    await logPipeline('step.recording.start');
    await runRecording(sessionDir);
    progress = await updateStep(sessionDir, 'extracted');
    await logPipeline('step.recording.done', { nextStep: progress.step });
  }

  // ── Step 2: Extract + Normalize ──
  let corpora: MethodCorpus[] = [];
  if (progress.step === 'extracted' || needsExtraction(progress.step)) {
    await logPipeline('step.extract.start');
    corpora = await runExtract(sessionDir);
    await logPipeline('step.extract.done', {
      methods: corpora.length,
      samples: corpora.reduce((s, c) => s + c.samples.length, 0),
    });
    if (progress.step === 'extracted') {
      progress = await updateStep(sessionDir, 'inferred');
      await logPipeline('step.transition', { nextStep: progress.step });
    }
  } else {
    corpora = await runExtract(sessionDir);
  }

  // ── Step 3: Infer ──
  let schemas: MethodSchema[] = [];
  if (progress.step === 'inferred' || needsInference(progress.step)) {
    await logPipeline('step.infer.start');
    schemas = await runInfer(corpora);
    await logPipeline('step.infer.done', { methods: schemas.length });
    if (progress.step === 'inferred') {
      progress = await updateStep(sessionDir, 'collecting_values');
      await logPipeline('step.transition', { nextStep: progress.step });
    }
  }

  // ── Step 4: Value Registry ──
  let suspects: Suspect[] = [];
  if (progress.step === 'collecting_values') {
    const registry = buildValueRegistry(corpora);
    suspects = sortSuspectsForPrompting(responseSuspectsOnly(detectSuspects(registry)));
    console.log(`\n  ${suspects.length} response-side suspect fields detected\n`);
    await logPipeline('step.collect_values.done', { suspects: suspects.length });
    progress = await updateStep(sessionDir, 'prompting');
    await logPipeline('step.transition', { nextStep: progress.step });
  }

  // ── Step 5: Prompt User ──
  {
    const loaded = await loadDecisions(decisionsPath(sessionDir));
    decisions = loaded.decisions;
    components = loaded.components;
    decisionsLoaded = true;
  }

  if (progress.step === 'prompting') {
    if (suspects.length === 0) {
      const registry = buildValueRegistry(corpora);
      suspects = sortSuspectsForPrompting(responseSuspectsOnly(detectSuspects(registry)));
    }

    const startIndex = progress.nextPromptIndex ?? 0;
    const undecided = sortSuspectsForPrompting(
      suspects.filter((s) => !(s.decisionKey in decisions.fields)),
    );

    if (undecided.length > 0) {
      const mode = options.reviewMode ?? await promptBatchOrInteractive();
      await logPipeline('prompting.mode', { mode, undecided: undecided.length });

      if (mode === 'interactive') {
        console.log('  Tip: Press Ctrl+R at any prompt to reload decisions.json and restart that prompt.\n');
        let suggestionState: SuggestionsState | null = null;
        let suggestionClient: ReturnType<typeof createSuggestionClient> | null = null;
        const pendingSuggestions = new Map<string, Promise<SuggestionFetchResult>>();
        const suggestionFilePath = suggestionsPath(sessionDir);
        const usageFilePath = llmUsagePath(sessionDir);
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
              `  LLM suggestions enabled (${options.suggestionsProvider}:${options.suggestionsModel})\n`,
            );
          }
        }

        const persistSuggestionState = async (): Promise<void> => {
          if (!suggestionState) return;
          await saveSuggestionsState(suggestionFilePath, suggestionState);
          await saveSessionUsageSnapshot(usageFilePath, suggestionState, suggestionPricing);
        };

        const fetchSuggestion = async (suspect: Suspect): Promise<SuggestionFetchResult> => {
          if (!suggestionState || !suggestionClient) return {};
          const cached = suggestionState.suggestions[suspect.decisionKey];
          if (cached) {
            suggestionState.metrics.cacheHits++;
            await persistSuggestionState();
            const cachedKind = suggestedKind(cached.advice);
            await logLlm('suggestion.cache_hit', {
              decisionKey: suspect.decisionKey,
              kind: cachedKind,
            });
            return { advice: cached.advice };
          }

          const pending = pendingSuggestions.get(suspect.decisionKey);
          if (pending) return pending;

          // Reserve the key immediately so concurrent callers share one in-flight request.
          const promise = (async (): Promise<SuggestionFetchResult> => {
            suggestionState!.metrics.attemptedCalls++;
            await logLlm('suggestion.request', {
              decisionKey: suspect.decisionKey,
              methodName: suspect.methodName,
              direction: suspect.direction,
              parentPath: suspect.parentPath,
              keyName: suspect.keyName,
            });
            const result = await suggestionClient!.suggest({
              suspect,
              components,
              decisions,
              suspects,
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
              await logLlm('suggestion.response', {
                decisionKey: suspect.decisionKey,
                prompt: result.prompt,
                response: result.rawResponse ?? result.advice,
                advice: result.advice,
                usage: result.usage,
                latencyMs: result.latencyMs,
                runningMetrics: suggestionState!.metrics,
              });
            } else {
              suggestionState!.metrics.failedCalls++;
              await logLlm('suggestion.error', {
                decisionKey: suspect.decisionKey,
                prompt: result.prompt,
                error: result.error,
                latencyMs: result.latencyMs,
                usage: result.usage,
                runningMetrics: suggestionState!.metrics,
              });
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

        const prefetchUpcomingSuggestions = (
          undecidedList: Suspect[],
          currentIndex: number,
        ): void => {
          for (let offset = 1; offset <= SUGGESTION_PREFETCH_AHEAD; offset++) {
            prefetchSuggestion(undecidedList[currentIndex + offset]);
          }
        };

        let i = startIndex;
        let decisionsFileHash = decisionsFingerprint(decisions, components);
        {
          const initialUndecided = sortSuspectsForPrompting(
            suspects.filter((s) => !(s.decisionKey in decisions.fields)),
          );
          prefetchSuggestion(initialUndecided[i]);
          prefetchUpcomingSuggestions(initialUndecided, i);
        }
        while (true) {
          const latestFile = await loadDecisions(decisionsPath(sessionDir));
          const latestHash = decisionsFingerprint(latestFile.decisions, latestFile.components);
          if (latestHash !== decisionsFileHash) {
            decisions = latestFile.decisions;
            components = latestFile.components;
            decisionsFileHash = latestHash;
            console.log('  decisions.json changed on disk. Reloaded and restarting current field.\n');
            await logPipeline('decisions.reload_from_disk', {
              promptIndex: i,
              decided: Object.keys(decisions.fields).length,
              components: Object.keys(components).length,
            });
          }

          const undecidedNow = sortSuspectsForPrompting(
            suspects.filter((s) => !(s.decisionKey in decisions.fields)),
          );
          if (i >= undecidedNow.length) break;
          const suspect = undecidedNow[i]!;
          const fetchedSuggestion = await fetchSuggestion(suspect);
          const shownSuggestion = fetchedSuggestion.advice;
          const suggestedKindForField = suggestedKind(shownSuggestion);
          if (shownSuggestion && suggestionState) {
            suggestionState.metrics.suggestionsShown++;
            await persistSuggestionState();
          }

          prefetchUpcomingSuggestions(undecidedNow, i);

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
              const selectedKind = kindFromPromptResult(result);
              if (selectedKind === suggestedKindForField) {
                suggestionState.metrics.acceptedKind++;
              }
              const suggestedSource = shownSuggestion.source.recommended === 'yes'
                ? shownSuggestion.source.yesPayload.fieldId
                : undefined;
              const suggestedReference = shownSuggestion.reference.recommended === 'yes'
                ? shownSuggestion.reference.yesPayload.fieldId
                : undefined;
              if (
                selectedKind === suggestedKindForField
                && result.sourceFieldId === suggestedSource
                && result.referenceFieldId === suggestedReference
              ) {
                suggestionState.metrics.acceptedExact++;
              }
            }
            await persistSuggestionState();
          }

          if (result.action === 'back') {
            const previousKey = progress.undoStack[progress.undoStack.length - 1];
            if (!previousKey) {
              console.log('  Nothing to undo.\n');
              continue;
            }

            const previousDecision = decisions.fields[previousKey];
            if (!previousDecision) {
              // Stale undo entry (e.g. manual edits on disk). Drop it and continue.
              removeLastOccurrence(progress.undoStack, previousKey);
              await saveProgress(sessionDir, progress);
              console.log('  Previous undo entry no longer exists in decisions; skipped.\n');
              continue;
            }

            const componentIds = decisionFieldIds(previousDecision);
            removeFieldDecision(decisions, previousKey);

            for (const componentId of componentIds) {
              if (!isComponentStillReferenced(decisions, componentId)) {
                removeComponent(components, componentId);
              }
            }

            removeLastOccurrence(progress.undoStack, previousKey);
            await saveDecisions(decisionsPath(sessionDir), decisions, components);
            decisionsFileHash = decisionsFingerprint(decisions, components);

            const undecidedAfterUndo = sortSuspectsForPrompting(
              suspects.filter((s) => !(s.decisionKey in decisions.fields)),
            );
            const restartIndex = undecidedAfterUndo.findIndex((s) => s.decisionKey === previousKey);
            i = restartIndex >= 0 ? restartIndex : Math.max(0, i - 1);
            progress.nextPromptIndex = i;
            await saveProgress(sessionDir, progress);

            await logPipeline('decision.undo', {
              decisionKey: previousKey,
              promptIndex: i,
            });

            const currentSuspect = undecidedAfterUndo[i];
            console.log(
              currentSuspect
                ? `  Undid previous decision. Returning to ${currentSuspect.methodName} [${currentSuspect.direction}] ${currentSuspect.keyName}.\n`
                : '  Undid previous decision.\n',
            );
            continue;
          }

          const selectedKind = kindFromPromptResult(result);
          const sourceRef = parseModelFieldId(result.sourceFieldId);
          const referenceRef = parseModelFieldId(result.referenceFieldId);

          if (result.sourceFieldId && !sourceRef) {
            console.log('  Source field target must be in "Model.Field" format. Restarting this field.\n');
            continue;
          }
          if (result.referenceFieldId && !referenceRef) {
            console.log('  Reference target must be in "Model.Field" format. Restarting this field.\n');
            continue;
          }

          if (result.sourceFieldId) {
            const existingComponent = components[result.sourceFieldId];
            if (existingComponent) {
              const inferredTypes = inferPrimitiveTypes(suspect.entry.values);
              if (hasTypeConflict(existingComponent, inferredTypes)) {
                console.error(
                  `\nType conflict on ${result.sourceFieldId}: existing ${componentTypes(existingComponent).join('|') || existingComponent.baseType}, `
                  + `current ${inferredTypes.join('|') || 'unknown'}.`,
                );
                const ready = await promptContinue('Edit decisions.json to resolve this type conflict, then continue?');
                if (!ready) {
                  console.log('  Session saved. Resume later to continue.\n');
                  await logPipeline('session.pause', { reason: 'type_conflict_unresolved' });
                  stopPromptTracing();
                  setPromptReloadHandler(null);
                  return;
                }
                const reloaded = await loadDecisions(decisionsPath(sessionDir));
                decisions = reloaded.decisions;
                components = reloaded.components;
                decisionsFileHash = decisionsFingerprint(decisions, components);
                continue;
              }
            }
          }

          if (result.referenceFieldId && !(result.referenceFieldId in components)) {
            console.warn(
              `  Warning: ${suspect.methodName} [${suspect.direction}] ${suspect.parentPath}.${suspect.keyName} `
              + `references undefined model field "${result.referenceFieldId}".`,
            );
          }

          setFieldDecision(decisions, suspect.decisionKey, {
            kind: selectedKind,
            sourceFieldId: result.sourceFieldId,
            referenceFieldId: result.referenceFieldId,
            modelName: sourceRef?.modelName,
            fieldName: sourceRef?.fieldName,
            referenceModelName: referenceRef?.modelName,
            referenceFieldName: referenceRef?.fieldName,
          });

          progress.undoStack.push(suspect.decisionKey);
          progress.nextPromptIndex = i + 1;
          await saveProgress(sessionDir, progress);
          await saveDecisions(decisionsPath(sessionDir), decisions, components);
          decisionsFileHash = decisionsFingerprint(decisions, components);
          await logPipeline('decision.apply', {
            decisionKey: suspect.decisionKey,
            kind: selectedKind,
            sourceFieldId: result.sourceFieldId,
            referenceFieldId: result.referenceFieldId,
            promptIndex: i,
            suggestionUsed: !!shownSuggestion,
            suggestedKind: suggestedKindForField,
            suggestedTarget: suggestionTarget(shownSuggestion),
          });
          i++;
        }
      } else if (mode === 'auto-scalar') {
        for (const suspect of undecided) {
          setFieldDecision(decisions, suspect.decisionKey, { kind: 'scalar' });
        }
        progress.nextPromptIndex = undecided.length;
        await saveProgress(sessionDir, progress);
        await saveDecisions(decisionsPath(sessionDir), decisions, components);
        await logPipeline('decision.auto_scalar', { count: undecided.length });
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
        console.log('  Edit each field: choose scalar/source/reference/source_reference and optional sourceFieldId/referenceFieldId.');
        console.log('  Then resume this session to continue.\n');

        const ready = options.assumeBatchEdited || await promptContinue('Have you finished editing decisions.json?');
        if (!ready) {
          console.log('  Session saved. Resume later to continue.\n');
          await logPipeline('session.pause', { reason: 'batch_waiting_for_edit' });
          stopPromptTracing();
          setPromptReloadHandler(null);
          return;
        }

        // Reload after manual edit
        const reloaded = await loadDecisions(decisionsPath(sessionDir));
        decisions = reloaded.decisions;
        components = reloaded.components;
      }
    }

    await saveDecisions(decisionsPath(sessionDir), decisions, components);
    await logPipeline('step.prompting.done', {
      decided: Object.keys(decisions.fields).length,
      components: Object.keys(components).length,
    });
    progress = await updateStep(sessionDir, 'transformed');
    await logPipeline('step.transition', { nextStep: progress.step });
  }

  // ── Step 6: Transform ──
  if (progress.step === 'transformed' || progress.step === 'validation_failed') {
    // Reload decisions in case we're resuming after edits
    const reloaded = await loadDecisions(decisionsPath(sessionDir));
    decisions = reloaded.decisions;
    components = reloaded.components;

    const relationshipWarnings = collectRelationshipWarnings(decisions, components);
    progress.relationshipWarnings = relationshipWarnings;
    await saveProgress(sessionDir, progress);
    await logPipeline('relationship.warnings', { count: relationshipWarnings.length });

    // Re-extract and re-infer if needed (we need corpora and schemas)
    if (corpora.length === 0) corpora = await runExtract(sessionDir);
    if (schemas.length === 0) schemas = await runInfer(corpora);

    const transformedSchemas = transformSchemas(schemas, decisions, components);

    // ── Step 7: Validate ──
    console.log('\nValidating (every sample must pass)...');
    const validation = validateSchemas(corpora, transformedSchemas, components);
    await logPipeline('validation.summary', {
      allPass: validation.allPass,
      methods: validation.results.length,
      failures: validation.failureRecords.length,
    });

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
              const componentIds = decisionFieldIds(dec);
              removeFieldDecision(decisions, lastKey);
              for (const componentId of componentIds) {
                if (!isComponentStillReferenced(decisions, componentId)) {
                  removeComponent(components, componentId);
                }
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
    await logPipeline('step.transition', { nextStep: progress.step });
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
    await logPipeline('emit.done', { rootPath, fileCount });

    progress = await updateStep(sessionDir, 'emitted');
    await logPipeline('step.transition', { nextStep: progress.step });
  }

  {
    const finalDecisions = await loadDecisions(decisionsPath(sessionDir));
    const warnings = collectRelationshipWarnings(finalDecisions.decisions, finalDecisions.components);
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
    await logPipeline('suggestions.metrics', {
      attemptedCalls: metrics.attemptedCalls,
      completedCalls: metrics.completedCalls,
      failedCalls: metrics.failedCalls,
      cacheHits: metrics.cacheHits,
      suggestionsShown: metrics.suggestionsShown,
      decisionCount: metrics.decisionCount,
      decisionsWithSuggestion: metrics.decisionsWithSuggestion,
      acceptedKind: metrics.acceptedKind,
      acceptedExact: metrics.acceptedExact,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
      estimatedCostUsd: metrics.estimatedCostUsd,
    });
  }

  // ── Done ──
  console.log('═══════════════════════════════════════════');
  console.log(`  Session   : ${sessionDir}`);
  console.log(`  Status    : ${latestProgress.step}`);
  console.log(`  Output    : ${openApiDir(sessionDir)}/`);
  console.log('═══════════════════════════════════════════\n');
  await logPipeline('session.complete', {
    status: latestProgress.step,
    outputDir: `${openApiDir(sessionDir)}/`,
  });
  stopPromptTracing();
  setPromptReloadHandler(null);
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
  setSessionsDirOverride(
    sessionsDir ? resolve(process.cwd(), sessionsDir) : undefined,
  );
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
      'Legacy option (ignored with rank-based suggestions)',
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
