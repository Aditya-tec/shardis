import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Many node tests spawn real processes and bind random TCP ports. Running
    // files in parallel makes CI contend for CPU/process resources and causes
    // false connection-refused failures in crash-recovery/failover tests.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1
  }
});
