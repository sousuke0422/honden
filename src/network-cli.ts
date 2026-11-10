import type { Database } from 'bun:sqlite';
import { changeKey, configureListener, issuePeer, peerStatus, type Capability } from './external';
import { serveNetwork } from './network';
import { configureWebhook } from './webhook';

export async function networkCli(db: Database, actor: string | undefined, rest: string[], flags: Record<string, string>): Promise<number> {
  if (rest[1] === 'serve') {
    const server = serveNetwork(db);
    console.log(`network inbox: ${server.hostname}:${server.port}`);
    return new Promise<number>((resolve) => {
      const stop = () => { server.stop(true); process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(0); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
    });
  }
  if (rest[1] === 'configure') {
    if (flags['disable'] !== 'true' && !flags['host']) throw new Error('--host or --disable is required');
    configureListener(db, actor, flags['disable'] === 'true' ? null : flags['host']!, Number(flags['port'] ?? 8789));
    console.log('network listener configuration saved');
    return 0;
  }
  if (rest[1] === 'peers') {
    console.log(JSON.stringify(peerStatus(db), null, 2));
    return 0;
  }
  if (rest[1] === 'peer' && rest[2] === 'webhook') {
    const disable = flags['disable'] === 'true';
    if (disable === !!flags['url']) throw new Error('provide either --url or --disable');
    const key = configureWebhook(db, actor, flags['name'] ?? '', disable ? null : flags['url']!);
    console.log(JSON.stringify({ name: flags['name'], ...(key ? { key } : { disabled: true }) }));
    return 0;
  }
  if (rest[1] === 'peer' && rest[2] === 'add') {
    const kind = flags['kind'] ?? 'agent';
    if (kind !== 'agent' && kind !== 'honden') throw new Error('--kind must be agent or honden');
    const key = issuePeer(db, actor, { name: flags['name'] ?? '', kind, direction: 'pull',
      capabilities: (flags['capabilities'] ?? '').split(',').filter(Boolean) as Capability[],
      destinations: (flags['destinations'] ?? '').split(',').filter(Boolean) });
    // This is the only display of the new key. Neither status nor the ledger retains it.
    console.log(JSON.stringify({ name: flags['name'], key }));
    return 0;
  }
  if (rest[1] === 'peer' && ['rotate','revoke'].includes(rest[2] ?? '')) {
    const key = changeKey(db, actor, flags['name'] ?? '', rest[2] === 'revoke');
    console.log(JSON.stringify({ name: flags['name'], ...(key ? { key } : { revoked: true }) }));
    return 0;
  }
  throw new Error('network: configure --host IP [--port N] | configure --disable | serve | peers | peer add --name NAME --capabilities inbox.read,inbox.write,report.submit --destinations gunshi,karo | peer rotate/revoke --name NAME | peer webhook --name NAME (--url URL | --disable)');
}
