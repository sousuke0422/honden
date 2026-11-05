import type { Database } from 'bun:sqlite';
import { roster } from '../src/roster';
import { syncLimits } from '../src/routing';

/** Tests not concerned with routing can explicitly mark their synthetic roster as known. */
export function trustRosterModels(db: Database): void {
  db.run("UPDATE roster SET model = 'test-model' WHERE model IS NULL");
  const models = [...new Set(roster(db).map((entry) => entry.model).filter((model): model is string => Boolean(model)))];
  syncLimits(
    db,
    models.map((model) => ({ model, maxBloom: 6, costGroup: 'test' })),
    'test',
  );
}
