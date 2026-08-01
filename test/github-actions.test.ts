import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import workflowYaml from "../.github/workflows/deploy.yml?raw";

// S21: the manual-dispatch GitHub Actions deploy workflow must stay valid and
// wire the operator's Cloudflare credentials + headless setup env. We parse
// the committed YAML (not a fixture) so the test fails if the workflow drifts.
// `?raw` imports the file content as a string at build time — no fs access is
// available inside the workerd test runtime, and this also pins the verbatim
// `${{ secrets... }}` expressions.

interface WorkflowInput {
  description?: string;
  required?: boolean;
  default?: string;
}

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Workflow {
  name?: string;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, WorkflowInput>;
    };
  };
  jobs?: {
    deploy?: {
      "runs-on"?: string;
      steps?: WorkflowStep[];
    };
  };
}

const workflow = parse(workflowYaml) as Workflow;
const steps = workflow.jobs?.deploy?.steps ?? [];

function findStep(predicate: (step: WorkflowStep) => boolean): WorkflowStep {
  const step = steps.find(predicate);
  if (!step) throw new Error("workflow step not found");
  return step;
}

describe(".github/workflows/deploy.yml", () => {
  it("is manual-dispatch with the four inputs and their defaults", () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs;
    expect(inputs).toBeTruthy();
    expect(inputs?.["worker-domain"]?.default).toBe("pages.example.com");
    expect(inputs?.["cdn-domain"]?.default).toBe("cdn.pages.example.com");
    expect(inputs?.["project-name"]?.default).toBe("pagelively");
    expect(inputs?.["create-kv"]?.default).toBe("true");
    expect(Object.keys(inputs ?? {})).toHaveLength(4);
  });

  it("runs on ubuntu-latest with checkout and actions/setup-node@v4 (node 22, npm cache)", () => {
    expect(workflow.jobs?.deploy?.["runs-on"]).toBe("ubuntu-latest");
    findStep((s) => s.uses === "actions/checkout@v4");
    const setupNode = findStep((s) => s.uses === "actions/setup-node@v4");
    expect(setupNode.with?.["node-version"]).toBe(22);
    expect(setupNode.with?.["cache"]).toBe("npm");
  });

  it("runs npm ci before npm run setup", () => {
    const runSteps = steps.map((s) => s.run).filter((r): r is string => Boolean(r));
    expect(runSteps).toContain("npm ci");
    expect(runSteps).toContain("npm run setup");
    expect(runSteps.indexOf("npm ci")).toBeLessThan(runSteps.indexOf("npm run setup"));
  });

  it("wires the three secrets, the four inputs mappings, and SETUP_NON_INTERACTIVE=1 into setup", () => {
    const setupStep = findStep((s) => s.run === "npm run setup");
    expect(setupStep.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      ADMIN_EMAILS: "${{ secrets.ADMIN_EMAILS }}",
      SETUP_WORKER_DOMAIN: "${{ inputs.worker-domain }}",
      SETUP_CDN_DOMAIN: "${{ inputs.cdn-domain }}",
      SETUP_PROJECT_NAME: "${{ inputs.project-name }}",
      SETUP_CREATE_KV: "${{ inputs.create-kv }}",
      SETUP_NON_INTERACTIVE: "1",
    });
  });

  it("keeps the ${{ secrets... }} expressions verbatim in the committed file", () => {
    for (const expression of [
      "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      "${{ secrets.ADMIN_EMAILS }}",
    ]) {
      expect(workflowYaml).toContain(expression);
    }
  });
});
