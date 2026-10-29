import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migratePersonalConditions } from "../plugins/byok/condition-migration.js";

it("persists personal condition migration without disturbing other channel data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE personal_channels(id TEXT PRIMARY KEY, settings_json TEXT, revision INTEGER, updated_at INTEGER)");
    const settings = {
      protocol: "openai-chat",
      baseUrl: "https://example.test/v1",
      models: { public: { model: "vendor" } },
      flow: {
        entry: "start",
        nodes: [
          { id: "start", type: "start", next: ["branch"] },
          { id: "branch", type: "condition", test: "model", models: ["claude-*"], yes: "yes", no: "no" },
          { id: "yes", type: "provider" },
          { id: "no", type: "provider" },
          { id: "patterns", type: "value", valueType: "string[]", value: ["claude-*"] },
        ],
        bindings: [{ source: "patterns", output: "value", target: "branch", input: "models" }],
        layout: { branch: { x: 500, y: 250 } },
      },
    };
    db.prepare("INSERT INTO personal_channels VALUES(?,?,?,?)").run("old", JSON.stringify(settings), 4, 100);
    db.prepare("INSERT INTO personal_channels VALUES(?,?,?,?)").run("new", JSON.stringify({ protocol: "gemini" }), 3, 200);
    migratePersonalConditions(db);
    const row = db.prepare("SELECT * FROM personal_channels WHERE id='old'").get() as any;
    const result = JSON.parse(row.settings_json);
    expect(row.revision).toBe(5);
    expect(row.updated_at).toBe(100);
    expect(result).toMatchObject({ protocol: settings.protocol, baseUrl: settings.baseUrl, models: settings.models });
    expect(result.flow.nodes).toContainEqual({ id: "branch", type: "branch", condition: false, yes: "yes", no: "no" });
    expect(result.flow.nodes).toContainEqual({ id: "branch-compare", type: "compare", valueType: "string", operator: "matches", left: "", right: ["claude-*"] });
    expect(result.flow.bindings).toEqual([
      { source: "patterns", output: "value", target: "branch-compare", input: "right" },
      { source: "branch-compare", output: "result", target: "branch", input: "condition" },
      { source: "start", output: "requestedModel", target: "branch-compare", input: "left" },
    ]);
    expect(result.flow.layout).toEqual({ branch: { x: 500, y: 250 }, "branch-compare": { x: 130, y: 250 } });
    migratePersonalConditions(db);
    expect(db.prepare("SELECT revision FROM personal_channels WHERE id='old'").get()).toMatchObject({ revision: 5 });
    expect(db.prepare("SELECT revision FROM personal_channels WHERE id='new'").get()).toMatchObject({ revision: 3 });
  } finally {
    db.close();
  }
});

it("rolls back every row if any stored settings cannot be read", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE personal_channels(id TEXT PRIMARY KEY, settings_json TEXT, revision INTEGER)");
    const original = JSON.stringify({ flow: { entry: "start", nodes: [{ id: "c", type: "condition", test: "stream", yes: "a", no: "b" }] } });
    db.prepare("INSERT INTO personal_channels VALUES(?,?,?)").run("a", original, 1);
    db.prepare("INSERT INTO personal_channels VALUES(?,?,?)").run("b", "{", 1);
    expect(() => migratePersonalConditions(db)).toThrow();
    expect(db.prepare("SELECT settings_json, revision FROM personal_channels WHERE id='a'").get()).toMatchObject({ settings_json: original, revision: 1 });
  } finally {
    db.close();
  }
});
