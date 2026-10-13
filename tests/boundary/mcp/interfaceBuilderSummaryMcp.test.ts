import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";
import { openProductionTarget } from "../../support/mcp/productionSession.js";

const evidenceOf = <Schema extends z.ZodType>(schema: Schema) =>
  z.object({
    evidence_id: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    normalized_result: schema,
  });
const summarySchema = z.object({
  kind: z.literal("summary"),
  parent_evidence_id: z.string(),
  summary: z.object({
    documents: z.array(z.unknown()),
    available_counts: z.object({
      nodes: z.number(),
      edges: z.number(),
      coverage: z.number(),
    }),
  }),
});
const pageSchema = z.object({
  kind: z.literal("interface-builder"),
  items: z.array(z.unknown()),
  coverage: z.object({ next_offset: z.number().nullable() }),
});

/** A two-document app; each nib is a real rooted UIKit outlet archive. */
const fixtureApp = async (): Promise<string> => {
  const app = join(
    await createTestTempDirectory("rea-ib-summary-mcp-"),
    "Fixture.app",
  );
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  await mkdir(resources, { recursive: true });
  await mkdir(join(contents, "MacOS"));
  await writeFile(
    join(contents, "MacOS", "Fixture"),
    thinMach(0xfeedfacf, 0x0100000c),
  );
  await writeFile(
    join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>",
  );
  const nib = await readFile(
    join(process.cwd(), "tests/fixtures/interface-builder/UIKitOutlet.xml"),
  );
  await writeFile(join(resources, "Main.nib"), nib);
  await writeFile(join(resources, "Second.nib"), nib);
  return app;
};

mcpTest(
  "retains complete Interface Builder Evidence and pages one document's rows",
  async ({ mcp, onTestFinished }) => {
    const app = await fixtureApp();
    const client = await openProductionTarget(mcp, onTestFinished, app);

    const complete = await client.callTool({
      name: "decode_interface_builder",
      arguments: {},
    });
    expect(complete.isError, JSON.stringify(complete.content)).not.toBe(true);
    const full = evidenceOf(interfaceBuilderAnalysisSchema).parse(
      complete.structuredContent,
    );
    expect(full.parameters).not.toHaveProperty("detail");
    const report = full.normalized_result;
    expect(report.documents).toHaveLength(2);

    const summarized = await client.callTool({
      name: "decode_interface_builder",
      arguments: { detail: "summary" },
    });
    expect(summarized.isError, JSON.stringify(summarized.content)).not.toBe(
      true,
    );
    const summary = evidenceOf(summarySchema).parse(
      summarized.structuredContent,
    ).normalized_result;
    // Delivery detail never reaches the decoder or the source Evidence ID.
    expect(summary.parent_evidence_id).toBe(full.evidence_id);
    expect(summary.summary.documents).toEqual(report.documents);
    expect(summary.summary.available_counts).toEqual({
      nodes: report.graph.nodes.length,
      edges: report.graph.edges.length,
      coverage: report.graph.coverage.length,
    });

    const source = {
      kind: "retained-evidence",
      evidence_id: summary.parent_evidence_id,
    };
    const readAll = async (view: Record<string, unknown>) => {
      const rows: unknown[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const paged = await client.callTool({
          name: "inspect_analysis_view",
          arguments: {
            source,
            view: { kind: "interface-builder", ...view, offset, limit: 2 },
          },
        });
        expect(paged.isError, JSON.stringify(paged.content)).not.toBe(true);
        const page = evidenceOf(pageSchema).parse(
          paged.structuredContent,
        ).normalized_result;
        rows.push(...page.items);
        offset = page.coverage.next_offset;
      }
      return rows;
    };
    expect(await readAll({ collection: "edges" })).toEqual(report.graph.edges);
    const main = "Contents/Resources/Main.nib";
    const mainNodes = report.graph.nodes.filter(({ evidence }) =>
      evidence.some(({ artifact_path }) => artifact_path === main),
    );
    expect(mainNodes.length).toBeGreaterThan(0);
    expect(mainNodes.length).toBeLessThan(report.graph.nodes.length);
    expect(await readAll({ collection: "nodes", document: main })).toEqual(
      mainNodes,
    );

    const unknownDocument = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source,
        view: {
          kind: "interface-builder",
          collection: "nodes",
          document: "Contents/Resources/Missing.nib",
        },
      },
    });
    expect(parseMcpToolError(unknownDocument)).toMatchObject({
      error: { code: "invalid_request" },
    });
  },
);
