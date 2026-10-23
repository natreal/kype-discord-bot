-- V9 "AnyPS5 repository monitor".
--
-- Additive only: five new tables, and no existing table is altered. Rolling back is
-- a plain DROP, and an instance that never configures the watch is unaffected.
--
-- Shape, and why:
--
--   monitored_repositories     -- what is watched (owner/name, branch, ETags).
--   repository_snapshots       -- one row per hourly refresh, never mutated. A
--                                 single mutable "current state" row could not
--                                 answer "how far had it come last week", which is
--                                 the reason the feature exists.
--   repository_commits         -- one row per commit, keyed (repositoryId, sha).
--   repository_pull_requests   -- one row per pull request, keyed
--                                 (repositoryId, number), updated in place as it is
--                                 merged.
--   repository_events          -- what was already announced, keyed by a stable
--                                 event key, so a restart or a retried task can
--                                 never repost the same commit.
--
-- `librariesPercent` / `shadersPercent` are nullable because they are copied from the
-- project's published progress.json: when that file is briefly unavailable the
-- snapshot still records commits and pull requests, and the gap is visible as NULL
-- rather than as a fabricated 0%.

-- CreateTable
CREATE TABLE "monitored_repositories" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branch" TEXT,
    "displayName" TEXT,
    "repositoryId" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "commitsEtag" TEXT,
    "pullRequestsEtag" TEXT,
    "cursorCommit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitored_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_snapshots" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "librariesDone" INTEGER,
    "librariesTotal" INTEGER,
    "librariesPercent" DOUBLE PRECISION,
    "shadersDone" INTEGER,
    "shadersTotal" INTEGER,
    "shadersPercent" DOUBLE PRECISION,
    "progressCommit" TEXT,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "forks" INTEGER NOT NULL DEFAULT 0,
    "openIssues" INTEGER NOT NULL DEFAULT 0,
    "commitCount" INTEGER NOT NULL DEFAULT 0,
    "pullCount" INTEGER NOT NULL DEFAULT 0,
    "progress" JSONB,
    "failures" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "repository_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_commits" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author" TEXT,
    "committedAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_pull_requests" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "state" TEXT NOT NULL,
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "merged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "url" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repository_pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_events" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monitored_repositories_repositoryId_key" ON "monitored_repositories"("repositoryId");

-- CreateIndex
CREATE INDEX "monitored_repositories_enabled_idx" ON "monitored_repositories"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "monitored_repositories_owner_name_key" ON "monitored_repositories"("owner", "name");

-- CreateIndex
CREATE INDEX "repository_snapshots_repositoryId_capturedAt_idx" ON "repository_snapshots"("repositoryId", "capturedAt");

-- CreateIndex
CREATE INDEX "repository_commits_repositoryId_committedAt_idx" ON "repository_commits"("repositoryId", "committedAt");

-- CreateIndex
CREATE UNIQUE INDEX "repository_commits_repositoryId_sha_key" ON "repository_commits"("repositoryId", "sha");

-- CreateIndex
CREATE INDEX "repository_pull_requests_repositoryId_createdAt_idx" ON "repository_pull_requests"("repositoryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "repository_pull_requests_repositoryId_number_key" ON "repository_pull_requests"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "repository_events_repositoryId_createdAt_idx" ON "repository_events"("repositoryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "repository_events_repositoryId_key_key" ON "repository_events"("repositoryId", "key");

-- AddForeignKey
ALTER TABLE "repository_snapshots" ADD CONSTRAINT "repository_snapshots_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "monitored_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_commits" ADD CONSTRAINT "repository_commits_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "monitored_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_pull_requests" ADD CONSTRAINT "repository_pull_requests_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "monitored_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_events" ADD CONSTRAINT "repository_events_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "monitored_repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

