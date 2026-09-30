/** The checklist task an iteration was given, as the iteration row records it. */
export type IterationTaskFields = {
  status: string;
  taskNumber?: number | null;
  taskCount?: number | null;
  taskText?: string | null;
  taskCompleted?: number | null;
};

export type IterationTask = {
  /** "Task 3/15" */
  label: string;
  state: "done" | "working" | "not done";
  /** Tasks still unfinished once this iteration is accounted for — the task
   * itself counts until it is done. */
  left: number;
  text: string;
};

/** What an iteration worked on, or null for rows recorded before tasks were
 * tracked per iteration. */
export function iterationTask(iteration: IterationTaskFields): IterationTask | null {
  const { taskNumber, taskCount, taskText } = iteration;
  if (taskNumber == null || taskCount == null || taskText == null) return null;
  const state =
    iteration.taskCompleted === 1 ? "done" : iteration.status === "running" ? "working" : "not done";
  return {
    label: `Task ${taskNumber}/${taskCount}`,
    state,
    left: Math.max(0, taskCount - taskNumber + (state === "done" ? 0 : 1)),
    text: taskText,
  };
}
