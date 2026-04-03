import { createClarit } from '../src/index.js';
import { generateText, streamText } from 'ai';

/**
 * Stateful Conversation Example
 * 
 * Demonstrates the signature Engram "remembering" workflow:
 * 1. Initial message with `autoSaveSnapshot`.
 * 2. Subsequent message using `restoreBeforeGenerate`.
 */
async function main() {
  const clarit = createClarit({
    baseURL: process.env.CLARIT_BASE_URL ?? 'http://localhost:30000',
  });

  const conversationId = `example-${Date.now()}`;
  const modelId = 'granite-4.0-h-small';

  // --- Turn 1: Save the context ---
  console.log('Turn 1: Setting context with auto-save...');

  const turn1 = await generateText({
    model: clarit(modelId),
    messages: [
      { role: 'user', content: 'My favorite color is neon purple.' },
    ],
    providerOptions: {
      clarit: {
        conversationId,
        turnNumber: 1,
        autoSaveSnapshot: true,
      },
    },
  });

  console.log('AI:', turn1.text);
  const meta1 = turn1.providerMetadata?.clarit as any;
  console.log('Snapshot Saved:', meta1?.snapshotSaved);

  // --- Turn 2: Instant recall with Restore-and-Generate ---
  console.log('\nTurn 2: Recalling context instantly...');

  // In a real app, you'd use a tokenizer to get IDs for the new turn.
  // Here we use dummy IDs for demonstration.
  const continuationPrompt = "What is my favorite color?";
  const dummyContinuationIds = [1, 2, 3, 4]; // Example token IDs

  const turn2 = await generateText({
    model: clarit(modelId),
    messages: [], // Message history is bypassed via direct state restoration
    providerOptions: {
      clarit: {
        conversationId,
        turnNumber: 1, // Restore from turn 1's saved state
        restoreBeforeGenerate: true,
        continuationIds: dummyContinuationIds,
        maxNewTokens: 64,
        autoSaveSnapshot: true, // Save new turn's state too
      },
    },
  });

  console.log('AI (Recalled):', turn2.text);
}

main().catch(console.error);
