import { expect, it } from "vitest";

import { analyzeAndAdoptJavaScriptArtifactFiles } from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { createJavaScriptSemanticGraphProjection } from "../../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import { readJavaScriptArtifactFiles } from "../../../../src/artifacts/javascript/JavaScriptArtifactFiles.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { createJavaScriptSourceAnalysis } from "../../../../src/artifacts/javascript/JavaScriptSourceAnalysis.js";
import { JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS } from "../../../../src/domain/javascript/javascriptAnalysisResourceControls.js";
import {
  scanCanonicalArtifactInventory,
  withArtifactResourceScope,
} from "../../../fixtures/artifactInventory.js";
import { writeJavaScriptSourceSelectionFixture } from "../../../fixtures/javascriptSourceSelection.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it("keeps unselected sources outside the selection when cancellation follows the last selected source", async () => {
  const root = await createTestTempDirectory("rea-js-selected-late-cancel-");
  await writeJavaScriptSourceSelectionFixture(root);
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  const worker = createJavaScriptSourceAnalysis(
    JAVASCRIPT_ANALYSIS_RESOURCE_DEFAULTS,
    1,
  );
  try {
    const files = await withArtifactResourceScope((scope) =>
      readJavaScriptArtifactFiles(reader, snapshot, scope, undefined, [
        "main.mjs",
      ]),
    );
    const controller = new AbortController();
    // Cancel after the only selected source completes, before the loop
    // reaches the first unselected source.
    const { analysis, interruption } =
      await analyzeAndAdoptJavaScriptArtifactFiles(
        files,
        {
          analyze: async (file, budget, signal) => {
            const result = await worker.analyze(file, budget, signal);
            controller.abort();
            return result;
          },
        },
        createJavaScriptSemanticGraphProjection(),
        async () => {},
        controller.signal,
      );

    expect(interruption?._tag).toBe("AnalysisCancelledError");
    const unselected = analysis.files.filter(
      ({ file }) =>
        !file.text.included && file.text.reason === "outside-analysis-scope",
    );
    expect(unselected).toHaveLength(5);
    expect(
      unselected.filter((entry) => entry.analysis_failure !== undefined),
    ).toEqual([]);
  } finally {
    await worker.close();
    await reader.close();
  }
});
