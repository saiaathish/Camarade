import type { ContextBudgetConfig } from "../context/context-types.js";
import type { RunCondition } from "../core/types.js";
export const EXPERIMENT_SCHEMA_VERSION = "1.0.0";
export const EXPERIMENT_CONTROLLER_VERSION = "1.0.0";
export type ExperimentConditionId = RunCondition;
export type ExperimentInstructionMode = "augmentation" | "replacement";
export type ExperimentExecutionOrder = "baseline-first" | "camarade-first";
export type ExperimentLifecycleStatus = "prepared" | "complete" | "partial" | "failed";
export type ConditionExecutionStatus = "not-run" | "complete" | "failed" | "timed-out";
export type FairnessStatus = "pass" | "fail" | "indeterminate";
export interface CodexExperimentConfig { executable: string; timeoutSeconds: number; arguments: string[]; environmentAllowlist: string[]; }
export interface ExperimentRunConfig { instructionMode: ExperimentInstructionMode; executionOrder: ExperimentExecutionOrder; codex: CodexExperimentConfig; }
export interface FairExperimentRequest { repositoryPath: string; task: string; controllerRoot?: string; contextBudget?: number; experimentId?: string; }
export interface ValidatedFairExperimentRequest extends FairExperimentRequest {}
export interface ExperimentConditionSpecification { conditionId: ExperimentConditionId; contextKind: "original-repository" | "camarade-compiled"; }
export interface FairExperimentSpecification { schemaVersion:string; controllerVersion:string; experimentId:string; specificationId:string; specificationHash:string; repositoryPath:string; task:{original:string;normalized:string;sha256:string}; instructionMode:ExperimentInstructionMode; executionOrder:ExperimentExecutionOrder; orderedConditionIds:ExperimentConditionId[]; conditions:ExperimentConditionSpecification[]; codex:CodexExperimentConfig; validationCommands:string[]; contextBudget:ContextBudgetConfig; hashes:{codexConfiguration:string;validationConfiguration:string;contextBudget:string}; }
export interface ExperimentSubmoduleState { path:string; commit:string; }
export interface ExperimentStartingState { repositoryPath:string; startingCommit:string; startingTree:string; repositoryFingerprint:string; clean:true; submodules:ExperimentSubmoduleState[]; }
export interface ConditionContextManifest { conditionId:ExperimentConditionId; contextKind:"original-repository"|"camarade-compiled"; contextPath:string; contextHash:string; sourcePaths:string[]; instructionMode?:ExperimentInstructionMode; manifestPath?:string; sources?:ExperimentInstructionSource[]; startingCommit?:string; startingTree?:string; taskHash?:string; codexConfigurationHash?:string; validationConfigurationHash?:string; contextBudgetHash?:string; includesOriginalInstructions?:boolean; requiresNativeInstructionSuppression?:boolean; stage4CompilationId?:string; stage4ContractHash?:string; stage4ArtifactPaths?:string[]; }
export interface CodexExecutionConfiguration { executable:string; executableVersion:string|null; arguments:string[]; timeoutSeconds:number; environmentAllowlist:string[]; }
export interface ConditionExecutionResult { conditionId:ExperimentConditionId; status:ConditionExecutionStatus; startedAt:string; completedAt:string; durationMs:number; exitCode:number|null; timedOut:boolean; stdoutPath:string; stderrPath:string; changedFiles:string[]; patchPath:string; patchHash:string; actualTokenUsageAvailable:boolean; inputTokens?:number; outputTokens?:number; }
export interface ExperimentValidationCommandResult { command:string; startedAt:string; completedAt:string; durationMs:number; exitCode:number|null; timedOut:boolean; stdoutPath:string; stderrPath:string; }
export interface ConditionValidationResult { conditionId:ExperimentConditionId; commands:ExperimentValidationCommandResult[]; }
export interface FairnessAuditCheck { checkId:string; status:FairnessStatus; baselineValueHash?:string; camaradeValueHash?:string; message:string; }
export interface FairnessAudit { status:FairnessStatus; checks:FairnessAuditCheck[]; }
export interface ExperimentManifest { schemaVersion:string; controllerVersion:string; experimentId:string; specificationId:string; specificationHash:string; status:ExperimentLifecycleStatus; startingState:ExperimentStartingState; conditionContextManifests:ConditionContextManifest[]; conditionExecutionResults:ConditionExecutionResult[]; conditionValidationResults:ConditionValidationResult[]; fairnessAudit:FairnessAudit; outputHashes:string[]; }
export interface ExperimentSummary { experimentId:string; status:ExperimentLifecycleStatus; startingCommit:string; taskHash:string; instructionMode:ExperimentInstructionMode; executionOrder:ExperimentExecutionOrder; fairnessStatus:FairnessStatus; baselineStatus:ConditionExecutionStatus; camaradeStatus:ConditionExecutionStatus; artifacts:string[]; }
export interface FairExperimentResult { specification:FairExperimentSpecification; startingState:ExperimentStartingState; manifest:ExperimentManifest; summary:ExperimentSummary; baseline:ConditionExecutionResult; camarade:ConditionExecutionResult; artifacts:string[]; }
export interface ExperimentPreparationLayout { controllerRoot:string; experimentDirectory:string; worktreeDirectory:string; baselineWorktreePath:string; camaradeWorktreePath:string; baselineContextDirectory:string; camaradeContextDirectory:string; preparationResultPath:string; startingStatePath:string; fairnessAuditPath:string; }
export interface ExperimentWorktreeState { conditionId:ExperimentConditionId; path:string; startingCommit:string; startingTree:string; trackedTreeHash:string; clean:true; }
export interface ExperimentInstructionSource { relativePath:string; sourceType:"file"|"symbolic-link"; contentHash:string; byteLength:number; linkTarget?:string; }
export interface PreparedConditionManifest { conditionId:ExperimentConditionId; worktree:ExperimentWorktreeState; context:ConditionContextManifest; taskHash:string; codexConfigurationHash:string; validationConfigurationHash:string; contextBudgetHash:string; }
export interface ExperimentPreparationArtifactPaths { specification:string; startingState:string; baselineContext:string; baselineContextManifest:string; camaradeContext:string; camaradeContextManifest:string; fairnessAudit:string; preparationResult:string; stage4Compilation:object; }
export interface PreparedFairExperiment { status:"prepared"; specification:FairExperimentSpecification; startingState:ExperimentStartingState; layout:ExperimentPreparationLayout; baseline:PreparedConditionManifest; camarade:PreparedConditionManifest; fairnessAudit:FairnessAudit; artifacts:ExperimentPreparationArtifactPaths; }
