import type { DatabaseSync } from "node:sqlite";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";
import { transaction } from "../../lib/storage/sqlite.js";

/** Persist graph migrations without changing unrelated personal channel settings. */
export function migratePersonalConditions(db: DatabaseSync) {
  transaction(db, () => {
    const rows = db.prepare("SELECT id,settings_json FROM personal_channels").all() as {
      id: string;
      settings_json: string;
    }[];
    const update = db.prepare(
      "UPDATE personal_channels SET settings_json=?,revision=revision+1 WHERE id=?",
    );
    for (const row of rows) {
      const settings = JSON.parse(row.settings_json) as { flow?: ChannelWorkflow };
      if (!settings.flow) continue;
      if (!Array.isArray(settings.flow.nodes))
        throw new Error(`Invalid workflow in personal channel ${row.id}`);
      const migrated = migrateWorkflowConditions(settings.flow);
      if (migrated === settings.flow) continue;
      settings.flow = migrated;
      update.run(JSON.stringify(settings), row.id);
    }
  });
}
