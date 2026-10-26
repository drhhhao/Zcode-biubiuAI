import fs from 'node:fs/promises';
import { Harbor } from '../lib/core.mjs';
const apply = process.argv.includes('--apply');
const harbor = new Harbor({ builtinConfigPath: 'E:/Zcode/resources/config/provider/zcode-builtin.json' });
const report = { version: '0.2.0', checkedAt: new Date().toISOString(), apply, providers: [] };
for (const p of (await harbor.providers()).providers.filter(p => p.id !== 'new-provider')) {
  const r = await harbor.fetchModels({ baseUrl: p.baseUrl, protocol: p.protocol, existingProviderId: p.id });
  const row = { id: p.id, name: p.name, models: r.models, calls: [] }; report.providers.push(row);
  console.log(JSON.stringify({ provider: p.name, models: r.models.map(m => ({ id: m.id, metadata: m.metadata, sources: m.sources })) }));
  if (apply) { row.import = await harbor.importModels({ sessionId: r.sessionId, modelIds: r.models.map(m => m.id), providerName: p.name }); console.log(JSON.stringify({ provider: p.name, import: row.import })); }
  const targets = p.id === 'deepseek' ? ['deepseek-flash'] : p.id === 'new-provider-3' ? ['claude-opus-5-5'] : [];
  for (const id of targets) {
    const m = r.models.find(m => m.id === id); if (!m) continue;
    for (const level of m.recommended.reasoningLevels || []) {
      const tested = await harbor.testModel({ sessionId: r.sessionId, modelId: id, reasoningLevel: level, settings: { reasoningLevels: m.recommended.reasoningLevels } }); row.calls.push(tested); console.log(JSON.stringify({ provider: p.name, tested }));
      await fs.writeFile(new URL('../../build/plugin-era-reports/metadata-live-report.json', import.meta.url), JSON.stringify(report, null, 2));
    }
  }
}
await fs.writeFile(new URL('../../build/plugin-era-reports/metadata-live-report.json', import.meta.url), JSON.stringify(report, null, 2));
