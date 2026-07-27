export type KnowledgePurpose =
	| "session-orientation"
	| "task-planning"
	| "implementation"
	| "debugging"
	| "replanning"
	| "decision-history"
	| "user-preference"
	| "task-resume"
	| "completion-review";

export type KnowledgeDepth = "quick" | "normal" | "deep" | "forensic";

export type KnowledgeScopeName = "global" | "repo" | "task";

export interface KnowledgeScope {
	global?: boolean;
	repo?: boolean;
	task?: boolean;
}

export type KnowledgeForm =
	| "preference"
	| "fact"
	| "decision"
	| "constraint"
	| "procedure"
	| "failure"
	| "pitfall"
	| "lesson";

export type KnowledgeDomain =
	| "user"
	| "repository"
	| "architecture"
	| "product"
	| "implementation"
	| "debugging"
	| "verification"
	| "workflow"
	| "operations";

export type KnowledgeSource = "user" | "document" | "test" | "runtime" | "external" | "agent";

export type KnowledgeConfidence = "confirmed" | "probable" | "tentative";

export type KnowledgeRecordStatus = "active" | "contested" | "superseded" | "invalidated";

export type KnowledgeContentClass =
	| "durable-fact"
	| "canonical-document"
	| "reference-document"
	| "investigation"
	| "append-document";

export type KnowledgeRequestOrigin = "user-explicit" | "agent-initiated" | "workflow-review";

export type KnowledgeDocumentUpdateMode = "replace" | "append" | "immutable-revision";

export type KnowledgeMentalModelName =
	| "developer-working-preferences"
	| "repo-operating-manual"
	| "repo-architecture-decisions"
	| "repo-known-pitfalls"
	| "repo-debugging-validation-playbook";

export interface KnowledgeIdentity {
	repoId: string;
	taskId?: string;
	branchId?: string;
	attemptId?: string;
	sessionId: string;
	episodeId?: string;
	commitHash?: string;
	specVersion?: number;
	planVersion?: number;
}

export interface KnowledgeRequestContext {
	groupId: string;
	origin: KnowledgeRequestOrigin;
	sourceRequestId?: string;
	userMessageEntryId?: string;
}

export interface KnowledgeApplicability {
	components?: string[];
	platforms?: string[];
	validFrom?: string;
	validUntil?: string;
}

export interface KnowledgeRecallInput {
	purpose: KnowledgePurpose;
	query: string;
	scope: KnowledgeScope;
	depth: KnowledgeDepth;
	forms?: KnowledgeForm[];
	domains?: KnowledgeDomain[];
	components?: string[];
	includeSourceFacts?: boolean;
	includeChunks?: boolean;
	identity: KnowledgeIdentity;
	request?: KnowledgeRequestContext;
}

export interface KnowledgeRecallItem {
	id: string;
	text: string;
	type?: string;
	context?: string;
	metadata?: Record<string, string>;
	tags?: string[];
	entities?: string[];
	mentionedAt?: string;
	occurredStart?: string;
	occurredEnd?: string;
	sourceFactIds?: string[];
}

export interface KnowledgeWorkingSet {
	id: string;
	purpose: KnowledgePurpose;
	queryHash: string;
	scopeHash: string;
	items: KnowledgeRecallItem[];
	content?: string;
	degraded: boolean;
	cached: boolean;
	createdAt: string;
}

export interface KnowledgeEvidenceReference {
	id: string;
	type: "test" | "log" | "diff" | "user-confirmation" | "document" | "runtime";
}

export interface KnowledgeRetainInput {
	contentClass?: "durable-fact" | "investigation";
	scope: KnowledgeScopeName;
	form: KnowledgeForm;
	domain: KnowledgeDomain;
	source: KnowledgeSource;
	confidence: KnowledgeConfidence;
	knowledgeKey: string;
	statement: string;
	futureUse: string;
	sourceRefs: KnowledgeEvidenceReference[];
	identity: KnowledgeIdentity;
	request?: KnowledgeRequestContext;
	applicability?: KnowledgeApplicability;
	occurredAt?: string;
	documentId?: string;
	supersedes?: string;
	refreshMentalModels?: KnowledgeMentalModelName[];
}

export interface KnowledgeDocumentRetainInput {
	contentClass: Exclude<KnowledgeContentClass, "durable-fact">;
	scope: KnowledgeScopeName;
	domain: KnowledgeDomain;
	source: Exclude<KnowledgeSource, "agent">;
	confidence: KnowledgeConfidence;
	sourceId: string;
	title: string;
	content: string;
	futureUse: string;
	sourceRefs: KnowledgeEvidenceReference[];
	updateMode: KnowledgeDocumentUpdateMode;
	identity: KnowledgeIdentity;
	request?: KnowledgeRequestContext;
	applicability?: KnowledgeApplicability;
	occurredAt?: string;
	version?: string;
	refreshMentalModels?: KnowledgeMentalModelName[];
}

