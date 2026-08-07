import type {
  AgentExecutionReport,
  ChangedFileSummary,
  EvidenceItem,
  ExecutionStatus,
  PermissionEventSummary,
  TestRunSummary,
} from "./types.js";

export class ExecutionReportBuilder {
  /**
   * Default `"partial"` is the explicit "no terminal claim" state.
   * Callers must call `setStatus("completed")` to claim success;
   * the validator only enforces evidence on `"completed"`.
   */
  private status: ExecutionStatus = "partial";
  private readonly changedFiles: ChangedFileSummary[] = [];
  private readonly evidence: EvidenceItem[] = [];
  private readonly tests: TestRunSummary[] = [];
  private readonly permissions: PermissionEventSummary[] = [];
  private readonly residualRisks: string[] = [];
  private readonly nextActions: string[] = [];

  constructor(private readonly taskId: string) {}

  setStatus(status: ExecutionStatus): this {
    this.status = status;
    return this;
  }

  addChangedFile(file: ChangedFileSummary): this {
    this.changedFiles.push(file);
    return this;
  }

  addEvidence(item: EvidenceItem): this {
    this.evidence.push(item);
    return this;
  }

  addTest(test: TestRunSummary): this {
    this.tests.push(test);
    return this;
  }

  addPermission(permission: PermissionEventSummary): this {
    this.permissions.push(permission);
    return this;
  }

  addResidualRisk(risk: string): this {
    this.residualRisks.push(risk);
    return this;
  }

  addNextAction(action: string): this {
    this.nextActions.push(action);
    return this;
  }

  build(): AgentExecutionReport {
    if (this.taskId.length === 0) {
      throw new Error("ExecutionReportBuilder: taskId must be non-empty");
    }
    if (
      this.status === "completed" &&
      this.changedFiles.length === 0 &&
      this.evidence.length === 0 &&
      this.tests.length === 0
    ) {
      throw new Error(
        "ExecutionReportBuilder: status 'completed' requires at least one evidence item, test, or changed file",
      );
    }
    return {
      taskId: this.taskId,
      status: this.status,
      changedFiles: [...this.changedFiles],
      evidence: [...this.evidence],
      tests: [...this.tests],
      permissions: [...this.permissions],
      residualRisks: [...this.residualRisks],
      nextActions: [...this.nextActions],
    };
  }
}
