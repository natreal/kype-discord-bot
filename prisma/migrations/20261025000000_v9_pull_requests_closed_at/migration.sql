-- `/github report` buckets pull-request closures by when they happened, which needs
-- more than `mergedAt`: a pull request closed *without* merging has no `mergedAt` at
-- all, so the report could not place it in an hour.
--
-- `closedAt` is nullable on purpose. Existing rows were first seen by a payload that
-- did not carry it, and a guessed timestamp would be worse than a null: the report
-- counts a null as "unknown" instead of filing it under an hour it may not belong to.
ALTER TABLE "repository_pull_requests" ADD COLUMN "closedAt" TIMESTAMP(3);

-- The report's merge and closure windows both filter on these, newest first.
CREATE INDEX "repository_pull_requests_repositoryId_mergedAt_idx"
    ON "repository_pull_requests"("repositoryId", "mergedAt");
