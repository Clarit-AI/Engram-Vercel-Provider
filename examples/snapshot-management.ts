import { createClarit } from '../src/index.js';

/**
 * Snapshot Management Example
 * 
 * Shows how to list, get info, and delete snapshots directly 
 * using the provider utilities.
 */
async function main() {
  const clarit = createClarit({
    baseURL: process.env.CLARIT_BASE_URL ?? 'http://localhost:30000',
  });

  const conversationId = 'my-persistent-session';

  console.log(`Listing snapshots for: ${conversationId}`);
  const snapshots = await clarit.snapshots.list(conversationId);

  if (snapshots.length === 0) {
    console.log('No snapshots found.');
    return;
  }

  snapshots.forEach((snap) => {
    console.log(`- Turn ${snap.turn_number}: ${snap.token_count} tokens (${new Date((snap.timestamp || 0) * 1000).toLocaleString()})`);
  });

  // Get detailed info for the latest one
  const latest = snapshots[snapshots.length - 1];
  const info = await clarit.snapshots.getInfo({
    conversation_id: conversationId,
    turn_number: latest.turn_number,
  });

  console.log('\nLatest Snapshot Info:', info.metadata);
}

main().catch(console.error);