export interface KnowledgeRetainReceipt {
	status: "queued" | "duplicate" | "rejected";
	groupId?: string;
	memberId?: string;
	documentId?: string;
	knowledgeKey?: string;
	reason?: string;
	outboxId?: string;
}

export type KnowledgeReflectPurpose =
	| "plan-critique"
	| "compare-prior-approaches"
	| "analyze-recurring-failure"
	| "resolve-knowledge-conflict"
	| "task-retrospective";

export interface KnowledgeReflectInput {
	purpose: KnowledgeReflectPurpose;
	question: string;
	scope: KnowledgeScope;
	identity: KnowledgeIdentity;
	includeFacts?: boolean;
}

export interface KnowledgeCurateInput {
	action: "correct" | "invalidate" | "restore";
	documentId: string;
	reason: string;
	correctedText?: string;
	evidenceRefs?: KnowledgeEvidenceReference[];
	identity: KnowledgeIdentity;
	request?: KnowledgeRequestContext;
}

export interface KnowledgeGroupActionInput {
	action: "invalidate" | "restore" | "purge";
	groupId: string;
	reason: string;
}

export type KnowledgeGroupStatus =
	| "prepared"
	| "queued"
	| "partial"
	| "completed"
	| "failed"
	| "invalidated"
	| "purged";

export interface KnowledgeRetainGroup {
	id: string;
	origin: KnowledgeRequestOrigin;
	sourceRequestId?: string;
	userMessageEntryId?: string;
	bankId: string;
	repoId: string;
	taskId?: string;
	status: KnowledgeGroupStatus;
	memberCount: number;
	queuedCount: number;
	failedCount: number;
	createdAt: string;
	completedAt?: string;
}

export interface KnowledgeReviewRequest {
	id: string;
	taskId: string;
	repoId: string;
	goal: string;
	candidates: Array<{
		knowledgeKey: string;
		statement: string;
		form: KnowledgeForm;
		domain: KnowledgeDomain;
		source: KnowledgeSource;
		confidence: KnowledgeConfidence;
		evidenceRefs: KnowledgeEvidenceReference[];
	}>;
	createdAt: string;
}

export interface KnowledgeBankProfileStatus {
	name: string;
	version: number;
	hash: string;
	appliedHash?: string;
	drifted: boolean;
	managedConfigMode: "merge" | "inspect-only";
}

export type KnowledgeBankKind = "global" | "repository";

export type KnowledgeBankNameSource = "generated" | "remote" | "project-config" | "local-directory";

export interface KnowledgeBankRef {
	kind: KnowledgeBankKind;
	bankId: string;
	displayName: string;
	nameSource: KnowledgeBankNameSource;
	repositoryId?: string;
}

export interface KnowledgeBankStatus extends KnowledgeBankRef {
	profile?: KnowledgeBankProfileStatus;
}

export interface KnowledgeProviderActivity {
	operation: "recall" | "retain" | "reflect";
	status: "ok" | "failed";
	at: string;
	statusCode?: number;
	error?: string;
}

export interface KnowledgeStatus {
	enabled: boolean;
	provider: "hindsight";
	securityBoundary: string;
	globalBank?: KnowledgeBankStatus;
	repositoryBank?: KnowledgeBankStatus;
	queued: number;
	pendingReviews: number;
	groupCount: number;
	workingSet?: KnowledgeWorkingSet;
	providerActivity?: KnowledgeProviderActivity;
	error?: string;
}

export interface KnowledgeRuntime {
	status(): Promise<KnowledgeStatus>;
	listBanks(): Promise<KnowledgeBankStatus[]>;
	recall(input: KnowledgeRecallInput): Promise<KnowledgeWorkingSet>;
	retain(input: KnowledgeRetainInput): Promise<KnowledgeRetainReceipt>;
	retainDocument(input: KnowledgeDocumentRetainInput): Promise<KnowledgeRetainReceipt>;
	reflect(input: KnowledgeReflectInput): Promise<string>;
	curate(input: KnowledgeCurateInput): Promise<void>;
	curateGroup(input: KnowledgeGroupActionInput): Promise<void>;
	listGroups(limit?: number): Promise<KnowledgeRetainGroup[]>;
	requestReview(input: KnowledgeReviewRequest): Promise<void>;
	listReviews(): Promise<KnowledgeReviewRequest[]>;
	flushOutbox(): Promise<void>;
	close(): Promise<void>;
}
