import { reviewSchema } from "../agents/host/review-schema.js";
import type { Task } from "../tasks/types.js";
// 放行是显式策略判断，审计警告不替代或绕过已启用的交付检查。
export function isReady(task: Task): boolean {
  if (!task.deliveryPrepared || !task.artifactDigest) return false;
  const review = reviewSchema.safeParse(task.review);
  if (
    task.config.delivery.aiReview &&
    (!review.success ||
      review.data.verdict !== "approve" ||
      review.data.taskId !== task.id ||
      review.data.artifactDigest !== task.artifactDigest ||
      review.data.configDigest !== task.configDigest)
  )
    return false;
  return task.config.delivery.checks.every((check) =>
    task.checks.some(
      (result) =>
        result.name === check.name &&
        result.status === "passed" &&
        result.artifactDigest === task.artifactDigest,
    ),
  );
}
